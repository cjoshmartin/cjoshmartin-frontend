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
snapshots/<ts>/manifest.json    fingerprint, counts per type, asset list, Mux list, warnings
assets/images/<sha1>.<ext>      each Sanity image, stored once
assets/files/<sha1>.<ext>       each Sanity file, stored once
assets/mux/<muxAssetId>.mp4     the original of each Mux video, stored once
markers/<ts>.json               written last; a snapshot without a marker is incomplete
archive/                        one-time decommission files (written by hand, not by this tool)
```

`<ts>` is a UTC timestamp in ISO 8601 basic format, for example `20261129T090000Z`. Names sort in time order, so the newest marker is the lexicographically last name.

### One run

1. **List the bucket.** If it already holds more than 4 GiB, fail before doing anything else.
2. **Export.** A single request to the Sanity Export API (`GET /v2025-02-19/data/export/<dataset>`) with a Viewer token. It returns every non-deleted document the token can read: published documents, drafts, release versions, asset documents (`sanity.imageAsset`, `sanity.fileAsset`), and system documents (`_.groups.*`, `_.retention.*`, `_.schemas.*`, `_.releases.*`). Sanity's docs say a stream that fails midway still returns HTTP 200 and ends with an `{"error": …}` line, so every line is checked. Stream mode gives a consistent point-in-time view.
3. **Fingerprint.** sha256 over the sorted lines `<_id>:<_rev>\n`, one per exported document. That is every document in the raw perspective. On 2026-11-26, `*[]._id` with `perspective=raw` and the export returned the same ID set on both datasets, system documents included. The fingerprint comes from the same export that becomes the snapshot, so the two can never disagree.
4. **Compare.** Find the newest marker for this project and dataset. If its fingerprint matches, log "No changes", write nothing, and exit 0. Markers for other datasets in the same bucket are skipped, so a staging test run can never hide a production change.
5. **Back up.** Every write is create-only (`ifGenerationMatch=0`). Nothing is ever overwritten or deleted, and the CI identity has no delete permission.
   - **Assets.** Each image or file whose `assets/...` object is missing is downloaded from the Sanity CDN and uploaded. Images use `?dlRaw=true` and the token, as `sanity datasets export` does. A download is accepted only if its sha1 equals the asset document's `sha1hash`, or if the CDN's `x-sanity-sha1` / `x-sanity-md5` headers vouch for it (Sanity rewrites some files after hashing, such as sanitized SVGs). A Content-Length mismatch also fails the run. If an asset binary is missing (HTTP 404), the run fails and names the asset, because a snapshot must be complete to be restorable. Fix it by re-uploading the asset in the Studio, or by deleting the asset document if nothing uses it.
   - **Mux originals.** For each `mux.videoAsset` document whose `assets/mux/<assetId>.mp4` is missing, see [Videos](#videos).
   - **Snapshot.** Then `data.ndjson.gz`, then `manifest.json`, then the marker last.
6. **Size check.** If the bucket now holds more than 4 GiB, the run fails *after* writing the marker. The snapshot is complete; the failure is the alert.

A run that dies midway leaves stored assets in place, because they are content-addressed. It writes no marker, so the next run retries and only uploads what is still missing. If a retried request finds that its own earlier attempt already wrote an object, the write is treated as done: identical bytes for snapshot files, the same size for content-addressed assets. Different content makes the run fail.

### What counts as a change

Any document, draft, release version, asset, or system document that is added, edited, or deleted changes some `_id:_rev` pair, so it triggers a snapshot. That includes a Studio schema deploy (`_.schemas.*`). Reordering does not trigger one: the fingerprint is order-independent.

### What a snapshot contains

`data.ndjson.gz` is the full raw export, documents only, drafts included. `sanity-plugin-mux-input` stores its Mux API token in a `secrets.mux` document once the token is entered in the Studio. If the backup token can read that document, the snapshot contains it too, and a restore brings it back. On 2026-11-26 neither dataset had that document yet, so whether a Viewer token can read it could not be checked. The bucket is private, and only the backup service account and project owners can read it. If the bucket is ever exposed, rotate the Mux token.

### Videos

Mux keeps a "master" for each asset, a file of the same quality as the original. Mux can no longer return the exact uploaded file. For every video not yet in the bucket, the backup does this:

1. `GET /video/v1/assets/{id}`. If the asset is still `preparing`, it polls every 5 s.
2. `PUT /video/v1/assets/{id}/master-access {"master_access": "temporary"}`.
3. It polls until `master.status` is `ready`. That wait is limited by `--mux-timeout-minutes`, default 20. Mux docs say masters are usually ready "very quickly".
4. It downloads `master.url`, an MP4 with the video and the primary audio track, at the asset's `max_resolution_tier`, and stores it at `assets/mux/<assetId>.mp4`.

Master access reverts to `none` by itself after 24 hours, so nothing has to be switched back off.

- **Cost check (Mux docs, 2026-11-26).** Mux's pricing pages list no charge for master access. The one documented side effect is that downloading a master moves an asset in infrequent or cold storage back to frequent storage and resets its cold-storage timer. That happens once per video, because each original is fetched only once.
- **Why not static renditions.** The alternative, static MP4 renditions, is a paid add-on billed for storage every month ($0.0006–$0.0024 per minute per month for basic quality), so it is not used.
- **When a video fails.** A video Mux reports as deleted (404) or errored has no original to fetch. The manifest records it as `unavailable`, the run prints a warning, the snapshot is still written, and the process exits with code 3. A non-zero exit fails the job, and GitHub emails the owner. A master that errors or times out fails the whole run with no marker, so the next run retries.

The 29 videos migrated from Wagtail also keep their true originals (`.mov`/`.MP4`/`.webm`) in the old `images-for-cms` bucket under `media/`. Plan D11 keeps that bucket, made private.

### Exit codes

- `0`: a snapshot was written, there were no changes, or it was a dry run.
- `1`: failure. Any marker written by the run is still valid (see the size check).
- `3`: a snapshot was written with warnings. The warnings are in the log, the GitHub job summary, and the manifest's `warnings`.

## Running it by hand

```sh
cd scripts/backup
npm ci
set -a; . ~/cjoshmartin-migration/secrets.env; set +a   # SANITY_PROJECT_ID, SANITY_READ_TOKEN, MUX_TOKEN_*

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
- the size limit and per-dataset markers
- Mux polling and timeouts
- the GCS adapter's create-only preconditions
- the restore NDJSON rewriting and tarball layout

