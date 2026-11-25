# WP7: end-to-end verification against the old site

Status: **done**. A production build of branch `sanity-migration` (commit `0f88962`, reading the
`production` dataset) was compared route by route with the live Wagtail-backed site. Of 47 routes,
5 are identical, 40 differ only in ways the plan or a work-package note explains, and **2 have
unexpected differences, both low severity** (a tag order on one project, and a Wagtail redirect that
points at a never-published post). Videos, STL models, YouTube embeds, testimonial ASCII art, the
hover reveal, testimonial rotation and Disqus threads all work. The live ASCII-art Function check
on `staging` passed and left the document exactly as it was.

The full report with screenshots is local only (55 MB, over the 5 MB limit for the repo):
`~/cjoshmartin-migration/reports/parity/index.html`.

## Setup

| Item | Value |
|---|---|
| Old site | `https://www.cjoshmartin.com` (the apex `cjoshmartin.com` answers 308 to `www`) |
| New site | `next build` + `next start -p 3000` of commit `0f88962`, built in an isolated copy (`git archive HEAD` into `~/cjoshmartin-migration/tmp/wp7-build`) so other agents' work in the tree could not interfere. Port 3000 is one of the project's CORS origins, which SanityLive and the STL files need. |
| Env | `NEXT_PUBLIC_SANITY_PROJECT_ID=j3vdh6ti`, `NEXT_PUBLIC_SANITY_DATASET=production`, `NEXT_PUBLIC_SANITY_STUDIO_URL=https://cjoshmartin.sanity.studio`, `SANITY_API_READ_TOKEN` from the viewer token, passed as process environment (no copy of `.env.local`). |
| Browser | Chrome for Testing 1248 from the Playwright cache (the build WP4 used), driven by `playwright-core` 1.65.1 through `executablePath`, headless. The revision `playwright-core` 1.65.1 would download (1255) is not installed, and nothing was downloaded. Chrome for Testing includes the H.264/AAC codecs that Mux streams need; the playback results below confirm it. |
| Reference data | Published documents of the Sanity `production` dataset (public read), the Wagtail export (`export.json`), and the live API snapshot of the home page (old testimonial art). |

The app code was not changed. `next build` passed (18 app routes plus the proxy). The server log
contains only the expected `video block … has no playable Mux asset` messages, for the 19 video blocks without a Mux asset.

## Tooling: `migration/verify/`

A standalone package (`playwright-core`, `@sanity/client`), documented in its README.

| File | Purpose |
|---|---|
| `src/routes.mjs` | Route list built from the Wagtail export (see below). |
| `src/crawl.mjs` | For each route and each site: an HTTP probe that follows redirects hop by hop, then Chromium at 1440 px and 390 px (mobile emulation, touch). It waits for the visible text to settle (TypeIt animations), scrolls the page so lazy content loads, extracts the data below, and saves full-page screenshots. |
| `src/page-extract.mjs` | The in-page extraction: status, `<title>`, meta description, og:image, canonical, robots meta, h1, the ordered heading list with ids, images (kind, host, rendered size, broken), videos (source and attributes), iframes (YouTube, Disqus, third party), code blocks (text and line numbers), STL canvases and load errors, internal and external links, in-page `#` links, every element id, visible text, testimonial art, page height and horizontal scroll. The rotating testimonial and Disqus are left out of the text and heading comparison and checked separately. |
| `src/compare.mjs` | The classification. A difference is EXPECTED only if a rule explains it, and each rule cites its source. Everything else is UNEXPECTED. |
| `src/text-diff.mjs` | Word-level Myers diff: similarity ratio and the differing hunks, each checked against the rules. |
| `src/report.mjs` | Writes `parity-results.json`, `summary.md` and `index.html` (every check per route, the interactive results, and old and new screenshots side by side with synchronized scrolling). |
| `src/interactive.mjs` | Interactive checks on the new site, with the old site as a baseline where needed. |
| `src/function-check.mjs` | The live Function check on staging. |
| `test/` | 11 `node:test` tests for the diff and the classification rules (`npm test`). |

### Routes (47)

