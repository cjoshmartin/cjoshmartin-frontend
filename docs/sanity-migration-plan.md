# cjoshmartin.com: Wagtail → Sanity migration plan

Status: **draft, awaiting approval** · Written 2026-11-26

> **Amended 2026-11-26: Mux dropped (owner decision).** Every video is stored in Sanity as an MP4
> file asset, converted with the fixed settings in `studio/functions/video-to-mp4/settings.ts`, and
> the original upload is kept as a hidden, read-only reference that is never served. Studio uploads
> are converted automatically by the `video-to-mp4` Sanity Function. This replaces D7, the video
> parts of §4, §7.1, §8, §9 (step 4), §10, §11, test 30 and §15–16 below; the contract is
> "Videos (video contract v2)" in `docs/sanity-migration/schema-contract.md`. Those sections are
> amended in place where an owner step depends on them.

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
| Frontend | Next 16.3, React 19.2, on Vercel (GitHub `cjoshmartin-com/cjoshmartin-frontend`, public) | DNS is GoDaddy (`domaincontrol.com`). |
| Backend repo | local + Dokku remote only, **no GitHub** | `secrets.json` (GCP service-account key) is committed in 4 commits. |

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
| D7 | Videos | ~~**Mux** via `sanity-plugin-mux-input`. Basic quality, public playback.~~ **Superseded 2026-11-26:** MP4 file assets in Sanity (video contract v2), converted by the migration and, for Studio uploads, by the `video-to-mp4` Function; the original upload is kept, never served. |
| D8 | Testimonial ASCII art | A **Sanity Function** regenerates it whenever a testimonial image changes. The migration uses the same generator code. |
| D9 | Existing bugs | **Fix all of them** in the rewrite (§7.3). Each one gets a manual test. |
| D10 | Decommission | Archive the backend code to a **private, archived** GitHub repo (with `secrets.json` scrubbed from history). Take a final Postgres dump and copy it, plus the Wagtail export, into the backup bucket. Destroy the Dokku app and its Postgres. Remove the `backend` DNS record. Remove all backend code from the frontend. |
| D11 | GCS images bucket | **Keep it, make it private, and revoke the leaked key.** Disable public access on `images-for-cms` and delete the user-managed keys of `file-upload-2024@com-cjoshmartin`. Nothing gets deleted. |
| D12 | Rollout | Overnight work ends at a **PR plus a Vercel Preview** pointed at the production dataset. Josh runs the manual tests (§12) in the morning, then merges. Teardown runs only after Josh says go. |
| D13 | Tags | `medium` and `technology` become **reference documents**. Duplicates that differ only by case or whitespace are merged, and every merge is listed in the report. |
| D14 | Scope | **All content and all files.** Every page and snippet migrates. Unpublished pages and pending changes become Sanity drafts. Every content file in the bucket is uploaded, including unreferenced ones. Renditions and Django static files are excluded. |
| D15 | `/about` | Redirects to `/` permanently. |
| D16 | Overnight pre-approvals | Josh pre-approved: Sanity project setup and writes, Mux uploads, pushing a GitHub branch and opening a PR (never merging), and Vercel **Preview-scoped** env vars. Everything irreversible waits for the morning. |

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
   │  ├─ images/files on cdn.sanity.io
   │  ├─ mux.videoAsset docs  ──►  Mux (video hosting/streaming)
   │  └─ Function: testimonial-ascii-art (on image change)
   ▼
