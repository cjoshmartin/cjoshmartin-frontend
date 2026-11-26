# Sanity schema contract

The content model of the cjoshmartin.com Sanity project, exactly as implemented in
[`studio/`](../../studio). Other work packages (migration, frontend, backups, Function) rely on the
type names, field names, stored values and document ids below. If the Studio schema changes, this
file changes in the same commit.

| | |
|---|---|
| Project | `j3vdh6ti` |
| Datasets | `production` (live), `staging` (rehearsal, restore tests). Both public: published documents are readable without a token. |
| Studio | <https://cjoshmartin.sanity.studio> (app id `uihrx4okiju6hmbteqql9b8u`, auto-updates on). Workspaces `/production` and `/staging`, same schema. |
| Deployed schemas | `_.schemas.production`, `_.schemas.staging` (`npm run schema:deploy` in `studio/`) |
| API version used by the Studio | `2026-11-01` |
| Extracted schema (TypeGen input) | `studio/schema.json` |
| Generated types | `sanity.types.ts` in the repo root, written by `npm run typegen` in `studio/` |

## Deviations from the work-package brief

Read these first. Everything else matches the brief.

1. **Vercel origin is scoped, not `https://*.vercel.app`.** Presentation `allowOrigins` and the
   credentialed CORS origin use `https://cjoshmartin-frontend-*-josh-martins-projects-0186b4e9.vercel.app`.
   It matches every deployment and branch URL of this Vercel project (for example
   `cjoshmartin-frontend-git-sanity-migration-josh-martins-projects-0186b4e9.vercel.app`) and
   nothing else. Sanity's CORS docs say never to add a platform-wide wildcard with credentials, and
   any Presentation origin can read drafts through the preview iframe (a crafted Studio link
   `?preview=https://anything.vercel.app` would otherwise be accepted). Draft-mode live updates on a
   Vercel preview need credentials, so a credential-less `*.vercel.app` alone would not work either.
2. **`studioHost` is deprecated** in this CLI version. `studio/sanity.cli.ts` keeps
   `studioHost: 'cjoshmartin'` as asked and also sets `deployment.appId`, which now identifies the
   hosted Studio and takes precedence.
3. **Hosted Studio URL redirects to the Sanity Dashboard.** `https://cjoshmartin.sanity.studio/`
   answers `302` to `https://www.sanity.io/@opn7xage4/studio/uihrx4okiju6hmbteqql9b8u` (sign-in, then
   the Studio inside the Dashboard). The Studio's own files are served from the hostname
   (`/static/...` returns 200).
