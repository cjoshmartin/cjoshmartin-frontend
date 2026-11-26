# Morning report: Wagtail → Sanity migration

Written 2026-11-26 at about 01:05 UTC, at the end of the overnight run. The plan is
[`../sanity-migration-plan.md`](../sanity-migration-plan.md).

## Overall status

**Everything in the plan has been built, deployed to a Vercel Preview and verified. It is not
ready to merge yet, for two reasons:**

1. **19 of the 29 videos are missing (high).** Mux's free plan refuses more than 10 assets. Plan
   §11 validation passes 9 of 12 checks on both datasets, and every one of the 39 failures is one
   of these 19 videos. You need to switch Mux to Pay as you go and run one command per dataset
   (morning step 2), or explicitly accept the gap.
2. **The backup workflow cannot authenticate to Google Cloud as written (high, found tonight).**
   This repository's canonical name is now `cjoshmartin/cjoshmartin-frontend`. The `cjoshmartin-com/...`
   path only redirects; the GitHub API reports `full_name` `cjoshmartin/cjoshmartin-frontend`,
   owner type User, with the same id `737918690`. `scripts/backup/setup-gcp.sh` sets
   `GITHUB_REPO="cjoshmartin-com/cjoshmartin-frontend"`, so its Workload Identity provider admits
   only `assertion.repository == 'cjoshmartin-com/cjoshmartin-frontend'`. GitHub's OIDC token
   carries the canonical `owner/name`, so the condition and the `principalSet` binding will
   never match. Change that one line before you run the script (morning step 6). It is not a
   merge blocker for the site itself.

The PR is open as a **draft**: <https://github.com/cjoshmartin/cjoshmartin-frontend/pull/6>.
The Vercel Preview built successfully and reads the `production` dataset.

## URLs

| What | URL |
|---|---|
| Pull request (draft) | <https://github.com/cjoshmartin/cjoshmartin-frontend/pull/6> |
| Vercel Preview, branch alias (always the newest build of `sanity-migration`) | <https://cjoshmartin-frontend-git-a08979-josh-martins-projects-0186b4e9.vercel.app> |
| Vercel Preview, the deployment verified tonight (commit `99782e2`) | <https://cjoshmartin-frontend-yzt76txct-josh-martins-projects-0186b4e9.vercel.app> |
| Vercel inspector for that deployment | <https://vercel.com/josh-martins-projects-0186b4e9/cjoshmartin-frontend/6pQa2M4eRaupPktDsVcqTBaLgtg7> |
| Studio | <https://cjoshmartin.sanity.studio> (redirects to the Sanity Dashboard, <https://www.sanity.io/@opn7xage4/studio/uihrx4okiju6hmbteqql9b8u>) |
| Studio, production workspace | <https://cjoshmartin.sanity.studio/production> |
| Studio, staging workspace | <https://cjoshmartin.sanity.studio/staging> |
| Old site (unchanged, still Wagtail) | <https://www.cjoshmartin.com> |

**The Preview is behind Vercel Authentication.** `curl` of both Preview URLs gets
`302` to `https://vercel.com/sso-api?...` (the project's protection is "Standard": production
deployment URLs and all previews). Open it in a browser where you are logged in to Vercel. No
protection bypass secret exists on the project, and none was created, so the agent could not
fetch pages from the Preview itself (see "Not verified tonight").

## Package status

| Package | Status | Report |
|---|---|---|
| WP1 Schema and Studio | done | [wp1-studio.md](reports/wp1-studio.md), [schema-contract.md](schema-contract.md) |
| WP2 ASCII generator and Function | done | [wp2-ascii.md](reports/wp2-ascii.md), [ascii-comparison.html](reports/ascii-comparison.html) |
| WP3a Migration into staging | partial (19 videos, Mux plan) | [wp3-migration.md](reports/wp3-migration.md) |
| WP3b Migration into production | partial (19 videos, Mux plan) | [wp3-migration.md](reports/wp3-migration.md), section "Production import (WP3b)" |
| WP4 Frontend rewrite | done | [wp4-frontend.md](reports/wp4-frontend.md) |
| WP5a Backup tooling | done | [wp5-backups.md](reports/wp5-backups.md) |
| WP5b Backup end-to-end and restore test | done | [wp5-backups.md](reports/wp5-backups.md), WP5b section |
| WP6 Decommission preparation (dry-run only) | done | [wp6-decommission.md](reports/wp6-decommission.md), [scripts/decommission/README.md](../../scripts/decommission/README.md) |
| WP7 Verification against the old site | done | [wp7-verification.md](reports/wp7-verification.md) |
| WP8 Independent review | done (verdict: not ready to merge) | [wp8-review.md](reports/wp8-review.md) |
| Fix round 1 | partial (videos and Plausible blocked outside the repo) | [fixes.md](reports/fixes.md), round 1 |
| Recheck 1 | done | [fixes.md](reports/fixes.md), [wp8-review.md](reports/wp8-review.md), round 2 |
| Fix round 2 | partial (same two blockers) | [fixes.md](reports/fixes.md), round 2 |
| Recheck 2 | done (R2-3 and R2-4 confirmed fixed) | its open items are in "Unresolved findings" below |
| Ship (PR, Preview, this report) | done | this file |

