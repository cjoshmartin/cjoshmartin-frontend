# WP1 report: Sanity Studio and schema

Status: **done**. Studio built, schema deployed to both datasets, hosted Studio live, CORS set.
Commit: `ff7e0cd Add standalone Sanity Studio and content schema` (plus this report).

## What was built

- **Standalone Studio in `studio/`** with its own `package.json` (sanity 6.25.0, @sanity/vision
  6.25.0, @sanity/code-input 7.3.16, sanity-plugin-mux-input 5.4.0, @sanity/icons 5.4.0, React
  19.3.1, styled-components 6.7.0, TypeScript 6.0). All were the latest versions on npm at the time;
  the plugins declare `sanity ^5 || ^6` and `react ^19.2`. Files were hand-written in `studio/`
  (the interrupted attempt had left only a scaffolded `package.json`, lockfile and `node_modules`,
  which were reused and updated). No root file was touched.
- **Schema** (`studio/schemaTypes/`): every type in the contract, with `defineType`,
  `defineField` and `defineArrayMember`, icons, previews, orderings and field groups (Content,
  Media, Details, SEO, Migration). The full contract, including the Mux document shape, is in
  [`../schema-contract.md`](../schema-contract.md).
- **Home singleton:** registered with the Studio 6.24 `document.singletons` API (fixed id
  `homePage`). No create template, no duplicate, delete or unpublish action.
- **Structure:** Home, Blog posts, Projects, Flex pages, People, Testimonials, Services, Tags
  (Mediums, Technologies), Redirects. Posts and projects sort by date, newest first.
- **Plugins:** Structure, Presentation, Vision, code input (with an added C++ mode), Mux input
  (`video_quality: 'basic'`, video files only).
- **Presentation:** `previewUrl.initial` `https://cjoshmartin.com` (override with
  `SANITY_STUDIO_PREVIEW_URL` for local dev), `previewMode.enable` `/api/draft-mode/enable`, main
  documents and locations for `/`, `/blog/:slug`, `/projects/:slug`, `/flex/:slug`.
- **Workspaces:** `production` (`/production`, dataset `production`) and `staging`
  (`/staging`, dataset `staging`), one shared config function.
- **`sanity.cli.ts`:** project `j3vdh6ti`, dataset `production`, `studioHost: 'cjoshmartin'`,
  `deployment.appId` and `autoUpdates: true`, schema extraction on build, TypeGen scanning
  `../app`, `../components`, `../lib`, `../sanity` and writing `../sanity.types.ts`.
- **Scripts:** `dev`, `build`, `preview`, `deploy`, `schema:extract`, `schema:validate`,
  `schema:deploy`, `typegen` (extract + generate), `validate`, `validate:staging`, `typecheck`, `lint`.
- **Hosted Studio:** <https://cjoshmartin.sanity.studio> (the hostname was free).
- **CORS:** localhost:3000 and 3333, cjoshmartin.com, www.cjoshmartin.com and the project's
  Vercel deployments, all with credentials.

## Deviations (also listed in the schema contract)

