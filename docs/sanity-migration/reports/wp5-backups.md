# WP5a: weekly Sanity backups (code and tests)

Status: **done** for code, tests and dry runs. The real GCS provisioning and the first real backup happen in the morning with Josh (plan §13). The end-to-end restore into `staging` is WP5b.

## What was built

| Path | What it is |
|---|---|
| `scripts/backup/package.json`, `package-lock.json` | Standalone Node ≥ 24 ESM package. Runtime dependencies: `@google-cloud/storage@8.4.0` and `modern-tar@0.8.6`, the tar library `@sanity/import` uses. Dev dependencies: `@sanity/import@7.1.1` (the version `@sanity/cli` 8.35 uses) and `@sanity/mutator@6.25.0`, both for the contract test only. |
| `scripts/backup/backup.mjs` | CLI: `--dataset`, `--target gcs\|local`, `--bucket`, `--local-dir`, `--dry-run`, plus `--project`, `--max-bucket-bytes`, `--concurrency`, `--mux-timeout-minutes`. |
| `scripts/backup/restore.mjs` | CLI: `--snapshot <ts>` or `--latest` (optionally with `--from-dataset`), `--dataset`, `--source gcs\|local`, `--replace`, `--exact`, `--i-understand-production`, `--verify`, `--build-only`, `--output`. |
| `scripts/backup/lib/fingerprint.mjs` | `computeFingerprint(docs)`: sha256 of the sorted `"<_id>:<_rev>\n"` lines. |
| `scripts/backup/lib/storage/{index,gcs,local,errors}.mjs` | One storage interface with two adapters. GCS uses Application Default Credentials and sends `ifGenerationMatch: 0` on every write. The local adapter writes create-only and atomically (temporary file plus `link(2)`). A 412 or `EEXIST` raises `ObjectExistsError`. There is no delete method. |
| `scripts/backup/lib/backup.mjs` | `runBackup(...)`, the plan §10 run logic, with dependencies injected so it can be tested. |
| `scripts/backup/lib/restore.mjs` | NDJSON rewriting, the import tarball, snapshot integrity checks, `--exact` planning, `--verify` comparison. |
| `scripts/backup/lib/sanity-export.mjs`, `sanity-assets.mjs`, `sanity-mutate.mjs`, `mux.mjs`, `http.mjs`, `layout.mjs`, `documents.mjs`, `util.mjs`, `cli.mjs` | Export API client, asset download and verification, deletes for `--exact`, Mux master-access archiver, fetch with retries, bucket layout, helpers. |
| `scripts/backup/test/*.test.mjs` | 53 unit tests (`npm test`), including a contract test against `@sanity/import`. |
| `scripts/backup/integration/gcs-emulator.test.mjs` | `npm run test:gcs-emulator`: the real `@google-cloud/storage` client against fake-gcs-server. Needs Docker. |
| `scripts/backup/setup-gcp.sh` | Idempotent provisioning with a `--print-only` mode. Its output is below. |
| `scripts/backup/README.md` | How it works, how to run it, how to restore step by step, the morning setup, costs. |
| `.github/workflows/sanity-backup.yml` | Weekly schedule plus manual runs, Workload Identity Federation, keepalive. |

Commits on `sanity-migration`:

- `9c014d6`: tooling and tests
- `a05eb1a`: workflow, setup script, README
- `10ad4a8`: GCS emulator test, Mux check made non-fatal
- the commit that adds this report

## How it implements plan §10

- **Bucket layout.** It follows the plan exactly:
  - `snapshots/<ts>/data.ndjson.gz`
  - `snapshots/<ts>/manifest.json`
  - `assets/images/<sha1>.<ext>`
  - `assets/files/<sha1>.<ext>`
  - `assets/mux/<muxAssetId>.mp4`
  - `markers/<ts>.json`, written last

  `<ts>` is ISO 8601 basic format, for example `20261129T090000Z`. It sorts by time and is safe in paths.
- **Fingerprint.** It is computed from the same Export API response that becomes the snapshot, so the fingerprint and the data can never describe different states. The Export API reference says the endpoint returns "all the non-deleted documents in a dataset, including drafts, release versions, and asset documents". With a token, system documents are included too. I checked on 2026-11-26 that `*[]._id` with `perspective=raw` and the export return identical ID sets on both datasets (staging 27/27, production 12/12).
- **No-change runs.** They write nothing and exit 0. The comparison uses the newest marker *for this project and dataset*, so a staging test run in the same bucket cannot mask a production change.
- **Changed runs.**
  1. Missing assets are downloaded and verified: sha1 against `sha1hash`, or the CDN's `x-sanity-sha1` / `x-sanity-md5` headers, plus Content-Length. Images are fetched with `dlRaw=true`, like `sanity datasets export`.
  2. Missing Mux originals are fetched.
  3. Then `data.ndjson.gz`, then `manifest.json`, then the marker.
- **Size limit.** The run fails if the bucket holds more than 4 GiB:
  - It checks first, before exporting. That check is read-only, so a no-change run against an over-limit bucket also fails rather than exiting 0, and the alert keeps firing.
  - It checks again after writing the marker. That snapshot is still complete.
- **Create-only writes.** Nothing is overwritten or deleted. If a retried request finds its own earlier write, the write counts as done: identical bytes for snapshot files, the same size for content-addressed assets. Anything else fails.
- **Mux originals.** These use *temporary master access* (`PUT /video/v1/assets/{id}/master-access`, poll until `master.status == ready`, download `master.url`). Waits are bounded: 5 s polling, 20 min per video by default, 30 min per download.
  - **Cost.** Checked in Mux's docs on 2026-11-26. Mux's pricing pages list no charge for master access. Its only documented side effect is that an asset in infrequent or cold storage moves back to frequent storage and its cold-storage timer resets, which happens once per video because each original is fetched once.
  - **Alternative.** Static renditions are "a paid add-on feature" billed for storage monthly, so the plan's fallback path is not needed and was not built.
  - **No reset.** Master access "will revert to none" after 24 hours (Mux API reference), so the tool does not reset it.
  - **Failures.** A Mux asset that is deleted (404) or errored, or a document without an `assetId`, is recorded as `unavailable` in the manifest. The snapshot is still written, and the process exits with code 3 so the job fails and emails the owner. A master that errors or times out fails the run, so the next run retries.