## Key numbers

### Documents (production and staging are identical)

Read with the Viewer token in the raw perspective at 01:00 UTC. `npm run compare` reports the two
datasets identical (221 of 221 ids, byte-identical NDJSON).

| Type | Published | Drafts |
|---|---|---|
| `homePage` | 1 | 0 |
| `flexPage` | 2 | 0 |
| `project` | 13 | 3 |
| `blogPost` | 7 | 16 |
| `person` | 1 | 0 |
| `testimonial` | 9 | 0 |
| `service` | 5 | 0 |
| `medium` | 8 | 0 |
| `technology` | 27 | 0 |
| `redirect` | 3 | 1 |
| `mux.videoAsset` | 10 (all `ready`) | 0 |
| **Documents** | **86** | **20** |
| `sanity.imageAsset` | 110 | |
| `sanity.fileAsset` | 5 | |

- 106 documents, 115 assets and 12 system documents in each dataset. There are no release
  versions and no `secrets.*` documents yet.
- The 20 drafts are unpublished Wagtail pages or pending changes, plus `drafts.redirect-1` (a
  Wagtail redirect whose target page was never published). None of them is visible on the site
  without Draft Mode.
- Tag merges: 0 (no duplicates by case or whitespace).

### Files and videos

- **Assets.** 116 bucket content files (videos excluded) became 115 distinct assets (110 images, 5
  files, including the 3 STL files and 2 resume PDFs).
  - 111 hashes equal Wagtail's `file_hash`, and 5 differences are explained: 4 objects were
    overwritten in the bucket after Wagtail recorded their hash, and 1 file is missing.
  - Only image 3 matters: its 2784x1798 original is gone, and the live site already shows the
    replacement.
  - All 115 production binaries were downloaded and their sha1 checked.
- **Mux.** 10 of 29 videos are on Mux, all `ready`, basic quality, passthrough `wagtail-media-1`
  to `-10`. Media 11–29 are refused: `400 "Free plan is limited to 10 assets"`.
- **ASCII art.** 9 of 9 testimonials are byte-identical to the live site. The
  `testimonial-ascii-art` Function is deployed (Blueprint stack `ST-jc4gwa3c4t`), and its live
  checks on staging passed in WP2 and WP7.

### Validation (plan §11), both datasets, last run 00:52 UTC

| Check | Result |
|---|---|
| counts | **fail**: `mux.videoAsset` 10 of 29 |
| assets | pass |
| hashes | pass (111 equal, 5 explained) |
| references | **fail**: 19 of 250 unresolved, all `mux-video-11` to `-29` |
| keys | pass (784 arrays) |
| portableText | pass (581 blocks, 729 spans) |
| textParity | pass (291 rich-text values and StreamField blocks) |
| fieldParity | pass (938 fields) |
| mux | **fail**: 10 of 29 ready |
| asciiArt | pass (9 of 9 byte-identical) |
| convergence | pass |
| studioValidation | pass (`sanity documents validate`: 0 errors; 48 warnings: 2 SEO descriptions over 160 characters, 46 Mux "unknown field") |

### Builds and tests (latest runs)

