#!/usr/bin/env bash
# Exercise the --execute paths of scripts/decommission/01-04 against fake gcloud, gh, ssh and
# curl (fakecli.py), in the morning order, including the failure and re-run cases.
#
# Real tools are used for everything else: git, gitleaks, openssl, unzip, python3,
# pg_restore (local PostgreSQL 15) and Docker (postgres:16.1, for a dump that the local
# pg_restore cannot read). Nothing outside a temporary directory is changed. The scrubbed
# backend clone is only read (pushed from by URL).
#
# Usage: scripts/decommission/test/run.sh [SCRUBBED_CLONE]
#   SCRUBBED_CLONE defaults to $HOME/cjoshmartin-migration/backend-archive/cjoshmartin-backend
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(dirname "$TEST_DIR")"
ARCHIVE_CLONE="${1:-$HOME/cjoshmartin-migration/backend-archive/cjoshmartin-backend}"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}"
PG16_IMAGE="postgres:16.1"

T="$(mktemp -d /tmp/decomtest.XXXXXX)"
PG16_CONTAINER="decom-test-pg16-$$"
cleanup() {
  if [ -f "$T/pg15/postmaster.pid" ]; then
    "$PGBIN/pg_ctl" -D "$T/pg15" -m immediate stop >/dev/null 2>&1 || echo "warning: could not stop the test PostgreSQL" >&2
  fi
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$PG16_CONTAINER"; then
    docker rm -f "$PG16_CONTAINER" >/dev/null 2>&1 || echo "warning: could not remove container $PG16_CONTAINER" >&2
  fi
  rm -rf "$T"
}
trap cleanup EXIT

export FAKE_ROOT="$T/fake"
export FAKE_READ_STDIN=1
export MIGRATION_DIR="$T/mig"
mkdir -p "$FAKE_ROOT" "$T/bin" "$T/logs" "$MIGRATION_DIR/final"
for tool in gcloud gh ssh curl; do
  printf '#!/bin/sh\nexec python3 -I %s %s "$@"\n' "$TEST_DIR/fakecli.py" "$tool" >"$T/bin/$tool"
  chmod +x "$T/bin/$tool"
done
export PATH="$T/bin:$PATH"

PASSED=0
FAILED=0
N=0
ok() {
  PASSED=$((PASSED + 1))
  printf 'ok   %s\n' "$1"
}
not_ok() {
  FAILED=$((FAILED + 1))
  printf 'FAIL %s\n' "$1"
  if [ -n "${2:-}" ] && [ -f "$2" ]; then
    sed 's/^/     | /' "$2" | tail -n 40
  fi
}
# run NAME EXPECTED_EXIT CMD...: run a command, keep its output in $LAST_LOG, check the exit status.
LAST_LOG=""
run() {
  local name="$1" want="$2" rc=0
  shift 2
  N=$((N + 1))
  LAST_LOG="$T/logs/$N.log"
  "$@" >"$LAST_LOG" 2>&1 </dev/null || rc=$?
  if [ "$rc" = "$want" ]; then ok "$name (exit $rc)"; else not_ok "$name: exit $rc, expected $want" "$LAST_LOG"; fi
}
# run_typed NAME EXPECTED_EXIT ANSWER CMD...: run CMD on a pseudo-terminal (script(1)) and type
# ANSWER once it prompts, the way a person would. Input sent before the prompt is lost on a
# fresh pty, so the answer waits for the prompt text in the transcript.
run_typed() {
  local name="$1" want="$2" answer="$3" rc=0
  shift 3
  N=$((N + 1))
  LAST_LOG="$T/logs/$N.log"
  : >"$LAST_LOG"
  {
    for _ in $(seq 1 900); do
      grep -q 'Type the app name' "$LAST_LOG" && break
      sleep 0.2
    done
    printf '%s\n' "$answer"
    sleep 1
  } | script -q -t 0 "$LAST_LOG" "$@" >/dev/null 2>&1 || rc=$?
  if [ "$rc" = "$want" ]; then ok "$name (exit $rc)"; else not_ok "$name: exit $rc, expected $want" "$LAST_LOG"; fi
}
# check NAME CMD...: an assertion on state.
check() {
  local name="$1"
  shift
  if "$@"; then ok "$name"; else not_ok "$name" "$LAST_LOG"; fi
}
log_has() { grep -q -- "$1" "$LAST_LOG"; }
calls_mark() {
  touch "$FAKE_ROOT/calls.log"
  CALLS_AT="$(wc -l <"$FAKE_ROOT/calls.log" | tr -d ' ')"
}
calls_since() { tail -n "+$((CALLS_AT + 1))" "$FAKE_ROOT/calls.log" 2>/dev/null || true; }
no_key_deletes() { ! calls_since | grep -q 'keys delete'; }
no_mutating_calls() {
  ! calls_since | grep -E -q 'storage cp|remove-iam-policy-binding|buckets update|keys delete|repo create|repo archive|apps:destroy|postgres:destroy'
}

