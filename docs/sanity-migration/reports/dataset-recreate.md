# Work package RECREATE: recreate staging and production from verified clean exports

Date: 2026-11-26, 20:03 to 20:35 UTC. Branch `sanity-migration`, starting at `fffb772`. Commits:
`925277d` (tooling) and the commit of this report. Nothing was pushed.

## Status: blocked at step 3. No dataset was changed.

- **Staging, steps 1 and 2: done, all checks pass.** Validation passes 13 of 13. The snapshot,
  the History API baseline and the export are taken. The export holds exactly the snapshot, and
  every exported file passes both privacy scans.
- **Step 3 (keep the Functions from acting on the import): blocked.** The permission system
  denied the deploy that removes the four Functions (command in
  [Blocked step](#blocked-step)). Every later step depends on it, so nothing was deleted.
- **Not started, because they depend on step 3:**
  - staging steps 4 to 6 (delete, create, import, restore, schema, validate, compare, history
    check, Functions back);
  - every production step. The brief starts production only after staging fully passes.
- **Unchanged:**
  - Both datasets: public, 96 documents, 173 assets and 12 system documents each.
  - The Blueprint Stack `ST-jc4gwa3c4t`: the same four Functions, and its last operation is still
    `OP-8zw5cnw4xr` (18:19 UTC), checked after the denial.
- **Step 7 (CDN probe and support email): done.** The email is drafted and not sent. It is kept
  outside the repository because it lists the full paths.
- **Tooling committed** for the rest of the run: `npm run recreate` and
  `scripts/recreate-dataset.sh` in `migration/wagtail-to-sanity`.

## Why this is still needed (measured on staging)

The staging History API baseline was taken at 20:11 to 20:14 UTC.

- **Deleted ids probed: 356.** That is every asset id named in any local migration file that is not
  in staging (316), plus 40 other document ids from local logs.
  - 346 of them still have transactions in the History API.
  - **344 can be read without a token** (1,572 of 2,298 anonymous probes returned the document).
    Only published, root-path ids are readable. The deleted drafts and the `secrets.` test document
    returned nothing.
- **All 13 deleted ids whose files held a location are readable anonymously.**
- **Current documents:** 4,136 transactions, the first at 2026-11-25T18:30:20Z.
- **Retention:** the dataset's own `_.retention._maximum_project` document says 90 days, so the
  history does not expire soon. Sanity's history page says 3 days for the Free plan; the dataset's
  setting is what applies here.

The production baseline was not taken (see [Status](#status-blocked-at-step-3-no-dataset-was-changed)).

## Step 1: pre-check (staging)

**Validation.** `npm run migrate -- --dataset staging --steps validate`, 20:03:32 to 20:05:35 UTC:
**13 of 13 pass**, with the same figures as the privacy review round 2. That includes `privacy`:
173 assets downloaded and scanned, 0 with personal metadata, 99/99 copies marked, and 0 documents
naming a missing asset.

**Snapshot.** `npm run recreate -- snapshot` at 20:11:22 UTC. It holds every document in the raw
perspective with every field (local file, mode 600). 281 documents:

| Type | Published | Drafts |
|---|---|---|
| `blogPost` | 7 | 16 |
| `flexPage` | 2 | 0 |
| `homePage` | 1 | 0 |
| `medium` | 8 | 0 |
| `person` | 1 | 0 |
| `project` | 13 | 3 |
| `redirect` | 3 | 1 |
| `service` | 5 | 0 |
| `technology` | 27 | 0 |
| `testimonial` | 9 | 0 |
| `sanity.imageAsset` | 110 | 0 |
| `sanity.fileAsset` | 63 | 0 |
| System (`_.groups.*` 10, `_.retention._maximum_project`, `_.schemas.staging`) | 12 | |

- **No release versions.**
- **Assets:** 173 sha1s (110 images, 63 files). The sorted list is in the snapshot. Its digest
  (sha256 of the list, first 16 hex digits) is `9492abf148024d53`.
- **Asset document fields:** every asset has `_createdAt`, `assetId`, `extension`, `mimeType`,
  `originalFilename`, `path`, `sha1hash`, `size`, `source`, `title`, `uploadId` and `url`.
  - Images also have `metadata` (110).
  - The stripped copies also have `privacy` (99: 70 `image-strip-v1`, 29 `video-strip-v2`).
  - The MP4s also have `videoToMp4SettingsVersion` (29).
  - No asset has `description`, `altText` or `creditLine`.
  - `source.name`: 144 `wagtail`, 29 `video-to-mp4`.

## Step 2: export and verification (staging)

**Export.** `npx sanity@latest datasets export staging
~/cjoshmartin-migration/dataset-exports/staging-20261126T201131Z.tar.gz` (CLI 6.25.0,
`@sanity/export` 7.1.1), 20:11:31 to 20:12:22 UTC:

- 96 documents and 173 assets;
- 472,728,590 bytes, sha256 `0590c3bf…`, mode 600.

A copy was unpacked into its own new directory.

**`npm run recreate -- verify-export`** (20:13 UTC): **PASS.**

| Check | Result |
|---|---|
| Documents (asset references written back from the export's `_sanityAsset` pointers) | 96/96 equal to the snapshot, `_rev` and every system field included; 0 missing, 0 extra |
| Asset files | 173/173 present, with the asset document's sha1 and size; 0 extra files |
| `assets.json` (the asset fields the import restores) | 173/173 equal to the snapshot, apart from the fields the export leaves out (`_id`, `_type`, `assetId`, `extension`, `mimeType`, `path`, `uploadId`, `url`) |
| Privacy scan of the `privacy` step (`scanLocalFile`). Images: exiftool `-ee` with rules v2, plus the image stripper's analysis. Videos: `checkStrippedIsobmff` from `studio/functions/privacy`, which needs no non-zero `mdat` byte outside the samples the sample tables reference and no location or device signature outside the samples. MP4s: the converter's box rule | 173 files, 0 with findings, 0 unreadable |
| Positive control: the same scan on 3 local originals that hold a location | 81, 43 and 49 findings, among them 19, 7 and 7 location tags |
| Documents and asset documents naming an asset that is not in the export | 0 |
| Asset documents with `metadata.location`, personal `metadata.exif` or `privacy.strippedFrom` | 0 |
| System documents in the export | 0 (the export leaves them out; see finding 3) |

**Independent scan** (local script that reuses recheck 3's scanner) of the 173 exported files:

- **0 location fingerprints.** The fingerprints come from the 11 local originals that held a
  location: 5 ISO 6709 strings, 12 EXIF GPS rationals and 105 decimal texts.
- **0 tags** in the location, identifier or people categories, apart from the two PDFs'
  `PDF:Creator`. That tag is the printing browser, a known item (privacy review R2-7).
- **Device tags:** only `ItemList:Encoder`, ffmpeg's name, in the 29 MP4s.
- **Capture times:** only the two PDFs' dates.
- **Byte signatures:** only `Exif` headers in 4 files. These are the known orientation-only EXIF
  blocks.
- **The 58 ISO BMFF files:** 0 non-zero bytes in `mdat` outside the packets ffprobe lists. One
  stripped original has 85,868 such bytes, all zero.
- Recheck 3 reported 1,118 non-zero bytes in 2 of these files with the same function. A rerun on
  recheck 3's own copies (the same sha1s) gives 0 today. The sample-table check above, which the
  brief names, gives 0 as well.

## Step 3: keep the Functions from acting on the import (blocked)

**Why it matters.** A Function would act on the import in these ways:

- The import uploads each file first. The asset document exists without `source` and `privacy`
  until a second patch sets them, and its `_createdAt` is the import time. So `upload-privacy`
  matches every upload.
- Documents are created without their asset references and get them in later patches. So
  `testimonial-ascii-art` would clear the art and generate it again.

**Docs.** Sanity's Functions cheat sheet ("Keep functions from running during an import or sync")
lists three ways:

1. Scope the Function to another dataset. Not possible: both datasets are recreated.
2. Remove the Function and redeploy, then add it back after the import.
3. Return early when an environment variable is set. This needs a code change, and every event
   still runs the Function.

The brief prescribes way 2.

**What was prepared** (local, `~/cjoshmartin-migration/dataset-exports/blueprint/`):

- `sanity.blueprint.ts.HEAD` and `HEAD.txt`: the exact configuration, at `fffb772`. The Function
  code is unchanged since the deployed `745ecdb`, apart from a test script.
- `info-before.json`: the Stack, every Function's parameters, and resource ids
  `RS-FN-zpuefja8iy:gv5rhm2y83`, `:8sdu2lwprh`, `:gpy8exxsc8` and `:h8bnem9p8d`.
- The environment variable names: `PRIVACY_LINK_KEY` on `video-to-mp4`, `image-privacy` and
  `upload-privacy`; none on `testimonial-ascii-art`. Removing a Function drops its variables, so
  the key must be set again from `secrets.env` after the redeploy.
- `off/blueprint.json`: a blueprint with no resources.
  - `blueprints plan` from that directory: "4 destroy".
  - `blueprints plan` from `studio/` with the arm64 variables: "4 update", so the redeploy path
    works.

The deploy of `off/` was denied. Nothing was deleted, as the brief requires.

## Step 7: CDN probe and support email

**Probe.** `node migration/verify/src/deleted-asset-cdn-probe.mjs --rounds 2`, 20:18:51 to 20:25:59
UTC, over:

- 632 deleted paths: 316 per dataset, every asset id in the local files that the dataset does not
  have now;
- 26 of them held a location.

| Result | staging | production |
|---|---|---|
| Deleted paths probed | 316 | 316 |
| Answered 200 at least once | 81 (20 files, 61 images) | 87 (29 files, 58 images) |
| Of the 26 that held a location | 0 | 0 |
| Of the round-2 purge list (307 real deletions) | 62 (4 files, 58 images) | 61 (3 files, 58 images) |

- **The still-served files were downloaded and scanned** (158 answered 200 on that fetch, 10 had
  gone 404):
  - 0 location fingerprints and 0 location tags.
  - `file-1df2945a` (a MOV, in both datasets) still has the Keys `Make`, `Model`, `Software` and
    `CreationDate`. This is the known "one video holds device data".
  - `file-7b6075d0` and `file-a96d1cca` (MP4s) have capture dates.
- **Expiry.** The largest cache age seen was 55,851 s. With `s-maxage=2592000` (30 days), the
  cached copies expire by 2026-12-26 at the latest. The last deletions were on 2026-11-26.
- **Email (not sent):** `~/cjoshmartin-migration/dataset-exports/cdn/sanity-support-cdn-purge-email.md`
  (mode 600). It is a short request to purge the listed paths, with their `?dl=` and rendition
  variants. It lists the full URLs in three groups:
  1. the 26 that held a location;
  2. the 168 still served;
  3. the 438 others.

  It also asks whether deleting a dataset purges its CDN paths, and whether a public dataset's
  History API can require a token.

## Findings

| # | Severity | Finding | What to do |
|---|---|---|---|
| 1 | medium | **Asset `_createdAt` cannot be kept.** The asset service creates each asset document at the upload, and a patch that sets `_createdAt` is accepted and ignored (WP8 review, note 9). After a recreate, all 173 assets get the import time, which is after the Functions' `UPLOADED_SINCE` (2026-11-26T00:00:00Z). `upload-privacy` still ignores them, provided `source` is restored: all are `wagtail` or `video-to-mp4`, including the 20 unused ones. **But 40 images have no `privacy` field, and 36 of them are used by documents.** On the next edit of such a document, `image-privacy` would treat them as never checked. It would download each one and, by the same rules v2, expected to find nothing, mark it `clean`. | Owner's call: accept (one check per image, which adds `privacy: clean`), or let `image-privacy` skip `source.name == "wagtail"` first (a Function change outside this package). Content documents keep `_createdAt`: the import creates them with it. |
| 2 | low | **The export writes MP4s as `<sha1>-mp4.bin`**, because `@sanity/export` takes only letters as an extension. It also leaves `mimeType` out of `assets.json`. The import names each upload by `originalFilename`, so the asset ids should come out the same, but `mimeType` may not. | `restore-assets` refuses while any identity field (`_id`, `extension`, `assetId`, `path`, `url`, `sha1hash`, `size`) differs, and it patches `mimeType` and every other field back. The first import shows whether it is needed. |
| 3 | info | **System documents are not exported.** These are 10 `_.groups.*`, `_.retention._maximum_project` (90 days) and `_.schemas.staging`. The new dataset makes its own groups and retention document, and the schema deploy writes `_.schemas.<dataset>`. | `compare` checks all 12 against the snapshot, including the public group's grant (`_id in path("*")`, read, everyone). |
| 4 | info | Recheck 3's ffprobe-based coverage reported 1,118 non-zero bytes in 2 files. Today the same function on the same bytes reports 0. | None. The sample-table check (the Functions' own) reports 0 on both. |

## Tooling (committed)

- **`migration/wagtail-to-sanity/src/recreate.ts`** (`npm run recreate -- <command>`) and
  `src/recreate-lib.ts`. Commands:
  - `snapshot`, `history-baseline` and `verify-export`, used above;
  - `restore-assets`, which patches each asset back field by field. It is revision-checked, never
    patches identity fields, and reads everything back afterwards;
  - `compare`, which ignores `_rev`, `_createdAt`, `_updatedAt` and an asset's `uploadId`;
  - `history-check`: deleted ids must have no transaction and no anonymous read at any time or
    revision the baseline saw. Current documents must have no transaction before the import and no
    anonymous read before it.
- **`migration/wagtail-to-sanity/scripts/recreate-dataset.sh <ds> <export> [--confirm-production]`**:
  - refuses while the Stack has any Function (checked read-only: it counts 4 now);
  - checks that the dataset exists and is public;
  - deletes it, waits until it is no longer listed, and creates it again as public (retrying while
    the name is briefly unavailable);
  - imports, and prints the import start time.

  Delete, create and import run in one invocation, so a later denied command cannot leave the
  dataset deleted. `shellcheck` is clean.
- **Tests:** `test/recreate.test.ts` (5) covers the export's file names, including `.bin`, asset
  pointers, writing references back, counts and field comparison. The package's `npm test` passes
  99 of 99, and `npm run typecheck` is clean.
- Local helper scripts (not committed) are in `~/cjoshmartin-migration/dataset-exports/scripts/`:
  the id collector, the independent export scan, and the served-file download and scan.

## Blocked step

| Step | Command | Why |
|---|---|---|
| 3: remove the four Functions before the deletes | `cd ~/cjoshmartin-migration/dataset-exports/blueprint/off && npx sanity@latest blueprints deploy --project-id j3vdh6ti --stack ST-jc4gwa3c4t -m "dataset-recreate: remove the four Functions while staging and production are recreated"` (`blueprint.json` with `"resources": []`) | Denied by the Claude Code permission classifier ("Destructive or Unwanted Actions"). Every later step depends on it, so steps 4 to 6 on staging and all production steps were not run. |

## To finish (in order, once step 3 is allowed)

1. **Staging export.** Take a new staging `snapshot`. If it equals the 20:11 snapshot exactly
   (`_rev` included), reuse `staging-20261126T201131Z.tar.gz`. Otherwise export again and rerun
   `verify-export` and the independent scan.
2. **Functions off.** Run the blocked command. `blueprints info` must then list 0 resources.
3. **Recreate staging.**
   1. `scripts/recreate-dataset.sh staging <export>`. It is also destructive, so it needs your
      permission.
   2. `npm run recreate -- restore-assets --dataset staging --snapshot <file>`.
   3. From `studio/`: `npx sanity@latest schemas deploy --workspace staging`.
   4. `npm run migrate -- --dataset staging --steps validate`, which must pass 13 of 13.
   5. `npm run recreate -- compare`.
   6. `npm run recreate -- history-check --import-start <time printed by the script>`.
4. **Production:** the same steps, with `--confirm-production`. Take the snapshot, the
   `history-baseline` and the export immediately before.
5. **Functions back.** From `studio/`:
   1. `npm_config_platform=linux npm_config_arch=arm64 npx sanity@latest blueprints deploy --project-id j3vdh6ti --stack ST-jc4gwa3c4t`.
   2. Set the key on the three Functions straight away:
      `npx sanity@latest functions env add <name> PRIVACY_LINK_KEY "$PRIVACY_LINK_KEY" --stack ST-jc4gwa3c4t`
      for `video-to-mp4`, `image-privacy` and `upload-privacy`, after
      `set -a; . ~/cjoshmartin-migration/secrets.env; set +a`.
   3. `blueprints info`: 4 Functions.
   4. `npx sanity@latest functions logs <name> --stack ST-jc4gwa3c4t -u` for each: no runs
      between the deploy and now.
6. **Decide on finding 1** before the next edit in the Studio.
7. **Send the support email** whenever you like. The CDN copies expire by 2026-12-26 either way.

## Local files (not committed)

All in `~/cjoshmartin-migration/dataset-exports/` (mode 700):

| File | What |
|---|---|
| `staging-20261126T201119Z-precheck.json` | The snapshot: every document and field, and the counts |
| `staging-history-baseline.json` | Transactions and anonymous reads of every current and deleted id |
| `staging-20261126T201131Z.tar.gz` | The verified export |
| `unpacked/` | The unpacked copy |
| `staging-20261126T201131Z-verify.json` | Result of `verify-export` |
| `staging-20261126T201131Z-scan.json` | Result of the independent scan |
| `ids/local-ids.json` | 625 ids from local files (489 asset ids), with their sources |
| `cdn/` | The probe, the still-served files and their scan, and the email draft |
| `blueprint/` | The saved Stack configuration and the empty blueprint |
| `logs/` | Every run |

---

## Fix round 1 (2026-11-26, about 21:50 to 22:40 UTC)

This round fixes the five findings of [recreate-verification.md](recreate-verification.md), which
checked the recreate the main session ran after this report was written (staging import from
20:40:54 UTC, production from 21:00:07 UTC). The sections above still describe the plan, not that
run.

- **Code:** commit `ed8a6bc`.
- **Functions:** redeployed as operation `OP-8uruppvaci` (22:23:41 to 22:24:37 UTC), built with
  `npm_config_platform=linux npm_config_arch=arm64`, with 4 updates and nothing destroyed.
  `PRIVACY_LINK_KEY` is still set on `video-to-mp4`, `image-privacy` and `upload-privacy`, and the
  deployed value equals the one in `secrets.env` (see finding 4).
- **Data:** a `privacy` mark was added to 40 image assets in each dataset (finding 2). The staging
  test data of this round was deleted.
- **Not changed:** no dataset was deleted or created, and no Function was removed. Nothing was
  pushed.

| # | Severity | Finding | Verdict | Fix |
|---|---|---|---|---|
| 1 | medium | A location an API client requests stays readable without a token in the History API | Confirmed again, with harmless data | Prevented in the repository and made visible in the Function logs. The History API side is the owner's call. |
| 2 | medium | 40 images per dataset have no privacy mark; 25 documents match image-privacy's filter | Confirmed | Fixed: all 40 checked with the Functions' stripper and marked `clean` in both datasets. Every Function filter now matches 0 documents. |
| 3 | low | `history-check` reports FAIL because of the system documents the dataset creation writes | Confirmed | Fixed at the cause, the time the script printed. Both datasets now PASS. |
| 4 | low | upload-privacy stripped two referenced uploads itself | Confirmed, cause narrowed | Fixed: a reference seen during the wait is final. Deployed and tested live. |
| 5 | low | Deleted uploads' asset documents stay readable without a token in the History API | Confirmed as described | Not a defect in the code. Same owner decision as finding 1. |

### Finding 1: a location requested by an API client stays in the History API

**Confirmed again, without putting any location into history.**

- **The test** (staging, 22:26:43 UTC): a synthetic 32×32 JPEG whose only EXIF tags are
  `Orientation` and `Software` (a synthetic string with the test's nonce) was uploaded through the
  HTTP API with `meta=image`.
- **What upload-privacy did:** it removed `metadata.image` from the asset document 0.28 s later.
- **What the History API still serves:** without a token, it returns the first revision (HTTP
  200) with `metadata.image.Software`. The three later revisions are returned without it, and the
  deleted state returns nothing.

**What the docs say** (Sanity docs, read 2026-11-26):

- "Image metadata": `location`, `exif` and `image` are excluded by default. Sanity extracts them
  only when an upload asks for them.
- "History experience": retention depends on the plan (Free 3 days, Growth 90, Enterprise 365).
  The datasets' own `_.retention._maximum_project` says 90 days.
- Document-level access control (custom roles and content resources) is an Enterprise feature.
  Nothing documented makes a public dataset's History API require a token.

**Why it cannot be found later:** the History API's transaction log needs document ids. A request
for the whole dataset's transactions returns nothing (checked). So such a revision cannot be
found later by a scan. Only upload-privacy sees it happen, because it runs on every upload the
Studio and the Functions did not make.

**Changes:**

- **`studio/test/upload-metadata.test.ts`** (new) checks three things:
  - every image field of the Studio schema extracts exactly `IMAGE_METADATA_OPTIONS`;
  - no source file in the repository asks for `location`, `exif` or `image` (the HTTP API's
    `meta=`, @sanity/client's `extract`, a schema's `metadata`);
  - every @sanity/client upload that can be an image names its `extract` list.

  A positive control, a temporary file with `extract: ['lqip', 'location']`, `?meta=exif` and an
  image upload without `extract`, failed both source checks. It was then removed.
- **What the test found:** `studio/functions/testimonial-ascii-art/scripts/compare-with-python.ts`
  uploaded Wagtail originals as images without `extract`. Sanity's default leaves location out, but
  the script now names `IMAGE_METADATA_OPTIONS`.
- **upload-privacy now warns.** When it removes extracted location, EXIF or camera data, it also
  logs a WARN (`console.warn`). The warning says that the first revision keeps the data in the
  History API for the retention period, and that only deleting and creating the dataset again
  removes it. The warning names key names only, never values. Live: the WARN line was logged 0.6 s
  after the test upload.

**Still open (owner):**

- Any client with a write token can still ask for `meta=location`. Two things would close it:
  - make the datasets private, with a read token in the frontend. That changes Vercel's
    environment, which is outside this package;
  - Sanity's answer to the drafted support email, which asks whether a public dataset's History
    API can require a token.
- Until then, check `npx sanity@latest functions logs upload-privacy` for `WARN` lines.

**What stays in staging's History API:**

- **T4's first revision** (the verification's synthetic fake coordinates, serial number and owner)
  stays until the retention ends: 90 days after 21:38:38 UTC, so about 2027-02-24. It names no real
  place or person.
- **This round's warning test** added a first revision with only the synthetic `Software` string.

### Finding 2: images without a privacy mark

**Confirmed.** Each dataset had the same 40 images without `privacy`:

- all have `source.name` `wagtail`;
- 18 JPEG, 12 PNG, 6 GIF, 3 WebP and 1 AVIF;
- 36 of them are used by documents.

image-privacy's filter matched 25 documents in each dataset.

**What was done:** the "accept" option of finding 1 above, done now rather than at the next edit.
Each image was checked the way image-privacy checks it and marked the way it marks it. Why this
and not letting the Function skip `source.name == "wagtail"`:

- a mark makes each image's state explicit, and independent of `_createdAt`;
- the mark is the one the Function itself would have written;
- skipping by source would leave these images unmarked for good and add a rule to the filter.

**The tool:** `npm run recreate -- mark-unchecked-images --dataset <ds> --out <file> [--dry-run]
[--confirm-production]` (in `migration/wagtail-to-sanity`). For each image without a mark it:

- downloads the stored bytes (`dlRaw` with the token) and checks their size and sha1;
- runs the Functions' stripper (`stripImage`) and the privacy step's exiftool scan;
- marks the image only when neither finds anything personal, with a revision-checked patch.

The mark comes from `cleanPrivacy` in `studio/functions/image-privacy/orchestrator.ts`. The
Function now uses the same helper, so the marks are identical. The tool then reads every mark back
and counts the documents that `IMAGE_PRIVACY_FILTER` matches.

| Run (UTC) | Unmarked before | Clean | Not marked | Unmarked after | Filter matches |
|---|---|---|---|---|---|
| staging, dry run, 22:14 | 40 | 40 (2 with technical metadata only) | 0 | 40 | 25 |
| staging, 22:15 | 40 | 40 marked | 0 | 0 | 25 → **0** |
| production, 22:15 to 22:16 | 40 | 40 marked, the same ids and messages as staging | 0 | 0 | 25 → **0** |

**About the marks:**

- The 2 "technical metadata only" messages read "EXIF (technical tags only); Apple's decoding hint
  (iDOT)".
- Patches to asset documents start no Function. The filters watch content documents, and
  upload-privacy watches only asset creates.

**Checks afterwards:**

- **Function filters, both datasets:** `testimonial-ascii-art` 0, `image-privacy` 0, `video-to-mp4`
  0, upload-privacy's sweep 0, images without `privacy` 0.
- **Validation, 13 of 13:** production 22:18 to 22:20 (`privacy`: 173 assets, 0 with personal
  metadata, 99/99 copies marked), staging 22:29 to 22:31.
- `npm run recreate -- compare` against the pre-recreate snapshots would now differ by these 40
  `privacy` fields. That is expected.
- The `UPLOADED_SINCE` comment in `image-privacy/trigger.ts` now says that the date no longer
  separates the migration's images from new ones, and that the marks do.

### Finding 3: `history-check` reported FAIL on clean datasets

**Confirmed.** `datasets create` writes the 10 `_.groups.*` documents and
`_.retention._maximum_project` (staging 20:40:52.689, production 21:00:05.337 UTC). The script took
the import start after the create.

**Fix at the cause:**

- **`scripts/recreate-dataset.sh`** now takes `created_after` after the delete and before
  `datasets create`, prints it, and its last line names `history-check --created-after <time>`.
- **`history-check`** takes `--created-after`. It refuses `--import-start` with an explanation. It
  also refuses a time that is not after every transaction in the pre-delete baseline, so a time
  that is too early cannot let old history pass, and a time that is not ISO UTC
  (`checkCreatedAfter` in `recreate-lib.ts`, with a unit test).
- The check itself was not loosened for system documents.

**Rerun** with the times the script printed between the delete and the create ("staging deleted"
20:40:45, "production deleted" 20:59:58 UTC):

| | staging (22:12 to 22:23) | production (22:23 to 22:29) |
|---|---|---|
| Deleted ids / with transactions | 356 / 0 | 356 / 0 |
| Anonymous probes of deleted ids / with content | 2,654 / 0 | 1,764 / 0 |
| Current documents | 295 (281 + this round's 14 scratch documents, present then) | 283 |
| Transactions before the creation | **0** | **0** |
| Earliest transaction | 20:40:52.689 | 21:00:05.337 |
| Anonymous probes of current documents / with content | 8,567 / 0 | 4,123 / 0 |
| **Result** | **PASS** | **PASS** |

### Finding 4: upload-privacy stripped two referenced uploads itself

**Evidence.** The times are from the History API's transactions. Function console lines are
logged about 1 s after the transactions they report.

- **T1, image A:** uploaded 21:32:17.382. The draft referenced it at 17.922 (+0.54 s), and
  upload-privacy took the lease at 18.792 (+1.41 s). Run `cad94aec` was the first upload-privacy
  run after the 21:07 redeploy, so its container was cold.
- **T1, image B:** uploaded 24.177. The draft referenced it at 24.760 (+0.58 s), and the lease
  came at 25.703 (+1.53 s). Run `d62869be` started while A's run was still going, so most likely
  in another new container.
- **What the old code allowed.** The wait could end on its first pass only if `getDocument`
  returned null or the reference query found the draft. `handleUpload` then queried the
  references again, and handled the upload as unused only if that second query found none. Both
  leases came before any 5 s poll. So in both runs the first pass ended the wait, and the second
  query did not see the draft.

**Reproduced on staging** (synthetic 64×64 PNGs; testimonial drafts, and one blog post draft,
written as the live test wrote them):

| Run | Code | Rounds | Draft after the upload | upload-privacy |
|---|---|---|---|---|
| 22:00 and 22:02, warm | old | 7 | 0.33 to 1.0 s | all polled once and found the reference ("used by a document", 5.2 to 5.3 s) |
| 22:22, after 19 min idle, 2 rounds 7 s apart (like T1) | old | 2 | 0.33 to 0.35 s | round 1: its first pass came after the draft, found the reference, and the run ended in 0.3 s with "used by a document". The second query agreed this time. Round 2: normal. |
| 22:25, the new version's first runs, 2 rounds 7 s apart, PNGs with a `tIME` chunk | new | 2 | 0.35 to 0.4 s | round 1: "wait ended after 0.1 s: used by 1 document(s)"; round 2: "wait ended after 5.1 s: a Function took the upload". Both were left to image-privacy, which stripped `tIME`, moved the reference and deleted the upload. |

**Cause.** After a cold start, the first check comes after the draft. The old wait stopped at a
reference seen once, and then let a second query decide. In T1 that second query missed a draft
written about 0.9 s earlier, most likely because the query index lagged. The draft was written
with `visibility=sync`.

A missing asset (`getDocument` null) would also have ended the old wait early. The warm runs, which
check earliest, never showed it, but the fix covers it too. The second query missing the draft did
not happen again in this round's 11 runs with a draft. The new log line names it if it does.

**Fix** (`upload-privacy/orchestrator.ts`, `waitForUse`):

- A reference seen during the wait is final: the upload is left to the content Functions without
  `handleUpload`. One more query is only recorded, and logged when it finds none ("the query index
  lagged").
- An upload that is not readable yet is waited for, and its extracted metadata is removed once it
  is readable.
- An upload is handled as unused only when nothing used it for the whole grace period.
- Every run logs how the wait ended.

**Tests:** 3 new. The first two reproduce the two possible causes. Run against the code at `HEAD`
before this round, all 3 fail. Run against the new code, all pass.

**Key check:** the two copies made at 22:25 carry HMAC-SHA256(key from `secrets.env`, upload id)
as `source.id` and `privacy.strippedFromDigest`. So the deployed `PRIVACY_LINK_KEY` is the same.

### Finding 5: deleted uploads stay readable in the History API

**Confirmed as described.** The warning test's deleted upload answered without a token at every
revision before the delete.

**Not a defect in the code.** For an upload the Functions delete, its history holds nothing the
dataset does not already serve publicly, apart from its own id (its sha1). That id's CDN path
answers 404, because the Functions read uploads privately.

- **Previews:** the previews (`lqip`, BlurHash, ThumbHash, `palette`) and the dimensions come from
  the pixels. The stripped copy keeps those pixels byte for byte and serves them publicly.
  upload-privacy keeps the copy of an unused upload too.
- **File name:** `originalFilename` is copied to the copy.
- **The frontend** uses none of the previews. It reads `originalFilename` for file downloads.

The history keeps more than the dataset only when someone deletes the copy too, for example to
withdraw an image: its name and previews stay for the retention period. The remedy is the same as
for finding 1.

### Staging test data of this round

- **Created:** 11 scratch drafts (`drafts.recreate-fix-…`, testimonials and one blog post) and 12
  synthetic uploads (random-pixel PNGs and the JPEG of the warning test). The Functions made 3
  copies and deleted 3 uploads.
- **Deleted:** at 22:28:58 UTC, the 11 drafts and the 12 remaining assets, each checked
  unreferenced first. No other asset had been created since 22:00. The deletions started 11
  upload-privacy runs, each with "nothing to do".
- **Afterwards:** staging has 110 images, 63 files and 0 scratch documents, and validation passes
  13 of 13.
- **Function logs since 22:00:**
  - upload-privacy: 23 runs, one `WARN` (the warning test's);
  - image-privacy: 11 runs; testimonial-ascii-art: 10 runs; video-to-mp4: none;
  - no `ERROR`.
- **History:** these documents' revisions stay in the History API for the retention period
  (finding 5). None holds a location.

### Blocked steps

None. One local scan command was refused by Claude Code's safety check because it combined a shell
indirection with `rm`. It was rewritten without either and run.

### Still open

1. **Finding 1 (owner):** decide whether to make the datasets private with a read token in the
   frontend, or wait for Sanity's answer. The support email still has to be sent.
2. **Docs written before the recreate:** the sections above, the privacy reports, the morning
   report and the plan still describe the plan, not the completed recreate.
3. **Local commits:** this round's 2 commits are ahead of `origin/sanity-migration`, like the
   main session's, and were not pushed.

### Local files (not committed)

`~/cjoshmartin-migration/recreate-fix/` (mode 700):

| Path | What |
|---|---|
| `scripts/` | the transaction timeline (`tx.mjs`), the visibility probe, the T1 repro, the key check, the cleanup |
| `data/` | the Function logs (JSON, millisecond times), the repro records, the mark results (they name the 40 image ids), the history-check results, the Blueprint info before and after |
| `logs/` | every run |
| `fixtures/` | the warning test's synthetic JPEG |
