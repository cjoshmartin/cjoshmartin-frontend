# Wagtail → Sanity migration

One-time ETL that moves every cjoshmartin.com page, snippet, image, document and video from the
Wagtail export into the Sanity project `j3vdh6ti`. Videos are converted to MP4 and stored as
Sanity file assets (video contract v2); nothing uses Mux any more. It is plan §9 of
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

`ffmpeg` and `ffprobe` must be on the `PATH` (the latest run used 9.0.1 from Homebrew).
`--dataset production` also needs `--confirm-production`. Other options: `--steps a,b`,
`--no-gcs-sync`, `--data-dir <path>` and `--discard-studio-edits` (see below).

Compare two datasets (document ids, counts, every document, Portable Text hashes and the two
transform outputs) with `npm run compare -- --datasets staging,production`. It writes
`reports/wp3/compare-staging-production.{json,md}` and exits non-zero on any difference. Assets
may differ only in `uploadId` and in the dataset name inside `path` and `url`.

Secrets come from the environment or from `~/cjoshmartin-migration/secrets.env`
(`SANITY_WRITE_TOKEN`). They are never logged. The Sanity CLI
steps (schema validation and `datasets import`) use the machine's `sanity login`.

Data lives outside the repo in `~/cjoshmartin-migration/`: `wagtail-export.zip`, `extracted/`,
`gcs/` (bucket mirror), `video-mp4/media-<id>/` (the converted MP4s), `state/` (asset, MP4, video
and ASCII-art maps), `transformed/<dataset>/data.ndjson` and `reports/`.

### Reruns after the Studio is in use

Every import first compares the dataset with `state/imported-<dataset>.json`, the record of the
`_rev` and content hash of each migration document the last import left behind. If anything
changed since (an edited document, a draft opened in the Studio, a migrated draft that was
published or discarded, a release version), the import stops before writing and lists the ids. It
would otherwise overwrite those edits, and its pruning would delete the published copy of a draft.
`--discard-studio-edits` overrides that on purpose. A dataset imported before the record existed
is recorded once with `--steps baseline`, which only succeeds when every migration document still
equals `transformed/<dataset>/data.ndjson`, so run it before the transform changes that file.

When a run includes `import`, that check also runs before the first step, so a full rerun that the
import would refuse stops before the `assets` or `videos` step writes anything. The `assets` step
protects asset metadata the same way, with `state/assets-<dataset>.json` as its record: it refuses
before uploading or patching anything when an asset's `title`, `description`, `originalFilename` or
`source` differs both from what it would set and from what its last run left. The `videos` step
does the same with `state/videos-<dataset>.json`. `--discard-studio-edits` overrides both.

Videos uploaded in the Studio later are converted by the `video-to-mp4` Sanity Function, not by
this package. The migrated video blocks are already converted (`conversion.status` `ready` and
`file` is the MP4), so the Function leaves them alone. Until the Studio is used, all 12 validation
checks must pass. After editors have changed content, the parity and convergence checks list their
edits as differences, which is expected.

## Steps