| What | Result |
|---|---|
| Vercel Preview build of `99782e2` | Ready (Next.js 16.3.4, 18 routes plus the proxy). The GitHub "Vercel" check on the PR passes |
| Frontend `npm run lint` / `tsc --noEmit` / `npm test` | 0 errors (2 old warnings) / clean / 13 of 13 |
| Local `next build` of HEAD against production, plus route smoke test | passes; 40 of 40 requests as expected (recheck 2) |
| Migration `npm test` / typecheck | 55 of 55 / clean |
| ASCII Function `npm test` | 65 of 65 |
| Backup `npm test` / GCS emulator test | 58 of 58 / 2 of 2 |
| Decommission `test/run.sh` | 93 of 93 |
| Parity classifier `npm test` | 14 of 14 |
| Studio `sanity build`, schema validate and deploy | pass, 0 errors and 0 warnings (WP1) |

### Backups (WP5b, local storage target)

- **Production backup.** Snapshot `20261125T222817Z` holds 233 documents and 115 assets (124,486,220
  bytes, each verified by sha1). It also holds 10 Mux originals (111.82 MiB), checked with
  `ffprobe`.
- **Second run.** It reported "No changes" and wrote nothing.
- **Restore into staging.** `--exact --verify` passed after two restore bugs were fixed (`8df2641`).
  221 of 221 documents are identical, and all 115 binaries are byte-identical.
- **Change detection on staging.** A one-field edit wrote only 3 snapshot files, and a new image
  wrote only that image plus 3 snapshot files. A point-in-time restore and a release round trip
  both worked.
- **Still to do.** The real GCS run happens after `setup-gcp.sh` (tests H32–H36).

## Parity with the old site

The latest crawl (fix round 2, commit `8911387`) compared 47 routes of the live Wagtail site with
a local production build of this branch at 1440 px and 390 px. The only commit after that
changes documentation. Result: **3 the same, 44 with expected differences only, 0 unexpected.**
The report with screenshots is local: `~/cjoshmartin-migration/reports/parity-fixes-r2/index.html`.

Interactive checks on the new site (WP7, repeated in round 1):
- Mux videos: 20 of 20 play, muted, looping and inline, with controls.
- STL models: 6 of 6 draw and rotate.
- YouTube: 18 of 18 load, and 16 play. The same 2 do not play on the old site either.
- Testimonial art: 8 of 8 match Sanity and the old site. The hover reveal and the 30 s rotation
  work.
- Disqus: 20 of 20 load the same thread as the old site.
- Console: no errors from the site, Sanity or Mux.

**Every remaining difference** (all classified as expected):

| Difference | Where | Why |
|---|---|---|
| 19 videos render nothing, so the pages are shorter | `/projects/squid-games-nerf-gun` (3 of 8), `/projects/v2-of-mobile-app-for-ios-and-andriod` (10 of 10), `/blog/bluetooth-low-energy-ble-with-react-native-and-arduino` (3), `/blog/ios-universal-links-with-expo-react-navigation-and-react-native` (3) | Mux free plan (blocker 1) |
| og:image is a 1200x630 JPEG crop from `cdn.sanity.io` | every page with an image | images moved to Sanity (WP4 deviation 5) |
| Images come from `cdn.sanity.io`; some renditions are 1 px taller | most pages | Sanity CDN rounding versus Wagtail renditions (±3 px allowed) |
| Videos stream from Mux (HLS); playback starts from script, not the `autoplay` attribute | pages with videos | plan §7.1; playback verified interactively |
| Footer credit says Next.js and Sanity instead of Django and Wagtail | every page | plan §7.2 |
| Flex pages have their own `<title>` and canonical; the old ones crashed without a Referer | `/flex/portfolio`, `/flex/blog` | bug 6, WP4 deviation 4 |
| Meta description is the Wagtail search description | `/blog/bluetooth-low-energy-ble-with-react-native-and-arduino`, `/blog/creating-zip-files-with-javascript` | bug 2 |
| `/?utm_source=test` renders the home page (the old site crashed) | `/?utm_source=test` | bug 3 |
| Sitemap base is `https://cjoshmartin.com`; `lastmod` is `_updatedAt` (the import time until edited) | `/sitemap.xml` | bug 4 |
| Unknown slugs answer 404 (the old site answered 200 with a crash page) | `/blog/does-not-exist`, `/projects/does-not-exist` | bug 5 |
| `/about` is a 308 to `/`; `/admin` is a 307 to the Studio | `/about`, `/admin` | plan §7.1 |
| The 3 published Wagtail redirects now work (308); the old frontend ignored them | `/blog/bluetooth-low-energy-ble-with-react-native`, `/blog/creating-zip-files-in-browser-with-javascript`, `/blog/universal-links-with-expo-react-navigation-and-react-native` | migrated `redirect` documents |
| `/blog/add-a-background` is a plain 404 | that path | its target page was never published, so `redirect-1` is a draft (R1-2) |
| The Squid Games `face_recognition` link goes to PyPI instead of a dead `#https://...` fragment | `/projects/squid-games-nerf-gun` | content fix R1-5 |
| The resume's Charter fonts load, so the text reflows | `/resume`, `/resume/pdf` | R1-3 |
| Technology order on parametric picture frames is now "cricut, Fusion 360", like the old site | that project | R1-1 (this matches the old site now) |

