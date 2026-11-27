# cjoshmartin.com: Wagtail → Sanity migration plan

Status: **approved**, built and verified (see the morning report) · Written 2026-11-26 · Amended
2026-11-26 (Mux dropped; personal metadata stripped from every asset, D17; datasets recreated to
drop their public edit history, D18)

> **Amended 2026-11-26: both datasets recreated to drop their public edit history (owner
> decision, D18).** The History API of a public dataset returns the earlier revisions of published
> documents and asset documents to anyone who has the id, for the dataset's retention period (90
> days here). After D17 it still served the documents of the deleted unstripped assets and the
> copies' earlier revisions that named them. So on 2026-11-26 both datasets were deleted and
> created again as public datasets from verified exports (staging import from 20:40:54 UTC,
> production from 21:00:07 UTC), with the Functions removed during the import and deployed again
> after it. Since then the History API knows none of the deleted ids, and the asset CDN served none
> of the 670 deleted paths probed from this machine. What new history can contain is in D18 and
> §15.
>
> D16, D18, §11 (new item 12), §12 (test 30a), §13, §14, §15 and §16 are updated in place. The
> reports are
> [`dataset-recreate.md`](sanity-migration/reports/dataset-recreate.md) (the run, two fix rounds
> and the current state) and
> [`recreate-verification.md`](sanity-migration/reports/recreate-verification.md); the rules are
> "Document history" in the contract's Privacy section.

