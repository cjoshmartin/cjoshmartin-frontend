#!/usr/bin/env bash
# Make the old media bucket private and revoke the leaked service-account keys (plan D11).
#   gs://images-for-cms
#     - remove every IAM binding for allUsers and allAuthenticatedUsers
#     - enforce public access prevention
#   file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com
#     - delete every USER_MANAGED key (system-managed keys are never touched)
#   fileuploads@com-cjoshmartin.iam.gserviceaccount.com (only with --include-legacy-sa)
#     - same; its key was committed to the backend repo from 2024-02 to 2025-07
#
# Nothing is deleted from the bucket. Re-running is safe: bindings and keys that are already
# gone are skipped. Removing allUsers makes every old image URL return 403, so this refuses
# to run until https://cjoshmartin.com no longer references images-for-cms. It also refuses
# until every Wagtail video is on Mux, because the migration creates Mux assets from the
# bucket's public URLs (videos Mux's free plan refused can only be migrated while it is public).
#
# --authenticated-users-only removes just the allAuthenticatedUsers bindings (which today
# include roles/storage.admin, i.e. any Google account can administer the bucket). It keeps
# allUsers read access, so the live site keeps working, and it can run before cutover.
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
Usage: $(basename "$0") [--execute | --offline] [--include-legacy-sa | --authenticated-users-only]

  --include-legacy-sa         also delete the user-managed keys of fileuploads@com-cjoshmartin
  --authenticated-users-only  only remove the allAuthenticatedUsers bindings (safe before cutover)
  --project ID                GCP project (default: com-cjoshmartin)
  --bucket NAME               bucket (default: images-for-cms)
  --execute                   make the changes (default is a dry-run that changes nothing)
  --offline                   dry-run without contacting GCP or the site

Run as the com-cjoshmartin owner (gcloud auth login).
EOF
}

PROJECT="com-cjoshmartin"
BUCKET="images-for-cms"
SA_MAIN="file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com"
SA_LEGACY="fileuploads@com-cjoshmartin.iam.gserviceaccount.com"
INCLUDE_LEGACY=0
AUTH_USERS_ONLY=0
while [ $# -gt 0 ]; do
  if decom_parse_common_flag "$1"; then
    shift
    continue
  fi
  case "$1" in
    --include-legacy-sa)
      INCLUDE_LEGACY=1
      shift
      ;;
    --authenticated-users-only)
      AUTH_USERS_ONLY=1
      shift
      ;;
    --project | --bucket)
      [ $# -ge 2 ] || decom_die "$1 needs a value"
      if [ "$1" = "--project" ]; then PROJECT="$2"; else BUCKET="$2"; fi
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
if [ "$AUTH_USERS_ONLY" -eq 1 ] && [ "$INCLUDE_LEGACY" -eq 1 ]; then
  decom_die "--authenticated-users-only cannot be combined with --include-legacy-sa"
fi

if [ "$AUTH_USERS_ONLY" -eq 1 ]; then
  PUBLIC_MEMBERS="allAuthenticatedUsers"
  SERVICE_ACCOUNTS=""
else
  PUBLIC_MEMBERS="allUsers allAuthenticatedUsers"
  SERVICE_ACCOUNTS="$SA_MAIN"
  [ "$INCLUDE_LEGACY" -eq 0 ] || SERVICE_ACCOUNTS="$SA_MAIN $SA_LEGACY"
fi

GCS_LIST="$DECOM_MIGRATION_DIR/final/gcs-file-list.txt"

if [ "$AUTH_USERS_ONLY" -eq 1 ]; then
  decom_banner "04: remove allAuthenticatedUsers access from gs://$BUCKET (allUsers read access is kept)"
else
  decom_banner "04: make gs://$BUCKET private and delete user-managed keys of: $SERVICE_ACCOUNTS"
fi

# Print "<role> <member>" for every public binding in a bucket IAM policy (JSON on stdin).
public_bindings() {
  python3 -I -c '
import json, sys
members = sys.argv[1].split()
policy = json.load(sys.stdin)
for b in policy.get("bindings", []):
    for m in b.get("members", []):
        if m in members:
            print(b["role"], m)
' "$PUBLIC_MEMBERS"
}

# Print the ids of USER_MANAGED keys (JSON key list on stdin). Refuses anything else.
user_managed_key_ids() {
  python3 -I -c '
import json, sys
for k in json.load(sys.stdin):
    if k.get("keyType") == "USER_MANAGED":
        print(k["name"].rsplit("/", 1)[-1])
'
}

# ---------------------------------------------------------------- prerequisites
decom_section "Prerequisites"
decom_require_tools gcloud python3 curl
decom_show_gcloud_account

if [ "$AUTH_USERS_ONLY" -eq 1 ]; then
  decom_skip "cutover check (not needed: allUsers read access is kept)"
else
  decom_check_online "$DECOM_SITE_URL is served from Sanity and no longer references images-for-cms or the backend" decom_site_cut_over
  decom_check_online "every Wagtail video is on Mux (production has a ready mux.videoAsset for each, and every video block resolves)" decom_mux_videos_complete
fi

POLICY=""
BINDINGS=""
if decom_ro_capture POLICY gcloud storage buckets get-iam-policy "gs://$BUCKET" --format=json; then
  decom_pass "can read the IAM policy of gs://$BUCKET"
  BINDINGS="$(printf '%s' "$POLICY" | public_bindings)"
elif [ "$DECOM_OFFLINE" -eq 0 ]; then
  decom_fail_prereq "cannot read the IAM policy of gs://$BUCKET (log in as the $PROJECT owner)"
fi

BUCKET_STATE=""
if decom_ro_capture BUCKET_STATE gcloud storage buckets describe "gs://$BUCKET" --format='value(public_access_prevention,uniform_bucket_level_access)'; then
  decom_say "  public_access_prevention / uniform_bucket_level_access: $(printf '%s' "$BUCKET_STATE" | tr '\t' ' ')"
  case "$BUCKET_STATE" in
    *True) decom_pass "uniform bucket-level access is on (no per-object ACLs to clean up)" ;;
    *) decom_fail_prereq "uniform bucket-level access is off; object ACLs could still be public. Turn it on first." ;;
  esac