## Unresolved findings

| # | Severity | Finding | What to do |
|---|---|---|---|
| 1 | high | 19 of 29 videos missing (R1-6, R2-1). Mux still lists exactly 10 assets (rechecked 00:37 UTC). | Morning step 2, or accept explicitly. |
| 2 | high | **New:** the backup's Workload Identity condition names `cjoshmartin-com/cjoshmartin-frontend`, but the repo is now `cjoshmartin/cjoshmartin-frontend` (same id `737918690`). `scripts/backup/README.md`, the WP5 report, and the plan's §2 and §10 use the old name too. | In `scripts/backup/setup-gcp.sh` set `readonly GITHUB_REPO="cjoshmartin/cjoshmartin-frontend"`, update the README line, then run it. The `repository_id` check stays as it is. Also run the printed `gh variable set` and `gh secret set` commands with `--repo cjoshmartin/cjoshmartin-frontend`. |
| 3 | high (owner decision, WP6 F1) | `gs://images-for-cms` grants `allAuthenticatedUsers` `roles/storage.admin` and `roles/storage.objectUser`. Any Google account can change its IAM or delete objects today. | Remove now without breaking the live site: `scripts/decommission/04-gcs-lockdown.sh --authenticated-users-only --execute` (after `gcloud auth login` as owner). Not run tonight: bucket permissions were out of scope. |
| 4 | high (owner decision, WP6 F2) | A private GitHub repo `cjoshmartin-com/backend.cjoshmartin.com` already holds the unscrubbed backend history, with `secrets.json` at `main` HEAD. The plan assumed no GitHub copy. | Decide whether to delete or archive it after the scrubbed archive is verified. Revoking the keys (teardown step 6) makes the leaked key useless either way. |
| 5 | high (owner decision, WP6 F3) | A second leaked key, for `fileuploads@com-cjoshmartin`, is outside D11. | Add `--include-legacy-sa` to `04-gcs-lockdown.sh --execute` if you agree. |
| 6 | low (WP6 F5) | 4 local stashes in `~/code/cjoshmartin.com/cjoshmartin-backend` contain key files. | `git stash clear` there when you no longer need them. |
| 7 | low | Plausible analytics fails TLS on every page (R1-4, R2-2): `plausible.technicalchicago.com` (49.13.164.251) ends the handshake with alert 80, and HTTP returns 503. The same is true on `main` today. | Fix the Plausible server. Nothing in this repo changes. |
| 8 | low | `npm run migrate -- --steps baseline,import` with no import record is refused before `baseline` runs (recheck 2). It fails safe, and it cannot happen today because both datasets have records. | Run `--steps baseline` on its own first if a record is ever missing. |
| 9 | medium | `secrets.mux` does not exist in either dataset. The Studio's Videos tool needs the Mux token, and test 30 depends on it. Once it is saved, backups (private bucket) contain it, because the Viewer token can read `secrets.*`. | Morning step 3. |
| 10 | low | The credentialed CORS and Presentation origin `https://cjoshmartin-frontend-*-josh-martins-projects-0186b4e9.vercel.app` also matches previews built from fork PRs. Git fork protection is on (checked tonight). | Keep Vercel's Git fork protection on. |
| 11 | low | The Preview env vars are scoped to the `sanity-migration` branch only. After the merge, previews of other branches fail with `Missing environment variable: NEXT_PUBLIC_SANITY_PROJECT_ID` until Preview (all branches) variables exist. | Morning step 5 adds Production. Add the same 4 for all Preview branches when you next need a preview. |
| 12 | low | The Vercel env var `API_URL` (Production, Preview, Development) is no longer read by the app. | Remove it after the teardown if you like: `vercel env rm API_URL`. |
| 13 | low, pre-existing content | Testimonial 4 shows the literal text `Josh&#x27;s`, as on the live site today. Two published posts have SEO descriptions over 160 characters (a Studio warning). Image 3's original bytes are gone from the bucket. | Edit in the Studio if you want. |
| 14 | low | About 473 MB of local test backups (`~/cjoshmartin-migration/backup-test/production`, `backup-test/staging-changes`, `tmp/wp5-local-bucket`), plus `tmp/recheck-r2/datadir-norecord`, which an agent could not delete. | `rm -rf ~/cjoshmartin-migration/backup-test/production ~/cjoshmartin-migration/backup-test/staging-changes ~/cjoshmartin-migration/tmp/wp5-local-bucket ~/cjoshmartin-migration/tmp/recheck-r2/datadir-norecord` after review. |
| 15 | info | Pushing printed: "GitHub found 63 vulnerabilities on cjoshmartin/cjoshmartin-frontend's default branch (7 critical, 15 high, 34 moderate, 7 low)". That is Dependabot's count for `main`, not for this branch. | Review Dependabot separately. |

