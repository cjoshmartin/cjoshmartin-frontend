#!/usr/bin/env bash
# Check the teardown (plan §12.I, tests 37-41, plus D10/D11 details) and print PASS or FAIL
# for each check. Read-only: it changes nothing, so there is no --execute. Every command it
# runs is printed.
#
#   FAIL         the step is not done (or is broken)
#   NOT CHECKED  the check could not run (no permission, no network, or --ssh not given)
#   WARN         informational, outside the approved plan; does not affect the exit status
#
# Exit status: 0 when every required check passes, 1 otherwise.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  cat >&2 <<EOF
Usage: $(basename "$0") [--ssh] [--host USER@HOST] [--app NAME]

  --ssh        also check over SSH that the Dokku app is gone (needs the owner's SSH key)
  --host       Dokku SSH target (default: dokku@159.203.93.178)
  --app        Dokku app (default: cjoshmartin-django)

Run as the com-cjoshmartin owner (gcloud) for the IAM and key checks.
Environment: MIGRATION_DIR (default \$HOME/cjoshmartin-migration).
EOF
}

USE_SSH=0
HOST="dokku@159.203.93.178"
APP="cjoshmartin-django"
SERVER_IP="159.203.93.178"
BACKEND_HOST="backend.cjoshmartin.com"
ZONE="cjoshmartin.com"
OLD_BUCKET="images-for-cms"
BACKUP_BUCKET="cjoshmartin-sanity-backups"
PROJECT="com-cjoshmartin"
SA_MAIN="file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com"
SA_LEGACY="fileuploads@com-cjoshmartin.iam.gserviceaccount.com"
ARCHIVE_REPO="cjoshmartin-com/cjoshmartin-backend-archive"
OLD_REPO="cjoshmartin-com/backend.cjoshmartin.com"
GCS_LIST="$DECOM_MIGRATION_DIR/final/gcs-file-list.txt"

while [ $# -gt 0 ]; do
  case "$1" in
    --ssh)
      USE_SSH=1
      shift
      ;;
    --host | --app)
      [ $# -ge 2 ] || decom_die "$1 needs a value"
      if [ "$1" = "--host" ]; then HOST="$2"; else APP="$2"; fi
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      decom_die "unknown argument: $1 (this script is read-only and has no --execute)"
      ;;
  esac
done

TMP_BASE="${TMPDIR:-/tmp}"
TMP_DIR="$(mktemp -d "${TMP_BASE%/}/decom-05.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

RESULTS=""
FAILED=0
# record STATUS ID DESCRIPTION DETAIL
record() {
  RESULTS="$RESULTS$1|$2|$3|$4
"
  case "$1" in
    PASS | WARN) ;;
    *) FAILED=1 ;;
  esac
  printf '  -> %s: %s\n' "$1" "$4" >&2
}
trace() { printf '+ [read-only] %s\n' "$(decom_quote "$@")" >&2; }

decom_say "05: verify the backend teardown (read-only)"

# ---------------------------------------------------------------- 37 DNS
decom_section "37. $BACKEND_HOST no longer resolves"
dns_lookup() { # SERVER TYPE -> answers, or exit 1 on a lookup error
  local out
  out="$(dig +short +time=5 +tries=2 "@$1" "$BACKEND_HOST" "$2")" || return 1
  case "$out" in
    *";;"*) return 1 ;;
  esac
  printf '%s' "$out"
}
if ! decom_have dig; then
  record "NOT CHECKED" 37 "DNS record removed" "dig is not installed"
else
  trace dig +short NS "$ZONE"
  NAMESERVERS="$(dig +short +time=5 +tries=2 NS "$ZONE" | grep -v '^;' || true)"
  if [ -z "$NAMESERVERS" ]; then
    record "NOT CHECKED" 37 "DNS record removed" "could not find the authoritative name servers for $ZONE"
  else
    ANSWERS=""
    LOOKUP_ERROR=""
    for ns in $NAMESERVERS; do
      for type in A AAAA CNAME; do
        trace dig +short "@$ns" "$BACKEND_HOST" "$type"
        if out="$(dns_lookup "$ns" "$type")"; then
          [ -z "$out" ] || ANSWERS="$ANSWERS $ns:$type=$(printf '%s' "$out" | tr '\n' ',')"
        else
          LOOKUP_ERROR="$LOOKUP_ERROR $ns:$type"
        fi
      done
    done
    if [ -n "$ANSWERS" ]; then
      record FAIL 37 "DNS record removed" "authoritative answers:$ANSWERS"
    elif [ -n "$LOOKUP_ERROR" ]; then
      record "NOT CHECKED" 37 "DNS record removed" "lookups failed:$LOOKUP_ERROR"
    else
      record PASS 37 "DNS record removed" "no A, AAAA or CNAME at $(printf '%s' "$NAMESERVERS" | tr '\n' ' ')"
      for resolver in 1.1.1.1 8.8.8.8; do
        trace dig +short "@$resolver" "$BACKEND_HOST" A
        if cached="$(dns_lookup "$resolver" A)" && [ -n "$cached" ]; then
          record WARN 37 "public resolver $resolver" "still answers $cached from cache (TTL is 600 s; re-check later)"
        fi
      done
    fi
  fi