They also include a contract test that feeds the restore tarball to `@sanity/import`, the library behind `sanity datasets import`, and checks that the backed-up documents come back unchanged.

## Restore

**A restore is not a point-in-time reset.** `sanity datasets import --replace` overwrites documents that share an id with the snapshot. Everything else stays:

- documents and assets created after the snapshot remain (use `--exact` to remove them)
- document history is not restored, and `_rev` and `_updatedAt` get new values
- Sanity-managed system documents (`_.groups.*` roles, `_.retention.*`, `_.schemas.*`) are not restored
- Studio, schema, CORS origins, tokens, webhooks, and Functions are not in the dataset at all
- release definitions (`_.releases.*`) and their versions are restored through Sanity's release import action
- Mux videos: the `mux.videoAsset` documents are restored as documents and point at the existing Mux assets (see step 6)

What `restore.mjs` does:

1. It picks the snapshot (`--snapshot <ts>`, or `--latest` with an optional `--from-dataset`). It only accepts snapshots that have a marker.
2. It checks integrity: the manifest's hash against the marker, `data.ndjson.gz`'s hash against the manifest, and the documents' fingerprint against the marker.
3. It builds a standard import tarball, the same layout `sanity datasets export` produces: `<dataset>-<ts>/data.ndjson`, `assets.json`, `images/`, `files/`.
   - Asset documents are left out. Every `{asset: {_ref: "image-…"}}` becomes `{_sanityAsset: "image@file://./images/<sha1>.<ext>"}`, and the binaries come from the bucket. The import uploads each binary (or reuses an identical one already in the target) and recreates the same content-addressed asset ids. `assets.json` restores asset metadata such as `originalFilename`. Every asset in the snapshot is included, referenced or not.
   - Sanity-managed system documents are left out. Release definitions are kept.
   - Everything else is kept as is, including drafts, release versions, and `mux.videoAsset` documents.
   - `--allow-assets-in-different-dataset` is passed only when the import file still holds asset documents of another type whose URL points at a different project or dataset. Image and file assets are never kept as documents, so with today's content it is never needed.
4. It runs `npx --yes sanity@latest datasets import <tarball> --project <id> --dataset <target> [--replace]` with `SANITY_AUTH_TOKEN` set to `SANITY_WRITE_TOKEN` (or uses your `sanity login` session when that variable is unset).
5. `--exact` (which implies `--replace`) then deletes target documents that are not in the snapshot: other documents first, then other assets. System documents are never deleted; a release that is not in the snapshot is reported so you can archive it in the Studio. The deletes run *after* the import rather than before. A document that is in the snapshot may still hold a strong reference to a newer document or asset, and the import has to replace it first, or Sanity would refuse the delete. `--exact` refuses to touch `production` unless you also pass `--i-understand-production`.
6. `--verify` exports the target and compares it with the snapshot: every document field by field (ignoring only `_rev` and `_updatedAt`), every asset by id or sha1, and extra documents (which fail only with `--exact`). It exits non-zero on any difference and keeps the work directory.

If `MUX_TOKEN_ID` / `MUX_TOKEN_SECRET` are set, it also checks that every Mux asset in the snapshot still exists in Mux.

