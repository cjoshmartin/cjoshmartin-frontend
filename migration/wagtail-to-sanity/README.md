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

`ffmpeg` and `ffprobe` must be on the `PATH` (the latest run used 9.1 from Homebrew), and so must
`exiftool` (13.0 or newer; the latest run used 13.55) and ImageMagick's `magick` for the privacy
step and the validation.
`--dataset production` also needs `--confirm-production`. Other options: `--steps a,b`,
`--no-gcs-sync`, `--data-dir <path>` and `--discard-studio-edits` (see below).

Compare two datasets (document ids, counts, every document, Portable Text hashes and the two
transform outputs) with `npm run compare -- --datasets staging,production`. It writes
`reports/wp3/compare-staging-production.{json,md}` and exits non-zero on any difference. Assets
may differ only in `uploadId` and in the dataset name inside `path` and `url`. `secrets.*` documents
and the Presentation tool's per-session `sanity.previewUrlSecret` documents hold secrets and are
listed by id only, never compared.

Secrets come from the environment or from `~/cjoshmartin-migration/secrets.env`
(`SANITY_WRITE_TOKEN`). They are never logged. The Sanity CLI
steps (schema validation and `datasets import`) use the machine's `sanity login`.

Data lives outside the repo in `~/cjoshmartin-migration/`: `wagtail-export.zip`, `extracted/`,
`gcs/` (bucket mirror), `privacy/` (copies without personal metadata, the privacy map, the asset
inventories and the downloads the checks read; local only), `video-mp4/media-<id>/` (the converted
MP4s), `state/` (asset, MP4, video and ASCII-art maps), `transformed/<dataset>/data.ndjson` and
`reports/`.

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
`file` is the MP4), so the Function leaves them alone. Until the Studio is used, all 13 validation
checks must pass. After editors have changed content, the parity and convergence checks list their
edits as differences, which is expected.

## Steps