4. **Small additions** (no change to stored data shapes):
   - `service.image` has `hotspot: true` (the brief listed only "image, alt"). Hotspot data is optional.
   - The home page singleton also loses the **unpublish** action, not only create, delete and
     duplicate, so the published home page can't be taken off the site by accident.
   - `legacy` is hidden while empty, so it only shows (read-only, Migration group) on migrated documents.
   - Extra validation, listed under [Validation](#validation): slug format, tag titles unique
     ignoring case, redirect sources unique, code languages limited to the list, `intro` required.
5. **Names the brief left open:** the `internalLink` annotation's reference field is named
   `reference`; the `fileLink` annotation's field is `file` (type `file`).

## Importing from the Studio package

| Path | Exports | Dependencies |
|---|---|---|
| `studio/schemaTypes/constants.ts` | `AUDIENCE_OPTIONS`, `DEFAULT_AUDIENCE`, `PROJECT_TYPE_OPTIONS`, `DEFAULT_PROJECT_TYPE`, `IMAGE_LAYOUT_OPTIONS`, `DEFAULT_IMAGE_LAYOUT`, `CODE_LANGUAGES`, `DEFAULT_CODE_LANGUAGE`, `INTERNAL_LINK_TYPES`, `HOME_PAGE_ID`, `VIDEO_CONVERSION_STATUSES`, and the types `Audience`, `ProjectType`, `ImageLayout`, `CodeLanguage`, `VideoConversionStatus` | none (plain TypeScript, safe to import from any package with a TS runtime) |
| `studio/schemaTypes/shared/validation.ts` | `SLUG_PATTERN`, `validateSlugFormat`, `getYouTubeVideoId`, `validateYouTubeUrl`, `validateSitePath`, `validatePathOrAbsoluteUrl`, `fileAssetExtension` | none |
| `studio/schemaTypes/shared/video-conversion.ts` | `videoNeedsConversion` (the contract's rule), `videoConversionState` and `videoConversionLabel` (the preview's status line; pass `SETTINGS_VERSION`, because a failure is final only for its settings), the Studio's stuck check `videoConversionNudge` and `nudgedConversion`, `STALE_PROCESSING_SECONDS`, `RETRY_DELAY_SECONDS`, and the types `VideoValue`, `VideoConversionValue`, `FileValue`, `VideoConversionState`, `VideoConversionNudgeReason` | none (a type-only import from `constants.ts`; Node's type stripping loads it) |
| `studio/functions/video-to-mp4/settings.ts` | The MP4 settings, see [MP4 settings](#mp4-settings): `SETTINGS_VERSION`, `buildFfmpegArgs`, `VIDEO_FILTER`, `expectedOutputSize`, `convertedFilename`, `CONVERTED_ASSET_SOURCE_NAME`, `CONVERTED_ASSET_SETTINGS_FIELD`, `OUTPUT_MIME_TYPE`, `OUTPUT_EXTENSION`, `MAX_DIMENSION`, `CRF`, `AUDIO_BITRATE`, `AUDIO_CHANNELS`, `X264_PRESETS`, `DEFAULT_PRESET`, `isX264Preset`, `MIN_FFMPEG_VERSION`, `parseFfmpegVersion`, `checkFfmpegVersion`, and the types `X264Preset`, `FfmpegArgsOptions`, `VideoSize`, `FfmpegVersion` | none (no imports, only erasable TypeScript: runs under the Functions bundler, `tsx` and Node's type stripping) |
| `studio/functions/video-to-mp4/frames.ts` | The frame-time check every converter runs: `compareFrameTimes`, `frameTimeProblems`, `FRAME_TIME_TOLERANCE_SECONDS`, and the showinfo parser the Function uses (`FrameTimesCollector`, `SHOWINFO_FILTER`) | none |
| `studio/functions/privacy/constants.ts` | See [Privacy](#privacy-location-and-personal-metadata): `IMAGE_STRIP_VERSION`, `VIDEO_STRIP_VERSION`, `PRIVACY_FIELD`, `IMAGE_PRIVACY_SOURCE_NAME`, `VIDEO_ORIGINAL_SOURCE_NAME`, `ACCEPTED_IMAGE_MIME_TYPES`, `IMAGE_ACCEPT`, `IMAGE_METADATA_OPTIONS`, `ASSET_PRIVACY_STATUSES`, and the types `AssetPrivacy`, `AssetPrivacyStatus` | none (no imports, only erasable TypeScript) |
| `studio/functions/privacy/image-strip.ts` | `stripImage`, `analyzeImage`, `detectImageFormat`, `IMAGE_MIME_TYPES`, `ImageStripError` | Node built-ins only (`node:crypto`, `node:zlib`) |
| `studio/functions/privacy/video-strip.ts` | `stripVideo`, `planStrip`, `stripArgs`, `describeContainer`, `checkIsobmffBoxes`, `comparePackets`, `parseFrameMd5`, `parseStreamHash`, `majorBrand`, `VideoStripError`, `VideoStripTimeoutError` | Node built-ins only; ffmpeg is passed in |
| `studio/schemaTypes/shared/image-privacy.ts` | `PRIVATE_IMAGE_OPTIONS`, `imageFormatProblem`, `imagePrivacyState`, `imagePrivacyWarning`, `imagePrivacyLabel` | `functions/privacy/constants.ts` only |
| `studio/schemaTypes/index.ts` | `schemaTypes: SchemaTypeDefinition[]` (every type below except `code`, which its plugin adds), each type definition by name (`blogPost`, `project`, ...), and everything from `constants.ts` | `sanity`, `@sanity/icons` (resolved from `studio/node_modules`, so run `npm ci` in `studio/` first) |

The Next.js app should not import from `studio/`. It uses `sanity.types.ts` and its own queries.

## Document ids

Deterministic, so migration reruns converge. Drafts use the same id with a `drafts.` prefix.
Assets keep Sanity's content-hash ids (`image-<sha1>-<w>x<h>-<ext>`, `file-<sha1>-<ext>`).

| Type | `_id` |
|---|---|
| `homePage` | `homePage` (singleton; the Studio only ever opens this id) |
| `person` | `person-<wagtailSnippetId>` |
| `testimonial` | `testimonial-<wagtailSnippetId>` |
| `service` | `service-<wagtailSnippetId>` |
| `blogPost` | `blogPost-<wagtailPageId>` |
| `project` | `project-<wagtailPageId>` |
| `flexPage` | `flexPage-<wagtailPageId>` |
| `medium` | `medium-<slug>` |
| `technology` | `technology-<slug>` |
| `redirect` | `redirect-<wagtailRedirectId>` |

There are no video documents: videos are file assets referenced from `video` blocks (see
[Videos](#videos-video-contract-v2)).

## Stored codes

| Field | Stored value | Studio title |
|---|---|---|
| `audience` (blogPost, project, service) | `DEV` | Developer |
| | `MAK` | Maker |
| `projectType` (project) | `CLI` | Client |
| | `PER` | Personal |
| `imageBlock.layout` | `fullwidth`, `left`, `right` | Full width, Left, Right |
| `code.language` | `python`, `javascript`, `json`, `css`, `markup`, `html`, `go`, `bash`, `yaml`, `cpp` | Python, JavaScript, JSON, CSS, Markup, HTML, Go, Bash, YAML, C++ |

The codes are the Wagtail values, so URLs like `/projects?project_type=PER` keep working.
Defaults for new documents follow Wagtail: audience `DEV`, project type `CLI`, code language `bash`,
image layout `fullwidth`, `isUnlisted` `false`, redirect `permanent` `true`, `date` today.

## Document types

"Req." means the document fails validation (error) without it. Field groups are Studio tabs only;
they do not change the data. Every document with `legacy` shows it in the **Migration** group.

### `homePage` (singleton, `_id: "homePage"`)

| Field | Type | Req. | Notes |
|---|---|---|---|
| `title` | string | yes | |
| `bio` | `blockContent` | | |
| `author` | reference → `person` | | Whose photo, name and links the home page shows. |
| `testimonials` | array of reference → `testimonial` | | Ordered. Unique. |
| `services` | array of reference → `service` | | Ordered. Unique. |
| `seo` | `seo` | | |
| `legacy` | `legacy` | | Read-only. |

Registered in `document.singletons`; create, duplicate, delete and unpublish are not available.

### `person`

| Field | Type | Req. | Notes |
|---|---|---|---|
| `firstName` | string | yes | |
| `lastName` | string | yes | |
| `image` | image (hotspot) with `alt` string | | `{_type: "image", asset, hotspot?, crop?, alt?}`. Missing alt is a warning. Private image options ([Privacy](#privacy-location-and-personal-metadata)). |
| `location` | string | | |
| `jobTitle` | string | | |
| `bio` | `blockContent` | | |
| `email` | string | | Must be an email address. |
| `github` | url | | http or https. |
| `legacy` | `legacy` | | Read-only. |

### `testimonial`

| Field | Type | Req. | Notes |
|---|---|---|---|
| `firstName` | string | yes | |
| `lastName` | string | yes | |
| `image` | image (hotspot) with `alt` string | | Warning when missing (the ASCII art comes from it). Private image options. |
| `jobTitle` | string | | |
| `relationship` | string | | |
| `link` | url | | http or https. |
| `body` | `blockContent` | | |
| `asciiArt` | text | | Read-only in the Studio. Written by the `testimonial-ascii-art` Function and the migration: HTML of `<span style="color:#rrggbb">` characters and `<br>` line breaks. |
| `asciiArtSource` | string | | Read-only. The image asset `_id` the art was generated from (for example `image-<sha1>-<w>x<h>-jpg`). |
| `legacy` | `legacy` | | Read-only. |

### `service`

| Field | Type | Req. | Notes |
|---|---|---|---|
| `title` | string | yes | |
| `image` | image (hotspot) with `alt` string | | Private image options. |
| `description` | `blockContent` | | |
| `link` | url | | http(s) or a site path. |
| `linkText` | string | | Plain string (Wagtail's rich-text `link_text` flattened). Warning when `link` is set and this is empty. |
| `audience` | string `DEV` \| `MAK` | yes | |
| `legacy` | `legacy` | | Read-only. |

### `blogPost`

| Field | Type | Req. | Notes |
|---|---|---|---|
| `title` | string | yes | |
| `slug` | slug (source `title`) | yes | Unique among `blogPost` documents. Format: lowercase letters, digits, single hyphens. |
| `date` | date `YYYY-MM-DD` | yes | |
| `intro` | string | yes | At most 250 characters. |
| `author` | reference → `person` | | |
| `body` | `blockContent` | | |
| `heroMedia` | array of `imageWithAlt` \| `youtube` | | Each item has `_key`. |
| `contentImage` | `imageWithAlt` | | |
| `audience` | string `DEV` \| `MAK` | yes | |
| `isUnlisted` | boolean | | |
| `seo` | `seo` | | |
| `legacy` | `legacy` | | Read-only. `legacy.wagtailId` is the Disqus identifier. |

### `project`

Every `blogPost` field (same names, types and rules; slug unique among `project` documents), plus:

| Field | Type | Req. | Notes |
|---|---|---|---|
| `projectType` | string `CLI` \| `PER` | yes | |
| `previewImage` | `imageWithAlt` | | |
| `client` | string | | |
| `website` | url | | http or https. |
| `mediums` | array of reference → `medium` | | Unique. |
| `technologies` | array of reference → `technology` | | Unique. |
| `testimonials` | array of reference → `testimonial` | | Ordered. Unique. |

### `flexPage`

| Field | Type | Req. | Notes |
|---|---|---|---|
| `title` | string | yes | |
| `slug` | slug (source `title`) | yes | Unique among `flexPage` documents. Same format rule. |
| `body` | `blockContent` | | |
| `seo` | `seo` | | |
| `legacy` | `legacy` | | Read-only. |

### `medium` and `technology`

| Field | Type | Req. | Notes |
|---|---|---|---|
| `title` | string | yes | Unique per type, ignoring case (the frontend filters by title). |
| `slug` | slug (source `title`) | yes | Unique per type. Same format rule. |

No `legacy` field.

### `redirect`

| Field | Type | Req. | Notes |
|---|---|---|---|
| `source` | string | yes | Site path starting with `/` (not `//`, no spaces). Unique among redirects. |
| `destination` | string | yes | Site path starting with `/`, or an absolute `http(s)://` URL. Must differ from `source`. |
| `permanent` | boolean | yes | `true`: 308, `false`: 307. |

No `legacy` field.

## Object types

### `seo`

`{_type: "seo", title?: string, description?: string (text)}`. Warnings (not errors) above 70 and
160 characters.

### `legacy` (read-only)

```json
{
  "_type": "legacy",
  "wagtailId": 13,
  "wagtailType": "blog.BlogPage",
  "wagtailUrlPath": "/home/blog/interview-practice/",
  "firstPublishedAt": "2023-01-02T03:04:05Z",
  "lastPublishedAt": "2024-01-02T03:04:05Z"
}
```

`wagtailId` number, `wagtailType` string (Wagtail model label), `wagtailUrlPath` string (empty or
absent for snippets), `firstPublishedAt` and `lastPublishedAt` ISO datetimes.

### `imageWithAlt`

Image type named `imageWithAlt`, hotspot on, with `alt` string and `caption` string:
`{_type: "imageWithAlt", asset: {_type: "reference", _ref: "image-..."}, hotspot?, crop?, alt?, caption?}`.
Used by `heroMedia[]`, `contentImage`, `previewImage`. Missing alt is a warning. Private image
options ([Privacy](#privacy-location-and-personal-metadata)).

### `imageBlock` (rich text)

Image type named `imageBlock`, hotspot on, fields `alt` string, `caption` string, `layout`
(`fullwidth` | `left` | `right`, required). Errors without an image asset. Missing alt is a warning.
Private image options.

### `youtube`

`{_type: "youtube", url: string}`. `url` is required and must be a YouTube video URL:
`youtube.com/watch?v=<id>`, `youtu.be/<id>`, `youtube.com/{embed,live,shorts,v}/<id>` (also
`m.`, `music.`, `youtube-nocookie.com`). Store real `&`, not `&amp;`.

### `stlModel`

`{_type: "stlModel", file: {_type: "file", asset: {_type: "reference", _ref: "file-<sha1>-stl"}}, scale: number}`.
`file` is required and must be an `.stl` asset (checked from the asset id suffix, so upload with a
filename ending in `.stl`). `scale` is a required integer from 1 to 1000 (Wagtail values: 20, 30).

### `video`

Video contract v2; the full rules are in [Videos](#videos-video-contract-v2).

```json
{
  "_type": "video",
  "_key": "v1",
  "file": {"_type": "file", "asset": {"_type": "reference", "_ref": "file-<sha1>-mp4"}},
  "original": {"_type": "file", "asset": {"_type": "reference", "_ref": "file-<sha1>-mov"}},
  "conversion": {
    "status": "ready",
    "message": "",
    "sourceAssetId": "file-<sha1>-mov",
    "outputAssetId": "file-<sha1>-mp4",
    "settingsVersion": "h264-crf23-max1920-v2",
    "originalStripped": true,
    "stripVersion": "video-strip-v1",
    "updatedAt": "2026-11-26T05:00:00.000Z"
  }
}
```

| Field | Type | Req. | Studio | Notes |
|---|---|---|---|---|
| `file` | file, `accept: "video/*"` | yes | editable | The file the site plays. After conversion it is the converted MP4. Must reference an asset whose `mimeType` starts with `video/`. |
| `original` | file | | read-only, hidden while empty | The upload, kept but never linked by the site (like every file of a public dataset it can be downloaded by anyone who finds it). Since 2026-11-26 a copy of it without location and personal metadata (same video and audio packets); set by the converter. An upload whose metadata cannot be removed is not kept: `file` and `original` are removed (see Privacy). |
| `conversion` | object | | read-only, collapsed | Set by the converter. |
| `conversion.status` | string `pending` \| `processing` \| `ready` \| `failed` | | | Titles Pending, Processing, Ready, Failed. Other values are a validation error. `pending` with a message for the current file is a retryable problem (not the video's fault) that the converter retries. |
| `conversion.message` | string | | | Failure reason, retry reason, or other converter details. |
| `conversion.sourceAssetId` | string | | | `_id` of the original asset that was (or is being) converted. Unset when the converter removed an upload it could not strip (it never names a deleted upload). |
| `conversion.outputAssetId` | string | | | `_id` of the MP4 asset produced. |
| `conversion.settingsVersion` | string | | | `SETTINGS_VERSION` the MP4 was made with, `h264-crf23-max1920-v2` today. |
| `conversion.originalStripped` | boolean | | | `true` when `original` is the upload's copy without location and personal metadata. The video-to-mp4 Function writes it on every ready result (`false` only for an adopted MP4 whose original was never stripped). |
| `conversion.stripVersion` | string | | | `VIDEO_STRIP_VERSION` of that copy, `video-strip-v1` today. |
| `conversion.updatedAt` | datetime | | | When the converter last wrote `conversion`. |

The asset ids are plain strings, not references, so they never block deleting an asset.

### `divider`

`{_type: "divider", style: "line"}`. `style` is hidden in the Studio and always `"line"`.

### `code` (from `@sanity/code-input`)

`{_type: "code", language: string, code: string (text), filename?: string, highlightedLines?: number[]}`.
`language` must be one of the codes in [Stored codes](#stored-codes) and `code` must not be blank.
Wagtail's code block `text` becomes `code`. The Studio highlights `markup` as HTML, `go` with the Go
mode, `bash` with the shell mode and `cpp` with a C++ mode registered in `sanity.config.ts`.

### `blockContent` (Portable Text)

Array type. Members, in insert-menu order: `block`, `imageBlock`, `youtube`, `code`, `stlModel`,
`video`, `divider`. Every member and every span needs a `_key`.

- **Styles:** `normal`, `h1`, `h2`, `h3`, `h4`, `h5`, `h6`, `blockquote`.
- **Lists:** `listItem: "bullet" | "number"` with `level` (1 = top level).
- **Decorators:** `strong`, `em`, `code`, `underline`, `strike-through`.
- **Annotations** (in `markDefs`, referenced from span `marks` by `_key`):

| `_type` | Fields | Rules |
|---|---|---|
| `link` | `href` (url), `openInNewTab` (boolean) | `href` required; absolute `http`, `https`, `mailto`, `tel`, or relative (`/path`, `#anchor`). |
| `internalLink` | `reference` (reference → `blogPost` \| `project` \| `flexPage` \| `homePage`) | `reference` required. |
| `fileLink` | `file` (file: `{_type: "file", asset: {_type: "reference", _ref: "file-..."}}`) | Must have an asset; PDF only (see Privacy). |

Example block:

```json
{
  "_type": "block",
  "_key": "a1",
  "style": "normal",
  "markDefs": [{"_type": "link", "_key": "l1", "href": "https://github.com/", "openInNewTab": false}],
  "children": [{"_type": "span", "_key": "a1s0", "text": "See GitHub", "marks": ["l1", "strong"]}]
}
```

A Wagtail `<br>` is a `\n` inside span text. Heading anchors are not stored; the frontend derives
them from heading text.

## Videos (video contract v2)

Mux is gone: `sanity-plugin-mux-input`, the `mux.video` / `mux.videoAsset` / `mux.apiKey` types and
the Videos tool were removed from the Studio, and no schema deployed to `production` or `staging`
has a Mux type. Every video is a Sanity file asset in MP4, converted with fixed settings.

**Needs conversion.** A `video` block needs conversion when `file.asset._ref` is set and differs
from `conversion.outputAssetId` (`videoNeedsConversion` in
`studio/schemaTypes/shared/video-conversion.ts`). That covers a new upload, a replaced file and a
migrated block that has not been converted yet.

**What a converter does** (the video-to-mp4 Sanity Function for Studio uploads, the migration for
the 29 Wagtail videos):

1. Takes `file.asset._ref` as the upload. Unless it already is a stripped copy (`privacy.status`
   `stripped` with the current `VIDEO_STRIP_VERSION`), the Function makes the original private
   first: it reuses the upload's earlier copy (`source: {name: "video-to-mp4-original", id: <upload
   _id>}` with that version) or strips and uploads one ([Privacy](#privacy-location-and-personal-metadata)).
   That copy is the source asset from here on.
2. Looks for an existing asset with `source.name == "video-to-mp4" && source.id == <source asset _id>`
   **and `videoToMp4SettingsVersion == SETTINGS_VERSION`** and reuses it instead of converting again
   (idempotent, no duplicate conversions, never an MP4 made with other settings).
3. Otherwise converts with `buildFfmpegArgs` (below; ffmpeg 7.0 or newer), checks that every decoded
   frame of the source is in the MP4 at its own time (within 1 ms, measured from the first frame)
   and no other frame is (`frames.ts`), and uploads the MP4 as a file asset with
   `originalFilename` `<original base name>.mp4` (`convertedFilename`), `mimeType` `video/mp4` and
   `source: {name: "video-to-mp4", id: <source asset _id>}` (`CONVERTED_ASSET_SOURCE_NAME`). Right
   after the upload it sets `videoToMp4SettingsVersion` (`CONVERTED_ASSET_SETTINGS_FIELD`) on that
   asset document to `SETTINGS_VERSION`.
4. Sets `original` to the source file (the stripped copy), `file` to the MP4, and `conversion` to
   `{status: "ready", sourceAssetId, outputAssetId, settingsVersion, originalStripped, stripVersion,
   updatedAt}`, where `settingsVersion` is the version recorded on the MP4 asset, then deletes the
   unstripped upload once nothing references it. While working it may write
   `status: "processing"`. When the video itself cannot be converted: `status: "failed"` with
   `sourceAssetId` and `message`, leaving `file` as it was. When the problem is not the video's
   fault (the converter's setup, a download, an API error): `status: "pending"` with
   `sourceAssetId`, `message` and `updatedAt`, retried by the first event 10 minutes or more later.

**Old conversions after a settings change.** A ready block never needs conversion, so blocks
converted with an earlier `SETTINGS_VERSION` keep their MP4 until they are redone on purpose:

- **Wagtail videos:** rerun the migration. Its `convert` and `videos` steps make and upload new MP4s,
  `import` points the blocks at them, and `prune-mp4s` then deletes the MP4s of the Wagtail
  originals made with other settings, once nothing references them. On 2026-11-26 all 29 went from
  `h264-crf23-max1920-v1` to `h264-crf23-max1920-v2` this way.
- **Studio uploads:** point `file` back at the original (`original`), or remove the block and add
  the video again; the Function converts it with the current settings. If an editor picks an MP4
  the converter made with older settings, the Function itself points `file` back at that MP4's
  original (`source.id`) and converts it; when the original is gone, it converts the old MP4 like
  any other upload.

MP4 assets made before `videoToMp4SettingsVersion` existed have no such field; no converter
reuses them.

**Studio.** The block preview's title is the `file` asset's `originalFilename`; its subtitle is
"No video file", "Converting to MP4..." (needs conversion and no failure for this file), "Waiting
to retry the conversion: <message>" (`pending` with a message for this file, or `failed` under
another settings version, which the Function converts again), "Ready" (`file` is the MP4; followed
by ". Original kept without location data" when `conversion.originalStripped` is true or the
original's asset has `privacy.status` "stripped", or ". The original upload still has its
metadata" for an original from before stripping) or
"Conversion failed: <message>" (status `failed`, `sourceAssetId` is the current file and
`settingsVersion` is the current `SETTINGS_VERSION`; a failure recorded for an earlier file or
under other settings does not count, the same rule as the Function's). A failed conversion is a
validation error on the block, so a document with one cannot be published. While a document's
form is open (any field group; the block itself need not be shown), its root input
(`studio/components/VideoConversionWatcher.tsx`) checks the draft and the published document every
minute and restarts a stuck conversion (`processing` older than 20 minutes, `pending` older than
10 minutes, no status on a document unchanged for 20 minutes, or `failed` under other settings more
than 10 minutes ago) by writing to that block: `pending`, or for the old-settings failure only a
new `updatedAt`, so the Function decides with its own settings. Documents nobody opens are not
checked; a scheduled sweep would need a one-way Blueprint stack promotion (owner decision).

**Site.** The site only plays a block whose `file` is its converted MP4 (`conversion.status` is
`ready`, `file.asset._ref == conversion.outputAssetId`, `video/mp4`). A block that is still being
converted, or whose conversion failed, renders nothing: its `file` is the original upload (or the
copy without metadata), which the site never links. An upload the converter cannot strip is
removed from the block (no `file`).

### MP4 settings

Single source of truth: [`studio/functions/video-to-mp4/settings.ts`](../../studio/functions/video-to-mp4/settings.ts).
`SETTINGS_VERSION = "h264-crf23-max1920-v2"` (v1, until 2026-11-26, had no `-fps_mode`/`-enc_time_base`
options and dropped or resampled frames of variable-frame-rate video). `buildFfmpegArgs({input,
output, preset, hasAudio})` returns the ffmpeg arguments (without the executable); they need ffmpeg
7.0 or newer (`MIN_FFMPEG_VERSION`, `checkFfmpegVersion`):

```
-hide_banner -nostdin -y -autorotate -i <input>
-map 0:V:0 [-map 0:a:0 -c:a aac -b:a 128k -ac 2 | -an]
-vf scale=w='if(gte(iw,ih),max(2,2*trunc(min(iw,1920)/2)),max(2,2*trunc(min(ih,1920)*iw/ih/2)))':h='if(gte(iw,ih),max(2,2*trunc(min(iw,1920)*ih/iw/2)),max(2,2*trunc(min(ih,1920)/2)))':out_range=tv,format=yuv420p
-c:v libx264 -profile:v high -pix_fmt yuv420p -crf 23 -preset <preset>
-fps_mode:v passthrough -enc_time_base:v demux
-map_metadata -1 -map_chapters -1 -movflags +faststart -f mp4 <output>
```

- Every decoded frame is encoded once, at its own time, in the input stream's time base
  (`-fps_mode:v passthrough -enc_time_base:v demux`). A variable-frame-rate input such as a screen
  recording keeps its timing: no frame dropped, duplicated or moved. Both options are needed:
  without them ffmpeg encodes at a constant rate taken from the average (v1); with only
  `-enc_time_base:v demux`, ffmpeg 7.0.2 encodes a 90 kHz time base input at 90,000 frames per
  second. Checked frame by frame on the 29 Wagtail videos with ffmpeg 7.0.2 (the Function's binary)
  and 9.0.1.
- ffmpeg 7.0 or newer: in 6.x, `-autorotate` before `-i` takes a value and swallows the `-i`.

- H.264 High profile, yuv420p, CRF 23. Rotation metadata is applied to the pixels (`-autorotate`),
  so the output has none and its width and height are the displayed size.
- Longest side at most 1920 px, aspect kept, both sides rounded down to even numbers, never
  upscaled (a side below 2 px becomes 2 px, the smallest libx264 can encode). Both sides are
  computed explicitly because ffmpeg's `-2` and `force_original_aspect_ratio` round differently
  across versions. `expectedOutputSize({width, height})` gives the same result in TypeScript.
  Examples: 3840x2160 → 1920x1080, 1080x2400 → 864x1920, 3420x2080 → 1920x1166, 918x2066 → 852x1920,
  641x361 → 640x360, rotated 1920x1440 iPhone video → 1440x1920.
- `out_range=tv` converts full-range input (iPhone `yuvj420p`) to limited range; `-pix_fmt yuv420p`
  alone keeps full range in ffmpeg 9.
- Audio: the first audio stream as AAC 128 kb/s stereo when `hasAudio` (from ffprobe); otherwise
  no audio track. Mono is upmixed.
- Only the first real video stream (`0:V:0` skips cover art) and the first audio stream are kept:
  no data, subtitle or chapter streams. No metadata is copied from the input (iPhone videos carry
  GPS location, device and creation date); ffmpeg's own `encoder` and brand tags remain.
- `preset` defaults to `medium`. Allowed: `superfast`, `veryfast`, `faster`, `fast`, `medium`,
  `slow`, `slower`, `veryslow`, `placebo`. `ultrafast` is rejected because its output is
  Constrained Baseline, not High.
- `input` may be a path or an https URL. `output` is overwritten (`-y`) and must not start with `-`.
- Any change to these arguments must change `SETTINGS_VERSION`; a unit test pins the full list.

### Frontend query (example)

```groq
body[]{
  ...,
  _type == "video" => {
    _key,
    "status": conversion.status,
    "url": select(
      defined(file.asset._ref) && file.asset._ref == conversion.outputAssetId
        && conversion.status == "ready" && file.asset->mimeType == "video/mp4" => file.asset->url
    ),
    "filename": file.asset->originalFilename
  }
}
```

`original` is never queried for playback.

## Privacy (location and personal metadata)

Owner decision 2026-11-26: every asset the public datasets serve is stripped of location and
personal metadata, without re-encoding. Assets uploaded before 2026-11-26 (the Wagtail migration)
are stripped by the migration's privacy step (`migration/wagtail-to-sanity`); every later upload by
the Sanity Functions below. Since the privacy review (2026-11-26) both use the same strippers
(`studio/functions/privacy`) and the same policy, and mark their copies with the same `privacy`
field.

**Asset `privacy` field** (`PRIVACY_FIELD`, on `sanity.imageAsset` and `sanity.fileAsset`):

```json
{"status": "stripped", "version": "image-strip-v1", "strippedFromDigest": "hmac-sha256:<64 hex digits>",
 "removed": ["EXIF: Make, Model, GPS, MakerNote, thumbnail (IFD1)", "XMP"], "updatedAt": "..."}
```

| `status` | Meaning |
|---|---|
| `processing` | A run is checking or stripping this upload; also its lease (`holder`, `expiresAt`). |
| `pending` | A problem that is not the file's fault (download, upload, API); retried by the first event 10 minutes or more later. `message` says why. |
| `failed` | The file cannot be stripped with this `version` (corrupt, BigTIFF, old-style JPEG-in-TIFF, SVG, not a video, too large for the Function, a check that fails). Final until the version changes. The upload is never kept once nothing uses it: a video upload is taken out of every block at once and deleted; an image stays only while a document uses it (a validation error, so the document cannot be published with it); an unused one is deleted by the upload-privacy Function. |
| `clean` | Checked: nothing personal. Left as it is (a video's `original` is then the upload itself). |
| `stripped` | A copy without personal metadata (`strippedFromDigest`: the keyed digest of the upload it was made from, see "Provenance" below; `removed`: what went, names only). |
| `replaced` | An upload with personal metadata; `replacementAssetId` is its copy. References are moved and it is deleted once nothing references it. |

`version` is `IMAGE_STRIP_VERSION` (`image-strip-v1`) for images and `VIDEO_STRIP_VERSION`
(`video-strip-v2`: in place; `video-strip-v1` was the ffmpeg stream copy) for videos. A new version
re-checks images on the next change of a document that uses them. Copies made by the Functions have
`source: {name: "image-privacy", id: <the upload's digest>}` or `source: {name:
"video-to-mp4-original", id: <the upload's digest>}`; the migration's copies keep `source: {name:
"wagtail", id}` without `url` (the bucket URL would link to the unstripped original).

**Provenance without pointers** (privacy review round 2). An asset id is the asset's
content-addressed CDN path, and the asset CDN keeps serving a deleted asset for up to 30 days (see
"Asset CDN" below). So no public document names an unstripped upload: a copy records its upload
only as `hmac-sha256:<hex>`, HMAC-SHA256 of the upload's asset id with the owner's key
`PRIVACY_LINK_KEY` (`studio/functions/privacy/provenance.ts`; a Function environment variable of
image-privacy, video-to-mp4 and upload-privacy, set with `npx sanity@latest functions env add`, and
in the migration's `secrets.env`). With the key the Functions find an upload's earlier copy and the
migration finds a copy's bucket original; without it nobody can get from the digest to the id or
confirm a guessed id. Without the key a Function writes `source.id: "unlinked"` and no digest. The
migration's `validate` fails on any document that names an asset id not in the dataset, on any
`privacy.strippedFrom` (the round-1 field that held the id) and on a Function copy whose
`source.id` is not a digest. A video block whose upload was removed does not name it either
(`conversion.sourceAssetId` is unset).

**What counts as personal** (one policy for migrated assets and new uploads): anything except what
displaying the picture or playing the video needs. Personal: location of any kind, camera, phone or
computer make, model, serials and software, maker notes, lens and capture settings, capture and
creation times with their UTC offsets, authors, people and face regions, comments and other free
text, XMP, IPTC/Photoshop data, EXIF thumbnails, data after the end of a JPEG (MPF gain maps and
depth maps, motion photos), timed-metadata and other data tracks, handler names, unused bytes in a
video's `mdat` and unknown chunks or boxes. Kept: the coded image or the audio and video samples
byte for byte, the orientation, the ICC profile, colour, HDR and Dolby Vision data, the display
matrix (rotation), edit lists and the technical data a decoder needs.

**Images** (image-privacy Function, `studio/functions/image-privacy`; stripper
`studio/functions/privacy/image-strip.ts`):

- Every image field and type (`person.image`, `testimonial.image`, `service.image`, `imageWithAlt`,
  `imageBlock`) has `options: {hotspot: true, accept: "image/jpeg,image/png,image/webp,image/gif,image/avif,image/tiff",
  metadata: ["blurhash", "thumbhash", "lqip", "palette"]}`: Sanity never extracts `exif`, `image`
  (camera) or `location` into the asset document, and only formats that can be stripped losslessly
  can be uploaded. SVG, HEIC/HEIF (Sanity itself cannot process HEVC images) and BMP are refused,
  and an existing asset of another format is a validation error.
- The input shows the Function's progress under the image ("Checking...", "Removing location and
  camera data...", "Location and camera data removed...", a warning while it waits to retry, or an
  error when it failed: the file stays public with that data while a document uses it, so replace
  it).
- Trigger: create and update of the watched document types (drafts and release versions included)
  with an image whose asset was uploaded since 2026-11-26T00:00:00Z and still needs work (no
  `privacy`, another version, `replaced`, a stale `processing`, a due `pending`). The filter follows
  `asset->`.
- An image with nothing personal is left alone (marked `clean`).
- The copy keeps the coded image byte for byte (identical decoded pixels), the orientation and the
  ICC profile, and has the upload's dimensions, so crops and hotspots stay right. Every reference
  in drafts, published documents and release versions moves to it (`asset._ref` only: crop,
  hotspot, alt, caption, layout unchanged; a testimonial's `asciiArtSource` moves with its image),
  then the upload is deleted. A version in a release that can no longer be edited (scheduled,
  published, archived) is not written; the upload stays `replaced` until the release is published
  (the published document's event moves it) or archived (the upload-privacy sweep deletes it).
- The plain image CDN URL usually serves a re-encoded rendition without any metadata, but not
  always: for 22 of the 110 images per dataset (all 8 GIFs, 5 JPEGs and 9 PNGs) it returns the
  stored bytes exactly, and anonymous `?dl=` does the same for 18 (privacy review round 2,
  measured 2026-11-26). So the stored file itself must be clean, which is why a failed image is a
  validation error and is deleted once unused. `?dlRaw=` returns the stored file and requires a
  token (anonymous requests get 401); the Function reads the stored file that way, and that
  response is `private, no-store`.

**Videos** (video-to-mp4 Function; strippers `studio/functions/privacy/isobmff-video.ts` and
`video-strip.ts`): `original` is the upload with its metadata removed in place for QuickTime/MP4:
`moov/udta`, `moov/meta` and track metadata (QuickTime keys and user data: location, make, model,
software, creation dates), data tracks (`mebx` timed metadata, timecode, text) and their samples,
creation times, handler names and every `mdat` byte no audio or video sample uses (iOS leaves a
draft movie header with the location there) become zeros or `free` boxes of the same size. No
offset moves, so the container, edit lists, time stamps, the display matrix, colour, HDR and Dolby
Vision boxes and every sample stay byte for byte; ffmpeg checks that every packet and every stream
description is unchanged. Other containers (Matroska/WebM) and ISO BMFF files the in-place stripper
refuses (fragmented files, unknown boxes) get an ffmpeg stream copy instead, which rewrites the
container and says so in `privacy.message`. An upload with nothing personal is kept as it is
(`clean`). Once the copy exists the block leaves the upload whatever the conversion does: `ready`
points `file` at the MP4 and `original` at the copy, `failed` and `pending` point `file` at the copy
(a retry converts it). The unstripped upload is then deleted once nothing references it. Release
versions are converted like drafts while their release is active. The converted MP4 is checked to
carry no metadata boxes besides ffmpeg's encoder name.

An upload the strippers cannot handle (larger than about 480 MB, which does not fit in the
Function's `/tmp`; a file the in-place stripper and the stream copy both refuse; a check that
fails; a timeout) is marked `failed` and taken out of every block that uses it: `file` and
`original` are removed and `conversion` is `{status: "failed", message}` without `sourceAssetId`,
where the message says why and asks for another file. The Studio shows "Upload removed: ..." on
the block and an error on its file field. The upload is then deleted (a version in a locked
release keeps it until the release is published or archived; the upload-privacy sweep deletes it
then). A later run for another block with the same upload uses the recorded failure without
stripping again.

**Residual limit: location inside the video stream.** The streams are kept bit for bit (owner
decision), so location that a camera writes into the coded video or audio samples themselves (for
example H.264/HEVC SEI user data from some dash cams and drones) stays in `original`, which, like
every file in a public dataset, can be downloaded by anyone who finds it. The checks only look for
location outside the kept samples. The 29 Wagtail originals have no location fingerprint anywhere
in their bytes. The converted MP4 is re-encoded and does not carry it. The Studio's help text on
`original` says so.

**Uploads no document uses** (upload-privacy Function, `studio/functions/upload-privacy`): on the
creation of an image or file asset (not one the migration or a Function made) it removes any
location or EXIF data Sanity extracted into the asset document at once, waits a minute for a
document to use the upload (then the Functions above handle it), and otherwise strips it the same
way (a copy, then the upload is deleted; an image uploaded as a file asset gets a file copy; an
upload the strippers fail on is deleted). On every upload and every deleted document (a publish, a
discarded draft, an archived release) it also sweeps up to five earlier unused uploads that still
have their metadata (never checked, `replaced` but not deleted, `failed`, a due retry). There is no
scheduled sweep (it would need the Blueprint stack promoted to the organization and a robot token:
the owner's call).

**Asset CDN** (privacy review round 2). Deleting an asset does not remove it from the asset CDN
(`cdn.sanity.io`, Google Cloud CDN): files and renditions are cached with `cache-control: public,
max-age=31536000, s-maxage=2592000`, so an edge that served a file keeps serving it for up to 30
days after the deletion (Sanity: "the CDN might have your asset cached, so it may not disappear
immediately"; there is no purge API, only Sanity support). Measured on staging with fresh assets:
after an anonymous GET of the plain URL and the deletion, the plain URL still answered 200; after a
GET with a unique query parameter or with a token, it answered 404. So:

- the Functions read every upload with a unique `privacyFetch` query parameter and their token
  (`studio/functions/privacy/private-fetch.ts`), so the unstripped bytes never enter the public
  cache under the guessable URL;
- no public document names a deleted upload (see "Provenance without pointers");
- the uploads the privacy work deleted on 2026-11-26 may still be cached where something fetched
  them before (the verification scans, the Functions' round-1 code). The owner's purge request to
  Sanity support lists every path (kept outside the repository, because it names where the
  unstripped bytes were), and `migration/verify/src/deleted-asset-cdn-probe.mjs` re-probes them;
  run it until 2026-12-26 (30 days after the last deletion).
- an editor's own browser fetches an upload's plain URL only if the editor opens it (the Studio's
  file input shows the name, not the file).

**Files**: `fileLink` annotations accept PDF documents only (`options.accept: ".pdf,application/pdf"`
and a validation error for any other file): a photo or video attached as a file would be served
exactly as uploaded. `stlModel` accepts `.stl` only. No Function strips PDF or STL files yet (open
point of the privacy review, round 2 finding 7): a new PDF keeps its document information (author,
creating application, dates) and XMP, and an STL its 80-byte header. The migration's privacy step
checks STL headers and PDF metadata for people's names; the two résumé PDFs keep the printing
browser, the PDF producer and their dates, and the three STL headers name the CAD exporter and its
version.

## Validation

`npm run validate` (production) and `npm run validate:staging` in `studio/` run
`sanity documents validate --level error` and exit non-zero on any error. Since Studio 6.24,
required fields and slug uniqueness are errors outside the Studio too. Drafts are validated as well.
To check transformed NDJSON before importing, use
`npx sanity documents validate --workspace staging --file <file.ndjson> --level error --yes`;
asset references must already exist in the dataset, other references can be in the same file.

Errors:

- Missing required fields listed in the tables above.
- Slug format (`^[a-z0-9]+(?:-[a-z0-9]+)*$`) and slug uniqueness per type.
- `intro` over 250 characters.
- `audience`, `projectType`, `imageBlock.layout` or `code.language` outside their lists.
- URLs with disallowed schemes (`person.github`, `testimonial.link`, `project.website`, `service.link`, `link.href`).
- `youtube.url` that is not a YouTube video URL.
- `stlModel` without an `.stl` file, or `scale` not an integer in 1..1000.
- `video` without a `file`, or whose `file` asset is missing or not a `video/*` MIME type;
  `conversion.status` outside its list; a `video` whose MP4 conversion failed for its current file;
  `imageBlock` without an image; `fileLink` without a file; `code` with blank code.
- An image (any image field or type) whose asset's format cannot be stripped losslessly (not
  JPEG, PNG, WebP, GIF, AVIF or TIFF, for example an SVG or HEIC picked from the media browser).
- Redirect `source`/`destination` format, duplicate `source`, `destination` equal to `source`.
- Duplicate `medium` or `technology` title ignoring case.
- Strong references to documents that don't exist or aren't published (Sanity's own check).

Warnings (reported, never fail `npm run validate`): missing image alt text, testimonial without a
photo, service link without link text, SEO title over 70 or description over 160 characters,
Sanity's own "File type ... is not accepted" for a non-video `file`, and an image whose location
and camera data the image-privacy Function could not remove (yet): `privacy.status` `failed`,
`pending` or `replaced`.

All 29 migrated video blocks are contract v2 and `ready` (`h264-crf23-max1920-v2`), and no
`mux.*` document is left: `npm run validate` and `npm run validate:staging` report 0 errors (on
2026-11-26; the only warnings are 2 SEO descriptions over 160 characters).

## Presentation tool routes

| Document | Main document route | Locations shown |
|---|---|---|
| `homePage` | `/` (`_id == "homePage"`) | Home `/` |
| `blogPost` | `/blog/:slug` | the post, Blog `/blog` |
| `project` | `/projects/:slug` | the project, Projects `/projects` |
| `flexPage` | `/flex/:slug` | the page |

`previewUrl.initial` is `https://cjoshmartin.com` (override with `SANITY_STUDIO_PREVIEW_URL` for
`sanity dev`), `previewMode.enable` is `/api/draft-mode/enable` on whichever allowed origin is
previewed. Allowed origins: `http://localhost:*`, the scoped Vercel pattern above,
`https://cjoshmartin.com`, `https://www.cjoshmartin.com`.

## CORS origins (project `j3vdh6ti`)

| Origin | Credentials |
|---|---|
| `http://localhost:3333` | yes |
| `http://localhost:3000` | yes |
| `https://cjoshmartin.com` | yes |
| `https://www.cjoshmartin.com` | yes |
| `https://cjoshmartin-frontend-*-josh-martins-projects-0186b4e9.vercel.app` | yes |

The hosted Studio needs no CORS entry.

## TypeGen

`studio/sanity.cli.ts`:

```ts
typegen: {
  path: [
    '../app/**/*.{ts,tsx,js,jsx}',
    '../components/**/*.{ts,tsx,js,jsx}',
    '../lib/**/*.{ts,tsx,js,jsx}',
    '../sanity/**/*.{ts,tsx,js,jsx}',
  ],
  schema: './schema.json',
  generates: '../sanity.types.ts',
  overloadClientMethods: true,
}
```

`npm run typegen` = `sanity schemas extract --workspace production --path schema.json --force`
then `sanity typegen generate`. It is not run by `sanity build`, so building the Studio never writes
outside `studio/`. Query variable names must be unique across those folders.