- Every live page in the export: home, 7 blog posts, 13 projects, `/flex/portfolio`, `/flex/blog`.
- `/blog`, `/projects`, `/projects?project_type=CLI`, `/projects?project_type=PER`,
  `/projects?medium=Web` and `/projects?technologies=React+Native` (the first medium and technology
  links on the old `/projects`).
- `/screen`, `/ascii`, `/start-a-project`, `/resume`, `/sitemap.xml`, `/robots.txt`.
- Redirects `/about`, `/portfolio`, `/info`, `/admin`.
- Additional checks: `/resume/pdf`, `/?utm_source=test` (bug 3), `/blog/does-not-exist` and
  `/projects/does-not-exist` (bug 5), and the 4 Wagtail redirect paths.

## Parity results

| Route | Verdict | Text similarity | Expected differences | Unexpected |
|---|---|---|---|---|
| `/` | expected | 0.994 | og:image crop, Sanity CDN, footer | |
| `/flex/portfolio` | expected | 0.900 | bug 6, title, canonical, footer | |
| `/projects/bad-ideas-online-card-game` | expected | 0.947 | og:image crop, Sanity CDN, footer | |
| `/projects/squid-games-nerf-gun` | expected | 0.998 | og:image crop, image ±3 px, Sanity CDN, 3 pending Mux videos, Mux, footer, height | |
| `/projects/mazda-key-holder` | expected | 0.997 | og:image crop, image ±3 px, Sanity CDN, Mux, footer, height ±4 px | |
| `/projects/sba-power-badge` | expected | 0.997 | og:image crop, image ±3 px, Sanity CDN, Mux, footer, height ±4 px | |
| `/projects/simon-malls-mills-outlets` | expected | 0.995 | og:image crop, Sanity CDN, footer | |
| `/projects/exploring-your-hinge-data` | expected | 0.936 | og:image crop, footer | |
| `/projects/v2-of-mobile-app-for-ios-and-andriod` | expected | 0.996 | og:image crop, image ±3 px, Sanity CDN, 10 pending Mux videos, Mux, footer, height | |
| `/projects/rocket-powered-high-heels` | expected | 0.950 | og:image crop, footer | |
| `/projects/cnc-stage-design` | expected | 0.933 | og:image crop, Sanity CDN, footer | |
| `/projects/venmo-me-graduation` | expected | 0.943 | og:image crop, Sanity CDN, footer | |
| `/projects/simple-css-based-calculator` | expected | 0.941 | og:image crop, footer | |
| `/projects/basic-contact-form-with-validation-and-animations` | expected | 0.936 | footer | |
| `/projects/parametric-picture-frames-to-sell-on-etsy` | **unexpected** | 0.895 | og:image crop, footer | technology order (finding 1) |
| `/flex/blog` | expected | 0.900 | bug 6, title, canonical, footer | |
| `/blog/interview-practice` | expected | 0.995 | Sanity CDN, footer | |
| `/blog/deploying-django-to-app-engine-with-github-actions` | expected | 0.999 | Sanity CDN, footer | |
| `/blog/react-native-animations-example` | expected | 0.997 | Sanity CDN, footer | |
| `/blog/added-support-for-3d-models-in-blog-post` | expected | 0.996 | Sanity CDN, footer | |
| `/blog/bluetooth-low-energy-ble-with-react-native-and-arduino` | expected | 1.000 | description (bug 2), og:image crop, image ±3 px, Sanity CDN, 3 pending Mux videos, Mux, footer, height | |
| `/blog/creating-zip-files-with-javascript` | expected | 0.997 | description (bug 2), og:image crop, Sanity CDN, footer | |
| `/blog/ios-universal-links-with-expo-react-navigation-and-react-native` | expected | 0.999 | Sanity CDN, 3 pending Mux videos, Mux, footer, height | |
| `/blog` | expected | 0.994 | image ±3 px, Sanity CDN, footer, height ±4 px | |
| `/projects` | expected | 0.993 | Sanity CDN, footer | |
| `/projects?project_type=CLI` | expected | 0.991 | Sanity CDN, footer | |
| `/projects?project_type=PER` | expected | 0.986 | Sanity CDN, footer | |
| `/projects?medium=Web` | expected | 0.987 | Sanity CDN, footer | |
| `/projects?technologies=React+Native` | expected | 0.989 | Sanity CDN, footer | |
| `/screen` | expected | 0.920 | Sanity CDN, footer | |
| `/ascii` | expected | 0.997 | footer | |
| `/start-a-project` | expected | 0.982 | footer | |
| `/resume` | same | 1.000 | | |
| `/resume/pdf` | same | 1.000 | | |
| `/sitemap.xml` | expected | | base URL, lastmod (bug 4) | |
| `/robots.txt` | same | | | |
| `/about` | expected | | 308 to `/` (plan §7.1) | |
| `/portfolio` | same | | both end on `/projects` | |
| `/info` | same | | both end on `/` | |
| `/admin` | expected | | 307 to the Studio (plan §7.1) | |
| `/?utm_source=test` | expected | 1.000 vs new `/` | bug 3 | |
| `/blog/does-not-exist` | expected | | 404 (bug 5) | |
| `/projects/does-not-exist` | expected | | 404 (bug 5) | |
| `/blog/add-a-background` | **unexpected** | | Wagtail redirect now a 308 | destination returns 404 (finding 2) |
| `/blog/bluetooth-low-energy-ble-with-react-native` | expected | | Wagtail redirect now a 308, destination 200 | |
| `/blog/creating-zip-files-in-browser-with-javascript` | expected | | Wagtail redirect now a 308, destination 200 | |
| `/blog/universal-links-with-expo-react-navigation-and-react-native` | expected | | Wagtail redirect now a 308, destination 200 | |

