#!/usr/bin/env bash
# Copy the one-time Wagtail archive into the private backup bucket:
#   gs://cjoshmartin-sanity-backups/archive/<date>/
#     wagtail-export.zip    the "Export for Sanity" zip
#     dumpdata.json         the Django dumpdata from inside that zip (checked against its manifest)
#     <final pg dump>       the final Postgres dump from 03-dokku-teardown.sh export
#     gcs-file-list.txt     `gsutil ls -l -r gs://images-for-cms`
#     SHA256SUMS            sha256 of each file and the object it was archived as
#
# Uploads are create-only (--if-generation-match=0): an existing object is never replaced.
# A file already archived under archive/ with the same name and MD5 (on any date) is not
# uploaded again, so re-running is safe. Every object is checked afterwards: MD5 and size
# must match the local file.
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
Usage: $(basename "$0") [--execute | --offline] [--date YYYY-MM-DD] [--bucket NAME] PG_DUMP_PATH

  PG_DUMP_PATH   the final Postgres dump, normally
                 $DECOM_MIGRATION_DIR/final/wagtail-final.dump
  --date         archive folder date (default: today, UTC)
  --bucket       backup bucket (default: cjoshmartin-sanity-backups)
  --execute      upload and verify (default is a dry-run that changes nothing)
  --offline      dry-run without contacting GCS

Environment: MIGRATION_DIR (default \$HOME/cjoshmartin-migration).
EOF
}

BUCKET="cjoshmartin-sanity-backups"
ARCHIVE_DATE="$(date -u +%Y-%m-%d)"
PG_DUMP=""
while [ $# -gt 0 ]; do
  if decom_parse_common_flag "$1"; then
    shift
    continue
  fi
  case "$1" in
    --date)
      [ $# -ge 2 ] || decom_die "--date needs a value"
      ARCHIVE_DATE="$2"
      shift 2
      ;;
    --bucket)
      [ $# -ge 2 ] || decom_die "--bucket needs a value"
      BUCKET="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      usage
      decom_die "unknown option: $1"
      ;;
    *)
      [ -z "$PG_DUMP" ] || decom_die "only one PG_DUMP_PATH may be given"
      PG_DUMP="$1"
      shift
      ;;
  esac
done
decom_validate_mode
if [ -z "$PG_DUMP" ]; then
  usage
  decom_die "PG_DUMP_PATH is required"
fi
case "$PG_DUMP$DECOM_MIGRATION_DIR" in
  *[[:space:]]*) decom_die "paths with whitespace are not supported (PG_DUMP_PATH and MIGRATION_DIR)" ;;
esac
case "$ARCHIVE_DATE" in
  [0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]) ;;
  *) decom_die "--date must look like YYYY-MM-DD, got '$ARCHIVE_DATE'" ;;
esac

EXPORT_ZIP="$DECOM_MIGRATION_DIR/wagtail-export.zip"
DUMPDATA="$DECOM_MIGRATION_DIR/final/dumpdata.json"
GCS_LIST="$DECOM_MIGRATION_DIR/final/gcs-file-list.txt"
SUMS_LOCAL="$DECOM_MIGRATION_DIR/final/archive-SHA256SUMS"
DEST="gs://$BUCKET/archive/$ARCHIVE_DATE"

decom_banner "01: archive the Wagtail export, dumpdata, final Postgres dump and GCS file list to $DEST/"

# ---------------------------------------------------------------- prerequisites
decom_section "Prerequisites"
decom_require_tools gcloud openssl unzip python3 base64 curl

manifest_sha256() {
  unzip -p "$EXPORT_ZIP" manifest.json | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["files"]["dumpdata.json"]["sha256"])'
}
zip_ok() {
  [ -s "$EXPORT_ZIP" ] && unzip -tq "$EXPORT_ZIP" >/dev/null &&
    unzip -l "$EXPORT_ZIP" | grep -q ' manifest.json$' &&
    unzip -l "$EXPORT_ZIP" | grep -q ' dumpdata.json$' &&
    unzip -l "$EXPORT_ZIP" | grep -q ' export.json$'
}
dumpdata_matches_manifest() {
  [ "$(decom_sha256 "$DUMPDATA")" = "$(manifest_sha256)" ]
}
gcs_list_complete() {
  [ -s "$GCS_LIST" ] && tail -n 1 "$GCS_LIST" | grep -q '^TOTAL: [0-9][0-9]* objects'
}

decom_check "export zip $EXPORT_ZIP exists, tests OK and has export.json, dumpdata.json, manifest.json" zip_ok
DUMPDATA_NEEDS_EXTRACT=0
if [ -e "$DUMPDATA" ]; then
  decom_check "$DUMPDATA matches the sha256 in the zip's manifest.json" dumpdata_matches_manifest
else
  DUMPDATA_NEEDS_EXTRACT=1
  decom_skip "$DUMPDATA does not exist yet; it will be extracted from the zip and checked against manifest.json"
