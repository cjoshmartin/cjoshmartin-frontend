/**
 * Nothing in this repository asks Sanity to extract location, EXIF or camera data from an upload
 * (recreate fix round 1, finding 1). The upload itself writes what it extracts into the asset
 * document's first revision, and the History API of a public dataset serves that revision without
 * a token for the history retention period: the upload-privacy Function removes the data from the
 * asset document within seconds, but cannot change that revision. Only deleting and creating the
 * dataset again removes it. So the request must never be made:
 *
 * - every image field of the Studio schema extracts only IMAGE_METADATA_OPTIONS;
 * - no source file in the repository requests `location`, `exif` or `image` (the HTTP API's
 *   `meta=`, @sanity/client's `extract`, a schema's `metadata`);
 * - every @sanity/client upload that can be an image names its `extract` explicitly (Sanity's
 *   default leaves location out today; an explicit list does not depend on that).
 */
import assert from 'node:assert/strict'
import {readdirSync, readFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, it} from 'node:test'

import {IMAGE_METADATA_OPTIONS} from '../functions/privacy/constants'
import {schemaTypes} from '../schemaTypes'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const THIS_FILE = fileURLToPath(import.meta.url)
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.vercel', '.claude', '.sanity', 'dist', 'build', 'coverage', 'out', 'docs'])
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.sh'])
const PERSONAL = /['"](location|exif|image)['"]/

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(path.join(dir, entry.name), out)
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

/** The text of a call from its opening parenthesis to the matching one (string literals skipped). */
function callText(text: string, open: number): string {
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return text.slice(open, i + 1)
  }
  throw new Error('unbalanced call')
}

/** The first argument of a call's text, up to the first comma at depth 1. */
function firstArgument(call: string): string {
  let depth = 0
  for (let i = 0; i < call.length; i++) {
    const c = call[i]
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (c === ',' && depth === 1) return call.slice(1, i).trim()
  }
  return call.slice(1, -1).trim()
}

const files = sourceFiles(REPO_ROOT).filter((file) => file !== THIS_FILE)
const relative = (file: string) => path.relative(REPO_ROOT, file)

describe('the Studio schema', () => {
  it('extracts only the placeholders and the palette in every image field', () => {
    const imageTypeNames = new Set(['image'])
    for (const type of schemaTypes as {name: string; type: string}[]) if (type.type === 'image') imageTypeNames.add(type.name)
    const checked: string[] = []
    const walk = (node: unknown, where: string) => {
      if (!node || typeof node !== 'object') return
      const field = node as {name?: string; type?: string; options?: {metadata?: unknown}; fields?: unknown[]; of?: unknown[]}
      if (typeof field.type === 'string' && imageTypeNames.has(field.type)) {
        // A field of a named image type inherits its options unless it sets its own.
        if (field.type === 'image' || field.options !== undefined) {
          assert.deepEqual(field.options?.metadata, [...IMAGE_METADATA_OPTIONS], `${where} must use PRIVATE_IMAGE_OPTIONS`)
        }
        checked.push(where)
      }
      for (const key of ['fields', 'of'] as const) {
        const children = field[key]
        if (Array.isArray(children)) children.forEach((child, i) => walk(child, `${where}.${(child as {name?: string})?.name ?? i}`))
      }
    }
    for (const type of schemaTypes) walk(type, type.name)
    assert.ok(checked.length >= 10, `found ${checked.length} image fields; the walk no longer reaches them`)
  })
})

describe('the repository', () => {
  it('has source files to check', () => {
    assert.ok(files.some((f) => relative(f).startsWith('studio/functions/')))
    assert.ok(files.some((f) => relative(f).startsWith('migration/')))
  })

  it('never requests location, EXIF or camera metadata on an upload', () => {
    const problems: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/[?&]meta=(location|exif|image)\b/g)) problems.push(`${relative(file)}: ${match[0]}`)
      for (const match of text.matchAll(/['"]meta['"]\s*,\s*['"](location|exif|image)['"]/g)) problems.push(`${relative(file)}: ${match[0]}`)
      for (const match of text.matchAll(/\b(extract|metadata)\s*:\s*\[([^\]]*)\]/g)) {
        if (PERSONAL.test(match[2])) problems.push(`${relative(file)}: ${match[0].replace(/\s+/g, ' ')}`)
      }
    }
    assert.deepEqual(problems, [])
  })

  it('names `extract` in every @sanity/client upload that can be an image', () => {
    const problems: string[] = []
    let uploads = 0
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/\bassets\.upload\(/g)) {
        const call = callText(text, match.index + match[0].length - 1)
        uploads++
        if (/^['"]file['"]$/.test(firstArgument(call))) continue
        if (!/\bextract\s*:/.test(call)) problems.push(`${relative(file)}:${text.slice(0, match.index).split('\n').length}: ${call.slice(0, 80).replace(/\s+/g, ' ')}`)
      }
    }
    assert.ok(uploads >= 8, `found ${uploads} uploads; the scan no longer reaches them`)
    assert.deepEqual(problems, [])
  })
})
