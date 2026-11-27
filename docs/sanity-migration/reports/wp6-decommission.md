# WP6: decommission preparation

Status: **done; nothing irreversible was executed.** No GitHub repo was created, nothing was uploaded to GCS, Dokku was not touched (not even read over SSH), and DNS and IAM were not changed. Everything below was read-only or local.

Owned paths: `scripts/decommission/`, this report, `~/cjoshmartin-migration/backend-archive/`, `~/cjoshmartin-migration/final/`.

## 1. Findings the owner needs to know

| # | Severity | Finding |
|---|---|---|
| F1 | **high** | **`gs://images-for-cms` grants `allAuthenticatedUsers` `roles/storage.admin`** (and `roles/storage.objectUser`), on top of `allUsers` `roles/storage.objectViewer`. Any Google account can change the bucket's IAM policy or delete objects. Tonight's non-owner gcloud account could read the policy for exactly this reason. Plan D11 removes it at teardown. `04-gcs-lockdown.sh --authenticated-users-only --execute` removes only these bindings, keeps public read, and can run before cutover (see the README). Not executed, because bucket permissions are out of scope tonight. |
| F2 | **high** | **The plan's inventory is wrong about GitHub.** The original backend repo's `origin` is `git@github.com:cjoshmartin-com/backend.cjoshmartin.com.git`, a **private** repo created 2025-05-05 (1 collaborator, 0 forks). Its `main` (bb72d58) has `secrets.json` at HEAD, and its history has all 4 commits that touch it. Publishing the scrubbed archive does not fix that copy. Deleting or archiving it is an owner decision outside the approved plan, so the scripts only report it (`05-verify.sh` row `40-old`). |
| F3 | **high** | **Two service accounts leaked keys, not one.** `secrets.json` held a key for `fileuploads@com-cjoshmartin` (f393672, 4955a99) and later one for `file-upload-2024@com-cjoshmartin` (564bb3c). D11 only covers `file-upload-2024@`. `04-gcs-lockdown.sh --include-legacy-sa` also revokes the `fileuploads@` user-managed keys, and `05-verify.sh` reports them as row `39-legacy`. Whether those keys are still active could not be checked: the active gcloud account has no IAM permissions on `com-cjoshmartin`. |
| F4 | medium | **A hardcoded Django `SECRET_KEY` was also compiled into a committed `.pyc`.** `mysite/settings/dev.py` (2 blob versions) and `mysite/settings/__pycache__/dev.cpython-38.pyc`, which is binary and still tracked at HEAD. `--replace-text` skips binary blobs, so the `.pyc` was redacted with a same-length `--blob-callback` (details in §2). Gitleaks' default rules detect neither. |
| F5 | medium | The original repo has **4 local stashes**. Two contain key files: `secrets.json` (`fileuploads@`) and a second JSON key for `file-upload-2024@`. Stashes are not part of any clone, so they are not in the archive. The GCP-side revocation (F3, D11) makes them harmless; dropping them is the owner's call. |
| F6 | info | The active gcloud account on this Mac is not the `com-cjoshmartin` owner, so key listing fails (`iam.serviceAccountKeys.list` denied). `gcloud auth list` also shows a credentialed account for `file-upload-2024@`, a local copy of a key. The README says to `gcloud auth revoke` it after step 6. |
| F7 | info | `gs://cjoshmartin-sanity-backups` does not exist yet. WP5's `setup-gcp.sh` creates it in the morning, so the `01` dry-run reports that prerequisite as FAIL. This is expected. |

Key-ID prefixes and the commit-by-commit list are in `~/cjoshmartin-migration/reports/wp6/leaked-credentials.txt` (mode 600). They are not repeated here because this repo is public.

## 2. Scrubbed archive copy of the backend repo

The partial clone from the interrupted run (45 commits, `origin` remote, `secrets.json` present, never filtered) was deleted and recreated.

```sh
git clone --no-local ~/code/cjoshmartin.com/cjoshmartin-backend ~/cjoshmartin-migration/backend-archive/cjoshmartin-backend
git filter-repo --invert-paths --path secrets.json \
  --replace-text tools/private/replace-text.txt \
  --blob-callback tools/blob_callback.py \
  --prune-empty never --replace-refs delete-no-add
```

- **The original repo was only read.** I never wrote to it: `git log`/`show`/`ls-tree`/`stash show` only, nothing checked out, no remotes changed.
- **How the secrets were found.** First gitleaks (3 findings, all `private-key` in `secrets.json`). Then a masked keyword scan over every blob and commit message (`backend-archive/tools/scan_history.py`), and a listing of every path that ever existed (93; no `.env`, `.pem`, sqlite or dump files). The scan found the dev `SECRET_KEY` and a 12-character local dev DB password, used in `docker-compose.yml` and as the `DATABASE_PASSWORD` default in `mysite/settings/base.py`. Commit messages were clean.
- **How the redaction inputs were built.** `backend-archive/tools/make_redactions.py` extracted the two values straight from git objects, without printing them, into mode-600 files. It refuses to run unless exactly one distinct value of each is found. Text blobs were rewritten by `--replace-text`, to `REDACTED_DJANGO_DEV_SECRET_KEY` and `REDACTED_DEV_DB_PASSWORD`, used consistently so `docker compose` still works. The binary `.pyc` got a same-length replacement (`tools/blob_callback.py`), so the marshal length prefix stays valid. It still unmarshals with Python 3.9, which has the same code-object layout as 3.8. Once verified, the plaintext inputs were deleted. Only sha256 digests remain (`tools/private/values.sha256`).
- **Why `--prune-empty never`.** It keeps all 45 commits with their original dates, authors and messages. "fix broken service keys" is now an empty commit, which is better than silently dropping history.
- **Remotes.** filter-repo removed `origin`. The clone has **no remotes** and was not pushed anywhere.
- **Not included:** the original's 4 stashes and its `dokku/*` and `origin/*` remote-tracking refs. Both remote-tracking refs are ancestors of `main`, so no commits are lost (F5).