fi
decom_check "$GCS_LIST exists and ends with gsutil's TOTAL line" gcs_list_complete
decom_check "$PG_DUMP is a non-empty pg_dump custom-format file (PGDMP header)" decom_is_pg_custom_dump "$PG_DUMP"

decom_show_gcloud_account
BUCKET_INFO=""
bucket_private() {
  # Uses BUCKET_INFO ("<public_access_prevention><TAB><uniform_bucket_level_access>") from the describe below.
  local pap ubla
  IFS="$(printf '\t')" read -r pap ubla <<EOF
$BUCKET_INFO
EOF
  [ "$pap" = "enforced" ] && [ "$ubla" = "True" ]
}
if decom_ro_capture BUCKET_INFO gcloud storage buckets describe "gs://$BUCKET" \
  --format='value(public_access_prevention,uniform_bucket_level_access)'; then
  decom_check "gs://$BUCKET has public access prevention enforced and uniform bucket-level access" bucket_private
elif [ "$DECOM_OFFLINE" -eq 1 ]; then
  decom_skip "gs://$BUCKET exists and is private (offline)"
else
  decom_fail_prereq "gs://$BUCKET is not readable (run scripts/backup/setup-gcp.sh first, as the com-cjoshmartin owner)"
fi

# Existing archive objects: lines of "<name> <md5_hash> <size>".
EXISTING=""
if [ "$DECOM_OFFLINE" -eq 0 ] && [ -n "$BUCKET_INFO" ]; then
  EXISTING_JSON=""
  if decom_ro_capture EXISTING_JSON gcloud storage objects list "gs://$BUCKET/archive/**" --format=json; then
    EXISTING="$(printf '%s' "$EXISTING_JSON" | python3 -I -c '
import json, sys
for o in json.load(sys.stdin):
    print(o["name"], o.get("md5_hash", "-"), o["size"])
')"
  else
    decom_fail_prereq "could not list gs://$BUCKET/archive/"
  fi
fi

# ---------------------------------------------------------------- plan
decom_section "Plan"
FILES="$EXPORT_ZIP
$DUMPDATA
$PG_DUMP
$GCS_LIST"

# PLAN holds one line per file: <action> <local path> <object url> <md5> <size>
PLAN=""
CONFLICT=0
plan_file() {
  local file="$1" base md5 size target found=""
  base="$(basename "$file")"
  target="$DEST/$base"
  if [ ! -s "$file" ]; then
    if [ "$file" = "$DUMPDATA" ] && [ "$DUMPDATA_NEEDS_EXTRACT" -eq 1 ]; then
      decom_say "  $base: will be extracted first; upload to $target"
      PLAN="$PLAN
upload $file $target <md5-after-extract> <size-after-extract>"
      return 0
    fi
    # The prerequisite for this file has already failed, so --execute stops at the gate.
    decom_say "  $base: local file missing (prerequisite failed); would upload to $target"
    PLAN="$PLAN
upload $file $target <md5-of-missing-file> <size-of-missing-file>"
    return 0
  fi
  md5="$(decom_md5_b64 "$file")"
  size="$(decom_file_size "$file")"
  if [ "$DECOM_OFFLINE" -eq 0 ] && [ -n "$EXISTING" ]; then
    found="$(printf '%s\n' "$EXISTING" | awk -v b="$base" -v m="$md5" -v s="$size" '
      { n = split($1, p, "/"); if (p[n] == b && $2 == m && $3 == s) { print $1; exit } }')"
    if [ -z "$found" ] && printf '%s\n' "$EXISTING" | awk -v t="archive/$ARCHIVE_DATE/$base" '$1 == t { f = 1 } END { exit !f }'; then
      decom_fail_prereq "$target already exists with different content; create-only, will not replace it (use another --date)"
      CONFLICT=1
      return 0
    fi
  fi
  if [ -n "$found" ]; then
    decom_say "  $base: already archived as gs://$BUCKET/$found (same MD5 and size), not uploading again"
    PLAN="$PLAN
keep $file gs://$BUCKET/$found $md5 $size"
  else
    decom_say "  $base: upload to $target (md5 $md5, $size bytes)"
    PLAN="$PLAN
upload $file $target $md5 $size"
  fi
}
while IFS= read -r f; do
  plan_file "$f"
done <<EOF
$FILES
EOF
decom_say "  SHA256SUMS: write $SUMS_LOCAL and upload it to $DEST/SHA256SUMS (create-only)"

decom_prereq_gate