Text similarity is the word-level ratio of the visible text. It is below 1 on every page with the
site footer because of the footer credit (`/resume` and `/resume/pdf` have no footer and score 1). Short pages score lower for the same few words. Every differing hunk on the
expected routes is the footer.

These were identical on every page route (apart from the two unexpected rows): `<title>` (except the
flex pages), meta description (except the 2 posts below), og:image presence, canonical (except
flex), robots meta, h1, the full heading list with ids and text, every heading anchor of the old
page (59 anchors on 10 pages, all resolve on the new page), image count, broken images (none), YouTube iframe `src` (same
ids and start times), Disqus presence, code block count, code text and line numbers, STL canvas
count, STL load errors (none), internal links (same multiset), external links (apart from the
footer and the Wagtail asset URLs, which now point at `cdn.sanity.io`), horizontal scroll at 390 px
(none), testimonial name and ASCII characters, and the console (no site errors on either width).

### Allowlisted (expected) differences

| Difference | Routes | Source |
|---|---|---|
| Footer credit reads "with Next.js and Sanity" instead of "with Django, Next.js and Wagtail"; the Django and Wagtail links become one Sanity link | every HTML page | plan §7.2 |
| Images load from `cdn.sanity.io` (and `/_next/image` of it) instead of `storage.googleapis.com/images-for-cms` | 23 | plan §7.1 |
| og:image is a 1200×630 JPEG crop from `cdn.sanity.io` instead of the GCS original; posts with an Unsplash hero keep the same Unsplash URL | 15 | WP4 deviation 5 |
| Rendered image size differs by at most 3 px (CDN rounding) | 6 | WP4 |
| Fewer videos: exactly the number of video blocks whose Mux asset doesn't exist yet (`mux-video-11` … `mux-video-29`), and the page is shorter by their height | squid-games (3), v2 mobile app (10), BLE post (3), iOS universal links post (3) | WP3b/WP4 note |
| Videos stream from Mux (`blob:` MSE source) instead of GCS files. `autoplay` is started from script (`autoPlay="muted"`), so the attribute is false; playback is verified below | 6 | plan §7.1, WP4 deviation 2 |
| Meta description is the Wagtail `search_description` (now `seo.description`) | BLE post, ZIP post | plan §7.3 bug 2 |
| Flex pages have their own `<title>` ("Portfolio/Blog - Josh Martin's Website") and canonical (`https://cjoshmartin.com/flex/<slug>`) instead of the home page's | `/flex/*` | WP4 deviation 4 |
| The old flex pages crash ("This page couldn't load", React error 441) without a Referer header; the new ones render. The old site was crawled with `Referer: https://www.cjoshmartin.com/` to get a comparable page | `/flex/*` | plan §7.3 bug 6 |
| `/?utm_source=test` crashes on the old site; on the new one it is identical to `/` (every check) | `/?utm_source=test` | plan §7.3 bug 3 |
| Unknown slugs: old 200 with the crash page; new 404 with the not-found page | 2 | plan §7.3 bug 5 |
| Sitemap URLs use `https://cjoshmartin.com` (was `https:/cjoshmartin.com`); `lastmod` equals each document's `_updatedAt`; same 21 paths; no flex pages | `/sitemap.xml` | plan §7.3 bug 4 |
| `/about` is a 308 to `/` (the old page went to `/flex/about` in the browser, which crashes); `/admin` is a 307 to `https://cjoshmartin.sanity.studio/` (was `backend.cjoshmartin.com/admin`) | 2 | plan §7.1 |
| The 4 Wagtail redirects are 308s to their target (the old frontend ignored them and showed the crash page, React error 441, status 200) | 4 | WP3 (Sanity redirect documents) |

