# WP8: review findings and how they were resolved

This file lists every finding from the independent review (WP8) and from the verification reports
it collected (WP7, WP5b), and what happened to each. Later review rounds append a section. The
details of each fix and how it was verified are in [fixes.md](fixes.md).

## Round 1 (2026-11-25)

18 findings were raised. Two are duplicates (WP8 repeated WP7's findings 1 and 2), so 16 are
distinct.

| Status | Count | Findings |
|---|---|---|
| Fixed in round 1 | 10 | R1-1, 2, 3, 5, 7, 9, 10, 13, 14, 15 |
| Resolved before round 1 (WP5b) | 1 | R1-8 |
| Not a code defect: behaviour tested and documented, or housekeeping left for Josh | 3 | R1-16, 17, 18 |
| Blocked outside this repo | 2 | R1-6 (Mux plan), R1-4 (Plausible server) |

One more defect was found while fixing these (R1-19 below) and was fixed too.

### Findings

| # | Finding | Severity | Source | Resolution | Commit |
|---|---|---|---|---|---|
| R1-1 | Technology tag order differs on the parametric picture frames project | low | WP7, WP8 (twice) | **Fixed.** See note 1. | `7f04159` |
| R1-2 | Wagtail redirect `redirect-1` points at a never-published post and ends in 404 | low | WP7, WP8 (twice) | **Fixed.** A redirect whose target page is not published is now migrated as a draft (`drafts.redirect-1`), so the site no longer serves it, and it no longer reveals the draft's slug. It can be published together with the post. `/blog/add-a-background` is now a plain 404. | `7f04159` |
| R1-3 | Resume pages load a missing stylesheet, and an `http://` favicon | low, pre-existing | WP7 | **Fixed.** See note 2. | `3c4ae1b` |
| R1-4 | Plausible analytics script fails TLS on every page | low, pre-existing | WP7 | **Blocked outside this repo.** See note 3. | none |
| R1-5 | Broken link `#https://pypi.org/project/face-recognition/` on the Squid Games project | low, pre-existing | WP7 | **Fixed** through a documented content fix in the migration (`src/content-fixes.ts`). Validation lists it as explained. | `7f04159` |
| R1-6 | 19 of 29 videos missing in production; §11 validation fails (counts, references, mux) | high | WP8 | **Still blocked: Mux free plan.** See note 4. | `7f04159`, `549e2e8` |
| R1-7 | The documented Mux follow-up (full rerun on production) reverts Studio edits and deletes editor-published drafts | high | WP8 | **Fixed.** See note 5. | `7f04159` |
| R1-8 | Backup restore into staging and the end-to-end test never ran on migrated data | high | WP8 | **Resolved by WP5b** (commits `8df2641`, `9fe2642`, `aa8e7eb`), which finished after the review was written. See note 6. | none in round 1 |
| R1-9 | Open redirect in `/api/draft-mode/disable` via tab/newline | medium | WP8 | **Fixed.** The target is resolved first and must have the request's origin. `/%09/evil.com`, `/%0A/evil.com`, `//evil.com`, `/\evil.com` and absolute URLs all go to `/`. | `d925211` |
| R1-10 | GCS lockdown is not gated on pending Mux videos | medium | WP8 | **Fixed.** `04-gcs-lockdown.sh` refuses to run until production has a ready `mux-video-<id>` for each Wagtail media item and every published video block resolves. Today it refuses: 10 of 29. The README lists it as a prerequisite. | `549e2e8` |
| R1-11 | (duplicate of R1-1) | low | WP8 | See R1-1. | |
| R1-12 | (duplicate of R1-2) | low | WP8 | See R1-2. | |
| R1-13 | Image width/height ignore the Studio crop | low | WP8 | **Fixed.** Dimensions are computed from the crop rect, rounded exactly like `@sanity/image-url`'s `rect` parameter. A check against the live CDN matched for 6 crop and width combinations. | `1fc4f4a` |
| R1-14 | `restore.mjs --latest` can restore another dataset's snapshot without warning | low | WP8 | **Fixed.** The source dataset is `--from-dataset`, which defaults to the target `--dataset`. `--latest` only considers that dataset, and `--snapshot` is refused when its marker names another dataset. | `500a61f` |
| R1-15 | Testimonial `asciiArt` rendered as raw HTML | low | WP8 | **Fixed.** See note 7. | `a686e36` |
| R1-16 | Whether the Viewer backup token can read `secrets.mux` is untested | medium | WP5b | **Tested; behaviour documented.** See note 8. | `500a61f` (README) |
| R1-17 | A restore over existing documents cannot reproduce `_createdAt` | medium | WP5b | **Not a defect of the tool.** See note 9. | none |
| R1-18 | Local test backups take about 463 MB outside git | medium | WP5b | **Not a code defect; left for Josh.** See note 10. | none |
| R1-19 | *(found in round 1)* A `mux` step rerun within 24 hours of a backup would write a signed Mux download URL into the public `mux.videoAsset` documents | medium | round 1 | **Fixed.** See note 11. | `7f04159` |

### Notes

1. **Tag order (R1-1).** WP7 suggested ordering tags by the tag through-table's primary key. That
   only happens to work for page 43: on 8 other live pages the through-table order differs from
   what the old site shows (page 6, for example, has OpenCV, Python, Django, Raspberry Pi in the
   table, and the site shows Django, OpenCV, Python, Raspberry Pi). The old site showed tags in
   the order the Wagtail API returned them, which is by name, ignoring case. That rule explains
   all 23 tag lists in the live API snapshot. The export plugin had sorted names by code point
   (Python's `sorted`), which puts "Fusion 360" before "cricut". The transform now orders tags
   with `wagtailTagOrder` (case-insensitive collation). Validation checks the rule, and it also
   checks every live project's tags against the live API snapshot, independently of the rule.
   Only `project-43` changed.
2. **Resume (R1-3).** The resume HTML comes from the `cjoshmartin-com/resume` repository, and
   that repository dropped its `font/` folder in 2018. The four Charter WOFF files it used to ship
   are now served from `public/fonts/charter/`. They are under Bitstream's permissive license,
   and the notice is kept in the files and in the CSS. `app/resume/_lib/resume.ts` rewrites the
   two links to same-site paths. Both resume routes now load `charterregular` and
   `charteritalic`, with no failed requests.
3. **Plausible (R1-4).** `plausible.technicalchicago.com` resolves to `49.13.164.251`. That host
   ends every TLS handshake with alert 80 (`internal_error`) and presents no certificate, and
   plain HTTP returns 503. The Plausible instance is down or not routed, so no change in this
   repo can fix it. When the server serves TLS again, the existing script tag works unchanged.
   The fix belongs on that server, which is outside this work's permitted scope.
4. **Videos (R1-6).** Rechecked on 2026-11-25 at 23:07 UTC: Mux still answers
   `400 "Free plan is limited to 10 assets"`. Only Josh can unblock it, because the upgrade
   needs a billing method. Round 1 made the follow-up safe and the teardown order enforced:
   - the narrow `videos` step adds only the missing `mux.videoAsset` documents
     (`npm run migrate -- --dataset production --confirm-production --steps mux,videos`)
   - the GCS lockdown refuses to run until all 29 are on Mux (R1-10)

   **Before merge, this must be resolved, or Josh must accept it explicitly.** Validation of both
   datasets stays at 9 of 12 checks, and the 39 failures are all these 19 videos.
5. **Rerun safety (R1-7).** Every import now records the `_rev` and content hash of each
   migration document in `state/imported-<dataset>.json`. The next import refuses before writing
   anything if a migration document changed, was created (an opened draft, or a published copy
   of a migrated draft), was deleted, or has a release version. `--discard-studio-edits`
   overrides that on purpose. `--steps baseline` recorded both datasets, which had been imported
   before the record existed, after proving they still equal the NDJSON. The WP3 report's
   follow-up now uses `--steps mux,videos`. Tested on staging by simulating an opened draft and a
   published migrated draft: the import refused, the `videos` step left both edits alone, and
   `--discard-studio-edits` restored the dataset.
6. **Restore test (R1-8).** The WP5b section of [wp5-backups.md](wp5-backups.md) records a
   production backup with the migrated data, verified independently:
   - 233 documents, 115 assets, and 10 real Mux masters checked with `ffprobe`
   - a restore of that snapshot into staging with `--exact --verify`, which passed after two
     restore bugs were fixed in `8df2641`
   - point-in-time and release round trips

   The logs and evidence are in `~/cjoshmartin-migration/reports/wp5b/`.
7. **ASCII art (R1-15).** The field is parsed against the generator's exact markup: an optional
   wrapping `<span>`, `<span style="color: #rrggbb">c</span>`, `<br/>`, whitespace, and five
   entities. It is rendered as React elements. Anything else is rejected, logged on the server,
   and not shown. All 9 production values parse and re-serialize byte for byte. In a browser, the
   home page's art has the same DOM shape (1 wrapper, 525 colored spans, 14 `br`, 540 text
   nodes), the same color and character sequence, and the same rendered width as the old site.
   The hover reveal still works.
8. **`secrets.mux` (R1-16).** A temporary `secrets.wp8-viewer-check` document of type
   `mux.apiKey` with dummy values was created in staging. The Viewer token reads it through both
   a raw-perspective query and the Export API, and an anonymous request does not see it. It was
   deleted afterwards. So once the Mux token is entered in the Studio, every backup snapshot
   contains `secrets.mux` (in the private bucket), and a restore brings it back. The backup README
   now says so.
9. **`_createdAt` (R1-17).** Checked on staging with a throwaway document: `create` sets
   `_createdAt`, but `createOrReplace` and `patch` with `set` both leave it unchanged, without an
   error. A restore over documents that already exist therefore cannot change it without
   deleting and re-creating them. That would lose their history, fail on strongly referenced
   documents, and leave a window in which they are missing. A restore into an empty dataset
   creates every document with the snapshot's value (WP5b saw this for documents the import
   created). The site never reads `_createdAt` (no use in `app/`, `components/`, `lib/` or
   `sanity/`). The backup README already documents this, and `--verify` reports the count.
10. **Local backups (R1-18).** `~/cjoshmartin-migration/backup-test/production` (231 MB) and
    `backup-test/staging-changes` (232 MB) are WP5b's evidence, and round 1 used the second one
    to check the restore dataset rule against real snapshots. `tmp/wp5-local-bucket` (9.8 MB) is
    WP5a's. Deleting files outside Sanity, Mux and the branch is out of this work's scope, so
    they were left in place. Once the reports are reviewed, Josh can remove them with
    `rm -rf ~/cjoshmartin-migration/backup-test/production ~/cjoshmartin-migration/backup-test/staging-changes ~/cjoshmartin-migration/tmp/wp5-local-bucket`.
11. **Signed Mux URL (R1-19).** WP5b's backup run requested temporary master access on all 10
    Mux assets. For 24 hours, the asset JSON from Mux then contains `master_access: "temporary"`
    and a signed `master.url`. A `mux` step rerun in round 1 picked that up into
    `state/mux-map.json`. Had the transform run next, it would have written the URL into the
    public `mux.videoAsset.data`, and reruns would no longer converge. The `mux` step now stores
    the asset's steady state (`master_access: "none"`, no `master`). The rewritten map is
    identical to the original one, including key order.