Next.js on Vercel (defineLive + draft mode + VisualEditing)
GitHub Actions weekly ──► private GCS bucket cjoshmartin-sanity-backups (snapshots + content-addressed assets)
```

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
| Mux video | `mux-video-<mediaId>` |
| Drafts | the same id with a `drafts.` prefix |

Assets get Sanity's own content-hash IDs.

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
- `codeBlock`: uses `@sanity/code-input`, with the language list `python, javascript, json, css, markup, html, go, bash, yaml, cpp`.
- `stlModel`: `file` (`.stl` only), `scale` (an integer from 1 to 1000).
- `video`: `asset` (`mux.video`).
- `divider`.

**PT annotations:**
- `link`: `href`, `openInNewTab`.
- `internalLink`: a reference to `blogPost`, `project`, `flexPage`, or `homePage`.
- `fileLink`: a reference to a file asset.

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

**Rendering**
- The `HtmlGenerator`/`RichTextArea` pair is replaced by a `PortableTextBody` component (`@portabletext/react`). It handles block, `imageBlock`, `youtube`, `codeBlock` (existing `CodeArea`), `stlModel` (existing lazy STL viewer), `video` (`@mux/mux-player-react` with the same autoplay/loop/muted/playsinline/controls behaviour), and `divider`.
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
  - add `cdn.sanity.io` and `image.mux.com` to the allowed image hosts
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
- `visionTool`, `codeInput`, `muxInput`.

**Validation**
- Required fields, and slugs unique per type.
- `scale` between 1 and 1000.
- `.stl` only for STL files.
- Alt text warnings on images.

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
   - Upload **all** content images and files from local disk to Sanity, with `source: {name:"wagtail", id, url}` and the title set.
   - Build a map from Wagtail id to Sanity asset id.
   - Re-runs don't create duplicates because Sanity names assets by their hash.
4. **Videos** (amended 2026-11-26: Mux dropped)
   - `convert`: convert each of the 29 media files from the local bucket mirror with `buildFfmpegArgs` (ffmpeg 7.0 or newer) and check every output, including that every decoded frame of the original is in the MP4 at its own time.
   - `videos`: upload each original and its MP4 as file assets (the MP4 with source `video-to-mp4`, the settings version recorded on it); re-runs reuse assets by content hash and reuse only MP4s made with the current settings.
   - After `import`, `prune-mp4s` deletes the MP4s of the Wagtail videos made with other settings once nothing references them.
   - Wagtail media thumbnails are uploaded as image assets, with `source` linking them to their media id.
5. **ASCII art:** generate `asciiArt` for every testimonial using the shared generator.
6. **Import**
   - Run `sanity datasets import --replace` into **`staging`**.
   - Validate (§11).
   - Fix and repeat until validation passes.
   - Then import the same files into **`production`** and validate again.

**Content freeze:** nobody edits Wagtail between the export and cutover. Anything changed there won't be migrated.

## 10. Weekly backups (`scripts/backup/` + `.github/workflows/sanity-backup.yml`)

**Bucket:** `gs://cjoshmartin-sanity-backups`
- us-central1, Standard storage class
- uniform bucket-level access, public access prevention enforced, no public URLs

**Access**
- Service account `sanity-backup@com-cjoshmartin` with `objectCreator` and `objectViewer` on that bucket only. It has no delete permission, so the CI can't destroy backups, and every object is written create-only.
- GitHub authenticates through Workload Identity Federation. The provider only accepts `repository == cjoshmartin-com/cjoshmartin-frontend` on `refs/heads/main`, so no key is stored anywhere.

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
   - upload each asset whose `assets/...<sha1>` object doesn't exist yet
   - (amended 2026-11-26) videos are ordinary file assets now, so they are backed up like every other file; there is no Mux step
   - upload the snapshot files, then write the marker
4. **Size check:** fail if the bucket is larger than 4 GB.

**Restore:** `scripts/backup/restore.mjs --snapshot <ts> --dataset <name>` rebuilds a standard Sanity import tarball (`data.ndjson` plus `images/` and `files/` with `_sanityAsset` directives) and runs `sanity datasets import --replace`.

**Workflow**
- Triggers: `schedule: '0 9 * * 0'` and `workflow_dispatch` (inputs: dataset, dry-run).
- Permissions: `id-token: write` and `actions: write`.
- A keepalive step re-enables the workflow through the GitHub API, so the 60-day inactivity rule can't turn it off.
- The Sanity read token (Viewer role, which can read drafts) is a GitHub secret. The GCP provider and service account are GitHub variables.

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
   - image, video, and embed counts
   - internal links, and visible-text similarity
   - expected differences (from §7.3) are allowlisted and listed
   - Playwright screenshots at 1440 and 390 px widths, old next to new, collected in an HTML report