elif [ "$DECOM_OFFLINE" -eq 0 ]; then
  decom_fail_prereq "cannot describe gs://$BUCKET"
fi

# KEYS: lines of "<service account> <key id>"
# KEYS_UNLISTED: service accounts whose keys could not be listed (offline or no permission)
KEYS=""
KEYS_UNLISTED=""
for sa in $SERVICE_ACCOUNTS; do
  KEY_JSON=""
  if decom_ro_capture KEY_JSON gcloud iam service-accounts keys list --iam-account "$sa" --project "$PROJECT" --managed-by=user --format=json; then
    decom_pass "can list keys of $sa"
    ids="$(printf '%s' "$KEY_JSON" | user_managed_key_ids)"
    for id in $ids; do
      KEYS="$KEYS$sa $id
"
    done
  else
    KEYS_UNLISTED="$KEYS_UNLISTED $sa"
    if [ "$DECOM_OFFLINE" -eq 0 ]; then
      decom_fail_prereq "cannot list keys of $sa (needs iam.serviceAccountKeys.list; log in as the $PROJECT owner)"
    fi
  fi
done

decom_prereq_gate

# ---------------------------------------------------------------- plan and apply
decom_section "1. Remove public IAM bindings from gs://$BUCKET"
if [ "$DECOM_OFFLINE" -eq 1 ]; then
  for member in $PUBLIC_MEMBERS; do
    decom_run gcloud storage buckets remove-iam-policy-binding "gs://$BUCKET" --member="$member" --role="<each role bound to $member>" --all
  done
elif [ -z "$BINDINGS" ]; then
  decom_say "  no bindings for: $PUBLIC_MEMBERS"
else
  while read -r role member; do
    [ -n "$role" ] || continue
    decom_run gcloud storage buckets remove-iam-policy-binding "gs://$BUCKET" --member="$member" --role="$role" --all
  done <<EOF
$BINDINGS
EOF
fi