# ---------------------------------------------------------------- fixtures: real pg_dump files
echo "# building fixtures"
cat >"$T/fixture.sql" <<'SQL'
CREATE TABLE wagtailcore_page (id serial PRIMARY KEY, title text);
CREATE TABLE wagtailcore_revision (id serial PRIMARY KEY, content jsonb);
CREATE TABLE wagtailimages_image (id serial PRIMARY KEY, file text);
CREATE TABLE wagtailmedia_media (id serial PRIMARY KEY, file text);
CREATE TABLE wagtaildocs_document (id serial PRIMARY KEY, file text);
CREATE TABLE blog_blogpage (page_ptr_id int PRIMARY KEY);
CREATE TABLE blog_projectpage (page_ptr_id int PRIMARY KEY);
CREATE TABLE home_homepage (page_ptr_id int PRIMARY KEY);
CREATE TABLE home_testimonial (id serial PRIMARY KEY, name text);
CREATE TABLE home_service (id serial PRIMARY KEY, title text);
CREATE TABLE home_author (id serial PRIMARY KEY, first_name text);
CREATE TABLE flex_flexpage (page_ptr_id int PRIMARY KEY);
INSERT INTO wagtailcore_page (title) VALUES ('Home');
INSERT INTO home_author (first_name) VALUES ('Test');
SQL

mkdir -p "$T/sock"
"$PGBIN/initdb" -D "$T/pg15" -U postgres -A trust >/dev/null
"$PGBIN/pg_ctl" -D "$T/pg15" -o "-k $T/sock -p 54329 -c listen_addresses=''" -l "$T/pg15.log" -w start >/dev/null
"$PGBIN/psql" -q -h "$T/sock" -p 54329 -U postgres -c 'CREATE DATABASE wagtail' >/dev/null
"$PGBIN/psql" -q -h "$T/sock" -p 54329 -U postgres -d wagtail -f "$T/fixture.sql" >/dev/null
"$PGBIN/pg_dump" -Fc -h "$T/sock" -p 54329 -U postgres wagtail >"$T/dump15.dump"
"$PGBIN/psql" -q -h "$T/sock" -p 54329 -U postgres -d wagtail -c 'DROP TABLE flex_flexpage' >/dev/null
"$PGBIN/pg_dump" -Fc -h "$T/sock" -p 54329 -U postgres wagtail >"$T/dump15-missing-table.dump"
"$PGBIN/pg_ctl" -D "$T/pg15" -w stop >/dev/null
echo "built PostgreSQL 15 dumps"

HAVE_PG16=0
if docker info >/dev/null 2>&1 && docker image inspect "$PG16_IMAGE" >/dev/null 2>&1; then
  docker run -d --name "$PG16_CONTAINER" -e POSTGRES_PASSWORD=test "$PG16_IMAGE" >/dev/null
  # The image runs a temporary server while initialising and then restarts; wait for the
  # final server, not the temporary one.
  ready=0
  for _ in $(seq 1 90); do
    if docker logs "$PG16_CONTAINER" 2>&1 | grep -q 'PostgreSQL init process complete' &&
      docker exec "$PG16_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  [ "$ready" -eq 1 ] || {
    echo "the $PG16_IMAGE test container did not become ready" >&2
    exit 1
  }
  docker exec "$PG16_CONTAINER" psql -q -U postgres -c 'CREATE DATABASE wagtail' >/dev/null
  docker exec -i "$PG16_CONTAINER" psql -q -U postgres -d wagtail >/dev/null <"$T/fixture.sql"
  docker exec "$PG16_CONTAINER" pg_dump -Fc -U postgres wagtail >"$T/dump16.dump"
  docker rm -f "$PG16_CONTAINER" >/dev/null
  HAVE_PG16=1
  echo "built PostgreSQL 16 dump (Docker $PG16_IMAGE)"
