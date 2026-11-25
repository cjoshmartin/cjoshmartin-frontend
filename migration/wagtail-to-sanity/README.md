# Wagtail → Sanity migration

One-time ETL that moves every cjoshmartin.com page, snippet, image, document and video from the
Wagtail export into the Sanity project `j3vdh6ti`. It is plan §9 of
[`docs/sanity-migration-plan.md`](../../docs/sanity-migration-plan.md). The target content model is
[`docs/sanity-migration/schema-contract.md`](../../docs/sanity-migration/schema-contract.md), and the
latest run is described in [`docs/sanity-migration/reports/wp3-migration.md`](../../docs/sanity-migration/reports/wp3-migration.md).

## Run it

```sh
npm ci                                              # this package (Node 24+)
(cd ../../studio && npm ci)                         # Studio schema + Sanity CLI
(cd ../../studio/functions/testimonial-ascii-art && npm ci)   # ASCII-art generator
npm run migrate -- --dataset staging
```

`--dataset production` also needs `--confirm-production`. Other options: `--steps a,b`,
`--no-gcs-sync`, `--data-dir <path>`, and `--allow-pending-videos`. That last one is for staging
only: when Mux refuses new assets because of the free plan's 10-asset limit, the run continues
and the missing videos are recorded, but validation still fails until every video is on Mux.

Secrets come from the environment or from `~/cjoshmartin-migration/secrets.env`
(`SANITY_WRITE_TOKEN`, `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`). They are never logged. The Sanity CLI
steps (schema validation and `datasets import`) use the machine's `sanity login`.

Data lives outside the repo in `~/cjoshmartin-migration/`: `wagtail-export.zip`, `extracted/`,
`gcs/` (bucket mirror), `state/` (asset, Mux and ASCII-art maps), `transformed/<dataset>/data.ndjson`
and `reports/`.

## Steps

| Step | What it does |
|---|---|
| `extract` | Unzips the export and checks it against the manifest (bytes and sha256). Mirrors `original_images/`, `documents/`, `media/` and `media_thumbnails/` with `gsutil -m rsync -r -d`. Hashes every file and reconciles files against the image, document and media records. Every discrepancy must be listed with its evidence in [`src/discrepancies.ts`](src/discrepancies.ts), otherwise the step fails. It also fails when migrated content references a record whose file is missing. |
| `assets` | Uploads every image, document and media thumbnail with `title`, `originalFilename` and `source {name: "wagtail", id, url}`. Assets are content-addressed, so files that are already in the dataset are only patched to the same metadata. |
| `mux` | Lists Mux assets and reuses the one whose passthrough is `wagtail-media-<id>`, otherwise creates it from the public bucket URL (basic quality, public playback). Waits for `ready` and writes `state/mux-map.json`. |
| `ascii` | Renders testimonial ASCII art with the WP2 generator from the target dataset's image CDN. All 9 testimonials must match the live site byte for byte. |
| `transform` | Converts Wagtail rich text to Portable Text with `@portabletext/block-tools`, JSDOM and the compiled Studio schema, against a strict allowlist. StreamField bodies become one Portable Text array. Writes `data.ndjson` sorted by `_id`, plus `reports/wp3/transform-<dataset>.json` (issues, tag merges, link-text flattening, mapping). |
| `import` | Runs `sanity documents validate --file` (Studio schema), then `sanity datasets import --replace`, then deletes documents with migration ids that the transform no longer produces. |
| `validate` | Checks counts, assets, hashes, references, `_key`s, Portable Text integrity, text and field parity against the export, Mux status, ASCII art, convergence (dataset == NDJSON) and `sanity documents validate`. Writes `reports/validation-<dataset>.{json,md}` and exits non-zero on any failure. |

Every step is deterministic. Document ids follow the contract (`blogPost-<pageId>`,
`drafts.blogPost-<pageId>`, ...), Portable Text keys come from Wagtail ids, and Mux data arrays get
their Mux ids as `_key`. Rerunning the whole pipeline converges to the same dataset.

## Tests

`npm test` covers the rich-text conversion (allowlist, keys, embeds, links) and the document
helpers. `npm run typecheck` type-checks the package, including the Studio and generator modules
it imports.