## Blocked steps (exact commands)

| Step | Command | Why |
|---|---|---|
| Migrating media 11–29 (WP3a, WP3b, fix rounds 1 and 2) | `npm run migrate -- --dataset staging --steps mux` (in `migration/wagtail-to-sanity`), which makes `POST https://api.mux.com/video/v1/assets` | `400 {"error":{"type":"invalid_parameters","messages":["Free plan is limited to 10 assets"]}}`. Upgrading Mux needs your billing method |
| Listing service-account keys (WP6 dry-run of `04` and `05` row 39) | `gcloud iam service-accounts keys list --iam-account file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com --project com-cjoshmartin --managed-by=user --format=json` (and the same for `fileuploads@com-cjoshmartin.iam.gserviceaccount.com`) | `PERMISSION_DENIED`: the active gcloud account is not the `com-cjoshmartin` owner. Resolved by your `gcloud auth login` |
| Cleanup during recheck 2 | `rm -rf /Users/josh/cjoshmartin-migration/tmp/recheck-r2/datadir-norecord` | Refused by the shell safety check. The folder is harmless (finding 14) |
| Secret scan during fix round 1 | a zsh loop using `${(P)v}` | Refused by the shell safety check. It was rerun as a Python scan, so nothing is missing |

## What this package did

1. **Repository checks.** On `sanity-migration`, `git status` was clean and all reports were
   present. `gitleaks git` over the 33 branch commits found no leaks. Every tracked file and the
   full branch patch history were scanned for the exact values of the four `secrets.env` tokens
   and the `.env.local` read token: 0 matches. A token-pattern scan of added lines found only false
   positives (base64 test fixtures, lockfile integrity hashes, and a sentence in the WP6 report).
