# upload-privacy

Sanity Function that removes location and personal metadata from uploads no document uses, and
deletes the unstripped upload. The image-privacy and video-to-mp4 Functions start from content
documents' events, so an upload that never gets a reference (or loses it before they run) was
never stripped: an abandoned upload, a video removed from its block before the conversion, a draft
or release discarded first, an upload by an API client. Contract:
`docs/sanity-migration/schema-contract.md`, "Privacy".

| File | What it is |
| --- | --- |
| `trigger.ts` | Event filter (delta mode: `create` of image and file assets, `delete` of content documents) and projection, the grace period, the sweep query. |
| `orchestrator.ts` | One run: remove extracted location data, wait for a reference, handle the upload, sweep earlier unused uploads. |
| `image-file.ts` | An image uploaded as a file asset: the image stripper's copy uploaded as a file asset, the upload marked `replaced`. |
| `sanity.ts` | The image-privacy store plus the sweep query. |
| `index.ts` | The handler: images through the image-privacy Function's processing, videos through the video-to-mp4 Function's stripper with the bundled ffmpeg. |
| `test/` | `npm test`: the filter and the sweep query (groq-js) and the orchestrator on an in-memory store with the real image stripper. |

## How it works

1. **Trigger.** `create` of a `sanity.imageAsset` or `sanity.fileAsset` in `production` or `staging`,
   uploaded since 2026-11-26, without `privacy`, not made by the migration (`source.name`
   `wagtail`) or a Function (`image-privacy`, `video-to-mp4-original`, `video-to-mp4`); and the
   `delete` of any content document, draft or release version (a publish, a discarded draft, an
   archived or published release).
2. **New upload.** Any `metadata.location`, `exif` or `image` Sanity extracted into the public asset
   document is removed at once. Then the run waits up to 60 s, looking every 5 s, for a document to
   use the upload (the Studio sets the reference right after the upload; then the content Functions
   handle it) or a Function to take it.
3. **An unused upload** (handleUpload): used meanwhile, being converted or checked: nothing.
   `replaced` with an existing copy: deleted. Checked with the current stripper: nothing. Otherwise
   an image goes through the image-privacy Function's processing (a copy without location and
   personal metadata, references moved, the upload deleted; clean images are marked `clean`), a
   video through the video-to-mp4 Function's stripper (in place for QuickTime/MP4; the copy is kept
   in the media library, the upload deleted; a clean upload is marked `clean`), an image uploaded as
   a file asset (served as stored) through the image stripper into a file copy (`image-file.ts`). A
   file the strippers cannot handle is marked `failed` and deleted (a file with its location is
   never kept in the public dataset); any other problem `pending` (a later sweep
   retries it). Other files (PDF, STL) are not stripped by any Function and are left as they are.
4. **Sweep.** Every run then handles up to 5 earlier uploads (older than the grace period, used by
   no document, not made by the migration or a Function) that still have their metadata: never
   checked, `replaced` but not deleted, `failed` (deleted; or stripped again when an older stripper
   failed), a due `pending`, a stale `processing`, or checked by an older stripper.

Uploads are read with a unique `privacyFetch` query parameter and the Function's token
(`privacy/private-fetch.ts`), never through their plain public URL: the asset CDN keeps a deleted
file cached for up to 30 days. Copies record their upload only as a keyed digest
(`privacy/provenance.ts`, the `PRIVACY_LINK_KEY` environment variable).

There is no scheduled sweep: scheduled Functions need the Blueprint stack promoted to the
organization (one-way) and a robot token, which is the owner's decision. Until then a leftover
(for example a `replaced` upload whose last reference was removed while a release was locked) is
handled at the next upload or deletion in its dataset.

## Commands

```sh
npm ci
npm test
npm run typecheck
# from studio/ (the Blueprint): deploy with npm_config_platform=linux npm_config_arch=arm64 (ffmpeg)
SANITY_PROJECT_ID=j3vdh6ti npx sanity@latest functions logs upload-privacy --stack ST-jc4gwa3c4t
```
