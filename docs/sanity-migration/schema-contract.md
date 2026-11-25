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
   - `mux.videoAsset` is removed from "create new document" menus; video documents are created by
     the Mux input and the Videos tool.
   - `legacy` is hidden while empty, so it only shows (read-only, Migration group) on migrated documents.
   - Extra validation, listed under [Validation](#validation): slug format, tag titles unique
     ignoring case, redirect sources unique, code languages limited to the list, `intro` required.
5. **Names the brief left open:** the `internalLink` annotation's reference field is named
   `reference`; the `fileLink` annotation's field is `file` (type `file`).

## Importing from the Studio package

| Path | Exports | Dependencies |
|---|---|---|
| `studio/schemaTypes/constants.ts` | `AUDIENCE_OPTIONS`, `DEFAULT_AUDIENCE`, `PROJECT_TYPE_OPTIONS`, `DEFAULT_PROJECT_TYPE`, `IMAGE_LAYOUT_OPTIONS`, `DEFAULT_IMAGE_LAYOUT`, `CODE_LANGUAGES`, `DEFAULT_CODE_LANGUAGE`, `INTERNAL_LINK_TYPES`, `HOME_PAGE_ID`, and the types `Audience`, `ProjectType`, `ImageLayout`, `CodeLanguage` | none (plain TypeScript, safe to import from any package with a TS runtime) |
| `studio/schemaTypes/shared/validation.ts` | `SLUG_PATTERN`, `validateSlugFormat`, `getYouTubeVideoId`, `validateYouTubeUrl`, `validateSitePath`, `validatePathOrAbsoluteUrl`, `fileAssetExtension` | none |
| `studio/schemaTypes/index.ts` | `schemaTypes: SchemaTypeDefinition[]` (every type below except `code` and `mux.*`, which their plugins add), each type definition by name (`blogPost`, `project`, ...), and everything from `constants.ts` | `sanity`, `@sanity/icons` (resolved from `studio/node_modules`, so run `npm ci` in `studio/` first) |

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
| `mux.videoAsset` | `mux-video-<wagtailMediaId>` |
| Mux plugin settings | `secrets.mux` (type `mux.apiKey`, written by the plugin's setup screen) |

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
| `image` | image (hotspot) with `alt` string | | `{_type: "image", asset, hotspot?, crop?, alt?}`. Missing alt is a warning. |
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
| `image` | image (hotspot) with `alt` string | | Warning when missing (the ASCII art comes from it). |
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
| `image` | image (hotspot) with `alt` string | | |
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
Used by `heroMedia[]`, `contentImage`, `previewImage`. Missing alt is a warning.

### `imageBlock` (rich text)

Image type named `imageBlock`, hotspot on, fields `alt` string, `caption` string, `layout`
(`fullwidth` | `left` | `right`, required). Errors without an image asset. Missing alt is a warning.

### `youtube`

`{_type: "youtube", url: string}`. `url` is required and must be a YouTube video URL:
`youtube.com/watch?v=<id>`, `youtu.be/<id>`, `youtube.com/{embed,live,shorts,v}/<id>` (also
`m.`, `music.`, `youtube-nocookie.com`). Store real `&`, not `&amp;`.

### `stlModel`

`{_type: "stlModel", file: {_type: "file", asset: {_type: "reference", _ref: "file-<sha1>-stl"}}, scale: number}`.
`file` is required and must be an `.stl` asset (checked from the asset id suffix, so upload with a
filename ending in `.stl`). `scale` is a required integer from 1 to 1000 (Wagtail values: 20, 30).

### `video`

`{_type: "video", asset: {_type: "mux.video", asset: {_type: "reference", _weak: true, _ref: "mux-video-<wagtailMediaId>"}}}`.
`asset` is the plugin's `mux.video` object and is required (it must reference a video).

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
| `fileLink` | `file` (file: `{_type: "file", asset: {_type: "reference", _ref: "file-..."}}`) | Must have an asset. |

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

## Mux video documents (`mux.videoAsset`)

Read from the installed `sanity-plugin-mux-input@5.4.0` (`dist/index.js` schema and the code that
creates documents after an upload or an import from Mux).

`mux.video` (object, used by `video.asset`):

```json
{"_type": "mux.video", "asset": {"_type": "reference", "_weak": true, "_ref": "mux-video-6"}}
```

`mux.videoAsset` (document). Fields in the plugin schema, all optional:

| Field | Type | What the plugin puts there |
|---|---|---|
| `status` | string | Mux asset status (`ready`, `preparing`, `errored`). |
| `assetId` | string | Mux asset id. |
| `playbackId` | string | The first playback id (`data.playback_ids[0].id`). Public policy for this site. |
| `filename` | string | Original file name, shown in the Studio. |
| `thumbTime` | number | Thumbnail time in seconds, set when an editor picks a thumbnail. |
| `data` | `mux.assetData` | The full Mux asset object as returned by the Mux API (`GET /video/v1/assets/{id}`): `id`, `status`, `created_at`, `duration`, `aspect_ratio`, `max_stored_resolution`, `max_stored_frame_rate`, `max_resolution_tier`, `resolution_tier`, `video_quality`, `encoding_tier`, `mp4_support`, `master_access`, `passthrough`, `upload_id`, `playback_ids[] {id, policy}`, `tracks[] {id, type, max_width, max_height, max_frame_rate, duration, ...}`, `static_renditions`, `master`. Arrays are stored as Mux returns them (no `_key`); validation accepts that. |
| `robotsJobs`, `robotsOutputs`, `robotsDirectiveRuns`, `robotsPendingCreates` | Mux Robots data | Written only by the plugin's Robots features. Leave unset. |

The plugin also writes `uploadId` (not in its schema) on documents it creates from Studio uploads,
and finds existing documents with `coalesce(assetId, data.id)` and `coalesce(uploadId, data.upload_id)`.

Shape for migrated videos (`passthrough` lets reruns find the asset in Mux):

```json
{
  "_id": "mux-video-6",
  "_type": "mux.videoAsset",
  "assetId": "<mux asset id>",
  "playbackId": "<public playback id>",
  "status": "ready",
  "filename": "<original Wagtail file name>",
  "data": { "...": "full Mux asset JSON, including passthrough: \"wagtail-media-6\" and video_quality: \"basic\"" }
}
```

Frontend query for a video block: `body[]{..., _type == "video" => {"playbackId": asset.asset->playbackId, "status": asset.asset->status, "aspectRatio": asset.asset->data.aspect_ratio}}`.

The Studio plugin is configured with `video_quality: 'basic'` and `acceptedMimeTypes: ['video/*']`
(public playback is the plugin default). Uploads from the Studio need the Mux token saved once per
dataset through the plugin's setup screen (`secrets.mux`); that document is not part of this schema
and the migration must not overwrite it.

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
- `video` without a video reference; `imageBlock` without an image; `fileLink` without a file;
  `code` with blank code.
- Redirect `source`/`destination` format, duplicate `source`, `destination` equal to `source`.
- Duplicate `medium` or `technology` title ignoring case.
- Strong references to documents that don't exist or aren't published (Sanity's own check).

Warnings (reported, never fail `npm run validate`): missing image alt text, testimonial without a
photo, service link without link text, SEO title over 70 or description over 160 characters.

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