fi

# ---------------------------------------------------------------- 37b backend no longer served
decom_section "37b. $SERVER_IP no longer serves the Wagtail API for $BACKEND_HOST"
API_URL="https://$BACKEND_HOST/api/pages/?format=json&fields=_,id&limit=1"
trace curl -sk --resolve "$BACKEND_HOST:443:$SERVER_IP" "$API_URL"
CODE="$(curl -sk --max-time 20 --resolve "$BACKEND_HOST:443:$SERVER_IP" -o "$TMP_DIR/api.json" -w '%{http_code}' "$API_URL" || true)"
if [ "$CODE" = "200" ] && grep -q '"total_count"' "$TMP_DIR/api.json" 2>/dev/null; then
  record FAIL 37b "Dokku stopped serving the backend" "the Wagtail pages API still answers 200 at $SERVER_IP"
else
  record PASS 37b "Dokku stopped serving the backend" "no Wagtail API response (HTTP ${CODE:-none})"
fi

# ---------------------------------------------------------------- 38 old image URL
decom_section "38. Old image URLs return 403"
SAMPLE=""
if [ -s "$GCS_LIST" ]; then
  SAMPLE="$(grep -o -m 1 "gs://$OLD_BUCKET/original_images/[^[:space:]]*[^/:]\$" "$GCS_LIST" || true)"
fi
if [ -z "$SAMPLE" ]; then
  record "NOT CHECKED" 38 "old image URL denied" "no original_images/ object listed in $GCS_LIST"
else
  URL="https://storage.googleapis.com/${SAMPLE#gs://}"
  trace curl -s -o /dev/null -w '%{http_code}' "$URL"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$URL" || true)"
  case "$CODE" in
    403 | 401) record PASS 38 "old image URL denied" "HTTP $CODE for $URL" ;;
    000 | "") record "NOT CHECKED" 38 "old image URL denied" "no response from storage.googleapis.com" ;;
    *) record FAIL 38 "old image URL denied" "HTTP $CODE for $URL (expected 403)" ;;
  esac
fi

# ---------------------------------------------------------------- D11 bucket settings
decom_section "D11. gs://$OLD_BUCKET is private"
trace gcloud storage buckets get-iam-policy "gs://$OLD_BUCKET" --format=json
if POLICY="$(gcloud storage buckets get-iam-policy "gs://$OLD_BUCKET" --format=json 2>"$TMP_DIR/iam.err")"; then
  PUBLIC="$(printf '%s' "$POLICY" | python3 -I -c '
import json, sys
for b in json.load(sys.stdin).get("bindings", []):
    for m in b.get("members", []):
        if m in ("allUsers", "allAuthenticatedUsers"):
            print("%s:%s" % (m, b["role"]))
' | tr '\n' ' ' | sed 's/ $//')"
  if [ -z "$PUBLIC" ]; then
    record PASS D11a "no allUsers/allAuthenticatedUsers bindings" "none in the bucket IAM policy"
  else
    record FAIL D11a "no allUsers/allAuthenticatedUsers bindings" "still bound: $PUBLIC"
  fi
else
  record "NOT CHECKED" D11a "no allUsers/allAuthenticatedUsers bindings" "$(head -n 1 "$TMP_DIR/iam.err")"
fi
trace gcloud storage buckets describe "gs://$OLD_BUCKET" --format='value(public_access_prevention)'
if PAP="$(gcloud storage buckets describe "gs://$OLD_BUCKET" --format='value(public_access_prevention)' 2>"$TMP_DIR/pap.err")"; then
  if [ "$PAP" = "enforced" ]; then
    record PASS D11b "public access prevention enforced" "enforced"
  else
    record FAIL D11b "public access prevention enforced" "public_access_prevention is '$PAP'"
  fi
