# WP3a: Wagtail → Sanity migration into `staging`

Package: [`migration/wagtail-to-sanity/`](../../../migration/wagtail-to-sanity) (Node 24, run with tsx).
Target: project `j3vdh6ti`, dataset **`staging`**. Production was not touched.

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

## How to run

```sh
cd migration/wagtail-to-sanity && npm ci
npm run migrate -- --dataset staging            # whole pipeline, rerunnable
npm run migrate -- --dataset staging --allow-pending-videos   # what ran tonight (staging only)
```

Steps: `extract → assets → mux → ascii → transform → import → validate`. The package
[README](../../../migration/wagtail-to-sanity/README.md) describes each one.
`--dataset production` also needs `--confirm-production` and rejects `--allow-pending-videos`.

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
