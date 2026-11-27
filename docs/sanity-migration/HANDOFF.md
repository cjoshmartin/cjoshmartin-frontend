# Handoff: Wagtail → Sanity migration (for the next agent)

Written 2026-11-27, when the session that did the migration was closed. Read this first, then
[`morning-report.md`](morning-report.md) (current state, findings, the owner's runbook) and
[`../sanity-migration-plan.md`](../sanity-migration-plan.md) (decisions D1–D18, model, tests).

## 1. What this is

cjoshmartin.com is moving off a Django/Wagtail CMS (Dokku app `cjoshmartin-django`,
`backend.cjoshmartin.com`, media in the public GCS bucket `images-for-cms`) to Sanity. The Next.js
frontend (Vercel) is rewritten to read Sanity. The Wagtail backend and the bucket are retired after
the owner tests and approves.

## 2. Where it stands

**All the build work is done, pushed and verified. It is waiting on the owner.** Nothing is
running in the background.

- **Branch and PR.** `sanity-migration` is pushed to origin and the working tree is clean. **Draft
  PR #6**: <https://github.com/cjoshmartin/cjoshmartin-frontend/pull/6>. `main` is untouched.
- **Vercel.** The Preview is Ready, behind Vercel Authentication. The Preview env vars are scoped to
  the `sanity-migration` branch. Production env vars are **not** set yet.
- **Sanity.** Project `j3vdh6ti`, Free plan, two **public** datasets, `production` and `staging`,
  identical in content:
  - 96 content documents: 76 published, 20 drafts;
  - 173 assets: 110 images, 29 MP4s, 29 stripped video originals, 5 other files.
- **Validation.** `npm run migrate -- --steps validate` passes 13 of 13 on both datasets.
- **History.** Both datasets were deleted and re-imported on 2026-11-26 (D18), so their public
  edit history starts at the import.
- **Studio.** <https://cjoshmartin.sanity.studio>, with workspaces `/production` and `/staging`.
  The code is in `studio/`.
- **Functions.** Four Sanity Functions are deployed: Blueprint stack `ST-jc4gwa3c4t`, configured in
  `studio/sanity.blueprint.ts`.
  - `testimonial-ascii-art`
  - `video-to-mp4`: converts every uploaded video to an H.264 MP4 and keeps the stripped original
  - `image-privacy` and `upload-privacy`: strip personal metadata from every upload and delete the
    unstripped upload once it is replaced
- **Mux.** Fully removed: 0 assets in the account. The token still authenticates; the owner
  revokes it.
- **Old site.** Still live and still served by Wagtail. **Content freeze: nobody edits Wagtail.**
- **Old bucket.** `images-for-cms` is still public. It still holds the unstripped originals, 11 of
  them with GPS, and grants `allAuthenticatedUsers` storage admin. The owner chose to fix this at
  teardown.

## 3. What happens next (owner-driven; the details are in `morning-report.md`, "Morning sequence")

1. The owner runs the manual tests A–G on the Preview, while logged in to Vercel.
2. Production env vars, then the merge (the commands are in step 4 of the morning report). Agents
   may add the vars **only when the owner asks**.
3. The revalidation webhook (step 5).
4. Backups:
   - the owner runs `! gcloud auth login` as the `com-cjoshmartin` owner;
   - then `scripts/backup/setup-gcp.sh` (step 6);
   - the workflow only authenticates from `main`.
5. Teardown, **only after the owner's explicit go-ahead**, with the scripts in
   `scripts/decommission/` (step 7). Each one is a dry-run by default and needs `--execute`.
6. Revoke the Mux token (step 8).
7. Open owner decisions:
   - PDF/STL metadata (finding 25);
   - capture dates in file names (finding 26);
   - History API exposure for API-client uploads (finding 23);
   - the `images-for-cms` IAM grant, which can go now with
     `04-gcs-lockdown.sh --authenticated-users-only` (finding 1);
   - the unscrubbed private repo `cjoshmartin-com/backend.cjoshmartin.com` (finding 2);
   - the second leaked key for `fileuploads@` (finding 3);
   - optionally, rewriting the pushed history that still holds 14 full sha1s of deleted assets
     (finding 30). The owner has not asked for a force push.

## 4. Changes after the morning report was written

- **The two temporary permission rules have been removed** from
  `~/code/cjoshmartin.com/.claude/settings.local.json`:
  - `Bash(npx sanity@latest blueprints deploy *)`
  - `Bash(migration/wagtail-to-sanity/scripts/recreate-dataset.sh *)`

  Morning-report step 12 and finding 31 are therefore done.
- **The backend repo** (`~/code/cjoshmartin.com/cjoshmartin-backend`, branch `main`):
  - The "Export for Sanity" plugin commit `73ee567` is local and on Dokku, but **not** on its
    GitHub remote `origin` (`cjoshmartin-com/backend.cjoshmartin.com`, still at `bb72d58`).
  - **The owner said to leave it.**
  - It is included in the scrubbed archive copy at `~/cjoshmartin-migration/backend-archive/`,
    which `02-push-backend-archive.sh` publishes at teardown.

## 5. Where things are

| What | Where |
|---|---|
| Secrets (Sanity editor/viewer tokens, project id, privacy link key, Mux token) | `~/cjoshmartin-migration/secrets.env`, mode 600. Load with `set -a; . ~/cjoshmartin-migration/secrets.env; set +a`. **Never print or commit values.** |
| Wagtail export (the source of truth), local bucket mirror, migration state, privacy evidence | `~/cjoshmartin-migration/` (`wagtail-export.zip`, `gcs/`, `state/`, `privacy/`, `reports/`, `dataset-exports/`) |
| Migration pipeline | `migration/wagtail-to-sanity/` (`npm run migrate -- --dataset <ds> [--confirm-production] --steps <…>`, `npm run recreate -- <cmd>`) |
| Old-vs-new parity tooling | `migration/verify/` |
| Studio, schema, Functions | `studio/` (schema contract: `docs/sanity-migration/schema-contract.md`) |
| Backups (weekly GitHub Action, GCS) | `scripts/backup/`, `.github/workflows/sanity-backup.yml` |
| Teardown | `scripts/decommission/` (with its README) |
| Package reports and evidence | `docs/sanity-migration/reports/` |

## 6. How to work in this setup (things that cost time before)

- **Frontend repo rules** (`CLAUDE.md` / `AGENTS.md`):
  - No `Co-Authored-By` or any AI attribution in commits or PR text.
  - Keep existing comments.
  - Read `node_modules/next/dist/docs/` before writing Next.js code. This is Next 16; `proxy.ts`
    replaces middleware.
- **The Sanity MCP server is logged in as a different account** (`josh@loopcamera.store`). Do not
  use its write or content tools; its docs tools are fine. Use the Sanity CLI instead, which is
  logged in as the owner `contact@cjoshmartin.com`, together with the tokens in `secrets.env`.
- **The permission system refuses destructive operations**, for example:
  - removing Functions or deleting a dataset;
  - `ssh dokku@…`;
  - `git gc`, `reflog expire` and some `rm -rf`.

  Do not work around it. Either the owner runs the command with `!`, or the owner adds a narrow
  allow rule, which you remove afterwards.
- **Blueprint deploys must run** from `studio/` with
  `npm_config_platform=linux npm_config_arch=arm64` set. The Function runtime is linux/arm64 with a
  bundled static ffmpeg.
  - Removing and redeploying the Functions drops their env var `PRIVACY_LINK_KEY`. Set it again on
    `video-to-mp4`, `image-privacy` and `upload-privacy` with
    `npx sanity@latest functions env add <fn> PRIVACY_LINK_KEY "$PRIVACY_LINK_KEY" --stack ST-jc4gwa3c4t`.
  - Never let a Function see a bulk import: remove the Functions first (see `dataset-recreate.md`).
- **The datasets are public.** The History API and the Listen API answer anonymously. Anything
  committed to this **public** repo must not contain:
  - secrets;
  - coordinates;
  - full ids or sha1s of deleted assets (use 8-hex prefixes);
  - the text of unpublished drafts.

  The local inventories in `~/cjoshmartin-migration/` hold the full ids; keep them local.
- **The GitHub repo moved** to `cjoshmartin/cjoshmartin-frontend` (id 737918690). The local
  `origin` URL still says `cjoshmartin-com/...`, and GitHub redirects it.
- **The Vercel Preview is behind Vercel Authentication.** No bypass secret exists; do not create
  one without the owner.
- **Workflow scripts from an earlier session** cannot be reloaded by `scriptPath` after a resume.
  Pass the script inline.
- **Scratchpad directories under `/private/tmp`** do not survive. Durable working data belongs in
  `~/cjoshmartin-migration/`.
- **Playwright's bundled Chromium cannot decode H.264.** Use `channel: 'chrome'` or WebKit for
  video checks.

## 7. Rollback

- **Before teardown step 4** (the Dokku destroy): Vercel Instant Rollback, or revert the merge. The
  old frontend reads Wagtail again at once.
- **After it:** restore the archived Postgres dump into a new Dokku app and re-point DNS (slow).