| Step | What it does |
|---|---|
| `extract` | Unzips the export and checks it against the manifest (bytes and sha256). Mirrors `original_images/`, `documents/`, `media/` and `media_thumbnails/` with `gsutil -m rsync -r -d`. Hashes every file and reconciles files against the image, document and media records. Every discrepancy must be listed with its evidence in [`src/discrepancies.ts`](src/discrepancies.ts), otherwise the step fails. It also fails when migrated content references a record whose file is missing. |
| `privacy` | Owner decision: no asset the public datasets serve carries location or other personal metadata, and nothing is re-encoded. Since rules version 2 the migrated assets follow the same policy as new uploads: the Functions' own strippers in [`studio/functions/privacy`](../../studio/functions/privacy) decide what goes. Scans every bucket file ([`src/privacy/scan.ts`](src/privacy/scan.ts)) with `exiftool -ee` (embedded documents and timed metadata too) against the rules in [`src/privacy/rules.ts`](src/privacy/rules.ts) (location, maker notes, serials and other ids, names of people and face regions, the camera or computer and its software, capture times with their UTC offsets, free-text comments, data tracks), with the image stripper's analysis, and for videos with the in-place stripper's check (metadata boxes, data tracks, creation times, non-zero `mdat` bytes no track uses such as an iOS draft movie header, location signatures outside the samples), plus the header of every STL model. For each file with personal metadata it makes a copy without it in `privacy/stripped/`: images with the image-privacy Function's stripper (coded image, orientation and ICC profile byte for byte), videos in place with [`isobmff-video.ts`](../../studio/functions/privacy/isobmff-video.ts), as the video-to-mp4 Function does (every audio and video packet, edit list, display matrix, colour and Dolby Vision box kept). Each copy is verified by decoded-pixel hashes (ImageMagick and ffmpeg) and unchanged tags, or by per-stream packet hashes and unchanged bytes outside the stripped ranges. Then it inventories every asset of the dataset (`privacy/inventory-<dataset>.json`), uploads the copy of each asset with personal metadata (same title, file name and source without `source.url`, which would link to the unstripped bucket object, plus the `privacy` field the image-privacy and video-to-mp4 Functions read), moves every use in every document (drafts and release versions too) to it in one transaction, deletes the old asset once nothing uses it, and brings the asset, video and ASCII-art maps, the NDJSON and the import record up to date. A copy made under earlier rules is replaced by the current copy of its bucket original. Rerunnable; a second run changes nothing. |
| `assets` | Uploads every image, document and media thumbnail with `title`, `originalFilename` and `source {name: "wagtail", id, url}`; a file with personal metadata is uploaded as its stripped copy from the privacy map, whose `source` has no `url` (the step refuses to run without a current map). Assets are content-addressed, so files that are already in the dataset are only patched to the same metadata. Refuses before writing when asset metadata changed since its last run (see above). |
| `convert` | Converts every Wagtail video in `gcs/media/` to MP4 with `buildFfmpegArgs` from [`studio/functions/video-to-mp4/settings.ts`](../../studio/functions/video-to-mp4/settings.ts) (preset `medium`), the same settings the `video-to-mp4` Function uses, into `video-mp4/media-<id>/<name>.mp4`. Then checks each MP4 ([`src/video/ffmpeg.ts`](src/video/ffmpeg.ts)): H.264 High, yuv420p, longest side at most 1920 px, even dimensions equal to the settings' own arithmetic, no rotation left, `moov` before `mdat`, stereo AAC only when the original has audio, no other streams, no metadata copied, durations within 0.1 s of the original, and every frame decodes without an error. A failing check fails the step unless [`src/conversion-deviations.ts`](src/conversion-deviations.ts) explains exactly that failure of exactly those bytes. Writes `state/video-mp4.json` and the size table `reports/wp3/video-mp4.md`. Does not depend on the dataset; reruns reuse MP4s whose original, settings and arguments are unchanged. |
| `videos` | Uploads each video's original (`source {name: "wagtail", id: "media-<id>", url}`; its stripped copy, without `url`, when it has personal metadata) and its MP4 (`originalFilename` `<base name>.mp4`, `video/mp4`, `source {name: "video-to-mp4", id: <original asset _id>}`) to the dataset. Like every converter it first looks for an asset with that `video-to-mp4` source and reuses it; one with other bytes (made by the Function) must pass the same checks, and its settings version is read from the video blocks that play it. Same metadata protection as `assets`. Writes `state/videos-<dataset>.json`. |
| `ascii` | Renders testimonial ASCII art with the WP2 generator from the target dataset's image CDN. All 9 testimonials must match the live site byte for byte. |
| `transform` | Converts Wagtail rich text to Portable Text with `@portabletext/block-tools`, JSDOM and the compiled Studio schema, against a strict allowlist. StreamField bodies become one Portable Text array; a media block becomes a `video` block whose `file` is the MP4, `original` the upload and `conversion` `{status: "ready", sourceAssetId, outputAssetId, settingsVersion, updatedAt}` (the conversion time). Tags are ordered as the old site showed them (by name, ignoring case). A redirect to a page that is not published becomes a draft. The only content changes are the fixes listed with their evidence in [`src/content-fixes.ts`](src/content-fixes.ts). Writes `data.ndjson` sorted by `_id`, plus `reports/wp3/transform-<dataset>.json` (issues, tag merges, link-text flattening, mapping). |
| `import` | Refuses if migration documents changed since the last import (see above), runs `sanity documents validate --file` (Studio schema), then `sanity datasets import --replace`, then deletes documents with migration ids that the transform no longer produces (this is how the `mux-video-<id>` documents of earlier runs were removed), then records every migration document's `_rev` and content hash in `state/imported-<dataset>.json`. |
| `validate` | Checks counts, assets (video originals included), hashes (a stripped image by its decoded pixels against the Wagtail original), references, `_key`s, Portable Text integrity, text and field parity against the export (and the tag order of every live project against the old site's API), videos (every block follows contract v2 with a `ready` conversion of the current settings version, its `file` is the checked `video/mp4` asset with source `video-to-mp4`, its `original` the Wagtail upload, nothing needs conversion, the CDN serves every MP4, and no Mux document, block or token is left; a stripped original has the Wagtail upload's audio and video packets), privacy (every asset, downloaded from the dataset, has no personal metadata by the scan of the `privacy` step; no `source.url` names a bucket object other than the asset's own bytes; no asset document holds `metadata.location`; no unstripped upload is left; every copy carries its `privacy` field), ASCII art, convergence (dataset == NDJSON) and `sanity documents validate`. Writes `reports/validation-<dataset>.{json,md}` and exits non-zero on any failure. |
| `baseline` | Only with `--steps`. Records an untouched dataset that was imported before the import kept a record. |

Every step is deterministic. Document ids follow the contract (`blogPost-<pageId>`,
`drafts.blogPost-<pageId>`, ...) and Portable Text keys come from Wagtail ids. The same original,
settings, ffmpeg version and CPU count give byte-identical MP4s, and a rerun reuses them anyway.
Rerunning the whole pipeline converges to the same dataset.

## Recreate a dataset from a verified export

Both datasets are public, and a public dataset's History API answers without a token. Its old
revisions name every deleted upload (an asset id is its CDN path). The only way to drop them is to
delete the dataset and import a clean export, so that the history starts at the import. The
procedure and its results are in
[`docs/sanity-migration/reports/dataset-recreate.md`](../../docs/sanity-migration/reports/dataset-recreate.md);
the tools are [`src/recreate.ts`](src/recreate.ts) (`npm run recreate -- <command>`) and
[`scripts/recreate-dataset.sh`](scripts/recreate-dataset.sh):

| Command | What it does |
|---|---|
| `snapshot --dataset <ds> --out <file>` | Every document (raw: drafts, versions, system documents) with every field, counts per type, asset sha1s |
| `history-baseline --dataset <ds> --snapshot <file> --ids-from <file>... --out <file>` | The current documents' transactions, and for every deleted id (asset ids named in the local files, `{"ids": [...]}` files verbatim) its transactions and whether an anonymous request reads it |
| `verify-export --snapshot <file> --dir <unpacked export> --out <file>` | The export equals the snapshot (documents, `assets.json`, every file's sha1 and size) and every file passes the privacy scan of the `privacy` step |
| `scripts/recreate-dataset.sh <ds> <export.tar.gz> [--confirm-production]` | Refuses while the Blueprint Stack has Functions; deletes the dataset, creates it again (public), imports the export, prints the import start time |
| `restore-assets --dataset <ds> --snapshot <file> [--confirm-production]` | Patches every asset document back to the snapshot (`_createdAt`, and anything else the import did not restore); identity fields must already be equal |
| `compare --dataset <ds> --snapshot <file> --out <file>` | Every document equals the snapshot, ignoring `_rev`, `_createdAt`, `_updatedAt` and an asset's `uploadId` |
| `history-check --dataset <ds> --baseline <file> --import-start <iso> --out <file>` | No deleted id has a transaction or an anonymous read; every current document's history starts at the import |

Snapshots, baselines and exports name deleted assets and hold unpublished drafts: keep them in
`~/cjoshmartin-migration/dataset-exports/` (mode 700), never in the repository.

## Tests

`npm test` covers the personal-metadata rules, stripped copies in the plan (no bucket URL), moving asset ids,
the privacy field and the import-record update of the privacy step, the rich-text conversion
(allowlist, keys, embeds, links), the document
helpers (tag order, content fixes, video blocks), the ffprobe and MP4 box helpers, the video asset
plan, the known conversion deviations, the Studio-edit check of the import, the asset metadata
check of the `assets` and `videos` steps, and the dataset-recreate helpers (the export's file
names and asset pointers, snapshot counts, field comparison). `npm run test:ffmpeg` converts synthetic clips with the
real ffmpeg and checks that the MP4 checks accept good files and reject bad ones, and strips a
photo, a screenshot and a phone-like video (also with an iOS-like draft movie header in `mdat`)
with the real exiftool, ffmpeg and ImageMagick, checking that the copies are lossless and clean and
that the verification rejects copies that are not (it fails when a tool is missing). The in-place
video stripper's own unit tests are in `studio/functions/privacy` (`npm test` there). `npm run typecheck` type-checks the package, including the Studio and generator modules
it imports.
