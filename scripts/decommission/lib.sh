# shellcheck shell=bash
# Globals defined here are read by the scripts that source this file.
# shellcheck disable=SC2034
# Shared helpers for scripts/decommission/*.sh. Sourced by those scripts, never run directly.
#
# Works with macOS /bin/bash 3.2: no associative arrays, no mapfile, no namerefs, and no
# expansion of possibly-empty arrays under `set -u`.
#
# Conventions used by every script:
#   - Dry-run is the default. Every command is printed. Read-only queries run so the plan
#     shows real values; commands that change anything run only with --execute.
#   - --offline is a dry-run that contacts nothing (no gcloud, gh, ssh or curl). Values that
#     would be discovered are shown as <placeholders>.
#   - Prerequisites are checked before anything changes. With --execute a failed
#     prerequisite aborts before the first change. In a dry-run the plan is still printed
#     and the script exits 3.
#   - All human-readable output goes to stderr, so command substitution never swallows it.

DECOM_EXECUTE=0
DECOM_OFFLINE=0
DECOM_PREREQ_FAILURES=0
DECOM_MIGRATION_DIR="${MIGRATION_DIR:-$HOME/cjoshmartin-migration}"

# The production site, and pages that must be served from Sanity before anything that the
# old site depends on is removed.
DECOM_SITE_URL="https://cjoshmartin.com"
DECOM_SITE_PATHS="/ /blog /projects"

decom_say() { printf '%s\n' "$*" >&2; }
decom_section() { printf '\n== %s ==\n' "$*" >&2; }
decom_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# Shell-quote a command line for printing.
decom_quote() {
  local out='' arg
  for arg in "$@"; do
    out="$out $(printf '%q' "$arg")"
  done
  printf '%s' "${out# }"
}

# Handle the flags every script accepts. Returns 0 when "$1" was one of them.
decom_parse_common_flag() {
  case "$1" in
    --execute) DECOM_EXECUTE=1 ;;
    --offline) DECOM_OFFLINE=1 ;;
    *) return 1 ;;
  esac
  return 0
}

decom_validate_mode() {
  if [ "$DECOM_EXECUTE" -eq 1 ] && [ "$DECOM_OFFLINE" -eq 1 ]; then
    decom_die "--execute and --offline cannot be combined"
  fi
}

decom_banner() {
  local name="$1"
  decom_say "$name"
  if [ "$DECOM_EXECUTE" -eq 1 ]; then
    decom_say "MODE: EXECUTE. Changes will be made."
  elif [ "$DECOM_OFFLINE" -eq 1 ]; then
    decom_say "MODE: DRY-RUN, OFFLINE. Nothing is contacted or changed; discovered values appear as <placeholders>."
  else
    decom_say "MODE: DRY-RUN. Read-only queries run; nothing is changed. Re-run with --execute to apply."
  fi
}

# Commands run by the helpers below get stdin from /dev/null: several callers loop over a
# plan read from a here-document, which a command reading stdin would otherwise consume.

# A command that changes something. Always printed; run only with --execute.
decom_run() {
  if [ "$DECOM_EXECUTE" -eq 1 ]; then
    printf '+ %s\n' "$(decom_quote "$@")" >&2
    "$@" </dev/null
  else
    printf 'DRY-RUN would run: %s\n' "$(decom_quote "$@")" >&2
  fi
}

# A read-only command whose output is only shown. Printed always; skipped with --offline.
decom_ro() {
  printf '+ [read-only] %s\n' "$(decom_quote "$@")" >&2
  if [ "$DECOM_OFFLINE" -eq 1 ]; then
    printf '  (offline: not run)\n' >&2
    return 0
  fi
  "$@" </dev/null >&2
}

# decom_ro_capture VAR CMD...: run a read-only command and store its stdout in VAR.
# Returns the command's status. With --offline the command is not run, VAR is set to ""
# and 2 is returned.
decom_ro_capture() {
  local __decom_var="$1"
  shift
  printf '+ [read-only] %s\n' "$(decom_quote "$@")" >&2
  if [ "$DECOM_OFFLINE" -eq 1 ]; then
    printf -v "$__decom_var" '%s' ''
    printf '  (offline: not run)\n' >&2
    return 2
  fi
  local __decom_out __decom_rc=0
  __decom_out="$("$@" </dev/null)" || __decom_rc=$?
  printf -v "$__decom_var" '%s' "$__decom_out"
  return "$__decom_rc"
}