if [ "$AUTH_USERS_ONLY" -eq 0 ]; then
  decom_section "2. Enforce public access prevention on gs://$BUCKET"
  case "$BUCKET_STATE" in
    enforced*) decom_say "  already enforced" ;;
    *) decom_run gcloud storage buckets update "gs://$BUCKET" --public-access-prevention ;;
  esac

  decom_section "3. Delete user-managed service-account keys"
  # Only reached with --execute when every listing succeeded (the gate stops it otherwise).
  for sa in $KEYS_UNLISTED; do
    if [ "$DECOM_OFFLINE" -eq 1 ]; then why="offline"; else why="no permission"; fi
    decom_say "  keys of $sa were not listed ($why); each USER_MANAGED key would be deleted with:"
    decom_run gcloud iam service-accounts keys delete "<USER_MANAGED key id>" --iam-account "$sa" --project "$PROJECT" --quiet
  done
  if [ -n "$KEYS" ]; then
    while read -r sa id; do
      [ -n "$sa" ] || continue
      decom_run gcloud iam service-accounts keys delete "$id" --iam-account "$sa" --project "$PROJECT" --quiet
    done <<EOF
$KEYS
EOF
  fi
  for sa in $SERVICE_ACCOUNTS; do
    case " $KEYS_UNLISTED " in
      *" $sa "*) ;;
      *) printf '%s' "$KEYS" | grep -q "^$sa " || decom_say "  $sa has no user-managed keys" ;;
    esac
  done
  if [ "$INCLUDE_LEGACY" -eq 0 ]; then
    decom_say "  ($SA_LEGACY is not included; pass --include-legacy-sa to revoke its keys too)"
  fi
fi

# ---------------------------------------------------------------- verify
decom_section "Verify"
if [ "$DECOM_EXECUTE" -eq 0 ]; then
  decom_say "DRY-RUN would check: the bucket IAM policy has no bindings for $PUBLIC_MEMBERS"
  if [ "$AUTH_USERS_ONLY" -eq 0 ]; then
    decom_say "DRY-RUN would check: public_access_prevention is 'enforced'"
    decom_say "DRY-RUN would check: an anonymous GET of an original_images/ object returns 401 or 403"
    decom_say "DRY-RUN would check: keys list --managed-by=user is empty for: $SERVICE_ACCOUNTS"
  fi
  decom_finish
fi

AFTER=""
decom_ro_capture AFTER gcloud storage buckets get-iam-policy "gs://$BUCKET" --format=json || decom_die "cannot re-read the IAM policy"
if [ -n "$(printf '%s' "$AFTER" | public_bindings)" ]; then
  decom_die "public bindings remain: $(printf '%s' "$AFTER" | public_bindings | tr '\n' ';')"
fi
decom_pass "no IAM bindings for $PUBLIC_MEMBERS"

if [ "$AUTH_USERS_ONLY" -eq 0 ]; then
  STATE=""
  decom_ro_capture STATE gcloud storage buckets describe "gs://$BUCKET" --format='value(public_access_prevention)' || decom_die "cannot describe the bucket"
  [ "$STATE" = "enforced" ] || decom_die "public access prevention is '$STATE'"
  decom_pass "public access prevention is enforced"

  SAMPLE="$(grep -o -m 1 "gs://$BUCKET/original_images/[^[:space:]]*[^/:]\$" "$GCS_LIST" || true)"
  if [ -n "$SAMPLE" ]; then
    URL="https://storage.googleapis.com/${SAMPLE#gs://}"
    CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$URL")"
    case "$CODE" in
      401 | 403) decom_pass "anonymous GET $URL returns $CODE" ;;
      *) decom_die "anonymous GET $URL returns $CODE, expected 401 or 403" ;;
    esac
  else
    decom_die "no original_images/ object found in $GCS_LIST to test anonymous access with"
  fi

  for sa in $SERVICE_ACCOUNTS; do
    LEFT=""
    decom_ro_capture LEFT gcloud iam service-accounts keys list --iam-account "$sa" --project "$PROJECT" --managed-by=user --format=json ||
      decom_die "cannot list keys of $sa"
    LEFT="$(printf '%s' "$LEFT" | user_managed_key_ids | tr '\n' ' ')"
    [ -z "$LEFT" ] || decom_die "user-managed keys remain on $sa: $LEFT"
    decom_pass "$sa has no user-managed keys"
  done
fi
decom_finish