### Step by step

1. Get read access to the bucket as an owner: `gcloud auth application-default login`. The CI service account can only be used from GitHub Actions.
2. Load the tokens: `cd scripts/backup && npm ci && set -a; . ~/cjoshmartin-migration/secrets.env; set +a`. The restore needs `SANITY_WRITE_TOKEN` (Editor).
3. Find the snapshot: `gcloud storage ls gs://cjoshmartin-sanity-backups/markers/`. The last name is the newest.
4. Optional: build only, and inspect the tarball:
   `node restore.mjs --latest --from-dataset production --source gcs --bucket cjoshmartin-sanity-backups --build-only --output /tmp/restore.tar.gz`
5. Rehearse into `staging` first:
   `node restore.mjs --latest --from-dataset production --source gcs --bucket cjoshmartin-sanity-backups --dataset staging --exact --verify`
   Importing triggers Sanity webhooks and deployed Functions in the target dataset, just like an edit. Check the Functions logs afterwards.
6. Restore production when needed. Add `--exact --i-understand-production` only if documents created after the snapshot must go:
   `node restore.mjs --snapshot <ts> --source gcs --bucket cjoshmartin-sanity-backups --dataset production --replace --verify`
7. Videos: if the Mux check reports a missing asset, download its original with `gcloud storage cp gs://cjoshmartin-sanity-backups/assets/mux/<assetId>.mp4 .` and create a new Mux asset from it (Studio upload, or the Mux API). Then patch the existing `mux.videoAsset` document's `assetId`, `playbackId`, `status` and `data` with the new asset's values. Documents keep referencing the same `mux-video-<id>` document, so nothing else changes.

## Morning setup (one time, plan §13 "Morning" step 4)

1. `! gcloud auth login` as an owner of `com-cjoshmartin`. Check with `gcloud config set project com-cjoshmartin`.
2. Review: `scripts/backup/setup-gcp.sh --print-only`. It runs nothing and prints a runnable script. The output from 2026-11-26 is in `docs/sanity-migration/reports/wp5-backups.md`.
3. Run it: `scripts/backup/setup-gcp.sh`. It:
   - enables the IAM, IAM Credentials, STS, and Storage APIs
   - creates or updates `gs://cjoshmartin-sanity-backups`: us-central1, Standard, uniform bucket-level access, public access prevention enforced
   - creates the service account `sanity-backup`
   - grants it `roles/storage.objectCreator` and `roles/storage.objectViewer` on the bucket, then verifies that it holds exactly those two roles
   - creates the Workload Identity pool `github-actions` and the OIDC provider `cjoshmartin-frontend`, which admits only `assertion.repository == 'cjoshmartin-com/cjoshmartin-frontend' && assertion.repository_id == '737918690' && assertion.ref == 'refs/heads/main'` (the numeric repository id stops a re-created repository with the same name from getting in)
   - binds `roles/iam.workloadIdentityUser` for `principalSet://…/attribute.repository/cjoshmartin-com/cjoshmartin-frontend`

   Running it again changes nothing. A provider that already exists gets its mapping and condition re-applied. A soft-deleted pool or provider is undeleted.
4. Run the `gh variable set` and `gh secret set` commands the script prints. The variables are `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_BACKUP_SERVICE_ACCOUNT`, `BACKUP_BUCKET`, and `SANITY_PROJECT_ID`. The secrets are `SANITY_BACKUP_TOKEN` (the Viewer token), `MUX_TOKEN_ID`, and `MUX_TOKEN_SECRET`. Secret values are piped from `secrets.env` and never echoed.
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
  - Expected storage is about 140 MB of images and files, plus the Mux masters (the Wagtail originals were 261 MB), plus roughly 20 KB–1 MB per changed week. That stays well under the 4 GiB alarm, which itself sits under the 5 GB free tier.
  - Each run makes about 2–3 list calls (Class A) and a few reads (Class B). A changed week adds 3 writes plus one write per new asset.
  - New buckets keep deleted objects for 7 days (soft delete). This tool never deletes, so that costs nothing.
- **Workload Identity Federation and the service account:** no charge.
- **GitHub Actions:** free for public repositories on standard GitHub-hosted runners. A run takes about 1–2 minutes.
- **Sanity:**
  - Each run makes one Export API request (a few MB at most).
  - CDN downloads only happen for assets not yet in the bucket, mostly on the first run.
  - Both are negligible against the Free plan's 100 GB/month bandwidth.
- **Mux:**
  - Master access has no listed charge. Each video's master is downloaded once, about 11 minutes of video in total.
  - The only cost effect is that a video in cold storage returns to frequent storage until its cold-storage timer runs again. For basic quality at 1080p, that is a difference of $0.0018 per minute per month, so at most a few cents once.