The plan's bug 1 (unlisted pages hidden from lists) produced no difference, because no live page is
unlisted: all 20 published posts and projects have `isUnlisted: false`.

## Interactive checks (new site, 1440 px and 390 px)

From `interactive-results.json`, over the 22 page routes that have videos, STL models, YouTube
embeds, testimonials or Disqus:

| Check | Result |
|---|---|
| Mux videos | **20 of 20 play** (the 10 rendered videos at both widths: squid-games 5, mazda-key-holder 1, sba-power-badge 4). Each one is scrolled into view and reaches the playing state (not paused, `currentTime` > 0.5 s, `readyState` ≥ 3) within 1 s, from a `blob:` MSE source (Mux HLS). All are muted, looping, inline and have controls. At 390 px they play inline. The 19 pending videos render nothing, as expected. |
| STL models | **6 of 6 render** (mazda-key-holder 1, 3D-models post 2, at both widths). Each canvas capture has 96 to 457 distinct colours, and two captures 1.5 s apart differ, so the model is drawn and rotating. The `.stl` files load from `cdn.sanity.io/files`. Captures are in `interactive/`. |
| YouTube | **18 of 18 embeds load** the player with the right video title and no player error. After a click in the middle of the embed, 16 of 18 play. The two that don't are the third embed on `/blog/interview-practice` at both widths, and the same click doesn't start it on the old site either (old site: 8 of 9 play, the same one fails), so this is YouTube's behaviour in headless Chrome, not the page's. |
| Testimonial ASCII art | **8 of 8** shown testimonials (home, `/?utm_source=test`, `simon-malls-mills-outlets`, `v2-of-mobile-app-for-ios-and-andriod`, at both widths) render 525 coloured spans whose colour and character sequence is identical to the testimonial's `asciiArt` in Sanity **and** to the old site's art (live API snapshot). |
| Hover / touch reveal | **8 of 8**: hovering (1440 px) or touching (390 px) the art fades it to opacity 0 and the photo to 1; the photo loads from `cdn.sanity.io`; leaving restores the art. |
| Rotation | On `/` the first testimonial (Andy Fate) is replaced by a different one after 32 s, with its own 525-span art. |
| Disqus | **20 of 20** posts and projects load the same thread as the old site: identical `t_i` (the Wagtail page id, e.g. 13 for interview-practice), `t_u` (`https://cjoshmartin.com/blog/<slug>`, also for projects, as before) and `t_t`. |
| Console | No errors from the site, Sanity or Mux on any page at either width. The only errors are third-party and also happen on the old site: Plausible's script host fails TLS, Disqus calls the removed `document.browsingTopics()` and its ad partners answer 451, and YouTube logs permissions-policy and ad-fetch errors. |

## Live Function check (staging)

`node src/function-check.mjs --id testimonial-5 --donor testimonial-7` on dataset `staging`
(2026-11-25 21:43 UTC):

