# Sanity backups

Weekly, change-only backups of the cjoshmartin.com Sanity dataset to a private Google Cloud Storage bucket, plus a restore tool. The design is in `docs/sanity-migration-plan.md` §10. This README covers how it works, how to run and restore it, the one-time setup, and the costs.

- `backup.mjs`: one backup run. GitHub Actions runs it every Sunday at 09:00 UTC (`.github/workflows/sanity-backup.yml`).
- `restore.mjs`: rebuilds a standard Sanity import from a snapshot and runs `sanity datasets import`.
- `setup-gcp.sh`: creates the bucket and the keyless GitHub access. It is idempotent.
- `lib/`: the modules. `test/`: unit tests (`npm test`).

The package is self-contained: Node 24 or newer, ESM, with its own `package.json` and lockfile. Run `npm ci` in this folder first.

## How it works

### Bucket layout (`gs://cjoshmartin-sanity-backups`)

```
snapshots/<ts>/data.ndjson.gz   every document, as the Export API returns it, sorted by _id
snapshots/<ts>/manifest.json    fingerprint, counts per type, asset list
assets/images/<sha1>.<ext>      each Sanity image, stored once
assets/files/<sha1>.<ext>       each Sanity file, stored once, videos included (see Videos)
markers/<ts>.json               written last; a snapshot without a marker is incomplete
archive/                        one-time decommission files (written by hand, not by this tool)
```

Plan §10 also had `assets/mux/` for Mux originals. Mux was dropped on 2026-11-26, before the bucket was ever created, so that prefix never existed in it.

`<ts>` is a UTC timestamp in ISO 8601 basic format, for example `20261129T090000Z`. Names sort in time order, so the newest marker is the lexicographically last name.

### One run