else
  echo "Docker or $PG16_IMAGE unavailable: the PostgreSQL 16 tests use the 15 dump instead"
  cp "$T/dump15.dump" "$T/dump16.dump"
fi

# ---------------------------------------------------------------- fixtures: fake world
python3 -I - "$MIGRATION_DIR" <<'PY'
import hashlib, json, sys, zipfile
mig = sys.argv[1]
dumpdata = json.dumps([{"model": "wagtailcore.page", "pk": 1, "fields": {"title": "Home"}}]).encode()
manifest = {"files": {"dumpdata.json": {"bytes": len(dumpdata), "sha256": hashlib.sha256(dumpdata).hexdigest()}}}
with zipfile.ZipFile(mig + "/wagtail-export.zip", "w") as z:
    z.writestr("export.json", "{}")
    z.writestr("dumpdata.json", dumpdata)
    z.writestr("manifest.json", json.dumps(manifest))
with open(mig + "/final/gcs-file-list.txt", "w") as f:
    f.write("gs://images-for-cms/original_images/:\n")
    f.write("    310053  2025-01-05T18:22:25Z  gs://images-for-cms/original_images/photo.jpeg\n")
    f.write("TOTAL: 1 objects, 310053 bytes (302.79 KiB)\n")
PY

mkdir -p "$FAKE_ROOT/gcs/cjoshmartin-sanity-backups/objects" "$FAKE_ROOT/gcs/images-for-cms/objects" "$FAKE_ROOT/iam" "$FAKE_ROOT/gh" "$FAKE_ROOT/site" \
  "$FAKE_ROOT/dokku/apps" "$FAKE_ROOT/dokku/services/cjoshmartin-db" "$FAKE_ROOT/dokku/services/other-db"
echo '{"pap": "enforced", "ubla": true}' >"$FAKE_ROOT/gcs/cjoshmartin-sanity-backups/meta.json"
echo '{"bindings": []}' >"$FAKE_ROOT/gcs/cjoshmartin-sanity-backups/iam.json"
echo '{"pap": "inherited", "ubla": true}' >"$FAKE_ROOT/gcs/images-for-cms/meta.json"
cat >"$FAKE_ROOT/gcs/images-for-cms/iam.json" <<'JSON'
{"bindings": [
 {"role": "roles/storage.admin", "members": ["allAuthenticatedUsers", "projectEditor:com-cjoshmartin", "projectOwner:com-cjoshmartin"]},
 {"role": "roles/storage.legacyBucketOwner", "members": ["projectEditor:com-cjoshmartin", "projectOwner:com-cjoshmartin"]},
 {"role": "roles/storage.objectUser", "members": ["allAuthenticatedUsers"]},
 {"role": "roles/storage.objectViewer", "members": ["allUsers"]}
]}
JSON
SA_MAIN="file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com"
SA_LEGACY="fileuploads@com-cjoshmartin.iam.gserviceaccount.com"
cat >"$FAKE_ROOT/iam/$SA_MAIN.json" <<JSON
[{"name": "projects/com-cjoshmartin/serviceAccounts/$SA_MAIN/keys/user1", "keyType": "USER_MANAGED"},
 {"name": "projects/com-cjoshmartin/serviceAccounts/$SA_MAIN/keys/user2", "keyType": "USER_MANAGED"},
 {"name": "projects/com-cjoshmartin/serviceAccounts/$SA_MAIN/keys/system1", "keyType": "SYSTEM_MANAGED"}]
JSON
cat >"$FAKE_ROOT/iam/$SA_LEGACY.json" <<JSON
[{"name": "projects/com-cjoshmartin/serviceAccounts/$SA_LEGACY/keys/legacyuser", "keyType": "USER_MANAGED"},
 {"name": "projects/com-cjoshmartin/serviceAccounts/$SA_LEGACY/keys/legacysystem", "keyType": "SYSTEM_MANAGED"}]