Verification (`~/cjoshmartin-migration/backend-archive/scans/verification.txt`):

```
Scrubbed backend archive verification (2026-11-25T19:35:03Z)
archive: ~/cjoshmartin-migration/backend-archive/cjoshmartin-backend
git log --all --oneline -- secrets.json | wc -l: 0
paths named secrets.json reachable from any ref: 0
remotes: 0
refs: refs/heads/main=d68a9ed 
commits on main: archive 45, original 45
commit dates/authors/subjects identical: yes
HEAD files: archive 86, original 87
HEAD file list diff (original -> archive): < secrets.json 
working tree == HEAD: yes; files on disk match ls-files: yes
objects: 360 total, unreachable 0
git fsck --full --strict: clean
gitleaks git (history): exit 0 (no leaks found, 43 commits scanned)
gitleaks dir (working tree): exit 0 (no leaks found)
for comparison, gitleaks git on the ORIGINAL repo: exit 1 (leaks found: 3)
```

Additional checks:

- Every one of the 360 objects in the store (`cat-file --batch-all-objects`, reachable or not) was scanned for the exact redacted values, and for `PRIVATE KEY-----`, `"private_key_id"` and `"type": "service_account"`: 0 hits. The `.git/filter-repo/` metadata is also clean.
- The 3 original `secrets.json` blob ids are absent from the archive.
- At HEAD, only `docker-compose.yml`, `mysite/settings/dev.py` and `mysite/settings/__pycache__/dev.cpython-38.pyc` differ in content from the original. The only text changes are the placeholders.

## 3. Final GCS listing

`gsutil ls -l -r gs://images-for-cms > ~/cjoshmartin-migration/final/gcs-file-list.txt` was re-run tonight. It is read-only and exited 0, and the output is byte-identical to the earlier attempt's file. It ends with `TOTAL: 669 objects, 429763674 bytes (409.85 MiB)` (771 lines). `final/dumpdata.json` was extracted from `wagtail-export.zip`, and its sha256 matches the zip's `manifest.json` (`66c806cb…84b2`, 1286 records, no `auth.user` or sessions). Both files are inputs to `01`.

## 4. Scripts (`scripts/decommission/`)

| File | Purpose |
|---|---|
| `lib.sh` | Shared helpers: dry-run and `--execute` and `--offline`, command printing, prerequisite gate, typed confirmation, MD5/sha256, and the "site is served from Sanity" interlock. Works with bash 3.2. |
| `01-archive-to-backup-bucket.sh PG_DUMP` | Uploads the export zip, `dumpdata.json`, the dump, `gcs-file-list.txt` and `SHA256SUMS` to `gs://cjoshmartin-sanity-backups/archive/<UTC date>/` with `--if-generation-match=0`. It verifies MD5 and size per object, skips files already archived under any date, and refuses unless the bucket has PAP enforced and UBLA on. |
| `02-push-backend-archive.sh` | Re-checks the scrubbed clone, then: `gh repo create --private`; push of branches and tags (never force); `ls-remote` equality; a fresh `--mirror` clone checked for no `secrets.json`, gitleaks clean, and the same HEAD file list; then `gh repo archive`. |
| `03-dokku-teardown.sh export\|destroy` | `export` runs `postgres:list`, `postgres:app-links`, `postgres:info --version` and `postgres:links`, then `postgres:export` to a `.partial` file. It validates the result (PGDMP header, `pg_restore --list`, 12 required Wagtail tables) before keeping it. If the local `pg_restore` is too old, it falls back to the service's own Docker image. `destroy` refuses unless the same dump is in the bucket, the live site is on Sanity, and the service is linked only to this app. It then requires the app name typed at the terminal, runs `apps:destroy --force` then `postgres:destroy --force`, and verifies both are gone. |
| `04-gcs-lockdown.sh` | Removes every `allUsers`/`allAuthenticatedUsers` binding, enforces PAP, and deletes `USER_MANAGED` keys only (checked through `--managed-by=user` and against `keyType`). It never deletes objects and refuses before cutover. Options: `--include-legacy-sa` (F3), `--authenticated-users-only` (F1). |
| `05-verify.sh [--ssh]` | Runs §12.I tests 37–41, plus Dokku-no-longer-serving (37b), D11 bucket settings, D10 (with `--ssh`) and the site check. Prints PASS, FAIL, NOT CHECKED or WARN for each. It is read-only. |
| `README.md` | The morning order, who runs what, click-by-click GoDaddy steps, expected output, owner decisions, rollback. |
| `test/run.sh`, `test/fakecli.py` | Tests of the `--execute` paths (below). |

Every script uses `set -euo pipefail` and `shellcheck -x` (0.11.0) is clean. Two justified file-level directives: `SC2329` for check functions that `decom_check` calls indirectly, and `SC2034` in `lib.sh` for globals read by the sourcing scripts. Docs checked before relying on CLI behaviour:

- git-filter-repo and gitleaks (Context7)
- the dokku-postgres README (`postgres:export` is pg_dump custom format to stdout; `-f|--force` on destroy; `app-links`; `info --version`)
- Dokku docs: `apps:destroy` unlinks services, and over SSH the args go after `--`
- the installed gcloud (584.0.0) and gh (2.105.0) help, plus real describe and list output from `images-for-cms`

### Execute-path tests