1. `https://*.vercel.app` was **not** used. Sanity's CORS guide says never to add a platform-wide
   wildcard with credentials, and any Presentation `allowOrigins` entry can read drafts through the
   preview iframe. Draft-mode live updates on a Vercel preview need a credentialed origin, so the
   Studio and CORS both use `https://cjoshmartin-frontend-*-josh-martins-projects-0186b4e9.vercel.app`
   (project name plus Vercel team slug, read from this repo's GitHub deployment statuses). It
   matches every deployment and branch URL of the project and nothing else (checked below).
2. `studioHost` is deprecated in CLI 8.35; it is kept as asked and `deployment.appId`
   (`uihrx4okiju6hmbteqql9b8u`) was added after the first deploy, as the CLI recommends.
3. The hosted Studio root answers `302` to the Sanity Dashboard
   (`https://www.sanity.io/@opn7xage4/studio/uihrx4okiju6hmbteqql9b8u`), which signs the user in and
   shows the Studio. That is how Sanity hosting works now; the Studio files themselves are served
   from the hostname.
4. Additions that keep the data shape: hotspot on `service.image`; `unpublish` also removed from
   the home page; `mux.videoAsset` removed from "create" menus; `legacy` hidden while empty; extra
   validation (slug format, `intro` required, tag titles unique ignoring case, redirect sources
   unique, code language list).
5. Names the brief left open: `internalLink.reference`, `fileLink.file`.

## Verification

All commands ran in `studio/` unless noted.

| Check | Result |
|---|---|
| `npx tsc --noEmit`, `npx eslint .`, `prettier --check` | Pass |
| `npm run build` (`sanity build`) | Pass; schema extracted to `schema.json` |
| `npm run schema:extract` | Pass |
| `sanity schemas validate --workspace production` and `--workspace staging` | 0 errors, 0 warnings each |
| `sanity schemas deploy` | `_.schemas.production` and `_.schemas.staging` deployed (`sanity schemas list` shows both) |
| `sanity deploy --yes` | Studio created and deployed at `https://cjoshmartin.sanity.studio`; redeployed after the final config change |
| Deployed Studio served | `curl`: root `302` to the Dashboard URL above; the deployed `static/sanity-*.js` bundle is byte-identical (sha256) to the local build and `static/create-manifest.json` is identical to the local one (production + staging workspaces) |
| CORS | `sanity cors add ... --credentials` for each origin; then an `OPTIONS` preflight with `Authorization` to the query API: localhost:3000/3333, cjoshmartin.com, www, and two real deployment URLs of this project get `access-control-allow-origin` + `allow-credentials: true`; `https://evil.vercel.app` and `https://other-x-josh-martins-projects-0186b4e9.vercel.app` get no CORS headers |
| Validation rules | `sanity documents validate --file` (nothing written to any dataset) on synthetic documents that follow the contract: no markers except "referenced document must be published" for the stand-in asset ids (file mode only accepts assets that exist in the dataset). A second file with deliberately broken documents raised exactly the intended markers: slug format, intro over 250, required slug/date, audience and project type outside the list, non-YouTube URL, code language not allowed, blank code, image block without image or layout, video without asset, STL that is a PDF, scale 0 and 2.5, file link without file, `javascript:` link, `ftp:` website, redirect without leading `/` and equal to its source; missing alt text came out as a warning only. A `mux.videoAsset` with raw Mux arrays (no `_key`) validated clean. |
| Uniqueness queries | The GROQ used by the tag-title and redirect-source rules runs on the API (`result: false` on the empty dataset) |
| Document actions and create menu | `sanity exec` script calling the config's resolvers for both workspaces: home page keeps only publish, discard changes and restore; blog post actions unchanged; `mux.videoAsset` dropped from new-document options |
| Studio in a browser | Local `sanity preview` of the build, opened in headless Chromium with the Viewer token: 18 of 19 checks pass. Structure items in both workspaces, Tags sub-list, Home opens `/structure/homePage` with the Singleton badge and "Used on one page", create menu lists the content types but not Home or Video asset, new blog post / project / testimonial / service / redirect forms render their fields and groups, Presentation, Vision and Videos tools load. The one failure is "Minified React error #441" thrown by the **current live site** inside the Presentation iframe; loading `https://www.cjoshmartin.com/?sanity-preview-perspective=drafts` directly reproduces it, so it is the old frontend's query-param crash (plan §7.3 bug 3), not the Studio. Screenshots: `~/cjoshmartin-migration/reports/wp1-screenshots/`. |
| TypeGen | Same `typegen` settings in a scratch folder with output redirected there (so no root file was written): 62 schema types, 3 sample queries typed, including `asset.asset->playbackId` for Mux videos and `audience`/`projectType` literal unions |
| `npm run validate`, `npm run validate:staging` | Pass (0 content documents yet) |
| Secrets | Committed files scanned for the four token values in `secrets.env`: no matches |
| `git status` | Only `studio/` and `docs/sanity-migration/` files from this package; nothing outside |

## Things other packages must handle

- **Root `tsconfig.json` and ESLint (WP4/orchestrator):** the root `include: ["**/*.ts"]` already
  type-checks `studio/` (today it reports errors in `studio/functions/**` scripts under the root's
  ES5 target). Exclude `studio`, `migration` and `scripts` from the root `tsconfig.json` and the
  root ESLint config before `next build` (plan §7.4).
- **Mux token:** the Studio's Mux input needs the token saved once per dataset (Videos tool setup
  screen, stored as `secrets.mux`). Not done by this package; plan §16 has Josh enter it. Needed for
  manual test 30 on staging.
- **Public repo and preview origins:** the credentialed Vercel origin also matches a preview built
  from a fork's pull request. Keep Vercel's fork protection on (previews from forks need approval).

## Files

- `studio/` (except `functions/` and `sanity.blueprint.ts`, owned by WP2)
- `docs/sanity-migration/schema-contract.md`
- `docs/sanity-migration/reports/wp1-studio.md`