else
  record "NOT CHECKED" D11b "public access prevention enforced" "$(head -n 1 "$TMP_DIR/pap.err")"
fi

# ---------------------------------------------------------------- 39 keys
decom_section "39. No user-managed keys on the leaked service account"
key_check() { # ID SA REQUIRED(1|0)
  local id="$1" sa="$2" required="$3" keys label
  label="no user-managed keys on ${sa%%.iam.gserviceaccount.com}"
  trace gcloud iam service-accounts keys list --iam-account "$sa" --project "$PROJECT" --managed-by=user --format=json
  if keys="$(gcloud iam service-accounts keys list --iam-account "$sa" --project "$PROJECT" --managed-by=user --format=json 2>"$TMP_DIR/keys.err")"; then
    keys="$(printf '%s' "$keys" | python3 -I -c '
import json, sys
for k in json.load(sys.stdin):
    if k.get("keyType") == "USER_MANAGED":
        print(k["name"].rsplit("/", 1)[-1])
')"
    if [ -z "$keys" ]; then
      record PASS "$id" "$label" "none"
    elif [ "$required" = 1 ]; then
      record FAIL "$id" "$label" "$(printf '%s' "$keys" | wc -l | tr -d ' ') key(s) remain (ids withheld)"
    else
      record WARN "$id" "$label" "$(printf '%s' "$keys" | wc -l | tr -d ' ') key(s) remain; run 04-gcs-lockdown.sh --include-legacy-sa to revoke"
    fi
  elif [ "$required" = 1 ]; then
    record "NOT CHECKED" "$id" "$label" "$(grep -m 1 -o "Permission '[^']*' denied" "$TMP_DIR/keys.err" || head -n 1 "$TMP_DIR/keys.err")"
  else
    record WARN "$id" "$label" "could not list keys (needs the $PROJECT owner)"
  fi
}
key_check 39 "$SA_MAIN" 1
key_check 39-legacy "$SA_LEGACY" 0

# ---------------------------------------------------------------- 40 archive repo
decom_section "40. $ARCHIVE_REPO is private, archived and has no secrets.json"
trace gh repo view "$ARCHIVE_REPO" --json visibility,isArchived
if STATE="$(gh repo view "$ARCHIVE_REPO" --json visibility,isArchived --jq '.visibility + " " + (.isArchived|tostring)' 2>"$TMP_DIR/gh.err")"; then
  if [ "$STATE" = "PRIVATE true" ]; then
    record PASS 40a "archive repo private and archived" "$STATE"
  else
    record FAIL 40a "archive repo private and archived" "visibility/archived is '$STATE'"
  fi
  trace gh repo clone "$ARCHIVE_REPO" "$TMP_DIR/archive.git" -- --mirror --quiet
  if gh repo clone "$ARCHIVE_REPO" "$TMP_DIR/archive.git" -- --mirror --quiet >/dev/null 2>"$TMP_DIR/clone.err"; then
    trace git -C "$TMP_DIR/archive.git" log --all --oneline -- secrets.json
    n="$(git -C "$TMP_DIR/archive.git" log --all --oneline -- secrets.json | wc -l | tr -d ' ')"
    paths="$(git -C "$TMP_DIR/archive.git" rev-list --all --objects | cut -d' ' -f2- | grep -c -E '(^|/)secrets\.json$' || true)"
    if [ "$n" = "0" ] && [ "$paths" = "0" ]; then
      record PASS 40b "fresh clone has no secrets.json history" "git log --all -- secrets.json is empty; no secrets.json path in any commit"
    else
      record FAIL 40b "fresh clone has no secrets.json history" "$n commit(s), $paths path(s)"
    fi
  else
    record "NOT CHECKED" 40b "fresh clone has no secrets.json history" "clone failed: $(head -n 1 "$TMP_DIR/clone.err")"
  fi
elif grep -q -i 'could not resolve' "$TMP_DIR/gh.err"; then
  record FAIL 40a "archive repo private and archived" "$ARCHIVE_REPO does not exist yet"
  record FAIL 40b "fresh clone has no secrets.json history" "$ARCHIVE_REPO does not exist yet"