JSON
site() { # old|new
  local p body
  for p in index blog projects; do
    if [ "$1" = old ]; then
      body="<img src=\"https://storage.googleapis.com/images-for-cms/original_images/photo.jpeg\">"
    else
      body="<img src=\"/_next/image?url=https%3A%2F%2Fcdn.sanity.io%2Fimages%2Fj3vdh6ti%2Fproduction%2Fabc.jpg\">"
    fi
    printf '<html><body>%s</body></html>\n' "$body" >"$FAKE_ROOT/site/$p.html"
  done
}
site old
# videos BLOCKS NOT_READY ORIGINALS: what the production dataset reports about its video blocks
# (contract v2) and which Wagtail originals (source ids, comma-separated) it holds.
mkdir -p "$FAKE_ROOT/sanity" "$MIGRATION_DIR/extracted"
printf '{"format_version": 1, "media": [{"id": 1}, {"id": 2}, {"id": 3}]}\n' >"$MIGRATION_DIR/extracted/export.json"
videos() {
  local originals
  originals="$(printf '%s' "$3" | python3 -I -c 'import json, sys; print(json.dumps([x for x in sys.stdin.read().split(",") if x]))')"
  printf '{"result": {"blocks": %s, "notReady": %s, "originals": %s}}\n' "$1" "$2" "$originals" >"$FAKE_ROOT/sanity/production.json"
}
videos 3 1 media-1,media-2
touch "$FAKE_ROOT/dokku/apps/cjoshmartin-django" "$FAKE_ROOT/dokku/apps/other-app"
echo "postgres:16.1" >"$FAKE_ROOT/dokku/services/cjoshmartin-db/image"
echo "cjoshmartin-django" >"$FAKE_ROOT/dokku/services/cjoshmartin-db/links"
cp "$T/dump16.dump" "$FAKE_ROOT/dokku/services/cjoshmartin-db/export.dump"
echo "postgres:16.1" >"$FAKE_ROOT/dokku/services/other-db/image"
echo "other-app" >"$FAKE_ROOT/dokku/services/other-db/links"
DUMP="$MIGRATION_DIR/final/wagtail-final.dump"

# ---------------------------------------------------------------- 03 export
echo "# 03 export"
calls_mark
run "03 export dry-run" 0 "$SCRIPTS/03-dokku-teardown.sh" export
check "03 export dry-run discovered the linked service" log_has "exactly one Postgres service is linked to cjoshmartin-django: cjoshmartin-db"
check "03 export dry-run wrote no dump" test ! -e "$DUMP"

cp "$T/dump15-missing-table.dump" "$FAKE_ROOT/dokku/services/cjoshmartin-db/export.dump"
run "03 export --execute rejects a dump without flex_flexpage" 1 "$SCRIPTS/03-dokku-teardown.sh" --execute export
check "03 rejected dump names the missing table" log_has "no TABLE DATA for: flex_flexpage"
check "03 rejected dump is not saved as the final dump" test ! -e "$DUMP"
check "03 rejected dump is kept as .partial for inspection" test -s "$DUMP.partial"
rm -f "$DUMP.partial"

cp "$T/dump16.dump" "$FAKE_ROOT/dokku/services/cjoshmartin-db/export.dump"
run "03 export --execute" 0 "$SCRIPTS/03-dokku-teardown.sh" --execute export
check "03 export saved the dump" cmp -s "$DUMP" "$T/dump16.dump"
check "03 export wrote the sha256 file" grep -q "wagtail-final.dump" "$DUMP.sha256"
check "03 export dump is private (mode 600)" test "$(stat -f '%Lp' "$DUMP")" = 600
if [ "$HAVE_PG16" -eq 1 ]; then
  check "03 used Docker postgres:16.1 because local pg_restore 15 cannot read a 16 dump" log_has "docker run --rm -v .* postgres:16.1 pg_restore --list"
fi
check "03 export listed the version header" log_has "Dumped from database version"
run "03 export --execute again (idempotent)" 0 "$SCRIPTS/03-dokku-teardown.sh" --execute export
check "03 second export did not export again" log_has "existing dump is valid; not exporting again"

# ---------------------------------------------------------------- 01 archive
echo "# 01 archive"
calls_mark
run "01 dry-run" 0 "$SCRIPTS/01-archive-to-backup-bucket.sh" --date 2026-11-26 "$DUMP"
check "01 dry-run made no changes" no_mutating_calls
check "01 dry-run did not extract dumpdata.json" test ! -e "$MIGRATION_DIR/final/dumpdata.json"