decom_pass() { printf '  [PASS] %s\n' "$*" >&2; }
decom_skip() { printf '  [SKIP] %s\n' "$*" >&2; }
decom_fail_prereq() {
  printf '  [FAIL] %s\n' "$*" >&2
  DECOM_PREREQ_FAILURES=$((DECOM_PREREQ_FAILURES + 1))
}

# decom_check DESCRIPTION CMD...: a local, read-only prerequisite.
decom_check() {
  local desc="$1"
  shift
  if "$@"; then
    decom_pass "$desc"
  else
    decom_fail_prereq "$desc"
  fi
}

# decom_check_online DESCRIPTION CMD...: a prerequisite that needs the network. Skipped with --offline.
decom_check_online() {
  local desc="$1"
  shift
  if [ "$DECOM_OFFLINE" -eq 1 ]; then
    decom_skip "$desc (offline)"
    return 0
  fi
  decom_check "$desc" "$@"
}

decom_have() { command -v "$1" >/dev/null 2>&1; }

decom_require_tools() {
  local tool
  for tool in "$@"; do
    decom_check "tool '$tool' is installed" decom_have "$tool"
  done
}

# With --execute, stop before the first change if any prerequisite failed.
decom_prereq_gate() {
  if [ "$DECOM_PREREQ_FAILURES" -gt 0 ]; then
    if [ "$DECOM_EXECUTE" -eq 1 ]; then
      decom_die "$DECOM_PREREQ_FAILURES prerequisite check(s) failed. Nothing was changed."
    fi
    decom_say ""
    decom_say "NOTE: $DECOM_PREREQ_FAILURES prerequisite check(s) failed. The plan below is printed anyway; --execute would refuse to run."
  fi
}

decom_finish() {
  decom_say ""
  if [ "$DECOM_PREREQ_FAILURES" -gt 0 ]; then
    decom_say "DONE (dry-run) with $DECOM_PREREQ_FAILURES failed prerequisite(s). Exit status 3."
    exit 3
  fi
  if [ "$DECOM_EXECUTE" -eq 1 ]; then
    decom_say "DONE. All steps completed and verified."
  else
    decom_say "DONE (dry-run). Nothing was changed. Re-run with --execute to apply."
  fi
  exit 0
}

# Ask the person at the terminal to type EXPECTED. Anything else aborts.
decom_confirm_typed() {
  local expected="$1" prompt="$2" answer=''
  if ! { : </dev/tty; } 2>/dev/null; then
    decom_die "a typed confirmation is required, but there is no terminal. Nothing was destroyed."
  fi
  printf '%s\n> ' "$prompt" >/dev/tty
  IFS= read -r answer </dev/tty || decom_die "could not read the confirmation. Nothing was destroyed."
  if [ "$answer" != "$expected" ]; then
    decom_die "confirmation '$answer' does not match '$expected'. Nothing was destroyed."
  fi
}

decom_file_size() { wc -c <"$1" | tr -d ' '; }

# MD5 of a file, base64-encoded, the form GCS reports in md5_hash.
decom_md5_b64() { openssl dgst -md5 -binary "$1" | base64 | tr -d '\n'; }

