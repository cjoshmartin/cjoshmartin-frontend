/**
 * Step 4: testimonial ASCII art.
 *
 * Generates `asciiArt` for every testimonial photo with the WP2 generator
 * (studio/functions/testimonial-ascii-art/generate.ts), reading the pixels from the image CDN of
 * the target dataset: the same code and the same source as the testimonial-ascii-art Function.
 * The transform writes the HTML and `asciiArtSource` (the image asset id) into the same document
 * as the image, so the Function's filter never matches the imported documents.
 *
 * An image the CDN cannot rasterize gets "" (what Django stored). Every result for a testimonial
 * that the live site shows must equal the live HTML byte for byte (live-api-snapshot/page-3.json);
 * any difference fails the step.
 *
 * Writes state/ascii-<dataset>.json: image asset id -> generated HTML.
 */
import {existsSync} from 'node:fs'
import path from 'node:path'

import {ASCII_FUNCTION_DIR, PROJECT_ID, type Dataset, type DataPaths} from '../config'
import {log, readJson, writeJson} from '../util'
import {loadExport} from '../wagtail'
import type {AssetMap} from './assets'

type GeneratorModule = typeof import('../../../../studio/functions/testimonial-ascii-art/generate')

export interface AsciiArtEntry {
  assetId: string
  html: string
  columns: number
  rows: number
  sourceUrl: string | null
  fullSize: boolean
  unsupported: boolean
}

export interface AsciiMap {
  dataset: string
  /** image asset id -> art */
  art: Record<string, AsciiArtEntry>
  /** Live-site comparison per testimonial id. */
  liveComparison: Record<string, 'identical' | 'not on live site'>
}

export async function loadGenerator(): Promise<GeneratorModule> {
  const pngjs = path.join(ASCII_FUNCTION_DIR, 'node_modules', 'pngjs')
  if (!existsSync(pngjs)) {
    throw new Error(`The ASCII-art generator needs its dependencies: run "npm ci" in ${ASCII_FUNCTION_DIR}`)
  }
  return (await import(path.join(ASCII_FUNCTION_DIR, 'generate.ts'))) as GeneratorModule
}

interface LiveHomePage {
  testimonials: {testimonial: {id: number; image?: {value?: string} | null}}[]
}

/** testimonial id -> ASCII HTML the live site serves (from the saved public API response). */
export function liveAsciiArt(paths: DataPaths): Map<number, string> {
  const file = path.join(paths.liveSnapshot, 'page-3.json')
  if (!existsSync(file)) throw new Error(`Live home page snapshot not found: ${file}`)
  const page = readJson<LiveHomePage>(file)
  const out = new Map<number, string>()
  for (const {testimonial} of page.testimonials) {
    const html = testimonial.image?.value
    if (typeof html !== 'string') throw new Error(`Live testimonial ${testimonial.id} has no ASCII HTML`)
    out.set(testimonial.id, html)
  }
  return out
}

export async function generateAsciiArt(paths: DataPaths, dataset: Dataset): Promise<AsciiMap> {
  const data = loadExport(paths.exportJson)
  const assets = readJson<AssetMap>(path.join(paths.state, `assets-${dataset}.json`))
  const generator = await loadGenerator()
  const live = liveAsciiArt(paths)

  const map: AsciiMap = {dataset, art: {}, liveComparison: {}}
  const problems: string[] = []
  for (const testimonial of data.snippets['home.Testimonial']) {
    if (testimonial.image_id == null) continue
    const assetId = assets.images[String(testimonial.image_id)]
    if (!assetId) throw new Error(`testimonial ${testimonial.id}: image ${testimonial.image_id} has no asset`)
    if (!map.art[assetId]) {
      let entry: AsciiArtEntry
      try {
        const result = await generator.generateAsciiArtForSanityImage({projectId: PROJECT_ID, dataset, assetId})
        entry = {
          assetId,
          html: result.html,
          columns: result.columns,
          rows: result.rows,
          sourceUrl: result.url,
          fullSize: result.fullSize,
          unsupported: false,
        }
      } catch (error) {
        if (!(error instanceof generator.UnsupportedImageError)) throw error
        log(`  testimonial ${testimonial.id}: image CDN cannot rasterize ${assetId}; storing "" like Django did`)
        entry = {assetId, html: '', columns: 0, rows: 0, sourceUrl: null, fullSize: false, unsupported: true}
      }
      map.art[assetId] = entry
    }
    const liveHtml = live.get(testimonial.id)
    if (liveHtml === undefined) {
      map.liveComparison[String(testimonial.id)] = 'not on live site'
    } else if (liveHtml !== map.art[assetId]!.html) {
      problems.push(`testimonial ${testimonial.id}: generated ASCII art differs from the live site`)
    } else {
      map.liveComparison[String(testimonial.id)] = 'identical'
    }
  }
  for (const id of live.keys()) {
    if (!data.snippets['home.Testimonial'].some((t) => t.id === id)) {
      problems.push(`live testimonial ${id} is not in the export`)
    }
  }
  writeJson(path.join(paths.state, `ascii-${dataset}.json`), map)
  if (problems.length) throw new Error(`ascii: ${problems.join('; ')}`)
  const identical = Object.values(map.liveComparison).filter((v) => v === 'identical').length
  log(`ascii: ${Object.keys(map.art).length} images rendered; ${identical}/${live.size} live testimonials byte-identical`)
  return map
}