2. **Vercel.** Linked the repo to project `cjoshmartin-frontend` (`.vercel/` is gitignored).
   `vercel link` also appended a `VERCEL_OIDC_TOKEN` line to `.env.local` and `.env*` to
   `.gitignore`. Both were put back exactly as they were (`.gitignore` matches `HEAD`, and
   `.env.local`'s sha256 matches the backup taken before the link). Added 4 variables to
   **Preview only, scoped to the `sanity-migration` branch**, with values piped through stdin:
   - `NEXT_PUBLIC_SANITY_PROJECT_ID=j3vdh6ti`
   - `NEXT_PUBLIC_SANITY_DATASET=production`
   - `NEXT_PUBLIC_SANITY_STUDIO_URL=https://cjoshmartin.sanity.studio`
   - `SANITY_API_READ_TOKEN` (the Viewer token, stored as sensitive)

   A scoped `vercel env pull` confirmed the three public values. The token is sensitive, so it
   cannot be read back; the successful build confirms the build-time values only. No Production or
   Development variable was touched. The existing `NEXT_PUBLIC_POSTHOG_*` and `API_URL` variables
   are unchanged.
3. **Push, Preview and PR.** Pushed `sanity-migration` to origin. The first Preview build
   (`cjoshmartin-frontend-lt99us6mw-…`) ran before the variables could exist, because Vercel only
   accepts a branch-scoped variable once the branch is on GitHub. It failed with
   `Error: Missing environment variable: NEXT_PUBLIC_SANITY_PROJECT_ID` while loading
   `next.config.ts`. A `vercel redeploy` of the same commit with the variables
   (`cjoshmartin-frontend-yzt76txct-…`) built in about 90 s and is Ready. Opened draft PR #6 with the
   summary, decisions, bug fixes, report links, morning steps and the full §12 checklist.
4. **Checks on the Preview.**
   - Both Preview hostnames get credentialed CORS from the Sanity API and `cdn.sanity.io` (checked
     with an `Origin` preflight), so SanityLive, Presentation and the STL files will work there.
   - `curl` of the Preview answers `302` to Vercel's SSO.
   - The GitHub "Vercel" status on `99782e2` is `success`.
5. **Morning report.** Wrote this file and pushed it. That push starts one more Preview build of a
   documentation-only commit; the PR's Vercel check shows its result.

### Not verified tonight

- **Pages served by the Vercel Preview.** Vercel Authentication blocks unauthenticated requests,
  and `vercel curl` would have created a project-wide "Protection Bypass for Automation" secret. That
  is a project security setting outside the pre-approved scope, so it was not done. The same
  commit was built and smoke-tested locally against production in recheck 2 (40 of 40 requests as
  expected).
- **The Presentation iframe and Disqus on the Preview domain** (tests 28 and 16). They may be
  blocked by Vercel protection or by Disqus. The plan already moves them to production right after
  merge.
- **A real GCS backup run** happens after `setup-gcp.sh` (tests H32–H36).

## Morning sequence

This is plan §13 "Morning, with you", updated with tonight's findings. Run everything from
`~/code/cjoshmartin.com/cjoshmartin-frontend` unless a step says otherwise.

### 1. Read this report

Pay most attention to the unresolved findings and the blocked steps above.

### 2. Videos (blocker 1)

Switch the Mux environment from the free plan to Pay as you go in the Mux dashboard (it needs a
billing method). Then:

```sh
cd migration/wagtail-to-sanity
npm run migrate -- --dataset staging --steps mux,videos
npm run migrate -- --dataset production --confirm-production --steps mux,videos
npm run migrate -- --dataset staging --steps validate
npm run migrate -- --dataset production --confirm-production --steps validate
npm run compare -- --datasets staging,production
```

Both validations should pass 12 of 12, and compare should report the datasets identical. The
`videos` step only adds the missing `mux.videoAsset` documents; it never touches Studio edits.
If you decide not to upgrade, say so on the PR; the 19 videos then stay missing on the 4 pages
listed above.

### 3. Mux token in the Studio

Open <https://cjoshmartin.sanity.studio>, go to the **Videos** tool in each workspace (production,
then staging), and enter the Mux token from `secrets.env` once each. Test 30 needs it.

### 4. Manual tests A–G

Run the checklist on the PR (or in plan §12) on the Preview URL while logged in to Vercel.
Known corrections:
- **Test 10.** Squid Games Nerf Gun has no STL model and no testimonials, on either site. Check
  STL on `/projects/mazda-key-holder` and project testimonials on
  `/projects/simon-malls-mills-outlets`.
- **Tests 16 and 28.** These may need production (see "Not verified tonight").

### 5. Approve, add the Production env vars, and merge

Add the Production variables **before** merging. Without them, the production build fails with
`Missing environment variable`. Vercel would keep serving the old deployment, so the site would
not go down, but the merge would not go live.

```sh
set -a; . ~/cjoshmartin-migration/secrets.env; set +a
printf '%s' "$SANITY_PROJECT_ID" | vercel env add NEXT_PUBLIC_SANITY_PROJECT_ID production --no-sensitive --yes
printf '%s' production | vercel env add NEXT_PUBLIC_SANITY_DATASET production --no-sensitive --yes
printf '%s' https://cjoshmartin.sanity.studio | vercel env add NEXT_PUBLIC_SANITY_STUDIO_URL production --no-sensitive --yes
printf '%s' "$SANITY_READ_TOKEN" | vercel env add SANITY_API_READ_TOKEN production --sensitive --yes
vercel env ls production
gh pr ready 6 --repo cjoshmartin/cjoshmartin-frontend
```

Then merge PR #6 on GitHub. Right after the production deployment is live, run test 16 (Disqus)
and test 28 (Presentation) on <https://cjoshmartin.com> if Preview blocked them, then test 31.

### 6. Backups

