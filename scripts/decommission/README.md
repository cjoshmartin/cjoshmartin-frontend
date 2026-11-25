# Decommissioning the Wagtail backend

Scripts for the teardown in the migration plan (`docs/sanity-migration-plan.md`, D10, D11, §12.I and §13 "Morning" step 5). Nothing here runs by itself, and nothing irreversible happens without `--execute`. The teardown starts only after Josh says go.

| Script | What it does | Who runs it |
|---|---|---|
| `03-dokku-teardown.sh export` | Finds the app's Postgres service and saves `postgres:export` to `~/cjoshmartin-migration/final/wagtail-final.dump`. Checks that the dump is non-empty and readable by `pg_restore --list`, and that it contains the Wagtail tables. | **Josh** (SSH key) |
| `01-archive-to-backup-bucket.sh` | Uploads the export zip, `dumpdata.json`, the final dump, the `images-for-cms` file list and a `SHA256SUMS` file to `gs://cjoshmartin-sanity-backups/archive/<date>/`. Uploads are create-only, and each object's MD5 and size are checked. | Claude, after Josh's `gcloud auth login` |
| `02-push-backend-archive.sh` | Creates the private repo `cjoshmartin-com/cjoshmartin-backend-archive`, pushes the scrubbed clone, checks a fresh mirror clone (no `secrets.json` anywhere, gitleaks clean), then archives the repo. | Claude |
| `03-dokku-teardown.sh destroy` | Asks Josh to type the app name, then runs `apps:destroy` and `postgres:destroy`, and checks both are gone. It refuses until the dump is in the bucket and the live site no longer uses the backend. | **Josh**, or Claude with permission |
| GoDaddy | Deletes the `backend` A record ([steps below](#step-5-josh-delete-the-backend-dns-record-in-godaddy)). | **Josh** |
| `04-gcs-lockdown.sh` | Removes the `allUsers` and `allAuthenticatedUsers` bindings from `gs://images-for-cms`, enforces public access prevention, and deletes the USER_MANAGED keys of `file-upload-2024@`. Nothing is deleted from the bucket. It refuses while any Wagtail video is missing from Mux. | Claude, after Josh's `gcloud auth login` |
| `05-verify.sh` | Runs the §12.I checks (tests 37–41, plus D10 and D11) and prints PASS or FAIL for each. It is read-only. | Josh (with `--ssh`), or Claude |

## How every script behaves

- **Dry-run by default.** Every command is printed. Read-only queries (gcloud, gh, ssh) run so the plan shows real values. Commands that change something print as `DRY-RUN would run: …` and run only with `--execute`.
- **`--offline`** is a dry-run that contacts nothing. Values it would have looked up show as `<placeholders>`.
- **Prerequisites first.** Each one prints `[PASS]`, `[FAIL]` or `[SKIP]`. With `--execute`, a failed prerequisite stops the script before its first change.
- **Exit status:** `0` means done, or a dry-run with every prerequisite met. `1` means an error, or `--execute` refused. `3` means a dry-run with failed prerequisites.
- **Re-running is safe.** Finished steps are recognised and skipped.
- Works with macOS `/bin/bash` 3.2. `MIGRATION_DIR` overrides `~/cjoshmartin-migration`.

Tools: `gcloud`, `gh`, `git`, `gitleaks`, `ssh`, `curl`, `dig`, `openssl`, `unzip`, `python3`. You also need a `pg_restore` at least as new as the Dokku Postgres server. If the newest local one is older (this Mac has PostgreSQL 15), `03` uses `pg_restore` from the service's own Docker image, so Docker Desktop must be running.

## Before the teardown

All of these must be true:

1. The PR is merged, and production `https://cjoshmartin.com` serves from Sanity. Manual tests A–G pass, and 16 and 28 pass on production if they couldn't be checked on Preview.
2. Backups work. `scripts/backup/setup-gcp.sh` has run, which creates `gs://cjoshmartin-sanity-backups` with public access prevention enforced, and tests H (32–36) pass.
3. Josh is logged in to gcloud as the `com-cjoshmartin` owner: `! gcloud auth login`, then `gcloud config set account <owner account>`. The account active tonight cannot list service-account keys. `01`, `04` and `05` print the active account.
4. `gh auth status` shows an account that is an admin of `cjoshmartin-com`.
5. **Every Wagtail video is on Mux** (only for step 6). When last checked (2026-11-25 23:07 UTC), Mux's free plan had accepted 10 of the 29 videos. The migration creates Mux assets from the public `images-for-cms` URLs, so the other 19 can only be migrated while the bucket is public. Upgrade the Mux environment from the free plan (it needs a billing method), then add the videos without touching anything edited in the Studio:

   ```sh
   cd migration/wagtail-to-sanity
   npm run migrate -- --dataset staging --steps mux,videos
   npm run migrate -- --dataset production --confirm-production --steps mux,videos
   ```

   `04-gcs-lockdown.sh` checks this itself: production must hold a ready `mux-video-<id>` document for each media item in the Wagtail export, and every video block of a published post or project must resolve.

## Morning order (§13 step 5)

Run every command from the frontend repo root. Do each step as a dry-run first, read it, then repeat it with `--execute`.

### Step 1 (Josh): export the final Postgres dump

```sh
scripts/decommission/03-dokku-teardown.sh export            # dry-run: discovers the service over SSH
scripts/decommission/03-dokku-teardown.sh --execute export
```

This does what the plan describes:

```sh
ssh dokku@159.203.93.178 postgres:list
ssh dokku@159.203.93.178 postgres:export <svc> > ~/cjoshmartin-migration/final/wagtail-final.dump
```

It writes to a `.partial` file first, and keeps the result only if it passes the checks. It also writes `wagtail-final.dump.sha256` next to the dump.

Expected output (shape; names and sizes will differ):

```
  [PASS] exactly one Postgres service is linked to cjoshmartin-django: <svc>
  service image: postgres:<version> (major <n>)
  apps linked to <svc>: cjoshmartin-django
== Export ==
+ ssh -n -o BatchMode=yes -o ConnectTimeout=20 dokku@159.203.93.178 -- postgres:export <svc> > …/final/wagtail-final.dump.partial
  checking …/final/wagtail-final.dump.partial:
    <bytes> bytes, sha256 <hex>
    <n> TABLE DATA entries; all 12 required Wagtail tables present
    Dumped from database version: <version>
  [PASS] saved …/final/wagtail-final.dump (sha256 in …/final/wagtail-final.dump.sha256)
DONE. All steps completed and verified.
```

If discovery cannot pick the service (for example, several services are linked), pass `--service <name>` after checking `postgres:list`.

### Step 2 (Claude): copy the archive into the backup bucket

```sh
scripts/decommission/01-archive-to-backup-bucket.sh ~/cjoshmartin-migration/final/wagtail-final.dump
scripts/decommission/01-archive-to-backup-bucket.sh --execute ~/cjoshmartin-migration/final/wagtail-final.dump
```

Expected: five `verified gs://cjoshmartin-sanity-backups/archive/<UTC date>/…` lines, then a listing of `archive/`:

```
  verified gs://cjoshmartin-sanity-backups/archive/<date>/wagtail-export.zip (md5 …, 561129 bytes, generation …)
  verified gs://cjoshmartin-sanity-backups/archive/<date>/dumpdata.json (md5 hj3FmCpqeomZ0lyEqKXElg==, 3629824 bytes, …)
  verified gs://cjoshmartin-sanity-backups/archive/<date>/wagtail-final.dump (…)
  verified gs://cjoshmartin-sanity-backups/archive/<date>/gcs-file-list.txt (md5 TAm2+T7O2v2uXTpBsSgpLA==, 65807 bytes, …)
  verified gs://cjoshmartin-sanity-backups/archive/<date>/SHA256SUMS (…)
DONE. All steps completed and verified.
```

The objects are created with `--if-generation-match=0`, so an existing object is never replaced. A file that is already archived under any date, with the same name and MD5, is not uploaded again.

### Step 3 (Claude): publish the scrubbed backend repo

```sh
scripts/decommission/02-push-backend-archive.sh
scripts/decommission/02-push-backend-archive.sh --execute
```

Expected: `[PASS]` for each check on the scrubbed clone, then `gh repo create … --private`, the push, and the checks on a fresh mirror clone:

```
  [PASS] remote branches and tags equal the scrubbed clone's (same commit ids)
  [PASS] fresh mirror clone: git log --all -- secrets.json is empty
  [PASS] fresh mirror clone: no path named secrets.json in any commit
  [PASS] fresh mirror clone: gitleaks finds nothing
  [PASS] fresh mirror clone: HEAD has the same file list as the scrubbed clone
+ gh repo archive cjoshmartin-com/cjoshmartin-backend-archive --yes
  [PASS] cjoshmartin-com/cjoshmartin-backend-archive is private and archived
```

The scrubbed clone is `~/cjoshmartin-migration/backend-archive/cjoshmartin-backend`. How it was made and checked is in `docs/sanity-migration/reports/wp6-decommission.md`.

### Step 4 (Josh, or Claude with permission): destroy the Dokku app and its database

```sh
scripts/decommission/03-dokku-teardown.sh destroy
scripts/decommission/03-dokku-teardown.sh --execute destroy
```

Before it asks anything, it checks four things:

- the local dump is still valid
- the same dump (name, MD5, size) is in `gs://cjoshmartin-sanity-backups/archive/`
- `https://cjoshmartin.com/`, `/blog` and `/projects` reference `cdn.sanity.io`, and no longer reference `images-for-cms` or `backend.cjoshmartin.com`
- the service is linked to no app other than `cjoshmartin-django`

Then it asks you to type the app name:

```
This permanently destroys the Dokku app 'cjoshmartin-django' and the Postgres service '<svc>' on dokku@159.203.93.178. Type the app name to continue:
> cjoshmartin-django
+ ssh -n … -- apps:destroy --force cjoshmartin-django
+ ssh -n … -- postgres:destroy <svc> --force
  [PASS] apps:exists cjoshmartin-django fails: the app is gone
  [PASS] postgres:exists <svc> fails: the service is gone
```

`apps:destroy` unlinks the service first, which is why `postgres:destroy` comes second. The droplet itself and any other apps on it are not touched. The script lists `storage:list cjoshmartin-django` beforehand, because host directories for persistent storage are not removed by `apps:destroy`.

### Step 5 (Josh): delete the `backend` DNS record in GoDaddy

DNS for `cjoshmartin.com` is at GoDaddy (name servers `ns31`/`ns32.domaincontrol.com`). The only record to delete is **Type A, Name `backend`, Value `159.203.93.178`**. There is no wildcard record, so once it is deleted the name stops resolving. GoDaddy moves its menus around, so the labels may differ slightly from these:

1. Open <https://dcc.godaddy.com/control/portfolio> and sign in with the GoDaddy account that owns `cjoshmartin.com`.
2. In **Domain Portfolio**, click **cjoshmartin.com**.
3. Click the **DNS** tab. On older layouts, it's the **⋯** menu, then **Manage DNS**. You should see the **DNS Records** table.
4. Find the row where **Type** is `A`, **Name** is `backend` and **Data** is `159.203.93.178`. If there is a search or filter box, type `backend`.
5. Click that row's **trash-can (Delete)** icon. On some layouts, click the **pencil (Edit)** icon first, then **Delete**.
6. In the confirmation dialog, click **Delete**. If a **Save** button appears at the bottom of the table, click it.
7. Check that only that row is gone. Do **not** change the `@` or `www` records (they point at Vercel), any other record, or the name servers.
8. Check from a terminal. The first command should print nothing within a minute or two; public resolvers may keep the old answer for up to 600 seconds (the record's TTL):

   ```sh
   dig +short @ns31.domaincontrol.com backend.cjoshmartin.com A
   dig +short @ns32.domaincontrol.com backend.cjoshmartin.com A
   ```

### Step 6 (Claude): make `images-for-cms` private and revoke the leaked key

```sh
scripts/decommission/04-gcs-lockdown.sh
scripts/decommission/04-gcs-lockdown.sh --execute            # add --include-legacy-sa if Josh agrees (see below)
```

It refuses to run until the live site no longer references `images-for-cms`, because afterwards every old image URL returns 403. It also refuses until every Wagtail video is on Mux (prerequisite 5 above), because afterwards the missing videos could not be ingested from the bucket. Expected:

```
+ gcloud storage buckets remove-iam-policy-binding gs://images-for-cms --member=allAuthenticatedUsers --role=roles/storage.admin --all
+ gcloud storage buckets remove-iam-policy-binding gs://images-for-cms --member=allAuthenticatedUsers --role=roles/storage.objectUser --all
+ gcloud storage buckets remove-iam-policy-binding gs://images-for-cms --member=allUsers --role=roles/storage.objectViewer --all
+ gcloud storage buckets update gs://images-for-cms --public-access-prevention
+ gcloud iam service-accounts keys delete <key id> --iam-account file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com --project com-cjoshmartin --quiet
  [PASS] every Wagtail video is on Mux (production has a ready mux.videoAsset for each, and every video block resolves)
  …
  [PASS] no IAM bindings for allUsers allAuthenticatedUsers
  [PASS] public access prevention is enforced
  [PASS] anonymous GET https://storage.googleapis.com/images-for-cms/original_images/… returns 403
  [PASS] file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com has no user-managed keys
```

It deletes only keys whose `keyType` is `USER_MANAGED`, and checks that twice: through `--managed-by=user` and against the JSON. It never deletes a bucket object.

After the keys are deleted, remove this Mac's stale local credential for that service account: `gcloud auth revoke file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com`. It shows up in `gcloud auth list`.

### Step 7 (Josh): tests I (37–41)

```sh
scripts/decommission/05-verify.sh --ssh
```

Expected after the teardown: every row is `PASS`, and the script exits 0. A `WARN` row is informational. Before the teardown, every teardown row is `FAIL` ("not done yet"); see the report for tonight's run. Checks:

| Row | Check |
|---|---|
| 37 | no A, AAAA or CNAME for `backend.cjoshmartin.com` at the GoDaddy name servers (WARN if a public resolver still has it cached) |
| 37b | `159.203.93.178` no longer answers the Wagtail pages API for `backend.cjoshmartin.com` |
| 38 | an old `images-for-cms/original_images/…` URL returns 403 |
| D11a, D11b | no `allUsers`/`allAuthenticatedUsers` bindings; public access prevention enforced |
| 39 | `file-upload-2024@` has no user-managed keys (39-legacy is a WARN row for `fileuploads@`) |
| 40a, 40b | the archive repo is private and archived; a fresh clone has no `secrets.json` in any commit |
| 41 | `archive/` holds `wagtail-export.zip`, `dumpdata.json`, `gcs-file-list.txt`, `SHA256SUMS` and the `.dump` |
| D10 | (`--ssh`) `apps:exists cjoshmartin-django` fails |
| site | `/`, `/blog`, `/projects` reference `cdn.sanity.io` and not the old backend or bucket |

Also check test 40 by hand once: `gh repo clone cjoshmartin-com/cjoshmartin-backend-archive /tmp/a && git -C /tmp/a log --all -- secrets.json` prints nothing.

## Decisions for Josh (found while preparing; not in the approved plan)

1. **`images-for-cms` grants `allAuthenticatedUsers` the `roles/storage.admin` role** (and `roles/storage.objectUser`). Any Google account can change the bucket's IAM, or delete or replace objects, today. You can remove only those bindings now without breaking the live site, because `allUsers` read access stays:
   `scripts/decommission/04-gcs-lockdown.sh --authenticated-users-only --execute`.
   One caveat: if Wagtail's service account writes only through that binding, new image renditions on the old backend stop being created. That's acceptable during the content freeze.
2. **A second leaked key.** History also contains a key for `fileuploads@com-cjoshmartin` (committed 2024-02 to 2025-07). D11 covers only `file-upload-2024@`. To revoke the other key too, add `--include-legacy-sa` in step 6. `05-verify.sh` reports it as `39-legacy`.
3. **There is already a private GitHub repo with the unscrubbed history:** `cjoshmartin-com/backend.cjoshmartin.com` (the original repo's `origin`). `secrets.json` is even present at its `main` HEAD. The plan assumed there was no GitHub copy. Once the archive repo is verified, decide whether to delete it in GitHub settings, or at least archive it. Revoking the keys in step 6 makes the leaked keys useless either way. `05-verify.sh` reports it as `40-old`.
4. **Local stashes** in `~/code/cjoshmartin.com/cjoshmartin-backend` (`git stash list`, 4 entries) include `secrets.json` and a second JSON key file for `file-upload-2024@`. They are not part of any clone or the archive. Step 6 deletes that key on the GCP side. Drop the stashes (`git stash clear`) when you no longer need them.

## Rollback

- Before step 4, nothing is lost: the app, the database and DNS are untouched.
- After step 4, restore the archived dump into a new Postgres service, create a new Dokku app from the archive repo, re-add the DNS record, and re-grant `allUsers` read on the bucket. This is slow but possible, because `archive/` and the repo hold everything.

## Tests

`scripts/decommission/test/run.sh` runs the `--execute` paths of `01`–`04` against fake `gcloud`, `gh`, `ssh` and `curl` (`test/fakecli.py`), in the order above. It covers the failure, refusal and re-run cases. Everything else is real: git, gitleaks, openssl, unzip, a PostgreSQL 15 dump, and a PostgreSQL 16 dump made in Docker, which the local `pg_restore` cannot read. The 16 dump exercises the Docker fallback. The run also lints every script with `shellcheck -x`.