1. Checked that `testimonial-5` had no draft and that its art was current
   (`asciiArtSource` = `image-5893cbb9…-347x347-jpg`).
2. Changed only `image.asset._ref` to `testimonial-7`'s photo (`image-036abc64…-259x259-jpg`).
   `asciiArt` and `asciiArtSource` were regenerated **after 2.2 s**, and the new art is
   byte-identical to the art already stored for that photo on `testimonial-7`.
3. Put the original `image` object back. The original art came back **after 2.1 s**,
   byte-identical.
4. The final document equals the original in every field except `_rev` and `_updatedAt`.

The Function log (`sanity functions logs testimonial-ascii-art`) shows exactly two invocations for
these two edits, both successful, and no loop:
`testimonial-5: asciiArt 35x15 from a full-size source, asciiArtSource image-036abc64…` and
`… asciiArtSource image-5893cbb9…`.

## Findings

1. **Technology order on one project (low).** `/projects/parametric-picture-frames-to-sell-on-etsy`
   shows "Technologies: Fusion 360, cricut"; the live site shows "cricut, Fusion 360". The
   transform (`migration/wagtail-to-sanity/src/transform/documents.ts`, `tagRefs(revision.tags…)`)
   takes the order from the export's revision JSON, which lists tags in a different order than
   Wagtail's tag through-table (`blog.technologiespagetag` pk 301 cricut, 302 Fusion 360, which is
   what the live API returns). Every other live page has the same tag order as before. Fix: swap the
   two references on `project-43`, or order tags by through-table pk in the transform and re-run it.
2. **Wagtail redirect to a never-published post (low).** `/blog/add-a-background` now answers 308
   to a blog post that was never published in Wagtail (page 17, draft-only in Sanity), so it ends in
   a 404 (`redirect-1`). On the old site the path showed the crash page with status 200, so this is
   not worse, but the redirect does nothing useful until that post is published. Options: delete
   `redirect-1`, or keep it and publish the post.

### Pre-existing issues (same on the old site, not caused by the migration)

- `/resume` and `/resume/pdf` link `font/charter-font.css` relatively; it 404s on both sites, so the
  Charter font never loads. `/resume` also links an `http://` favicon (mixed content on HTTPS).
- `plausible.technicalchicago.com/js/plausible.js` fails with `ERR_SSL_PROTOCOL_ERROR` on every page
  of both sites, so Plausible analytics is not recording.
- `/projects/squid-games-nerf-gun` has a content link `href="#https://pypi.org/project/face-recognition/"`
  (a leading `#`), broken on both sites.
- Disqus throws `document.browsingTopics() is deprecated` and its ad partners log 451/DNS errors, on
  both sites.

### Notes for the manual tests (plan §12)

- Test 10 expects an STL model and testimonials on "Squid Games Nerf Gun". The live page has
  neither; the STL viewers are on `/projects/mazda-key-holder` and
  `/blog/added-support-for-3d-models-in-blog-post`, and the project testimonials are on
  `simon-malls-mills-outlets` and `v2-of-mobile-app-for-ios-and-andriod`.
- `/resume/pdf` is an HTML page with a "save as PDF" prompt on both sites, not a PDF file.
- The home screenshots show different testimonials on the two sides: the full-page capture runs
  after the 30-second rotation, which picks at random. The extracted data compares the first
  testimonial, which is the same.

## How to reproduce

```sh
cd migration/verify && npm ci && npm test
# new site on :3000 built against production (see README), then:
node src/crawl.mjs && node src/report.mjs && node src/interactive.mjs
set -a; . ~/cjoshmartin-migration/secrets.env; set +a
node src/function-check.mjs --id testimonial-5 --donor testimonial-7
```

Outputs (outside git) in `~/cjoshmartin-migration/reports/parity/`: `index.html` (every check per
route, the interactive results, and side-by-side screenshots at 1440 and 390 px), `summary.md`, `parity-results.json`, `interactive-results.json`,
`interactive/` (STL canvas captures), `raw/` (per-route observations), `shots/` (162 screenshots),
`function-check.json`, `function-check.log`, `function-logs.txt`, `crawl.log`, `interactive.log`.
