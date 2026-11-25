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
`--no-gcs-sync`, `--data-dir <path>`, `--discard-studio-edits` (see below) and
`--allow-pending-videos`. With that last one, when Mux
refuses new assets because of the free plan's 10-asset limit, the run continues and the missing
videos are recorded as pending in `state/mux-map.json`. Everything else is imported, and the video
blocks keep their weak references to `mux-video-<id>`, so they resolve as soon as a later run
creates those documents. Validation still fails until every video is on Mux. The transform
refuses a Mux map with pending videos unless the flag is given on that run too, so
`--steps transform,import` can't import without the videos by accident.

Compare two datasets (document ids, counts, every document, Portable Text hashes and the two
transform outputs) with `npm run compare -- --datasets staging,production`. It writes
`reports/wp3/compare-staging-production.{json,md}` and exits non-zero on any difference. Assets
may differ only in `uploadId` and in the dataset name inside `path` and `url`.

Secrets come from the environment or from `~/cjoshmartin-migration/secrets.env`
(`SANITY_WRITE_TOKEN`, `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`). They are never logged. The Sanity CLI
steps (schema validation and `datasets import`) use the machine's `sanity login`.

Data lives outside the repo in `~/cjoshmartin-migration/`: `wagtail-export.zip`, `extracted/`,
`gcs/` (bucket mirror), `state/` (asset, Mux and ASCII-art maps), `transformed/<dataset>/data.ndjson`
and `reports/`.

### Reruns after the Studio is in use

Every import first compares the dataset with `state/imported-<dataset>.json`, the record of the
`_rev` and content hash of each migration document the last import left behind. If anything
changed since (an edited document, a draft opened in the Studio, a migrated draft that was
published or discarded, a release version), the import stops before writing and lists the ids. It
would otherwise overwrite those edits, and its pruning would delete the published copy of a draft.
`--discard-studio-edits` overrides that on purpose. A dataset imported before the record existed
is recorded once with `--steps baseline`, which only succeeds when every migration document still
equals `transformed/<dataset>/data.ndjson`, so run it before the transform changes that file.

To add videos later (Mux's free plan refused media 11–29), don't rerun the import. Upgrade the Mux
environment, then run the `mux` step and the narrow `videos` step, which only creates the missing
`mux-video-<id>` documents with `createIfNotExists`, adds them to the record, and checks that every
video block resolves:

```sh
npm run migrate -- --dataset staging --steps mux,videos
npm run migrate -- --dataset production --confirm-production --steps mux,videos
```

The `videos` step fails while any video is still pending, unless `--allow-pending-videos` is given.
To run the full validation afterwards, use `--steps transform,validate`: the transform then writes
all 29 video documents to the NDJSON (nothing is imported), and validation compares the dataset
with it. Until the Studio is used, all 12 checks must pass. After editors have changed content,
the parity and convergence checks list their edits as differences, which is expected.

## Steps

| Step | What it does |
|---|---|
| `extract` | Unzips the export and checks it against the manifest (bytes and sha256). Mirrors `original_images/`, `documents/`, `media/` and `media_thumbnails/` with `gsutil -m rsync -r -d`. Hashes every file and reconciles files against the image, document and media records. Every discrepancy must be listed with its evidence in [`src/discrepancies.ts`](src/discrepancies.ts), otherwise the step fails. It also fails when migrated content references a record whose file is missing. |
| `assets` | Uploads every image, document and media thumbnail with `title`, `originalFilename` and `source {name: "wagtail", id, url}`. Assets are content-addressed, so files that are already in the dataset are only patched to the same metadata. |
| `mux` | Lists Mux assets and reuses the one whose passthrough is `wagtail-media-<id>`, otherwise creates it from the public bucket URL (basic quality, public playback). Waits for `ready` and writes `state/mux-map.json`. The stored asset JSON is the asset's steady state: temporary master access (the weekly backup requests it, Mux reverts it after 24 hours) and its signed `master.url` are never recorded. |
| `ascii` | Renders testimonial ASCII art with the WP2 generator from the target dataset's image CDN. All 9 testimonials must match the live site byte for byte. |
| `transform` | Converts Wagtail rich text to Portable Text with `@portabletext/block-tools`, JSDOM and the compiled Studio schema, against a strict allowlist. StreamField bodies become one Portable Text array. Tags are ordered as the old site showed them (by name, ignoring case). A redirect to a page that is not published becomes a draft. The only content changes are the fixes listed with their evidence in [`src/content-fixes.ts`](src/content-fixes.ts). Writes `data.ndjson` sorted by `_id`, plus `reports/wp3/transform-<dataset>.json` (issues, tag merges, link-text flattening, mapping). |
| `import` | Refuses if migration documents changed since the last import (see above), runs `sanity documents validate --file` (Studio schema), then `sanity datasets import --replace`, then deletes documents with migration ids that the transform no longer produces, then records every migration document's `_rev` and content hash in `state/imported-<dataset>.json`. |
| `validate` | Checks counts, assets, hashes, references, `_key`s, Portable Text integrity, text and field parity against the export (and the tag order of every live project against the old site's API), Mux status, ASCII art, convergence (dataset == NDJSON) and `sanity documents validate`. Writes `reports/validation-<dataset>.{json,md}` and exits non-zero on any failure. |
| `baseline` | Only with `--steps`. Records an untouched dataset that was imported before the import kept a record. |
| `videos` | Only with `--steps`. Creates the missing `mux.videoAsset` documents and changes nothing else. |

Every step is deterministic. Document ids follow the contract (`blogPost-<pageId>`,
`drafts.blogPost-<pageId>`, ...), Portable Text keys come from Wagtail ids, and Mux data arrays get
their Mux ids as `_key`. Rerunning the whole pipeline converges to the same dataset.

## Tests

`npm test` covers the rich-text conversion (allowlist, keys, embeds, links), the document
helpers (tag order, content fixes, Mux steady state) and the Studio-edit check of the import. `npm run typecheck` type-checks the package, including the Studio and generator modules
it imports.
