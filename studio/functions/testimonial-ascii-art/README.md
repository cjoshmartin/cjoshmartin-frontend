# testimonial-ascii-art

Sanity Function that keeps `testimonial.asciiArt` in sync with `testimonial.image`. It replaces
the Django serializer that rendered each testimonial photo with `ascii-magic==2.3.0`
(`to_html(columns=35)`, brightness floor 8, lxml pretty print). The output is byte-identical to
the Django output for the current photos.

| File | What it is |
| --- | --- |
| `generate.ts` | The generator. Exact port of ascii-magic 2.3.0 and lxml's formatting, plus the Sanity CDN helper. Also imported by the migration scripts. |
| `pillow-resample.ts` | Exact port of Pillow's bicubic `Image.resize` for RGB (Pillow 13.0.0 `Resample.c`). |
| `trigger.ts` | Event filter, projection and the matching decision logic (`planAsciiArtUpdate`). |
| `index.ts` | The Function handler. |
| `../../sanity.blueprint.ts` | Blueprint that deploys it (Stack `cjoshmartin-functions`). |
| `test/` | `node:test` suites. Expected values come from the real Python libraries (`test/fixtures/make_fixtures.py`). |
| `scripts/compare-with-python.ts` | Real-pipeline comparison through the Sanity CDN; writes `docs/sanity-migration/reports/ascii-comparison.html`. |
| `scripts/live-check.ts` | End-to-end check of the deployed Function on a dataset (creates and deletes a scratch document). |

## How it works

1. Trigger: `create` and `update` of `testimonial` documents (drafts included) in `production` or
   `staging`, only when `asciiArtSource` differs from `image.asset._ref`, `asciiArt` is missing,
   or the image was removed while generated fields are still set.
2. Grid size from the asset id dimensions, with ascii-magic's float arithmetic (usually 35x15).
3. Pixels: the whole image as a lossless PNG from the image CDN (`?fm=png`), decoded with
   `pngjs`. Images whose longer edge is above 2048 px are first scaled down by the CDN.
4. Brightness floor, Pillow bicubic resize to the grid, ascii-magic HTML.
5. Patch `asciiArt` and `asciiArtSource` (the asset id), or unset both when there is no image.
   The patch makes the document stop matching the filter, so it does not retrigger itself.

## Commands

```sh
npm ci                      # in this directory
npm test                    # unit tests
npm run typecheck

# from studio/
npx sanity@latest blueprints plan
npx sanity@latest blueprints deploy
SANITY_PROJECT_ID=j3vdh6ti npx sanity@latest functions logs testimonial-ascii-art --stack ST-jc4gwa3c4t
```

Regenerate the fixtures (needs Python with `ascii-magic==2.3.0`, `lxml==5.1.0` and Pillow, plus
the live API snapshot and the original photos):

```sh
python -I test/fixtures/make_fixtures.py <page-3.json> <originals dir>
```
