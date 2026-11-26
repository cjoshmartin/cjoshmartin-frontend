# image-privacy

Sanity Function that replaces every image added to a document that carries location or other
personal metadata with a losslessly stripped copy (`../privacy/image-strip.ts`), points every
reference at the copy, and deletes the upload. Images without personal metadata are left as they
are. Contract: `docs/sanity-migration/schema-contract.md`, "Privacy".

| File | What it is |
| --- | --- |
| `trigger.ts` | Event filter (follows `asset->` to the asset's `privacy` field) and projection, the watched fields per type, the same rule in TypeScript, and the reference path finder. |
| `orchestrator.ts` | One run: for each image that needs work, lease, download, strip, upload the copy, mark it, repoint, delete. |
| `sanity.ts` | The ImageStore on @sanity/client: raw-perspective patches with revision checks, references, guarded delete, download of the stored bytes (`?dlRaw=` with the Function's token), upload of the copy. |
| `index.ts` | The handler. |
| `test/` | `npm test`: the filter against the rule (groq-js), the fields against `studio/schema.json`, and the orchestrator with the real stripper on an in-memory store. |

## How it works

1. **Trigger.** `create` and `update` of `blogPost`, `project`, `flexPage`, `testimonial`,
   `homePage`, `person` and `service`, drafts included, in `production` and `staging`, when an
   image in a watched field (single images, hero media, Portable Text image blocks) references an
   asset that was uploaded since `UPLOADED_SINCE` (2026-11-26; older images belong to the
   migration's privacy step) and whose `privacy` is missing, from another strip version,
   `replaced`, a stale `processing` (older than 10 minutes) or a due `pending` (older than 10
   minutes). The trigger is the content document, not the asset: a Studio upload creates the
   asset before it patches the reference in, and by the time the document's event arrives the
   reference exists. The live test waited 8 s between upload and reference: nothing ran before.
2. **Lease.** `privacy` = `processing` with this run as `holder`, revision-checked on the asset.
3. **Check.** The stored bytes come from `<url>?dlRaw=` with the Function's token: the plain image
   URL serves a re-encoded rendition, not the upload. Size and sha1 are checked. No personal
   metadata: `privacy` = `clean`, nothing else changes.
4. **Copy.** The stripped bytes are uploaded with the upload's file name, `source: {name:
   "image-privacy", id: <upload>}` and only the placeholders and palette extracted. The copy must
   have the upload's dimensions (crops and hotspots are fractions). It is marked `stripped` before
   anything points at it, and the upload is marked `replaced` (any `metadata.location`, `exif` or
   `image` Sanity extracted is removed from it).
5. **Repoint and delete.** Every document that references the upload (raw perspective: drafts,
   published, release versions) gets `<path>._ref` = the copy, with a revision check; crop,
   hotspot, alt, caption and layout are untouched. Then the upload is deleted if nothing references
   it; a reference added meanwhile is moved in the next round (5 rounds), and after that the filter
   matches `replaced` on that document's next event.
6. **Failures.** A file the stripper cannot handle: `failed` (final for this strip version), shown
   in the Studio as a warning on the field. Download, upload and API problems: `pending`, retried by
   the first event at least 10 minutes later. An unexpected error is also thrown, so it is in the
   Function logs.

No loops: the copy is marked before references move to it, checked uploads are `clean`,
`replaced` or `failed`, and patches on asset documents are not events of the watched types.

## Commands

```sh
npm ci
npm test
npm run typecheck
# from studio/ (the Blueprint): see ../video-to-mp4/README.md for the arm64 environment
SANITY_PROJECT_ID=j3vdh6ti npx sanity@latest functions logs image-privacy --stack ST-jc4gwa3c4t
```