8. **Backups:** the tests in §10.
9. **Review:** an independent review agent reviews the whole PR diff for correctness against this plan. Its findings are fixed before the PR is marked ready.

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
26. Open a blog post. Rich text, code blocks, the STL block, and video blocks show. The hidden "Migration" group has the Wagtail id.
27. Draft check: if Wagtail had unpublished pages or changes, they appear as drafts in Studio and **not** on the site.
28. Presentation tab:
    - the site loads in the iframe
    - clicking a heading focuses its field
    - typing shows a live draft
    - discarding the draft reverts it
    - (Vercel preview protection may block the iframe; if so, check this one on production after merge)
29. On a staging copy of a testimonial (use the dataset switcher), change the photo. Within about a minute `asciiArt` updates.
30. Upload a short test video to a staging blog post. Within about a minute the block shows "Ready": `file` is the converted MP4 and "Original upload" holds your file. It plays in the Presentation preview. (Amended 2026-11-26; it used to go to Mux.)
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
4. **You:** create a Mux access token (Mux Video read and write). Put it in `~/cjoshmartin-migration/secrets.env`, which I'll create with blank placeholders, as `MUX_TOKEN_ID=` and `MUX_TOKEN_SECRET=`.
5. **Me:** check the prerequisites:
   - the export zip is valid and its counts match the live API
   - `sanity debug` shows the new account
   - the Mux token works
6. **Me:** once those pass, create the Sanity project, both datasets, and the tokens (stored in `secrets.env`, never committed), then start the overnight workflow. You can go to sleep.
7. *(Optional)* Overnight steps can be blocked by the permission system. A blocked step is logged and the run carries on with the other work. Anything blocked is waiting for you in the morning.

### Overnight (agents, §14)

Schema and Studio → migration into staging → validation → import into production → frontend rewrite → parity crawl → backups code → teardown scripts (dry-run only) → review → PR with Vercel Preview → morning report.

### Morning, with you

1. Read the morning report: what passed, every allowlisted difference, any blocked steps.
2. Run the manual tests A–G (§12) on the Preview URL.
3. Approve, then I add the Production env vars on Vercel and you merge. Then run test 16 and test 28 (Disqus and Visual Editing) on production if they couldn't be checked on Preview.
4. Backups:
   - `! gcloud auth login` as the `com-cjoshmartin` owner
   - I run `setup-gcp.sh` and set the GitHub secrets and variables
   - you run tests H (32–36)
5. Teardown, with your go-ahead. I prepare every command. The steps marked *you* need your credentials or SSH.
   - **you:** run `ssh dokku@159.203.93.178 postgres:list`, then `postgres:export <svc> > ~/cjoshmartin-migration/final/wagtail-final.dump`
   - **me:** upload that dump, the export zip, `dumpdata`, and the GCS file list to `archive/`
   - **me:** push the scrubbed backend repo to a private repo and archive it
   - **you, or me with permission:** `apps:destroy` and `postgres:destroy` on Dokku
   - **you:** delete the `backend` A record in GoDaddy
   - **me:** make `images-for-cms` private and delete the `file-upload-2024` service-account keys
   - **you:** tests I (37–41)

### Rollback

- **Before teardown:** use Vercel Instant Rollback or revert the PR. The old frontend reads Wagtail again immediately.
- **After teardown:** this is why teardown waits for your tests. Recovering means restoring the archived Postgres dump into a new Dokku app and re-pointing DNS. It's possible because the archive holds everything, but it's slow.

## 14. Work packages (one sub-agent each, run as a workflow)

Each agent gets only its package brief: goal, inputs, owned paths, constraints, and acceptance criteria. Packages own disjoint paths, and each works on its own branch or worktree off `sanity-migration`. The orchestrator (me) merges them in dependency order and owns all shared root files. Secrets are only ever read from `~/cjoshmartin-migration/secrets.env`, never printed, and never committed.