| Step | What it does |
|---|---|
| `extract` | Unzips the export and checks it against the manifest (bytes and sha256). Mirrors `original_images/`, `documents/`, `media/` and `media_thumbnails/` with `gsutil -m rsync -r -d`. Hashes every file and reconciles files against the image, document and media records. Every discrepancy must be listed with its evidence in [`src/discrepancies.ts`](src/discrepancies.ts), otherwise the step fails. It also fails when migrated content references a record whose file is missing. |
| `assets` | Uploads every image, document and media thumbnail with `title`, `originalFilename` and `source {name: "wagtail", id, url}`. Assets are content-addressed, so files that are already in the dataset are only patched to the same metadata. Refuses before writing when asset metadata changed since its last run (see above). |
| `convert` | Converts every Wagtail video in `gcs/media/` to MP4 with `buildFfmpegArgs` from [`studio/functions/video-to-mp4/settings.ts`](../../studio/functions/video-to-mp4/settings.ts) (preset `medium`), the same settings the `video-to-mp4` Function uses, into `video-mp4/media-<id>/<name>.mp4`. Then checks each MP4 ([`src/video/ffmpeg.ts`](src/video/ffmpeg.ts)): H.264 High, yuv420p, longest side at most 1920 px, even dimensions equal to the settings' own arithmetic, no rotation left, `moov` before `mdat`, stereo AAC only when the original has audio, no other streams, no metadata copied, durations within 0.1 s of the original, and every frame decodes without an error. A failing check fails the step unless [`src/conversion-deviations.ts`](src/conversion-deviations.ts) explains exactly that failure of exactly those bytes. Writes `state/video-mp4.json` and the size table `reports/wp3/video-mp4.md`. Does not depend on the dataset; reruns reuse MP4s whose original, settings and arguments are unchanged. |
| `videos` | Uploads each video's original (`source {name: "wagtail", id: "media-<id>", url}`) and its MP4 (`originalFilename` `<base name>.mp4`, `video/mp4`, `source {name: "video-to-mp4", id: <original asset _id>}`) to the dataset. Like every converter it first looks for an asset with that `video-to-mp4` source and reuses it; one with other bytes (made by the Function) must pass the same checks, and its settings version is read from the video blocks that play it. Same metadata protection as `assets`. Writes `state/videos-<dataset>.json`. |
| `ascii` | Renders testimonial ASCII art with the WP2 generator from the target dataset's image CDN. All 9 testimonials must match the live site byte for byte. |
| `transform` | Converts Wagtail rich text to Portable Text with `@portabletext/block-tools`, JSDOM and the compiled Studio schema, against a strict allowlist. StreamField bodies become one Portable Text array; a media block becomes a `video` block whose `file` is the MP4, `original` the upload and `conversion` `{status: "ready", sourceAssetId, outputAssetId, settingsVersion, updatedAt}` (the conversion time). Tags are ordered as the old site showed them (by name, ignoring case). A redirect to a page that is not published becomes a draft. The only content changes are the fixes listed with their evidence in [`src/content-fixes.ts`](src/content-fixes.ts). Writes `data.ndjson` sorted by `_id`, plus `reports/wp3/transform-<dataset>.json` (issues, tag merges, link-text flattening, mapping). |
| `import` | Refuses if migration documents changed since the last import (see above), runs `sanity documents validate --file` (Studio schema), then `sanity datasets import --replace`, then deletes documents with migration ids that the transform no longer produces (this is how the `mux-video-<id>` documents of earlier runs were removed), then records every migration document's `_rev` and content hash in `state/imported-<dataset>.json`. |
| `validate` | Checks counts, assets (video originals included), hashes, references, `_key`s, Portable Text integrity, text and field parity against the export (and the tag order of every live project against the old site's API), videos (every block follows contract v2 with a `ready` conversion of the current settings version, its `file` is the checked `video/mp4` asset with source `video-to-mp4`, its `original` the Wagtail upload, nothing needs conversion, the CDN serves every MP4, and no Mux document, block or token is left), ASCII art, convergence (dataset == NDJSON) and `sanity documents validate`. Writes `reports/validation-<dataset>.{json,md}` and exits non-zero on any failure. |
| `baseline` | Only with `--steps`. Records an untouched dataset that was imported before the import kept a record. |

Every step is deterministic. Document ids follow the contract (`blogPost-<pageId>`,
`drafts.blogPost-<pageId>`, ...) and Portable Text keys come from Wagtail ids. The same original,
settings, ffmpeg version and CPU count give byte-identical MP4s, and a rerun reuses them anyway.
Rerunning the whole pipeline converges to the same dataset.

## Tests

`npm test` covers the rich-text conversion (allowlist, keys, embeds, links), the document
helpers (tag order, content fixes, video blocks), the ffprobe and MP4 box helpers, the video asset
plan, the known conversion deviations, the Studio-edit check of the import and the asset metadata
check of the `assets` and `videos` steps. `npm run test:ffmpeg` converts synthetic clips with the
real ffmpeg and checks that the MP4 checks accept good files and reject bad ones (it fails when
ffmpeg is missing). `npm run typecheck` type-checks the package, including the Studio and generator modules
it imports.