echo '{"pap": "inherited", "ubla": true}' >"$FAKE_ROOT/gcs/cjoshmartin-sanity-backups/meta.json"
calls_mark
run "01 --execute refuses a bucket without public access prevention" 1 "$SCRIPTS/01-archive-to-backup-bucket.sh" --execute --date 2026-11-26 "$DUMP"
check "01 refused before any upload" no_mutating_calls
echo '{"pap": "enforced", "ubla": true}' >"$FAKE_ROOT/gcs/cjoshmartin-sanity-backups/meta.json"

calls_mark
run "01 --execute" 0 "$SCRIPTS/01-archive-to-backup-bucket.sh" --execute --date 2026-11-26 "$DUMP"
OBJ="$FAKE_ROOT/gcs/cjoshmartin-sanity-backups/objects/archive/2026-11-26"
check "01 extracted dumpdata.json and matched the manifest" log_has "extracted and matched manifest.json sha256"
check "01 uploaded the export zip" cmp -s "$OBJ/wagtail-export.zip" "$MIGRATION_DIR/wagtail-export.zip"
check "01 uploaded dumpdata.json" cmp -s "$OBJ/dumpdata.json" "$MIGRATION_DIR/final/dumpdata.json"
check "01 uploaded the final dump" cmp -s "$OBJ/wagtail-final.dump" "$DUMP"
check "01 uploaded the GCS file list" cmp -s "$OBJ/gcs-file-list.txt" "$MIGRATION_DIR/final/gcs-file-list.txt"
check "01 uploaded SHA256SUMS listing 4 objects" test "$(wc -l <"$OBJ/SHA256SUMS" | tr -d ' ')" = 4
check "01 verified every object" test "$(grep -c '^  verified gs://' "$LAST_LOG")" = 5
check "01 used create-only uploads" sh -c "! grep 'storage cp' '$FAKE_ROOT/calls.log' | grep -v -q -- '--if-generation-match=0'"

calls_mark
run "01 --execute again (idempotent)" 0 "$SCRIPTS/01-archive-to-backup-bucket.sh" --execute --date 2026-11-26 "$DUMP"
check "01 second run uploaded nothing" no_mutating_calls
calls_mark
run "01 --execute on a later date" 0 "$SCRIPTS/01-archive-to-backup-bucket.sh" --execute --date 2026-11-27 "$DUMP"
check "01 later date reuses the earlier archive (no uploads)" no_mutating_calls

cp "$DUMP" "$T/dump-saved"
cp "$T/dump15.dump" "$DUMP"
calls_mark
run "01 --execute refuses to replace a different file on the same date" 1 "$SCRIPTS/01-archive-to-backup-bucket.sh" --execute --date 2026-11-26 "$DUMP"
check "01 conflict uploaded nothing" no_mutating_calls
check "01 conflict is explained" log_has "already exists with different content"
cp "$T/dump-saved" "$DUMP"

# ---------------------------------------------------------------- 02 push
echo "# 02 push"
REMOTE="$FAKE_ROOT/gh/cjoshmartin-com__cjoshmartin-backend-archive.git"
if [ -d "$ARCHIVE_CLONE/.git" ]; then
  ARCHIVE_REMOTES_BEFORE="$(git -C "$ARCHIVE_CLONE" remote | wc -l | tr -d ' ')"
  run "02 dry-run" 0 "$SCRIPTS/02-push-backend-archive.sh" --archive-dir "$ARCHIVE_CLONE" --remote-url "$REMOTE"
  check "02 dry-run created nothing" test ! -e "$REMOTE"
  calls_mark
  run "02 --execute" 0 "$SCRIPTS/02-push-backend-archive.sh" --execute --archive-dir "$ARCHIVE_CLONE" --remote-url "$REMOTE"
  check "02 remote main equals the scrubbed clone" test "$(git -C "$REMOTE" rev-parse main)" = "$(git -C "$ARCHIVE_CLONE" rev-parse main)"
  check "02 remote has no secrets.json history" test -z "$(git -C "$REMOTE" log --all --oneline -- secrets.json)"
  check "02 repo is private and archived" grep -q '"isArchived": true' "$FAKE_ROOT/gh/cjoshmartin-com__cjoshmartin-backend-archive.json"
  check "02 verified the mirror clone with gitleaks" log_has "fresh mirror clone: gitleaks finds nothing"
  check "02 left the scrubbed clone without remotes" test "$(git -C "$ARCHIVE_CLONE" remote | wc -l | tr -d ' ')" = "$ARCHIVE_REMOTES_BEFORE"
  calls_mark
  run "02 --execute again (archived, refs match)" 0 "$SCRIPTS/02-push-backend-archive.sh" --execute --archive-dir "$ARCHIVE_CLONE" --remote-url "$REMOTE"
  check "02 second run created and archived nothing" no_mutating_calls
