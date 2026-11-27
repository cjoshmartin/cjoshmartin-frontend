# WP3a: Wagtail → Sanity migration into `staging`

Package: [`migration/wagtail-to-sanity/`](../../../migration/wagtail-to-sanity) (Node 24, run with tsx).
Target: project `j3vdh6ti`, dataset **`staging`**. Production was not touched by WP3a. The
production import (WP3b) is described in [Production import](#production-import-wp3b) at the end.

## Result

All content, all files and 10 of the 29 videos are in `staging`. 9 of the 12 validation checks
pass. The 3 that fail (counts, references, mux) all have one cause, and it is outside this
package's control:

> **Blocked: Mux free plan.** Mux refused the 11th asset with `400 invalid_parameters: "Free plan
> is limited to 10 assets"`. Media 1–10 are on Mux and ready. Media 11–29 have no Mux asset, so
> 19 `mux.videoAsset` documents are missing and 19 video blocks point at documents that don't
> exist yet. These are weak references, so the Studio accepts them, but nothing plays. They sit
> on the live pages *Squid Games Nerf Gun* (project 6, media 11–13), blog posts 19 and 39, and
> project 23.
>
> **To unblock:** switch the Mux environment to Pay as you go in the Mux dashboard (this needs a
> billing method). Mux's published rates put about 11 minutes of basic-quality video at roughly
> $0.03 a month of storage, encoding basic video costs nothing, and the first 100,000 delivery
> minutes each month are free. That's well inside the $20 monthly credit that comes with Pay as
> you go. Then run `npm run migrate -- --dataset staging`. The 10 existing assets are reused by
> passthrough, the other 19 are created, and validation must pass before the production import.
>
> **Updated by the round-1 review fixes ([fixes.md](fixes.md)):** once the Studio is in use, a
> full rerun would overwrite editors' changes, so the import now refuses when migration documents
> changed since it last wrote them. Add the videos with the narrow `videos` step instead:
> `npm run migrate -- --dataset <name> --steps mux,videos` (see "Still open" below).

## How to run

```sh
cd migration/wagtail-to-sanity && npm ci
npm run migrate -- --dataset staging            # whole pipeline, rerunnable
npm run migrate -- --dataset staging --allow-pending-videos   # what ran tonight on staging
```

Steps: `extract → assets → mux → ascii → transform → import → validate`. The package
[README](../../../migration/wagtail-to-sanity/README.md) describes each one.
`--dataset production` also needs `--confirm-production`. In WP3a it also rejected
`--allow-pending-videos`. WP3b changed that (see [Production import](#production-import-wp3b)).

## Extract

- The export zip holds exactly `export.json`, `dumpdata.json` and `manifest.json`. Both data files
  match the manifest's byte counts and sha256. The export was generated `2026-11-25T18:22:03Z`
  by Wagtail 8.0.1.
- Bucket mirror (`gsutil -m rsync -r -d`): 145 files, 398.6 MB. That's `original_images/` 110,
  `documents/` 5, `media/` 29 and `media_thumbnails/` 1. Renditions and Django static files are
  not migrated.
- Records: 112 images, 4 documents, 29 media (all video), 9 testimonials, 5 services, 1 author,
  4 redirects, 43 pages.
- sha1 of every image and document file compared with Wagtail's `file_hash`: 107 image records
  and 4 document records match. **12 discrepancies**, each explained with evidence in
  [`src/discrepancies.ts`](../../../migration/wagtail-to-sanity/src/discrepancies.ts). The step
  fails on any discrepancy that isn't listed there, or on a listed one that has changed.

| Kind | Records / file | Explanation (short) |
|---|---|---|
| Hash mismatch | image 3 `bad_ideas.png` | Object rewritten 2024-08-29 with bytes identical to `bad_ideass.png` (image 21). The live project page 5 already shows those bytes. The 2784×1798 original is gone: the bucket keeps one generation per object. Used as page 5's content image. |
| Hash mismatch | images 7, 33, 80 | Each shares its file name with a later upload (images 28, 36, 81). django-storages overwrote the object, and its sha1 equals the later record's hash. The site's renditions were made from the current bytes. None of the three is referenced by content. |
| File missing | image 5 `bad_ideas2.png` | The object is gone (its 2024 rendition shows it existed). It isn't referenced, and its bytes equal `bad_ideass.png`, which is migrated. |
| Two records, one file | images 48+50, 95+97 | The same file was uploaded twice under the same name, with equal hashes. One asset serves both records. |
| File without record | 4 originals, 1 PDF | No record points at these files. The PDF's name has spaces, which Django would have replaced, so it was put in the bucket directly. All five are uploaded as standalone assets (D14). |

**No migrated content references a record whose file is missing.** 138 references in all, to 94
images, 2 documents (STL), 29 media and 4 pages (redirect targets).

## Assets

115 distinct assets: 110 images (109 original images, because two files have identical bytes,
plus 1 media thumbnail) and 5 files (3 STL, 2 PDF). Each has `title`, `originalFilename` and
`source {name: "wagtail", id: "image:3,image:21" | "document:1" | "media-thumbnail:2" |
"bucket:<path>", url: <GCS URL>}`. 100 were uploaded in this run. The other 15 (WP2's
testimonial photos and samples) were already in `staging` and only had their metadata patched.
Image metadata extracted: blurhash, lqip and palette. EXIF and location were not extracted.

## Documents in `staging`

| Type | Published | Drafts | From |
|---|---|---|---|
| `homePage` | 1 | 0 | home page 3 |
| `flexPage` | 2 | 0 | Portfolio (4) and Blog (12) flex pages (empty bodies, migrated anyway) |
| `project` | 13 | 3 | 13 live; pages 9, 11, 44 were unpublished in Wagtail → drafts only |
| `blogPost` | 7 | 16 | 7 live; 16 never published → drafts only |
| `person` | 1 | 0 | author 1 |
| `testimonial` | 9 | 0 | all 9, ordered on the home page as in Wagtail |
| `service` | 5 | 0 | all 5 |
| `medium` | 8 | 0 | taggit tags |
| `technology` | 27 | 0 | taggit tags |
| `redirect` | 4 | 0 | Wagtail redirects 1–4 |
| `mux.videoAsset` | 10 | 0 | media 1–10 (19 blocked, see above) |

The tree root (`wagtailcore.Page` 1) is the only page not migrated. No live page had unpublished
changes, so no live page has a draft as well.

- **Tag merges: none.** No two tag names differed only by case or whitespace. The merge logic
  runs, and the report lists every merge it makes (`reports/wp3/transform-staging.json`).
- **Service link text:** services 1 and 2 had a single plain `<p>`, which became the strings
  "Checkout examples of Mobile/Web Development". **No formatting was lost.** Services 3–5 have
  no link.
- **Rich text:** 581 text blocks and 729 spans; 59 inline images (57 full width, 2 left); 6
  YouTube embeds; 2 dividers. Every element and attribute is on the allowlist
  (`p h2–h4 ul ol li b i a[href] br hr embed[image|media]`). The data has no page or document
  links, but the converter supports both and they have unit tests. 95 empty paragraphs (Draftail
  spacers around embeds) are kept as empty blocks, exactly as the HTML had them.
- **StreamField:** 82 code blocks (yaml, javascript, cpp, bash, json; text kept verbatim,
  including Wagtail's CRLF line endings), 3 STL models (scale 20 and 30) and 29 videos. Each
  stays in its original position in a single `body` array.
- **Keys:** a rich-text block's key is `<first 8 chars of the StreamField block id>-<data-block-key>`
  (or just the `data-block-key` in non-StreamField fields). Code, STL, video and hero items use
  the StreamField block uuid. Reference arrays use the referenced id. Mux `data` arrays use
  Mux's own ids.
- **Alt text:** inline images take their alt from the embed. Every other image (person,
  testimonials, services, hero, content and preview images) uses Wagtail's default alt text,
  which is the image description, falling back to its title. That's what the old frontend showed
  for the author, testimonials and services. All 112 image records have an empty description.
- **Timestamps:** `legacy.firstPublishedAt`/`lastPublishedAt` are ISO UTC with millisecond
  precision (Wagtail stored microseconds). `legacy.wagtailId` (the Disqus identifier) is set on
  every page and snippet.

## ASCII art

All 9 testimonials have `asciiArt` from the WP2 generator, which reads the staging image CDN, and
`asciiArtSource` set to the photo's asset id. Both are written in the same document as the image.
**All 9 are byte-identical to the live site's HTML** (`live-api-snapshot/page-3.json`). The
`testimonial-ascii-art` Function logs show no invocation during or after the imports: its filter
doesn't match documents that are already up to date.

## Validation (`reports/validation-staging.{json,md}`, outside git)

| Check | Result | Detail |
|---|---|---|
| counts | FAIL (Mux only) | Every type matches the numbers derived from `export.json` except `mux.videoAsset`: 10 of 29 |
| assets | pass | 116 bucket files (videos excluded) → 115 distinct assets, all present with matching sha1 and `source.name` wagtail |
| hashes | pass | 107 image + 4 document records equal their `file_hash`; 5 are the explained discrepancies above |
| references | FAIL (Mux only) | 250 references; the 19 unresolved ones are exactly the pending videos |
| keys | pass | 784 arrays of objects: every item has a unique `_key` |
| portableText | pass | Styles, lists, decorators and annotations all resolve. No raw HTML. One explained literal: testimonial 4 contains the text `&#x27;` (see below) |
| textParity | pass | 291 rich-text values and StreamField blocks: identical plain text ignoring whitespace; same text-block, image, YouTube, divider, link, code, STL and video sequences |
| fieldParity | pass | 912 fields (titles, slugs, dates, intros, flags, codes, authors, tags, ordered references, images, SEO, legacy) |
| mux | FAIL (Mux only) | 10/29 ready, checked live against the Mux API (status, passthrough, public playback id, basic quality) |
| asciiArt | pass | 9/9 byte-identical with the live site; `asciiArtSource` equals the image on all |
| convergence | pass | The dataset holds exactly the 106 transformed documents, unchanged |
| studioValidation | pass | `sanity documents validate --workspace staging --level error`: 0 errors |

Studio warnings (not errors): blog posts 19 and 20 have SEO descriptions over 160 characters.
The 10 Mux documents also get "unknown field" warnings (`progress`, `ingest_type`,
`non_standard_input_reasons`, `tracks[].primary`, `tracks[].max_channels`), because the plugin's
schema lags the Mux API. The full asset JSON is stored as the contract asks.

### How the checks were verified

- **The checks catch real faults.** I edited `blogPost-13` in staging by hand: changed a word,
  removed a YouTube block and changed the title. `textParity` (3 failures), `fieldParity` (1)
  and `convergence` (1) all failed.
- **Reruns repair and converge.** The next full run, `npm run migrate -- --dataset staging
  --allow-pending-videos`, restored the document. A second full run wrote byte-identical NDJSON
  (sha256 `59bdab24…`) with 0 uploads, 0 metadata patches, 0 Mux creations and 0 stale documents.
  Only the Mux checks failed.
- **Before every import**, the NDJSON is validated with the Studio's own CLI and schema.
- **Unit tests:** `npm test` runs 25 tests, covering every allowlist failure, key derivation,
  embeds, links, decorators, plain-text parity, link-text flattening, Mux keys and id patterns.
  `npm run typecheck` is clean.

## Pre-existing content issues (migrated as they are, for Josh to decide)

1. **Testimonial 4 (Deepika Ramachandran)** shows the literal text `Josh&#x27;s`. Wagtail stored
   it double-escaped, and the live site shows the same text today. Fix it in the Studio if
   wanted.
2. **`redirect-1`** sends `/blog/add-a-background` to blog page 17, which was never published. It
   will 404 until that post is published, as it does on Wagtail today.
3. **Image 3** (project page 5's content image) is the replacement bytes the bucket holds now,
   not the original upload. Same as the live site.
4. **Blog posts 19 and 20** have SEO descriptions longer than 160 characters (a Studio warning).

## Deviations

- **Deterministic `_id`s.** Sanity's migration guidance prefers generated ids. The approved plan
  (§5) requires deterministic ids for convergent reruns, `--replace` imports and stable Disqus
  mapping, so this package follows the plan.
- **Mux `data` arrays have `_key`s** (Mux track and playback ids). The contract said they would
  be stored without keys, but `sanity datasets import` adds random keys to keyless arrays,
  which breaks convergence. Deterministic keys keep reruns identical, and the plugin doesn't
  read them.
- **Pruning.** After the import, documents whose id matches this migration's patterns but that
  the transform no longer produces are deleted. That covers a stale `drafts.` copy, for example.
  Assets, `secrets.mux` and Studio-created documents (random ids) are never touched.

## Data reports (outside git, `~/cjoshmartin-migration/reports/`)

`validation-staging.json` and `.md`. In `wp3/`: `extract-inventory.json`,
`transform-staging.json` (issues, merges, link text, Wagtail → Sanity mapping; it quotes draft
content, so keep it out of git), `import-staging.log`, `validate-ndjson-staging.log`,
`validate-dataset-staging.log`, `mux-run-*.log` and `full-run-1.log`/`full-run-2.log`. State maps
are in `~/cjoshmartin-migration/state/`: `inventory.json`, `assets-staging.json`, `mux-map.json`
and `ascii-staging.json`.

## Production import (WP3b)

Ran on 2026-11-25 from 20:27 to 20:42 UTC into project `j3vdh6ti`, dataset **`production`**.
Staging was only read. Nothing was deleted from either dataset.

### Result

`production` now holds exactly what `staging` holds:
- 106 documents with the same ids and the same bytes.
- 115 assets with the same content-hash ids, checked byte for byte.
- 10 `mux.videoAsset` documents that point at the same 10 Mux assets.

9 of the 12 checks pass. The 3 that fail are the same 3 as on staging, with the same 39
failures, and each one is a video that Mux hasn't accepted yet:

> **Still blocked: Mux free plan.** Rechecked at 20:29 UTC: the Mux environment holds 10 assets
> (media 1–10, all `ready`, basic quality), and creating media 11 still returns
> `400 invalid_parameters: "Free plan is limited to 10 assets"`. That is the only open item
> from WP3a. Only Josh can unblock it, because the upgrade needs a billing method (see the
> top of this report).

| Document | Videos still missing (Wagtail media ids) |
|---|---|
| `project-6` | 11, 12, 13 |
| `blogPost-19` | 14, 15, 16 |
| `project-23` | 17–26 |
| `blogPost-39` | 27, 28, 29 |

Those four pages have no playable video until Mux is upgraded and the pipeline is rerun. Every
other page is complete.

### Decision: import production without the 19 videos

WP3a made production refuse `--allow-pending-videos`. WP3b allows it, for these reasons:

- The Mux upgrade can't happen overnight. It needs Josh and a billing method.
- WP4's Preview, WP5's restore test and WP7's parity crawl all read `production`. With an empty
  production dataset, none of them can run. With this import they all can, and only the four
  pages above are missing videos.
- Nothing has to be undone later. The video blocks already hold their final weak references to
  `mux-video-<id>`, so the rerun after the upgrade only adds the 19 `mux.videoAsset` documents.
  The import uses `--replace` and converges.
- Validation is unchanged. `counts`, `references` and `mux` keep failing, and the CLI exits
  non-zero, until all 29 videos are on Mux.

Code changes (commit `57ea5d8`, `migration/wagtail-to-sanity/`):

- `--allow-pending-videos` is accepted for production when `--confirm-production` is also
  given. Production without `--confirm-production` is still refused.
- The transform now refuses a Mux map with pending videos unless the flag is passed on that
  run. The map is shared by both datasets, so before this change
  `--steps transform,import` could have imported production without the videos even though
  nobody passed the flag.
- New: `npm run compare -- --datasets staging,production` (`src/compare.ts`, with pure helpers in
  `src/comparison.ts`).
- `loadStudioSchema()` also returns `portableTextFields` (document type → its `blockContent`
  fields), so the comparison takes the Portable Text fields from the Studio schema.
- 9 new unit tests (34 in total).

### Runs

Logs are in `~/cjoshmartin-migration/reports/wp3/`.

| Run | Command | Outcome |
|---|---|---|
| 1 | `npm run migrate -- --dataset production --confirm-production` | **Extract:** manifest sha256 OK, bucket mirror unchanged (145 files, the same 12 explained discrepancies). **Assets:** 115 uploaded to production. **Mux:** refused by the free plan, so the run stopped as designed (`full-run-production-1.log`). |
| 2 | the same plus `--allow-pending-videos` | 0 uploads. 10 Mux assets reused. ASCII art 9/9 byte-identical with the live site. NDJSON: 106 documents, sha256 `59bdab24705a4198…`, identical to staging's. Studio validation of the NDJSON: 0 errors. Imported with 0 stale documents. Validation 9/12 (`full-run-production-2.log`). |
| 3 | the same as run 2 | Converged: 0 uploads, 0 metadata patches, 0 Mux creations, the same NDJSON, 0 stale documents, the same 9/12 (`full-run-production-3.log`). |

### Validation of `production`

The report is `~/cjoshmartin-migration/reports/validation-production.{json,md}`. Its check
summaries are identical to staging's, apart from the dataset name.

| Check | Result | Detail |
|---|---|---|
| counts | FAIL (Mux only) | Every type matches the export except `mux.videoAsset`, which has 10 of 29 |
| assets | pass | 116 bucket files (videos excluded) → 115 distinct assets, 110 images and 5 files |
| hashes | pass | 111 records equal their `file_hash`; 5 are the explained discrepancies |
| references | FAIL (Mux only) | 250 references. The 19 unresolved ones are exactly media 11–29 |
| keys | pass | 784 arrays of objects |
| portableText | pass | 581 text blocks, 729 spans |
| textParity | pass | 291 rich-text values and StreamField blocks |
| fieldParity | pass | 912 fields |
| mux | FAIL (Mux only) | 10/29 ready; the 19 pending ones were refused by the free plan |
| asciiArt | pass | 9/9 byte-identical with the live site; `asciiArtSource` equals the image on all |
| convergence | pass | The dataset holds exactly the 106 transformed documents |
| studioValidation | pass | `sanity documents validate --workspace production --level error`: 0 errors |

### Production compared with staging

`npm run compare -- --datasets staging,production` reports **IDENTICAL**: 0 differences and 15
explained ones (`reports/wp3/compare-staging-production.{json,md,log}`).

| What | staging | production |
|---|---|---|
| Document ids | 106 | 106, the same ids |
| Asset ids | 115 | 115, the same ids |
| Counts per type (published + drafts) | identical | identical |
| Ids in both datasets, compared field by field | 221 | 206 identical, 15 explained, 0 different |
| Portable Text: `blockContent` fields / blocks | 40 / 762 | 40 / 762 |
| Portable Text digest (sha256 over every field's hash) | `f82e76b8837f716f…` | `f82e76b8837f716f…` |
| The same digest from the transformed NDJSON | `f82e76b8837f716f…` | `f82e76b8837f716f…` |
| `transformed/<dataset>/data.ndjson` sha256 | `59bdab24705a4198…` | `59bdab24705a4198…` (byte-identical) |
| `secrets.mux` | absent | absent |

The comparison ignores system fields (`_rev`, `_createdAt`, `_updatedAt`). For assets it also
ignores `uploadId` and the dataset name inside `path` and `url`.

**The 15 explained differences:** 15 image assets in staging have `metadata.thumbHash` and
their production copies don't. These are the 15 photos and samples that WP2 uploaded to staging
around 19:00 UTC with the API's default metadata extraction, before the migration ran. The
migration uploads with `blurhash`, `lqip` and `palette` only. Every other metadata field
(`blurHash`, `lqip`, `palette`, `dimensions`, `hasAlpha`, `isOpaque`) is equal on all 110
images. Nothing in the repo reads `thumbHash`; it appears only as an optional field in the
generated `sanity.imageMetadata` type. I left staging as it is rather than strip the field.

### Other checks

- **Asset bytes:** I downloaded the original of every production asset (images with the
  authenticated `?dlRaw=` parameter, files directly). All 115 have a sha1 equal to their
  `sha1hash` (`reports/wp3/production-assets-sha1.txt`). The `hashes` check ties those hashes to
  the bucket files and to Wagtail's `file_hash`.
- **Public read:** an anonymous query of `production` sees 0 drafts. It sees the 87 published
  documents and the 115 assets. `homePage` resolves its author, 9 testimonials and 5 services.
- **Function:** the `testimonial-ascii-art` logs show no invocation during either production
  import. The last entry is WP2's staging check at 19:35 UTC
  (`reports/wp3/function-logs-after-production.txt`). `asciiArt` and `asciiArtSource` are
  written in the same document as the image, so the Function's filter doesn't match.
- **Studio warnings:** with `--level warning`, both datasets show the same 48 warnings and no
  errors:
  - 2 SEO descriptions over 160 characters (`blogPost-19`, `blogPost-20`)
  - 46 "unknown field" warnings on the 10 Mux documents
- **Guards:**
  - production without `--confirm-production` is refused
  - `--steps transform` without `--allow-pending-videos` fails with the pending-video message
    and leaves the NDJSON unchanged
  - with the new code, the staging transform writes the same NDJSON bytes
- `npm test`: 34/34 pass. `npm run typecheck`: clean.

### Still open

1. **19 videos (media 11–29).** Josh switches the Mux environment to Pay as you go, then runs:

   ```sh
   cd migration/wagtail-to-sanity
   npm run migrate -- --dataset staging --steps mux,videos                           # creates the 19 Mux assets and their documents
   npm run migrate -- --dataset production --confirm-production --steps mux,videos   # reuses the assets by passthrough
   ```

   Neither command passes `--allow-pending-videos`, so each one fails if any video is still
   pending. The `videos` step only creates the missing `mux-video-<id>` documents and leaves
   every other document as it is, so it is safe after Studio edits. It checks that every video
   block then resolves. (This replaces the full `npm run migrate` rerun this section first gave,
   which would have overwritten Studio edits; see [fixes.md](fixes.md).) The bucket must stay
   public until this is done: `scripts/decommission/04-gcs-lockdown.sh` refuses to run before.
2. **The `secrets.mux` document** is absent in both datasets. The Mux token still has to be saved
   once per dataset in the Studio's Videos tool (manual test 30). The migration never writes
   that document.


## Videos as MP4 file assets, Mux removed (work package B, 2026-11-26)

Owner decision: drop Mux. Every video is stored in Sanity as an MP4 file asset, converted with
the fixed settings of [`studio/functions/video-to-mp4/settings.ts`](../../../studio/functions/video-to-mp4/settings.ts)
(`h264-crf23-max1920-v1`), and the original upload stays in the dataset as a hidden reference
that is never served. This section supersedes everything above about Mux, `--allow-pending-videos`,
the `mux` and old `videos` steps and the "19 videos missing" blocker. All 29 videos are now in
both datasets.

### Result

All 29 Wagtail videos are MP4 file assets in **both** `staging` and `production`, and Mux is
gone:

- **Validation:** 12 of 12 checks pass on `production` (06:15, 06:19 and 06:24 UTC, the last
  with the final code) and on `staging` (06:08 and 06:27 UTC, the last with the final code); see
  [Validation results](#validation-results).
- **Documents:** each dataset has 96 migration documents: 76 published, 20 drafts. That is 106
  minus the 10 `mux.videoAsset` documents the import pruned. No `mux.*` document, block or
  `secrets.mux` is left.
- **Assets:** each dataset gained 58 file assets: 29 originals and 29 MP4s, with the same
  content-hash ids in both. In total there are 110 image and 63 file assets.
- **Video blocks:** all 29 are contract v2 with `conversion.status` `ready`. The video-to-mp4
  Function, deployed at 05:58 UTC before both imports, ran on none of them.
- **CDN:** the 29 production MP4s, downloaded anonymously from the CDN, are byte-identical to
  the checked local files and pass the same checks again.
- **Mux:** the 10 `wagtail-media-*` assets are deleted from the Mux account. Listing returns 0
  assets, and each id answers 404.
- **Convergence:** reruns converge. A full rerun of each dataset (staging 06:09, production
  06:22 UTC) converted nothing, uploaded nothing, patched nothing and pruned nothing. Both wrote
  the same NDJSON as before (`ec2d67f00a25c801…`, byte-identical for both datasets).
- **One open issue for the settings owner:** media 14 (`step_count.mp4`) loses 18 of its 31
  frames under the v1 settings. It is listed as a deviation with its evidence; see
  [Conversion](#conversion).

### What changed in `migration/wagtail-to-sanity/` (commits `ab56788`, `220feac`, `25e2851`)

| Path | Change |
|---|---|
| `src/steps/mux.ts` | Deleted (Mux client, asset creation, steady-state asset JSON). |
| `src/steps/convert.ts` (new) | Step `convert`: converts each of the 29 originals in `gcs/media/` with `buildFfmpegArgs` (preset `medium`, with `-loglevel error` added before the settings' arguments) to `~/cjoshmartin-migration/video-mp4/media-<id>/<base name>.mp4`. It checks every output and writes `state/video-mp4.json` and `reports/wp3/video-mp4.{json,md}`. It does not depend on the dataset. A rerun reuses an MP4 whose original sha1, settings version, preset, ffmpeg arguments and output sha1 are unchanged, and checks it again. |
| `src/video/ffmpeg.ts` (new) | ffprobe and ffmpeg helpers, and the MP4 checks (`verifyMp4`), each with a stable check id. ffmpeg runs asynchronously, never through a shell. |
| `src/conversion-deviations.ts` (new) | The one known deviation (media 14, below). An entry matches only the exact original sha1, settings version, output sha1 and set of failing checks. An entry that no longer matches fails the step. |
| `src/steps/videos.ts` | Rewritten. Step `videos`, now part of the default run, uploads each original and its MP4 per dataset. It reuses existing assets and protects metadata the same way as the `assets` step. Writes `state/videos-<dataset>.json`. |
| `src/transform/documents.ts` | A Wagtail `media` block becomes a contract v2 `video` block (`videoBlock`). There are no `mux.videoAsset` documents any more, and `muxVideoDocument` and `withArrayKeys` (Mux only) are gone. |
| `src/steps/validate.ts` | The new `videos` check (below) replaces `mux`. `assets` now covers the 29 originals. The Mux-pending branch of `references` and the expected `mux.videoAsset` count are gone. |
| `src/transform/schema.ts` | No longer loads `sanity-plugin-mux-input`, which A1 removed from the Studio. |
| `src/config.ts` | No `MUX_TOKEN_ID`/`MUX_TOKEN_SECRET` and no passthrough prefix. Adds `video-mp4/` and `mediaAssetSourceId`. Only `SANITY_WRITE_TOKEN` is read. |
| `src/import-guard.ts`, `src/steps/import.ts` | `addToImportRecord`, used only by the old `videos` step, is gone. `mux-video-<id>` stays in `MIGRATION_ID_PATTERN` on purpose. The import records listed those 10 documents, so the import treats them as its own and prunes them (without the pattern they would count as deleted and block the import). |
| `src/compare.ts`, `src/comparison.ts` | The `secrets.mux` special case is now general: `secrets.*` documents are never read, only their ids are listed. |
| `src/cli.ts` | Steps `extract → assets → convert → videos → ascii → transform → import → validate` (`baseline` only with `--steps`). `--allow-pending-videos` is gone. |
| `test/` | Mux tests removed. New `test/video.test.ts` covers the probe helpers, the MP4 box parser, the asset plan, the deviations and the metadata guard. `videoBlock` tests check the shape and that the Studio's `videoNeedsConversion` is false. New `test/ffmpeg.integration.ts` (`npm run test:ffmpeg`) uses the real ffmpeg: it converts a rotated clip with mono audio and a GPS tag and an odd-sized silent clip, and checks that bad files are rejected. |
| `README.md`, `package.json` | Updated, with a new `test:ffmpeg` script. `package.json` never had a Mux dependency (the Mux client used `fetch`). |

`npm test` 70 of 70, `npm run test:ffmpeg` 4 of 4, `npm run typecheck` clean.

How to run: `npm run migrate -- --dataset staging` runs the whole pipeline (ffmpeg and ffprobe must
be on the `PATH`). Production also needs `--confirm-production`. The runs here used
`--steps assets,convert,videos,ascii,transform,import,validate`. They left out `extract`, which
would have re-synced the bucket mirror (`gcs/`) and re-unzipped `extracted/`, two folders this
package did not own today. Instead, `convert` checks every original's sha1 against
`state/inventory.json`.

### Conversion

`ffmpeg version 9.0.1` and `ffprobe 9.0.1` (Homebrew, macOS arm64, 11 CPUs), preset `medium`.

The 29 originals are 5 VP9 in `.mov`, 18 H.264 and 6 HEVC; 16 have audio, 3 are rotated by
-90°, and 11 have a side longer than 1920 px. They shrank from 261.21 MiB to 86.00 MiB (33 %).
Six MP4s are larger than their originals (media 2, 3, 5, 6, 8, 12). Their sources are
low-bitrate VP9 or H.264, and CRF 23 is fixed.

Checks on every output (`src/video/ffmpeg.ts`):

- exactly one video stream, H.264 **High**, `yuv420p`;
- both sides even, the longest side at most 1920, and the size equal to `expectedOutputSize` of
  the displayed (rotation-corrected) input size, with no rotation left;
- top-level boxes with `moov` before `mdat` (faststart);
- one stereo AAC stream exactly when the input has audio, and no other streams;
- no format or stream metadata except ffmpeg's own (`major_brand`, `minor_version`,
  `compatible_brands`, `encoder`, `language`, `handler_name`, `vendor_id`);
- video, audio and file durations each within 0.1 s of the input;
- `ffprobe -count_frames` decodes as many frames as the header declares, and
  `ffmpeg -xerror -err_detect explode -f null` decodes every stream without a message.

Before/after sizes. Decoded frames are added because of the deviation below.

| Media | Original | Video in | Audio in | MiB in | Size out | Audio out | MiB out | Frames in / out |
|---|---|---|---|---|---|---|---|---|
| 1 | `7415f78306d7420ca4a385f0c876247f_1.mov` | vp9 720x1280 | aac 2 ch | 0.92 | 720x1280 | AAC 2 ch | 0.82 | 123 / 123 |
| 2 | `IMG_6810.MOV` | vp9 1440x1920 | aac 2 ch | 2.29 | 1440x1920 | AAC 2 ch | 2.37 | 103 / 103 |
| 3 | `IMG_7386.MOV` | vp9 1440x1920 | aac 2 ch | 1.14 | 1440x1920 | AAC 2 ch | 1.21 | 84 / 84 |
| 4 | `6be87f59f8274485a421101a6bc59034.mov` | vp9 720x1280 | aac 2 ch | 1.29 | 720x1280 | AAC 2 ch | 1.27 | 156 / 156 |
| 5 | `1d06b6eff7cf4a318c3b8a927cb55d44.mov` | vp9 720x1280 | aac 2 ch | 1.05 | 720x1280 | AAC 2 ch | 1.13 | 151 / 151 |
| 6 | `yt1s.com_-_Squid_Game_Red_Light_Green_Light_English_version.mp4.webm` | h264 640x320 | aac 2 ch | 9.07 | 640x320 | AAC 2 ch | 11.01 | 3938 / 3938 |
| 7 | `IMG_3151.MOV` | hevc 1920x1080 rot -90 | aac 2 ch | 19.25 | 1080x1920 | AAC 2 ch | 5.74 | 470 / 470 |
| 8 | `ca2338621e154538b9d3c582b6f2704b.mov` | h264 720x1280 | aac 2 ch | 2.14 | 720x1280 | AAC 2 ch | 3.01 | 345 / 345 |
| 9 | `export_1711667273802.MOV` | hevc 576x1024 | aac 2 ch | 35.14 | 576x1024 | AAC 2 ch | 11.59 | 1767 / 1767 |
| 10 | `IMG_3239.MOV` | h264 1920x1440 rot -90 | aac 1 ch | 37.84 | 1440x1920 | AAC 2 ch | 14.25 | 476 / 476 |
| 11 | `Screen_Recording_2021-11-10_at_11.44.10_AM.mp4` | h264 1280x720 | none | 21.95 | 1280x720 | none | 2.04 | 3559 / 3559 |
| 12 | `4db2f4c84bab42fba31f8e7e27f9d485.mov` | h264 720x1280 | aac 2 ch | 2.08 | 720x1280 | AAC 2 ch | 3.03 | 303 / 303 |
| 13 | `IMG_3240.mp4` | h264 1280x720 | aac 1 ch | 9.69 | 1280x720 | AAC 2 ch | 7.67 | 764 / 764 |
| 14 | `step_count.mp4` | h264 1004x2176 | none | 0.10 | 884x1920 | none | 0.04 | 31 / 13 |
| 15 | `IMG_0169.MOV` | hevc 1920x1440 rot -90 | pcm_s16le 1 ch | 25.22 | 1440x1920 | AAC 2 ch | 8.76 | 594 / 594 |
| 16 | `Untitled.mp4` | h264 1004x2176 | none | 2.34 | 884x1920 | none | 0.22 | 325 / 325 |
| 17 | `Screen_Recording_2025-05-05_at_1.57.42PM.mov` | h264 942x1916 | none | 0.42 | 942x1916 | none | 0.09 | 325 / 325 |
| 18 | `Screen_Recording_2025-05-05_at_2.19.49PM.mov` | h264 1008x2182 | none | 2.24 | 886x1920 | none | 0.26 | 548 / 548 |
| 19 | `Screen_Recording_2025-05-05_at_2.28.21PM.mov` | h264 1008x2162 | none | 4.85 | 894x1920 | none | 0.58 | 1385 / 1385 |
| 20 | `Screen_Recording_2025-05-05_at_2.38.07PM.mov` | h264 1008x2162 | none | 3.75 | 894x1920 | none | 0.43 | 892 / 892 |
| 21 | `Screen_Recording_2025-05-05_at_2.48.07PM.mov` | h264 1008x2162 | none | 7.51 | 894x1920 | none | 1.00 | 1557 / 1557 |
| 22 | `Screen_Recording_2025-05-05_at_2.55.11PM.mov` | h264 3420x2080 | none | 11.55 | 1920x1166 | none | 0.77 | 1834 / 1834 |
| 23 | `Screen_Recording_2025-05-05_at_3.35.34PM.mov` | h264 918x2066 | none | 2.81 | 852x1920 | none | 0.44 | 478 / 478 |
| 24 | `Screen_Recording_2025-05-05_at_3.34.49PM.mov` | h264 918x2066 | none | 3.83 | 852x1920 | none | 0.45 | 979 / 979 |
| 25 | `Screen_Recording_2025-05-05_at_3.46.43PM.mov` | h264 918x2066 | none | 25.91 | 852x1920 | none | 3.88 | 2483 / 2483 |
| 26 | `Screen_Recording_2025-05-05_at_3.53.38PM.mov` | h264 918x2066 | none | 4.44 | 852x1920 | none | 0.79 | 1503 / 1503 |
| 27 | `ScreenRecording_07-22-2025_01-50-57_1.MP4` | hevc 886x1920 | aac 2 ch | 17.94 | 886x1920 | AAC 2 ch | 2.39 | 1433 / 1432 |
| 28 | `deep_linking.MP4` | hevc 886x1920 | aac 2 ch | 1.69 | 886x1920 | AAC 2 ch | 0.31 | 398 / 398 |
| 29 | `ScreenRecording_07-26-2025_20-39-27_1.MP4` | hevc 886x1920 | aac 2 ch | 2.78 | 886x1920 | AAC 2 ch | 0.47 | 282 / 282 |

**28 of 29 pass every check. Media 14 passes only as a listed deviation.** It is an open issue for
the owner of `settings.ts`:

- `step_count.mp4` has a variable frame rate: 25 frames in its first 0.53 s, then 6 frames about
  0.5 s apart.
- With the v1 arguments, ffmpeg 9.0.1 uses 1/average frame rate (1/8.8 s) as the H.264 time base,
  so frames that fall into the same tick are dropped. The MP4 keeps 13 of 31 frames and lasts
  3.184 s instead of 3.4585 s (its last frame starts at 3.411 s instead of 3.446 s). Every other
  check passes.
- ffmpeg 6.0 (ffmpeg-static's macOS build) gives 34 frames and 3.866 s instead, with the same
  arguments except `-autorotate`, which 6.0 rejected in that position (autorotation is on by
  default). So how these arguments
  handle a variable frame rate depends on the ffmpeg version, and the Function bundles 7.0.2.
- Adding `-enc_time_base:v demux` kept all 31 frames with their original timestamps (tested with
  9.0.1). That change belongs in `settings.ts` with a new `SETTINGS_VERSION`, which this package
  does not own. After it, remove the entry in `src/conversion-deviations.ts` and rerun (see
  "Open").

Media 27 loses one frame (1432 of 1433) but stays within every check.

Reproducibility: a second `convert` run reused all 29 MP4s and wrote an identical
`state/video-mp4.json` (apart from `verifiedAt`). Converting media 14 again gave the same sha1
(`e0714608ff35…`).

### Assets per dataset

For each media item:

- **Original:** the bucket file, byte for byte, as a file asset. `originalFilename` is the bucket
  name and `title` the Wagtail media title. `mimeType` is the type a browser reports for the
  extension: `video/quicktime`, `video/mp4`, or `video/webm` for the `.mp4.webm` file (whose
  content is MP4). `source` is `{name: "wagtail", id: "media-<id>", url: <public bucket URL>}`.
- **MP4:** `originalFilename` comes from `convertedFilename` (`IMG_3151.MOV` → `IMG_3151.mp4`;
  the `.mp4.webm` file becomes `….mp4.mp4`). `mimeType` is `video/mp4`, `title` the same, and
  `source` is `{name: "video-to-mp4", id: <original asset _id>}`.

Like every converter, the `videos` step first looks for an asset with that `video-to-mp4` source
and reuses it. If its bytes differ from the local MP4 (because the Function made it), the step
downloads it, runs the same checks on it, and reads its `settingsVersion` from the video blocks
that already play it. If it fails a check, or no block (or more than one settings version) is
recorded for it, the step fails. Neither dataset had such an asset, so all 29 MP4s
are the local files. Asset ids are content hashes, so both datasets have the same 58 ids. Each
dataset gains 261.21 MiB of originals and 86.00 MiB of MP4s.

### Video blocks

All 29 blocks are now in this shape: `project-6` 8, `project-7` 1, `project-8` 4, `project-23` 10,
`blogPost-19` 3, `blogPost-39` 3. No draft has a video.

```json
{"_type": "video", "_key": "<Wagtail block id>",
 "file": {"_type": "file", "asset": {"_type": "reference", "_ref": "file-<mp4 sha1>-mp4"}},
 "original": {"_type": "file", "asset": {"_type": "reference", "_ref": "file-<original sha1>-<ext>"}},
 "conversion": {"status": "ready", "sourceAssetId": "<original id>", "outputAssetId": "<mp4 id>",
                "settingsVersion": "h264-crf23-max1920-v1", "updatedAt": "<conversion time>"}}
```

`conversion` has no `_type` (it is an inline object) and no `message`. `updatedAt` is the time the
local conversion finished, so reruns write the same bytes. The old `asset` key is gone.

### Validation

`videos` replaces `mux`. For every video block in the dataset, published or draft, it checks:

- the block matches a Wagtail media block, and has only `_type`, `_key`, `file`, `original` and
  `conversion`;
- `file` is a `video/mp4` file asset with extension `mp4` and
  `source {name: "video-to-mp4", id: <original>}`, and its sha1 is the checked MP4;
- `original` is the Wagtail upload: source `media-<id>`, the bucket sha1 and the expected MIME
  type;
- `conversion` is `ready`, with `sourceAssetId` = original, `outputAssetId` = file,
  `settingsVersion` = the current `SETTINGS_VERSION` and a valid `updatedAt`;
- the Studio's own `videoNeedsConversion` is false.

It then checks that:

- each migrated original has exactly one `video-to-mp4` asset (Function conversions of Studio
  uploads are not counted);
- every MP4 answers `HEAD` on the CDN with 200, `video/mp4` and its size;
- no `mux.*` document, `secrets.mux` document or `mux.*` object is left anywhere.

Known conversion deviations are listed as explained.

#### Validation results

`reports/validation-<dataset>.{json,md}` (outside git):

| Check | `staging` (06:08 and 06:27 UTC) | `production` (06:15, 06:19 and 06:24 UTC) |
|---|---|---|
| counts | pass: 96 of 96 | pass: 96 of 96 |
| assets | pass: 145 bucket files (29 videos) → 144 assets; 110 image + 34 file assets from `wagtail` | same |
| hashes | pass: 111 equal, 5 explained | same |
| references | pass: 279, 0 unresolved | same |
| keys | pass: 764 arrays | same |
| portableText | pass: 581 blocks, 729 spans | same |
| textParity | pass: 291 values | same |
| fieldParity | pass: 938 fields | same |
| videos | pass: 29 of 29 ready MP4s, 29 of 29 served by the CDN, 0 Mux documents; media 14 explained | same |
| asciiArt | pass: 9 of 9 | same |
| convergence | pass: 96 documents | same |
| studioValidation | pass: 0 errors | same |

With `--level warning`, the Studio reports only the 2 known SEO descriptions over 160 characters.
The 46 Mux "unknown field" warnings are gone.

**Other agent's test data in staging.** Between 06:01 and about 06:22 UTC, the Function package
(A2) ran its live check in staging. It used `blogPost-video-function-check`, its draft, its own
uploads and the MP4s the Function made from them, and has since deleted all of it.

- A staging validation at 06:19 UTC failed only because of that data: 16 failures (counts +1
  published and +1 draft `blogPost`, 31 instead of 29 video blocks, convergence, and 10 Studio
  "Required" errors), all on that document.
- A comparison at 06:17 UTC reported 9 differences, again all that document, its 4 assets and
  the counts and digest they change.
- Every check was run again after the cleanup: staging passes 12 of 12 at 06:27 UTC.

**Comparison** (`npm run compare -- --datasets staging,production`, 06:27 UTC): **identical**.

- 96 documents and 173 assets in each dataset;
- 269 of 269 shared ids identical (documents and assets);
- Portable Text: 40 fields, 762 blocks, digest `93b706605bf50450…` in both datasets and in both
  NDJSON files;
- the NDJSON is byte-identical (`ec2d67f00a25c801…`);
- no `secrets.*` documents.

**CDN check.** All 29 MP4s of each dataset were downloaded anonymously from `cdn.sanity.io`. Each
is HTTP 200 `video/mp4`, its sha1 equals both its asset id and the checked local file, and it passes
`verifyMp4` again (media 14 with exactly its listed deviation).

**Fixes made along the way:**

- `sanity documents validate` exits 1 when it finds errors. The import's NDJSON check and the
  `studioValidation` check then stopped with a bare `EEXIT: 1` and listed no errors. Both now
  accept exit 1 only together with JSON that lists errors, and report each one (commit
  `220feac`).
- The first production convergence rerun (06:21 UTC) imported correctly, but then failed while
  writing the import record: 25 documents "differ from the expected document". A read-only diff
  right afterwards found 0 of 96 different. The cause: `sanity datasets import` writes references
  weak and strengthens them in a second pass, and the query that builds the record lagged behind
  that pass. This was a pre-existing race in `src/steps/import.ts`. The read-back after an import
  (missing ids, stale ids, the record) now retries every 2 s until the dataset reads back as
  imported. It fails with the last difference after 60 s, so a real difference still stops the
  run (commit `25e2851`). The rerun after the fix (06:22 to 06:24 UTC) imported, recorded and validated
  without needing a retry. The earlier record stayed valid, because the Studio-edit check
  also accepts an unchanged content hash.

### Mux cleanup

- **Documents:** the import pruned `mux-video-1` to `mux-video-10` from both datasets
  (staging 06:08:17 UTC, production 06:14:42 UTC). Neither dataset ever had a `secrets.mux`
  document; validation checks that none appears.
- **Mux account:** a one-off script outside the repo (it reads the token from `secrets.env` and
  never prints it) first listed the account: 10 assets, all `ready`, passthrough
  `wagtail-media-1` to `-10`. It then deleted each one (10 × `204`, 06:15 UTC). The listing right
  after the deletes still showed 8, because Mux's list is eventually consistent. A new listing
  returned **0 assets**, and `GET` of each of the 10 ids returns **404**.
- **Code:** the migration package has no Mux code, configuration or token left. The only Mux
  mentions are the retired `mux-video-<id>` id pattern (explained above) and the checks that no
  Mux data is left.
- **State:** `state/mux-map.json` described assets that no longer exist. It was moved to
  `reports/wp3/package-b/mux-map-before-mux-removal.json` as a record, not deleted.

### video-to-mp4 Function

Another package deployed `video-to-mp4` to stack `ST-jc4gwa3c4t` at 05:58 UTC (10 GB, 900 s), before
both imports. Its filter only matches blocks with `file.asset._ref != conversion.outputAssetId`,
and the migrated blocks have them equal.

There were 6 imports with v2 blocks: staging at 06:08, 06:11 and 06:26 UTC, production at 06:14,
06:21 and 06:24 UTC. The Function's logs up to the last entry at 06:20:13 UTC (57 entries) are
about only one document, `drafts.blogPost-video-function-check`, the other package's test in
staging. None of the 58 migration asset ids appears in them, so no conversion ran on these
imports. The
`testimonial-ascii-art` Function's last entry is from 2026-11-25 22:47 UTC, so the imports did
not trigger it either.

### Open

> **Update (fix round 1, same day):** items 1 to 3 are resolved; see
> [mux-removal-review.md](mux-removal-review.md). The settings are now `h264-crf23-max1920-v2` with
> `-fps_mode:v passthrough -enc_time_base:v demux` (not `-enc_time_base:v demux` alone, which makes
> the Function's ffmpeg 7.0.2 encode media 14 at 90,000 fps). All 29 videos were reconverted and
> keep every frame; the MP4 assets record their settings version, the reuse lookup includes it, and
> the new `prune-mp4s` step deleted the 29 v1 MP4s in each dataset. `scripts/decommission` checks
> the v2 blocks.

1. **Media 14 and variable frame rates (owner of `settings.ts`, high for future uploads).** The v1
   arguments drop frames from bursty variable-frame-rate input, and the result depends on the
   ffmpeg version. The Function converts Studio uploads with the same arguments, and iPhone
   screen recordings are often like this.
   - Tested fix: add `-enc_time_base:v demux` and bump `SETTINGS_VERSION`.
   - Then remove the entry in `src/conversion-deviations.ts`. The `convert` step fails while the
     entry is stale, so it can't be forgotten.
   - Contract v2 does not yet say how an existing conversion is redone after a settings change.
     The reuse rule looks only at `source.id` (the original), and a `ready` block never needs
     conversion. So the old MP4 would be reused, and the `videos` step would record its old
     `settingsVersion`, which validation then reports.
   - Before redoing media 14 (or any video), delete its old `video-to-mp4` asset, or add the
     settings version to the reuse lookup.
2. **`scripts/decommission` (another package).** `lib.sh` `decom_mux_videos_complete` still
   requires a ready `mux.videoAsset` per Wagtail video, so `04-gcs-lockdown.sh` now always
   refuses. It should check the v2 blocks instead: every `video` block's
   `file.asset->mimeType == "video/mp4"` with `conversion.status == "ready"` and
   `defined(original.asset->_id)`. The originals are now copied into both datasets, so the bucket
   no longer has to stay public for the videos.
3. **Other documents still describe Mux** (owned by other packages): the morning report, the plan
   (§2 D7, §9, §10, test 30), `scripts/decommission/README.md` and the earlier sections of this
   report.
4. **HDR (owner of `settings.ts`, already raised by the spike).** The MP4 of media 7
   (`IMG_3151.MOV`) is 8-bit H.264 still tagged HLG (`arib-std-b67`). It passes every contract
   check.

Logs, scripts and state from this package are outside git:

- `~/cjoshmartin-migration/reports/wp3/package-b/`: run logs, Function logs, CDN check, Mux
  listings and the one-off scripts;
- `reports/wp3/video-mp4.{json,md}`;
- `state/video-mp4.json`, `state/videos-<dataset>.json`;
- `video-mp4/media-<id>/`, with the 29 MP4s (86 MiB).


## Privacy: personal metadata stripped from every existing asset (work package M, 2026-11-26)

Owner decision: no asset the public datasets serve may carry location or other personal metadata,
and nothing is re-encoded. Photos keep their pixels, orientation and ICC profile. Video originals
keep their video and audio streams byte for byte, with their rotation and colour/HDR tags. This
package cleaned the assets that are already in `staging` and `production`. Future uploads belong to
the image-privacy and video-to-mp4 Functions (another package).

> **Later, 2026-11-26 (not reflected below).** The privacy review widened the policy (rules v2) and
> replaced 99 assets per dataset, not 24 ([privacy-review.md](privacy-review.md)). The deleted
> assets' documents and the copies' earlier revisions then stayed readable without a token in the
> History API until both datasets were deleted and created again from verified exports
> ([dataset-recreate.md](dataset-recreate.md), which has the current state).

### Result

- **24 assets in each dataset had personal metadata: 15 images and 9 video originals.** Each one
  was replaced by a copy without it, and the old asset was deleted once nothing used it. On the CDN,
  all 24 old URLs now answer 404.
- **Lossless, and proven per file.** Images were checked by decoded-pixel hashes (ImageMagick and
  ffmpeg, every frame). Video originals were checked by per-stream packet hashes (pts, dts,
  duration, flags, size, byte position, sha256 of the data). Both kinds were checked for unchanged
  stream and tag descriptions. The Dolby Vision configuration of `IMG_3151.MOV` is kept.
- **Content is unchanged apart from asset ids.** The documents that used the 24 assets were patched
  in one transaction per dataset: `blogPost-19`, `blogPost-39`, `project-6`, `project-7`,
  `project-8` and `project-24`. The `source.id` of 9 MP4 assets was patched too. Crop, hotspot, alt
  text and captions are untouched, and every video block keeps its MP4.
- **The 29 converted MP4s carry no personal metadata** (scanned with `exiftool -ee`), so none had to
  be converted again.
- **Validation: 13 of 13 checks pass** on `staging` (11:44 UTC) and on `production` (11:52 UTC). The
  13th check is the new `privacy` check.
- **The two datasets compare identical** on all 269 ids they share. The NDJSON is byte-identical
  (`d427c126c7164b24…`) and so is the Portable Text digest (`6ce9db236331b857…`). The only ids in just
  one dataset are 3 unreferenced probe images that the image-privacy package uploaded to staging for
  its format test. They are not this package's to delete (see [Open](#open-1)).
- **Reruns change nothing.** A rerun of `npm run migrate -- --dataset <ds> --steps privacy` on each
  dataset found 0 assets to replace, and left the state files and the NDJSON byte-identical.

### What counts as personal

The rules are in [`src/privacy/rules.ts`](../../../migration/wagtail-to-sanity/src/privacy/rules.ts)
(`personal-metadata-v1`). They read every tag of `exiftool -j -a -u -ee -G0:1:3`, which covers
embedded documents and each sample of timed metadata. They also read the track list of videos and the
header of STL models, which exiftool does not read.

| Category | Tags |
|---|---|
| location | anything GPS, location, geotag, ISO 6709, latitude or longitude, plus the IPTC/XMP place fields |
| maker-notes | every maker note (vendor blocks with device and photo ids, face and scene data) |
| identifier | serial numbers, `ImageUniqueID`, Apple content/photo ids, camera, device and body ids, owner names |
| person | artist, author, creator, by-line, credit, copyright, rights, contact details, face/person regions |
| data-track | any video track that is not video or audio (timed metadata `mebx`, timecode, text, ...) |

These are kept as not personal: orientation and ICC profile (the owner decision), colour, HDR and
rendering data, camera make, model, lens and software name (a device type, not a device), capture
settings and times, free-text titles and comments, the editing-session ids of XMP `xmpMM`, and a
PDF's `Creator` (the application).

### Inventory

`~/cjoshmartin-migration/privacy/inventory-<dataset>.json` (local only; tag names, never values) has
one entry per asset: its bytes, the scan, `metadata.location`/`metadata.exif`, the `privacy` field and
the documents that use it. Timestamped copies are in `privacy/runs/`. `production` before the clean:
173 assets (110 images, 58 videos, 3 STL, 2 PDF), every one mapped by sha1 to its local bucket file or
converted MP4. 24 of them had personal metadata. `staging` had the same 173 plus the 3 probes, with
the same 24 flagged. (The first staging inventory file was overwritten by a later run. The 24 are in
`run-staging-1.log` and in `privacy/runs/replaced-staging-*.json`.)

- **Location: 11 assets.**
  - 6 photos have an EXIF GPS block: `IMG_0070.jpeg`, `IMG_3241_copy.jpg`, `IMG_3736.jpg`,
    `IMG_7630.jpg`, `IMG_8414.jpg` and `IMG_9514.jpg`.
  - 5 videos have a location atom: `IMG_0169.MOV`, `IMG_3151.MOV` and `IMG_3239.MOV` in QuickTime
    Keys, `IMG_6810.MOV` and `IMG_7386.MOV` in an item list.
  - `exiftool -ee` found no location inside the timed-metadata (`mebx`) tracks of the three iPhone
    MOVs. They carry camera, motion and Live Photo details, and were removed as data tracks.
- **Maker notes: 7 Apple photos.** These are the 6 GPS photos and `IMG_9344.jpeg`.
- **Identifiers: 12 images with `ImageUniqueID`.** That includes 4 Android screenshots, `IMG_5861.JPG`,
  `IMG_9932.JPG`, `IMG_9932_copy.jpeg` and `l_9b2d….jpg`.
- **Person: 5 assets.**
  - `IMG_9344.jpeg` has face regions (XMP `mwg-rs`, with face ids).
  - The three iPhone screen recordings have an `Author` atom.
  - `export_1711667273802.MOV` has a video editor's 32-hex `Copyright` value.
- **None of the other assets had personal metadata:** the 2 PDFs, the 3 STL models (Fusion "ATF"
  headers), all 29 MP4s and every other image and video. No asset document holds
  `metadata.location` or `metadata.exif`.
- **EXIF thumbnails show the same picture as the main image** (RMSE 2–8 % after scaling both to the
  thumbnail size). So they are not a stale-crop leak, and they are kept.

### How the copies are made

Copies are made once, locally, in `~/cjoshmartin-migration/privacy/stripped/<sha1>/`, and listed in
`privacy/privacy-map.json`. Both datasets upload the same bytes, so the new asset ids are equal in
both. Making a copy again gives the same bytes; the integration test checks this.

**Images** (exiftool 13.55):

- exiftool deletes exactly the personal tags: the whole GPS IFD, the whole maker note, the whole
  `XMP-mwg-rs` namespace, and `ExifIFD:ImageUniqueID` on its own. It rewrites only metadata
  segments, never the image data.
- The check (`src/privacy/image.ts`) requires all of the following:
  - the decoded pixels are identical with two decoders;
  - the EXIF thumbnail and the MPF gain map (`IMG_9344.jpeg`) are byte-identical;
  - the ICC profile is byte-identical and the orientation is unchanged;
  - every tag that is not personal keeps its value, except offsets exiftool must move
    (`ThumbnailOffset`, `MPImageStart`);
  - a new scan finds nothing personal.
- On the 4 Android screenshots exiftool printed "Entries in IFD0 were out of sequence. Fixed." It
  writes IFD0 in tag order. Every value was compared afterwards, and that warning is the only one
  accepted.

**Video originals.** These are not remuxed with ffmpeg. Measured with ffmpeg 9.0.1, `-c copy`
(with `-map_metadata -1` and the original track timescale) kept every packet, but it:

- dropped the Dolby Vision configuration record of `IMG_3151.MOV`;
- changed the edit lists of `deep_linking.MP4` (the AAC priming packet and the last video frame
  were no longer marked as discarded);
- changed a video `duration_ts` from 9407 to 9408.

Instead, [`src/privacy/isobmff.ts`](../../../migration/wagtail-to-sanity/src/privacy/isobmff.ts)
edits the boxes in place:

- `moov/udta`, `moov/meta`, the `udta`/`meta` of kept tracks, and every track that is not `vide` or
  `soun` each become a zero-filled `free` box of the same size, so no offset changes;
- the removed tracks' samples in `mdat` are overwritten with zeros;
- anything unknown is refused rather than kept.

The check (`src/privacy/video.ts`) requires all of the following:

- the size is the same, and every byte outside the reported ranges is identical;
- every kept stream has identical packets and an identical ffprobe description (codec
  configuration, colour, side data: display matrix, DOVI record, ambient viewing environment);
- the container duration, start and bit rate are unchanged;
- only tags were removed;
- a new scan finds nothing personal and no data track.

Converting three stripped originals again (media 2, 7 and 28) gave MP4s byte-identical to the ones
in the datasets. That is why every video keeps its MP4.

| File | Found | Removed | Proof |
|---|---|---|---|
| `IMG_0070.jpeg` | location, maker notes | EXIF GPS, maker notes | pixels equal (2 decoders); orientation 6; ICC and thumbnail identical |
| `IMG_3241_copy.jpg` | location, maker notes | EXIF GPS, maker notes | pixels equal; orientation 1; ICC identical |
| `IMG_3736.jpg` | location, maker notes, id | EXIF GPS, maker notes, ImageUniqueID | pixels equal; ICC and thumbnail identical |
| `IMG_7630.jpg` | location, maker notes, id | EXIF GPS, maker notes, ImageUniqueID | pixels equal; orientation 6; ICC and thumbnail identical |
| `IMG_8414.jpg` | location, maker notes, id | EXIF GPS, maker notes, ImageUniqueID | pixels equal; orientation 6; ICC and thumbnail identical |
| `IMG_9514.jpg` | location, maker notes, id | EXIF GPS, maker notes, ImageUniqueID | pixels equal; orientation 6; ICC and thumbnail identical |
| `IMG_9344.jpeg` | maker notes, face regions | maker notes, XMP mwg-rs | pixels equal; ICC and HDR gain map (MPF) identical |
| `IMG_5861.JPG`, `IMG_9932.JPG`, `IMG_9932_copy.jpeg`, `l_9b2d….jpg` | id | ImageUniqueID | pixels equal; ICC and thumbnails identical where present |
| 4 × `Screenshot_20240517-*.png` | id | ImageUniqueID (PNG eXIf) | pixels equal; ICC identical |
| `IMG_3151.MOV` (media 7) | location, 3 data tracks | `moov/meta`, 3 `mebx` tracks (68 KB of samples zeroed) | HEVC 470 + AAC 676 packets equal; display matrix, DOVI profile 8 record, ambient viewing environment kept |
| `IMG_0169.MOV` (media 15) | location, 2 data tracks | `moov/meta`, 2 `mebx` tracks | HEVC 594 + PCM 887 packets equal; rotation kept |
| `IMG_3239.MOV` (media 10) | location, 2 data tracks | `moov/meta`, 2 `mebx` tracks | AAC 686 + H.264 476 packets equal; rotation kept |
| `IMG_6810.MOV`, `IMG_7386.MOV` (media 2, 3) | location | `moov/udta` | VP9 103/84 + AAC 151/123 packets equal |
| `export_1711667273802.MOV` (media 9) | copyright id | `moov/meta` | HEVC 1767 + AAC 2539 packets equal |
| `deep_linking.MP4`, 2 × `ScreenRecording_*.MP4` (media 27–29) | author | `moov/udta` | HEVC + AAC packets equal, edit lists untouched |

### In the datasets

For each of the 24, the step works in this order:

1. **Upload the copy.** It has the old asset's `title`, `originalFilename`, MIME type and `source`
   (Wagtail record, bucket URL). Images extract the same metadata (`blurhash`, `lqip`, `palette`) and
   never `exif` or `location`.
2. **Mark it.** The copy gets a `privacy` field in the shape the Functions read: `status: "stripped"`,
   `version` (the Functions' `image-strip-v1`/`video-strip-v1`), `removed`, `strippedFrom` (the
   deleted asset) and `updatedAt`.
3. **Move every use in one transaction.** This covers every document in the raw perspective,
   drafts and release versions included. Each patch is conditional on the document's `_rev`.
4. **Delete the old asset.** This happens only after a query and a scan of every document find no
   reference and no stored id.

Next it brings the state the later steps read up to date. It reruns the asset, video and
ASCII-art logic, which uploaded and patched nothing, and the transform. Then it moves the import
record's entries of the 6 patched migration documents to their new revisions, so the next import
does not take these patches for Studio edits. A document already edited in the Studio would have
kept its old entry. None was.

Runs (logs in `~/cjoshmartin-migration/reports/wp3/privacy/`):

| Run | Result |
|---|---|
| staging 1 (11:27 UTC) | Copies uploaded and marked, all uses moved (11:31:20). Then it **stopped before deleting**: its own check counted the new copies' `privacy.strippedFrom` as a use of the old assets. Fixed: provenance fields are recorded, never moved or counted as uses. The pending record of the patched documents survived for the next run. |
| staging 2 (11:33) | 24 deleted, state brought up to date, 6 record entries moved. |
| staging validate (11:40) | 13/13 pass |
| staging 3 and 4 (11:44, 11:53) | 0 to replace; state files and NDJSON unchanged |
| production 1 (11:46, `--confirm-production`) | 24 uploaded, 15 documents patched, 24 deleted, 6 record entries moved, in one run |
| production validate (11:50) | 13/13 pass |
| production 2 (11:53) | 0 to replace |

Local records: `privacy/runs/replaced-<dataset>-*.json` holds the replaced asset documents, the
patches, and the documents as they were before the patch. These files contain draft content, so they
stay local only. With the bucket originals, they are enough to undo the change.

### Validation changes

- **`privacy` (new).** Downloads every asset of the dataset (images with `dlRaw`) and checks each
  against its sha1. Then it requires all of the following:
  - the scan (`exiftool -ee`, tracks, STL headers) finds nothing personal;
  - no asset document holds `metadata.location` or personal `metadata.exif` keys;
  - no asset still has the bytes of an upload that has a stripped copy;
  - every copy carries its expected `privacy` field.
- **`hashes`.** An image record whose bucket file was stripped is now checked by decoded pixels: the
  downloaded asset against the Wagtail original, with both decoders. It is no longer checked by file
  sha1. Result: 98 equal to `file_hash`, 13 stripped copies with equal pixels, and 5 explained. Image
  7 (an overwritten object whose bytes are `IMG_9514.jpg`'s) is now explained through the stripped
  copy.
- **`assets` and `videos`** expect the copy's sha1 for stripped files. A stripped original must have
  the Wagtail upload's audio and video packets (compared on the downloaded asset).
- **`compare`** lists the Presentation tool's `sanity.previewUrlSecret` documents by id only and
  never reads them. Production now has 2 (preview sessions), and they hold secrets.

| Check | staging | production |
|---|---|---|
| counts, references, keys, portableText, textParity, fieldParity, asciiArt, convergence, studioValidation | pass (as before) | pass |
| assets | pass: 144 distinct assets, 24 as copies | pass |
| hashes | pass: 98 equal, 13 equal pixels, 5 explained | pass |
| videos | pass: 29/29 ready; 9 stripped originals with equal packets; 29/29 MP4s on the CDN | pass |
| privacy | pass: 176 assets downloaded and scanned, 0 personal; 24/24 copies marked; 0 unstripped left | pass: 173 assets, same |

### CDN

For the 24 replaced production assets:

- every old URL answers 404, and every new one 200;
- the scaled and converted renditions of the 15 images (`w=400`, `w=1200&fm=jpg`, `w=800&fm=webp`,
  `w=800&auto=format`) and the 9 new video files carry no personal tag.

Even before this change, the image CDN served originals re-encoded and without metadata. Only the
authenticated `?dlRaw=` download and the file URLs (videos) served the bytes with GPS.

### Functions

- **image-privacy** was deployed at 11:52:40 UTC, after both cleaning runs. It acts on images
  created on or after 2026-11-26 unless `privacy.version` is `image-strip-v1` and the status is
  `clean`, `stripped` or `failed`. The 24 copies are marked that way, and the other migrated assets
  were created on 2026-11-25.
- **Its logs (11:58 UTC) show one invocation, its own test document.** It did nothing on this
  package's documents or assets.
- **video-to-mp4** was last invoked at 10:06 UTC, before these runs. The patched video blocks keep
  `file == conversion.outputAssetId`, so its filter does not match them.
- **testimonial-ascii-art** was not invoked, because no testimonial was touched.

### Code (`migration/wagtail-to-sanity/`)

| Path | Change |
|---|---|
| `src/privacy/rules.ts` | The rules above, STL header check |
| `src/privacy/exiftool.ts`, `scan.ts` | Scanning (exiftool, tracks, STL), exiftool tag removal |
| `src/privacy/image.ts` | Image strip and its verification (pixels with two decoders, embedded images, ICC, orientation, every tag) |
| `src/privacy/isobmff.ts`, `video.ts` | In-place ISO BMFF/QuickTime box stripper; packet and stream verification |
| `src/privacy/copies.ts` | Copies and `privacy/privacy-map.json`; deterministic, re-verified on every use |
| `src/privacy/repoint.ts` | Finds and moves asset-id uses (references, `asciiArtSource`, `conversion.*AssetId`, MP4 `source.id`); refuses unknown places |
| `src/privacy/marker.ts`, `download.ts` | The `privacy` field (from the Functions' `studio/functions/privacy/constants.ts`); checked downloads |
| `src/steps/privacy.ts` | Step `privacy` (after `extract`): copies, inventory, replace, delete, state and import record |
| `src/steps/assets.ts`, `videos.ts` | Upload the stripped copy (never a file with personal metadata) with the `privacy` field; refuse without a current privacy map |
| `src/steps/validate.ts` | New `privacy` check; pixel- and packet-based checks for copies |
| `src/import-guard.ts` | `updateRecordAfterPatch` |
| `src/compare.ts`, `src/comparison.ts` | `sanity.previewUrlSecret` listed, not compared |
| `test/privacy.test.ts`, `test/privacy.integration.ts` | 24 unit tests, plus 7 tests with the real exiftool, ffmpeg and ImageMagick. These cover finding, stripping and verifying a photo, a PNG and a rotated video with a location and a timecode track; rejecting re-encoded or over-stripped copies; and determinism |

`npm test`: 96 of 96 pass. `npm run test:ffmpeg`: 12 of 12. `npm run typecheck`: clean. ImageMagick and
exiftool are now required tools (README).

### Open

1. **Policy difference with the image-privacy Function (owner decision).** The Function strips new
   uploads much harder: all EXIF except orientation, all XMP, thumbnails, HDR gain maps and PNG
   text. The migrated assets follow the owner's list, so they keep camera make and model, software,
   capture times, XMP "Screenshot" comments, EXIF thumbnails and gain maps. The Function's date
   cutoff leaves them alone. If the owner wants the stricter policy for existing assets too, the
   rules here have to change. Rerunning the step then replaces those assets the same way.
2. **Unstripped bytes outside the datasets.** This package did not touch them:
   - the public bucket `images-for-cms` (until the WP6 lockdown);
   - backups made before today (WP5);
   - the local mirror `~/cjoshmartin-migration/gcs/`.
3. **Staging test data of the image-privacy package:** the 3 probe images (`privacy-format-probe-t.*`)
   and its live-test drafts. They make `compare` and staging's counts differ until that package
   removes them.
4. **This package imports `studio/functions/privacy/constants.ts`** for the marker's field name and
   versions. That file belongs to the image-privacy package, which must commit it.
