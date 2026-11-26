#!/usr/bin/env bash
# Deletes one dataset, creates it again (public, same name) and imports a verified export into it,
# so that its revision history starts at the import. The whole procedure, with the checks before
# and after this script, is in docs/sanity-migration/reports/dataset-recreate.md.
#
#   scripts/recreate-dataset.sh staging    <export.tar.gz>
#   scripts/recreate-dataset.sh production <export.tar.gz> --confirm-production
#
# Run it only after:
#   1. validation passes (npm run migrate -- --dataset <ds> --steps validate);
#   2. npm run recreate -- snapshot / history-baseline / verify-export pass for THIS export;
#   3. the Blueprint Stack has no Functions (a deployed Function would act on the import: the
#      imported asset documents are created without `source` or `privacy` first, and testimonials
#      without their image). This script checks it and refuses otherwise.
# Afterwards: npm run recreate -- restore-assets, a schema deploy for the workspace, validate,
# npm run recreate -- compare and history-check (with the import start time printed below).
#
# Delete, create and import run in one invocation, so the dataset is never left deleted because a
# later command was not run. If the import fails after the create, rerun only the import:
#   (cd studio && npx sanity@latest datasets import <export.tar.gz> --dataset <ds> --replace -p j3vdh6ti)
set -euo pipefail

readonly PROJECT_ID=j3vdh6ti
readonly STACK_ID=ST-jc4gwa3c4t
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
STUDIO_DIR="$(cd "$SCRIPT_DIR/../../../studio" && pwd)"
readonly STUDIO_DIR
readonly WAIT_SECONDS=600

die() {
  printf 'recreate-dataset: %s\n' "$*" >&2
  exit 1
}
say() {
  printf '%s recreate-dataset: %s\n' "$(date -u +%H:%M:%S)" "$*"
}

[[ $# -ge 2 ]] || die "usage: $0 <staging|production> <export.tar.gz> [--confirm-production]"
dataset=$1
export_file=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
case "$dataset" in
  staging) ;;
  production) [[ "${3:-}" == "--confirm-production" ]] || die "production needs --confirm-production" ;;
  *) die "dataset must be staging or production" ;;
esac
[[ -s "$export_file" ]] || die "export $export_file does not exist or is empty"
tar -tzf "$export_file" | grep '/data.ndjson$' >/dev/null || die "$export_file has no data.ndjson"

cd "$STUDIO_DIR"
sanity() { npx --yes sanity@latest "$@"; }

# 1. No Function may run on the import.
functions=$(sanity blueprints info --project-id "$PROJECT_ID" --stack "$STACK_ID" --json |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).stack.resources??[];console.log(r.filter(x=>String(x.type).startsWith("sanity.function")).length)})')
[[ "$functions" == "0" ]] || die "the Stack still has $functions Functions; deploy the blueprint without them first"
say "the Stack has no Functions"

# 2. The dataset exists and is public (it is created again with the same visibility).
sanity datasets list -p "$PROJECT_ID" | grep -x "$dataset" >/dev/null || die "dataset $dataset does not exist"
[[ "$(sanity datasets visibility get "$dataset" -p "$PROJECT_ID" | tail -1)" == "public" ]] || die "dataset $dataset is not public"

# 3. Delete, and wait until the project no longer lists it.
say "deleting $dataset"
sanity datasets delete "$dataset" --force -p "$PROJECT_ID"
deadline=$((SECONDS + WAIT_SECONDS))
while sanity datasets list -p "$PROJECT_ID" | grep -x "$dataset" >/dev/null; do
  ((SECONDS < deadline)) || die "$dataset is still listed ${WAIT_SECONDS}s after the delete; create it with: npx sanity@latest datasets create $dataset --visibility public -p $PROJECT_ID, then import"
  sleep 10
done
say "$dataset deleted"

# 4. Create it again (public). A name can be briefly unavailable after a delete, so retry.
deadline=$((SECONDS + WAIT_SECONDS))
until sanity datasets create "$dataset" --visibility public -p "$PROJECT_ID"; do
  ((SECONDS < deadline)) || die "could not create $dataset within ${WAIT_SECONDS}s; create it by hand, then import $export_file"
  sleep 15
done
[[ "$(sanity datasets visibility get "$dataset" -p "$PROJECT_ID" | tail -1)" == "public" ]] || die "the new $dataset is not public"
say "$dataset created (public)"

# 5. Import. System documents (_.groups, _.retention, _.schemas) are not in an export: the new
# dataset makes its own groups and retention document, and the schema is deployed afterwards.
import_start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
say "import start $import_start"
sanity datasets import "$export_file" --dataset "$dataset" -p "$PROJECT_ID"
say "import done; history-check --import-start $import_start"