- **Restore.** It rebuilds a standard import tarball and runs `npx --yes sanity@latest datasets import … --replace`. See "Deviations" for `--exact` and `--allow-assets-in-different-dataset`. The README documents that a restore is not a point-in-time reset.

## Deviations from the brief, and why

1. **`--exact` deletes after the import, not before.** The brief says "first deletes". A document that is in the snapshot can hold a *strong* reference to a newer document or asset. Sanity refuses to delete the target of a strong reference until the referring document is replaced. So `--exact` does this:
   1. it imports with `--replace`
   2. it deletes target documents that are not in the snapshot: other documents first, then assets
   3. `--verify` can then confirm the result

   `_.` system documents are never deleted. A release missing from the snapshot is reported so it can be archived in the Studio. The production guard (`--i-understand-production`) is checked before anything else runs.
2. **`--allow-assets-in-different-dataset` is never needed with today's content.** The restore drops `sanity.imageAsset` / `sanity.fileAsset` documents and recreates them from the binaries through `_sanityAsset` directives, the same way `sanity datasets export` does. `@sanity/import` only checks project and dataset on asset *documents* that are present in the file. The flag is passed automatically only if the file still contains some other `sanity.*Asset` type pointing at another project or dataset.
3. **A missing asset binary (CDN 404) fails the backup.** The official exporter warns and skips such assets. A snapshot with a missing binary cannot be restored without `--allow-failing-assets`, so the run fails, names the asset, and says how to fix it. Assets already uploaded stay, and the next run resumes.
4. **Workflow permissions are set per job.** The brief lists `id-token: write`, `contents: read`, `actions: write`. Instead:
   - the workflow default is `permissions: {}`
   - the `backup` job gets `contents: read` and `id-token: write`
   - the `keepalive` job gets `actions: write`

   That is the same set, but no step holds a permission it does not use.
5. **The dataset input is a `choice` (`production` | `staging`), default `production`.** Every input goes into scripts through environment variables, never by inline expansion.
6. **The provider's attribute condition also checks `assertion.repository_id == '737918690'`.** This is on top of the required `repository == 'cjoshmartin-com/cjoshmartin-frontend'` and `ref == 'refs/heads/main'`. It only narrows access. A repository deleted and re-created under the same name cannot authenticate, which is google-github-actions/auth's own security advice.
7. **The keepalive is a separate job, not a step in the backup job.** It contains the one step and runs with `if: always()`, so a failed backup still keeps its schedule.

## Keepalive research and choice

- **The rule.** GitHub's docs: "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days." Scheduled runs themselves do not count as activity.
- **Approach 1: dummy commits.** keepalive-workflow v1, and `entepotenz/keep-github-actions-alive-min-dependencies` still today, push an empty commit when the repository nears 60 days. Downsides:
  - it needs `contents: write`
  - it adds noise commits to `main`
  - it fights branch protection
- **Third-party risk.** The original `gautamkrishnar/keepalive-workflow` repository now returns "Repository access blocked" (reason: `tos`, since 2025-04-21). Depending on such actions is a supply-chain and availability risk.
- **Approach 2: re-enable through the API.** `liskin/gh-workflow-keepalive`, and keepalive-workflow v2's "API mode", call `PUT /repos/{owner}/{repo}/actions/workflows/{workflow}/enable`. That sets the workflow active and restarts its inactivity window, with no commit. GitHub does not document this reset explicitly. These tools, and `PhrozenByte/gh-workflow-immortality`, rely on it, and they recommend running it well inside the 60 days.
- **Chosen.** Approach 2, done inline with `gh api --method PUT "repos/$REPOSITORY/actions/workflows/sanity-backup.yml/enable"` and the built-in `GITHUB_TOKEN` (`actions: write`). There is no third-party action. It runs every week (every 7 days, far inside 60) and after failed runs too.

## Action versions (checked against the releases on 2026-11-26)

- `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1`, which is v7.0.1, the latest
- `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1`, which is v7.1.0, the latest; it runs on `node24`
- `google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093`, which is v3.0.0, the latest; it runs on `node24`

All three are pinned to commit SHAs, with the tag in a comment. `actions/checkout` uses `persist-credentials: false`.

## Verification

