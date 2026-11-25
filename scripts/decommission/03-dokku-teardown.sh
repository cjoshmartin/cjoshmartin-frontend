#!/usr/bin/env bash
# Tear down the Wagtail backend on Dokku, in two phases. The owner runs this (it needs the
# owner's SSH key for dokku@159.203.93.178).
#
#   export   find the app's Postgres service (postgres:list, postgres:app-links, postgres:info),
#            save `postgres:export` to $HOME/cjoshmartin-migration/final/wagtail-final.dump and
#            check that the dump is non-empty and readable by `pg_restore --list`, with the
#            Wagtail content tables present.
#   destroy  only after the dump is archived in gs://cjoshmartin-sanity-backups/archive/
#            (01-archive-to-backup-bucket.sh) and the live site no longer uses the backend:
#            a typed confirmation of the app name, then
#              apps:destroy --force cjoshmartin-django
#              postgres:destroy <service> --force
#            and a check that both are gone.
#
# Re-running is safe: a valid dump is not exported again (unless --re-export), and an app or
# service that no longer exists is not destroyed again.
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
Usage: $(basename "$0") [--execute | --offline] [options] export|destroy

  export     export the Postgres service to the dump file and check it
  destroy    destroy the Dokku app and its Postgres service (after the archive upload)

Options:
  --host USER@HOST  Dokku SSH target (default: dokku@159.203.93.178)
  --app NAME        Dokku app (default: cjoshmartin-django)
  --service NAME    Postgres service (default: the single service linked to the app)
  --dump PATH       dump file (default: $DECOM_MIGRATION_DIR/final/wagtail-final.dump)
  --bucket NAME     backup bucket holding archive/ (default: cjoshmartin-sanity-backups)
  --re-export       export again even if a valid dump already exists
  --execute         make changes (default is a dry-run that changes nothing)
  --offline         dry-run without contacting the server, GCS or the site

Environment: MIGRATION_DIR (default \$HOME/cjoshmartin-migration), PG_RESTORE (a pg_restore binary to prefer).
EOF
}

HOST="dokku@159.203.93.178"
APP="cjoshmartin-django"
SERVICE=""
DUMP="$DECOM_MIGRATION_DIR/final/wagtail-final.dump"
BUCKET="cjoshmartin-sanity-backups"
RE_EXPORT=0
PHASE=""
while [ $# -gt 0 ]; do
  if decom_parse_common_flag "$1"; then
    shift
    continue
  fi
  case "$1" in
    --host | --app | --service | --dump | --bucket)
      [ $# -ge 2 ] || decom_die "$1 needs a value"
      case "$1" in
        --host) HOST="$2" ;;
        --app) APP="$2" ;;
        --service) SERVICE="$2" ;;
        --dump) DUMP="$2" ;;
        --bucket) BUCKET="$2" ;;
      esac
      shift 2
      ;;
    --re-export)
      RE_EXPORT=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    export | destroy)
      [ -z "$PHASE" ] || decom_die "give exactly one phase"
      PHASE="$1"
      shift
      ;;
    *)
      usage
      decom_die "unknown argument: $1"
      ;;
  esac
done
decom_validate_mode
if [ -z "$PHASE" ]; then
  usage
  decom_die "a phase is required: export or destroy"
fi

# Tables that must be in the dump's table of contents.
REQUIRED_TABLES="wagtailcore_page wagtailcore_revision wagtailimages_image wagtailmedia_media wagtaildocs_document blog_blogpage blog_projectpage home_homepage home_testimonial home_service home_author flex_flexpage"

TMP_BASE="${TMPDIR:-/tmp}"
TMP_DIR="$(mktemp -d "${TMP_BASE%/}/decom-03.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

# Every Dokku command goes over SSH as: ssh <opts> dokku@host -- <dokku args>
# -n: ssh never reads this terminal, so it cannot swallow the typed confirmation.
SSH=(ssh -n -o BatchMode=yes -o ConnectTimeout=20 "$HOST" --)

decom_banner "03 ($PHASE): Dokku app $APP on $HOST"

# ---------------------------------------------------------------- dump checks
# Print the major version of a pg_restore binary.
pg_major() {
  "$1" --version 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+(\.[0-9]+)*$/) { split($i, v, "."); print v[1]; exit } }'
}