| WP | Owns | Depends on | Output and acceptance |
|---|---|---|---|
| **WP1 Schema + Studio** | `studio/` (except `functions/`) | project created | Schemas, structure, plugins, Presentation config, TypeGen config, CORS. Studio deployed. Schema contract doc. `sanity build` and `sanity schema deploy` pass. |
| **WP2 ASCII generator + Function** | `studio/functions/testimonial-ascii-art/`, blueprint | WP1 types | An exact port of ascii-magic 2.3.0. Unit tests. Comparison report against Python output for all 9 images. Function deployed and verified on staging. |
| **WP3 Migration ETL** | `migration/wagtail-to-sanity/` | WP1, WP2 module, export zip, Mux token | Extract, transform, assets, Mux, import to staging, validation (§11.1–5), then production. Morning report section: counts, merges, issues. |
| **WP4 Frontend rewrite** | `app/`, `components/`, `lib/`, `sanity/`, `next.config.js`, root config files | WP1 types, WP3 staging data | Every item in §7 implemented. `next build`, lint, and typecheck pass. Each bug fix noted in the PR body. |
| **WP5 Backups** | `scripts/backup/`, `.github/workflows/sanity-backup.yml` | WP1 project; restore test after WP3's production import | Everything in §10. Tests pass. Local end-to-end and restore into staging pass. `setup-gcp.sh` written, linted, and dry-run with `--print-only`. |
| **WP6 Decommission prep** | `scripts/decommission/`, a scrubbed copy of the backend repo in `~/cjoshmartin-migration/backend-archive/` | none | `git filter-repo` copy with `secrets.json` gone from every commit (verified). Teardown scripts with `--dry-run`, printing every command. A checklist matching §13 morning step 5. **Runs nothing irreversible.** |
| **WP7 Verification** | `migration/verify/` | WP3 (production), WP4 | Parity crawl plus screenshots (§11.7). HTML report. Fills in the morning report. |
| **WP8 Review** | read-only | WP1–WP7 merged | Independent correctness review of the full diff against this plan. Findings fixed by the owning WP, or by me, before the PR is marked ready. |

The PR is opened by me after WP8, using `gh pr create` from `sanity-migration`. The body has a summary, the decisions table, the bug-fix list, links to the reports, and the §12 checklist. There is no co-author trailer.

## 15. Risks and how they're handled

| Risk | Mitigation |
|---|---|
| Next 16.3 or React 19.2 incompatible with next-sanity or the Studio | WP1 and WP4 check the latest compatible versions first. The Studio is standalone, so it never shares the Next build. |
| A permission prompt blocks an overnight step | It's logged and the run continues with other packages. Anything blocked appears in the morning report. |
| Rich-text edge cases | Strict allowlist, a failing transform on anything unknown, text-parity checks, and screenshot diffs. |
| Anchor or Disqus breakage | The slug algorithm is kept and the `legacy.wagtailId` identifier is preserved. Both are covered by tests 13 and 16. |
| Vercel preview protection blocks the Presentation iframe or the Disqus domain | Those tests fall back to production right after merge, still before teardown. |
| Sanity Free plan quotas | About 140 MB of images and files (videos live on Mux), a few hundred documents, and server-side cached reads. Well under the 100 GB asset, 100 GB/month bandwidth, and 10k document quotas. |
| Mux master-access cost for backups | Checked in Mux's docs by WP5. A fallback path is defined in §10. |
| Content edited in Wagtail after the export | Content freeze from export time to cutover. The export manifest records the export time. |

## 16. Secrets and where they live

| Secret | Where it's stored |
|---|---|
| Sanity tokens (Editor for migration, Viewer for site, backups, and preview) | `~/cjoshmartin-migration/secrets.env` (mode 600), Vercel env vars (Preview tonight, Production in the morning), GitHub Actions secret (morning) |
| Mux token | No longer used (Mux dropped 2026-11-26). Revoke it in the Mux dashboard, then delete it from `secrets.env`. It was never entered into the Studio, so no `secrets.mux` document exists. |
| Revalidation webhook secret | `SANITY_REVALIDATE_SECRET`: `secrets.env`, the production Vercel env var, and the Sanity webhook "Revalidate cjoshmartin.com" (added 2026-11-26, set up after the merge). |
| GCP | No keys. Workload Identity Federation only. |
| Old leaked `secrets.json` key | Revoked in the morning teardown, and scrubbed from the archived repo's history. |