else
  not_ok "02 tests need the scrubbed clone at $ARCHIVE_CLONE"
fi

LEAKY="$T/leaky"
git init -q -b main "$LEAKY"
printf '{"type": "service_account"}\n' >"$LEAKY/secrets.json"
git -C "$LEAKY" add secrets.json
git -C "$LEAKY" -c user.name=t -c user.email=t@example.test commit -q -m "add key"
git -C "$LEAKY" rm -q secrets.json
git -C "$LEAKY" -c user.name=t -c user.email=t@example.test commit -q -m "remove key"
calls_mark
run "02 --execute refuses a repo with secrets.json in history" 1 "$SCRIPTS/02-push-backend-archive.sh" --execute --archive-dir "$LEAKY" --repo cjoshmartin-com/leaky --remote-url "$T/leaky-remote.git"
check "02 refused before creating anything" no_mutating_calls

# ---------------------------------------------------------------- 03 destroy
echo "# 03 destroy"
calls_mark
run "03 destroy --execute refuses while the site still uses the backend" 1 "$SCRIPTS/03-dokku-teardown.sh" --execute destroy
check "03 refusal names the site check" log_has "still references images-for-cms"
check "03 refused before destroying" no_mutating_calls
site new

echo "other-app" >>"$FAKE_ROOT/dokku/services/cjoshmartin-db/links"
calls_mark
run "03 destroy --execute refuses a service shared with another app" 1 "$SCRIPTS/03-dokku-teardown.sh" --execute destroy
check "03 shared-service refusal destroyed nothing" no_mutating_calls
echo "cjoshmartin-django" >"$FAKE_ROOT/dokku/services/cjoshmartin-db/links"

# Only when this runner has no terminal; with one, the script would wait for typed input.
if ! { : </dev/tty; } 2>/dev/null; then
  calls_mark
  run "03 destroy --execute without a terminal refuses" 1 "$SCRIPTS/03-dokku-teardown.sh" --execute destroy
  check "03 no-terminal refusal destroyed nothing" no_mutating_calls
fi

calls_mark
run_typed "03 destroy --execute with a wrong typed confirmation" 1 cjoshmartin "$SCRIPTS/03-dokku-teardown.sh" --execute destroy
check "03 wrong typed confirmation aborts" log_has "does not match 'cjoshmartin-django'"
check "03 wrong confirmation destroyed nothing" no_mutating_calls

run_typed "03 destroy --execute with the app name typed" 0 cjoshmartin-django "$SCRIPTS/03-dokku-teardown.sh" --execute destroy
check "03 destroy reports success" log_has "DONE. All steps completed and verified."
check "03 app is gone" test ! -e "$FAKE_ROOT/dokku/apps/cjoshmartin-django"
check "03 service is gone" test ! -e "$FAKE_ROOT/dokku/services/cjoshmartin-db"
check "03 other app untouched" test -e "$FAKE_ROOT/dokku/apps/other-app"
check "03 other service untouched" test -d "$FAKE_ROOT/dokku/services/other-db"
calls_mark
run "03 destroy --execute again (already gone)" 0 "$SCRIPTS/03-dokku-teardown.sh" --execute --service cjoshmartin-db destroy
check "03 second run destroyed nothing" no_mutating_calls

# ---------------------------------------------------------------- 04 lockdown
echo "# 04 lockdown"
site old
calls_mark
run "04 --execute refuses before cutover" 1 "$SCRIPTS/04-gcs-lockdown.sh" --execute
check "04 refused before changing anything" no_mutating_calls

