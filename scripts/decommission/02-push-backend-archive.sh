#!/usr/bin/env bash
# Publish the scrubbed backend repo as a private, archived GitHub repo:
#   1. check the local scrubbed clone (no remotes, no secrets.json anywhere in history,
#      only branches and tags, gitleaks clean)
#   2. gh repo create cjoshmartin-com/cjoshmartin-backend-archive --private (if missing)
#   3. push every branch and tag (never --force)
#   4. verify the remote: same refs as the local clone, and a fresh mirror clone has no
#      secrets.json in any commit and is gitleaks clean
#   5. gh repo archive (read-only on GitHub)
#
# Re-running is safe: an existing repo is reused when it is private, a push of identical
# refs changes nothing, and an archived repo whose refs already match is left alone.
#
# Dry-run by default. See README.md for when to run it.
# Check functions are called indirectly through decom_check, which shellcheck cannot follow.
# shellcheck disable=SC2329
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  cat >&2 <<EOF
Usage: $(basename "$0") [--execute | --offline] [--archive-dir PATH] [--repo OWNER/NAME]

  --archive-dir  scrubbed clone (default: $DECOM_MIGRATION_DIR/backend-archive/cjoshmartin-backend)
  --repo         GitHub repo to create (default: cjoshmartin-com/cjoshmartin-backend-archive)
  --remote-url   git URL to push to and verify (default: from gh's git_protocol, ssh or https)
  --execute      create, push, verify and archive (default is a dry-run that changes nothing)
  --offline      dry-run without contacting GitHub

Environment: MIGRATION_DIR (default \$HOME/cjoshmartin-migration).
EOF
}