`scripts/decommission/test/run.sh` runs `01`–`04` with `--execute` against fake `gcloud`, `gh`, `ssh` and `curl`. Everything else is real: git, gitleaks, openssl, unzip, Python, a PostgreSQL 15 dump from a local `initdb`, and a PostgreSQL 16 dump made in Docker `postgres:16.1`. The 16 dump proves the Docker fallback, because the local `pg_restore` 15 cannot read it. `02` pushes from the **real scrubbed clone** to a local bare repo, by URL; the clone still has no remotes afterwards. Typed confirmations run on a pseudo-terminal through `script(1)`, answering only after the prompt.

Result: **85 passed, 0 failed.** The run found and fixed four real bugs before they could matter in the morning:

1. `SHA256SUMS` line order depended on whether `dumpdata.json` had just been extracted. A re-run would then hit the create-only precondition (HTTP 412). It is now sorted by object URL.
2. `ssh` without `-n` can read the terminal and swallow the typed confirmation. All Dokku calls now use `ssh -n`.
3. When key listing was denied, `04` printed "no user-managed keys left". It now prints the delete command with a placeholder and says why.
4. `01` and `04` loop over a plan read from a here-document. Any command in the loop that read stdin (a prompt, for example) would have swallowed the rest of the plan. Every wrapped command now gets `</dev/null`. The fakes drain a non-terminal stdin (`FAKE_READ_STDIN=1`) to keep this covered. As a negative control, a copy of the scripts with the fix reverted fails the suite: `01` uploads only the first file.

<details><summary>Test transcript</summary>

```
# building fixtures
built PostgreSQL 15 dumps
built PostgreSQL 16 dump (Docker postgres:16.1)
# 03 export
ok   03 export dry-run (exit 0)
ok   03 export dry-run discovered the linked service
ok   03 export dry-run wrote no dump
ok   03 export --execute rejects a dump without flex_flexpage (exit 1)
ok   03 rejected dump names the missing table
ok   03 rejected dump is not saved as the final dump
ok   03 rejected dump is kept as .partial for inspection
ok   03 export --execute (exit 0)
ok   03 export saved the dump
ok   03 export wrote the sha256 file
ok   03 export dump is private (mode 600)
ok   03 used Docker postgres:16.1 because local pg_restore 15 cannot read a 16 dump
ok   03 export listed the version header
ok   03 export --execute again (idempotent) (exit 0)
ok   03 second export did not export again
# 01 archive
ok   01 dry-run (exit 0)
ok   01 dry-run made no changes
ok   01 dry-run did not extract dumpdata.json
ok   01 --execute refuses a bucket without public access prevention (exit 1)
ok   01 refused before any upload
ok   01 --execute (exit 0)
ok   01 extracted dumpdata.json and matched the manifest
ok   01 uploaded the export zip
ok   01 uploaded dumpdata.json
ok   01 uploaded the final dump
ok   01 uploaded the GCS file list
ok   01 uploaded SHA256SUMS listing 4 objects
ok   01 verified every object
ok   01 used create-only uploads
ok   01 --execute again (idempotent) (exit 0)
ok   01 second run uploaded nothing
ok   01 --execute on a later date (exit 0)
ok   01 later date reuses the earlier archive (no uploads)
ok   01 --execute refuses to replace a different file on the same date (exit 1)
ok   01 conflict uploaded nothing
ok   01 conflict is explained
# 02 push
ok   02 dry-run (exit 0)
ok   02 dry-run created nothing
ok   02 --execute (exit 0)
ok   02 remote main equals the scrubbed clone
ok   02 remote has no secrets.json history
ok   02 repo is private and archived
ok   02 verified the mirror clone with gitleaks
ok   02 left the scrubbed clone without remotes
ok   02 --execute again (archived, refs match) (exit 0)
ok   02 second run created and archived nothing
ok   02 --execute refuses a repo with secrets.json in history (exit 1)
ok   02 refused before creating anything
# 03 destroy
ok   03 destroy --execute refuses while the site still uses the backend (exit 1)
ok   03 refusal names the site check
ok   03 refused before destroying
ok   03 destroy --execute refuses a service shared with another app (exit 1)
ok   03 shared-service refusal destroyed nothing
ok   03 destroy --execute without a terminal refuses (exit 1)
ok   03 no-terminal refusal destroyed nothing
ok   03 destroy --execute with a wrong typed confirmation (exit 1)
ok   03 wrong typed confirmation aborts
ok   03 wrong confirmation destroyed nothing
ok   03 destroy --execute with the app name typed (exit 0)
ok   03 destroy reports success
ok   03 app is gone
ok   03 service is gone
ok   03 other app untouched
ok   03 other service untouched
ok   03 destroy --execute again (already gone) (exit 0)
ok   03 second run destroyed nothing
# 04 lockdown
ok   04 --execute refuses before cutover (exit 1)
ok   04 refused before changing anything
ok   04 --authenticated-users-only --execute (allowed before cutover) (exit 0)
ok   04 removed allAuthenticatedUsers
ok   04 kept allUsers read access
ok   04 left public access prevention alone
ok   04 deleted no keys
ok   04 --execute --include-legacy-sa (exit 0)
ok   04 no public bindings left
ok   04 kept project bindings
ok   04 enforced public access prevention
ok   04 deleted the user-managed keys
ok   04 kept the system-managed keys
ok   04 never deleted a system-managed key
ok   04 saw anonymous access denied
ok   04 left every bucket object in place
ok   04 --execute again (nothing left to do) (exit 0)
ok   04 second run changed nothing
# lint
ok   shellcheck (exit 0)
passed: 85  failed: 0
```
</details>

## 5. Dry-run outputs (tonight)

Run from the repo root on 2026-11-26 (UTC date 2026-11-25). The personal gcloud account and gcloud's ErrorInfo and troubleshooter blocks are replaced with markers; full outputs are in `~/cjoshmartin-migration/reports/wp6/`. `03` ran with `--offline`: its online dry-run reads over SSH from the production Dokku host, and SSH steps belong to the owner.