1. **List the bucket.** If it already holds more than 4 GiB, fail before doing anything else.
2. **Export.** A single request to the Sanity Export API (`GET /v2025-02-19/data/export/<dataset>`) with a Viewer token. It returns every non-deleted document the token can read: published documents, drafts, release versions, asset documents (`sanity.imageAsset`, `sanity.fileAsset`), and system documents (`_.groups.*`, `_.retention.*`, `_.schemas.*`, `_.releases.*`). Sanity's docs say a stream that fails midway still returns HTTP 200 and ends with an `{"error": …}` line, so every line is checked. Stream mode gives a consistent point-in-time view.
3. **Fingerprint.** sha256 over the sorted lines `<_id>:<_rev>\n`, one per exported document. That is every document in the raw perspective. On 2026-11-26, `*[]._id` with `perspective=raw` and the export returned the same ID set on both datasets, system documents included. The fingerprint comes from the same export that becomes the snapshot, so the two can never disagree.
4. **Compare.** Find the newest marker for this project and dataset. If its fingerprint matches, log "No changes", write nothing, and exit 0. Markers for other datasets in the same bucket are skipped, so a staging test run can never hide a production change.
5. **Back up.** Every write is create-only (`ifGenerationMatch=0`). Nothing is ever overwritten or deleted, and the CI identity has no delete permission.
   - **Assets.** Each image or file whose `assets/...` object is missing is downloaded from the Sanity CDN and uploaded. Images use `?dlRaw=true` and the token, as `sanity datasets export` does. A download is accepted only if its sha1 equals the asset document's `sha1hash`, or if the CDN's `x-sanity-sha1` / `x-sanity-md5` headers vouch for it (Sanity rewrites some files after hashing, such as sanitized SVGs). A Content-Length mismatch also fails the run. If an asset binary is missing (HTTP 404), the run fails and names the asset, because a snapshot must be complete to be restorable. Fix it by re-uploading the asset in the Studio, or by deleting the asset document if nothing uses it. Each download must finish within 5 minutes plus 1 second per 512 KiB of the file, so large video files get more time.
   - **Videos** are file assets and take the same path; see [Videos](#videos).
   - **Snapshot.** Then `data.ndjson.gz`, then `manifest.json`, then the marker last.
6. **Size check.** If the bucket now holds more than 4 GiB, the run fails *after* writing the marker. The snapshot is complete; the failure is the alert.

A run that dies midway leaves stored assets in place, because they are content-addressed. It writes no marker, so the next run retries and only uploads what is still missing. If a retried request finds that its own earlier attempt already wrote an object, the write is treated as done: identical bytes for snapshot files, the same size for content-addressed assets. Different content makes the run fail.

### What counts as a change

Any document, draft, release version, asset, or system document that is added, edited, or deleted changes some `_id:_rev` pair, so it triggers a snapshot. That includes a Studio schema deploy (`_.schemas.*`). Reordering does not trigger one: the fingerprint is order-independent. A restore rewrites every imported document with a new `_rev`, so the first backup after a restore always writes a new snapshot, even when the content is the same. It uploads no assets again.

### What a snapshot contains

`data.ndjson.gz` is the full raw export, documents only, drafts included. The Viewer token can read `secrets.*` documents: on 2026-11-25 a temporary `secrets.wp8-viewer-check` document (dummy values) in `staging` was returned to the Viewer token by both a raw-perspective query and the Export API, and not to an anonymous request; it was deleted afterwards. So any token a Studio plugin stores in a `secrets.*` document ends up in every snapshot, and a restore brings it back. Neither dataset has such a document (checked 2026-11-26): the Mux plugin, which would have stored `secrets.mux`, was dropped without its token ever being entered. The bucket is private, and only the backup service account and project owners can read it. If the bucket is ever exposed, rotate any token a `secrets.*` document in it holds.

### Videos

Every video is stored in Sanity; Mux is no longer used (owner decision, 2026-11-26). A Portable Text `video` block holds two file assets (video contract v2, `docs/sanity-migration/schema-contract.md`):

- `file`: what the site plays. Once converted, it is an H.264 MP4 named `<original base name>.mp4`, with `source: {name: "video-to-mp4", id: <original asset _id>}`.
- `original`: the upload as it was (`.mov`, `.MP4`, `.webm`, ...), kept read-only in the Studio and never served.

Both are ordinary `sanity.fileAsset` documents, so the backup has no video code of its own:

- **Backup.** Each file is downloaded from the Sanity CDN, verified by its `sha1hash`, and stored once at `assets/files/<sha1>.<ext>`, however many documents, drafts, release versions or datasets reference it. A video that is not converted yet (its `file` still points at the upload) is backed up as it is. The log line `Assets: N in the dataset (V of them videos)` counts the `video/*` files, and the manifest lists each with its `mimeType`.
- **Restore.** The import re-uploads both files and gets the same content-addressed ids back, so `file`, `original`, `conversion.sourceAssetId` and `conversion.outputAssetId` still agree after a restore. `assets.json`, and with `--replace` the asset metadata patches, give each file its `originalFilename` back and the MP4 its `source`. The converter finds existing MP4s by that `source`, so a restored block whose `file` is already its MP4 needs no conversion, and a block caught mid-conversion reuses the MP4 instead of converting again.

The tests cover this: an MP4 and its original referenced from a post and its draft are each downloaded and stored once, a later snapshot and another dataset's snapshot store neither again, and the restore tarball, run through `@sanity/import`, uploads each once and returns the blocks, file names and `source` unchanged.

The 29 videos migrated from Wagtail also keep their Wagtail files (`.mov`/`.MP4`/`.webm`) in the old `images-for-cms` bucket under `media/`. Plan D11 keeps that bucket, made private.

### Exit codes

- `0`: a snapshot was written, there were no changes, or it was a dry run.
- `1`: failure. Any marker written by the run is still valid (see the size check).

Exit code `3` (a snapshot written with warnings) is gone: the only warnings were Mux originals that could not be fetched. Every other problem fails the run.

## Running it by hand

```sh
cd scripts/backup
npm ci
set -a; . ~/cjoshmartin-migration/secrets.env; set +a   # SANITY_PROJECT_ID, SANITY_READ_TOKEN

# Local directory instead of GCS (good for testing; only reads from Sanity)
node backup.mjs --dataset staging --target local --local-dir /tmp/sanity-backups

# Real bucket, read-only preview: fingerprint, compare, list what would be written
gcloud auth application-default login
node backup.mjs --dataset production --target gcs --bucket cjoshmartin-sanity-backups --dry-run

# Real run
node backup.mjs --dataset production --target gcs --bucket cjoshmartin-sanity-backups
```

`node backup.mjs --help` lists every option. In GitHub, use **Actions → Sanity backup → Run workflow**. You can pick the dataset and a dry run. Manual runs only authenticate from `main`, because the Workload Identity provider only admits `refs/heads/main`.

Run the tests with `npm test`. They cover:

- fingerprint order independence and coverage
- a no-change run writing nothing
- a changed run writing the snapshot and then the marker last
- asset dedupe and resuming after a failure
- videos: an MP4 and its kept original stored once each, across references, snapshots and datasets
- the size limit and per-dataset markers
- download time limits that grow with the file size
- the GCS adapter's create-only preconditions
- the restore NDJSON rewriting and tarball layout
- the asset metadata patches, `--verify` (including `_createdAt`), and the Mutate API calls behind `--exact`

They also include a contract test that feeds the restore tarball to `@sanity/import`, the library behind `sanity datasets import`, and checks that the backed-up documents come back unchanged, video blocks and their two files included.

`npm run test:gcs-emulator` runs the GCS adapter and a full backup → no-change → restore-build cycle with the real `@google-cloud/storage` client against [fake-gcs-server](https://github.com/fsouza/fake-gcs-server). It is kept out of `npm test` because it needs Docker. The commands are at the top of `integration/gcs-emulator.test.mjs`.

## Restore

**A restore is not a point-in-time reset.** `sanity datasets import --replace` overwrites documents that share an id with the snapshot. Everything else stays:

- documents and assets created after the snapshot remain (use `--exact` to remove them)
- document history is not restored, and `_rev` and `_updatedAt` get new values
- `_createdAt` is only partly restored. Documents the import creates get the snapshot's value, documents that already exist in the target keep their own, and a re-created release definition gets the time of the import. The site does not read `_createdAt`.
- Sanity-managed system documents (`_.groups.*` roles, `_.retention.*`, `_.schemas.*`) are not restored
- Studio, schema, CORS origins, tokens, webhooks, and Functions are not in the dataset at all
- release definitions (`_.releases.*`) and their versions are restored through Sanity's release import action
- videos come back like any other file: the MP4 and the kept original are re-uploaded from the bucket (see [Videos](#videos))

What `restore.mjs` does:

1. It picks the snapshot (`--snapshot <ts>`, or `--latest`). It only accepts snapshots that have a marker, and only snapshots of the source dataset: `--from-dataset`, which defaults to the target `--dataset`. Staging and production share the bucket, so `--latest --dataset production` takes the newest *production* snapshot even when a staging snapshot is newer, and `--snapshot <ts>` is refused when that snapshot is of another dataset. Restoring one dataset's snapshot into another (for example production into staging) needs `--from-dataset <source>`; the restore then prints a warning naming both.
2. It checks integrity: the manifest's hash against the marker, `data.ndjson.gz`'s hash against the manifest, and the documents' fingerprint against the marker.
3. It builds a standard import tarball, the same layout `sanity datasets export` produces: `<dataset>-<ts>/data.ndjson`, `assets.json`, `images/`, `files/`.
   - Asset documents are left out. Every `{asset: {_ref: "image-…"}}` becomes `{_sanityAsset: "image@file://./images/<sha1>.<ext>"}`, and the binaries come from the bucket. The import uploads each binary (or reuses an identical one already in the target) and recreates the same content-addressed asset ids. `assets.json` restores asset metadata such as `originalFilename`. Every asset in the snapshot is included, referenced or not.
   - Sanity-managed system documents are left out. Release definitions are kept.
   - Everything else is kept as is, including drafts and release versions.
   - `--allow-assets-in-different-dataset` is passed only when the import file still holds asset documents of another type whose URL points at a different project or dataset. Image and file assets are never kept as documents, so with today's content it is never needed.
4. It runs `npx --yes sanity@latest datasets import <tarball> --project <id> --dataset <target> [--replace]` with `SANITY_AUTH_TOKEN` set to `SANITY_WRITE_TOKEN`. `--replace`, `--exact` and `--verify` need that token. Only a plain import into an empty dataset can run without it, on your `sanity login` session.
5. With `--replace` (and so with `--exact`) it then restores asset metadata.
   - **Why.** The import only applies `assets.json` to binaries it uploads. When the target already has an asset with the same content, the import reuses that asset document as it is, so the target keeps its own metadata. On 2026-11-26, 15 image assets in `staging` had a `metadata.thumbHash` that `production` lacked, and the plain import left them that way.
   - **What it does.** It compares every snapshot asset with the target asset of the same id or sha1. For each one that differs, it sets the differing top-level fields to the snapshot's values and unsets the fields the snapshot doesn't have.
   - **Fields it never touches.** `_id`, `_type`, `_rev`, `_createdAt`, `_updatedAt`, `assetId`, `extension`, `mimeType`, `path`, `url`, `sha1hash`, `size`, `uploadId`. The asset service derives these from the stored blob, its location, or the upload. `@sanity/import` refuses to replay `uploadId`, because doing so makes the asset impossible to delete.
6. `--exact` (which implies `--replace`) then deletes target documents that are not in the snapshot: other documents first, then other assets. System documents are never deleted; a release that is not in the snapshot is reported so you can archive it in the Studio. The deletes run *after* the import rather than before. A document that is in the snapshot may still hold a strong reference to a newer document or asset, and the import has to replace it first, or Sanity would refuse the delete. `--exact` refuses to touch `production` unless you also pass `--i-understand-production`.
7. `--verify` exports the target and compares it with the snapshot. It exits non-zero on any difference and keeps the work directory. It checks:
   - every document, field by field, ignoring `_rev`, `_updatedAt` and `_createdAt`; it prints how many `_createdAt` values differ
   - every asset: it must exist under the snapshot's id or sha1, and its restorable fields must match (the fields listed in step 5 are left out)
   - extra documents, which fail only with `--exact`

### Step by step

1. Get read access to the bucket as an owner: `gcloud auth application-default login`. The CI service account can only be used from GitHub Actions.
2. Load the tokens: `cd scripts/backup && npm ci && set -a; . ~/cjoshmartin-migration/secrets.env; set +a`. The restore needs `SANITY_WRITE_TOKEN` (Editor).
3. Find the snapshot: `gcloud storage ls gs://cjoshmartin-sanity-backups/markers/`. The last name is the newest.
4. Optional: build only, and inspect the tarball:
   `node restore.mjs --latest --from-dataset production --source gcs --bucket cjoshmartin-sanity-backups --build-only --output /tmp/restore.tar.gz`
5. Rehearse into `staging` first:
   `node restore.mjs --latest --from-dataset production --source gcs --bucket cjoshmartin-sanity-backups --dataset staging --exact --verify`
   Importing triggers Sanity webhooks and deployed Functions in the target dataset, just like an edit. Check the Functions logs afterwards. The video conversion Function should convert nothing: every restored video block already plays the MP4 its `conversion` record names (see [Videos](#videos)).
6. Restore production when needed. Add `--exact --i-understand-production` only if documents created after the snapshot must go:
   `node restore.mjs --snapshot <ts> --source gcs --bucket cjoshmartin-sanity-backups --dataset production --replace --verify`
7. Videos need no extra step. A single file can be fetched by hand with `gcloud storage cp gs://cjoshmartin-sanity-backups/assets/files/<sha1>.<ext> .`, where `<sha1>` and `<ext>` come from the asset id `file-<sha1>-<ext>`.

## Morning setup (one time, plan §13 "Morning" step 4)

1. `! gcloud auth login` as an owner of `com-cjoshmartin`. Check with `gcloud config set project com-cjoshmartin`.
2. Review: `scripts/backup/setup-gcp.sh --print-only`. It runs nothing and prints a runnable script. The current output, with the moved repository's name, is in `docs/sanity-migration/reports/wp5-backups.md`, section "WP D: Mux removed from the backups, repository name fixed".
3. Run it: `scripts/backup/setup-gcp.sh`. It:
   - enables the IAM, IAM Credentials, STS, and Storage APIs
   - creates or updates `gs://cjoshmartin-sanity-backups`: us-central1, Standard, uniform bucket-level access, public access prevention enforced
   - creates the service account `sanity-backup`
   - grants it `roles/storage.objectCreator` and `roles/storage.objectViewer` on the bucket, then verifies that it holds exactly those two roles
   - creates the Workload Identity pool `github-actions` and the OIDC provider `cjoshmartin-frontend`, which admits only `assertion.repository == 'cjoshmartin/cjoshmartin-frontend' && assertion.repository_id == '737918690' && assertion.ref == 'refs/heads/main'` (the numeric repository id stops a re-created repository with the same name from getting in)
   - binds `roles/iam.workloadIdentityUser` for `principalSet://…/attribute.repository/cjoshmartin/cjoshmartin-frontend`

   The repository moved from the `cjoshmartin-com` organization to the `cjoshmartin` user account. `cjoshmartin-com/cjoshmartin-frontend` only redirects now, and GitHub's OIDC token carries the canonical name, so the script uses `cjoshmartin/cjoshmartin-frontend` (owner type User, repository id `737918690`, unchanged by the move).

   Running it again changes nothing. A provider that already exists gets its mapping and condition re-applied. A soft-deleted pool or provider is undeleted.
4. Run the `gh variable set` and `gh secret set` commands the script prints, all with `--repo cjoshmartin/cjoshmartin-frontend`. The variables are `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_BACKUP_SERVICE_ACCOUNT`, `BACKUP_BUCKET`, and `SANITY_PROJECT_ID`. The only secret is `SANITY_BACKUP_TOKEN` (the Viewer token); the backup needs no Mux token. The secret value is piped from `secrets.env` and never echoed.
5. After the PR is merged (scheduled and authenticated runs only work from `main`), run the manual tests H32–H36 in plan §12:
   - run the workflow
   - run it again and expect "No changes"
   - edit a document, run it again, and expect a new snapshot with no re-uploaded assets
   - restore into staging
   - check in the console that the bucket has no `allUsers` access

## The workflow and its keepalive

`.github/workflows/sanity-backup.yml` runs on `schedule: '0 9 * * 0'` and on `workflow_dispatch`, with a dataset choice (default `production`) and a `dry_run` flag. The `backup` job:

1. checks out the repository
2. sets up Node 24 with an npm cache keyed on this folder's lockfile
3. runs `npm ci` and `npm test`
4. exchanges the GitHub OIDC token for Google credentials with `google-github-actions/auth`
5. runs `backup.mjs`

Permissions are set per job: `backup` gets `contents: read` and `id-token: write`, and `keepalive` gets `actions: write`. A concurrency group stops two backups of the same dataset from running at once. Actions are pinned to commit SHAs (checkout v7.0.1, setup-node v7.1.0, auth v3.0.0).

**Keepalive.**

- **The rule.** GitHub disables scheduled workflows in a public repository after 60 days without repository activity. The workflow's own scheduled runs do not count, so a quiet repository would silently lose its backups.
- **What other tools do.** The old approach (keepalive-workflow v1 and similar actions) pushed an empty commit every ~45 days. That pollutes history, needs `contents: write`, and fights branch protection. The original `gautamkrishnar/keepalive-workflow` repository is now blocked by GitHub for a terms-of-service violation. Tools such as `liskin/gh-workflow-keepalive` instead call the REST endpoint `PUT /repos/{owner}/{repo}/actions/workflows/{workflow}/enable`. Enabling a workflow sets it active and restarts the inactivity window, with no commit.
- **What this workflow does.** The `keepalive` job makes that same API call with `gh api` and the built-in `GITHUB_TOKEN` (`actions: write`), so there is no third-party action. It runs after every backup, even a failed one (`if: always()`). Weekly runs re-enable the workflow every 7 days, far inside the 60-day window. A broken backup keeps its schedule and keeps sending failure emails instead of going quiet.

## Costs

- **Google Cloud Storage.** The Free Tier gives 5 GB-months of regional storage in us-central1, us-east1, or us-west1, plus 5,000 Class A and 50,000 Class B operations and 100 GB of egress from North America per month (Google's Free Tier page, checked 2026-11-26).
  - Expected storage is about 140 MB of images and files, plus the videos: the 29 kept originals are 274 MB (655 s of video in total), and their MP4 conversions come on top. Even at an average of 8 Mbit/s, which is high for CRF 23, the MP4s would add about 655 MB. Add roughly 20 KB–1 MB per changed week. That stays well under the 4 GiB alarm, which itself sits under the 5 GB free tier.
  - Each run makes about 2–3 list calls (Class A) and a few reads (Class B). A changed week adds 3 writes plus one write per new asset.
  - New buckets keep deleted objects for 7 days (soft delete). This tool never deletes, so that costs nothing.
- **Workload Identity Federation and the service account:** no charge.
- **GitHub Actions:** free for public repositories on standard GitHub-hosted runners. A run takes about 1–2 minutes. The first run, which stores every asset and video file, takes a few minutes more.
- **Sanity:**
  - Each run makes one Export API request (a few MB at most).
  - CDN downloads only happen for assets not yet in the bucket, mostly on the first run, which downloads every video file once (about 1 GB at most, see above).
  - Both are negligible against the Free plan's 100 GB/month bandwidth.
