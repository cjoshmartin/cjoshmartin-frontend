# Morning report: Wagtail → Sanity migration

Rewritten 2026-11-26 at about 10:30 UTC, after Mux was dropped. It replaces the overnight version
(written at 01:05 UTC, last in commit `1018045`), whose Mux content is superseded. The plan is
[`../sanity-migration-plan.md`](../sanity-migration-plan.md), amended the same day.

## Overall status

**Everything in the plan is built, deployed and verified, with one change you decided this
morning: every video is now an MP4 stored in Sanity, and Mux is gone.** Plan §11 validation passes
12 of 12 checks on both datasets (rerun at 10:13 UTC for this report), and the two datasets are
identical.

- **The overnight blockers are gone.** The 19 missing videos (Mux's 10-asset free plan) no longer
  apply: all 29 videos are converted MP4 file assets in both datasets, and the site plays every one
  of them. The backup workflow's repository name is fixed (`cjoshmartin/cjoshmartin-frontend`).
- **Every video uploaded in the Studio is converted to MP4 automatically** by the `video-to-mp4`
  Sanity Function, with the same fixed settings as the migration. The original upload is kept as a
  hidden, read-only reference and is never served.
- **Mux is gone:** the 10 Mux assets and the 10 `mux.videoAsset` documents are deleted, and the
  Mux plugin, player and backup code are removed. Only the Mux access token is left; you revoke it
  (step 8).
- **No high finding about this branch is open.** Still open: one medium (the kept originals are
  publicly downloadable, 5 of them with GPS tags; your decision), lows, and the three high
  owner decisions about the old infrastructure from WP6 (the `images-for-cms` IAM grant, an
  unscrubbed private repo, a second leaked key). Those three are not changed by this branch, and
  they are why the PR stays a **draft**: you mark it ready yourself in step 4.

The PR: <https://github.com/cjoshmartin/cjoshmartin-frontend/pull/6>. The Vercel Preview of the
current code is in [URLs](#urls).

## URLs

| What | URL |
|---|---|
| Pull request (draft) | <https://github.com/cjoshmartin/cjoshmartin-frontend/pull/6> |
| Vercel Preview, branch alias (always the newest build of `sanity-migration`) | <https://cjoshmartin-frontend-git-a08979-josh-martins-projects-0186b4e9.vercel.app> |
| Vercel Preview of this push | recorded in the PR description, "Vercel Preview" (the deployment of the last commit, which only changes this report) |
| Studio | <https://cjoshmartin.sanity.studio> (redirects to the Sanity Dashboard) |
| Studio, production workspace | <https://cjoshmartin.sanity.studio/production> |
| Studio, staging workspace | <https://cjoshmartin.sanity.studio/staging> |
| Old site (unchanged, still Wagtail) | <https://www.cjoshmartin.com> |

**The Preview is behind Vercel Authentication.** Open it in a browser where you are logged in to
Vercel. No protection bypass secret exists or was created, so no agent fetched pages from the
Preview itself (see [Not verified](#not-verified)).

**Preview data cache.** Sanity query results are cached until a live event or the revalidation
webhook expires them. The video pages use a query that changed in `e673fe0`, so they should not
reuse results cached before the video migration. If a video page on the Preview still shows no
videos, purge the project's Data Cache in the Vercel dashboard (project settings) and reload. That
also clears the production deployment's cache, which only makes the old site refetch from Wagtail.

## What changed since the overnight report

You decided to drop Mux and store every video in Sanity as an MP4, converted with fixed settings,
both the 29 migrated videos and every future Studio upload. A second workflow did it on this
branch:

| Package | Result | Report |
|---|---|---|
| Spike | A Sanity Function can run a bundled static ffmpeg. The worst case (60 s of rotated 4K 10-bit HEVC, 211.5 MB) converts in 54 s at 10 GB. Recommended: 10 GB, 900 s, preset `medium`. No GitHub Actions fallback needed. | [video-spike.md](reports/video-spike.md) |
| A1 Studio | Video contract v2 in the schema (`file`, `original`, `conversion`), the Mux plugin and its Videos tool removed, `settings.ts` with `SETTINGS_VERSION` and `buildFfmpegArgs`; schema and Studio deployed | [a1-studio-video.md](reports/a1-studio-video.md) |
| A2 Function | The `video-to-mp4` Function, deployed and checked live on staging | [a2-video-function.md](reports/a2-video-function.md) |
| B Data | The 29 videos converted and migrated into both datasets; the Mux assets and documents deleted | [wp3-migration.md](reports/wp3-migration.md), section "Videos as MP4 file assets, Mux removed" |
| C Frontend | A native `<video>` plays the MP4 from `cdn.sanity.io`; the Mux player and `image.mux.com` removed | [wp4-frontend.md](reports/wp4-frontend.md), section "Work package C" |
| D Backups | Mux removed from the backups; videos are ordinary file assets; the repository name fixed (overnight blocker 2) | [wp5-backups.md](reports/wp5-backups.md), section "WP D" |
| Verify | Parity crawl and real-browser video checks without Mux, a live Function check | [video-verification.md](reports/video-verification.md) |
| Review, two fix rounds, two rechecks | 19 + 6 findings handled; settings v2 (no frame dropped from variable-frame-rate video), version-aware reuse, retryable failures, the Studio's stuck-conversion check, the revalidation webhook route | [mux-removal-review.md](reports/mux-removal-review.md) |
| Ship (this) | Plan and this report updated, branch pushed, PR updated | this file |

Commits on the branch since the overnight push (`5b8f936`): `d01626c` to `1018045` (26 commits),
plus this package's documentation commits.

## How video conversion works

The contract is "Videos (video contract v2)" in [`schema-contract.md`](schema-contract.md); the
Function's design is in [a2-video-function.md](reports/a2-video-function.md) and
`studio/functions/video-to-mp4/README.md`.

- **The block.** A Portable Text `video` block has `file` (the file the site plays: after
  conversion, the MP4), `original` (the upload as it came in; read-only, hidden while empty, never
  served) and `conversion` (read-only: `status` `pending` / `processing` / `ready` / `failed`,
  `message`, `sourceAssetId`, `outputAssetId`, `settingsVersion`, `updatedAt`). A block needs
  conversion when `file.asset._ref` is set and differs from `conversion.outputAssetId`.
- **The settings** (single source of truth `studio/functions/video-to-mp4/settings.ts`,
  `SETTINGS_VERSION` `h264-crf23-max1920-v2`): H.264 High, yuv420p (limited range), CRF 23, preset
  `medium`; longest side at most 1920 px, aspect kept, even sides, never upscaled; rotation applied
  to the pixels; AAC 128 kb/s stereo when the input has audio, no audio track otherwise; no
  metadata copied (iPhone GPS tags are dropped); `-movflags +faststart`. v2 adds
  `-fps_mode:v passthrough -enc_time_base:v demux`, so every frame of a variable-frame-rate screen
  recording stays at its own time (v1 dropped or moved 3,607 frame times in 9 of the 29 videos).
  ffmpeg 7.0 or newer is required and checked.
- **Studio uploads: the `video-to-mp4` Function** (Blueprint stack `ST-jc4gwa3c4t`, 10 GB, 900 s,
  `nodejs24.x`, a bundled static ffmpeg 7.0.2 for linux/arm64 whose sha256 is checked before use).
  It runs on create and update, drafts included, in both datasets, for any document with a video
  block that needs conversion (blog posts, projects, flex pages, testimonials, the home page,
  people and services). Each run:
  1. takes a revision-checked lease on the upload's asset (`videoToMp4Lease`), so one upload is
     never converted twice at the same time;
  2. marks the block `processing` (the Studio shows "Converting to MP4...");
  3. reuses an MP4 already made from that upload with the current settings, or converts it: inputs
     up to 400 MB are downloaded to `/tmp`, larger ones are read through a localhost range proxy;
  4. checks the MP4 (H.264 High, yuv420p, exact size, audio rule, `moov` before `mdat`, every
     decoded frame of the upload at its own time, a full decode) and uploads it as
     `<original base name>.mp4` with `source: {name: "video-to-mp4", id: <upload _id>}` and
     `videoToMp4SettingsVersion`;
  5. writes `ready` (`file` = MP4, `original` = upload) to every draft or published block that
     still uses that upload, and releases the lease.

  A video that cannot be converted gets `failed` with a message: a validation error, so the
  document cannot be published until the editor replaces or removes it. A problem that is not the
  video's fault (a download, the API, a wrongly deployed binary) gets a retryable `pending`,
  retried 10 minutes later. While a document is open in the Studio, `VideoConversionWatcher`
  restarts a stuck conversion; a document nobody opens waits for its next edit.
- **The 29 Wagtail videos** were converted by the migration's `convert` step with the same
  `buildFfmpegArgs` (Homebrew ffmpeg 9.0.1), checked the same way, and written as `ready` blocks, so
  the Function never runs on migrated content. Both ffmpeg versions keep 27,286 of 27,286 frames at
  their own times on all 29.
- **The site** queries only a converted MP4's URL (`ready`, `file` = `outputAssetId`, `video/mp4`)
  and renders `<video autoPlay loop muted playsInline controls preload="metadata">` with
  `<source type="video/mp4">`. A block still converting, or failed, renders nothing; `original` is
  never queried.
- **Backups** need nothing special: the MP4 and the original are ordinary file assets, stored once
  each under `assets/files/`, and a restore keeps their `source`, so restored blocks are not
  converted again.
- **After a settings change** (a new `SETTINGS_VERSION`), migrated videos are redone by rerunning
  the migration (`prune-mp4s` then deletes the old MP4s); a Studio video is redone by pointing
  `file` back at its original or uploading it again. Details in the contract.

## Package status

| Package | Status | Report |
|---|---|---|
| WP1 Schema and Studio | done | [wp1-studio.md](reports/wp1-studio.md), [schema-contract.md](schema-contract.md) |
| WP2 ASCII generator and Function | done | [wp2-ascii.md](reports/wp2-ascii.md), [ascii-comparison.html](reports/ascii-comparison.html) |
| WP3a/b Migration into staging and production | done; its videos part is superseded by package B | [wp3-migration.md](reports/wp3-migration.md) |
| WP4 Frontend rewrite | done | [wp4-frontend.md](reports/wp4-frontend.md) |
| WP5a/b Backup tooling, end-to-end and restore test | done | [wp5-backups.md](reports/wp5-backups.md) |
| WP6 Decommission preparation (dry-run only) | done | [wp6-decommission.md](reports/wp6-decommission.md), [scripts/decommission/README.md](../../scripts/decommission/README.md) |
| WP7 Verification against the old site | done | [wp7-verification.md](reports/wp7-verification.md) |
| WP8 Review, two fix rounds, two rechecks | done | [wp8-review.md](reports/wp8-review.md), [fixes.md](reports/fixes.md) |
| Spike, A1, A2, B, C, D, Verify (Mux removal) | done | see [What changed](#what-changed-since-the-overnight-report) |
| Mux removal review, fix rounds 1 and 2, rechecks 1 and 2 | done; recheck 2 found no new defect | [mux-removal-review.md](reports/mux-removal-review.md) |
| Ship (docs, push, PR, Preview) | done | this file |

**Reports written before the Mux removal** ([wp1-studio.md](reports/wp1-studio.md),
[wp7-verification.md](reports/wp7-verification.md), [wp8-review.md](reports/wp8-review.md),
[fixes.md](reports/fixes.md), and the sections of [wp3-migration.md](reports/wp3-migration.md),
[wp4-frontend.md](reports/wp4-frontend.md) and [wp5-backups.md](reports/wp5-backups.md) before
their 2026-11-26 Mux-removal sections) are history: **everything they say about Mux is
superseded** by the reports above and by this file.

## Key numbers

### Documents (production and staging are identical)

Read with the Viewer token in the raw perspective at about 10:15 UTC. `npm run compare` reports the
two datasets identical at 10:13 UTC: 96 documents and 173 assets each, 269 of 269 shared ids equal,
byte-identical NDJSON.

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

- 96 documents, 173 assets and 12 system documents in each dataset. No release versions, no
  `mux.*` and no `secrets.*` documents.
- The 20 drafts are unpublished Wagtail pages or pending changes, plus `drafts.redirect-1` (a
  Wagtail redirect whose target page was never published). None is visible on the site without
  Draft Mode.
- Tag merges: 0 (no duplicates by case or whitespace).

### Assets and videos (each dataset)

| Assets | Count | Size |
|---|---|---|
| Images (`sanity.imageAsset`) | 110 | 108.5 MiB |
| Converted MP4s (`sanity.fileAsset`, source `video-to-mp4`, settings v2) | 29 | 86.0 MiB |
| Video originals (`sanity.fileAsset`, source `wagtail`) | 29 | 261.2 MiB |
| Other files (3 STL models, 2 resume PDFs) | 5 | 10.2 MiB |
| **Total** | **173** | **465.9 MiB** |

- **Videos.** 29 video blocks in 6 published documents: `/projects/squid-games-nerf-gun` (8),
  `/projects/mazda-key-holder` (1), `/projects/sba-power-badge` (4),
  `/projects/v2-of-mobile-app-for-ios-and-andriod` (10),
  `/blog/bluetooth-low-energy-ble-with-react-native-and-arduino` (3) and
  `/blog/ios-universal-links-with-expo-react-navigation-and-react-native` (3). All 29 are `ready`
  with settings v2, `file` is the MP4, and `original` is the Wagtail upload. 0 blocks need
  conversion and no conversion lease is held. No draft has a video.
- **Hashes.** Of the 116 Wagtail image and document records, 111 equal Wagtail's `file_hash` and 5
  differences are explained (4 objects overwritten in the bucket after Wagtail hashed them, 1
  missing file; only image 3 matters, and the live site already shows its replacement).
- **Upper-case file extensions.** Sanity lowercases them in asset ids (`IMG_0169.MOV` became
  `file-<sha1>-mov`). The backup tool accepts both cases (WP D's open question, now answered).
- **Mux.** 0 assets in the Mux account (checked at about 10:15 UTC); the token still
  authenticates, and nothing uses it.
- **ASCII art.** 9 of 9 testimonials are byte-identical to the live site, and the
  `testimonial-ascii-art` Function is unchanged (asset `AS-dac26sc8in`).

### Validation (plan §11), both datasets, 10:13 UTC

`npm run migrate -- --steps validate` in `migration/wagtail-to-sanity`: staging at 10:13:15 UTC,
production at 10:13:43 UTC, **12 of 12 pass on both**, with identical figures.

| Check | Result |
|---|---|
| counts | pass: 96 documents, 96 expected from the export |
| assets | pass: 145 bucket files (29 videos) → 144 distinct assets; 110 image and 34 file assets from Wagtail |
| hashes | pass: 111 equal to `file_hash`, 5 explained, 0 failing |
| references | pass: 279 references, 0 unresolved |
| keys | pass: 764 arrays of objects |
| portableText | pass: 581 text blocks, 729 spans |
| textParity | pass: 291 rich-text values and StreamField blocks |
| fieldParity | pass: 938 fields |
| videos | pass: 29 of 29 blocks are ready MP4s (settings `h264-crf23-max1920-v2`); 29 of 29 MP4s served by the CDN; 0 Mux documents |
| asciiArt | pass: 9 of 9 byte-identical; `asciiArtSource` matches the image on all |
| convergence | pass: 96 transformed documents equal the dataset |
| studioValidation | pass: `sanity documents validate --level error`, 0 errors (with `--level warning`, only the 2 known SEO descriptions over 160 characters) |

### Builds and tests (latest runs)

| What | Result |
|---|---|
| Frontend `npm run lint` / `tsc --noEmit` / `npm test`, at `1018045` (this package) | 0 errors (the 2 old warnings) / clean / 13 of 13 |
| Vercel Preview build of the pushed branch | see the PR description ("Vercel Preview") |
| Clean `next build` of `e673fe0` (the last commit that changes the site) | pass, 19 app routes plus the proxy, including `/api/revalidate` (fix round 1) |
| Studio `npm test` / typecheck / `eslint .` / `sanity build` | 61 of 61 / pass / pass / pass (recheck 2) |
| `video-to-mp4` Function `npm test` / `test:ffmpeg` / `check-originals` on the 29 originals | 103 of 103 / 9 of 9 / 29 of 29 (fix rounds 1 and 2, recheck 2) |
| Migration `npm test` / `test:ffmpeg` / typecheck | 71 of 71 / 5 of 5 / clean |
| Verify harness `npm test` | 18 of 18 |
| Backups `npm test` / GCS emulator | 57 of 57 / 2 of 2 (WP D; 57 of 57 again in the review) |
| Decommission `test/run.sh` | 96 of 96, shellcheck included |
| ASCII Function `npm test` | 65 of 65 (overnight; unchanged since) |
| Studio deploy | the served bundle equals the local build of the current code (fix round 2, recheck 2) |
| Blueprint stack `ST-jc4gwa3c4t` | last operation `OP-z27urztvpm` completed 09:53:37 UTC; `video-to-mp4` asset `AS-4nz5puavgi`; still unchanged at about 10:20 UTC |
| Live Function checks on staging | `ready` in 6.4 to 32.5 s; every frame at its time (594 of 594, 2,483 of 2,483, 31 of 31); the Studio's own stuck-conversion nudge (11 of 11 checks); everything cleaned up |

### Backups

- **Tooling.** Videos are ordinary file assets, so the weekly backup stores each MP4 and each
  original once under `assets/files/`, and a restore re-uploads them with their `source`. The
  Mux code, the `assets/mux/` layout, exit code 3 and the Mux secrets are gone. The only GitHub
  secret is `SANITY_BACKUP_TOKEN`.
- **Size.** A first snapshot of a dataset is now about 466 MiB of assets; the bucket guard fails a
  run above 4 GB.
- **Evidence.** The overnight WP5b run (production snapshot, a "no changes" second run, an exact
  restore into staging, change detection) predates the video migration. WP D's read-only dry run of
  both datasets also predates it (0 videos then). The video path is covered by unit, restore and
  `@sanity/import` contract tests with a contract v2 fixture. The real GCS run with videos happens
  after `setup-gcp.sh` (tests H32–H36).

## Parity with the old site

The latest crawl (fix round 1, a clean production build of `e673fe0`; no site code changed after
it) compared 47 routes of the live Wagtail site with the new site at 1440 px and 390 px. Result:
**3 the same, 44 with expected differences only, 0 unexpected.** Reports with screenshots are local:
`~/cjoshmartin-migration/reports/parity-fix-r1/` and `~/cjoshmartin-migration/reports/parity-video/`.

Interactive checks on the new site:
- **Videos:** 58 of 58 checks (29 videos at two widths) pass in Chrome for Testing and in WebKit:
  each starts on its own without a `play()` call, is muted, inline and looping with controls, and
  plays its contract v2 MP4. Video counts equal Sanity and the old page on 12 of 12 visits, and the
  order is the old site's. 0 requests to a Mux host or the old bucket.
- **STL models:** 6 of 6 draw and rotate.
- **YouTube:** 18 of 18 load, and 16 play. The same 2 do not play on the old site either.
- **Testimonial art:** 8 of 8 match Sanity and the old site. The hover reveal and the 30 s rotation
  work.
- **Disqus:** 20 of 20 load the same thread as the old site.
- **Console:** only the known third-party errors (Disqus, YouTube, Plausible TLS).

**Every remaining difference** (all classified as expected):

| Difference | Where | Why |
|---|---|---|
| Videos are converted MP4s from `cdn.sanity.io` instead of the originals from `storage.googleapis.com/images-for-cms/media/`; the boxes are identical | the 6 video pages | Mux dropped, D7 |
| og:image is a 1200x630 JPEG crop from `cdn.sanity.io` | every page with an image | images moved to Sanity (WP4 deviation 5) |
| Images come from `cdn.sanity.io`; some renditions are 1 px taller | most pages | Sanity CDN rounding versus Wagtail renditions (±3 px allowed) |
| Footer credit says Next.js and Sanity instead of Django and Wagtail | every page | plan §7.2 |
| Flex pages have their own `<title>` and canonical; the old ones crashed without a Referer | `/flex/portfolio`, `/flex/blog` | bug 6, WP4 deviation 4 |
| Meta description is the Wagtail search description | `/blog/bluetooth-low-energy-ble-with-react-native-and-arduino`, `/blog/creating-zip-files-with-javascript` | bug 2 |
| `/?utm_source=test` renders the home page (the old site crashed) | `/?utm_source=test` | bug 3 |
| Sitemap base is `https://cjoshmartin.com`; `lastmod` is `_updatedAt` (the import time until edited) | `/sitemap.xml` | bug 4 |
| Unknown slugs answer 404 (the old site answered 200 with a crash page) | `/blog/does-not-exist`, `/projects/does-not-exist` | bug 5 |
| `/about` is a 308 to `/`; `/admin` is a 307 to the Studio | `/about`, `/admin` | plan §7.1 |
| The 3 published Wagtail redirects now work (308); the old frontend ignored them | `/blog/bluetooth-low-energy-ble-with-react-native`, `/blog/creating-zip-files-in-browser-with-javascript`, `/blog/universal-links-with-expo-react-navigation-and-react-native` | migrated `redirect` documents |
| `/blog/add-a-background` is a plain 404 | that path | its target page was never published, so `redirect-1` is a draft (R1-2) |
| The Squid Games `face_recognition` link goes to PyPI instead of a dead `#https://...` fragment | `/projects/squid-games-nerf-gun` | content fix R1-5 |
| The resume's Charter fonts load, so the text reflows | `/resume`, `/resume/pdf` | R1-3 |
| Technology order on parametric picture frames is "cricut, Fusion 360", like the old site | that project | R1-1 |

## Unresolved findings

None of these blocks the site. Items 1 to 3 are about the old infrastructure, not this branch.

| # | Severity | Finding | What to do |
|---|---|---|---|
| 1 | high (owner decision, WP6 F1) | `gs://images-for-cms` grants `allAuthenticatedUsers` `roles/storage.admin` and `roles/storage.objectUser`. Any Google account can change its IAM or delete objects today. | Remove those bindings now, without breaking the live site: `scripts/decommission/04-gcs-lockdown.sh --authenticated-users-only --execute` (after `gcloud auth login` as the owner). The full lockdown is teardown step 6. No video depends on the bucket any more. |
| 2 | high (owner decision, WP6 F2) | The private repo `cjoshmartin-com/backend.cjoshmartin.com` holds the unscrubbed backend history, with `secrets.json` at `main` HEAD. | Delete or archive it once the scrubbed archive is verified. Revoking the keys (teardown step 6) makes the leaked key useless either way. |
| 3 | high (owner decision, WP6 F3) | A second leaked key, for `fileuploads@com-cjoshmartin`, is outside D11. | Add `--include-legacy-sa` to `04-gcs-lockdown.sh --execute` if you agree. |
| 4 | medium (owner decision, review R2-2) | **The kept originals are publicly downloadable.** The Free plan only allows public datasets: an anonymous query lists the 29 Wagtail originals with their CDN URLs, and an anonymous download works. 5 are iPhone clips with a GPS location tag (`IMG_0169`, `IMG_3151`, `IMG_3239`, `IMG_6810`, `IMG_7386`). The MP4s carry no metadata. The old site served the same files from the public bucket, but every new iPhone upload adds a public original. | Decide: accept it; strip metadata from originals (a lossless remux, which changes what "original" means); or keep originals out of the public dataset. |
| 5 | low (review, round 1 #15) | Documents nobody opens are not checked for stuck conversions. A block whose run died, or whose retry came due, waits for the next edit or for someone to open the document; meanwhile the site shows nothing for it. | Optional: a scheduled sweep. It needs the one-way promotion of the Blueprint stack to organization scope and a robot token. |
| 6 | low (review R2-6) | **Bandwidth.** Video traffic now counts toward the Free plan's 100 GB/month. A full view of `/projects/squid-games-nerf-gun` (8 autoplaying videos) downloads up to 58.35 MiB, so about 1,600 such views a month reach the cap, and the Free plan then blocks the public API (HTTP 402) until the month resets, so the whole site's content stops loading. Sanity emails the admins at 80 % and 100 %. | Watch usage. Upgrading to Growth, or playing videos only when they scroll into view, removes the hard stop. |
| 7 | low (review R2-3) | The revalidation webhook and `SANITY_REVALIDATE_SECRET` are not set up, so content changed while nobody has the site open stays cached. | Step 5, after the merge. |
| 8 | low (review R2-4) | The Mux token still authenticates (0 assets in the account). | Step 8. |
| 9 | low (recheck 2) | `studio/functions/video-to-mp4/README.md` says the Studio nudges a stuck block "at most once per block every 10 minutes"; the limit holds per browser tab. Another tab or a reload can nudge again (one extra write; the lease prevents a second conversion). | Wording only: add "in each browser tab" there. |
| 10 | low (B, fix round 1) | Media 14 (`step_count.mp4`) keeps all 31 frames at their times, but ffprobe reports 3.025 s for the MP4 against 3.4585 s for the original (B-frames in the sample table). It passes as an explained deviation bound to its sha1; players present every frame. | None needed. `-bf 0` would align it at a bitrate cost for every video (a new `SETTINGS_VERSION`). |
| 11 | low (spike, C) | HDR iPhone sources (`IMG_3151.MOV`) come out as 8-bit H.264 still tagged HLG/BT.2020, without tone mapping. Anamorphic sources keep non-square pixels (browsers show them at the right aspect). | A settings decision; any change needs a new `SETTINGS_VERSION`. |
| 12 | low (A2) | Every Blueprint deploy needs `npm_config_platform=linux npm_config_arch=arm64`; npm 11 warns this stops working in its next major. Without it, conversions record a retryable "redeploy" message. Videos in release versions (`versions.*`) are converted when the release is published. | Keep the variables (they are in the Blueprint comment and the Function README). |
| 13 | low (ship) | Several reports from before the Mux removal (see [Package status](#package-status)) have no superseded banner in the files themselves. | Marked as superseded here and in the PR; a banner in each would need those reports' owners. |
| 14 | low | Plausible analytics fails TLS on every page (R1-4): `plausible.technicalchicago.com` ends the handshake with alert 80. The same is true on `main` today. | Fix the Plausible server. Nothing in this repo changes. |
| 15 | low | `npm run migrate -- --steps baseline,import` with no import record is refused before `baseline` runs. It fails safe and cannot happen today (both datasets have records). | Run `--steps baseline` on its own first if a record is ever missing. |
| 16 | low | The credentialed CORS and Presentation origin `https://cjoshmartin-frontend-*-josh-martins-projects-0186b4e9.vercel.app` also matches previews built from fork PRs. | Keep Vercel's Git fork protection on (it is on). |
| 17 | low | The Preview env vars are scoped to the `sanity-migration` branch. After the merge, previews of other branches fail with `Missing environment variable: NEXT_PUBLIC_SANITY_PROJECT_ID`. | Add the same 4 variables for all Preview branches when you next need a preview. |
| 18 | low | The Vercel env var `API_URL` (Production, Preview, Development) is no longer read by the app. | Remove it after the teardown if you like: `vercel env rm API_URL`. |
| 19 | low, pre-existing content | Testimonial 4 shows the literal text `Josh&#x27;s`, as on the live site. Two published posts have SEO descriptions over 160 characters. Image 3's original bytes are gone from the bucket. | Edit in the Studio if you want. |
| 20 | low (WP6 F5) | 4 local stashes in `~/code/cjoshmartin.com/cjoshmartin-backend` contain key files. | `git stash clear` there when you no longer need them. |
| 21 | info | GitHub reports Dependabot alerts on the default branch (63 at the overnight push). | Review Dependabot separately. |

## Blocked steps (exact commands)

| Step | Command | Why |
|---|---|---|
| Listing service-account keys (WP6 dry-run of `04` and `05` row 39) | `gcloud iam service-accounts keys list --iam-account file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com --project com-cjoshmartin --managed-by=user --format=json` (and the same for `fileuploads@com-cjoshmartin.iam.gserviceaccount.com`) | `PERMISSION_DENIED`: the active gcloud account is not the `com-cjoshmartin` owner. Resolved by your `gcloud auth login` |
| Checking for an existing Workload Identity pool (WP D, read-only) | `gcloud iam workload-identity-pools list --project=com-cjoshmartin --location=global` | `PERMISSION_DENIED` for the same account. Not needed: `gs://cjoshmartin-sanity-backups` does not exist, so `setup-gcp.sh` never ran |
| Cleanup during the overnight recheck 2 | `rm -rf /Users/josh/cjoshmartin-migration/tmp/recheck-r2/datadir-norecord` | Refused by the shell safety check. Harmless; it is in the cleanup list (step 9) |

Not blocked, but left to you on purpose: revoking the Mux token (only the Mux dashboard can),
the revalidation webhook (it needs a production Vercel variable), and a scheduled conversion
sweep (a one-way stack promotion). The overnight Mux upload refusal
(`400 "Free plan is limited to 10 assets"`) is superseded: nothing goes to Mux any more.

## What this package did

1. **Plan.** D7 now reads "Videos are Sanity file assets converted to MP4 (H.264 CRF 23, max
   1920 px, AAC, faststart) by the video-to-mp4 Sanity Function on every upload; originals kept
   hidden; Mux dropped". The architecture, content model, frontend, Studio (including the Function),
   migration, backups (and the moved repository name), verification, tests 26 and 30, timeline,
   work packages, risks and secrets are updated in place. Mux remains only as struck-through or
   superseded history.
2. **This report**, rewritten for the current state.
3. **Fresh checks for this report:** validation 12 of 12 on both datasets, compare identical, the
   read-only counts above, the Mux account (0 assets), the deployed Blueprint, the frontend lint,
   typecheck and tests, and the asset-id extension question.
4. **Vercel.** The Preview variables are the same 4 Sanity ones scoped to `sanity-migration`, plus
   the old `NEXT_PUBLIC_POSTHOG_*` and `API_URL`. No Mux-related variable exists in any
   environment, so nothing was removed. No Production or Development variable was touched.
5. **Secret scan.** `gitleaks git` (8.30.1) over the 61 branch commits after `origin/main` (this
   package's commit included), and `gitleaks dir` over `docs/`: no leaks. An exact-value scan of the
   branch's full patch history, every tracked file in the working tree and the new PR description
   for the 5 token values in `secrets.env` and `.env.local` (Sanity write and read tokens, the
   site's read token, the Mux token id and secret): 0 hits. No value was printed.
6. **Push, Preview and PR.** Pushed `sanity-migration` (never `main`), waited for the Vercel
   Preview of the pushed commit, and replaced the PR description: summary, decisions, every
   report including the new ones, the updated checklist, and the Preview URL. The PR stays a draft
   (see [Overall status](#overall-status)).

### Not verified

- **Pages served by the Vercel Preview.** Vercel Authentication blocks unauthenticated requests,
  and a bypass would be a project security setting outside the approved scope. The same site code
  (`e673fe0`) was built and crawled locally against production in fix round 1.
- **The Presentation iframe and Disqus on the Preview domain** (tests 28 and 16). They may be
  blocked by Vercel protection or by Disqus; check them on production right after the merge.
- **A person uploading a video in the real Studio** (test 30). The Function was checked live on
  staging with API uploads, and the Studio's stuck-conversion check in a headless Studio build.
- **Real Safari.** Playwright WebKit and Chrome for Testing were used.
- **A real GCS backup run with videos** (tests H32–H36, after `setup-gcp.sh`).
- **The Studio-only retry of a failure under older settings** (R2-5). It cannot be set up without a
  settings change; unit tests cover it.

## Morning sequence

Run everything from `~/code/cjoshmartin.com/cjoshmartin-frontend` unless a step says otherwise.

### 1. Read this report

Pay most attention to [Unresolved findings](#unresolved-findings).

### 2. Manual tests A–G

Run the checklist in the PR (or plan §12) on the Preview URL while logged in to Vercel. Known
notes:
- **Test 10.** Squid Games Nerf Gun has no STL model and no testimonials, on either site. Check
  STL on `/projects/mazda-key-holder` and project testimonials on
  `/projects/simon-malls-mills-outlets`. All 8 of its videos should play.
- **Test 30** (rewritten): upload a `.mov` to a video block of a blog post in the **staging**
  workspace, watch "Converting to MP4..." then "Ready", check that **File** is the `.mp4` and
  **Original upload** holds your `.mov`, publish, and open the post on a local site that reads
  staging (`NEXT_PUBLIC_SANITY_DATASET=staging npm run dev`): it plays the
  `cdn.sanity.io/files/j3vdh6ti/staging/<sha1>.mp4`. Delete the test post afterwards.
- **Tests 16 and 28** may need production (see [Not verified](#not-verified)).

To recheck the data yourself (read-only):

```sh
cd migration/wagtail-to-sanity
npm run migrate -- --dataset staging --steps validate
npm run migrate -- --dataset production --confirm-production --steps validate
npm run compare -- --datasets staging,production
```

Both validations should pass 12 of 12, and compare should report the datasets identical. Run
`npm run compare` before test 30 or after deleting its test assets: the test adds two file assets
to staging only.

### 3. Decisions (any time)

- The kept originals (finding 4).
- The `images-for-cms` IAM grant (finding 1); the bindings can go now with
  `--authenticated-users-only`.
- The old private backend repo (finding 2) and the second leaked key (finding 3).

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
and test 28 (Presentation) on <https://cjoshmartin.com> if Preview blocked them, then test 31.

### 5. Revalidation webhook (after the merge)

`<SanityLive>` only refreshes cached pages while a browser has the site open; a change made while
nobody does (a publish, a finished video conversion, a migration run) would otherwise stay
invisible until the next deploy. The site has `POST /api/revalidate` for this. Create a random
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

1. The repository name is fixed on this branch (`d01626c`): `scripts/backup/setup-gcp.sh` has
   `readonly GITHUB_REPO="cjoshmartin/cjoshmartin-frontend"` and keeps the `repository_id`
   `737918690` check.
2. Run `! gcloud auth login` as the `com-cjoshmartin` owner, then
   `gcloud config set project com-cjoshmartin`.
3. Review, then run:

   ```sh
   scripts/backup/setup-gcp.sh --print-only
   scripts/backup/setup-gcp.sh
   ```

   It creates `gs://cjoshmartin-sanity-backups`, the `sanity-backup` service account, and the
   Workload Identity pool and provider.
4. Run the `gh variable set` and `gh secret set` commands it prints, with
   `--repo cjoshmartin/cjoshmartin-frontend`. The variables are `GCP_WORKLOAD_IDENTITY_PROVIDER`,
   `GCP_BACKUP_SERVICE_ACCOUNT`, `BACKUP_BUCKET` and `SANITY_PROJECT_ID`. The only secret is
   `SANITY_BACKUP_TOKEN`.
5. Run tests H32–H36. The workflow only authenticates from `main`, so this is after the merge. The
   first backup is about 466 MiB of assets per dataset; the first backup after any restore always
   writes a new snapshot.

### 7. Security lockdown and teardown, only after your go-ahead

Prerequisites (from `scripts/decommission/README.md`):
- tests A–H pass
- the site serves from Sanity
- backups work
- `gcloud` is logged in as the owner, and `gh` as an admin of `cjoshmartin-com`
- for step 6 only, every video is stored in Sanity (published video blocks play converted MP4s,
  and the 29 Wagtail originals are in production); `04` checks this itself and refuses otherwise.
  It passed on 2026-11-26.

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

6. **Claude:** make `images-for-cms` private and revoke the leaked key.

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

### 8. Mux: revoke the token, and delete the account if you want

Nothing uses Mux: its account holds 0 assets, no Vercel or GitHub variable and no Sanity document
holds the token, and no code reads it. It still authenticates, so:

1. In the Mux dashboard (Settings, Access Tokens), revoke the token whose id matches `MUX_TOKEN_ID`
   in `~/cjoshmartin-migration/secrets.env`.
2. Delete the `MUX_TOKEN_ID` and `MUX_TOKEN_SECRET` lines from that file.
3. If you no longer want the Mux account, delete it in the dashboard (account settings). Nothing in
   this project depends on it.

### 9. Clean up local scratch data (outside git, any time)

```sh
rm -rf ~/cjoshmartin-migration/tmp/fix-r1 ~/cjoshmartin-migration/tmp/fix-r2 \
  ~/cjoshmartin-migration/tmp/recheck-r2 ~/cjoshmartin-migration/tmp/video-verify-build \
  ~/cjoshmartin-migration/tmp/video-verify-ffmpeg702 ~/cjoshmartin-migration/tmp/a1-browser \
  ~/cjoshmartin-migration/reports/a1-screenshots ~/cjoshmartin-migration/tmp/wp5-local-bucket \
  ~/cjoshmartin-migration/backup-test/production ~/cjoshmartin-migration/backup-test/staging-changes \
  ~/cjoshmartin-migration/tmp/ship-final /tmp/a1-ffmpeg /tmp/recheck-r1
```

That is about 4.2 GB, mostly build copies with `node_modules`. The two `backup-test` folders hold
the overnight test backups (with Mux masters), which nothing reads. Keep
`~/cjoshmartin-migration/gcs/`, `state/`, `video-mp4/` and `reports/` (the migration's inputs,
state and evidence).

### Rollback

- **Before teardown step 4:** use Vercel Instant Rollback or revert the PR. The old frontend reads
  Wagtail again immediately.
- **After teardown step 4:** restore the archived dump into a new Dokku app and re-point DNS (slow,
  but everything is archived).
