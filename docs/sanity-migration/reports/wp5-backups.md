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