# Print the newest pg_restore found on this machine, or nothing.
newest_pg_restore() {
  local best="" best_major=0 candidate major
  for candidate in "${PG_RESTORE:-}" "$(command -v pg_restore 2>/dev/null || true)" \
    /opt/homebrew/opt/postgresql@*/bin/pg_restore /usr/local/opt/postgresql@*/bin/pg_restore \
    /Applications/Postgres.app/Contents/Versions/*/bin/pg_restore; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    major="$(pg_major "$candidate")"
    [ -n "$major" ] || continue
    if [ "$major" -gt "$best_major" ]; then
      best="$candidate"
      best_major="$major"
    fi
  done
  printf '%s' "$best"
}

# Write the dump's table of contents to $2. Uses the newest local pg_restore; if it is older
# than the pg_dump that wrote the file, uses pg_restore from the service's own Docker image
# (postgres:info --version), or postgres:<major>, instead.
SERVER_MAJOR=""
SERVICE_IMAGE=""
dump_toc() {
  local dump="$1" out="$2" local_bin dir base image
  local_bin="$(newest_pg_restore)"
  if [ -n "$local_bin" ]; then
    decom_say "    + [read-only] $(decom_quote "$local_bin" --list "$dump")"
    if "$local_bin" --list "$dump" >"$out" 2>"$out.err"; then
      return 0
    fi
    if ! grep -q -i 'unsupported version' "$out.err"; then
      sed 's/^/      /' "$out.err" >&2
      return 1
    fi
    decom_say "    $local_bin (major $(pg_major "$local_bin")) is older than the dump's pg_dump; trying Docker"
  fi
  decom_have docker || {
    decom_say "    no suitable pg_restore: install postgresql@${SERVER_MAJOR:-<server major>} (brew) or Docker"
    return 1
  }
  dir="$(cd "$(dirname "$dump")" && pwd)"
  base="$(basename "$dump")"
  case "$SERVICE_IMAGE" in
    postgres:*) image="$SERVICE_IMAGE" ;;
    *) image="postgres:${SERVER_MAJOR:-latest}" ;;
  esac
  decom_say "    + [read-only] $(decom_quote docker run --rm -v "$dir:/dump:ro" "$image" pg_restore --list "/dump/$base")"
  docker run --rm -v "$dir:/dump:ro" "$image" pg_restore --list "/dump/$base" >"$out" 2>"$out.err" || {
    sed 's/^/      /' "$out.err" >&2
    return 1
  }
}

# Non-empty, custom format, readable TOC, required tables present. Prints a summary.
dump_valid() {
  local dump="$1" toc="$TMP_DIR/toc.txt" table missing=""
  [ -s "$dump" ] || {
    decom_say "    $dump is missing or empty"
    return 1
  }
  decom_is_pg_custom_dump "$dump" || {
    decom_say "    $dump is not a pg_dump custom-format file"
    return 1
  }
  dump_toc "$dump" "$toc" || return 1
  for table in $REQUIRED_TABLES; do
    grep -q -E "TABLE DATA public $table( |$)" "$toc" || missing="$missing $table"
  done
  if [ -n "$missing" ]; then
    decom_say "    the dump has no TABLE DATA for:$missing"
    return 1
  fi
  decom_say "    $(decom_file_size "$dump") bytes, sha256 $(decom_sha256 "$dump")"
  decom_say "    $(grep -c 'TABLE DATA' "$toc") TABLE DATA entries; all $(echo "$REQUIRED_TABLES" | wc -w | tr -d ' ') required Wagtail tables present"
  grep -E '^;[[:space:]]+(Dumped from database version|Dumped by pg_dump version|Format|Dump Version)' "$toc" | sed 's/^;[[:space:]]*/    /' >&2 ||
    decom_say "    (the TOC has no version header lines)"
}

# ---------------------------------------------------------------- discovery (read-only, over SSH)
decom_section "Prerequisites and discovery"
decom_require_tools ssh
APP_EXISTS="<unknown>"
SERVICE_EXISTS="<unknown>"
SERVICE_LINKS=""

if [ "$DECOM_OFFLINE" -eq 1 ]; then
  decom_ro "${SSH[@]}" apps:exists "$APP"
  decom_ro "${SSH[@]}" --quiet postgres:list
  decom_ro "${SSH[@]}" --quiet postgres:app-links "$APP"
  decom_ro "${SSH[@]}" postgres:info "${SERVICE:-<service>}" --version
  decom_ro "${SSH[@]}" --quiet postgres:links "${SERVICE:-<service>}"
  [ -n "$SERVICE" ] || SERVICE="<service linked to $APP>"