| Check | Result |
|---|---|
| `npm test` on Node 26.4.0 (local) | 53/53 pass |
| `npm test` on Node 24.22.3 (`npx node@24`, the CI version) | 53/53 pass |
| Required tests | Fingerprint order independence (shuffles and reverse, plus edits, adds, deletes, drafts, versions, system and asset documents). No-change run writes nothing (no create calls, no downloads, same listing). Changed run writes data → manifest → marker last, with no asset re-uploads. Asset dedupe (only the new asset uploaded; two documents with the same content stored once). Restore NDJSON rewriting (images, file annotations, hotspot/crop kept, Mux references untouched, drafts and versions rewritten). |
| Other tests | Dry run writes nothing and only *inspects* Mux. Per-dataset markers. Size limit before and after the run. Missing Mux credentials. A failed asset leaves no marker, and the next run resumes. Clock going backwards. Marker without its snapshot. Create-only helpers. GCS adapter preconditions and 412 mapping. Export stream error, cursor and bad lines. Retry policy (and no URL in errors). Asset verification by sha1hash, CDN header, Content-Length and 404. Mux polling, timeout, errored and deleted assets. Tarball layout and `assets.json`. Tampered data rejected. `--latest` / `--from-dataset` / `--snapshot`. `--exact` plan. `--verify`. CLI production guard. `--build-only` CLI. |
| Contract test with `@sanity/import` 7.1.1 | The restore tarball, imported by the real importer into an in-memory client that applies every mutation with `@sanity/mutator`, gives back every backed-up document unchanged apart from `_rev` and `_updatedAt`. Every asset is uploaded once with its `originalFilename`, asset metadata is restored, and the release goes through `sanity.action.release.import`. Breaking the directive path on purpose makes the test fail. |
| `npm run test:gcs-emulator` (fake-gcs-server 1.56.1, real `@google-cloud/storage` 8.4.0) | 2/2 pass. Create-only for simple and resumable (9 MiB) uploads → `ObjectExistsError`; list, stat, download; full backup → no-change → restore build on GCS. |
| Read-only run against the real **staging** dataset, local target | Snapshot `20261125T192909Z`: 27 documents (15 image assets, 12 system), 15 binaries downloaded from the CDN, all verified by `sha1hash`, 9.76 MiB. Second run: "No changes … nothing written". |
| Restore tarball vs the official `sanity datasets export staging` | `assets.json` identical (15/15 entries, field for field). All 15 binaries byte-identical. My file names inside the tarball are `<sha1>.<ext>`; the exporter's are `<sha1>-<WxH>.<ext>`. Both work, because the import reads whatever path the directives name. |
| Production dataset dry run | 12 system documents, 0 content (WP3 had not imported yet). It would write 3 objects. |
| ESLint (repo root config) on `scripts/backup` | clean, `--max-warnings=0` |
| actionlint 1.7.12 (with shellcheck) on the workflow | clean |
| shellcheck 0.11.0 on `setup-gcp.sh` | clean. It also passes `bash -n` under macOS's bash 3.2, and its argument quoting round-trips in a separate test. |
| `setup-gcp.sh --print-only` with `gcloud` removed from `PATH` | exits 0 and calls nothing. The generated script passes `bash -n`. |
| Mux token | `GET /video/v1/assets` → HTTP 200 (0 assets existed, so no real master download was possible yet). |

## `setup-gcp.sh --print-only` output (2026-11-26)

```bash
#!/usr/bin/env bash
# Generated by scripts/backup/setup-gcp.sh --print-only. A real run checks each
# resource first, skips what already exists, and updates settings that differ.
set -euo pipefail
PROJECT_NUMBER="$(gcloud projects describe com-cjoshmartin --format='value(projectNumber)')"

# APIs needed for Workload Identity Federation and Cloud Storage
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com storage.googleapis.com --project=com-cjoshmartin

# Bucket gs://cjoshmartin-sanity-backups
gcloud storage buckets create gs://cjoshmartin-sanity-backups --project=com-cjoshmartin --location=us-central1 --default-storage-class=STANDARD --uniform-bucket-level-access --public-access-prevention

# Service account sanity-backup@com-cjoshmartin.iam.gserviceaccount.com
gcloud iam service-accounts create sanity-backup --project=com-cjoshmartin '--display-name=Sanity backup (GitHub Actions)' '--description=Writes weekly Sanity backups to gs://cjoshmartin-sanity-backups. Create and read only; no delete.'

# Bucket roles for the service account: create and read objects, nothing else
gcloud storage buckets add-iam-policy-binding gs://cjoshmartin-sanity-backups --member=serviceAccount:sanity-backup@com-cjoshmartin.iam.gserviceaccount.com --role=roles/storage.objectCreator
gcloud storage buckets add-iam-policy-binding gs://cjoshmartin-sanity-backups --member=serviceAccount:sanity-backup@com-cjoshmartin.iam.gserviceaccount.com --role=roles/storage.objectViewer

# Workload Identity pool github-actions
gcloud iam workload-identity-pools create github-actions --project=com-cjoshmartin --location=global '--display-name=GitHub Actions'

# GitHub OIDC provider cjoshmartin-frontend: only cjoshmartin-com/cjoshmartin-frontend on refs/heads/main
gcloud iam workload-identity-pools providers create-oidc cjoshmartin-frontend --project=com-cjoshmartin --location=global --workload-identity-pool=github-actions '--display-name=cjoshmartin-frontend main' --issuer-uri=https://token.actions.githubusercontent.com --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref "--attribute-condition=assertion.repository == 'cjoshmartin-com/cjoshmartin-frontend' && assertion.repository_id == '737918690' && assertion.ref == 'refs/heads/main'"

# Let cjoshmartin-com/cjoshmartin-frontend impersonate the service account
gcloud iam service-accounts add-iam-policy-binding sanity-backup@com-cjoshmartin.iam.gserviceaccount.com --project=com-cjoshmartin --role=roles/iam.workloadIdentityUser "--member=principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-actions/attribute.repository/cjoshmartin-com/cjoshmartin-frontend"

# GitHub configuration. Variables are not secret. Secrets are read from secrets.env and piped on stdin, so they never appear in shell history or the process list.
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo cjoshmartin-com/cjoshmartin-frontend --body "projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-actions/providers/cjoshmartin-frontend"
gh variable set GCP_BACKUP_SERVICE_ACCOUNT --repo cjoshmartin-com/cjoshmartin-frontend --body sanity-backup@com-cjoshmartin.iam.gserviceaccount.com
gh variable set BACKUP_BUCKET --repo cjoshmartin-com/cjoshmartin-frontend --body cjoshmartin-sanity-backups
gh variable set SANITY_PROJECT_ID --repo cjoshmartin-com/cjoshmartin-frontend --body j3vdh6ti
(set -a; . ~/cjoshmartin-migration/secrets.env; set +a; printf %s "$SANITY_READ_TOKEN" | gh secret set SANITY_BACKUP_TOKEN --repo cjoshmartin-com/cjoshmartin-frontend)
(set -a; . ~/cjoshmartin-migration/secrets.env; set +a; printf %s "$MUX_TOKEN_ID" | gh secret set MUX_TOKEN_ID --repo cjoshmartin-com/cjoshmartin-frontend)
(set -a; . ~/cjoshmartin-migration/secrets.env; set +a; printf %s "$MUX_TOKEN_SECRET" | gh secret set MUX_TOKEN_SECRET --repo cjoshmartin-com/cjoshmartin-frontend)

# --print-only: nothing was run.
```