| Run | Exit | Why |
|---|---|---|
| `01 … wagtail-final.dump` | 3 | The final dump does not exist yet (step 1), and `gs://cjoshmartin-sanity-backups` does not exist yet (WP5, morning). |
| `02` | 0 | All prerequisites pass. The repo would be created, pushed, verified and archived. |
| `03 --offline export` | 0 | Plan printed. |
| `03 --offline destroy` | 3 | No final dump yet. The site check was skipped (offline). |
| `04` | 3 | The live site still uses `images-for-cms` (correct: lockdown must wait for cutover), and the active account cannot list keys. |
| `04 --authenticated-users-only` | 0 | Would remove the two `allAuthenticatedUsers` bindings only. |
| `05` | 1 | Every teardown check is FAIL (not done yet). Row 39 is NOT CHECKED (needs the owner), D10 is NOT CHECKED (needs `--ssh`), and there are two WARN rows (F2, F3). |

### `scripts/decommission/01-archive-to-backup-bucket.sh ~/cjoshmartin-migration/final/wagtail-final.dump`

```
01: archive the Wagtail export, dumpdata, final Postgres dump and GCS file list to gs://cjoshmartin-sanity-backups/archive/2026-11-25/
MODE: DRY-RUN. Read-only queries run; nothing is changed. Re-run with --execute to apply.

== Prerequisites ==
  [PASS] tool 'gcloud' is installed
  [PASS] tool 'openssl' is installed
  [PASS] tool 'unzip' is installed
  [PASS] tool 'python3' is installed
  [PASS] tool 'base64' is installed
  [PASS] tool 'curl' is installed
  [PASS] export zip ~/cjoshmartin-migration/wagtail-export.zip exists, tests OK and has export.json, dumpdata.json, manifest.json
  [PASS] ~/cjoshmartin-migration/final/dumpdata.json matches the sha256 in the zip's manifest.json
  [PASS] ~/cjoshmartin-migration/final/gcs-file-list.txt exists and ends with gsutil's TOTAL line
  [FAIL] ~/cjoshmartin-migration/final/wagtail-final.dump is a non-empty pg_dump custom-format file (PGDMP header)
+ [read-only] gcloud config get-value account
  active gcloud account: <active gcloud account, not the project owner>
+ [read-only] gcloud storage buckets describe gs://cjoshmartin-sanity-backups --format=value\(public_access_prevention\,uniform_bucket_level_access\)
ERROR: (gcloud.storage.buckets.describe) gs://cjoshmartin-sanity-backups not found: 404.
  [FAIL] gs://cjoshmartin-sanity-backups is not readable (run scripts/backup/setup-gcp.sh first, as the com-cjoshmartin owner)

== Plan ==
  wagtail-export.zip: upload to gs://cjoshmartin-sanity-backups/archive/2026-11-25/wagtail-export.zip (md5 aAOQvdvI/SaOSmYv5a+8nQ==, 561129 bytes)
  dumpdata.json: upload to gs://cjoshmartin-sanity-backups/archive/2026-11-25/dumpdata.json (md5 hj3FmCpqeomZ0lyEqKXElg==, 3629824 bytes)
  wagtail-final.dump: local file missing (prerequisite failed); would upload to gs://cjoshmartin-sanity-backups/archive/2026-11-25/wagtail-final.dump
  gcs-file-list.txt: upload to gs://cjoshmartin-sanity-backups/archive/2026-11-25/gcs-file-list.txt (md5 TAm2+T7O2v2uXTpBsSgpLA==, 65807 bytes)
  SHA256SUMS: write ~/cjoshmartin-migration/final/archive-SHA256SUMS and upload it to gs://cjoshmartin-sanity-backups/archive/2026-11-25/SHA256SUMS (create-only)

NOTE: 2 prerequisite check(s) failed. The plan below is printed anyway; --execute would refuse to run.

== Apply ==
wagtail-export.zip (md5 aAOQvdvI/SaOSmYv5a+8nQ==):
DRY-RUN would run: env CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED=False gcloud storage cp --if-generation-match=0 ~/cjoshmartin-migration/wagtail-export.zip gs://cjoshmartin-sanity-backups/archive/2026-11-25/wagtail-export.zip
DRY-RUN would verify: gs://cjoshmartin-sanity-backups/archive/2026-11-25/wagtail-export.zip md5_hash and size equal the local file
dumpdata.json (md5 hj3FmCpqeomZ0lyEqKXElg==):
DRY-RUN would run: env CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED=False gcloud storage cp --if-generation-match=0 ~/cjoshmartin-migration/final/dumpdata.json gs://cjoshmartin-sanity-backups/archive/2026-11-25/dumpdata.json
DRY-RUN would verify: gs://cjoshmartin-sanity-backups/archive/2026-11-25/dumpdata.json md5_hash and size equal the local file
wagtail-final.dump (md5 <md5-of-missing-file>):
DRY-RUN would run: env CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED=False gcloud storage cp --if-generation-match=0 ~/cjoshmartin-migration/final/wagtail-final.dump gs://cjoshmartin-sanity-backups/archive/2026-11-25/wagtail-final.dump
DRY-RUN would verify: gs://cjoshmartin-sanity-backups/archive/2026-11-25/wagtail-final.dump md5_hash and size equal the local file
gcs-file-list.txt (md5 TAm2+T7O2v2uXTpBsSgpLA==):
DRY-RUN would run: env CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED=False gcloud storage cp --if-generation-match=0 ~/cjoshmartin-migration/final/gcs-file-list.txt gs://cjoshmartin-sanity-backups/archive/2026-11-25/gcs-file-list.txt
DRY-RUN would verify: gs://cjoshmartin-sanity-backups/archive/2026-11-25/gcs-file-list.txt md5_hash and size equal the local file
SHA256SUMS:
DRY-RUN would write ~/cjoshmartin-migration/final/archive-SHA256SUMS with "<sha256>  <object url>" for each file above, sorted by URL
DRY-RUN would run: env CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED=False gcloud storage cp --if-generation-match=0 ~/cjoshmartin-migration/final/archive-SHA256SUMS gs://cjoshmartin-sanity-backups/archive/2026-11-25/SHA256SUMS
DRY-RUN would verify: gs://cjoshmartin-sanity-backups/archive/2026-11-25/SHA256SUMS md5_hash and size equal the local file

== Archive listing ==
+ [read-only] gcloud storage ls -l gs://cjoshmartin-sanity-backups/archive/\*\*
ERROR: (gcloud.storage.ls) gs://cjoshmartin-sanity-backups not found: 404.
  (listing failed; expected in a dry-run before the bucket exists)

DONE (dry-run) with 2 failed prerequisite(s). Exit status 3.
[exit status: 3]
```

