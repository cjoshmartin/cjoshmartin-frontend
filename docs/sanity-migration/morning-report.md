# Morning report: Wagtail → Sanity migration

Rewritten 2026-11-27 at about 00:45 UTC by the ship package, after two owner decisions of
2026-11-26: every asset is stripped of personal metadata (D17), and both datasets were recreated to
drop their public edit history (D18). It replaces the version of 2026-11-26 10:30 UTC (Mux removal;
last changed in `3f1f9fc`). The plan is [`../sanity-migration-plan.md`](../sanity-migration-plan.md),
amended for D17 and D18.

## Overall status

**Everything in the plan is built, deployed and verified, including D17 and D18.** Plan §11
validation passes **13 of 13 checks on both datasets** (rerun 2026-11-27 00:20 to 00:25 UTC for this
report), and the two datasets hold the same content.

- **Personal metadata is gone from every asset (D17).** 99 of the 173 assets per dataset were
  replaced by lossless copies without it (70 images, 29 video originals), and the other 40 images
  were checked and marked clean. Three Sanity Functions strip every new upload and delete the
  unstripped upload once its copy replaces it. An independent scan of every asset through the
  public CDN found no location and no personal tag.
- **The public edit history was dropped (D18).** Both datasets were deleted and created again from
  verified exports (staging import from 2026-11-26 20:40:54 UTC, production from 21:00:07 UTC).
  The History API now knows none of the 356 deleted ids per dataset (25,686 anonymous probes, 0
  documents returned), and the CDN served none of the 670 deleted asset paths probed from this
  machine.
