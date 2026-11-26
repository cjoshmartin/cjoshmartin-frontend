# Migration verification (WP7)

End-to-end checks of the Sanity-backed site against the old Wagtail-backed site (plan §11.5, §11.7).
Results go to `~/cjoshmartin-migration/reports/parity/` (outside git: screenshots are large and the
raw data can quote draft-only slugs).

## Setup

```sh
npm ci
```

`playwright-core` drives a browser that decodes H.264/AAC, which the site's MP4 videos need
(Playwright's open-source Chromium builds do not). `--browser` (or `VERIFY_BROWSER`) picks it:

| `--browser` | Browser |
|---|---|
| `chrome-for-testing` (default) | The Chrome for Testing build in the Playwright cache (`~/Library/Caches/ms-playwright/chromium-*`). `CHROME_PATH` overrides the executable. |
| `chrome` | An installed Google Chrome (Playwright channel `chrome`). |
| `webkit` | Playwright's WebKit build in the Playwright cache (Safari's engine). |

The new site must run locally on port 3000 (a CORS origin of the Sanity project, needed for
SanityLive and the STL files), built against the dataset being checked:

```sh
# from the repo root, with NEXT_PUBLIC_SANITY_DATASET=production
npm run build && npx next start -p 3000
```

## Commands

| Command | What it does |
|---|---|
| `node src/crawl.mjs [--only <text>] [--browser <b>]` | Loads every route on both sites (HTTP probe with each redirect hop, then the browser at 1440 and 390 px), extracts metadata, headings, media counts, videos (sources, types, attributes, rendered size), links and visible text, records every request host and any request to Mux or the old bucket (`src/forbidden.mjs`), and saves full-page screenshots. Writes `raw/`, `shots/`, `routes.json`. |
| `node src/report.mjs` | Compares the crawl route by route, classifies each difference as expected (with its reason) or unexpected, and writes `parity-results.json`, `summary.md` and `index.html` (old and new screenshots side by side, and every `interactive-results*.json`). |
| `node src/interactive.mjs [--browser <b>] [--videos-only]` | On the new site: every video starts on its own and plays its Sanity MP4 (`type="video/mp4"`, video contract v2), muted, inline, with controls, and loops after a seek to the end, and each page has as many videos as the old page and the Sanity document; STL canvases draw a moving model, YouTube embeds load and play, testimonial ASCII art matches Sanity and the old site, hover/touch reveal and rotation work, Disqus thread parameters match the old site, and no request reaches Mux or the old bucket. Writes `interactive-results.json` (Chrome for Testing) or `interactive-results-<browser>.json`, and `interactive/`. `--videos-only` skips everything but the videos. |
| `node src/video-function-check.mjs --input <video> [--reference <mp4>] [--keep-mp4 <path>] [--json <file>]` | Live check of the `video-to-mp4` Function on **staging**: uploads a copy of the input (a `free` box appended, so a new asset) into a scratch draft blog post, waits for `ready`, checks the block, the MP4 asset and the MP4 itself against `studio/functions/video-to-mp4/settings.ts` (codec, profile, size, audio, metadata, faststart, CRF and preset in the x264 SEI, every input frame at its own time, duration, full decode), optionally against a local conversion of the same original, then deletes the scratch document and every asset it made. Needs `SANITY_PROJECT_ID`, `SANITY_WRITE_TOKEN`, ffmpeg and ffprobe. |
| `node src/function-check.mjs [--id testimonial-5] [--donor testimonial-7]` | Live check of the `testimonial-ascii-art` Function on **staging**: swaps the photo, waits for the art to be regenerated, restores the photo and waits for the original art. Needs `SANITY_PROJECT_ID`, `SANITY_STAGING_DATASET`, `SANITY_WRITE_TOKEN`. |
| `npm test` | Unit tests for the text diff and the classification rules. |

`OLD_BASE`, `NEW_BASE`, `PARITY_DIR` and `WAGTAIL_EXPORT_JSON` override the defaults in `src/config.mjs`.

## Route list

Built from the Wagtail export (`src/routes.mjs`): every live page (home, 7 blog posts, 13 projects,
2 flex pages), `/blog`, `/projects` with `project_type=CLI|PER` and one medium and one technology
filter (the first ones linked on the old `/projects`), `/screen`, `/ascii`, `/start-a-project`,
`/resume`, `/resume/pdf`, `/sitemap.xml`, `/robots.txt`, the redirects `/about`, `/portfolio`,
`/info`, `/admin`, the four Wagtail redirects, `/?utm_source=test` and two unknown slugs.

## Expected differences

`src/compare.mjs` only accepts a difference when a rule explains it, and every rule names its
source: plan §7.1–7.3 (footer credit, `/about` and `/admin` redirects, bugs 1–6), WP4's documented
deviations (flex titles and canonicals, Sanity og:image crops, image rounding), the MP4 videos
(video contract v2 in `docs/sanity-migration/schema-contract.md`: each video plays the block's
converted MP4 from the Sanity CDN instead of the original file in the old bucket, the old file is
the block's kept original in the same order, and each video box is within ±2 px) and the round-1
review fixes (a Wagtail redirect to a never-published page is a draft, so its path is a plain 404;
see `docs/sanity-migration/reports/fixes.md`).
Everything else is reported as unexpected; in particular a page with fewer videos than the old
page, and any request to Mux or to `storage.googleapis.com/images-for-cms` on any route.