calls_mark
run "04 --authenticated-users-only --execute (allowed before cutover)" 0 "$SCRIPTS/04-gcs-lockdown.sh" --execute --authenticated-users-only
check "04 removed allAuthenticatedUsers" sh -c "! grep -q allAuthenticatedUsers '$FAKE_ROOT/gcs/images-for-cms/iam.json'"
check "04 kept allUsers read access" grep -q allUsers "$FAKE_ROOT/gcs/images-for-cms/iam.json"
check "04 left public access prevention alone" grep -q '"inherited"' "$FAKE_ROOT/gcs/images-for-cms/meta.json"
check "04 deleted no keys" no_key_deletes

site new
calls_mark
run "04 --execute refuses while a video is not in Sanity" 1 "$SCRIPTS/04-gcs-lockdown.sh" --execute --include-legacy-sa
check "04 names the unconverted blocks and the missing originals" log_has "1 of 3 published video blocks do not play a converted MP4 with its original kept; 1 of 3 Wagtail video originals are not in production (media-3)"
check "04 refused before changing anything (videos)" no_mutating_calls
videos 3 0 media-1,media-2
calls_mark
run "04 --execute refuses while a Wagtail original is missing" 1 "$SCRIPTS/04-gcs-lockdown.sh" --execute --include-legacy-sa
check "04 names the missing original" log_has "1 of 3 Wagtail video originals are not in production (media-3)"
check "04 refused before changing anything (originals)" no_mutating_calls
videos 3 1 media-1,media-2,media-3
calls_mark
run "04 --execute refuses while a video block is not converted" 1 "$SCRIPTS/04-gcs-lockdown.sh" --execute --include-legacy-sa
check "04 refused before changing anything (video blocks)" no_mutating_calls
rm "$FAKE_ROOT/sanity/production.json"
run "04 --execute refuses when the dataset cannot be queried" 1 "$SCRIPTS/04-gcs-lockdown.sh" --execute --include-legacy-sa
check "04 reports the failed query" log_has "could not query the production dataset"
videos 3 0 media-1,media-2,media-3
export FAKE_IGNORE_MANAGED_BY=1
calls_mark
run "04 --execute --include-legacy-sa" 0 "$SCRIPTS/04-gcs-lockdown.sh" --execute --include-legacy-sa
check "04 checked the videos first" log_has "ok 3 published video blocks play converted MP4s; the 3 Wagtail originals are in production"
unset FAKE_IGNORE_MANAGED_BY
check "04 no public bindings left" sh -c "! grep -q -E 'allUsers|allAuthenticatedUsers' '$FAKE_ROOT/gcs/images-for-cms/iam.json'"
check "04 kept project bindings" grep -q projectOwner "$FAKE_ROOT/gcs/images-for-cms/iam.json"
check "04 enforced public access prevention" grep -q '"enforced"' "$FAKE_ROOT/gcs/images-for-cms/meta.json"
check "04 deleted the user-managed keys" sh -c "! grep -q -E 'user1|user2|legacyuser' '$FAKE_ROOT/iam/$SA_MAIN.json' '$FAKE_ROOT/iam/$SA_LEGACY.json'"
check "04 kept the system-managed keys" sh -c "grep -q system1 '$FAKE_ROOT/iam/$SA_MAIN.json' && grep -q legacysystem '$FAKE_ROOT/iam/$SA_LEGACY.json'"
check "04 never deleted a system-managed key" sh -c "! grep -q VIOLATION '$FAKE_ROOT/calls.log'"
check "04 saw anonymous access denied" log_has "returns 403"
check "04 left every bucket object in place" test "$(find "$FAKE_ROOT/gcs/images-for-cms/objects" -type f | wc -l | tr -d ' ')" = 0
calls_mark
run "04 --execute again (nothing left to do)" 0 "$SCRIPTS/04-gcs-lockdown.sh" --execute --include-legacy-sa
check "04 second run changed nothing" no_mutating_calls

# ---------------------------------------------------------------- shellcheck
echo "# lint"
if command -v shellcheck >/dev/null 2>&1; then
  run "shellcheck" 0 shellcheck -x "$SCRIPTS"/*.sh "$TEST_DIR/run.sh"
fi

echo
echo "passed: $PASSED  failed: $FAILED"
[ "$FAILED" -eq 0 ]