decom_sha256() {
  if decom_have shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

# True when the file starts with the pg_dump custom-format magic.
decom_is_pg_custom_dump() {
  [ -s "$1" ] && [ "$(head -c 5 "$1")" = "PGDMP" ]
}

# Succeeds when the production site serves content from Sanity and no longer references the
# old backend or the old bucket. Used as a safety interlock before teardown steps. On failure
# the reason is printed and left in DECOM_SITE_REASON.
DECOM_SITE_REASON=""
decom_site_cut_over() {
  local path html
  DECOM_SITE_REASON=""
  for path in $DECOM_SITE_PATHS; do
    printf '    + [read-only] %s\n' "$(decom_quote curl -fsSL "$DECOM_SITE_URL$path")" >&2
    if ! html="$(curl -fsSL --max-time 30 "$DECOM_SITE_URL$path")"; then
      DECOM_SITE_REASON="could not fetch $DECOM_SITE_URL$path"
    else
      case "$html" in
        *images-for-cms* | *backend.cjoshmartin.com*)
          DECOM_SITE_REASON="$DECOM_SITE_URL$path still references images-for-cms or backend.cjoshmartin.com"
          ;;
        *cdn.sanity.io*) ;;
        *)
          DECOM_SITE_REASON="$DECOM_SITE_URL$path has no cdn.sanity.io reference"
          ;;
      esac
    fi
    if [ -n "$DECOM_SITE_REASON" ]; then
      decom_say "    $DECOM_SITE_REASON"
      return 1
    fi
  done
  return 0
}

# The public (published) query endpoint of the production dataset.
DECOM_SANITY_QUERY_URL="https://j3vdh6ti.api.sanity.io/v2025-02-19/data/query/production"

# Succeeds when every Wagtail video is on Mux: production has a ready `mux-video-<id>` document
# for each media item in the Wagtail export, and every video block of a published post or project
# resolves to a video document. The migration's mux step creates Mux assets only from the public
# images-for-cms URLs, so the bucket must stay public until this holds. On failure the reason is
# printed and left in DECOM_MUX_REASON.
DECOM_MUX_REASON=""
decom_mux_videos_complete() {
  local export_json="$DECOM_MIGRATION_DIR/extracted/export.json" expected query url body verdict
  DECOM_MUX_REASON=""
  if [ ! -s "$export_json" ]; then
    DECOM_MUX_REASON="$export_json is missing; it gives the number of Wagtail videos"
  elif ! expected="$(python3 -I -c 'import json, sys; print(len(json.load(open(sys.argv[1]))["media"]))' "$export_json")"; then
    DECOM_MUX_REASON="cannot read the media list from $export_json"
  else
    query='{"ready": count(*[_type == "mux.videoAsset" && string::startsWith(_id, "mux-video-") && status == "ready"]), "blocks": math::sum(*[_type in ["blogPost", "project"]]{"n": count(body[_type == "video"])}.n), "unresolved": math::sum(*[_type in ["blogPost", "project"]]{"n": count(body[_type == "video" && !defined(asset.asset->_id)])}.n)}'
    url="$DECOM_SANITY_QUERY_URL?query=$(python3 -I -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$query")&perspective=published"
    printf '    + [read-only] %s\n' "$(decom_quote curl -fsS "$url")" >&2
    if ! body="$(curl -fsS --max-time 30 "$url")"; then
      DECOM_MUX_REASON="could not query the production dataset"
    elif ! verdict="$(printf '%s' "$body" | python3 -I -c '
import json, sys
expected = int(sys.argv[1])
r = json.load(sys.stdin)["result"]
ready, blocks, unresolved = r["ready"], r["blocks"] or 0, r["unresolved"] or 0
if ready != expected or unresolved:
    print("%d of %d Wagtail videos have a ready mux.videoAsset in production, and %d of %d published video blocks do not resolve. Finish the videos first (migration/wagtail-to-sanity: --steps mux,videos)" % (ready, expected, unresolved, blocks))
else:
    print("ok %d videos, %d published video blocks" % (ready, blocks))
' "$expected")"; then
      DECOM_MUX_REASON="could not parse the production query result"
    else
      case "$verdict" in
        ok\ *) decom_say "    $verdict" ;;
        *) DECOM_MUX_REASON="$verdict" ;;
      esac
    fi
  fi
  if [ -n "$DECOM_MUX_REASON" ]; then
    decom_say "    $DECOM_MUX_REASON"
    return 1
  fi
  return 0
}

# Print the active gcloud account (informational; the owner of com-cjoshmartin is required).
decom_show_gcloud_account() {
  local account=''
  if decom_ro_capture account gcloud config get-value account; then
    decom_say "  active gcloud account: ${account:-<none>}"
  fi
}