A real run first checks each resource.

- **Bucket.** An existing bucket must already be in us-central1 with the Standard storage class, or the script stops. If so, the script re-applies uniform bucket-level access and public access prevention.
- **Service account roles.** After granting them, the script verifies that the service account holds *exactly* objectCreator and objectViewer on the bucket, and fails otherwise.
- **Pool and provider.** A soft-deleted pool or provider is undeleted. An existing provider gets `update-oidc` with the same mapping and condition.

`setup-gcp.sh` was **not** run for real.

## Not done here (for WP5b and the morning)

- A real GCS run. The bucket does not exist until the morning; the GCS path was tested against fake-gcs-server and with a fake bucket.
- A real Mux master download. The Mux account had 0 assets. Mux's own guide shows `master_access: "temporary"` together with `video_quality: "basic"`, which matches the plugin's basic quality, but the first real fetch happens in WP5b or the first production run.
- A real `sanity datasets import`, `--exact` and `--verify` against `staging`. Two things in them are not verified yet:
  - whether the Mutate API accepts plain `delete` mutations for `versions.*` ids
  - whether imported documents keep `_createdAt`

  `--verify` reports any field differences by path.
- The `secrets.mux` document did not exist yet, so whether a Viewer token can read it (and therefore whether backups contain it) is unknown. The README covers both cases.

## Sources