### `scripts/decommission/02-push-backend-archive.sh`

```
02: push the scrubbed backend repo to cjoshmartin-com/cjoshmartin-backend-archive (private), verify it, then archive it
MODE: DRY-RUN. Read-only queries run; nothing is changed. Re-run with --execute to apply.

== Prerequisites ==
  [PASS] tool 'git' is installed
  [PASS] tool 'gh' is installed
  [PASS] tool 'gitleaks' is installed
  [PASS] ~/cjoshmartin-migration/backend-archive/cjoshmartin-backend is a git repository
  [PASS] scrubbed clone has no remotes
  [PASS] scrubbed clone has only branches and tags
  [PASS] scrubbed clone has a main branch
  [PASS] scrubbed clone working tree is clean
  [PASS] scrubbed clone has no secrets.json on disk
  [PASS] git log --all -- secrets.json is empty in the scrubbed clone
  [PASS] no path named secrets.json in any commit of the scrubbed clone
  [PASS] gitleaks finds nothing in the scrubbed clone's history
  local refs to publish:
    d68a9ed8caf6ecca12dea04bbde322e9b22afd54 refs/heads/main
  [PASS] gh is logged in to github.com
  [PASS] the gh user can create repositories in cjoshmartin-com
+ [read-only] gh repo view cjoshmartin-com/cjoshmartin-backend-archive --json visibility\,isArchived
  cjoshmartin-com/cjoshmartin-backend-archive does not exist yet; it will be created
  push URL (ssh): git@github.com:cjoshmartin-com/cjoshmartin-backend-archive.git

== 1. Create the private repository ==
DRY-RUN would run: gh repo create cjoshmartin-com/cjoshmartin-backend-archive --private --description Archive\ of\ the\ retired\ Wagtail\ backend\ for\ cjoshmartin.com.\ secrets.json\ and\ hardcoded\ dev\ secrets\ were\ removed\ from\ history.\ Read-only. --disable-issues --disable-wiki

== 2. Push every branch and tag (no force) ==
DRY-RUN would run: git -C ~/cjoshmartin-migration/backend-archive/cjoshmartin-backend push --porcelain git@github.com:cjoshmartin-com/cjoshmartin-backend-archive.git refs/heads/\*:refs/heads/\* refs/tags/\*:refs/tags/\*

== 3. Verify the remote ==
DRY-RUN would run: git ls-remote git@github.com:cjoshmartin-com/cjoshmartin-backend-archive.git refs/heads/\* refs/tags/\* and compare it with the local refs
DRY-RUN would run: git clone --mirror git@github.com:cjoshmartin-com/cjoshmartin-backend-archive.git $TMPDIR/decom-02.WvYYoC/remote.git
DRY-RUN would check in that clone: git log --all -- secrets.json is empty, no secrets.json path in any commit, gitleaks git is clean, HEAD file list equals the scrubbed clone's

== 4. Archive the repository ==
DRY-RUN would run: gh repo archive cjoshmartin-com/cjoshmartin-backend-archive --yes

== 5. Final state ==
DRY-RUN would check: gh repo view cjoshmartin-com/cjoshmartin-backend-archive --json visibility\,isArchived prints "PRIVATE true"

DONE (dry-run). Nothing was changed. Re-run with --execute to apply.
[exit status: 0]
```

### `scripts/decommission/03-dokku-teardown.sh --offline export`

```
03 (export): Dokku app cjoshmartin-django on dokku@159.203.93.178
MODE: DRY-RUN, OFFLINE. Nothing is contacted or changed; discovered values appear as <placeholders>.

== Prerequisites and discovery ==
  [PASS] tool 'ssh' is installed
+ [read-only] ssh -n -o BatchMode=yes -o ConnectTimeout=20 dokku@159.203.93.178 -- apps:exists cjoshmartin-django
  (offline: not run)
+ [read-only] ssh -n -o BatchMode=yes -o ConnectTimeout=20 dokku@159.203.93.178 -- --quiet postgres:list
  (offline: not run)
+ [read-only] ssh -n -o BatchMode=yes -o ConnectTimeout=20 dokku@159.203.93.178 -- --quiet postgres:app-links cjoshmartin-django
  (offline: not run)
+ [read-only] ssh -n -o BatchMode=yes -o ConnectTimeout=20 dokku@159.203.93.178 -- postgres:info \<service\> --version
  (offline: not run)
+ [read-only] ssh -n -o BatchMode=yes -o ConnectTimeout=20 dokku@159.203.93.178 -- --quiet postgres:links \<service\>
  (offline: not run)
  [PASS] dump directory ~/cjoshmartin-migration/final exists

== Export ==
DRY-RUN would run: ssh -n -o BatchMode=yes -o ConnectTimeout=20 dokku@159.203.93.178 -- postgres:export \<service\ linked\ to\ cjoshmartin-django\> > ~/cjoshmartin-migration/final/wagtail-final.dump.partial
DRY-RUN would check: non-empty, PGDMP header, pg_restore --list succeeds (newest local pg_restore, else Docker postgres:<major>), TABLE DATA present for:
  wagtailcore_page wagtailcore_revision wagtailimages_image wagtailmedia_media wagtaildocs_document blog_blogpage blog_projectpage home_homepage home_testimonial home_service home_author flex_flexpage
DRY-RUN would then move it to ~/cjoshmartin-migration/final/wagtail-final.dump and write ~/cjoshmartin-migration/final/wagtail-final.dump.sha256

Next: 01-archive-to-backup-bucket.sh --execute ~/cjoshmartin-migration/final/wagtail-final.dump, then 03-dokku-teardown.sh --execute destroy

DONE (dry-run). Nothing was changed. Re-run with --execute to apply.
[exit status: 0]
```

