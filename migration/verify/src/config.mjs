// Shared settings for the verification scripts. Everything that varies between machines can be
// overridden with an environment variable; nothing here is secret.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

/** The current production site (Wagtail-backed until cutover). The apex domain 308s to www. */
export const OLD_BASE = process.env.OLD_BASE ?? 'https://www.cjoshmartin.com'

/** A local `next start` of the Sanity-backed build. Port 3000 is one of the project's CORS origins. */
export const NEW_BASE = process.env.NEW_BASE ?? 'http://localhost:3000'

export const SANITY_PROJECT_ID = process.env.SANITY_PROJECT_ID ?? 'j3vdh6ti'
export const SANITY_API_VERSION = '2026-11-01'

/** Migration working data, outside git. */
export const MIGRATION_DIR = process.env.MIGRATION_DIR ?? path.join(os.homedir(), 'cjoshmartin-migration')
export const EXPORT_JSON = process.env.WAGTAIL_EXPORT_JSON ?? path.join(MIGRATION_DIR, 'extracted', 'export.json')
export const LIVE_SNAPSHOT_DIR = path.join(MIGRATION_DIR, 'live-api-snapshot')
export const PARITY_DIR = process.env.PARITY_DIR ?? path.join(MIGRATION_DIR, 'reports', 'parity')

/** A desktop Chrome user agent, so neither site serves a bot variant. */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36'

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
}

/**
 * The newest Chrome for Testing in the Playwright cache (any revision, so no download is needed).
 * Chrome for Testing has the proprietary codecs (H.264/AAC) that Mux HLS playback needs.
 * CHROME_PATH overrides it.
 */
export function chromeExecutable() {
  if (process.env.CHROME_PATH) {
    if (!fs.existsSync(process.env.CHROME_PATH)) throw new Error(`CHROME_PATH does not exist: ${process.env.CHROME_PATH}`)
    return process.env.CHROME_PATH
  }
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
  const app = 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  const candidates = fs.existsSync(cache)
    ? fs
        .readdirSync(cache)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
        .map((name) => path.join(cache, name, app))
        .filter((file) => fs.existsSync(file))
    : []
  if (candidates.length === 0) {
    throw new Error(`No Chrome for Testing found under ${cache}; set CHROME_PATH or run "npx playwright-core install chromium"`)
  }
  return candidates[0]
}

export async function launchBrowser() {
  return chromium.launch({
    executablePath: chromeExecutable(),
    headless: true,
    // Muted autoplay is allowed by default; this also lets the YouTube check start playback.
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
}

/** Reads a JSON file, failing with the file name in the message. */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`Could not read ${file}: ${error.message}`)
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** A file-system-safe name for a route ("/" → "home", "/projects?x=y" → "projects__x=y"). */
export function routeFileName(route) {
  if (route === '/') return 'home'
  return route
    .replace(/^\//, '')
    .replace(/[?]/g, '__')
    .replace(/[^a-zA-Z0-9_=.-]+/g, '_')
    .slice(0, 120)
}
