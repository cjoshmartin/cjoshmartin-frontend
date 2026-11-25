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
| `npm run typecheck`, `npm run lint` | TypeScript and ESLint for the Studio code. `functions/` is its own package with its own checks. |

## Layout

- `sanity.config.ts`: the two workspaces, plugins (Structure, Presentation, Vision, code input,
  Mux), the home page singleton and document actions.
- `sanity.cli.ts`: project, hosted Studio, schema extraction and TypeGen settings.
- `schemaTypes/`: `documents/`, `objects/` and `shared/` field helpers. `schemaTypes/index.ts`
  exports `schemaTypes` and the option constants.
- `structure/`: the desk structure. `presentation/`: routes for the Presentation tool.
- `functions/` and `sanity.blueprint.ts`: the testimonial ASCII art Sanity Function.

## Notes

- Mux uploads need the Mux access token entered once per dataset: open **Videos** in the Studio
  (or any video field) and follow the setup prompt. The plugin stores it in the dataset's
  `secrets.mux` document.
- The Presentation tool accepts the live site, `http://localhost:*` and this project's Vercel
  preview deployments (`https://cjoshmartin-frontend-*-josh-martins-projects-0186b4e9.vercel.app`).
  The same origins (localhost:3000 and 3333 included) are CORS origins with credentials.