### `scripts/decommission/03-dokku-teardown.sh --offline destroy`

```
03 (destroy): Dokku app cjoshmartin-django on dokku@159.203.93.178
MODE: DRY-RUN, OFFLINE. Nothing is contacted or changed; discovered values appear as <placeholders>.

== Prerequisites and discovery ==
  [PASS] tool 'ssh' is installed
+ [read-only] ssh -n -o BatchMode=yes -o ConnectTimeout=20 dokku@159.203.93.178 -- apps:exists cjoshmartin-django
  (offline: not run)
+ [read-only] ssh -n -o BatchMode=yes -o ConnectTimeout=20 dokku@159.203.93.178 -- --quiet postgres:list
  (offline: not run)
+ [read-only] ssh -n -o BatchMode=yes -o ConnectTimeout=20 dokku@159.203.93.178 -- --quiet postgres:app-links cjoshmartin-django
  (offline: not run)
+ [read-only] ssh -n -o BatchMode=yes -o ConnectTimeout=20 dokku@159.203.93.178 -- postgres:info \<service\> --version
  (offline: not run)
+ [read-only] ssh -n -o BatchMode=yes -o ConnectTimeout=20 dokku@159.203.93.178 -- --quiet postgres:links \<service\>
  (offline: not run)
  [PASS] tool 'gcloud' is installed
  [PASS] tool 'curl' is installed
  [PASS] tool 'openssl' is installed
  [PASS] tool 'python3' is installed
  checking the local dump ~/cjoshmartin-migration/final/wagtail-final.dump:
    ~/cjoshmartin-migration/final/wagtail-final.dump is missing or empty
  [FAIL] the final dump is valid
  [SKIP] the dump is in gs://cjoshmartin-sanity-backups/archive/ (no local dump to compare; already failed above)
  [SKIP] https://cjoshmartin.com is served from Sanity and no longer references the backend or images-for-cms (offline)

NOTE: 1 prerequisite check(s) failed. The plan below is printed anyway; --execute would refuse to run.

== Destroy ==
DRY-RUN would run: ssh -n -o BatchMode=yes -o ConnectTimeout=20 dokku@159.203.93.178 -- apps:destroy --force cjoshmartin-django
DRY-RUN would run: ssh -n -o BatchMode=yes -o ConnectTimeout=20 dokku@159.203.93.178 -- postgres:destroy \<service\ linked\ to\ cjoshmartin-django\> --force

== Verify ==
DRY-RUN would check: ssh -n -o BatchMode=yes -o ConnectTimeout=20 dokku@159.203.93.178 -- apps:exists cjoshmartin-django fails, and ssh -n -o BatchMode=yes -o ConnectTimeout=20 dokku@159.203.93.178 -- postgres:exists \<service\ linked\ to\ cjoshmartin-django\> fails

Next: delete the 'backend' A record in GoDaddy (README.md), then 04-gcs-lockdown.sh.

DONE (dry-run) with 1 failed prerequisite(s). Exit status 3.
[exit status: 3]
```

### `scripts/decommission/04-gcs-lockdown.sh`

```
04: make gs://images-for-cms private and delete user-managed keys of: file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com
MODE: DRY-RUN. Read-only queries run; nothing is changed. Re-run with --execute to apply.

== Prerequisites ==
  [PASS] tool 'gcloud' is installed
  [PASS] tool 'python3' is installed
  [PASS] tool 'curl' is installed
+ [read-only] gcloud config get-value account
  active gcloud account: <active gcloud account, not the project owner>
    + [read-only] curl -fsSL https://cjoshmartin.com/
    https://cjoshmartin.com/ still references images-for-cms or backend.cjoshmartin.com
  [FAIL] https://cjoshmartin.com is served from Sanity and no longer references images-for-cms or the backend
+ [read-only] gcloud storage buckets get-iam-policy gs://images-for-cms --format=json
  [PASS] can read the IAM policy of gs://images-for-cms
+ [read-only] gcloud storage buckets describe gs://images-for-cms --format=value\(public_access_prevention\,uniform_bucket_level_access\)
  public_access_prevention / uniform_bucket_level_access: inherited True
  [PASS] uniform bucket-level access is on (no per-object ACLs to clean up)
+ [read-only] gcloud iam service-accounts keys list --iam-account file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com --project com-cjoshmartin --managed-by=user --format=json
ERROR: (gcloud.iam.service-accounts.keys.list) PERMISSION_DENIED: Permission 'iam.serviceAccountKeys.list' denied on resource '//iam.googleapis.com/projects/-/serviceAccounts/107883156988966274962' (or it may not exist). [troubleshooter URL removed]
[gcloud ErrorInfo details removed]
  [FAIL] cannot list keys of file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com (needs iam.serviceAccountKeys.list; log in as the com-cjoshmartin owner)

NOTE: 2 prerequisite check(s) failed. The plan below is printed anyway; --execute would refuse to run.

== 1. Remove public IAM bindings from gs://images-for-cms ==
DRY-RUN would run: gcloud storage buckets remove-iam-policy-binding gs://images-for-cms --member=allAuthenticatedUsers --role=roles/storage.admin --all
DRY-RUN would run: gcloud storage buckets remove-iam-policy-binding gs://images-for-cms --member=allAuthenticatedUsers --role=roles/storage.objectUser --all
DRY-RUN would run: gcloud storage buckets remove-iam-policy-binding gs://images-for-cms --member=allUsers --role=roles/storage.objectViewer --all

== 2. Enforce public access prevention on gs://images-for-cms ==
DRY-RUN would run: gcloud storage buckets update gs://images-for-cms --public-access-prevention

== 3. Delete user-managed service-account keys ==
  keys of file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com were not listed (no permission); each USER_MANAGED key would be deleted with:
DRY-RUN would run: gcloud iam service-accounts keys delete \<USER_MANAGED\ key\ id\> --iam-account file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com --project com-cjoshmartin --quiet
  (fileuploads@com-cjoshmartin.iam.gserviceaccount.com is not included; pass --include-legacy-sa to revoke its keys too)

== Verify ==
DRY-RUN would check: the bucket IAM policy has no bindings for allUsers allAuthenticatedUsers
DRY-RUN would check: public_access_prevention is 'enforced'
DRY-RUN would check: an anonymous GET of an original_images/ object returns 401 or 403
DRY-RUN would check: keys list --managed-by=user is empty for: file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com

DONE (dry-run) with 2 failed prerequisite(s). Exit status 3.
[exit status: 3]
```

