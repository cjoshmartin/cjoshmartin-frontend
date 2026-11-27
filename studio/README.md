# cjoshmartin.com Studio

Standalone Sanity Studio for cjoshmartin.com. Project `j3vdh6ti`, hosted at
<https://cjoshmartin.sanity.studio> (opens through the Sanity Dashboard; auto-updates on).

It has its own `package.json` and is not part of the Next.js build. The content model is
documented in [`docs/sanity-migration/schema-contract.md`](../docs/sanity-migration/schema-contract.md).

## Workspaces

| Workspace | URL path | Dataset |
|---|---|---|
| Production (live site) | `/production` | `production` |
| Staging (test copy) | `/staging` | `staging` |

Both share the same schema, structure and plugins. Switch with the menu next to the Studio title.

## Scripts

Run from this folder after `npm install`.

| Script | What it does |
|---|---|
| `npm run dev` | Local Studio at <http://localhost:3333>. Set `SANITY_STUDIO_PREVIEW_URL=http://localhost:3000` to point the Presentation tool at a local Next.js app (default: <https://cjoshmartin.com>). |
| `npm run build` | Builds to `dist/` and refreshes `schema.json`. |
| `npm run deploy` | Builds and deploys the hosted Studio and both workspace schemas. |
| `npm run schema:extract` | Writes `schema.json` (the input for TypeGen). |
| `npm run schema:validate` | Validates the schema definitions of both workspaces. |
| `npm run schema:deploy` | Deploys the schema of both workspaces to the Content Lake. |
| `npm run typegen` | Extracts the schema, then scans `../app`, `../components`, `../lib` and `../sanity` for `defineQuery` queries and writes `../sanity.types.ts`. |
| `npm run validate` / `npm run validate:staging` | Validates every document in `production` / `staging` and fails on errors (warnings such as missing alt text are not failures). |
| `npm run typecheck`, `npm run lint` | TypeScript and ESLint for the Studio code. `functions/testimonial-ascii-art/` is its own package with its own checks; `functions/video-to-mp4/settings.ts` is type-checked here through the tests that import it. |
| `npm test` | Unit tests in `test/`: the MP4 settings (`functions/video-to-mp4/settings.ts`) and the video block's conversion status helpers. No network, no ffmpeg. |
| `npm run test:ffmpeg` | Runs the MP4 settings through a real ffmpeg on small generated videos and checks the output with ffprobe. Needs `ffmpeg` (with libx264) and `ffprobe` on `PATH`, or `FFMPEG_PATH` / `FFPROBE_PATH`; fails if they are missing. |

## Layout

- `sanity.config.ts`: the two workspaces, plugins (Structure, Presentation, Vision, code input),
  the home page singleton and document actions.
- `sanity.cli.ts`: project, hosted Studio, schema extraction and TypeGen settings.
- `schemaTypes/`: `documents/`, `objects/` and `shared/` field helpers. `schemaTypes/index.ts`
  exports `schemaTypes` and the option constants.
- `structure/`: the desk structure. `presentation/`: routes for the Presentation tool.
- `functions/` and `sanity.blueprint.ts`: the testimonial ASCII art Sanity Function.
  `functions/video-to-mp4/settings.ts` holds the MP4 conversion settings (`SETTINGS_VERSION`,
  `buildFfmpegArgs`) that every video converter uses.
- `test/`: tests for the MP4 settings and the video block helpers (`npm test`, `npm run test:ffmpeg`).

## Notes

- Videos are Sanity file assets. A video block's **Video file** accepts any `video/*` upload. The
  video-to-mp4 Sanity Function (in `functions/video-to-mp4/`) converts the upload to MP4 (H.264,
  longest side at most 1920 px) with the settings in `functions/video-to-mp4/settings.ts`; then
  **Video file** holds the MP4 and the upload is kept, read-only, under **Original upload**. The
  block's preview shows the conversion status ("Converting to MP4...", "Ready" or
  "Conversion failed: ...").
- The Presentation tool accepts the live site, `http://localhost:*` and this project's Vercel
  preview deployments (`https://cjoshmartin-frontend-*-josh-martins-projects-0186b4e9.vercel.app`).
  The same origins (localhost:3000 and 3333 included) are CORS origins with credentials.
