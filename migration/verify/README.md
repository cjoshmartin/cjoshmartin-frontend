# Migration verification (WP7)

End-to-end checks of the Sanity-backed site against the old Wagtail-backed site (plan §11.5, §11.7).
Results go to `~/cjoshmartin-migration/reports/parity/` (outside git: screenshots are large and the
raw data can quote draft-only slugs).

## Setup

```sh
npm ci
```

`playwright-core` drives the Chrome for Testing build in the Playwright cache
(`~/Library/Caches/ms-playwright/chromium-*`), which has the H.264/AAC codecs Mux playback needs.
Set `CHROME_PATH` to use another Chrome.

The new site must run locally on port 3000 (a CORS origin of the Sanity project, needed for
SanityLive and the STL files), built against the dataset being checked:

```sh
# from the repo root, with NEXT_PUBLIC_SANITY_DATASET=production
npm run build && npx next start -p 3000
```

## Commands

| Command | What it does |
|---|---|
| `node src/crawl.mjs [--only <text>]` | Loads every route on both sites (HTTP probe with each redirect hop, then Chromium at 1440 and 390 px), extracts metadata, headings, media counts, links and visible text, and saves full-page screenshots. Writes `raw/`, `shots/`, `routes.json`. |
| `node src/report.mjs` | Compares the crawl route by route, classifies each difference as expected (with its reason) or unexpected, and writes `parity-results.json`, `summary.md` and `index.html` (old and new screenshots side by side). |
| `node src/interactive.mjs` | On the new site: Mux videos reach the playing state, STL canvases draw a moving model, YouTube embeds load and play, testimonial ASCII art matches Sanity and the old site, hover/touch reveal and rotation work, Disqus thread parameters match the old site. Writes `interactive-results.json` and `interactive/`. |
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
deviations (flex titles and canonicals, Sanity og:image crops, image rounding) and WP3b's pending
Mux videos (only as many missing videos as the page has video blocks without a Mux asset).
Everything else is reported as unexpected.