### `scripts/decommission/04-gcs-lockdown.sh --authenticated-users-only`

```
04: remove allAuthenticatedUsers access from gs://images-for-cms (allUsers read access is kept)
MODE: DRY-RUN. Read-only queries run; nothing is changed. Re-run with --execute to apply.

== Prerequisites ==
  [PASS] tool 'gcloud' is installed
  [PASS] tool 'python3' is installed
  [PASS] tool 'curl' is installed
+ [read-only] gcloud config get-value account
  active gcloud account: <active gcloud account, not the project owner>
  [SKIP] cutover check (not needed: allUsers read access is kept)
+ [read-only] gcloud storage buckets get-iam-policy gs://images-for-cms --format=json
  [PASS] can read the IAM policy of gs://images-for-cms
+ [read-only] gcloud storage buckets describe gs://images-for-cms --format=value\(public_access_prevention\,uniform_bucket_level_access\)
  public_access_prevention / uniform_bucket_level_access: inherited True
  [PASS] uniform bucket-level access is on (no per-object ACLs to clean up)

== 1. Remove public IAM bindings from gs://images-for-cms ==
DRY-RUN would run: gcloud storage buckets remove-iam-policy-binding gs://images-for-cms --member=allAuthenticatedUsers --role=roles/storage.admin --all
DRY-RUN would run: gcloud storage buckets remove-iam-policy-binding gs://images-for-cms --member=allAuthenticatedUsers --role=roles/storage.objectUser --all

== Verify ==
DRY-RUN would check: the bucket IAM policy has no bindings for allAuthenticatedUsers

DONE (dry-run). Nothing was changed. Re-run with --execute to apply.
[exit status: 0]
```

### `scripts/decommission/05-verify.sh`