else
  record "NOT CHECKED" 40a "archive repo private and archived" "$(head -n 1 "$TMP_DIR/gh.err")"
  record "NOT CHECKED" 40b "fresh clone has no secrets.json history" "gh could not read the repo"
fi
trace gh repo view "$OLD_REPO" --json visibility,isArchived
if OLD_STATE="$(gh repo view "$OLD_REPO" --json visibility,isArchived --jq '.visibility + " archived=" + (.isArchived|tostring)' 2>/dev/null)"; then
  record WARN 40-old "old repo $OLD_REPO" "still exists ($OLD_STATE) with unscrubbed history (secrets.json); deleting it is an owner decision outside the plan"
fi

# ---------------------------------------------------------------- 41 archive folder
decom_section "41. gs://$BACKUP_BUCKET/archive/ holds the final dump, the export and the file list"
trace gcloud storage objects list "gs://$BACKUP_BUCKET/archive/**" --format='value(name)'
if NAMES="$(gcloud storage objects list "gs://$BACKUP_BUCKET/archive/**" --format='value(name)' 2>"$TMP_DIR/ls.err")"; then
  missing=""
  for want in wagtail-export.zip dumpdata.json gcs-file-list.txt SHA256SUMS; do
    printf '%s\n' "$NAMES" | awk -F/ -v w="$want" '$NF == w { f = 1 } END { exit !f }' || missing="$missing $want"
  done
  printf '%s\n' "$NAMES" | grep -q '\.dump$' || missing="$missing <final .dump>"
  if [ -z "$missing" ]; then
    record PASS 41 "archive folder complete" "$(printf '%s\n' "$NAMES" | awk 'NF' | wc -l | tr -d ' ') objects under archive/"
  else
    record FAIL 41 "archive folder complete" "missing:$missing"
  fi
elif grep -q -E '404|not found' "$TMP_DIR/ls.err"; then
  record FAIL 41 "archive folder complete" "gs://$BACKUP_BUCKET does not exist yet"
else
  record "NOT CHECKED" 41 "archive folder complete" "$(head -n 1 "$TMP_DIR/ls.err")"
fi

# ---------------------------------------------------------------- D10 Dokku
decom_section "D10. Dokku app $APP is destroyed"
if [ "$USE_SSH" -eq 1 ]; then
  trace ssh -n -o BatchMode=yes -o ConnectTimeout=20 "$HOST" -- apps:exists "$APP"
  rc=0
  ssh -n -o BatchMode=yes -o ConnectTimeout=20 "$HOST" -- apps:exists "$APP" >/dev/null 2>"$TMP_DIR/ssh.err" || rc=$?
  case "$rc" in
    0) record FAIL D10 "Dokku app destroyed" "$APP still exists" ;;
    255) record "NOT CHECKED" D10 "Dokku app destroyed" "ssh failed: $(head -n 1 "$TMP_DIR/ssh.err")" ;;
    *) record PASS D10 "Dokku app destroyed" "apps:exists $APP exits $rc" ;;
  esac
  trace ssh -n -o BatchMode=yes -o ConnectTimeout=20 "$HOST" -- --quiet postgres:list
  ssh -n -o BatchMode=yes -o ConnectTimeout=20 "$HOST" -- --quiet postgres:list >&2 ||
    decom_say "  (could not list Postgres services)"
else
  record "NOT CHECKED" D10 "Dokku app destroyed" "pass --ssh (owner's SSH key) to check"
fi

# ---------------------------------------------------------------- site
decom_section "Site serves from Sanity only"
if decom_site_cut_over; then
  record PASS site "site no longer uses the backend or images-for-cms" "$DECOM_SITE_PATHS reference cdn.sanity.io only"
else
  record FAIL site "site no longer uses the backend or images-for-cms" "$DECOM_SITE_REASON"
fi

# ---------------------------------------------------------------- summary
printf '\n%-12s %-10s %-52s %s\n' STATUS CHECK DESCRIPTION DETAIL
while IFS='|' read -r status id desc detail; do
  [ -n "$status" ] || continue
  printf '%-12s %-10s %-52s %s\n' "$status" "$id" "$desc" "$detail"
done <<EOF
$RESULTS
EOF
if [ "$FAILED" -eq 0 ]; then
  printf '\nAll required checks passed.\n'
  exit 0
fi
printf '\nSome required checks are FAIL (not done yet) or NOT CHECKED.\n'
exit 1