else
  decom_say "+ [read-only] $(decom_quote "${SSH[@]}" apps:exists "$APP")"
  if "${SSH[@]}" apps:exists "$APP" >/dev/null 2>&1; then
    APP_EXISTS=yes
    decom_say "  app $APP exists"
  else
    APP_EXISTS=no
    decom_say "  app $APP does not exist (already destroyed, or the name is wrong)"
  fi

  ALL_SERVICES=""
  if decom_ro_capture ALL_SERVICES "${SSH[@]}" --quiet postgres:list; then
    decom_say "  Postgres services on the host:"
    printf '%s\n' "$ALL_SERVICES" | sed 's/^/    /' >&2
  else
    decom_fail_prereq "could not list Postgres services over SSH (is your key loaded? try: ssh $HOST version)"
  fi

  if [ -z "$SERVICE" ]; then
    if [ "$APP_EXISTS" = yes ]; then
      LINKED=""
      if decom_ro_capture LINKED "${SSH[@]}" --quiet postgres:app-links "$APP"; then
        LINKED="$(printf '%s\n' "$LINKED" | awk 'NF { print $1 }')"
        count="$(printf '%s\n' "$LINKED" | awk 'NF' | wc -l | tr -d ' ')"
        if [ "$count" = "1" ]; then
          SERVICE="$LINKED"
          decom_pass "exactly one Postgres service is linked to $APP: $SERVICE"
        else
          decom_fail_prereq "expected exactly one Postgres service linked to $APP, found $count; pass --service NAME"
        fi
      else
        decom_fail_prereq "could not read postgres:app-links $APP"
      fi
    else
      decom_fail_prereq "$APP does not exist, so its service cannot be discovered; pass --service NAME"
    fi
  fi

  if [ -n "$SERVICE" ]; then
    decom_say "+ [read-only] $(decom_quote "${SSH[@]}" postgres:exists "$SERVICE")"
    if "${SSH[@]}" postgres:exists "$SERVICE" >/dev/null 2>&1; then
      SERVICE_EXISTS=yes
      VERSION=""
      if decom_ro_capture VERSION "${SSH[@]}" postgres:info "$SERVICE" --version; then
        SERVICE_IMAGE="$(printf '%s\n' "$VERSION" | awk 'NF { line = $NF } END { print line }')"
        SERVER_MAJOR="$(printf '%s\n' "$SERVICE_IMAGE" | sed -n -E 's/^[^:]*:([0-9]+).*/\1/p')"
        decom_say "  service image: ${SERVICE_IMAGE:-<unknown>} (major ${SERVER_MAJOR:-<unknown>})"
      else
        decom_say "  could not read the service image version; the dump check will try local pg_restore first"
      fi
      if decom_ro_capture SERVICE_LINKS "${SSH[@]}" --quiet postgres:links "$SERVICE"; then
        SERVICE_LINKS="$(printf '%s\n' "$SERVICE_LINKS" | awk 'NF { print $1 }')"
        decom_say "  apps linked to $SERVICE: $(printf '%s' "$SERVICE_LINKS" | tr '\n' ' ')"
      else
        decom_fail_prereq "could not read postgres:links $SERVICE"
      fi
    else
      SERVICE_EXISTS=no
      decom_say "  service $SERVICE does not exist"
    fi
  fi
fi

# ---------------------------------------------------------------- export
if [ "$PHASE" = "export" ]; then
  if [ "$DECOM_OFFLINE" -eq 0 ] && [ "$SERVICE_EXISTS" = no ]; then
    decom_fail_prereq "service $SERVICE does not exist, nothing to export"
  fi
  NEED_EXPORT=1
  if [ -e "$DUMP" ] && [ "$RE_EXPORT" -eq 0 ]; then
    decom_say "  checking the existing dump $DUMP:"
    if dump_valid "$DUMP"; then
      NEED_EXPORT=0
      decom_pass "existing dump is valid; not exporting again (use --re-export to replace it)"
    else
      decom_fail_prereq "$DUMP exists but is not a valid dump; move it aside or pass --re-export"
    fi
  fi
  decom_check "dump directory $(dirname "$DUMP") exists" test -d "$(dirname "$DUMP")"
  decom_prereq_gate

  decom_section "Export"
  if [ "$NEED_EXPORT" -eq 1 ]; then
    if [ "$DECOM_EXECUTE" -eq 1 ]; then
      printf '+ %s > %s\n' "$(decom_quote "${SSH[@]}" postgres:export "$SERVICE")" "$(decom_quote "$DUMP.partial")" >&2
      (
        umask 077
        "${SSH[@]}" postgres:export "$SERVICE" >"$DUMP.partial"
      ) || decom_die "postgres:export failed; any partial output is at $DUMP.partial. Nothing was destroyed."
      decom_say "  checking $DUMP.partial:"
      dump_valid "$DUMP.partial" || decom_die "the export is not a valid dump; kept at $DUMP.partial for inspection. Nothing was destroyed."
      mv -f "$DUMP.partial" "$DUMP"
      decom_sha256 "$DUMP" | sed "s|\$|  $(basename "$DUMP")|" >"$DUMP.sha256"
      decom_pass "saved $DUMP (sha256 in $DUMP.sha256)"
    else
      printf 'DRY-RUN would run: %s > %s\n' "$(decom_quote "${SSH[@]}" postgres:export "$SERVICE")" "$(decom_quote "$DUMP.partial")" >&2
      decom_say "DRY-RUN would check: non-empty, PGDMP header, pg_restore --list succeeds (newest local pg_restore, else Docker postgres:<major>), TABLE DATA present for:"
      decom_say "  $REQUIRED_TABLES"
      decom_say "DRY-RUN would then move it to $DUMP and write $DUMP.sha256"
    fi
  fi
  decom_say ""
  decom_say "Next: 01-archive-to-backup-bucket.sh --execute $DUMP, then $(basename "$0") --execute destroy"
  decom_finish