```
05: verify the backend teardown (read-only)

== 37. backend.cjoshmartin.com no longer resolves ==
+ [read-only] dig +short NS cjoshmartin.com
+ [read-only] dig +short @ns32.domaincontrol.com. backend.cjoshmartin.com A
+ [read-only] dig +short @ns32.domaincontrol.com. backend.cjoshmartin.com AAAA
+ [read-only] dig +short @ns32.domaincontrol.com. backend.cjoshmartin.com CNAME
+ [read-only] dig +short @ns31.domaincontrol.com. backend.cjoshmartin.com A
+ [read-only] dig +short @ns31.domaincontrol.com. backend.cjoshmartin.com AAAA
+ [read-only] dig +short @ns31.domaincontrol.com. backend.cjoshmartin.com CNAME
  -> FAIL: authoritative answers: ns32.domaincontrol.com.:A=159.203.93.178 ns31.domaincontrol.com.:A=159.203.93.178

== 37b. 159.203.93.178 no longer serves the Wagtail API for backend.cjoshmartin.com ==
+ [read-only] curl -sk --resolve backend.cjoshmartin.com:443:159.203.93.178 https://backend.cjoshmartin.com/api/pages/\?format=json\&fields=_\,id\&limit=1
  -> FAIL: the Wagtail pages API still answers 200 at 159.203.93.178

== 38. Old image URLs return 403 ==
+ [read-only] curl -s -o /dev/null -w %\{http_code\} https://storage.googleapis.com/images-for-cms/original_images/000078110010_Large.jpeg
  -> FAIL: HTTP 200 for https://storage.googleapis.com/images-for-cms/original_images/000078110010_Large.jpeg (expected 403)

== D11. gs://images-for-cms is private ==
+ [read-only] gcloud storage buckets get-iam-policy gs://images-for-cms --format=json
  -> FAIL: still bound: allAuthenticatedUsers:roles/storage.admin allAuthenticatedUsers:roles/storage.objectUser allUsers:roles/storage.objectViewer
+ [read-only] gcloud storage buckets describe gs://images-for-cms --format=value\(public_access_prevention\)
  -> FAIL: public_access_prevention is 'inherited'

== 39. No user-managed keys on the leaked service account ==
+ [read-only] gcloud iam service-accounts keys list --iam-account file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com --project com-cjoshmartin --managed-by=user --format=json
  -> NOT CHECKED: Permission 'iam.serviceAccountKeys.list' denied
+ [read-only] gcloud iam service-accounts keys list --iam-account fileuploads@com-cjoshmartin.iam.gserviceaccount.com --project com-cjoshmartin --managed-by=user --format=json
  -> WARN: could not list keys (needs the com-cjoshmartin owner)

== 40. cjoshmartin-com/cjoshmartin-backend-archive is private, archived and has no secrets.json ==
+ [read-only] gh repo view cjoshmartin-com/cjoshmartin-backend-archive --json visibility\,isArchived
  -> FAIL: cjoshmartin-com/cjoshmartin-backend-archive does not exist yet
  -> FAIL: cjoshmartin-com/cjoshmartin-backend-archive does not exist yet
+ [read-only] gh repo view cjoshmartin-com/backend.cjoshmartin.com --json visibility\,isArchived
  -> WARN: still exists (PRIVATE archived=false) with unscrubbed history (secrets.json); deleting it is an owner decision outside the plan

== 41. gs://cjoshmartin-sanity-backups/archive/ holds the final dump, the export and the file list ==
+ [read-only] gcloud storage objects list gs://cjoshmartin-sanity-backups/archive/\*\* --format=value\(name\)
  -> FAIL: gs://cjoshmartin-sanity-backups does not exist yet

== D10. Dokku app cjoshmartin-django is destroyed ==
  -> NOT CHECKED: pass --ssh (owner's SSH key) to check

== Site serves from Sanity only ==
    + [read-only] curl -fsSL https://cjoshmartin.com/
    https://cjoshmartin.com/ still references images-for-cms or backend.cjoshmartin.com
  -> FAIL: https://cjoshmartin.com/ still references images-for-cms or backend.cjoshmartin.com

STATUS       CHECK      DESCRIPTION                                          DETAIL
FAIL         37         DNS record removed                                   authoritative answers: ns32.domaincontrol.com.:A=159.203.93.178 ns31.domaincontrol.com.:A=159.203.93.178
FAIL         37b        Dokku stopped serving the backend                    the Wagtail pages API still answers 200 at 159.203.93.178
FAIL         38         old image URL denied                                 HTTP 200 for https://storage.googleapis.com/images-for-cms/original_images/000078110010_Large.jpeg (expected 403)
FAIL         D11a       no allUsers/allAuthenticatedUsers bindings           still bound: allAuthenticatedUsers:roles/storage.admin allAuthenticatedUsers:roles/storage.objectUser allUsers:roles/storage.objectViewer
FAIL         D11b       public access prevention enforced                    public_access_prevention is 'inherited'
NOT CHECKED  39         no user-managed keys on file-upload-2024@com-cjoshmartin Permission 'iam.serviceAccountKeys.list' denied
WARN         39-legacy  no user-managed keys on fileuploads@com-cjoshmartin  could not list keys (needs the com-cjoshmartin owner)
FAIL         40a        archive repo private and archived                    cjoshmartin-com/cjoshmartin-backend-archive does not exist yet
FAIL         40b        fresh clone has no secrets.json history              cjoshmartin-com/cjoshmartin-backend-archive does not exist yet
WARN         40-old     old repo cjoshmartin-com/backend.cjoshmartin.com     still exists (PRIVATE archived=false) with unscrubbed history (secrets.json); deleting it is an owner decision outside the plan
FAIL         41         archive folder complete                              gs://cjoshmartin-sanity-backups does not exist yet
NOT CHECKED  D10        Dokku app destroyed                                  pass --ssh (owner's SSH key) to check
FAIL         site       site no longer uses the backend or images-for-cms    https://cjoshmartin.com/ still references images-for-cms or backend.cjoshmartin.com

Some required checks are FAIL (not done yet) or NOT CHECKED.
[exit status: 1]
```

## 6. Deviations from the brief, and why

- **No `--content-md5` on uploads.** Its digest encoding couldn't be tested without a writable bucket. Integrity comes from gcloud's own upload hash check (`check_hashes=if_fast_else_fail`), plus the script's describe-and-compare of MD5 and size. This Mac's Homebrew gcloud lacks the `gcloud-crc32c` helper (`gcloud storage hash` fails without `--skip-crc32c`), so the scripts compare MD5 computed with `openssl`, and they disable parallel composite uploads so every object keeps an MD5.
- **`03` is one script with two phases** (`export`, `destroy`). That matches the morning order: the archive upload happens between them, and `destroy` checks that it did.
- **Extra options beyond the brief:** `04 --include-legacy-sa` and `--authenticated-users-only` (F1, F3), `02 --remote-url` (used by the tests), `03 --service/--re-export`, and `05 --ssh`. None of them change a default.
- **`05-verify.sh` checks more than §12.I.** It adds Dokku-no-longer-serving, the D11 bucket settings, D10 and the site check, and adds WARN rows for F2 and F3. WARN rows do not change the exit status.

## 7. Files

In the repo:

- `scripts/decommission/{lib.sh,01-archive-to-backup-bucket.sh,02-push-backend-archive.sh,03-dokku-teardown.sh,04-gcs-lockdown.sh,05-verify.sh,README.md}`
- `scripts/decommission/test/{run.sh,fakecli.py}`
- `docs/sanity-migration/reports/wp6-decommission.md`

Outside the repo:

- `~/cjoshmartin-migration/backend-archive/cjoshmartin-backend`: the scrubbed clone (main d68a9ed, no remotes)
- `~/cjoshmartin-migration/backend-archive/tools/`: `make_redactions.py`, `blob_callback.py`, `scan_history.py`, and `private/values.sha256`
- `~/cjoshmartin-migration/backend-archive/scans/`: gitleaks before and after (redacted), file lists, `verification.txt`
- `~/cjoshmartin-migration/final/`: `gcs-file-list.txt`, `dumpdata.json` (mode 600)
- `~/cjoshmartin-migration/reports/wp6/`: full dry-run outputs, the test transcript, `leaked-credentials.txt` (mode 600)