1. **Fix the repository name (blocker 2).** In `scripts/backup/setup-gcp.sh`, change
   `readonly GITHUB_REPO="cjoshmartin-com/cjoshmartin-frontend"` to
   `readonly GITHUB_REPO="cjoshmartin/cjoshmartin-frontend"`, and update the same name in
   `scripts/backup/README.md`. Commit that on `main` (or on this branch before merging).
2. Run `! gcloud auth login` as the `com-cjoshmartin` owner, then
   `gcloud config set project com-cjoshmartin`.
3. Review, then run:

   ```sh
   scripts/backup/setup-gcp.sh --print-only
   scripts/backup/setup-gcp.sh
   ```

   It creates `gs://cjoshmartin-sanity-backups`, the `sanity-backup` service account, and the
   Workload Identity pool and provider.
4. Run the `gh variable set` and `gh secret set` commands it prints. The variables are
   `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_BACKUP_SERVICE_ACCOUNT`, `BACKUP_BUCKET` and
   `SANITY_PROJECT_ID`. The secrets are `SANITY_BACKUP_TOKEN`, `MUX_TOKEN_ID` and
   `MUX_TOKEN_SECRET`.
5. Run tests H32–H36. The workflow only authenticates from `main`, so this is after the merge. The
   first backup after any restore always writes a new snapshot.

### 7. Teardown, only after your go-ahead

Prerequisites (from `scripts/decommission/README.md`):
- tests A–H pass
- the site serves from Sanity
- backups work
- `gcloud` is logged in as the owner, and `gh` as an admin of `cjoshmartin-com`
- for step 6 only, all 29 videos are on Mux; `04` checks this itself and refuses otherwise

Run each script as a dry-run first, read it, then repeat it with `--execute`.

1. **You:** export the final Postgres dump.

   ```sh
   scripts/decommission/03-dokku-teardown.sh export
   scripts/decommission/03-dokku-teardown.sh --execute export
   ```

   This is the same as `ssh dokku@159.203.93.178 postgres:list`, then
   `postgres:export <svc> > ~/cjoshmartin-migration/final/wagtail-final.dump`.
2. **Claude:** copy the archive into the backup bucket.

   ```sh
   scripts/decommission/01-archive-to-backup-bucket.sh ~/cjoshmartin-migration/final/wagtail-final.dump
   scripts/decommission/01-archive-to-backup-bucket.sh --execute ~/cjoshmartin-migration/final/wagtail-final.dump
   ```

3. **Claude:** publish the scrubbed backend repo as a private, archived repo
   (`cjoshmartin-com/cjoshmartin-backend-archive`).

   ```sh
   scripts/decommission/02-push-backend-archive.sh
   scripts/decommission/02-push-backend-archive.sh --execute
   ```

4. **You, or Claude with permission:** destroy the Dokku app and its database. It asks you to
   type the app name.

   ```sh
   scripts/decommission/03-dokku-teardown.sh destroy
   scripts/decommission/03-dokku-teardown.sh --execute destroy
   ```

5. **You:** in GoDaddy, delete only the record Type A, Name `backend`, Value `159.203.93.178`.
   The click-by-click steps are in the decommission README, step 5. Then check:

   ```sh
   dig +short @ns31.domaincontrol.com backend.cjoshmartin.com A
   ```

6. **Claude:** make `images-for-cms` private and revoke the leaked key.

   ```sh
   scripts/decommission/04-gcs-lockdown.sh
   scripts/decommission/04-gcs-lockdown.sh --execute
   ```

   Add `--include-legacy-sa` if you agree to revoke the `fileuploads@` key too (finding 5). Then
   run `gcloud auth revoke file-upload-2024@com-cjoshmartin.iam.gserviceaccount.com` to remove this
   Mac's stale local credential.
7. **You:** run tests I (37–41).

   ```sh
   scripts/decommission/05-verify.sh --ssh
   ```

   Every row should be `PASS`. Also check test 40 once by hand:
   `gh repo clone cjoshmartin-com/cjoshmartin-backend-archive /tmp/a && git -C /tmp/a log --all -- secrets.json`
   should print nothing.

### Rollback

- **Before teardown step 4:** use Vercel Instant Rollback or revert the PR. The old frontend reads
  Wagtail again immediately.
- **After teardown step 4:** restore the archived dump into a new Dokku app and re-point DNS (slow,
  but everything is archived).