fi

# ---------------------------------------------------------------- destroy
decom_require_tools gcloud curl openssl python3
decom_say "  checking the local dump $DUMP:"
decom_check "the final dump is valid" dump_valid "$DUMP"

archived_in_bucket() {
  local md5 size base listing
  md5="$(decom_md5_b64 "$DUMP")"
  size="$(decom_file_size "$DUMP")"
  base="$(basename "$DUMP")"
  listing="$(gcloud storage objects list "gs://$BUCKET/archive/**" --format=json)" || return 1
  printf '%s' "$listing" | python3 -I -c '
import json, sys
base, md5, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
hits = [o["name"] for o in json.load(sys.stdin)
        if o["name"].rsplit("/", 1)[-1] == base and o.get("md5_hash") == md5 and int(o["size"]) == size]
for h in hits:
    print("    archived as gs://%s/%s" % (sys.argv[4], h), file=sys.stderr)
sys.exit(0 if hits else 1)
' "$base" "$md5" "$size" "$BUCKET"
}
if [ -s "$DUMP" ]; then
  decom_check_online "the same dump (name, MD5, size) is in gs://$BUCKET/archive/" archived_in_bucket
else
  decom_skip "the dump is in gs://$BUCKET/archive/ (no local dump to compare; already failed above)"
fi
decom_check_online "$DECOM_SITE_URL is served from Sanity and no longer references the backend or images-for-cms" decom_site_cut_over

only_app_linked() {
  local other
  other="$(printf '%s\n' "$SERVICE_LINKS" | awk -v a="$APP" 'NF && $1 != a')"
  [ -z "$other" ] || {
    decom_say "    $SERVICE is also linked to: $other"
    return 1
  }
}
if [ "$DECOM_OFFLINE" -eq 0 ] && [ "$SERVICE_EXISTS" = yes ]; then
  decom_check "$SERVICE is linked to no app other than $APP" only_app_linked
fi
if [ "$DECOM_OFFLINE" -eq 0 ] && [ "$APP_EXISTS" = yes ]; then
  decom_say "  persistent storage mounted into $APP (apps:destroy leaves host directories in place):"
  decom_ro "${SSH[@]}" storage:list "$APP" || decom_say "    (could not list storage)"
fi
decom_prereq_gate

decom_section "Destroy"
if [ "$DECOM_EXECUTE" -eq 1 ]; then
  if [ "$APP_EXISTS" = no ] && [ "$SERVICE_EXISTS" = no ]; then
    decom_say "  $APP and $SERVICE are already gone"
  else
    decom_confirm_typed "$APP" "This permanently destroys the Dokku app '$APP' and the Postgres service '$SERVICE' on $HOST. Type the app name to continue:"
  fi
fi
if [ "$APP_EXISTS" = no ]; then
  decom_say "  app $APP already gone; skipping apps:destroy"
else
  decom_run "${SSH[@]}" apps:destroy --force "$APP"
fi
if [ "$SERVICE_EXISTS" = no ]; then
  decom_say "  service $SERVICE already gone; skipping postgres:destroy"
else
  decom_run "${SSH[@]}" postgres:destroy "$SERVICE" --force
fi

decom_section "Verify"
if [ "$DECOM_EXECUTE" -eq 1 ]; then
  if "${SSH[@]}" apps:exists "$APP" >/dev/null 2>&1; then
    decom_die "$APP still exists"
  fi
  decom_pass "apps:exists $APP fails: the app is gone"
  if "${SSH[@]}" postgres:exists "$SERVICE" >/dev/null 2>&1; then
    decom_die "$SERVICE still exists"
  fi
  decom_pass "postgres:exists $SERVICE fails: the service is gone"
  decom_ro "${SSH[@]}" --quiet postgres:list || decom_say "  (could not list the remaining services)"
else
  decom_say "DRY-RUN would check: $(decom_quote "${SSH[@]}" apps:exists "$APP") fails, and $(decom_quote "${SSH[@]}" postgres:exists "$SERVICE") fails"
fi
decom_say ""
decom_say "Next: delete the 'backend' A record in GoDaddy (README.md), then 04-gcs-lockdown.sh."
decom_finish