ARCHIVE_DIR="$DECOM_MIGRATION_DIR/backend-archive/cjoshmartin-backend"
REPO="cjoshmartin-com/cjoshmartin-backend-archive"
REMOTE_URL=""
DESCRIPTION="Archive of the retired Wagtail backend for cjoshmartin.com. secrets.json and hardcoded dev secrets were removed from history. Read-only."
while [ $# -gt 0 ]; do
  if decom_parse_common_flag "$1"; then
    shift
    continue
  fi
  case "$1" in
    --archive-dir)
      [ $# -ge 2 ] || decom_die "--archive-dir needs a value"
      ARCHIVE_DIR="$2"
      shift 2
      ;;
    --repo)
      [ $# -ge 2 ] || decom_die "--repo needs a value"
      REPO="$2"
      shift 2
      ;;
    --remote-url)
      [ $# -ge 2 ] || decom_die "--remote-url needs a value"
      REMOTE_URL="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      decom_die "unknown argument: $1"
      ;;
  esac
done
decom_validate_mode
case "$REPO" in
  */*) ;;
  *) decom_die "--repo must be OWNER/NAME" ;;
esac
OWNER="${REPO%%/*}"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/decom-02.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

decom_banner "02: push the scrubbed backend repo to $REPO (private), verify it, then archive it"

# ---------------------------------------------------------------- checks shared by local and remote
# Every check below prints why it failed.
no_secrets_json_commits() {
  local n
  n="$(git -C "$1" log --all --oneline -- secrets.json | wc -l | tr -d ' ')"
  [ "$n" = "0" ] || {
    decom_say "    $n commit(s) in $1 touch secrets.json"
    return 1
  }
}
no_secrets_json_paths() {
  # Any tree, any commit, any directory.
  if git -C "$1" rev-list --all --objects | cut -d' ' -f2- | grep -E '(^|/)secrets\.json$' >/dev/null; then
    decom_say "    a path named secrets.json is reachable in $1"
    return 1
  fi
}
gitleaks_clean() {
  local log
  log="$TMP_DIR/gitleaks-$(basename "$1").log"
  if ! gitleaks git --no-banner --redact --exit-code 1 "$1" >"$log" 2>&1; then
    decom_say "    gitleaks reported findings or failed for $1 (secrets redacted):"
    sed 's/^/      /' "$log" >&2
    return 1
  fi
}
local_refs() {
  git -C "$ARCHIVE_DIR" for-each-ref --format='%(objectname) %(refname)' refs/heads refs/tags | sort
}

# ---------------------------------------------------------------- prerequisites
decom_section "Prerequisites"
decom_require_tools git gh gitleaks

is_git_repo() { git -C "$ARCHIVE_DIR" rev-parse --git-dir >/dev/null 2>&1; }
no_remotes() {
  local remotes
  remotes="$(git -C "$ARCHIVE_DIR" remote)"
  [ -z "$remotes" ] || {
    decom_say "    remotes present: $remotes"
    return 1
  }
}
only_branches_and_tags() {
  local other
  other="$(git -C "$ARCHIVE_DIR" for-each-ref --format='%(refname)' | grep -v -E '^refs/(heads|tags)/' || true)"
  [ -z "$other" ] || {
    decom_say "    refs other than branches and tags: $other"
    return 1
  }
}
has_main() { git -C "$ARCHIVE_DIR" rev-parse --verify --quiet refs/heads/main >/dev/null; }
worktree_clean() { [ -z "$(git -C "$ARCHIVE_DIR" status --porcelain)" ]; }
no_secrets_json_file() { [ ! -e "$ARCHIVE_DIR/secrets.json" ]; }

if decom_check "$ARCHIVE_DIR is a git repository" is_git_repo; then
  decom_check "scrubbed clone has no remotes" no_remotes
  decom_check "scrubbed clone has only branches and tags" only_branches_and_tags
  decom_check "scrubbed clone has a main branch" has_main
  decom_check "scrubbed clone working tree is clean" worktree_clean
  decom_check "scrubbed clone has no secrets.json on disk" no_secrets_json_file
  decom_check "git log --all -- secrets.json is empty in the scrubbed clone" no_secrets_json_commits "$ARCHIVE_DIR"
  decom_check "no path named secrets.json in any commit of the scrubbed clone" no_secrets_json_paths "$ARCHIVE_DIR"
  decom_check "gitleaks finds nothing in the scrubbed clone's history" gitleaks_clean "$ARCHIVE_DIR"
  decom_say "  local refs to publish:"
  local_refs | sed 's/^/    /' >&2
fi

gh_authed() { gh auth status --hostname github.com >/dev/null 2>&1; }
can_create_in_owner() {
  local login role
  login="$(gh api user --jq .login)" || return 1
  if [ "$login" = "$OWNER" ]; then
    return 0
  fi
  role="$(gh api "user/memberships/orgs/$OWNER" --jq .role 2>/dev/null)" || {
    decom_say "    $login is not a member of $OWNER"
    return 1
  }
  [ "$role" = "admin" ] || {
    decom_say "    $login has role '$role' in $OWNER; creating repos needs admin (or a member repo-creation setting)"
    return 1
  }
}
decom_check_online "gh is logged in to github.com" gh_authed
decom_check_online "the gh user can create repositories in $OWNER" can_create_in_owner

REMOTE_STATE="absent"
REMOTE_JSON=""
if [ "$DECOM_OFFLINE" -eq 1 ]; then
  REMOTE_STATE="<unknown: offline>"
  decom_ro gh repo view "$REPO" --json visibility,isArchived
# The trace is printed here, not by decom_ro_capture, because gh's stderr is kept in a file
# to tell "does not exist" apart from other errors.
elif decom_say "+ [read-only] $(decom_quote gh repo view "$REPO" --json visibility,isArchived)" &&
  REMOTE_JSON="$(gh repo view "$REPO" --json visibility,isArchived --jq '.visibility + " " + (.isArchived|tostring)' 2>"$TMP_DIR/view.err")"; then
  REMOTE_STATE="$REMOTE_JSON"
  decom_say "  $REPO exists: $REMOTE_STATE"
  case "$REMOTE_STATE" in
    PRIVATE\ *) decom_pass "$REPO is private" ;;
    *) decom_fail_prereq "$REPO exists and is not private ($REMOTE_STATE)" ;;
  esac
else
  if grep -q -i 'could not resolve' "$TMP_DIR/view.err"; then
    decom_say "  $REPO does not exist yet; it will be created"
  else
    sed 's/^/    /' "$TMP_DIR/view.err" >&2
    decom_fail_prereq "could not query $REPO"
  fi
fi

if [ -n "$REMOTE_URL" ]; then
  decom_say "  push URL (--remote-url): $REMOTE_URL"
else
  # gh prints nothing when git_protocol is unset; gh's own default is https.
  PROTOCOL="ssh"
  if [ "$DECOM_OFFLINE" -eq 0 ] && decom_have gh; then
    PROTOCOL="$(gh config get git_protocol --host github.com 2>/dev/null)" || PROTOCOL=""
    [ -n "$PROTOCOL" ] || PROTOCOL="https"
  fi
  if [ "$PROTOCOL" = "ssh" ]; then
    REMOTE_URL="git@github.com:$REPO.git"
  else
    REMOTE_URL="https://github.com/$REPO.git"
  fi
  decom_say "  push URL ($PROTOCOL): $REMOTE_URL"
fi

decom_prereq_gate

# ---------------------------------------------------------------- apply
remote_refs() {
  git ls-remote "$REMOTE_URL" 'refs/heads/*' 'refs/tags/*' | awk '$2 !~ /\^\{\}$/ {print $1" "$2}' | sort
}
refs_match() {
  [ "$(remote_refs)" = "$(local_refs)" ]
}

decom_section "1. Create the private repository"
case "$REMOTE_STATE" in
  absent)
    decom_run gh repo create "$REPO" --private --description "$DESCRIPTION" --disable-issues --disable-wiki
    ;;
  "<unknown: offline>")
    decom_run gh repo create "$REPO" --private --description "$DESCRIPTION" --disable-issues --disable-wiki
    decom_say "  (offline: skipped when the repo already exists and is private)"
    ;;
  *)
    decom_say "  $REPO already exists and is private; not creating it"
    ;;
esac

decom_section "2. Push every branch and tag (no force)"
case "$REMOTE_STATE" in
  *" true")
    decom_say "  $REPO is already archived; pushing is not possible. Checking its refs match instead."
    if refs_match; then
      decom_pass "remote refs equal the scrubbed clone's refs"
    else
      decom_say "  remote refs:"
      remote_refs | sed 's/^/    /' >&2
      decom_die "$REPO is archived and its refs differ from the scrubbed clone. Unarchive it in GitHub settings only if you mean to update it."
    fi
    ;;
  *)
    decom_run git -C "$ARCHIVE_DIR" push --porcelain "$REMOTE_URL" 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'
    ;;
esac

decom_section "3. Verify the remote"
if [ "$DECOM_EXECUTE" -eq 1 ]; then
  decom_say "+ [read-only] $(decom_quote git ls-remote "$REMOTE_URL" 'refs/heads/*' 'refs/tags/*')"
  if refs_match; then
    decom_pass "remote branches and tags equal the scrubbed clone's (same commit ids)"
  else
    decom_say "  remote refs:"
    remote_refs | sed 's/^/    /' >&2
    decom_die "remote refs differ from the scrubbed clone"
  fi
  decom_say "+ [read-only] git clone --mirror $REMOTE_URL $TMP_DIR/remote.git"
  git clone --quiet --mirror "$REMOTE_URL" "$TMP_DIR/remote.git"
  no_secrets_json_commits "$TMP_DIR/remote.git" || decom_die "the remote has commits touching secrets.json"
  decom_pass "fresh mirror clone: git log --all -- secrets.json is empty"
  no_secrets_json_paths "$TMP_DIR/remote.git" || decom_die "the remote has a secrets.json path"
  decom_pass "fresh mirror clone: no path named secrets.json in any commit"
  gitleaks_clean "$TMP_DIR/remote.git" || decom_die "gitleaks found something in the remote"
  decom_pass "fresh mirror clone: gitleaks finds nothing"
  if [ "$(git -C "$TMP_DIR/remote.git" ls-tree -r --name-only HEAD)" = "$(git -C "$ARCHIVE_DIR" ls-tree -r --name-only HEAD)" ]; then
    decom_pass "fresh mirror clone: HEAD has the same file list as the scrubbed clone"
  else
    decom_die "the remote HEAD file list differs from the scrubbed clone"
  fi
else
  printf 'DRY-RUN would run: %s and compare it with the local refs\n' "$(decom_quote git ls-remote "$REMOTE_URL" 'refs/heads/*' 'refs/tags/*')" >&2
  printf 'DRY-RUN would run: %s\n' "$(decom_quote git clone --mirror "$REMOTE_URL" "$TMP_DIR/remote.git")" >&2
  decom_say "DRY-RUN would check in that clone: git log --all -- secrets.json is empty, no secrets.json path in any commit, gitleaks git is clean, HEAD file list equals the scrubbed clone's"
fi

decom_section "4. Archive the repository"
case "$REMOTE_STATE" in
  *" true") decom_say "  already archived" ;;
  *) decom_run gh repo archive "$REPO" --yes ;;
esac

decom_section "5. Final state"
if [ "$DECOM_EXECUTE" -eq 1 ]; then
  FINAL=""
  decom_ro_capture FINAL gh repo view "$REPO" --json visibility,isArchived --jq '.visibility + " " + (.isArchived|tostring)' ||
    decom_die "could not read $REPO"
  if [ "$FINAL" = "PRIVATE true" ]; then
    decom_pass "$REPO is private and archived"
  else
    decom_die "$REPO is '$FINAL', expected 'PRIVATE true'"
  fi
else
  printf 'DRY-RUN would check: %s prints "PRIVATE true"\n' "$(decom_quote gh repo view "$REPO" --json visibility,isArchived)" >&2
fi

decom_finish