> **Amended 2026-11-26: location and personal metadata stripped (owner decision, D17).** Every
> asset the public datasets serve is stripped of GPS/location and personal metadata **without
> re-encoding**: photos keep their pixels, orientation and ICC profile; video originals keep their
> video and audio samples byte for byte, with rotation, colour, HDR and Dolby Vision. The migration
> replaced 99 of the 173 assets of each dataset (70 images, 29 video originals) with checked
> copies and deleted the unstripped ones; the other 40 images were checked and marked `clean`.
> Every later upload is stripped by Sanity Functions (`image-privacy`, `upload-privacy`, and
> `video-to-mp4`, which strips before it converts), and the unstripped upload is deleted once
> nothing references it. The old bucket `images-for-cms`,
> and the live Wagtail site that links to it, still serve the unstripped originals publicly until
> teardown step 6; the owner chose that timing.
>
> D16, D17, §2, §4, §5, §8, §9, §10, §11 (new item 11), §12 (tests 30 and the new 30a), §13, §14,
> §15 and §16 are updated in place. The rules are in "Privacy (location and personal metadata)" in
> [`schema-contract.md`](sanity-migration/schema-contract.md#privacy-location-and-personal-metadata);
> the reports are
> [`privacy-functions.md`](sanity-migration/reports/privacy-functions.md),
> [`wp3-migration.md`](sanity-migration/reports/wp3-migration.md) (last section),
> [`privacy-verification.md`](sanity-migration/reports/privacy-verification.md) and
> [`privacy-review.md`](sanity-migration/reports/privacy-review.md).

> **Amended 2026-11-26: Mux dropped (owner decision).** Every video is stored in Sanity as an MP4
> file asset, converted with the fixed settings in `studio/functions/video-to-mp4/settings.ts`
> (H.264 High, CRF 23, longest side at most 1920 px, AAC 128 kb/s stereo when there is audio,
> faststart; `SETTINGS_VERSION` `h264-crf23-max1920-v2`). The original upload is kept as a hidden,
> read-only reference that is never served. The migration converted the 29 Wagtail videos, and the
> `video-to-mp4` Sanity Function converts every video uploaded in the Studio. The Mux assets, the
> `mux.videoAsset` documents, the Mux plugin, player and backup code are deleted.
>
> D7, D16, §2, §4, §5, §7.1, §8, §9, §10, §11, §12 (tests 26 and 30), §13, §14, §15 and §16 are
> updated in place. Wherever Mux is still named below, it is history and is struck through or
> marked **superseded**. The contract is "Videos (video contract v2)" in
> [`docs/sanity-migration/schema-contract.md`](sanity-migration/schema-contract.md); the current
> state and the owner's remaining steps are in
> [`docs/sanity-migration/morning-report.md`](sanity-migration/morning-report.md).

## 1. Goal

Retire the Django/Wagtail backend (`backend.cjoshmartin.com`, Dokku on 159.203.93.178) and the GCS media bucket (`images-for-cms`) as content sources. Move every page, snippet, image, document, and video into a new Sanity project. The Next.js frontend reads from Sanity. A weekly GitHub Actions job backs up the Sanity dataset to a private GCS bucket, and only writes a backup when the data has changed.

Success means:
- Every route on cjoshmartin.com renders the same content from Sanity.
- Editing happens in a hosted Sanity Studio with Visual Editing.
- The backend is archived and shut down.
- Backups run unattended.
- Nothing ever depends on the old backend again.

## 2. Inventory (measured 2026-11-26)

| Item | Count / size | Notes |
|---|---|---|
| Live pages | 23 | 1 home, 2 flex (`portfolio`, `blog`), 13 projects, 7 blog posts. Wagtail page IDs go up to 43, so drafts and unpublished pages exist. |
| Snippets | authors, testimonials (9 shown on home), services | Some snippets may not be attached to any page. The export will show this. |
| Bucket total | 430 MB | `original_images/` 110 files (108 MB), `images/` renditions (23 MB, derived, not migrated), `media/` 29 videos (261 MB), `documents/` 5 (3 STL, 2 resume PDFs), plus Django static dirs (not content). |
| Referenced by live pages | 34 original images, 46 rich-text image renditions, 29 videos, 2 STL files | Unreferenced: 76 original images, 1 STL (`nerf-gun-trigger_v37.stl`), 2 resume PDFs |
| Videos | 29 files, about 11 min total | Codecs: h264, HEVC, VP9. Containers: .mov, .MP4, .webm. Resolutions up to 3420×2080. |
| Rich text | `p`, `h2`–`h4`, `ul`/`ol`/`li`, links, `b`, `br`, `hr`, 47 inline images, 9 YouTube embeds | No heading has an id. Anchors are generated from heading text on the frontend. |
| Disqus | comment threads keyed on the **numeric Wagtail page id** | Must be preserved. |
| Frontend | Next 16.3, React 19.2, on Vercel (GitHub `cjoshmartin/cjoshmartin-frontend`, public; it moved from the `cjoshmartin-com` organization, same repository id `737918690`, and the old path only redirects) | DNS is GoDaddy (`domaincontrol.com`). |
| Backend repo | local + Dokku remote only, **no GitHub** | `secrets.json` (GCP service-account key) is committed in 4 commits. |
| Personal metadata (measured 2026-11-26, added with D17) | 11 content files with a location: 6 photos with EXIF GPS, 5 iPhone videos with a QuickTime location (2 of them also in an iOS draft movie header inside `mdat`) | Most phone files also carry maker notes, serials and unique ids, camera and device models, capture times, face regions or timed-metadata tracks. Under the D17 policy, 99 of the 173 Sanity assets of each dataset had something to remove (70 images, 29 video originals); the 29 MP4s, 3 STL models and 2 PDFs had no location. |

The full frontend data contract is in §6. It comes from a file-by-file audit of every field the frontend reads.

## 3. Decisions (all confirmed with Josh)

| # | Topic | Decision |
|---|---|---|
| D1 | Sanity account | A **different Sanity login** from `josh@loopcamera.store`. Josh runs `sanity login` tonight. A new project is created there, on the Free plan, with datasets `production` and `staging`. Free plan datasets are public: only published documents can be read without a token. |
| D2 | Extraction | A new **Wagtail admin plugin**, "Export for Sanity". Josh deploys it to Dokku and clicks Export tonight. |
| D3 | Studio | **Standalone**, deployed to `<name>.sanity.studio` (auto-updates on). Code lives in `studio/` in the frontend repo. |
| D4 | Preview | **Visual Editing**: Presentation tool, Next draft mode, `defineLive`. |
| D5 | Backups | **Private GCS bucket** in `com-cjoshmartin`, region us-central1, sized to stay in the always-free tier. Content-addressed asset store. Code is written and tested overnight. The bucket and access are provisioned in the morning. |
| D6 | Cron | **GitHub Actions**, weekly, with a keepalive so the 60-day inactivity rule never disables it. |
| D7 | Videos | **Videos are Sanity file assets converted to MP4 (H.264 CRF 23, max 1920 px, AAC, faststart) by the `video-to-mp4` Sanity Function on every upload; originals kept hidden; Mux dropped.** The 29 Wagtail videos were converted with the same settings by the migration. Decided 2026-11-26; it replaces ~~Mux via `sanity-plugin-mux-input`, basic quality, public playback~~ (superseded). |
| D8 | Testimonial ASCII art | A **Sanity Function** regenerates it whenever a testimonial image changes. The migration uses the same generator code. |
| D9 | Existing bugs | **Fix all of them** in the rewrite (§7.3). Each one gets a manual test. |
| D10 | Decommission | Archive the backend code to a **private, archived** GitHub repo (with `secrets.json` scrubbed from history). Take a final Postgres dump and copy it, plus the Wagtail export, into the backup bucket. Destroy the Dokku app and its Postgres. Remove the `backend` DNS record. Remove all backend code from the frontend. |
| D11 | GCS images bucket | **Keep it, make it private, and revoke the leaked key.** Disable public access on `images-for-cms` and delete the user-managed keys of `file-upload-2024@com-cjoshmartin`. Nothing gets deleted. |
| D12 | Rollout | Overnight work ends at a **PR plus a Vercel Preview** pointed at the production dataset. Josh runs the manual tests (§12) in the morning, then merges. Teardown runs only after Josh says go. |
| D13 | Tags | `medium` and `technology` become **reference documents**. Duplicates that differ only by case or whitespace are merged, and every merge is listed in the report. |
| D14 | Scope | **All content and all files.** Every page and snippet migrates. Unpublished pages and pending changes become Sanity drafts. Every content file in the bucket is uploaded, including unreferenced ones. Renditions and Django static files are excluded. |
| D15 | `/about` | Redirects to `/` permanently. |
| D16 | Overnight pre-approvals | Josh pre-approved: Sanity project setup and writes, ~~Mux uploads~~ (superseded: Mux dropped), pushing a GitHub branch and opening a PR (never merging), and Vercel **Preview-scoped** env vars. Everything irreversible waits for the morning. On 2026-11-26 Josh also approved dropping Mux: deleting the Mux assets and the `mux.videoAsset` documents, removing the Mux code, and deploying the `video-to-mp4` Function. Later that day, with D17, he approved replacing assets in both datasets with stripped copies, deleting an unstripped asset once it is replaced and nothing references it (raw perspective, drafts and versions included), and deploying the privacy Functions; with D18, deleting and creating both datasets again from verified exports, with the Functions removed during the import and deployed again after it. |
| D17 | Personal metadata | **All personal metadata is stripped losslessly from every asset, existing and future, by the Functions' strippers; an unstripped upload is deleted once its copy replaces it.** Decided 2026-11-26. The existing assets were stripped by the migration's `privacy` step with the same strippers (`studio/functions/privacy/`), every upload is stripped by the `image-privacy`, `video-to-mp4` and `upload-privacy` Functions. Photos: pixels untouched (no recompression), orientation and ICC profile kept; GPS, location, maker notes, serials, unique ids, device and capture data, people, comments, XMP/IPTC and EXIF thumbnails removed. Video originals: video and audio samples byte for byte (rotation, colour, HDR and Dolby Vision kept); location, QuickTime keys and user data, timed-metadata (`mebx`) and other data tracks, creation times, handler names and unused `mdat` bytes removed. Converted MP4s and resized CDN images carry no metadata. Nothing in the repository asks Sanity to extract EXIF, camera or location data from an upload (`uploadAsset`, a guard test). Not covered yet: PDF and STL metadata, and capture dates in file names (owner decisions). The old bucket `images-for-cms` keeps serving the unstripped originals publicly until teardown step 6 (the owner chose that timing; D11). The full policy is in the contract's "Privacy" section. |
| D18 | Public edit history | **Both datasets were deleted and created again from verified exports on 2026-11-26, to drop their public edit history.** Decided 2026-11-26, after D17. The History API of a public dataset returns earlier revisions of published documents and asset documents without a token to anyone who has the id, for the retention period (90 days, the datasets' `_.retention._maximum_project`); listing a document's transactions needs a token. Before the recreate it still served the deleted unstripped assets' documents (344 of 356 deleted ids readable on staging, 192 on production); after it, none. From now on it records every change again, so for 90 days it can hold: the first revision of every upload, including an unstripped one, for the seconds to a minute before a Function replaces and deletes it (file name, sha1, size and previews made from the same pixels as the copy; a Studio upload extracts no EXIF, camera or location data); location, EXIF or camera data that an API client outside the repository asks Sanity to extract (upload-privacy removes it from the asset document within seconds and logs a WARN, but the first revision keeps it); and the earlier revisions of anything withdrawn later. Removing such history again takes another recreate, a `purge` delete (needs the `editHistory` permission, an Enterprise custom role) or private datasets (owner decisions). |

### Defaults I'm choosing (say so before approving if you want something different)

- **Project and Studio names:** Sanity project "cjoshmartin.com". Studio hostname `cjoshmartin` (falls back to `cjoshmartin-com` if taken).
- **`/admin`** redirects to the Studio URL.
- **Service link text:** `link_text` is rich-text HTML in Wagtail but is only ever used as a link label. It becomes a plain string. Any formatting lost in the conversion is listed in the report.
- **Footer:** the "Django" and "Wagtail" credits become a "Sanity" credit.
- **Backup schedule:** Sundays 09:00 UTC, plus a manual "Run workflow" button.
- **Backup retention:** keep every snapshot. The workflow fails, which emails you, if the bucket grows past 4 GB.
- **What counts as "changed" for backups:** any document, draft, or asset added, edited, or deleted.
- **Branch:** `sanity-migration` in the frontend repo.
- **Frontend commits:** no AI co-author trailer, per the frontend's `CLAUDE.md`.

## 4. Target architecture

```
Sanity Studio (cjoshmartin.sanity.studio, code in studio/)
   │  edits                    ▲ Presentation tool iframes the site
   ▼                           │
Sanity Content Lake  ──────────┤  dataset: production (staging = rehearsal + restore tests)
   │  ├─ images/files on cdn.sanity.io (each video = converted MP4 + kept original, both file assets;
   │  │    every asset stripped of location and personal metadata, D17)
   │  ├─ Function: video-to-mp4 (on a video upload: strip the original in place → ffmpeg → MP4)
   │  ├─ Function: image-privacy (on an image change: lossless copy without metadata, repoint, delete)
   │  ├─ Function: upload-privacy (on an asset upload or a document deletion: unused uploads)
   │  └─ Function: testimonial-ascii-art (on image change)
   ▼
Next.js on Vercel (defineLive + draft mode + VisualEditing; <video> plays the MP4 from cdn.sanity.io)
   ▲  POST /api/revalidate  ◄── Sanity webhook (set up after the merge)
GitHub Actions weekly ──► private GCS bucket cjoshmartin-sanity-backups (snapshots + content-addressed assets)
```

Amended 2026-11-26: there is no Mux. Videos are served from Sanity's CDN like every other file.
The Free plan's datasets are public (D1), so every asset is stripped before it stays in a dataset
(D17).

## 5. Sanity content model

Every migrated document has a `legacy` object:

| Field | Meaning |
|---|---|
| `wagtailId` | Wagtail page or snippet id |
| `wagtailType` | Wagtail model |
| `wagtailUrlPath` | page path in the Wagtail tree |
| `firstPublishedAt`, `lastPublishedAt` | Wagtail publish timestamps |

`legacy` is hidden in a Studio "Migration" group and kept permanently. It is used for Disqus, QA, and debugging.

### Document IDs

IDs are deterministic, so reruns converge:

| Document | ID |
|---|---|
| Home page | `homePage` (singleton) |
| Author | `person-<id>` |
| Testimonial | `testimonial-<id>` |
| Service | `service-<id>` |
| Blog post | `blogPost-<pageId>` |
| Project | `project-<pageId>` |
| Flex page | `flexPage-<pageId>` |
| Medium tag | `medium-<slug>` |
| Technology tag | `technology-<slug>` |
| Redirect | `redirect-<id>` |
| Drafts | the same id with a `drafts.` prefix |

Assets get Sanity's own content-hash IDs. Videos are file assets too (the converted MP4 and the kept
original), so there are no video documents. (Until 2026-11-26 each Mux video had a
`mux-video-<mediaId>` document; superseded, and all of them are deleted.)

(Added 2026-11-26, D17.) A stripped copy gets a new content-hash id, so stripping replaces an asset:
the copy is uploaded, every reference moves to it, and the unstripped asset is deleted. Asset
documents carry a `privacy` field: `status` (`stripped`, `clean`, `replaced`, `processing`,
`pending` or `failed`), the stripper `version` (`image-strip-v1`, `video-strip-v2`), what was
`removed` (names only) and `strippedFromDigest`, a keyed HMAC of the upload's id. A copy never
names the deleted upload, because an asset id is its CDN path. Migrated copies keep `source:
{name: "wagtail", id}` without `url` (that URL is the unstripped bucket object).

### Document types

| Sanity type | Comes from | Fields |
|---|---|---|
| `homePage` (singleton) | `home.HomePage` | `title`, `bio` (PT), `author` → person, `testimonials[]` → testimonial (ordered), `services[]` → service (ordered), `seo` |
| `person` | `home.Author` | `firstName`, `lastName`, `image` (hotspot + alt), `location`, `jobTitle`, `bio` (PT), `email`, `github` |
| `testimonial` | `home.Testimonial` | `firstName`, `lastName`, `image`, `jobTitle`, `relationship`, `link`, `body` (PT); `asciiArt` (read-only, generated) and `asciiArtSource` (asset id it was generated from) |
| `service` | `home.Service` | `title`, `image`, `description` (PT), `link`, `linkText` (string), `audience` (`DEV` or `MAK`) |
| `blogPost` | `blog.BlogPage` | `title`, `slug`, `date`, `intro`, `isUnlisted`, `audience` (`DEV`/`MAK`), `author` → person, `heroMedia[]` (image or youtube), `contentImage`, `body` (PT), `seo`, `legacy` |
| `project` | `blog.ProjectPage` | All `blogPost` fields, plus `projectType` (`CLI`/`PER`), `previewImage`, `client`, `website`, `mediums[]` → medium, `technologies[]` → technology, `testimonials[]` → testimonial |
| `flexPage` | `flex.FlexPage` | `title`, `slug`, `body` (PT), `seo`, `legacy` |
| `medium`, `technology` | taggit tags | `title`, `slug` |
| `redirect` | `wagtail.contrib.redirects` | `source`, `destination`, `permanent` |

The `DEV`/`MAK` and `CLI`/`PER` codes stay as stored values, with human-readable titles in Studio. That way existing URLs like `/projects?project_type=PER` keep working.

**Objects:**
- `seo`: `title`, `description`. Replaces `seo_title` and `search_description`.
- `youtube`: `url`.
- `imageBlock`: `image`, `alt`, `caption`, `layout` (`fullwidth`, `left`, or `right`).
- Every image field and type (amended 2026-11-26, D17) accepts JPEG, PNG, WebP, GIF, AVIF and TIFF
  only (the formats that can be stripped losslessly) and asks Sanity to extract only `blurhash`,
  `thumbhash`, `lqip` and `palette`, never `exif`, `image` (camera) or `location`.
- `codeBlock`: uses `@sanity/code-input`, with the language list `python, javascript, json, css, markup, html, go, bash, yaml, cpp`.
- `stlModel`: `file` (`.stl` only), `scale` (an integer from 1 to 1000).
- `video` (video contract v2, amended 2026-11-26; it was ~~`asset` (`mux.video`)~~, superseded):
  - `file`: the file the site plays (`accept: "video/*"`, required); after conversion, the MP4
  - `original`: the file as uploaded, stripped of location and personal metadata in place (D17);
    read-only, hidden while empty, kept but never linked by the site (like every file of a public
    dataset, anyone who finds its URL can download it)
  - `conversion` (read-only): `status` (`pending`, `processing`, `ready` or `failed`), `message`,
    `sourceAssetId`, `outputAssetId`, `settingsVersion`, `originalStripped` and `stripVersion`
    (added with D17), `updatedAt`
  - a block needs conversion when `file.asset._ref` is set and differs from
    `conversion.outputAssetId`
  - an upload the strippers cannot handle is taken out of the block (`file` and `original` unset,
    `conversion` `failed` with a message and no asset id) and deleted (D17)
- `divider`.

**PT annotations:**
- `link`: `href`, `openInNewTab`.
- `internalLink`: a reference to `blogPost`, `project`, `flexPage`, or `homePage`.
- `fileLink`: a reference to a file asset; PDF only since 2026-11-26 (D17: a photo or video attached
  as a file would be served exactly as uploaded).

### Rich text and StreamField mapping

The source is Wagtail's **database-format** rich text, taken from the export rather than the API's expanded HTML. That format names images, pages, and documents by Wagtail id, so no URL guessing is needed.

The conversion uses `@portabletext/block-tools` with JSDOM and custom rules:

| Wagtail source | Sanity |
|---|---|
| `<p>`, `<h1>`–`<h6>`, nested `<ul>`/`<ol>` | `block` styles and list items |
| `b`/`strong`, `i`/`em`, other inline marks (only if present) | decorators |
| `<br>` | soft line break |
| `<hr>` | `divider` |
| `<embed embedtype="image" id format alt>` | `imageBlock`, with the original image uploaded (renditions ignored) |
| `<embed embedtype="media" url>` | `youtube` |
| `<a href>` | `link` |
| `<a linktype="page" id>` | `internalLink` |
| `<a linktype="document" id>` | `fileLink` |
| Anything else | logged as a quality issue; the transform fails unless it's on the allowlist |

The StreamField `body` (`full_richtext`, `code`, `stl_picker`, `media`) becomes **one PT array**. The rich-text blocks are expanded in place, and the custom blocks keep their original order.

`content_visuals` becomes `heroMedia[]`. `<embed embedtype="media">` values in `content_visuals` become `youtube`.

## 6. Frontend data contract (what must keep working)

| Area | What it needs |
|---|---|
| **Home** | Bio HTML. The first author's image (`file`, `width`, `height`, `title`), name, job title, location, email, GitHub. Testimonials, rotated randomly every 30 s, with ASCII art that reveals the photo on hover. Services filtered by `DEV`. Portfolio previews: the 3 newest listed `CLI` projects and the 3 newest listed `PER` projects. |
| **Projects list** | Filters by `project_type`, `medium`, and `technologies` query params. Top-10 tag counts. Thumbnail is `contentImage`, then `previewImage`, then the first hero image. If a project has a website and no body, its card links out to the website. |
| **Project detail** | Unlisted banner. Hero (image or YouTube). Client, mediums, technologies. Testimonials. Body. Disqus. |
| **Blog list and detail** | Hero image. Read time (200 wpm over rich text plus code lines). Outline built from headings, with anchor ids made by slugifying heading text. Author box with bio. Code highlighting (Prism, gruvboxDark, line numbers). STL viewer (three.js, `file.url`). Video (autoplay, loop, muted, plays inline, controls). Recommended posts (3 newest, excluding the current one). Disqus. |
| **`/flex/[slug]`** | Title plus body. |
| **`/screen`** | Projects, with each one's first testimonial with the image hidden. |
| **Metadata and sitemap** | Title, description, og:image, canonical, `publishedTime`, keywords. |

## 7. Frontend changes (branch `sanity-migration`)

### 7.1 New and replaced

**Data layer**
- `sanity/lib/{client,live,image,queries,token}.ts`, using next-sanity `defineLive` and `defineQuery`.
- `sanity.types.ts`, generated by TypeGen from `studio/sanity.cli.ts`.
- (Added 2026-11-26.) Every `sanityFetch` result carries the `sanity-content` cache tag. A signed
  `POST /api/revalidate` (a Sanity webhook with `SANITY_REVALIDATE_SECRET`, set up after the merge)
  expires it, so content that changes while nobody has the site open (a publish, a finished video
  conversion, a migration run) is not served from the cache.

**Rendering**
- The `HtmlGenerator`/`RichTextArea` pair is replaced by a `PortableTextBody` component (`@portabletext/react`). It handles block, `imageBlock`, `youtube`, `codeBlock` (existing `CodeArea`), `stlModel` (existing lazy STL viewer), `video`, and `divider`.
- `video` (amended 2026-11-26; it was ~~`@mux/mux-player-react`~~, superseded) is a native `<video autoPlay loop muted playsInline controls preload="metadata">` with one `<source type="video/mp4">`: the block's converted MP4 from `cdn.sanity.io`. The query returns a URL only when the block is `ready` and `file` is its MP4, so a block that is still converting, or whose conversion failed, renders nothing. `original` is never queried.
- One shared heading-id utility is used by both the renderer and the outline. It keeps today's slug algorithm so existing `#anchors` keep working, and adds de-duplication.
- `CalculateReadTime` and `getOutlineHeaders` are rewritten to work on Portable Text instead of HTML.

**Page by page**
- **Home, intro, testimonials, services:** read Sanity shapes. Images go through `@sanity/image-url`.
- **Testimonial ASCII art:** read from the `asciiArt` field.
- **Comments:** Disqus `identifier` is `String(legacy.wagtailId)` for migrated documents and `_id` for new ones. The Disqus URL is unchanged.

**Preview and editing**
- `/api/draft-mode/enable` and `/disable` routes.
- `<SanityLive/>` plus `<VisualEditing/>` (only in draft mode) in the root layout.
- Stega is turned off in `generateMetadata` and the sitemap.

**Config and redirects**
- `next.config.js`:
  - add `cdn.sanity.io` to the allowed image hosts (~~and `image.mux.com`~~, removed with Mux on 2026-11-26)
  - remove `storage.googleapis.com/images-for-cms`, `45.55.48.61`, and `nyc3.digitaloceanspaces.com`
  - redirects: `/about` → `/`, plus `redirect` documents from Sanity (only if the export contains Wagtail redirects)
- `/admin` redirects to the Studio URL.

### 7.2 Removed (backend code)
- `app/components/api/pages.ts`
- `app/api/pages/get-page-from-slug/`
- `app/preview/route.ts`
- `app/components/defaulturl.tsx`, `generateURL.ts`, `getHost.ts`
- `PageTypes.tsx`, if nothing else uses it
- The `/blog/preview` and `/projects/preview` slug special cases
- The Django and Wagtail footer credits

Existing comments are kept, per `CLAUDE.md`, unless they describe code that is deleted in the same change.

### 7.3 Bug fixes (each has a manual test in §12)

1. Unlisted posts and projects are excluded from the blog list, recommended posts, `/screen`, and the sitemap. They stay reachable by direct URL, with a banner.
2. The meta description uses `seo.description`, falling back to `intro`. It no longer uses the SEO title.
3. Query params on `/` (e.g. `?utm_source=x`) no longer switch the home page into preview mode or crash it. Preview is driven only by draft mode.
4. The sitemap base URL is `https://cjoshmartin.com`. `lastModified` uses `_updatedAt` (previously a typo meant the date was never used). Flex pages stay out of the sitemap, as today.
5. An unknown slug returns a real 404 via `notFound()`, not a 500. Slug lookups are filtered by document type.
6. The flex page queries Sanity directly. Nothing is built from the referer header.
7. Preview no longer logs tokens. The `/preview` route is deleted.
8. Crash guards:
   - the home page no longer crashes on `author.image.width` when the author has no image
   - `intro.trim()` no longer crashes when `intro` is null
   - `CalculateReadTime` no longer crashes when `body` is undefined
9. Blog pages no longer read fields that blog posts don't have (`technologies`, `previewImage`).
10. Heading anchors are unique within a page. The old per-block counter could produce colliding fallback ids.
11. Content updates appear within seconds of publishing (`defineLive`), instead of the old one-hour cache.

### 7.4 Repo layout and rules
- `studio/`, `migration/`, and `scripts/` each have their own `package.json`.
- The root `tsconfig.json` excludes and the ESLint ignores cover those three directories.
- Vercel builds only the Next app.
- Every agent reads `node_modules/next/dist/docs/` before writing Next code (`AGENTS.md`), and follows `CLAUDE.md`: no co-author trailers, and keep comments.

## 8. Studio (`studio/`)

**Plugins and config**
- `structureTool` with a custom structure: Home singleton, Blog posts, Projects, Flex pages, People, Testimonials, Services, Tags (medium and technology), Redirects.
- `presentationTool`:
  - `previewUrl` is `https://cjoshmartin.com`, with `previewMode.enable` pointing at `/api/draft-mode/enable`
  - `allowOrigins` covers localhost and `*.vercel.app`
  - `resolve.locations` maps each document type to its route
- `visionTool`, `codeInput`. (~~`muxInput`~~ and its Videos tool were removed on 2026-11-26, superseded.)
- (Added 2026-11-26.) The `video` block preview shows the file name and the conversion state:
  "Converting to MP4...", "Waiting to retry the conversion", "Ready" or "Conversion failed".
  `VideoConversionWatcher` (`studio/components/`) is the root input of every document type that can
  hold a video. While a document's form is open, it checks the draft and the published document
  every minute and restarts a stuck conversion.
- (Added 2026-11-26, D17.) Under every image, `ImagePrivacyInput` shows live what the image-privacy
  Function is doing ("Checking...", "Removing location and camera data...", "Location and camera
  data removed", a retry warning, or an error). A ready video block's subtitle adds "Original kept
  without location data"; a block whose upload could not be stripped shows "Upload removed: ...".

**Validation**
- Required fields, and slugs unique per type.
- `scale` between 1 and 1000.
- `.stl` only for STL files.
- Alt text warnings on images.
- (Added 2026-11-26.) A `video` needs a `file` whose asset is a `video/*` file. A conversion that
  failed for the current file under the current settings is an error, so the document cannot be
  published until the editor replaces or removes the video.
- (Added 2026-11-26, D17.) Errors: an image whose format cannot be stripped losslessly (not JPEG,
  PNG, WebP, GIF, AVIF or TIFF), an image whose personal metadata the image-privacy Function could
  not remove (`privacy.status` `failed`: the file stays public with that data while a document uses
  it), a `fileLink` that is not a PDF, and a video block whose upload was removed. Warnings: an
  image whose stripping is still pending or waiting to be retried.

**Deploy**
- `sanity deploy` with `autoUpdates: true`.
- CORS origins: `http://localhost:3000`, `https://cjoshmartin.com`, `https://www.cjoshmartin.com`, `https://*.vercel.app`, with credentials only where Presentation needs them.

**Function `testimonial-ascii-art`** (Blueprint in `studio/`)
- **Trigger:** `create` and `update` on `_type == "testimonial"`, only when the image changed (`delta::changedAny(image.asset)`, or `asciiArtSource` doesn't match the current asset).
- **What it does:**
  1. Requests a tiny PNG from the Sanity image CDN at the 35-column grid size.
  2. Decodes it in pure JavaScript (`pngjs`).
  3. Applies the brightness floor (8).
  4. Maps pixels to characters with an exact port of `ascii-magic==2.3.0` `to_html(columns=35)`: same character ramp, same width ratio, same `<span style="color:#rrggbb">` and `<br>` markup.
  5. Patches `asciiArt` and `asciiArtSource`.
- **Recursion guard:** the function's own patch doesn't change the image, so it doesn't retrigger.
- **Shared code:** the generator is a separate module that the migration also imports.

**Function `video-to-mp4`** (same Blueprint, added 2026-11-26; code and tests in
`studio/functions/video-to-mp4/`, design in `docs/sanity-migration/reports/a2-video-function.md`)
- **Trigger:** `create` and `update`, drafts included, in `production` and `staging`, on a document
  with a `video` block that needs conversion, in the fields that offer the block (`body` of blog
  posts, projects, flex pages and testimonials, `bio` of the home page and people, `description` of
  services). Skipped: a block already `processing` for its current file (for less than 20 minutes),
  one that `failed` for its current file under the current settings, and a retryable `pending`
  whose 10-minute back-off has not passed.
- **Runtime:** 10 GB memory, 900 s timeout (ffmpeg is stopped 60 s before), `nodejs24.x`, and a
  bundled static ffmpeg 7.0.2 for linux/arm64 (`ffmpeg-static` 5.3.0, sha256 checked before use).
  Sized by the spike (`reports/video-spike.md`): its worst case, 60 s of rotated 4K 10-bit HEVC
  (211.5 MB), converts in about 54 s.
- **What it does, one block per run:**
  1. Takes a lease on the upload's asset document (`videoToMp4Lease`, revision-checked), so one
     upload is never converted twice at the same time.
  2. Marks the block `processing`.
  3. Reuses an MP4 already made from that upload with the current settings, if there is one.
     Otherwise it converts with `buildFfmpegArgs` (preset `medium`), checks the MP4 (H.264 High,
     yuv420p, exact size, audio rule, `moov` before `mdat`, every decoded frame of the upload at its
     own time, a full decode), and uploads it as `<original base name>.mp4`, `video/mp4`, with
     `source: {name: "video-to-mp4", id: <upload _id>}` and `videoToMp4SettingsVersion`.
  4. Writes `ready` (`file` = the MP4, `original` = the upload) to every draft or published block
     that still uses that upload, then releases the lease.
  - A video that cannot be converted gets `failed` with a message. A problem that is not the
    video's fault (a download, the API, the deployed binary) gets a retryable `pending`.
- **Recursion guard:** each patch it writes leaves the block converted, `processing`, `failed` or
  `pending` for its current file, which the filter skips.
- **Privacy (amended 2026-11-26, D17).** Before converting, the Function strips the upload: in
  place for QuickTime/MP4 (metadata boxes, data tracks and their samples, creation times, handler
  names and every unused `mdat` byte become zeros or `free` boxes of the same size, so every
  sample, edit list, time stamp, display matrix, colour, HDR and Dolby Vision box stays byte for
  byte), and with an ffmpeg stream copy for other containers. ffmpeg then checks that every packet
  and every stream description is unchanged. The copy (`source.name` `video-to-mp4-original`) is
  converted and becomes `original`; an upload with nothing personal is kept (`clean`). Once the copy
  exists the block leaves the upload whatever the conversion does (`failed` and `pending` point
  `file` at the copy), and the upload is deleted once nothing references it. An upload that cannot
  be stripped (larger than about 480 MB for `/tmp`, refused by both strippers, a failed check) is
  taken out of every block and deleted, with a message. The Function runs on release versions too
  (`includeAllVersions`) and never writes a version whose release is locked. It reads every upload
  with its token and a unique query parameter, so unstripped bytes never enter the public CDN cache
  under the guessable URL. Copies record a keyed digest of the upload (`PRIVACY_LINK_KEY`, a
  Function environment variable), never its id.
- **Deploy:** `npx sanity@latest blueprints deploy` from `studio/`, always with
  `npm_config_platform=linux npm_config_arch=arm64` in the environment. Without them the deploy
  bundles the Mac's ffmpeg, and every conversion fails its binary check.

**Function `image-privacy`** (same Blueprint, added 2026-11-26 for D17; code in
`studio/functions/image-privacy/`, shared strippers in `studio/functions/privacy/`, design in
`docs/sanity-migration/reports/privacy-functions.md` and `privacy-review.md`)
- **Trigger:** `create` and `update`, drafts and release versions included, in both datasets, on a
  document of the watched types with an image whose asset was uploaded since 2026-11-26 and still
  needs work (no `privacy`, another stripper version, `replaced`, a stale lease or a due retry). 2
  GB, 300 s. Since the recreate (D18) every asset's `_createdAt` is the import time, so the
  `privacy` mark, not the date, separates checked images: all 110 images carry one (70 `stripped`,
  40 `clean`), and the filter matches no document.
- **What it does:** reads the stored bytes (`?dlRaw=` with its token), and when they hold anything
  personal writes a copy with a pure TypeScript stripper (no exiftool: the runtime has no perl):
  the coded image byte for byte, orientation and ICC kept, same dimensions. JPEG, PNG, WebP, GIF,
  AVIF and TIFF. It moves every reference in drafts, published documents and active release
  versions to the copy (`asset._ref` only, so crop, hotspot, alt, caption and layout stay; a
  testimonial's `asciiArtSource` moves too), then deletes the upload. A clean image is only marked
  `clean`.

**Function `upload-privacy`** (same Blueprint, added 2026-11-26 for D17; code in
`studio/functions/upload-privacy/`)
- **Trigger:** `create` of an image or file asset uploaded since 2026-11-26 that the migration or a
  Function did not make, and `delete` of a content document, draft or release version. 2 GB, 900 s.
- **What it does:** removes any `metadata.location`, `exif` or `image` an API client asked Sanity to
  extract into the asset document and logs a WARN (the upload's first revision keeps that data in
  the History API, D18), waits up to 60 s for a document to use the upload (a reference seen once
  is final: the Functions above then handle it), and otherwise strips it with the same strippers
  and deletes it; an upload the strippers fail on is deleted. Every run logs how its wait ended.
  Each run also sweeps up to five earlier unused uploads that still have their metadata. There is
  no scheduled sweep: it needs the one-way promotion of the Blueprint stack to the organization and
  a robot token (owner decision).
- **Uploads from code** (added 2026-11-26, D18): every upload in the repository that can be an
  image goes through `uploadAsset` (`studio/functions/privacy/upload.ts`), which lets Sanity
  extract only `blurhash`, `thumbhash`, `lqip` and `palette`, and `studio/test/upload-metadata.test.ts`
  fails on a `meta` request parameter or a direct image upload.

## 9. Migration pipeline (`migration/wagtail-to-sanity/`)

Scripts are committed. Data lives outside the repo in `~/cjoshmartin-migration/`, mode 700.

1. **Extract**
   - Unzip the Wagtail export.
   - `gsutil -m rsync` the content folders (`original_images/`, `documents/`, `media/`, `media_thumbnails/`) to a local folder.
   - Check every image and document file's sha1 against Wagtail's `file_hash`.
   - Write the inventory report.
2. **Transform**
   - Build lookup maps for images, documents, media, pages, snippets, and tags.
   - Convert rich text and StreamFields (§5).
   - Merge duplicate tags.
   - Each page produces a **published** version and, if it has unpublished changes or was never published, a **draft** version from its latest revision.
   - Every issue is logged per record, and anything unexpected fails the transform.
   - Output is `transformed/*.ndjson`, plus a mapping report.
3. **Assets**
   - Upload **all** content images and files from local disk to Sanity, with `source: {name:"wagtail", id, url}` and the title set. (Amended 2026-11-26, D17: a file with personal metadata is uploaded only as its stripped copy, whose `source` has no `url`.)
   - Build a map from Wagtail id to Sanity asset id.
   - Re-runs don't create duplicates because Sanity names assets by their hash.
4. **Videos** (amended 2026-11-26: Mux dropped; the ~~`mux` step~~ is superseded and no longer exists)
   - `convert`: convert each of the 29 media files from the local bucket mirror with `buildFfmpegArgs` (ffmpeg 7.0 or newer) and check every output, including that every decoded frame of the original is in the MP4 at its own time. The 29 originals (261.2 MiB) became 86.0 MiB of MP4s.
   - `videos`: upload each original (source `{name: "wagtail", id: "media-<id>"}`) and its MP4 as file assets (the MP4 with source `video-to-mp4`, the settings version recorded on it); re-runs reuse assets by content hash and reuse only MP4s made with the current settings.
   - `transform` writes each video block already converted (`ready`, `file` = the MP4, `original` = the Wagtail upload), so the `video-to-mp4` Function never runs on migrated content.
   - After `import`, `prune-mp4s` deletes the MP4s of the Wagtail videos made with other settings once nothing references them.
   - Wagtail media thumbnails are uploaded as image assets, with `source` linking them to their media id.

   The steps of a full run, in order: `extract`, `privacy` (added 2026-11-26, D17), `assets`, `convert`, `videos`, `ascii`, `transform`, `import`, `prune-mp4s`, `validate`.
5. **ASCII art:** generate `asciiArt` for every testimonial using the shared generator.
6. **Import**
   - Run `sanity datasets import --replace` into **`staging`**.
   - Validate (§11).
   - Fix and repeat until validation passes.
   - Then import the same files into **`production`** and validate again.

**Privacy step** (added 2026-11-26, D17; `src/steps/privacy.ts`, report `wp3-migration.md` last section and `privacy-review.md`):

- Scans every content file of the bucket mirror and every asset of the dataset (exiftool `-ee`, the track list, the boxes outside the samples, STL headers) with rules `personal-metadata-v2`, the same policy as the Functions.
- Makes each copy locally with the Functions' own strippers (`studio/functions/privacy/image-strip.ts`, `isobmff-video.ts`), always from the Wagtail original, and checks it independently: images by decoded pixels with ImageMagick and ffmpeg, the orientation, a byte-identical ICC profile and every kept tag; videos by per-stream packet hashes with time stamps and byte positions, the stream descriptions, the bytes outside the changed ranges and a byte-level scan for location signatures. Copies are listed in `~/cjoshmartin-migration/privacy/privacy-map.json`, which records a fingerprint of the stripper code; a change of that code remakes every copy.
- Uploads each copy with the old asset's title, file name and `source` (without `url`), marks it (`privacy.status` `stripped`, its version, `strippedFromDigest`), moves every use (references, `asciiArtSource`, `conversion.*AssetId`, the MP4s' `source.id`) in one revision-checked transaction per dataset, then deletes the old asset once nothing references it.
- The `assets` and `videos` steps upload only stripped copies. Reruns change nothing. `loadSecrets` needs `PRIVACY_LINK_KEY` for the digests.
- Result in each dataset: 99 assets replaced (70 images, 29 video originals); the MP4s kept their bytes.

**Content freeze:** nobody edits Wagtail between the export and cutover. Anything changed there won't be migrated.

## 10. Weekly backups (`scripts/backup/` + `.github/workflows/sanity-backup.yml`)

**Bucket:** `gs://cjoshmartin-sanity-backups`
- us-central1, Standard storage class
- uniform bucket-level access, public access prevention enforced, no public URLs

**Access**
- Service account `sanity-backup@com-cjoshmartin` with `objectCreator` and `objectViewer` on that bucket only. It has no delete permission, so the CI can't destroy backups, and every object is written create-only.
- GitHub authenticates through Workload Identity Federation. The provider only accepts `repository == cjoshmartin/cjoshmartin-frontend` with `repository_id == 737918690` on `refs/heads/main`, so no key is stored anywhere. (Amended 2026-11-26: the repository moved from ~~`cjoshmartin-com/cjoshmartin-frontend`~~, and GitHub's token carries the new name.)

**Bucket layout**
```
snapshots/<ISO-timestamp>/data.ndjson.gz   # full raw export incl. drafts (documents only)
snapshots/<ISO-timestamp>/manifest.json    # fingerprint, counts per _type, asset list (sha1 → path)
assets/images/<sha1>.<ext>                  # each Sanity image stored once
assets/files/<sha1>.<ext>                   # each Sanity file stored once (videos included: MP4s and originals)
markers/<ISO-timestamp>.json                # written last = snapshot complete; latest marker = newest name
archive/                                    # one-time: wagtail export zip, dumpdata, final pg_dump, GCS file list
```

**Run logic**
1. **Fingerprint:** hash the sorted `_id:_rev` pairs of every document in the raw perspective (drafts and asset documents included).
2. **Compare:** if it matches the newest marker, log "no changes", write nothing, and exit 0.
3. **Back up:**
   - export the documents
   - upload each asset whose `assets/...<sha1>` object doesn't exist yet. Videos are ordinary file assets (each converted MP4 and its kept original), so they are stored once under `assets/files/` like every other file, and a restore keeps their `source`, so restored blocks need no new conversion. (Amended 2026-11-26: the ~~Mux step and `assets/mux/`~~ are superseded; the bucket never held them.)
   - upload the snapshot files, then write the marker
4. **Size check:** fail if the bucket is larger than 4 GB. Each dataset now holds about 466 MiB of assets (261 MiB of it video originals and 86 MiB MP4s), so the first snapshot of a dataset is about that size; later snapshots add only new assets.

(Added 2026-11-26, D17.) Backups store what the dataset holds, so only stripped copies: the real GCS bucket does not exist yet, and its first snapshot comes after the strip. The restore keeps every asset field that is not derived from the file, `privacy` and `source` included. The overnight test backups in `~/cjoshmartin-migration/backup-test/` predate the strip and hold unstripped originals; they are local only and on the cleanup list.

**Restore:** `scripts/backup/restore.mjs --snapshot <ts> --dataset <name>` rebuilds a standard Sanity import tarball (`data.ndjson` plus `images/` and `files/` with `_sanityAsset` directives) and runs `sanity datasets import --replace`.

**Workflow**
- Triggers: `schedule: '0 9 * * 0'` and `workflow_dispatch` (inputs: dataset, dry-run).
- Permissions: `id-token: write` and `actions: write`.
- A keepalive step re-enables the workflow through the GitHub API, so the 60-day inactivity rule can't turn it off.
- The Sanity read token (Viewer role, which can read drafts) is the only GitHub secret, `SANITY_BACKUP_TOKEN` (the ~~Mux secrets~~ are superseded). The GCP provider and service account are GitHub variables.

**Testing overnight** (the real GCS run happens in the morning)
- A storage-adapter interface with GCS and local-filesystem implementations.
- Unit tests for the fingerprint and for the change, no-change, and new-asset cases.
- An end-to-end run against `staging` using the local adapter.
- A restore into `staging` that must reproduce the document set exactly (ids and content, ignoring `_rev` and `_updatedAt`) with every asset present.

**`scripts/backup/setup-gcp.sh`**
- Idempotent. Creates the bucket, the service account, the IAM bindings, and the Workload Identity pool and provider.
- Prints the values to put in GitHub secrets and variables.
- Reviewed overnight. You run it in the morning, after `gcloud auth login` as the project owner.

## 11. Automated verification (overnight, must pass before the PR is marked ready)

1. **Counts:** per type, published and draft, Wagtail export vs Sanity. Asset counts match the bucket content files. Tag merges are listed.
2. **Integrity**
   - every `_ref` resolves
   - Portable Text has no raw HTML strings and every block has a `_key`
   - every Sanity image's `sha1hash` equals Wagtail's `file_hash`
   - all 29 video blocks are `ready` MP4s made with the current `SETTINGS_VERSION`, with their originals kept (amended 2026-11-26; was "all 29 Mux assets are `ready`")
3. **Text parity:** for every page and snippet, the normalized plain text of the Wagtail rich text matches the plain text of the Portable Text. Any difference fails the check, unless it's an allowlisted whitespace difference.
4. **Schema:** `sanity documents validate` passes on both datasets.
5. **ASCII art**
   - JS output vs Python `ascii-magic` output for all 9 testimonial images: same grid size, at least 90% of characters within ±1 step on the character ramp, mean colour difference under a threshold
   - side-by-side images in the report
   - the deployed Function is triggered by changing a staging testimonial's image
6. **Build:** `next build`, typecheck, and lint pass. Studio `sanity build` passes.
7. **Parity crawl:** every route is crawled on the current production site (Wagtail) and on a local production build that reads the production Sanity dataset. Compared per route:
   - title, description, og:image presence, h1, heading list and ids
   - image, video, and embed counts; for videos also their order (each old file is the block's `original`), their sources (the block's MP4 from `cdn.sanity.io`, `type="video/mp4"`), their attributes and rendered boxes (added 2026-11-26)
   - no request to a Mux host or to the old bucket, and neither in any HTML (added 2026-11-26)
   - internal links, and visible-text similarity
   - expected differences (from §7.3) are allowlisted and listed
   - Playwright screenshots at 1440 and 390 px widths, old next to new, collected in an HTML report
8. **Backups:** the tests in §10.
9. **Review:** an independent review agent reviews the whole PR diff for correctness against this plan. Its findings are fixed before the PR is marked ready.
10. **Videos** (added 2026-11-26)
    - every MP4 is checked after conversion: H.264 High, yuv420p, the exact expected size, even sides, longest side at most 1920, no rotation left, `moov` before `mdat`, stereo AAC only when the input has audio, no other streams or copied metadata, and every decoded frame of the original at its own time (within 1 ms)
    - all 29 MP4s, downloaded anonymously from the CDN, match the checked files
    - in real browsers (Chrome for Testing and WebKit), every video starts on its own, muted, inline and looping, with controls, and plays its MP4
    - the deployed `video-to-mp4` Function converts a real upload on `staging` and passes the same checks; the scratch document and assets are deleted afterwards
11. **Privacy** (added 2026-11-26, D17)
    - the migration's `validate` has a 13th check, `privacy`: it downloads every asset of the dataset (images with `?dlRaw=` and a token) and requires that the scan (exiftool `-ee`, the Functions' strippers, tracks, unused `mdat` bytes, STL headers) finds nothing personal, that no asset document holds `metadata.location` or `metadata.exif`, that no unstripped upload is left, that every copy is marked, that every remaining `source.url` serves exactly the asset's bytes, and that no document (drafts and versions included) names an asset id that is not in the dataset
    - `hashes` compares a stripped image with its Wagtail original by decoded pixels; `videos` requires each stripped original to have the Wagtail upload's audio and video packets
    - every copy is checked when it is made: identical decoded pixels (two decoders), orientation and ICC profile for images; identical packets with time stamps, stream descriptions and the bytes outside the changed ranges for videos
    - an independent verification with its own scripts (no repository code): every stored and public asset byte of both datasets and the CDN renditions scanned for the location fingerprints of the local originals, personal tags, and non-zero unused `mdat` bytes; the copies compared with the originals; the old URLs probed
    - the Functions are tested live on staging with generated media that carries fake location data: a photo in a draft, a video in a draft, a failed conversion, a release version, an image uploaded as a file, an unused upload, an unstrippable upload, and a testimonial photo
12. **History** (added 2026-11-26, D18)
    - before a dataset is deleted, `npm run recreate -- snapshot`, `verify-export` (the export holds exactly the snapshot, and every exported file passes both privacy scans) and `history-baseline` (every deleted id found in local files, with its transactions and anonymous reads)
    - after the import: `restore-assets`, validation (13 checks), `compare` with the snapshot, and `history-check --created-after <the time recreate-dataset.sh prints before the create>`: no deleted id has a transaction or an anonymous read at any time or revision the baseline saw, and no current document has a transaction before the dataset's creation
    - an independent probe without a token of every deleted id found in local files and of the current documents at old times and revisions, a scan of every asset through the public CDN, and a probe of every deleted CDN path
    - result on 2026-11-26: PASS on both datasets (356 deleted ids each, 0 with a transaction, 0 anonymous reads with content; the independent probe: 389 and 387 ids, 25,686 probes, 0 documents; 0 of 670 deleted CDN paths served)

## 12. Manual UI tests (for you, in the morning, on the Vercel Preview URL unless noted)

Mark each item pass or fail. Anything that fails blocks the merge.

**A. Home (`/`)**
1. The bio, profile photo, name, job title, location, email link, and GitHub link all match the current site.
2. Testimonials show ASCII art. Hovering (or tapping on mobile) fades in the real photo. Within about 30 s a different testimonial appears.
3. The services cards match the current site (image, title, description). Linked cards open their links.
4. The client and personal portfolio previews each show 3 projects, newest first, none of them unlisted.
5. The resume section loads. `/resume` and `/resume/pdf` work.
6. `/?utm_source=test` renders the normal home page. *(Bug 3)*

**B. Projects**

7. `/projects` lists the same projects as the current site, minus unlisted ones. The tag counts look right.
8. Click a medium tag, then a technology tag, then use `?project_type=PER` and `?project_type=CLI`. Each filters correctly. "Clear filters" resets.
9. A project with a website and no body (e.g. the CSS calculator) opens its website in a new tab.
10. Open "Squid Games Nerf Gun":
    - the hero shows
    - client, medium, and technologies are correct
    - each video autoplays muted on a loop, with controls
    - the STL model renders and rotates
    - the testimonials show
11. Open an unlisted project by URL. The "unlisted" banner shows.

**C. Blog**

12. `/blog` lists the 7 posts with dates, read times, and hero images, newest first, none unlisted. *(Bug 1)*
13. Open "IOS Universal Links…":
    - the outline links jump to their headings
    - each `#anchor` from the outline matches the old site's anchor
    - code blocks are highlighted with line numbers
    - inline images show
    - the YouTube embed plays
    - the author box shows
14. Open "Added Support For 3D Models…". The STL viewer works.
15. Recommended posts show 3 other posts and never the current one.
16. Disqus comments load on a post that already has comments, and show the **same existing thread**. Disqus may block preview domains; if so, check this one on production right after merge.
17. `/blog/does-not-exist` and `/projects/does-not-exist` return a 404 page, not a 500. *(Bug 5)*

**D. Other routes**

18. `/flex/portfolio` and `/flex/blog` render.
19. `/about` goes to `/`. `/portfolio` goes to `/projects`. `/info` goes to `/`.
20. `/admin` goes to the Studio URL.
21. `/screen` cycles through projects (unlisted ones excluded). `/ascii` and `/start-a-project` work.

**E. SEO** (View Source)

22. On the home page, a blog post, and a project, check `<title>`, the meta description (not the SEO title), og:image (a `cdn.sanity.io` URL), and the canonical URL. *(Bug 2)*
23. `/sitemap.xml` uses `https://cjoshmartin.com/...` URLs, has real `lastModified` dates, and contains no unlisted pages. `/robots.txt` is unchanged. *(Bugs 1, 4)*

**F. Mobile** (390 px wide, or your phone)

24. Home, a project, and a blog post look the same as production, and videos play inline.

**G. Studio** (`<name>.sanity.studio`)

25. You can log in. You see Home, Blog posts, Projects, Flex pages, People, Testimonials, Services, Tags, and Redirects.
26. Open a blog post. Rich text, code blocks, the STL block, and video blocks show (each video block shows its file name and "Ready"). The hidden "Migration" group has the Wagtail id.
27. Draft check: if Wagtail had unpublished pages or changes, they appear as drafts in Studio and **not** on the site.
28. Presentation tab:
    - the site loads in the iframe
    - clicking a heading focuses its field
    - typing shows a live draft
    - discarding the draft reverts it
    - (Vercel preview protection may block the iframe; if so, check this one on production after merge)
29. On a staging copy of a testimonial (use the dataset switcher), change the photo. Within about a minute `asciiArt` updates.
30. In the **staging** workspace, open a blog post (a new one is simplest: fill the required title, slug, date, intro and audience), add a video block to its body and upload a `.mov` (an iPhone clip is ideal). Watch the block's subtitle change to "Converting to MP4..." and then, usually within a minute, "Ready. Original kept without location data". Open the block: **File** is now `<your file name>.mp4`, and **Original upload** (read-only) holds your `.mov` without its metadata (same name, new asset; D17, checked in test 30a). Publish, then run the site locally against staging (`NEXT_PUBLIC_SANITY_DATASET=staging npm run dev`) and open `http://localhost:3000/blog/<slug>`: the video autoplays muted on a loop, its source is a `https://cdn.sanity.io/files/j3vdh6ti/staging/<sha1>.mp4` URL with `type="video/mp4"`, and the `.mov` appears nowhere on the page. Delete the test post afterwards. (Rewritten 2026-11-26; it used to go to ~~Mux~~.)
30a. *(Added 2026-11-26, D17.)* Privacy of uploads, in the **staging** workspace (the test post of test 30 is fine). Use a photo and a video taken on a phone with location services on (check first: `exiftool -ee -G1 -a <file> | grep -iE 'gps|location'` prints lines).
    - Set the post's content image to the photo, open its crop tool and set a crop and a hotspot, and add alt text. Within about 15 s the line under the image says "Location and camera data removed". The crop, the hotspot and the alt text are still the ones you set (open the crop tool again).
    - Add a video block with the video. It becomes "Ready. Original kept without location data" (test 30).
    - In Vision (staging), run `*[_id in ["<post id>", "drafts.<post id>"]]{_id, contentImage{crop, hotspot, alt, "url": asset->url, "privacy": asset->privacy.status}, "videos": body[_type == "video"]{"original": original.asset->url, "mp4": file.asset->url, "privacy": original.asset->privacy.status}}`: the image's `privacy` is `stripped` and its crop and hotspot are yours; each video's `privacy` is `stripped`.
    - Download the three stored files and check them. The stored image needs the Viewer token (`?dlRaw=`); file URLs are public:

      ```sh
      set -a; . ~/cjoshmartin-migration/secrets.env; set +a
      curl -sf -H "Authorization: Bearer $SANITY_READ_TOKEN" "<image url>?dlRaw=" -o /tmp/t30a-photo
      curl -sf "<original url>" -o /tmp/t30a-original
      curl -sf "<mp4 url>" -o /tmp/t30a.mp4
      exiftool -ee -a -G1 -s --ICC_Profile:all /tmp/t30a-photo /tmp/t30a-original /tmp/t30a.mp4 | grep -iE 'gps|location|latitude|longitude|make|model|serial'
      LC_ALL=C grep -c -a -E 'ISO6709|quicktime\.location|[+-][0-9]{2}\.[0-9]{4}[+-][0-9]{3}\.[0-9]{4}' /tmp/t30a-original
      ```

      The `exiftool | grep` prints nothing and the byte search prints `0`. (On the files you uploaded, both find something.) Zeroed dates (`0000:00:00`) are expected.
    - The uploads themselves are gone: `*[_type in ["sanity.imageAsset", "sanity.fileAsset"] && _createdAt > "<the UTC time you started this test>"]{_id, originalFilename, "privacy": privacy.status, "source": source.name}` lists only the copies (`stripped`) and the MP4, never an asset with `privacy` `replaced` or none. (Use the start time, not the date: since the recreate every migrated asset was created on 2026-11-26.)
    - Nothing was extracted into the History API (D18): from `studio/`, `npx sanity@latest functions logs upload-privacy --stack ST-jc4gwa3c4t | grep WARN` shows no line from your test. A WARN would mean an upload asked Sanity for location, EXIF or camera data, which then stays readable without a token for 90 days; Studio uploads never ask.
    - Delete the test post, then the copies and the MP4 from `studio/`: `npx sanity@latest documents delete --dataset=staging <asset id> <asset id> <asset id>` (they hold nothing personal, but `npm run compare` lists them until they are gone; their revisions stay in the History API for 90 days, D18). Then `rm /tmp/t30a-*`.
31. Edit and publish a typo fix on production. It appears on the site within seconds, not an hour. Then revert it. *(Bug 11)*

**H. Backups** (after merge and running `setup-gcp.sh`)

32. In the Actions tab, run "Sanity backup" manually. It succeeds, and `snapshots/<ts>/`, `markers/<ts>.json`, and `assets/` exist in the bucket.
33. Run it again with no edits. The log says "no changes", and no new snapshot is created.
34. Edit any document, then run it again. A new snapshot appears, and only new assets are uploaded.
35. Run `restore.mjs` from the newest snapshot into `staging`. The counts match production.
36. In the GCS console, confirm the bucket isn't public and has no `allUsers` access.

**I. Teardown** (after your go-ahead)

37. `https://backend.cjoshmartin.com` no longer resolves.
38. An old image URL `https://storage.googleapis.com/images-for-cms/original_images/...` returns 403.
39. `gcloud iam service-accounts keys list --iam-account file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com` shows no user-managed keys.
40. The repo `cjoshmartin-com/cjoshmartin-backend-archive` is private and archived. `git log --all -- secrets.json` in a fresh clone shows nothing.
41. The backup bucket's `archive/` folder has the final Postgres dump, the Wagtail export, and the list of GCS files.

## 13. Timeline and who does what

### Tonight, with you (before bed)

1. **Me:** build the Wagtail export plugin, then test it locally with Docker Compose Postgres and Django tests. It's a Django app, `sanity_export`, registered through Wagtail hooks. It adds an "Export for Sanity" admin menu item for superusers only. It adds no models and no migrations.
   - The zip contains `export.json`:
     - every page (`.specific`), both the live version and the latest revision
     - page tree, slugs, URL paths, SEO fields, publish timestamps
     - StreamField `raw_data` and database-format rich text
     - orderables with their sort order, and tags
     - all authors, testimonials, and services
     - every image, document, and media record (file name, size, hash, dimensions, focal point, collection), plus media thumbnails
     - redirects and sites
   - It also contains `dumpdata.json` (a full Django dump) and `manifest.json` (counts and checksums).
2. **You:**
   - `git push dokku main` from `cjoshmartin-backend`
   - open `https://backend.cjoshmartin.com/admin/` and click **Export for Sanity**
   - save the zip as `~/cjoshmartin-migration/wagtail-export.zip`
3. **You:** `! sanity login`, using the **other** Sanity account.
4. ~~**You:** create a Mux access token (Mux Video read and write). Put it in `~/cjoshmartin-migration/secrets.env`, which I'll create with blank placeholders, as `MUX_TOKEN_ID=` and `MUX_TOKEN_SECRET=`.~~ (Done that night; superseded on 2026-11-26 when Mux was dropped. The token is no longer used; revoke it, see §16.)
5. **Me:** check the prerequisites:
   - the export zip is valid and its counts match the live API
   - `sanity debug` shows the new account
   - ~~the Mux token works~~ (superseded)
6. **Me:** once those pass, create the Sanity project, both datasets, and the tokens (stored in `secrets.env`, never committed), then start the overnight workflow. You can go to sleep.
7. *(Optional)* Overnight steps can be blocked by the permission system. A blocked step is logged and the run carries on with the other work. Anything blocked is waiting for you in the morning.

### Overnight (agents, §14)

Schema and Studio → migration into staging → validation → import into production → frontend rewrite → parity crawl → backups code → teardown scripts (dry-run only) → review → PR with Vercel Preview → morning report.

### Morning, with you

The morning report's "Morning sequence" is the current, detailed version of this list (updated
2026-11-26 for the Mux removal, and 2026-11-27 for D17 and D18).

1. Read the morning report: what passed, every allowlisted difference, any blocked steps.
2. Run the manual tests A–G (§12) on the Preview URL (tests 30 and 30a against staging, as written
   there).
3. *(Optional, added 2026-11-27.)* Send the drafted email to Sanity support
   (`~/cjoshmartin-migration/dataset-exports/cdn/sanity-support-cdn-purge-email.md`, outside the
   repository). Its CDN purge request is probably moot: after the recreate none of the 670 deleted
   asset paths is served, and the cached copies expire by 2026-12-26 at the latest. Its question
   whether a public dataset's History API can require a token still matters (D18).
4. Approve, then I add the Production env vars on Vercel and you merge. Then run test 16 and test 28 (Disqus and Visual Editing) on production if they couldn't be checked on Preview, and test 31.
5. Set up the revalidation webhook and `SANITY_REVALIDATE_SECRET` (added 2026-11-26).
6. Backups:
   - `! gcloud auth login` as the `com-cjoshmartin` owner
   - I run `setup-gcp.sh` and set the GitHub secrets and variables
   - you run tests H (32–36)
7. Teardown, with your go-ahead. I prepare every command. The steps marked *you* need your credentials or SSH.
   - **you:** run `ssh dokku@159.203.93.178 postgres:list`, then `postgres:export <svc> > ~/cjoshmartin-migration/final/wagtail-final.dump`
   - **me:** upload that dump, the export zip, `dumpdata`, and the GCS file list to `archive/`
   - **me:** push the scrubbed backend repo to a private repo and archive it
   - **you, or me with permission:** `apps:destroy` and `postgres:destroy` on Dokku
   - **you:** delete the `backend` A record in GoDaddy
   - **me:** make `images-for-cms` private and delete the `file-upload-2024` service-account keys (no video depends on the bucket any more: all 29 originals and their MP4s are in Sanity). Until then the old bucket and the live Wagtail site keep serving the unstripped originals, 11 of them with a location (your timing, D17).
   - **you:** tests I (37–41)
8. **You** (added 2026-11-26): revoke the Mux access token in the Mux dashboard, and delete the Mux account if you no longer want it. Nothing uses it, and it holds no assets.
9. **You** (added 2026-11-26, D17 and D18): decide the open privacy points: PDF and STL metadata, capture dates in file names, a scheduled sweep, and whether to close the History API to anonymous readers (private datasets on a paid plan, or an Enterprise custom role so the Functions can purge what they delete).
10. **You** (optional, added 2026-11-27): remove the two temporary permission rules added for the recreate, if they are still there: `Bash(npx sanity@latest blueprints deploy *)` and `Bash(migration/wagtail-to-sanity/scripts/recreate-dataset.sh *)` in the `permissions.allow` list of `~/code/cjoshmartin.com/.claude/settings.local.json`.

### Rollback

- **Before teardown:** use Vercel Instant Rollback or revert the PR. The old frontend reads Wagtail again immediately.
- **After teardown:** this is why teardown waits for your tests. Recovering means restoring the archived Postgres dump into a new Dokku app and re-pointing DNS. It's possible because the archive holds everything, but it's slow.

## 14. Work packages (one sub-agent each, run as a workflow)

Each agent gets only its package brief: goal, inputs, owned paths, constraints, and acceptance criteria. Packages own disjoint paths, and each works on its own branch or worktree off `sanity-migration`. The orchestrator (me) merges them in dependency order and owns all shared root files. Secrets are only ever read from `~/cjoshmartin-migration/secrets.env`, never printed, and never committed.

| WP | Owns | Depends on | Output and acceptance |
|---|---|---|---|
| **WP1 Schema + Studio** | `studio/` (except `functions/`) | project created | Schemas, structure, plugins, Presentation config, TypeGen config, CORS. Studio deployed. Schema contract doc. `sanity build` and `sanity schema deploy` pass. |
| **WP2 ASCII generator + Function** | `studio/functions/testimonial-ascii-art/`, blueprint | WP1 types | An exact port of ascii-magic 2.3.0. Unit tests. Comparison report against Python output for all 9 images. Function deployed and verified on staging. |
| **WP3 Migration ETL** | `migration/wagtail-to-sanity/` | WP1, WP2 module, export zip (~~Mux token~~, superseded) | Extract, transform, assets, videos (~~Mux~~ until 2026-11-26, then MP4 conversion, see below), import to staging, validation (§11.1–5), then production. Morning report section: counts, merges, issues. |
| **WP4 Frontend rewrite** | `app/`, `components/`, `lib/`, `sanity/`, `next.config.js`, root config files | WP1 types, WP3 staging data | Every item in §7 implemented. `next build`, lint, and typecheck pass. Each bug fix noted in the PR body. |
| **WP5 Backups** | `scripts/backup/`, `.github/workflows/sanity-backup.yml` | WP1 project; restore test after WP3's production import | Everything in §10. Tests pass. Local end-to-end and restore into staging pass. `setup-gcp.sh` written, linted, and dry-run with `--print-only`. |
| **WP6 Decommission prep** | `scripts/decommission/`, a scrubbed copy of the backend repo in `~/cjoshmartin-migration/backend-archive/` | none | `git filter-repo` copy with `secrets.json` gone from every commit (verified). Teardown scripts with `--dry-run`, printing every command. A checklist matching §13 morning step 5. **Runs nothing irreversible.** |
| **WP7 Verification** | `migration/verify/` | WP3 (production), WP4 | Parity crawl plus screenshots (§11.7). HTML report. Fills in the morning report. |
| **WP8 Review** | read-only | WP1–WP7 merged | Independent correctness review of the full diff against this plan. Findings fixed by the owning WP, or by me, before the PR is marked ready. |

The PR is opened by me after WP8, using `gh pr create` from `sanity-migration`. The body has a summary, the decisions table, the bug-fix list, links to the reports, and the §12 checklist. There is no co-author trailer.

**Mux removal (2026-11-26, after the owner's decision).** A second workflow on the same branch:

| Package | Owns | Output and acceptance |
|---|---|---|
| **Spike** | a staging scratch Function (deleted) | Whether a Sanity Function can run ffmpeg, with what memory, timeout and preset. Report `reports/video-spike.md`. |
| **A1 Studio video** | `studio/` (except the Function), `settings.ts` | Video contract v2 in the schema, the Mux plugin removed, `settings.ts` with `SETTINGS_VERSION` and `buildFfmpegArgs`, schema and Studio deployed. Report `reports/a1-studio-video.md`. |
| **A2 Function** | `studio/functions/video-to-mp4/`, `studio/sanity.blueprint.ts` | The `video-to-mp4` Function deployed and checked live on staging. Report `reports/a2-video-function.md`. |
| **B Data** | `migration/wagtail-to-sanity/` | The 29 videos converted and migrated to both datasets, the Mux assets and `mux.videoAsset` documents deleted, validation 12 of 12. Report `reports/wp3-migration.md`, last section. |
| **C Frontend** | `app/`, `sanity/`, `next.config.ts`, `package.json` | The site plays the MP4s; the Mux player removed. Report `reports/wp4-frontend.md`, last section. |
| **D Backups** | `scripts/backup/`, the workflow | Mux removed from the backups; the moved repository name fixed. Report `reports/wp5-backups.md`, last section. |
| **Verify** | `migration/verify/` | Parity crawl and browser video checks without Mux, a live Function check. Report `reports/video-verification.md`. |
| **Review and fix rounds** | read-only, then the owning paths | Review of the whole Mux removal and two fix rounds. Report `reports/mux-removal-review.md`. |
| **Ship** | this plan, the morning report, the PR description | Docs and PR updated, branch pushed, Preview checked. |

**Metadata stripping (2026-11-26, D17).** A third workflow on the same branch:

| Package | Owns | Output and acceptance |
|---|---|---|
| **F Functions** | `studio/` (Functions, schema, Studio), the contract's Privacy section | Shared lossless strippers (`studio/functions/privacy/`), the `image-privacy` Function, stripping in `video-to-mp4`, Studio accept lists and status lines; deployed and tested live on staging. Report `reports/privacy-functions.md`. |
| **M Migration** | `migration/wagtail-to-sanity/` | The `privacy` step: the existing assets of both datasets replaced by verified copies and the unstripped ones deleted; a `privacy` validation check (13 of 13). Report `reports/wp3-migration.md`, last section. |
| **Verify** | read-only, report only | Independent scan of every asset, the CDN renditions and the old URLs, live tests and a browser check of the site. Report `reports/privacy-verification.md`. |
| **Review** | read-only | Review of both packages' code. |
| **Fix rounds 1 and 2, rechecks 1 and 2** | the owning paths | 16 + 7 findings; one policy, in-place video stripping, `mdat` zeroing, `upload-privacy`, release versions, keyed digests, private reads, unstrippable uploads removed. Report `reports/privacy-review.md`. |
| **Ship** | this plan, the morning report, the PR description | Stopped before it pushed; its work is done by the ship package of D18 below. |

**Dataset recreate (2026-11-26, D18).** A fourth workflow on the same branch:

| Package | Owns | Output and acceptance |
|---|---|---|
| **Recreate** | `migration/wagtail-to-sanity/` (`npm run recreate`, `scripts/recreate-dataset.sh`); the main session for the deletes, the imports and the Function removal | Snapshots, verified exports and History API baselines; both datasets deleted and created again; assets restored, schemas deployed, validation 13 of 13, compare, `history-check`; Functions deployed again. Report `reports/dataset-recreate.md`. |
| **Verify** | read-only, report only | History API probes of every deleted id, a public CDN scan of every asset, live Function tests, a browser check of the site, the old CDN paths. Report `reports/recreate-verification.md`. |
| **Fix rounds 1 and 2, rechecks 1 and 2** | the owning paths | 5 + 4 findings: the 40 unmarked images marked, `history-check --created-after`, upload-privacy's wait, a WARN on extracted data, the `uploadAsset` helper and its guard test. Report `reports/dataset-recreate.md` (fix rounds). |
| **Ship** | this plan, the reports, the morning report, the PR description; the full sha1s of deleted assets in tracked files | Docs updated for D17 and D18, deleted-asset ids shortened to 8 hex digits, secrets, ids and coordinates scanned, branch pushed, PR updated, Preview checked. Report: the morning report. |

## 15. Risks and how they're handled

| Risk | Mitigation |
|---|---|
| Next 16.3 or React 19.2 incompatible with next-sanity or the Studio | WP1 and WP4 check the latest compatible versions first. The Studio is standalone, so it never shares the Next build. |
| A permission prompt blocks an overnight step | It's logged and the run continues with other packages. Anything blocked appears in the morning report. |
| Rich-text edge cases | Strict allowlist, a failing transform on anything unknown, text-parity checks, and screenshot diffs. |
| Anchor or Disqus breakage | The slug algorithm is kept and the `legacy.wagtailId` identifier is preserved. Both are covered by tests 13 and 16. |
| Vercel preview protection blocks the Presentation iframe or the Disqus domain | Those tests fall back to production right after merge, still before teardown. |
| Sanity Free plan quotas | ~~About 140 MB of images and files (videos live on Mux), a few hundred documents, and server-side cached reads. Well under the 100 GB asset, 100 GB/month bandwidth, and 10k document quotas.~~ **Amended 2026-11-26 (Mux dropped):** each dataset holds 465.9 MiB of assets (110 images 108.5 MiB, 29 kept video originals 261.2 MiB, 29 MP4s 86.0 MiB, 5 other files 10.2 MiB; measured on `production` and `staging`), about 0.9 GiB for the project, and 96 documents. Well under the 100 GB asset and 10k document quotas. Bandwidth (100 GB/month, API, CDN and asset traffic together) now also carries the videos, which the site serves from Sanity's CDN and autoplays: one full view of the heaviest page (project `squid-games-nerf-gun`, 8 videos) downloads up to 58.35 MiB of MP4s, so about 1,600 such views in a month would use the whole quota. On the Free plan that blocks the public API and CDN, and the site's content stops loading until the month resets. Sanity emails the admins at 80 % and 100 %; upgrading to Growth turns the block into overage billing. |
| Mux master-access cost for backups | ~~Checked in Mux's docs by WP5. A fallback path is defined in §10.~~ **Superseded 2026-11-26:** there is no Mux. Videos are ordinary file assets and are backed up with the other files (§10). |
| Content edited in Wagtail after the export | Content freeze from export time to cutover. The export manifest records the export time. |
| A Studio video upload is not converted (added 2026-11-26) | The site never plays an unconverted upload: the block renders nothing until it is `ready`. A failed conversion is a validation error, so it cannot be published unnoticed. Problems that are not the video's fault are retried after 10 minutes. A stuck run is restarted while the document is open in the Studio; documents nobody opens wait for their next edit (a scheduled sweep would need a one-way Blueprint stack promotion, owner decision). |
| The Function is deployed with the wrong ffmpeg (added 2026-11-26) | It checks the binary's sha256 before use and records a retryable `pending` with a "redeploy" message. Always deploy with `npm_config_platform=linux npm_config_arch=arm64`; npm 11 warns that these variables stop working in its next major version. |
| Kept originals are public (added 2026-11-26) | The Free plan only allows public datasets, so an anonymous query lists every original and its CDN URL, and 5 of the 29 Wagtail originals are iPhone clips with a GPS location tag (the MP4s carry no metadata). The old site served the same files from the public bucket. ~~Owner decision: accept, strip metadata from the originals, or keep them out of the public dataset.~~ **Decided: D17.** Every original, every image and every future upload is stripped losslessly; the datasets hold no location or personal metadata (validated, and scanned independently). The originals stay downloadable by anyone who finds them, now without metadata. |
| Deleted unstripped assets stay reachable (added 2026-11-26, D17; amended for D18) | Deleting an asset does not purge the asset CDN: an edge that served a file keeps it for up to 30 days (`s-maxage=2592000`), and the History API (90 days, readable without a token on a public dataset for published documents and asset documents) kept the deleted uploads' documents and the revisions that named them. Mitigations: the Functions read uploads privately (token plus a unique query parameter, so nothing enters the public cache), copies record a keyed digest instead of the upload id, and **D18**: both datasets were deleted and created again, after which the History API knew none of the 356 deleted ids per dataset and the CDN served none of the 670 deleted paths (deleting a dataset appears to purge its paths). The cached copies expire by 2026-12-26 at the latest; `migration/verify/src/deleted-asset-cdn-probe.mjs` re-probes them, and the drafted support email asks for a purge (optional now). |
| The old bucket and site still serve the unstripped originals (added 2026-11-26, D17) | `images-for-cms` is public and the live Wagtail site links its files, including the 11 with a location, until teardown step 6. The owner chose that timing. Nothing in the Sanity datasets links to the bucket copies of stripped files any more. |
| New uploads are public until a Function replaces them (added 2026-11-26, D17; amended for D18) | The window is a few seconds for an image used by a document (4.9 s measured), about a minute for an unused upload and tens of seconds for a video; anyone who knows or watches for the upload (the Listen API accepts anonymous connections on a public dataset) could fetch it then. Its first revision stays in the History API for 90 days (D18): file name, sha1 and the previews, and, only if an API client asked Sanity to extract them, location, EXIF or camera data. Studio uploads never ask, every upload from the repository goes through `uploadAsset`, a guard test fails on a `meta` request parameter, and upload-privacy removes extracted data within seconds and logs a WARN. A strip in the browser before the upload, private datasets (a paid plan) or an Enterprise custom role with `editHistory` (so the Functions could `purge` what they delete) would close it: owner decisions. |
| The edit history is public again (added 2026-11-27, D18) | From the recreate on, the History API records every change and returns earlier revisions of published documents and asset documents without a token to anyone with the id, for 90 days: also the earlier revisions of anything withdrawn later (an image deleted to take it off the site keeps its name and previews there). Listing a document's transactions needs a token. Mitigations: what is stored is already stripped (D17), drafts are not returned, and `history-check` and the verification's probes show what a dataset's history holds. Removing it again takes another recreate (`scripts/recreate-dataset.sh`, owner approval), `purge` deletes (Enterprise) or private datasets (a paid plan). |
| Something cannot be stripped (added 2026-11-26, D17) | An upload the strippers cannot handle (a video above about 480 MB for the Function's `/tmp`, a corrupt file, a format the in-place stripper and the stream copy both refuse) is removed from its blocks and deleted, with a message; a failed image is a validation error. PDF and STL files are not stripped by any Function yet (owner decision on the design in `privacy-review.md`). Location written into the video samples themselves (SEI user data of some dash cams and drones) stays, by the bit-identical rule; it is documented in the Studio help text. |
| The stripper or its tools change (added 2026-11-26, D17) | The stripper versions (`image-strip-v1`, `video-strip-v2`) and a fingerprint of the stripper code make the migration remake every copy and the Functions re-check uploads. The Function's ffmpeg is pinned (7.0.2, sha256 checked); the media tests also pass with the local ffmpeg 9.1. |
| An import or restore into a dataset that lacks the assets while the Functions are deployed (added 2026-11-27, D18) | `sanity datasets import` uploads each file first and sets `source` and `privacy` in a later patch, so upload-privacy would see every new asset document as an unchecked upload, and `testimonial-ascii-art` would regenerate the art while the references are missing. A restore into a dataset that already holds the same files (test 35, into staging) creates no asset documents. Otherwise remove the Functions first and deploy them again after the import, then set `PRIVACY_LINK_KEY` again, as the D18 recreate did (`reports/dataset-recreate.md`, step 3 and "The run"). |

## 16. Secrets and where they live

| Secret | Where it's stored |
|---|---|
| Sanity tokens (Editor for migration, Viewer for site, backups, and preview) | `~/cjoshmartin-migration/secrets.env` (mode 600), Vercel env vars (Preview tonight, Production in the morning), GitHub Actions secret `SANITY_BACKUP_TOKEN` (morning) |
| ~~Mux token~~ (superseded) | No longer used (Mux dropped 2026-11-26; the Mux account holds 0 assets). It still authenticates: revoke it in the Mux dashboard (Settings, Access Tokens), then delete `MUX_TOKEN_ID` and `MUX_TOKEN_SECRET` from `secrets.env`. It was never entered into the Studio, so no `secrets.mux` document exists, and no Vercel or GitHub variable holds it. |
| Revalidation webhook secret | `SANITY_REVALIDATE_SECRET`: `secrets.env`, the production Vercel env var, and the Sanity webhook "Revalidate cjoshmartin.com" (added 2026-11-26, set up after the merge). |
| Privacy link key (added 2026-11-26, D17) | `PRIVACY_LINK_KEY` (32 random bytes): `secrets.env` and the environment of the `image-privacy`, `video-to-mp4` and `upload-privacy` Functions (`npx sanity@latest functions env add`; a deploy that updates a Function keeps it, removing a Function drops it, so it was set again after the D18 redeploy). It keys the digests that link a stripped copy to its upload. Losing it loses only those links; rotating it means setting it on the three Functions and rerunning the migration's `--steps privacy,assets,videos` on both datasets. |
| GCP | No keys. Workload Identity Federation only. |
| Old leaked `secrets.json` key | Revoked in the morning teardown, and scrubbed from the archived repo's history. |