- Sanity:
  - [Export API reference](https://www.sanity.io/docs/http-reference/export)
  - [Export a dataset](https://www.sanity.io/docs/content-lake/exporting-data)
  - [Import data](https://www.sanity.io/docs/content-lake/importing-data)
  - [Datasets CLI reference](https://www.sanity.io/docs/cli-reference/cli-datasets)
  - [CLI configuration (`SANITY_AUTH_TOKEN`)](https://www.sanity.io/docs/cli-reference/cli-config)
  - the source of `@sanity/export` 7.1.1 and `@sanity/import` 7.1.1
- Mux:
  - [Download for offline editing (master access)](https://www.mux.com/docs/guides/download-for-offline-editing)
  - [Update master access API](https://www.mux.com/docs/api-reference/video/assets/update-asset-master-access)
  - [Video pricing](https://www.mux.com/docs/pricing/video)
- GitHub:
  - [Disabling and enabling a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)
  - [liskin/gh-workflow-keepalive](https://github.com/liskin/gh-workflow-keepalive)
  - [google-github-actions/auth README](https://github.com/google-github-actions/auth)
- Google Cloud:
  - [Free Tier](https://docs.cloud.google.com/free/docs/free-cloud-features)
  - `@google-cloud/storage` 8.4.0 source (`ifGenerationMatch`, endpoint handling)

---

# WP5b: end-to-end tests against the real datasets

Status: **done**. The tests ran on 2026-11-25 from 22:28 to 22:50 UTC against project `j3vdh6ti` with the `local` storage target. Real GCS is set up in the morning. Production was only read; its fingerprint was `4c60ba14…` before, during and after every test. Staging was changed on purpose and ends as an exact copy of production.

Two restore bugs were found and fixed in `8df2641` (see [Bugs found and fixed](#bugs-found-and-fixed)). Every task passed after the fix.

## How it was checked

The checks do not trust the tool under test. Small scripts in `~/cjoshmartin-migration/backup-test/tools/` (outside git) re-implement each check on their own and import nothing from `scripts/backup`:

| Script | What it checks |
|---|---|
| `dataset-stats.mjs` | Exports a live dataset and counts its documents by kind and type. Cross-checks with GROQ `count(*)` and `*[]._id` in the raw perspective, and computes the fingerprint. |
| `verify-bucket.mjs` | For one snapshot, checks the hash chain marker → manifest → data. Then checks the manifest against the live counts and fingerprint, the sha1 and size of every stored asset against its asset document, and each Mux original with `ffprobe`: the video stream, and that its duration is within 1 s of the document's. |
| `compare-datasets.mjs` | Compares two live datasets document by document. It ignores `_rev`, `_updatedAt` and `_createdAt`. For assets it also ignores `uploadId`, and it normalizes the dataset name in `url` and `path`. |
| `verify-dataset-assets.mjs` | Downloads every asset from the target dataset's CDN and compares its bytes with the backup copy. Also checks that every asset reference resolves. |
| `tree-snapshot.mjs` | Records every file in a backup directory: size, mtime, inode and sha256. Diffing two records shows exactly what a run wrote. |
| `snapshot-diff.mjs` | Lists which document ids were added, removed or changed between two snapshots, with the changed field paths (not their values), and what each manifest says was stored. |
| `staging-change.mjs`, `release-test.mjs` | Make the deliberate staging changes. Both are hard-wired to `staging`. |

All logs and JSON evidence are in `~/cjoshmartin-migration/reports/wp5b/`. A scan of the logs, the evidence, `scripts/backup` and this folder found none of the four secret values.

## 1. Production backup

`node backup.mjs --dataset production --target local --local-dir ~/cjoshmartin-migration/backup-test/production`: exit 0 in 3 min 36 s. It wrote snapshot **`20261125T222817Z`**, 230.76 MiB in 128 objects.

| | Manifest | Live export | GROQ, raw perspective |
|---|---|---|---|
| Documents | 233 | 233 | `count(*)` = 233, same id set |
| Published / drafts / versions / system | 202 / 19 / 0 / 12 | 202 / 19 / 0 / 12 | |
| Per type | blogPost 23, flexPage 2, homePage 1, medium 8, mux.videoAsset 10, person 1, project 16, redirect 4, service 5, technology 27, testimonial 9, sanity.imageAsset 110, sanity.fileAsset 5, system.group 10, system.retention 1, system.schema 1 | identical | identical |
| Fingerprint | `4c60ba14b10e8030…` | identical | |
| Assets | 115 (110 images, 5 files), 124,486,220 bytes, all 115 verified by `sha1hash` | 115 asset documents | |
| Mux originals | 10 of 10 stored, 117,256,047 bytes (111.82 MiB), 0 warnings | 10 `mux.videoAsset` documents, 10 distinct asset ids | |

`verify-bucket.mjs` passed. The hash chain is intact, and every stored asset has its document's sha1 and size. All 10 Mux files are MP4s that `ffprobe` reads, each with a video stream (8 H.264, 2 HEVC; up to 1440×1920) and an AAC audio stream. Their durations are within 0.06 s of the documents' (287 s in total). Every manifest item records `1080p` / `basic`.

## 2. Immediate re-run

The second run logged `No changes since snapshot 20261125T222817Z; nothing written` and exited 0. All 128 files had the same size, mtime, inode and sha256 before and after the run. No `.partial-*` files and no `sanity-backup-*` temp directories were left behind. A third run, just before the final restore, gave the same result.

## 3. Restore into staging

`node restore.mjs --latest --from-dataset production --source local --local-dir …/production --dataset staging --exact --verify`

- **First attempt, with the WP5a code: failed.** The import itself worked: 106 documents, 115 assets, references strengthened. But `--verify` reported 106 differences, all at `_createdAt`. The independent comparison showed what the tool's check had missed: 15 image assets in staging still had a `metadata.thumbHash` that production does not have. Both are fixed in `8df2641`.
- **Second attempt, with the fix: passed.**
  - The tool patched `metadata` on those 15 assets.
  - `--exact` found nothing to delete.
  - `--verify` reported 0 missing, 0 changed, 0 missing assets and 0 extra, and noted that 106 documents kept staging's own `_createdAt`.
- **Independent checks.**
  - `compare-datasets.mjs production staging`: 221 of 221 non-system documents identical, including 115 assets and 10 `mux.videoAsset`, with no missing or extra documents. The only system-document difference is `_.schemas.production` vs `_.schemas.staging`, which are managed by Sanity and never imported.
  - `verify-dataset-assets.mjs staging`: all 115 binaries served by the staging CDN are byte-identical to the backup copies. All 95 distinct asset references resolve, and there are no extra assets.
  - `npx sanity@latest documents validate --workspace staging --dataset staging --level info` (run from `studio/`): 0 errors and 48 warnings on 12 documents. 46 are the known "unknown field" warnings on `mux.videoAsset.data`, and 2 are `seo.description` length warnings on blog posts. Production gives exactly the same markers.
- **Mux check:** the restore confirmed that all 10 Mux assets still exist in Mux.

## 4. Staging change test

Backups of `staging` went to a separate directory, `~/cjoshmartin-migration/backup-test/staging-changes`, and the directory tree was recorded before and after each run.

| Run | Before it | Result | Written to the directory |
|---|---|---|---|
| S1 | staging = production | snapshot `20261125T223843Z` | 128 objects: 115 assets, 10 Mux originals, 3 snapshot files |
| S2 | nothing | "No changes", exit 0 | nothing; all 128 files unchanged |
| S3 | **change A:** edited one field (`intro`) of `blogPost-13` | snapshot `20261125T223956Z` | exactly 3 objects (data, manifest, marker), 217.95 KiB. Manifest: 0 assets and 0 Mux originals stored this run. Snapshot diff: only `blogPost-13` at `intro`. |
| S4 | **change B:** uploaded a new 320×200 PNG and set it as `blogPost-13.contentImage`; created `technology-wp5b-backup-test`; deleted the draft-only `drafts.project-9` | snapshot `20261125T224025Z` | exactly 4 objects: the new image (`assets/images/6d4df83d….png`, 9.10 KiB) and 3 snapshot files. Counts went from 233 to 234 documents (204 published, 18 drafts), and assets from 115 to 116. |
| S5 | nothing | "No changes", exit 0 | nothing |
| S6 | created release `rWp5bBackupTest` with a version of `blogPost-13` (and two restores, see below) | snapshot `20261125T224444Z` | exactly 3 snapshot files. Counts: 1 release version, 13 system documents. |

`verify-bucket.mjs` passed for S4. The Mux originals that the staging S1 run downloaded again are byte-identical to the production run's, so Mux masters are deterministic.

**Restores from the staging backups.**

- **Point in time:** `--snapshot 20261125T223956Z --exact --verify` (that is S3, before change B). It passed and did the following:
  - `--exact` deleted the extra document and the new asset. The asset's CDN URL then returned 404.
  - The import re-created `drafts.project-9` with the snapshot's `_createdAt` (2026-11-25T20:14:10Z).
  - The change-A edit stayed, as it should for a snapshot taken after it.
- **Release round trip:**
  1. Restoring production over the dataset with `--exact` deleted `versions.rWp5bBackupTest.blogPost-13` with a plain Mutate API delete. It kept `_.releases.rWp5bBackupTest` and reported it.
  2. After the release was archived and deleted, restoring S6 re-created the release and its version, and `--verify` passed.
  3. Restoring production again removed the version. The release was archived and deleted again.

## 5. Final state of staging

The final run was `--latest --from-dataset production --exact --verify` (log `18-…`), then the test release was archived and deleted. Afterwards:

- **Comparison with production:** 221 of 221 non-system documents identical, with no missing or extra documents.
- **Counts:** 233 documents (202 published, 19 drafts, 0 versions, 12 system), the same counts per type as production, and no releases in either dataset.
- **Assets:** all 115 binaries are byte-identical to the backup, and all 95 references resolve.
- **Validation:** markers identical to production's (0 errors, 48 warnings).

The test document, the test asset and the release are gone. The ASCII-art Function changed nothing: all 9 testimonials are identical to production. Staging's `_createdAt` values are its own, from the WP3a import.

## 6. Tests

| Check | Result |
|---|---|
| `npm test`, Node 26.4.0 | 57/57 pass. 4 tests are new: `_createdAt` and asset-field verification, asset metadata patches, the Mutate API batches for deletes and patches, and `--replace` without a token. |
| `npm test`, Node 24.22.3 (`npx node@24`, the CI version) | 57/57 pass |
| `npm run test:gcs-emulator` (fake-gcs-server 1.56.1 on port 4453) | 2/2 pass |
| ESLint with the repo config (`--no-ignore`, because the root config now ignores `scripts/**`) on `scripts/backup` | clean, `--max-warnings=0` |

## Bugs found and fixed

Commit `8df2641`, in `scripts/backup`:

1. **The restore left the target's own asset metadata in place.**
   - **Cause.** `sanity datasets import` only applies `assets.json` to binaries it uploads (`@sanity/import` 7.1.1, `ensureAsset`). An asset with the same content that already exists in the target is reused as it is. On staging, that left 15 images with a `thumbHash` that production lacks. An edited `title`, `description`, `source` or `originalFilename` would have survived a restore the same way.
   - **Fix.** With `--replace` (and so with `--exact`), `restore.mjs` now exports the target after the import. For every reused asset whose restorable fields differ from the snapshot, it sets those fields to the snapshot's values and unsets the ones the snapshot doesn't have.
   - **Fields it never touches.** The fields the asset service derives: `_id`, `_type`, `_rev`, `_createdAt`, `_updatedAt`, `assetId`, `extension`, `mimeType`, `path`, `url`, `sha1hash`, `size`, `uploadId`. `@sanity/import` also refuses to replay `uploadId`.
   - **Verify.** `--verify` now compares asset documents on their restorable fields, not only by id and sha1.
   - **Code.** New exports: `planAssetMetadataPatches` and `restorableAssetFields` in `lib/restore.mjs`, and `patchDocuments` in `lib/sanity-mutate.mjs`.
2. **`--verify` failed on every document that already existed in the target.**
   - **Cause.** The import keeps the target's `_createdAt` for documents that already exist. Documents it creates get the snapshot's value, but a re-created release definition gets the time of the import. So a restore over existing data can never pass a check that includes `_createdAt`.
   - **Fix.** `--verify` now ignores `_createdAt`, the same way the brief's equality rule does, and prints how many values differ. `compareWithSnapshot` returns them as `createdAtDiffers`. The site never reads `_createdAt`.
3. **`--replace` now needs `SANITY_WRITE_TOKEN`**, like `--exact` and `--verify`, because the asset metadata step uses the API. Only a plain import into an empty dataset can still run on a `sanity login` session. The README and `--help` say so.

The README's restore section was updated, and it now notes that the first backup after a restore always writes a snapshot: every imported document gets a new `_rev`, though no asset is uploaded again.

## Open questions from WP5a, answered

- **Real Mux master download.** It works on this Mux plan. All 10 masters were stored in one run, with no warnings and no timeouts. That whole first run, with 115 assets and 10 masters, took 3 min 36 s; the time per video was not measured. Within 24 hours, a second run skips the PUT because master access is still `temporary`: the staging S1 log has no "Requesting temporary master access" lines. That run, which downloaded all 10 again, took 53 s in total.
- **Plain `delete` of `versions.*` ids.** The Mutate API accepts it. Tested for real in the release round trip.
- **`_createdAt` after an import.** Documents the import creates keep the snapshot's value. Documents that already exist keep the target's. A re-created release gets the time of the import.
- **Releases through the restore.** A release definition and its version are restored by `sanity datasets import`, and `--verify` compares the release document field by field.
- **`secrets.mux`.** It still does not exist in either dataset, as checked with the Editor token. This remains open until a Mux token is entered in the Studio.

## Notes for the morning

- In the real bucket, production and staging snapshots share `assets/` and `assets/mux/`, so a staging run never stores what a production run already has.
- The local test backups are 231 MB (`backup-test/production`) and 232 MB (`backup-test/staging-changes`), outside git. Both can be deleted once this report is reviewed. WP5a's `tmp/wp5-local-bucket` is still there.
- Manual test H34 ("edit a document, run it again, expect a new snapshot with no re-uploaded assets") matches S3 above. Expect exactly 3 new objects.

---

# WP D: Mux removed from the backups, repository name fixed

Status: **done**, 2026-11-26. This follows the owner's decision to drop Mux: every video is now stored in Sanity as file assets (video contract v2: a `video` block's `file` is the MP4 the site plays, `original` is the upload as it was, kept and never served). Nothing in the real backup bucket had to change, because the bucket does not exist yet: `gcloud storage buckets describe gs://cjoshmartin-sanity-backups` answered 404 on 2026-11-26, so no `assets/mux/` object was ever written to it.

## What changed

| Path | Change |
|---|---|
| `scripts/backup/lib/mux.mjs` | Deleted (the Mux master-access archiver). |
| `scripts/backup/lib/backup.mjs` | No Mux planning, downloads, manifest section or `muxArchiver` input. The warnings channel is gone too: its only source was a Mux original that could not be fetched. The log now reads `Assets: N in the dataset (V of them videos), …`. |
| `scripts/backup/lib/layout.mjs` | `MUX_PREFIX` and `muxAssetKey` removed; the layout comment says why plan §10's `assets/mux/` is gone. |
| `scripts/backup/lib/sanity-assets.mjs` | `isVideoAsset` (counts only). `downloadTimeoutMs(size)`: a download may take 5 minutes plus 1 s per 512 KiB, instead of a flat 5 minutes, because the Mux path had its own 30-minute limit and the large files now go through the normal asset path. File asset ids also accept an upper-case extension (see below). |
| `scripts/backup/lib/restore.mjs`, `lib/util.mjs` | The restore hashes each archived file by streaming it (`sha1OfFile`) instead of reading it into memory, so four large videos in parallel never have to fit in RAM. |
| `scripts/backup/backup.mjs` | No `--mux-timeout-minutes`, no `MUX_TOKEN_*`, no exit code 3. `--help` says where videos go. |
| `scripts/backup/restore.mjs` | No Mux existence check and no `MUX_TOKEN_*`. |
| `scripts/backup/package.json`, `package-lock.json` | Version 2.0.0, so `manifest.tool.version` tells Mux-free snapshots apart. |
| `scripts/backup/test/*`, `integration/gcs-emulator.test.mjs` | The fixture's `mux.videoAsset` document is replaced by a converted contract-v2 video block (an MP4 with `source: {name: "video-to-mp4", id: <original id>}` plus a `.mov` original), used by a post and its draft. Mux tests removed; video tests added (below). |
| `scripts/backup/setup-gcp.sh` | `GITHUB_REPO="cjoshmartin/cjoshmartin-frontend"`, which sets the provider condition and the `principalSet`. The `repository_id == '737918690'` check is unchanged. It prints only the `SANITY_BACKUP_TOKEN` secret command. |
| `scripts/backup/README.md` | Bucket layout, run steps, a new **Videos** section, exit codes, tests, restore steps (no Mux check; the video Function should convert nothing after a restore), morning setup (new repository name, one secret), costs (no Mux; video storage estimate). |
| `.github/workflows/sanity-backup.yml` | `MUX_TOKEN_ID` / `MUX_TOKEN_SECRET` removed from the backup step. The repository name never appeared in the workflow (it uses `github.repository`). |

### Decisions

- **Videos have no code path of their own.** Both the MP4 and the kept original are `sanity.fileAsset` documents. They are downloaded, verified by `sha1hash` and stored once at `assets/files/<sha1>.<ext>` like the STL and PDF files, and the restore re-uploads them through `_sanityAsset` directives. Their content-addressed ids come back unchanged, so `file`, `original`, `conversion.sourceAssetId` and `conversion.outputAssetId` still agree after a restore. `assets.json`, and with `--replace` the asset metadata patches, restore the MP4's `source`, which the converter uses to find an existing MP4 instead of converting again.
- **`MANIFEST_FORMAT_VERSION` stays 1.** The restore reads only the marker's `formatVersion`, `fingerprint`, `dataset`, `projectId`, `manifestSha256` and `dataSha256`, and the manifest's `data`. The removed fields (`manifest.mux`, `manifest.warnings`, `marker.warningCount`) were never read, so older snapshots, such as the WP5b test backups, still load and restore. Their `mux.videoAsset` documents come back as plain documents.
- **Upper-case file extensions.** The Wagtail originals include `.MOV` and `.MP4` names. Every file asset id in both datasets today is lower case, and `@sanity/asset-utils` only parses lower case, which suggests the asset service lowercases the extension. Sanity's docs do not say so, and no video had been uploaded yet to check. An id the parser rejected would fail every backup (`does not have a standard content-addressed id`) and leave restore references unrewritten. So file ids now accept either case, and the key and archive name keep the id's own spelling. Image ids stay lower case, because their extension comes from the detected format.
- **Exit code 3 is gone.** Its only trigger was an unavailable Mux original. Every remaining problem fails the run with exit 1.

### Repository name

`gh api repos/cjoshmartin/cjoshmartin-frontend` on 2026-11-26: `full_name` `cjoshmartin/cjoshmartin-frontend`, id `737918690`, owner `cjoshmartin` (type User), public, default branch `main`. `repos/cjoshmartin-com/cjoshmartin-frontend` redirects to the same repository. `gh secret list` and `gh variable list` on the repository are both empty, so there are no `MUX_*` Actions secrets to delete, and nothing else in GitHub was changed.

## `setup-gcp.sh --print-only` output (2026-11-26, after the move)

Run with `PATH=/usr/bin:/bin`, so `gcloud` was not reachable. It exited 0, and the generated script passes `bash -n` under macOS's bash 3.2.

```bash
#!/usr/bin/env bash
# Generated by scripts/backup/setup-gcp.sh --print-only. A real run checks each
# resource first, skips what already exists, and updates settings that differ.
set -euo pipefail
PROJECT_NUMBER="$(gcloud projects describe com-cjoshmartin --format='value(projectNumber)')"

# APIs needed for Workload Identity Federation and Cloud Storage
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com storage.googleapis.com --project=com-cjoshmartin

# Bucket gs://cjoshmartin-sanity-backups
gcloud storage buckets create gs://cjoshmartin-sanity-backups --project=com-cjoshmartin --location=us-central1 --default-storage-class=STANDARD --uniform-bucket-level-access --public-access-prevention

# Service account sanity-backup@com-cjoshmartin.iam.gserviceaccount.com
gcloud iam service-accounts create sanity-backup --project=com-cjoshmartin '--display-name=Sanity backup (GitHub Actions)' '--description=Writes weekly Sanity backups to gs://cjoshmartin-sanity-backups. Create and read only; no delete.'

# Bucket roles for the service account: create and read objects, nothing else
gcloud storage buckets add-iam-policy-binding gs://cjoshmartin-sanity-backups --member=serviceAccount:sanity-backup@com-cjoshmartin.iam.gserviceaccount.com --role=roles/storage.objectCreator
gcloud storage buckets add-iam-policy-binding gs://cjoshmartin-sanity-backups --member=serviceAccount:sanity-backup@com-cjoshmartin.iam.gserviceaccount.com --role=roles/storage.objectViewer

# Workload Identity pool github-actions
gcloud iam workload-identity-pools create github-actions --project=com-cjoshmartin --location=global '--display-name=GitHub Actions'

# GitHub OIDC provider cjoshmartin-frontend: only cjoshmartin/cjoshmartin-frontend on refs/heads/main
gcloud iam workload-identity-pools providers create-oidc cjoshmartin-frontend --project=com-cjoshmartin --location=global --workload-identity-pool=github-actions '--display-name=cjoshmartin-frontend main' --issuer-uri=https://token.actions.githubusercontent.com --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref "--attribute-condition=assertion.repository == 'cjoshmartin/cjoshmartin-frontend' && assertion.repository_id == '737918690' && assertion.ref == 'refs/heads/main'"

# Let cjoshmartin/cjoshmartin-frontend impersonate the service account
gcloud iam service-accounts add-iam-policy-binding sanity-backup@com-cjoshmartin.iam.gserviceaccount.com --project=com-cjoshmartin --role=roles/iam.workloadIdentityUser "--member=principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-actions/attribute.repository/cjoshmartin/cjoshmartin-frontend"

# GitHub configuration. Variables are not secret. Secrets are read from secrets.env and piped on stdin, so they never appear in shell history or the process list.
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo cjoshmartin/cjoshmartin-frontend --body "projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-actions/providers/cjoshmartin-frontend"
gh variable set GCP_BACKUP_SERVICE_ACCOUNT --repo cjoshmartin/cjoshmartin-frontend --body sanity-backup@com-cjoshmartin.iam.gserviceaccount.com
gh variable set BACKUP_BUCKET --repo cjoshmartin/cjoshmartin-frontend --body cjoshmartin-sanity-backups
gh variable set SANITY_PROJECT_ID --repo cjoshmartin/cjoshmartin-frontend --body j3vdh6ti
(set -a; . ~/cjoshmartin-migration/secrets.env; set +a; printf %s "$SANITY_READ_TOKEN" | gh secret set SANITY_BACKUP_TOKEN --repo cjoshmartin/cjoshmartin-frontend)

# --print-only: nothing was run.
```

Compared with the WP5a output above, only the repository name changed (provider condition, `principalSet`, every `--repo`), and the two `MUX_*` secret commands are gone. `setup-gcp.sh` was **not** run for real.

## Verification

| Check | Result |
|---|---|
| `npm test`, Node 26.4.0 | 57/57 pass (58 before: 6 Mux tests removed, 5 tests added) |
| `npm test`, Node 24.22.3 (`npx node@24`, the CI version) | 57/57 pass |
| `npm run test:gcs-emulator` (fake-gcs-server 1.56.1, real `@google-cloud/storage` 8.4.0) | 2/2 pass. The resumable-upload case now writes a 9 MiB `assets/files/<sha1>.mp4`. The end-to-end case checks the fixture's MP4 and original byte for byte in the emulated bucket and builds a restore archive with all 6 assets. The `MaxListenersExceededWarning` it prints comes from the storage client's resumable upload and is printed by the committed version of the test as well. |
| New tests | **Backup:** an MP4 and its original, referenced from a post and its draft, are each downloaded and stored once, byte-identical, and listed in the manifest with their `mimeType`; a later snapshot and another dataset's first snapshot in the same bucket store and download neither again. **Restore:** the archive holds both files once; both blocks point at them through directives; `conversion` is unchanged; `assets.json` carries the file names and the MP4's `source`. **Contract with `@sanity/import` 7.1.1:** each video file is uploaded once with its name; the MP4's `source` is restored; after the import every block's `conversion.outputAssetId` equals `file.asset._ref` and `conversion.sourceAssetId` equals `original.asset._ref`. **Other:** upper-case extension ids parse and rewrite consistently; video files download without `dlRaw` or a token; the download time limit grows with size. |
| Mutation check (scratch copy) | Dropping `source` from the restored asset metadata fails 3 tests, including both new video restore tests. Making video assets never count as already stored fails 4 tests, including the new video backup test. |
| Live dry run, Mux variables unset | `node backup.mjs --dataset staging\|production --target local --dry-run`: both exit 0. Each has 233 documents and 115 assets, `0 of them videos` (no video had been uploaded yet), and would write 118 objects. The local directory stayed empty. |
| ESLint, repo config (`--no-ignore`) on `scripts/backup` sources and tests | clean, `--max-warnings=0` |
| actionlint 1.7.12 (with shellcheck) on `.github/workflows/sanity-backup.yml` | clean |
| shellcheck 0.11.0 on `setup-gcp.sh` | clean (the secrets loop over one item became one `printf`, which keeps SC2043 away; the printed output is unchanged) |

## Not done here, and notes

- `docs/sanity-migration-plan.md` §2 and §10 still name `assets/mux/` and `cjoshmartin-com/cjoshmartin-frontend`, and the morning report's blocker 2 and steps 3, 4 and 6 still mention the old name and the Mux secrets. Those files belong to other packages. For the backups, blocker 2 is fixed by this change: run `scripts/backup/setup-gcp.sh` as it is now.
- The WP5b local test backups (`~/cjoshmartin-migration/backup-test/…`) contain `assets/mux/` and Mux masters. Nothing reads them, and they can still be deleted as the morning report says.
- `scripts/decommission/04-gcs-lockdown.sh` and `lib.sh` still require every video to be on Mux. That is another package's code.
- The first real backup of the converted videos will show the actual video storage. The README's estimate: 274 MB of originals (655 s of video), plus at most about 655 MB of MP4s at 8 Mbit/s. That stays far under the 4 GiB limit.