# ---------------------------------------------------------------- apply
decom_section "Apply"
if [ "$DUMPDATA_NEEDS_EXTRACT" -eq 1 ]; then
  decom_say "Extract dumpdata.json from the export zip:"
  if [ "$DECOM_EXECUTE" -eq 1 ]; then
    printf '+ %s > %s\n' "$(decom_quote unzip -p "$EXPORT_ZIP" dumpdata.json)" "$(decom_quote "$DUMPDATA.partial")" >&2
    mkdir -p "$(dirname "$DUMPDATA")"
    unzip -p "$EXPORT_ZIP" dumpdata.json >"$DUMPDATA.partial"
    if [ "$(decom_sha256 "$DUMPDATA.partial")" != "$(manifest_sha256)" ]; then
      rm -f "$DUMPDATA.partial"
      decom_die "extracted dumpdata.json does not match manifest.json"
    fi
    chmod 600 "$DUMPDATA.partial"
    mv "$DUMPDATA.partial" "$DUMPDATA"
    decom_say "  extracted and matched manifest.json sha256"
    # Re-plan this file now that it exists.
    PLAN="$(printf '%s\n' "$PLAN" | awk -v f="$DUMPDATA" '!($1 == "upload" && $2 == f)')"
    plan_file "$DUMPDATA"
    [ "$CONFLICT" -eq 0 ] || decom_die "conflict found after extracting dumpdata.json. Nothing else was uploaded."
  else
    printf 'DRY-RUN would run: %s > %s, then check it against manifest.json\n' \
      "$(decom_quote unzip -p "$EXPORT_ZIP" dumpdata.json)" "$(decom_quote "$DUMPDATA")" >&2
  fi
fi

upload_create_only() {
  local file="$1" target="$2"
  # --if-generation-match=0: the upload only succeeds if the object does not exist yet.
  # Parallel composite uploads are turned off so the object keeps an MD5 to verify against.
  decom_run env CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED=False \
    gcloud storage cp --if-generation-match=0 "$file" "$target"
}

verify_object() {
  local file="$1" target="$2" want_md5 want_size got
  if [ "$DECOM_EXECUTE" -eq 0 ]; then
    printf 'DRY-RUN would verify: %s md5_hash and size equal the local file\n' "$target" >&2
    return 0
  fi
  want_md5="$(decom_md5_b64 "$file")"
  want_size="$(decom_file_size "$file")"
  decom_ro_capture got gcloud storage objects describe "$target" --format='value(md5_hash,size,generation)' ||
    decom_die "could not describe $target"
  local got_md5 got_size got_generation
  IFS="$(printf '\t')" read -r got_md5 got_size got_generation <<EOF
$got
EOF
  if [ "$got_md5" = "$want_md5" ] && [ "$got_size" = "$want_size" ]; then
    decom_say "  verified $target (md5 $got_md5, $got_size bytes, generation $got_generation)"
  else
    decom_die "verification failed for $target: got md5=$got_md5 size=$got_size, want md5=$want_md5 size=$want_size"
  fi
}

SUMS=""
while IFS=' ' read -r action file target md5 _size; do
  [ -n "$action" ] || continue
  if [ "$action" = "upload" ]; then
    decom_say "$(basename "$file") (md5 $md5):"
    upload_create_only "$file" "$target"
  else
    decom_say "$(basename "$file"): already archived"
  fi
  verify_object "$file" "$target"
  if [ "$DECOM_EXECUTE" -eq 1 ]; then
    SUMS="$SUMS$(decom_sha256 "$file")  $target
"
  fi
done <<EOF
$PLAN
EOF

decom_say "SHA256SUMS:"
if [ "$DECOM_EXECUTE" -eq 1 ]; then
  # Sorted by object URL so a re-run produces identical content (and is recognised as archived).
  printf '%s' "$SUMS" | sort -k 2 >"$SUMS_LOCAL"
  decom_say "  wrote $SUMS_LOCAL:"
  sed 's/^/    /' "$SUMS_LOCAL" >&2
  sums_md5="$(decom_md5_b64 "$SUMS_LOCAL")"
  sums_size="$(decom_file_size "$SUMS_LOCAL")"
  sums_found="$(printf '%s\n' "$EXISTING" | awk -v m="$sums_md5" -v s="$sums_size" '
    { n = split($1, p, "/"); if (p[n] == "SHA256SUMS" && $2 == m && $3 == s) { print $1; exit } }')"
  if [ -n "$sums_found" ]; then
    decom_say "  identical SHA256SUMS already archived as gs://$BUCKET/$sums_found"
  else
    upload_create_only "$SUMS_LOCAL" "$DEST/SHA256SUMS"
    verify_object "$SUMS_LOCAL" "$DEST/SHA256SUMS"
  fi
else
  printf 'DRY-RUN would write %s with "<sha256>  <object url>" for each file above, sorted by URL\n' "$SUMS_LOCAL" >&2
  upload_create_only "$SUMS_LOCAL" "$DEST/SHA256SUMS"
  verify_object "$SUMS_LOCAL" "$DEST/SHA256SUMS"
fi

decom_section "Archive listing"
if ! decom_ro gcloud storage ls -l "gs://$BUCKET/archive/**"; then
  if [ "$DECOM_EXECUTE" -eq 1 ]; then
    decom_die "could not list gs://$BUCKET/archive/ after the upload"
  fi
  decom_say "  (listing failed; expected in a dry-run before the bucket exists)"
fi

decom_finish
