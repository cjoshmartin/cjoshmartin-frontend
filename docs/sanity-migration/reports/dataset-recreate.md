# Work package RECREATE: recreate staging and production from verified clean exports

## Current status (2026-11-26, 23:45 UTC)

**Done: both datasets were deleted and created again from the verified exports, and two fix rounds
followed.** This report was first written at 20:35 UTC, while step 3 was blocked. The sections from
[Status when first written](#status-when-first-written-2035-utc-blocked-at-step-3) to
[Local files](#local-files-not-committed) are kept as that record: they describe the state and the
plan before the run, not the run.

- **The recreate** (the main session, along the steps of
  [To finish](#to-finish-in-order-once-step-3-is-allowed)):
  - the four Functions were removed first;
  - staging (import from 20:40:54 UTC) and production (import from 21:00:07 UTC) were deleted and
    created again as public datasets with `scripts/recreate-dataset.sh`, from the verified exports;
  - `restore-assets` had nothing to patch (0 of 173 assets in each dataset), the schemas were
    deployed again, and validation passed 13 of 13 on both;
  - `history-check`: 0 of the 356 deleted ids per dataset have a transaction, and 0 anonymous
    probes returned content. It reported FAIL only because of the system documents the creation
    writes; it passes since [fix round 1](#fix-round-1-2026-11-26-about-2150-to-2240-utc)
    (finding 3);
  - the Functions were deployed again (`OP-hm7sskpxmd`) and `PRIVACY_LINK_KEY` was set again.
- **[Fix round 1](#fix-round-1-2026-11-26-about-2150-to-2240-utc):** the 40 unmarked images
  were marked, `history-check` takes the time before the creation, upload-privacy keeps a reference
  it saw during its wait, and a guard test against uploads that ask for location.
- **[Fix round 2](#fix-round-2-2026-11-26-about-2310-to-2345-utc):** one checked helper for every
  upload that can be an image and a wider guard test, this status, and the corrected compare note.
  The History API finding was confirmed live again; a purge would remove such history, but needs a
  permission that no predefined role grants (403 for the migration's write token).
- **Open (owner):** data that an API client outside the repository asks Sanity to extract stays
  readable without a token in the History API (finding 1 of both fix rounds), and the support
  email is not sent. The CDN copies of deleted assets expire by 2026-12-26.
- **Not pushed:** `origin/sanity-migration` is at `b18c179`. The local commits after it (the
  privacy work, the recreate tooling and reports, both fix rounds: 16 before this round's report
  commit) fast-forward it.

## Status when first written (20:35 UTC): blocked at step 3

Date: 2026-11-26, 20:03 to 20:35 UTC. Branch `sanity-migration`, starting at `fffb772`. Commits:
`925277d` (tooling) and the commit of this report. Nothing was pushed.

At that time no dataset was changed:

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

The production baseline was not taken (see [Status when first written](#status-when-first-written-2035-utc-blocked-at-step-3)).

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
- `npm run recreate -- compare` against the pre-recreate snapshots now reports FAIL in both
  datasets, as expected, with two differences: these 40 `privacy` fields, and the `members` of the
  system documents `_.groups.sanity.editor` and `_.groups.write` (the four Function robots; see
  [fix round 2, finding 4](#finding-4-compare-differs-in-two-group-documents-too)). Corrected in
  fix round 2: this note named only the first.
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

---

## Fix round 2 (2026-11-26, about 23:10 to 23:45 UTC)

This round fixes the four findings of the recheck of fix round 1.

- **Code:** commit `68615f5`.
- **Functions:** deployed twice, built with `npm_config_platform=linux npm_config_arch=arm64`, 4
  updates and nothing destroyed each time:
  - `OP-my6te6d4ga` (23:26:37 to 23:27:21 UTC), from the working tree;
  - `OP-vzue263ewu` (23:32:41 to 23:33:31 UTC), from `68615f5`. The working tree of the first
    deploy differed from it only in a comment of `privacy/constants.ts` (see
    [Finding 2](#finding-2-the-guard-test-caught-only-literal-requests)).

  After each deploy, `functions env list` shows `PRIVACY_LINK_KEY` on `video-to-mp4`,
  `image-privacy` and `upload-privacy`, and no variable on `testimonial-ascii-art`. The deploys
  started no Function run.
- **Data:** only staging test data, all deleted again (see
  [Staging test data](#staging-test-data-of-round-2)). No dataset was deleted or created, no
  Function was removed, and the datasets stay public. Nothing was pushed.

| # | Severity | Finding | Verdict | Fix |
|---|---|---|---|---|
| 1 | medium | A location an API client requests stays readable without a token in the History API | Confirmed live again | Not fixable in the repository. The owner's options are narrowed: a purge would remove such history, but it needs the `editHistory` permission, which only an Enterprise custom role grants (403 for the migration's write token). |
| 2 | low | The guard test caught only literal requests for location, EXIF or camera data | Confirmed | Fixed: one checked upload helper for every upload that can be an image; the test checks it on the wire, fails on any `meta` parameter whatever its value, and states what it cannot see. |
| 3 | low | `dataset-recreate.md` opened with "Status: blocked at step 3. No dataset was changed." | Confirmed | Fixed: a current status at the top. Dated notes in the privacy reports, the morning report (new item 23) and the plan point here. |
| 4 | low | The report said compare differs only in the 40 privacy fields | Confirmed in both datasets | Fixed: the note names the group members too. |

### Finding 1: History API, checked again

**Confirmed again, 23:15 UTC on staging** (local script; it prints key names and statuses only):

| | T4's upload `image-30001f5f` | The warning test's upload `image-9fce4f63` |
|---|---|---|
| Transactions | 5, the last a delete | 5, the last a delete |
| First revision, without a token | 21:38:38.087: HTTP 200, `metadata` has `location` and `exif` | 22:26:43.715: HTTP 200, `metadata` has `image` |
| The 3 revisions after it, without a token | 200, without them | 200, without it |
| The deleted state | 200, no document | 200, no document |
| Transaction list without a token | 401 | 401 |
| CDN path of the upload | 404 | 404 |

So a reader needs the id, the sha1 of the original bytes, as the recheck said. T4's data is
synthetic (fake coordinates and serial number); the warning test's `image` holds only a synthetic
`Software` string. Both stay for the retention period (90 days, the datasets'
`_.retention._maximum_project`), until about 2027-02-24.

**A remedy that exists, and why it is not available here.** Sanity's docs ("Purge document history
when you delete", Mutation and Actions API references) describe `delete` with `purge: true`, which
removes every transaction of the document from the History API at once. Purging needs the
`editHistory` permission. No predefined role grants it, Administrator included; only a custom role
made with the Access API does, and custom roles are an Enterprise feature. Checked on staging:

- a scratch document `recreate-fix-r2-purge-probe` (a note only) was created at 23:16:08 UTC;
- a dry run of `delete` with `purge: true` answered **403**: `Insufficient permissions; permission
  "editHistory" required`;
- the document was then deleted without purge.

A dry-run purge of T4's already deleted id answered 200 with no result: a delete of a missing
document checks nothing, so that says nothing about the permission. Purge was not tried on any real
document.

With `editHistory`, the Functions could delete the uploads they replace with `purge`. They replace
and delete an upload whose bytes hold location or camera data, so the revision with the extracted
data would go with it. That is a design option, not tested.

**Not changed:** the datasets stay public, the retention is not changed, nothing was purged.

**Still the owner's call**, in the order of what it closes:

1. Private datasets, with a read token in the frontend. This closes the History API to anonymous
   readers. It changes Vercel's environment.
2. An Enterprise custom role with `editHistory` for the Functions' robot, and `purge` on their
   deletes of uploads. This closes it for uploads the Functions delete.
3. Sanity's answer to the support email. The draft asks whether a public dataset's History API can
   require a token.

Until then, nothing in the repository asks for location, EXIF or camera data (finding 2 below), and
upload-privacy logs a WARN, with key names only, when any client does.

### Finding 2: the guard test caught only literal requests

**Confirmed.** The recheck's four forms (`extract: LIST`, `new URLSearchParams({meta: 'exif'})`,
`client.request({query: {meta: ['location']}})` and Python `params={"meta": "location"}`) were not
caught. The literal forms were.

**Fix at the cause: one helper, checked where it runs, and a scan that does not depend on values.**

- **`studio/functions/privacy/upload.ts`, `uploadAsset(client, kind, body, options)`.** It is
  structurally typed, so it works with every package's @sanity/client.
  - `extract` takes only `IMAGE_METADATA_OPTIONS` values, in TypeScript and at run time.
  - At run time it also refuses, before any request: any other value (`location`, `exif`, `image`,
    `none`, wrong case), `extract` on a file upload, a non-list, and any option it does not list
    (for example `meta` or `query`).
  - An image upload without `extract` asks for `IMAGE_METADATA_OPTIONS` explicitly.
- **Every upload that can be an image now goes through it:**
  - the image-privacy Function's copy upload (`image-privacy/sanity.ts`);
  - `testimonial-ascii-art/scripts/compare-with-python.ts`;
  - the migration's `assets` step (type known only at run time) and `privacy` step (image or file).

  The six file uploads (video-to-mp4's MP4 and stripped original, upload-privacy's stripped image
  file, the migration's videos, and the two video live-check scripts) still call @sanity/client: a
  file asset gets no image metadata, and the test refuses `extract` in them.
- **`studio/test/upload-metadata.test.ts`**, rewritten. It checks:
  - `IMAGE_METADATA_OPTIONS` against a fixed list in the test, so adding `location` to the constant
    fails;
  - the Studio schema, as before;
  - `uploadAsset` and the image-privacy Function's store, against a local HTTP server with the real
    @sanity/client: the `meta` parameters on the wire, that nothing is sent when a call is refused,
    and, as a positive control, that the client itself sends whatever `extract` asks for;
  - the files git tracks or would track. Before, it walked the disk and read the Functions' ignored
    `.build/` bundles too. It fails on:
    - an `assets.upload` that can be an image outside the helper, a non-call reference such as
      `.bind`, or a computed name;
    - `extract` in a file upload;
    - **any `meta` request parameter, whatever its value**: `meta=` (URL, shell, Python keyword), an
      object or dict key whose value is not an object, a shorthand key in a query, URLSearchParams
      `set`/`append`, `['meta', …]`/`("meta", …)` pairs, and `.meta =`/`['meta'] =` assignments;
    - a literal `extract` or `metadata` list with `location`, `exif` or `image`, as before.
  - 26 forms the scan must catch (the recheck's four among them), and 13 forms the repository uses
    for other things that it must allow, such as `import.meta`, a box named `meta`, destructuring
    and a parameter with an object type. The helper's own upload call is allowed only in the
    helper.

  Its header now states the limits. Not seen: a parameter name built at run time, an object key
  after a comment line, the assets object reached under another name, and uploads from outside the
  repository. For those, upload-privacy's WARN line is the only signal.
- **upload-privacy's WARN text** ended with "Upload without `meta=location`, exif or image", which
  the scan reads as a parameter. It now ends "Never ask an upload for location, exif or image
  (@sanity/client's extract, the HTTP API's meta parameter)". The test that checks the WARN still
  passes.

**A side effect, caught and undone.** A comment added to `privacy/constants.ts` changed the
migration's stripper fingerprint (`STRIPPER_SOURCES` in `migration/wagtail-to-sanity/src/privacy/copies.ts`
hashes that file). Validation then refused to run: "privacy-map.json was made with other stripper
code". The comment was removed, so `constants.ts` equals its last commit, and validation ran. The
first deploy carried that comment; the second was built from the commit.

**Checks:**

- **On disk.** Temporary untracked files with the recheck's four forms (an `.mjs` and a `.py`) gave
  4 problems: the image upload with `extract: LIST`, both `{meta: …}` and the Python dict. They were
  then removed.
- **Mutations**, applied together in one run, then undone (both files compared by sha1 afterwards):
  `'location'` added to `IMAGE_METADATA_OPTIONS`, and image-privacy's upload changed back to
  `client.assets.upload('image', …)`. 4 tests fail:
  - the fixed-list check names `location`;
  - the refusal check, because `location` is then allowed;
  - the repository scan flags the direct upload at its line;
  - the reach check finds `uploadAsset` calls in 3 files instead of 4.
- **TypeScript.** A `// @ts-expect-error` on `extract: ['lqip', 'location']` in the test: the
  Studio's `tsc --noEmit` passes, so TypeScript refuses `location`.
- **Suites:**
  - Studio: 122 of 122 tests (74 before);
  - `privacy` 41, `image-privacy` 32, `upload-privacy` 21, migration 100 (all pass);
  - typecheck clean in the Studio, `privacy`, `image-privacy`, `upload-privacy`,
    `testimonial-ascii-art` and the migration;
  - ESLint clean on the test (the Functions are outside its scope).
- **Live, after each deploy** (staging, a synthetic random-pixel 64×64 PNG with a `tIME` chunk,
  uploaded through `uploadAsset`; a scratch testimonial draft that uses it):

  | | after `OP-my6te6d4ga` (23:28:52) | after `OP-vzue263ewu` (23:33:55) |
  |---|---|---|
  | upload-privacy | wait ended after 0.1 s: used by a document | the same |
  | image-privacy | stripped `tIME`, moved the reference, deleted the upload in 6.4 s | the same, in 6.2 s |
  | Copy (`source.name` `image-privacy`, `privacy.status` `stripped`) | `metadata`: `blurHash`, `dimensions`, `hasAlpha`, `isOpaque`, `lqip`, `palette`, `thumbHash` | the same |
  | First revision of the copy and of the upload, without a token | 200, the same keys; no `location`, `exif` or `image` | the same |

- **Function logs since 23:00 UTC:** image-privacy 2 runs, upload-privacy 4 (the 2 uploads and the
  2 draft deletes, "nothing to do"), testimonial-ascii-art 2, video-to-mp4 none. All INFO: no
  `WARN`, no `ERROR`.
- **Validation, staging,** 23:30:57 to 23:33:12 UTC: 13 of 13 pass. `privacy`: 173 assets, 0 with
  personal metadata, 99/99 copies marked.

### Finding 3: the report's status

**Confirmed.** The top of this report said "Status: blocked at step 3. No dataset was changed.",
after the recreate and fix round 1.

**Fixed:**

- **This report** opens with [Current status](#current-status-2026-11-26-2345-utc). The old status
  section is renamed "Status when first written (20:35 UTC)" and kept as the record, with the plan
  sections after it.
- **Dated notes** at the top of [privacy-review.md](privacy-review.md),
  [privacy-verification.md](privacy-verification.md), the
  [morning report](../morning-report.md) and the [plan](../../sanity-migration-plan.md) say that
  the datasets were recreated after they were written, and point here. Their bodies are not
  rewritten: they record what was true then.
- **The morning report** has a new unresolved item 23: the History API decision of finding 1.

### Finding 4: compare differs in two group documents too

**Confirmed in both datasets.** `npm run recreate -- compare` against the pre-recreate snapshots,
23:16 UTC:

| | staging (snapshot of 20:39) | production (snapshot of 20:56) |
|---|---|---|
| Equal | 239 of 281 | 241 of 283 |
| Differing documents | 40, all in `privacy` only | 40, all in `privacy` only |
| Missing / extra | 0 / 0 | 0 / 0 |
| System documents differing | `_.groups.sanity.editor` and `_.groups.write`, in `members` | the same |
| Members then → now | 5 → 5: 4 replaced | 1 → 5: 4 added |
| Asset sha1 lists, counts per type | equal | equal |
| Result | FAIL, as expected | FAIL, as expected |

- **The four new members are the Function robots.** The members of both groups are identical in
  both datasets now.
- **Production's snapshot** was taken while the Functions were removed. The 21:05 redeploy added the
  robots.
- **Staging's snapshot** (20:39) still lists the four robots of the Functions deployed before the
  recreate. The redeploy created new ones.

**Fixed:** the note in fix round 1, finding 2 now names both differences. Anyone who reruns
`compare` against these snapshots should expect exactly these two.

### Staging test data of round 2

- **Created:**
  - the purge probe document (a note only), 23:16:08, deleted at once without purge;
  - two scratch testimonial drafts (`drafts.recreate-fix-r2-…`) with one synthetic PNG upload each.
    image-privacy made a copy of each and deleted the upload.
- **Deleted** at 23:30:05 and 23:34:15 UTC: both drafts and both copies, each copy checked
  referenced by its draft only.
- **Afterwards:** staging has 110 images, 63 files, 0 scratch documents and 0 assets created since
  23:00. Validation (above) ran between the two tests.
- **History:** these documents' revisions stay in the History API for the retention period. None
  holds a location, EXIF or camera data: the first revisions were checked (table above).

### Blocked steps

None. No command was denied. One foreground `sleep` before reading the Function logs was refused by
the shell tool, and the logs were read without it.

### Still open

1. **Finding 1 (owner):** choose between private datasets with a read token, an Enterprise custom
   role with `editHistory` (purge), or Sanity's answer. The support email
   (`~/cjoshmartin-migration/dataset-exports/cdn/sanity-support-cdn-purge-email.md`) is not sent.
2. **Not pushed:** the local commits fast-forward `origin/sanity-migration` (`b18c179`).

### Local files (not committed)

`~/cjoshmartin-migration/recreate-fix-r2/` (mode 700):

| Path | What |
|---|---|
| `scripts/` | the History API probe, the purge probes, the live image-privacy check, the cleanup |
| `data/` | the probe results, both compares, the Blueprint info before and after, the Function logs (JSON), the live check results, the cleanup records |
| `logs/` | every run, including both deploys and the plan |