- **Videos** are still converted MP4s in Sanity (D7). Their originals are now stripped in place.
- **The branch is pushed** (`b18c179` to `4121a3e`, a fast-forward, plus this report's commit) and
  the Vercel Preview of `4121a3e` is Ready.
- **Still a draft.** No high finding about this branch is open. Open: one medium owner decision
  about the History API (finding 23), lows, and the three high owner decisions about the old
  infrastructure from WP6 (the `images-for-cms` IAM grant, an unscrubbed private repo, a second
  leaked key). You mark the PR ready yourself in step 4.

The PR: <https://github.com/cjoshmartin/cjoshmartin-frontend/pull/6>.

## URLs

| What | URL |
|---|---|
| Pull request (draft) | <https://github.com/cjoshmartin/cjoshmartin-frontend/pull/6> |
| Vercel Preview of `4121a3e` (Ready 2026-11-27 00:35:17 UTC, built in 25 s; the site code is that of `e673fe0`: every later commit changes only documentation, tests, the Studio, the Functions or the migration) | <https://cjoshmartin-frontend-aqiubo5qc-josh-martins-projects-0186b4e9.vercel.app> ([inspector](https://vercel.com/josh-martins-projects-0186b4e9/cjoshmartin-frontend/HfEyFhcAupY9uWiEmneShL7jLYAG)); the newest deployment is listed in the PR description |
| Vercel Preview, branch alias (always the newest build of `sanity-migration`) | <https://cjoshmartin-frontend-git-a08979-josh-martins-projects-0186b4e9.vercel.app> |
| Studio | <https://cjoshmartin.sanity.studio> (redirects to the Sanity Dashboard) |
| Studio, production workspace | <https://cjoshmartin.sanity.studio/production> |
| Studio, staging workspace | <https://cjoshmartin.sanity.studio/staging> |
| Old site (unchanged, still Wagtail) | <https://www.cjoshmartin.com> |

**The Preview is behind Vercel Authentication.** Open it in a browser where you are logged in to
Vercel. No protection bypass secret exists or was created, so no agent fetched pages from the
Preview itself (see [Not verified](#not-verified)). The same site code was built against the
recreated production dataset and checked in two browsers ([Parity](#parity-with-the-old-site)).

**Preview data cache.** Sanity query results are cached until a live event or the revalidation
webhook expires them. If a page on the Preview shows stale content, purge the project's Data Cache
in the Vercel dashboard (project settings) and reload. That also clears the production deployment's
cache, which only makes the old site refetch from Wagtail.

## What changed since the last version (2026-11-26 10:30 UTC)

| Decision | Package | Result | Report |
|---|---|---|---|
| D17 | F Functions | Shared lossless strippers, the `image-privacy` Function, stripping in `video-to-mp4`, Studio accept lists and status lines | [privacy-functions.md](reports/privacy-functions.md) |
| D17 | M Migration | The `privacy` step and validation check; the existing assets replaced by checked copies | [wp3-migration.md](reports/wp3-migration.md), last section |
| D17 | Verify | Independent scan of every asset, live tests | [privacy-verification.md](reports/privacy-verification.md) |
| D17 | Review, two fix rounds, three rechecks | 16 + 7 findings: one policy, in-place video stripping, `mdat` zeroing, `upload-privacy`, release versions, keyed digests, private reads, unstrippable uploads removed | [privacy-review.md](reports/privacy-review.md) |
| D18 | Recreate | Snapshots, verified exports, History API baselines; both datasets deleted and created again; validation, compare, `history-check` | [dataset-recreate.md](reports/dataset-recreate.md) |
| D18 | Verify | History API probes, a public CDN scan of every asset, live Function tests, the site in two browsers, the old CDN paths | [recreate-verification.md](reports/recreate-verification.md) |
| D18 | Two fix rounds, two rechecks | 5 + 4 findings: the 40 unmarked images marked, `history-check --created-after`, upload-privacy's wait, a WARN on extracted data, the `uploadAsset` helper and its guard test | [dataset-recreate.md](reports/dataset-recreate.md), fix rounds |
| | Ship (this) | Plan, reports and contract updated; full ids of deleted assets shortened; scans; push; PR | this file |

Commits since the last push (`b18c179`): `fb1e00d` to `3f1f9fc` (17), the ship package's `5209e49`
and `4121a3e`, and the commit of this report.

## Current state

### Documents

Read with the Viewer token in the raw perspective on 2026-11-27 at about 00:25 UTC. Both datasets:

| Type | Published | Drafts |
|---|---|---|
| `homePage` | 1 | 0 |
| `flexPage` | 2 | 0 |
| `project` | 13 | 3 |
| `blogPost` | 7 | 16 |
| `person` | 1 | 0 |
| `testimonial` | 9 | 0 |
| `service` | 5 | 0 |
| `medium` | 8 | 0 |
| `technology` | 27 | 0 |
| `redirect` | 3 | 1 |
| **Documents** | **76** | **20** |

- 96 content documents, 173 assets and 12 system documents in each dataset; no release versions,
  no `mux.*` and no `secrets.*` documents.
- Production also has 2 `sanity.previewUrlSecret` drafts: Presentation preview sessions, which hold
  secrets and are not content. They were exported and imported with the dataset.
- The 20 drafts are unpublished Wagtail pages or pending changes, plus `drafts.redirect-1`. None is
  visible on the site without Draft Mode.
- `compare` against the pre-recreate snapshots: the same 40 documents differ, in `privacy` only (the
  marks of D18 fix round 1), and the members of 2 system group documents (the Function robots);
  0 missing, 0 extra. The verification compared the two datasets with each other: 280 of 280
  shared documents equal.

### Assets (each dataset)

| Assets | Count | Size | `privacy` |
|---|---|---|---|
| Images, stripped copies | 70 | 62.7 MiB | `stripped`, `image-strip-v1` |
| Images, checked, nothing personal | 40 | 45.4 MiB | `clean`, `image-strip-v1` |
| Converted MP4s (source `video-to-mp4`, settings v2) | 29 | 86.0 MiB | none (no metadata besides ffmpeg's encoder name) |
| Video originals, stripped in place | 29 | 261.2 MiB | `stripped`, `video-strip-v2` |
| Other files (3 STL models, 2 resume PDFs) | 5 | 10.2 MiB | none (not stripped yet: finding 25) |
| **Total** | **173** | **465.6 MiB** (488,209,248 bytes) | |

- 0 assets with `metadata.location`, `metadata.exif` or `metadata.image`; 0 images without a
  `privacy` mark; every Function filter matches 0 documents.
- Every asset's `_createdAt` is the import time of the recreate (staging 20:41 to 20:42 UTC,
  production 21:00 to 21:01 UTC).
- **Videos.** 29 video blocks in 6 published documents, all `ready` with settings v2; `file` is the
  MP4 and `original` the stripped Wagtail upload.
- **ASCII art.** 9 of 9 testimonials byte-identical to the live site.

### Validation (plan §11), both datasets, 2026-11-27

`npm run migrate -- --steps validate` in `migration/wagtail-to-sanity`: staging 00:20:13 to
00:22:28 UTC, production 00:22:28 to 00:24:47 UTC, **13 of 13 pass on both**, with identical figures.

| Check | Result |
|---|---|
| counts | 96 documents, 96 expected from the export |
| assets | 145 bucket files (29 videos, 100 uploaded as copies without personal metadata) → 144 distinct assets; 110 image and 34 file assets from Wagtail |
| hashes | 112 image and 4 document records: 44 equal to `file_hash`, 67 stripped copies with the decoded pixels of the Wagtail original, 5 explained (4 overwritten objects, 1 missing file), 0 failing |
| references | 279 references, 0 unresolved |
| keys | 764 arrays of objects |
| portableText | 581 text blocks, 729 spans |
| textParity | 291 rich-text values and StreamField blocks |
| fieldParity | 938 fields |
| videos | 29 of 29 blocks are ready MP4s (`h264-crf23-max1920-v2`); 29 originals are copies without personal metadata with the Wagtail upload's audio and video packets; 29 of 29 MP4s served by the CDN; 0 Mux documents |
| privacy | 173 assets downloaded and scanned (exiftool `-ee`, the Functions' strippers, tracks, unused `mdat` bytes, STL headers; rules `personal-metadata-v2`): 0 with personal metadata; 99 of 99 copies marked; 0 unstripped uploads; 45 source URLs, each serving the asset's own bytes; 0 documents naming a missing asset |
| asciiArt | 9 of 9 byte-identical; `asciiArtSource` matches the image on all |
| convergence | 96 transformed documents equal the dataset |
| studioValidation | `sanity documents validate --level error`: 0 errors |

This run also exercised the ship package's change to `hashes` (the explained sha1s are now
compared by their first 8 hex digits).

### Privacy (D17)

From the [recreate verification](reports/recreate-verification.md) (2026-11-26 21:13 to 21:50 UTC),
after the recreate:

- All 173 assets of each dataset downloaded through the public CDN without a token, plus `?dl=` and
  the stored bytes of the 110 images; 63 of 63 files and 110 of 110 stored images equal their sha1.
- **0 location fingerprints** of the 11 local originals that hold a location; **0 location,
  identifier or people tags**, apart from the 2 PDFs' `Creator` (finding 25); **0 non-zero unused
  `mdat` bytes** in the 58 ISO BMFF files; 0 problems from the Functions' own checks.
- Live tests on staging with synthetic media and fake coordinates: a fake-GPS JPEG moved to one
  stripped copy in 4.9 s with crop, hotspot, alt, caption and layout unchanged; a fake-GPS phone
  video was ready in 10.3 s with the same packets and rotation; every upload was deleted.

### History (D18)

- **Before the recreate** (baselines, 2026-11-26): 344 of 356 deleted ids on staging and 192 on
  production could be read without a token.
- **After** (`history-check --created-after`, rerun in D18 fix rounds 1 and 2, and recheck 2 at
  23:51 to 00:08 UTC): PASS on both datasets. 356 deleted ids each, 0 with a transaction, 0
  anonymous reads with content (2,654 and 1,764 probes); 0 transactions before the dataset's
  creation.
- **Independent probe:** 389 (staging) and 387 (production) deleted ids, 25,686 anonymous probes,
  0 documents; 12,676 anonymous reads of current documents at old times and revisions, 0 content.
- **What the History API holds now and can hold from now on** (90 days):
  [dataset-recreate.md, "What the History API holds now"](reports/dataset-recreate.md#what-the-history-api-holds-now)
  and "Document history" in the [contract](schema-contract.md#privacy-location-and-personal-metadata).
  In short: the first revision of every upload for the seconds before a Function replaces it (file
  name, sha1, previews), data an API client asks Sanity to extract (finding 23), and earlier
  revisions of anything withdrawn later. On staging it also holds the test revisions of the
  verification and fix rounds, one with synthetic coordinates (finding 28).
- **CDN:** 0 of 670 deleted asset paths served (2,168 requests), against 168 before the recreate;
  194 of them also answered 404 for every rendition variant tried.

### Functions

Blueprint stack `ST-jc4gwa3c4t`, last operation `OP-vzue263ewu`, COMPLETED 2026-11-26 23:33:31 UTC
(D18 fix round 2, from `68615f5`; checked 2026-11-27 00:28 UTC):

| Function | Memory, timeout | Runs on | Environment |
|---|---|---|---|
| `testimonial-ascii-art` | 1 GB, 60 s | a testimonial whose image changed | none |
| `video-to-mp4` | 10 GB, 900 s | a document with a video block that needs conversion | `PRIVACY_LINK_KEY` |
| `image-privacy` | 2 GB, 300 s | a document with an image uploaded since 2026-11-26 that has no current `privacy` mark | `PRIVACY_LINK_KEY` |
| `upload-privacy` | 2 GB, 900 s | an upload not made by the migration or a Function, and a deleted content document | `PRIVACY_LINK_KEY` |

The Functions run in both datasets; `video-to-mp4`, `image-privacy` and `upload-privacy` also on
drafts and release versions. No Function has run since 2026-11-26 23:34:14 UTC (the last test of
fix round 2). The only WARN since upload-privacy got one (fix round 1) is that round's synthetic
warning test.

### Builds and tests (latest runs)

| What | Result |
|---|---|
| Frontend `npm run lint` / `tsc --noEmit` / `npm test` (this package, at `5209e49`) | 0 errors (the 2 old warnings) / clean / 13 of 13 |
| Vercel Preview of `4121a3e` | Ready at 00:35:17 UTC in 25 s; GitHub "Vercel" status `success` |
| `next build` of the site code against the recreated production dataset (D18 verify) | 19 routes plus the proxy, no errors |
| Studio `npm test` / typecheck / lint (D18 recheck 2) | 122 of 122 / clean / clean |
| Functions `npm test` (D18 recheck 2) | `privacy` 41, `image-privacy` 32, `upload-privacy` 21, `video-to-mp4` 118, `testimonial-ascii-art` 65, all pass |
| Migration `npm test` / typecheck (this package) | 100 of 100 / clean |
| Verify harness / backups `npm test` (this package) | 18 of 18 / 57 of 57 |
| Decommission `test/run.sh` | 96 of 96 (overnight; the scripts are unchanged since) |

### Backups

Nothing changed in the backup code. Backups store what the dataset holds, so the first real
snapshot (after `setup-gcp.sh`) holds only stripped files: about 466 MiB of assets per dataset. The
restore keeps every asset field not derived from the file, `privacy` and `source` included. The
overnight test backups in `~/cjoshmartin-migration/backup-test/` predate the strip and hold
unstripped originals; they are local only and on the cleanup list (step 11).

## How the Functions treat an upload

The contract is "Videos (video contract v2)" and "Privacy" in [`schema-contract.md`](schema-contract.md).

- **An image** added to any image field: `image-privacy` reads the stored bytes with its token. If
  they hold anything personal, it writes a copy with the coded image byte for byte (orientation and
  ICC kept, same dimensions), moves every reference in drafts, published documents and active
  release versions to the copy (crop, hotspot, alt, caption and layout unchanged), and deletes the
  upload. The Studio shows "Checking this image for location and camera data..." and then
  "Location and camera data removed...". A clean image is only marked `clean`.
- **A video** in a video block: `video-to-mp4` strips the upload in place first (metadata boxes,
  data tracks, creation times, handler names and every unused `mdat` byte; every sample, edit list,
  rotation, colour, HDR and Dolby Vision box stays byte for byte), converts the copy to MP4 with the
  fixed settings (`h264-crf23-max1920-v2`: H.264 High, CRF 23, longest side at most 1920 px, AAC
  128 kb/s stereo when there is audio, faststart), writes `ready` with `file` = the MP4 and
  `original` = the copy, and deletes the upload. The Studio shows "Converting to MP4..." and then
  "Ready. Original kept without location data". A video that cannot be converted gets `failed` (a
  validation error); one that cannot be stripped is taken out of the block and deleted, with a
  message.
- **Any other upload** (unused, or made through the API): `upload-privacy` removes any location,
  EXIF or camera data Sanity extracted into the asset document and logs a WARN, waits up to 60 s
  for a document to use the upload, and otherwise strips it and deletes it.
- **The site** queries only a converted MP4 (`ready`, `file` = `outputAssetId`, `video/mp4`) and
  never `original`.
- **The 29 Wagtail videos and every migrated image** were handled by the migration with the same
  strippers and the same `buildFfmpegArgs`, so no Function runs on migrated content.

## Package status

| Package | Status | Report |
|---|---|---|
| WP1 to WP8 (overnight) | done | [wp1-studio.md](reports/wp1-studio.md) to [wp8-review.md](reports/wp8-review.md), [fixes.md](reports/fixes.md) |
| Mux removal (spike, A1, A2, B, C, D, verify, review, fix rounds, rechecks) | done | [mux-removal-review.md](reports/mux-removal-review.md) and the reports it lists |
| D17 metadata stripping (F, M, verify, review, fix rounds, rechecks) | done | [privacy-review.md](reports/privacy-review.md) and the reports it lists |
| D18 dataset recreate (recreate, verify, fix rounds, rechecks) | done; finding 23 needs your decision | [dataset-recreate.md](reports/dataset-recreate.md), [recreate-verification.md](reports/recreate-verification.md) |
| Ship (docs, ids, scans, push, PR, Preview) | done | this file |

**Reports written before a later decision are history** where that decision changed things: what
the reports before the Mux removal say about Mux is superseded, and the reports before D18 describe
the datasets before the recreate. Each such report that the later packages touched has a dated note
at the top.

## Parity with the old site

The latest crawl against the old site (Mux removal fix round 1, a clean production build of
`e673fe0`; no site code changed after it) compared 47 routes at 1440 px and 390 px: **3 the same,
44 with expected differences only, 0 unexpected.** Reports with screenshots are local:
`~/cjoshmartin-migration/reports/parity-fix-r1/` and `~/cjoshmartin-migration/reports/parity-video/`.
The expected differences are listed in [wp7-verification.md](reports/wp7-verification.md) and
[video-verification.md](reports/video-verification.md); the main ones are images and videos from
`cdn.sanity.io`, the og:image crop, the footer credit and the bug fixes of plan §7.3.

After the recreate, the [D18 verification](reports/recreate-verification.md#5-frontend-against-production)
built the same site code against the recreated production dataset:

- 35 pages answer 200 in WebKit at 1440 and 390 px and in Chrome for Testing at 1440 px;
- 135 images load in each, 0 broken; 29 of 29 videos play in each (87 runs);
- 0 requests to a deleted asset; 11 of 11 HTTP checks (sitemap, robots.txt, resume PDF, three
  404s, `/info`, `/portfolio`, the 3 redirects);
- `/projects` filters show exactly the expected projects;
- only the known third-party console errors (Plausible TLS, Disqus in WebKit, ad scripts).

## Unresolved findings

None of these blocks the site. Items 1 to 3 are about the old infrastructure, not this branch.
Numbers 1 to 23 are those of the earlier versions of this report.

| # | Severity | Finding | What to do |
|---|---|---|---|
| 1 | high (owner decision, WP6 F1) | `gs://images-for-cms` grants `allAuthenticatedUsers` `roles/storage.admin` and `roles/storage.objectUser`. Any Google account can change its IAM or delete objects today. | Remove those bindings now, without breaking the live site: `scripts/decommission/04-gcs-lockdown.sh --authenticated-users-only --execute` (after `gcloud auth login` as the owner). The full lockdown is teardown step 6. |
| 2 | high (owner decision, WP6 F2) | The private repo `cjoshmartin-com/backend.cjoshmartin.com` holds the unscrubbed backend history, with `secrets.json` at `main` HEAD. | Delete or archive it once the scrubbed archive is verified. Revoking the keys (teardown step 6) makes the leaked key useless either way. |
| 3 | high (owner decision, WP6 F3) | A second leaked key, for `fileuploads@com-cjoshmartin`, is outside D11. | Add `--include-legacy-sa` to `04-gcs-lockdown.sh --execute` if you agree. |
| 4 | resolved (D17) | ~~The kept originals are publicly downloadable, 5 with GPS tags.~~ | Every original is stripped in place; they stay downloadable by anyone who finds their URL, now without metadata. The old bucket still serves the unstripped files until teardown step 6 (your timing). |
| 5 | low (Mux review, round 1 #15) | Documents nobody opens are not checked for stuck conversions, and leftover unused uploads wait for the next upload or document deletion (no scheduled sweep). | Optional: a scheduled sweep. It needs the one-way promotion of the Blueprint stack to organization scope and a robot token. |
| 6 | low (Mux review R2-6) | **Bandwidth.** Video traffic counts toward the Free plan's 100 GB/month. A full view of `/projects/squid-games-nerf-gun` downloads up to 58.35 MiB, so about 1,600 such views a month reach the cap, and the Free plan then blocks the public API until the month resets. Sanity emails the admins at 80 % and 100 %. | Watch usage. Growth, or playing videos only when they scroll into view, removes the hard stop. |
| 7 | low (Mux review R2-3) | The revalidation webhook and `SANITY_REVALIDATE_SECRET` are not set up, so content changed while nobody has the site open stays cached. | Step 5, after the merge. |
| 8 | low (Mux review R2-4) | The Mux token still authenticates (0 assets in the account). | Step 10. |
| 9 | low (Mux recheck 2) | `studio/functions/video-to-mp4/README.md` says the Studio nudges a stuck block "at most once per block every 10 minutes"; the limit holds per browser tab. | Wording only: add "in each browser tab" there. |
| 10 | low | Media 14 (`step_count.mp4`) keeps all 31 frames at their times, but ffprobe reports 3.025 s for the MP4 against 3.4585 s for the original (B-frames). Explained deviation; players present every frame. | None needed. |
| 11 | low | HDR iPhone sources come out as 8-bit H.264 still tagged HLG/BT.2020, without tone mapping. Anamorphic sources keep non-square pixels. | A settings decision; any change needs a new `SETTINGS_VERSION`. |
| 12 | low | Every Blueprint deploy needs `npm_config_platform=linux npm_config_arch=arm64`; npm 11 warns this stops working in its next major. | Keep the variables (they are in the Blueprint comment and the Function README). |
| 13 | low | Several reports from before the Mux removal have no superseded banner in the files themselves. | Marked as superseded here and in the PR. |
| 14 | low | Plausible analytics fails TLS on every page: `plausible.technicalchicago.com` ends the handshake with alert 80. The same is true on `main` today. | Fix the Plausible server. Nothing in this repo changes. |
| 15 | low | `npm run migrate -- --steps baseline,import` with no import record is refused before `baseline` runs. It fails safe. | Run `--steps baseline` on its own first if a record is ever missing. |
| 16 | low | The credentialed CORS and Presentation origin `https://cjoshmartin-frontend-*-josh-martins-projects-0186b4e9.vercel.app` also matches previews built from fork PRs. | Keep Vercel's Git fork protection on (it is on). |
| 17 | low | The Preview env vars are scoped to the `sanity-migration` branch. After the merge, previews of other branches fail with `Missing environment variable: NEXT_PUBLIC_SANITY_PROJECT_ID`. | Add the same 4 variables for all Preview branches when you next need a preview. |
| 18 | low | The Vercel env var `API_URL` is no longer read by the app. | Remove it after the teardown if you like: `vercel env rm API_URL`. |
| 19 | low, pre-existing content | Testimonial 4 shows the literal text `Josh&#x27;s`, as on the live site. Two published posts have SEO descriptions over 160 characters. Image 3's original bytes are gone from the bucket. | Edit in the Studio if you want. |
| 20 | low (WP6 F5) | 4 local stashes in `~/code/cjoshmartin.com/cjoshmartin-backend` contain key files. | `git stash clear` there when you no longer need them. |
| 21 | info | GitHub reports 63 Dependabot alerts on the default branch (7 critical, 15 high; at this push). | Review Dependabot separately. |
| 22 | low (was high; D17 review round 2, D18) | **Deleted uploads in the asset CDN's cache.** Deleting an asset does not purge `cdn.sanity.io` (30-day `s-maxage`). After the recreate, none of the 670 deleted paths is served from this machine (168 were before); deleting a dataset appears to purge its paths. Edges elsewhere may hold copies until 2026-12-26 at the latest. | Optional: send the drafted email (step 3). Until 2026-12-26 you can run `node migration/verify/src/deleted-asset-cdn-probe.mjs` (command in `privacy-review.md`). Keep `PRIVACY_LINK_KEY` safe. |
| 23 | medium (owner decision, D18 fix rounds 1 and 2) | **Data an upload asks Sanity to extract stays readable without a token in the History API** for 90 days, although upload-privacy removes it from the asset document within seconds and logs a WARN. Nothing in the repository asks for location, EXIF or camera data, and the Studio never does, but any client with a write token can. A reader needs the asset id (the sha1 of the original bytes), or a Listen connection open at upload time (the Listen API accepts anonymous connections on a public dataset). | Decide: private datasets with a read token in the frontend (a paid plan and a Vercel env change), an Enterprise custom role with `editHistory` so the Functions can `purge` what they delete, or Sanity's answer to the support email (step 3). Meanwhile check `npx sanity@latest functions logs upload-privacy --stack ST-jc4gwa3c4t` for `WARN`. |
| 24 | low (D18 recheck 2) | The header of `studio/test/upload-metadata.test.ts` does not list every form its scan misses: `assets?.upload` and `assets!.upload`, a computed key `{['meta']: …}`, `Reflect.set(…, 'meta', …)`, httpie `meta==…`, and files with other extensions (`.yml`, extensionless scripts). Nothing in the repository uses them. The header also says only a recreate removes such history; a `purge` delete would too (finding 23). | Widen the scan or list the forms in the header (a Studio change). |
| 25 | low (D17 review R2-7, owner decision) | No Function strips PDF or STL uploads. The two résumé PDFs keep the printing browser, the PDF producer and their dates; the three STL headers name the CAD exporter. | Decide whether to build PDF and STL stripping (design in `privacy-review.md`, R2-7). |
| 26 | low (D17 review R2-5, owner decision) | Capture dates and times stay in asset file names and titles (59 of 173 assets per dataset, for example screen recordings and screenshots); the site shows `originalFilename` for STL models and videos. | Decide: rename them (a patch of `originalFilename` and `title`, plus a rule for new uploads) or leave them. |
| 27 | low (D17 review) | Videos above about 480 MB cannot be stripped in the Function's `/tmp`; they are taken out of the block and deleted, with a message. An intermittent frame-check failure on Lambda (120 frames for 119) makes the editor upload again. Two images lost their HDR gain maps when stripped (the policy removes everything after the primary image). | A streaming strip would lift the size limit. The others need no action. |
| 28 | info (D18) | Staging's History API keeps the verification's synthetic test revisions until about 2027-02-24: one with fake coordinates, a fake serial number and owner (`image-30001f5f…`), one with a synthetic `Software` string. They name no real place or person. | None; they expire. |
| 29 | low (D18 fix round 1, finding 4) | upload-privacy once stripped two uploads a draft already used; the result was identical. The cause is most likely query index lag after a cold start, not proven; a seen reference is now final, and the log names the lag if it happens. | None; watch the `upload-privacy` logs for "the query index lagged". |
| 30 | low (ship) | The pushed history still holds the full sha1s of 14 deleted assets that this package shortened in the current files: one is a location-bearing photo (`c447bc43…`, in `discrepancies.ts` since `7192d8e`), the others hold no location. Their CDN paths answer 404 and the History API no longer knows them; the photo's bucket object is public until teardown step 6. | Only a history rewrite and a force push would remove them, which is your call and was not done. |
| 31 | resolved | ~~Two temporary permission rules for the recreate are still in `~/code/cjoshmartin.com/.claude/settings.local.json`.~~ | Removed on 2026-11-27 (step 12). |

## Blocked steps (exact commands)

| Step | Command | Why |
|---|---|---|
| Listing service-account keys (WP6 dry-run of `04` and `05` row 39) | `gcloud iam service-accounts keys list --iam-account file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com --project com-cjoshmartin --managed-by=user --format=json` (and the same for `fileuploads@com-cjoshmartin.iam.gserviceaccount.com`) | `PERMISSION_DENIED`: the active gcloud account is not the `com-cjoshmartin` owner. Resolved by your `gcloud auth login` |
| Checking for an existing Workload Identity pool (WP D, read-only) | `gcloud iam workload-identity-pools list --project=com-cjoshmartin --location=global` | `PERMISSION_DENIED` for the same account. Not needed: `gs://cjoshmartin-sanity-backups` does not exist, so `setup-gcp.sh` never ran |
| Cleanup during the overnight recheck 2 | `rm -rf /Users/josh/cjoshmartin-migration/tmp/recheck-r2/datadir-norecord` | Refused by the shell safety check. Harmless; it is in the cleanup list (step 11) |

The D18 step that was blocked at first (removing the Functions before the deletes) was run later
by the main session with your permission. This package had no command denied.

## What this package did

1. **Full ids of deleted assets** (`5209e49`). A scan of every tracked file at `3f1f9fc` for 40-hex
   values, against both datasets and the local inventories, found 14 full sha1s of deleted assets
   in 15 places, all already pushed: `discrepancies.ts` (8 sha1s in 9 places, including line 81,
   the location-bearing photo), `conversion-deviations.ts` (1), `test/imageDimensions.test.ts` (3,
   plus 1 made-up id) and `a1-studio-video.md` (2). All are now 8 hex digits. `extract`, `validate` and
   `matchingDeviation` compare those sha1s by prefix (`sha1Matches` in `discrepancies.ts`), and
   `validate` takes the full sha1 from the bucket file the explanation names. Checks: migration 100
   of 100 tests and typecheck; frontend 13 of 13, `tsc` and lint; an offline replay of extract's
   comparison against the last observed discrepancies (12 of 12 match, 14 negative controls
   caught), of `matchingDeviation` against the recorded conversion, and validation 13 of 13 on both
   datasets. The other 40-hex values in tracked files are current assets, commits of this or other
   repositories, Wagtail's stale recorded hashes (never Sanity assets) or synthetic test fixtures.
2. **Docs** (`4121a3e`): the plan (D17, D18, the Functions, verification item 12, test 30a, risks,
   morning steps, work packages); `dataset-recreate.md` (the completed run and its verification,
   what the History API holds now); corrections in `privacy-review.md` (the claim that the
   repository held no full id of a location-bearing video, the verdict on documents naming deleted
   uploads, commit hashes changed by the history rewrite), notes in `privacy-functions.md` and
   `wp3-migration.md`; the contract (Document history, the image trigger after the recreate, and a
   failed image privacy check is an error, not a warning).
3. **This report**, rewritten, with two link fixes in the same commit: the status anchor in
   `dataset-recreate.md`, and a link in `wp3-migration.md` to a file removed in `94f27e0`. All 98
   relative links and anchors of the changed docs resolve.
4. **Scans before each push**, of the unpushed commits (`b18c179..HEAD`):
   - `gitleaks git` (8.30.1): 1 finding, a false positive: the synthetic test key
     `'0123456789abcdef'.repeat(4)` in `studio/functions/privacy/test/provenance.test.ts`. The same
     single finding over all 81 commits since `origin/main`; `gitleaks dir docs`: no leaks;
   - an exact-value scan for the 6 secret values of `secrets.env` and `.env.local` (tokens and the
     privacy key) in every patch and commit message, every tracked file and the PR description: 0
     hits, no value printed;
   - full 40-hex values in added lines: only synthetic fixtures, no deleted asset id;
   - location: 0 fingerprints of the 11 local originals; the only ISO 6709 strings are the
     synthetic test coordinates the stripper tests inject (round numbers and city centres); no
     decimal coordinate pairs.
5. **Push and PR.** Pushed `sanity-migration` as a fast-forward (never `main`, never forced), waited
   for the Vercel Preview, and replaced the PR description. The PR stays a draft.

### Not verified

- **Pages served by the Vercel Preview.** Vercel Authentication blocks unauthenticated requests,
  and a bypass would be a project security setting outside the approved scope. The same site code
  was built and checked locally against the recreated production dataset.
- **The Presentation iframe and Disqus on the Preview domain** (tests 28 and 16): check them on
  production right after the merge if the Preview blocks them.
- **A person uploading in the real Studio** (tests 30 and 30a). The Functions were checked live on
  staging with API uploads and synthetic media.
- **Real Safari.** Playwright WebKit and Chrome for Testing were used.
- **A real GCS backup run** (tests H32–H36, after `setup-gcp.sh`).
- **CDN edges other than this machine's** (finding 22).
- **The `extract` step after the id change.** It mirrors the old bucket with `gsutil`, which this
  package must not touch; its comparison was replayed offline against the last observed values.

## Morning sequence

Run everything from `~/code/cjoshmartin.com/cjoshmartin-frontend` unless a step says otherwise.

### 1. Read this report

Pay most attention to [Unresolved findings](#unresolved-findings).

### 2. Manual tests A–G on the Preview

Run the checklist in the PR (or plan §12) on the Preview URL while logged in to Vercel. Known
notes:
- **Test 10.** Squid Games Nerf Gun has no STL model and no testimonials, on either site. Check
  STL on `/projects/mazda-key-holder` and project testimonials on
  `/projects/simon-malls-mills-outlets`. All 8 of its videos should play.
- **Tests 30 and 30a** run in the **staging** workspace: upload a phone video and a phone photo
  with location services on, watch "Ready. Original kept without location data" and "Location and
  camera data removed", check the stored files with `exiftool`, check that `upload-privacy` logged
  no WARN, and delete the test post and its assets (exact steps in plan §12).
- **Tests 16 and 28** may need production (see [Not verified](#not-verified)).

To recheck the data yourself (read-only):

```sh
cd migration/wagtail-to-sanity
npm run migrate -- --dataset staging --steps validate
npm run migrate -- --dataset production --confirm-production --steps validate
```

Both should pass 13 of 13. Run them after deleting the assets of tests 30 and 30a.

### 3. Optional: the support email to Sanity

`~/cjoshmartin-migration/dataset-exports/cdn/sanity-support-cdn-purge-email.md` (outside the
repository, because it lists the deleted paths). Its purge request is probably moot now (finding
22). Its question whether a public dataset's History API can require a token is what finding 23
needs. Send it from your own account if you want an answer.

### 4. Approve, add the Production env vars, and merge

Add the Production variables **before** merging. Without them, the production build fails with
`Missing environment variable`; Vercel would keep serving the old deployment, so the site would not
go down, but the merge would not go live.

```sh
set -a; . ~/cjoshmartin-migration/secrets.env; set +a
printf '%s' "$SANITY_PROJECT_ID" | vercel env add NEXT_PUBLIC_SANITY_PROJECT_ID production --no-sensitive --yes
printf '%s' production | vercel env add NEXT_PUBLIC_SANITY_DATASET production --no-sensitive --yes
printf '%s' https://cjoshmartin.sanity.studio | vercel env add NEXT_PUBLIC_SANITY_STUDIO_URL production --no-sensitive --yes
printf '%s' "$SANITY_READ_TOKEN" | vercel env add SANITY_API_READ_TOKEN production --sensitive --yes
vercel env ls production
gh pr ready 6 --repo cjoshmartin/cjoshmartin-frontend
```

Then merge PR #6 on GitHub. Right after the production deployment is live, run test 16 (Disqus)
and test 28 (Presentation) on <https://cjoshmartin.com> if the Preview blocked them, then test 31.

### 5. Revalidation webhook (after the merge)

`<SanityLive>` only refreshes cached pages while a browser has the site open; a change made while
nobody does (a publish, a finished video conversion, a Function's stripped copy) would otherwise
stay invisible until the next deploy. The site has `POST /api/revalidate` for this. Create a random
secret, add it to Vercel, then add a GROQ-powered webhook in the Sanity project (Manage, API,
Webhooks):

```sh
openssl rand -hex 32   # the secret; keep it in secrets.env as SANITY_REVALIDATE_SECRET
set -a; . ~/cjoshmartin-migration/secrets.env; set +a
printf '%s' "$SANITY_REVALIDATE_SECRET" | vercel env add SANITY_REVALIDATE_SECRET production --sensitive --yes
```

| Webhook field | Value |
|---|---|
| Name | Revalidate cjoshmartin.com |
| URL | `https://cjoshmartin.com/api/revalidate` |
| Dataset | `production` |
| Trigger on | Create, Update, Delete |
| Filter | (empty: every document) |
| Projection | `{_id, _type}` |
| Drafts, versions | off |
| HTTP method | POST |
| Secret | the secret above |

Redeploy production once the variable is set. Until then the route answers 500 and nothing else
changes.

### 6. Backups

1. Run `! gcloud auth login` as the `com-cjoshmartin` owner, then
   `gcloud config set project com-cjoshmartin`.
2. Review, then run:

   ```sh
   scripts/backup/setup-gcp.sh --print-only
   scripts/backup/setup-gcp.sh
   ```

   It creates `gs://cjoshmartin-sanity-backups`, the `sanity-backup` service account, and the
   Workload Identity pool and provider (repository `cjoshmartin/cjoshmartin-frontend`, id
   `737918690`).
3. Run the `gh variable set` and `gh secret set` commands it prints, with
   `--repo cjoshmartin/cjoshmartin-frontend`. The variables are `GCP_WORKLOAD_IDENTITY_PROVIDER`,
   `GCP_BACKUP_SERVICE_ACCOUNT`, `BACKUP_BUCKET` and `SANITY_PROJECT_ID`. The only secret is
   `SANITY_BACKUP_TOKEN`.
4. Run tests H32–H36. The workflow only authenticates from `main`, so this is after the merge. The
   first backup is about 466 MiB of assets per dataset. Test 35 restores into staging, which already
   holds the same files, so no asset is created and no Function sees an upload. A restore into a
   dataset without those files needs the Functions removed first (plan §15).

### 7. Security lockdown and teardown, only after your go-ahead

Prerequisites (from `scripts/decommission/README.md`): tests A–H pass, the site serves from Sanity,
backups work, `gcloud` is logged in as the owner and `gh` as an admin of `cjoshmartin-com`, and for
step 6 every video is stored in Sanity (`04` checks this itself).

Run each script as a dry-run first, read it, then repeat it with `--execute`.

1. **You:** export the final Postgres dump.

   ```sh
   scripts/decommission/03-dokku-teardown.sh export
   scripts/decommission/03-dokku-teardown.sh --execute export
   ```

2. **Claude:** copy the archive into the backup bucket.

   ```sh
   scripts/decommission/01-archive-to-backup-bucket.sh ~/cjoshmartin-migration/final/wagtail-final.dump
   scripts/decommission/01-archive-to-backup-bucket.sh --execute ~/cjoshmartin-migration/final/wagtail-final.dump
   ```

3. **Claude:** publish the scrubbed backend repo as a private, archived repo
   (`cjoshmartin-com/cjoshmartin-backend-archive`).

   ```sh
   scripts/decommission/02-push-backend-archive.sh
   scripts/decommission/02-push-backend-archive.sh --execute
   ```

4. **You, or Claude with permission:** destroy the Dokku app and its database. It asks you to
   type the app name.

   ```sh
   scripts/decommission/03-dokku-teardown.sh destroy
   scripts/decommission/03-dokku-teardown.sh --execute destroy
   ```

5. **You:** in GoDaddy, delete only the record Type A, Name `backend`, Value `159.203.93.178`
   (click-by-click steps in the decommission README, step 5). Then check:

   ```sh
   dig +short @ns31.domaincontrol.com backend.cjoshmartin.com A
   ```

6. **Claude:** make the old bucket `images-for-cms` private and revoke the leaked key. Until this
   step the bucket, and the live Wagtail site, serve the unstripped originals, 11 of them with a
   location (D17, your timing).

   ```sh
   scripts/decommission/04-gcs-lockdown.sh
   scripts/decommission/04-gcs-lockdown.sh --execute
   ```

   Add `--include-legacy-sa` if you agree to revoke the `fileuploads@` key too (finding 3). Then
   run `gcloud auth revoke file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com` to remove this
   Mac's stale local credential.
7. **You:** run tests I (37–41).

   ```sh
   scripts/decommission/05-verify.sh --ssh
   ```

   Every row should be `PASS`. Also check test 40 once by hand:
   `gh repo clone cjoshmartin-com/cjoshmartin-backend-archive /tmp/a && git -C /tmp/a log --all -- secrets.json`
   should print nothing.

### 8. Mux: revoke the token

Nothing uses Mux: its account holds 0 assets, and no Vercel or GitHub variable, Sanity document or
code holds or reads the token. It still authenticates, so:

1. In the Mux dashboard (Settings, Access Tokens), revoke the token whose id matches `MUX_TOKEN_ID`
   in `~/cjoshmartin-migration/secrets.env`.
2. Delete the `MUX_TOKEN_ID` and `MUX_TOKEN_SECRET` lines from that file.
3. If you no longer want the Mux account, delete it in the dashboard.

### 9. Privacy decisions (any time)

- PDF and STL metadata (finding 25).
- Capture dates in file names (finding 26).
- The History API (finding 23): private datasets, an Enterprise custom role, or wait for Sanity.
- A scheduled sweep (finding 5).

### 10. Other decisions (any time)

- The `images-for-cms` IAM grant (finding 1); the bindings can go now with
  `--authenticated-users-only`.
- The old private backend repo (finding 2) and the second leaked key (finding 3).

### 11. Clean up local scratch data (outside git, any time)

```sh
rm -rf ~/cjoshmartin-migration/tmp/fix-r1 ~/cjoshmartin-migration/tmp/fix-r2 \
  ~/cjoshmartin-migration/tmp/recheck-r2 ~/cjoshmartin-migration/tmp/video-verify-build \
  ~/cjoshmartin-migration/tmp/video-verify-ffmpeg702 ~/cjoshmartin-migration/tmp/a1-browser \
  ~/cjoshmartin-migration/reports/a1-screenshots ~/cjoshmartin-migration/tmp/wp5-local-bucket \
  ~/cjoshmartin-migration/backup-test/production ~/cjoshmartin-migration/backup-test/staging-changes \
  ~/cjoshmartin-migration/tmp/ship-final /tmp/a1-ffmpeg /tmp/recheck-r1
```

The two `backup-test` folders hold the overnight test backups (with unstripped originals), which
nothing reads. The recreate's exports in `~/cjoshmartin-migration/dataset-exports/` (two 473 MB
tarballs, stripped) and the evidence folders `recreate-verify/`, `recreate-fix/`,
`recreate-fix-r2/`, `recreate-recheck-r1/`, `recreate-recheck-r2/` and `ship-docs/` can go once you
no longer need them; they hold full asset ids, so keep them local. Keep
`~/cjoshmartin-migration/gcs/`, `state/`, `privacy/`, `video-mp4/` and `reports/` (the migration's
inputs, state and evidence).

### 12. Done: the temporary permission rules were removed

The recreate needed two rules in the `permissions.allow` list of
`~/code/cjoshmartin.com/.claude/settings.local.json`. They were removed on 2026-11-27 after the
recreate finished (see [`HANDOFF.md`](HANDOFF.md)):

- `Bash(npx sanity@latest blueprints deploy *)`
- `Bash(migration/wagtail-to-sanity/scripts/recreate-dataset.sh *)`

Remove them if you do not want agents to deploy the Blueprint or recreate a dataset without asking.

### Rollback

- **Before teardown step 4:** use Vercel Instant Rollback or revert the PR. The old frontend reads
  Wagtail again immediately.
- **After teardown step 4:** restore the archived dump into a new Dokku app and re-point DNS (slow,
  but everything is archived).
