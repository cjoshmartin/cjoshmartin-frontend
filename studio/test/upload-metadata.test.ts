/**
 * Nothing in this repository asks Sanity to extract location, EXIF or camera data from an upload
 * (recreate fix round 1, finding 1). The upload itself writes what it extracts into the asset
 * document's first revision, and the History API of a public dataset serves that revision without
 * a token for the history retention period: the upload-privacy Function removes the data from the
 * asset document within seconds, but cannot change that revision. Only deleting and creating the
 * dataset again removes it. So the request must never be made:
 *
 * - IMAGE_METADATA_OPTIONS holds only the placeholders and the palette (checked against a list in
 *   this file, so a change to the constant fails here);
 * - every image field of the Studio schema extracts only IMAGE_METADATA_OPTIONS;
 * - every upload that can be an image goes through `uploadAsset` (studio/functions/privacy/upload.ts,
 *   recreate fix round 2, finding 2). TypeScript lets its `extract` take only IMAGE_METADATA_OPTIONS
 *   values, and at run time it refuses any other value, `extract` on a file upload and options it
 *   does not list. An image upload without `extract` asks for IMAGE_METADATA_OPTIONS explicitly, so
 *   it does not depend on Sanity's default. Its requests, and those of the image-privacy Function's
 *   store, are sent to a local server here with the real @sanity/client, which checks the `meta`
 *   parameters on the wire;
 * - no source file in the repository sends a `meta` request parameter at all, whatever its value:
 *   only @sanity/client builds one, from `extract`. The scan looks for `meta` as a URL, shell or
 *   Python keyword parameter (`meta=`, in prose too), an object or dict key whose value is not an
 *   object (`{meta: …}`, `{"meta": …}`), a shorthand key in a query (`URLSearchParams({meta})`,
 *   `query: {meta}`), a URLSearchParams `set`/`append` name, a key/value pair (`['meta', …]`,
 *   `("meta", …)`) and a property assignment (`query.meta = …`, `params['meta'] = …`). A function
 *   parameter or a type field named `meta` with a non-object type reads as a key too: rename it;
 * - no `extract` or `metadata` list written in a source file names `location`, `exif` or `image`.
 *
 * Limits. The source checks are text checks over the files git tracks or would track (ignored build
 * output such as the Functions' `.build/` is not read). They do not follow values through
 * variables; the run-time refusal in `uploadAsset` covers the values. They do not see:
 * - a parameter name built at run time (`'me' + 'ta'`), or an object key after a comment line;
 * - an upload through the client's assets object reached under another name
 *   (`const a = client.assets; a.upload('image', …)`), or a client other than @sanity/client and
 *   plain HTTP;
 * - uploads made outside the repository: a local script, curl by hand, or another project's Studio
 *   with a token for these datasets. For those, upload-privacy's WARN line (it names the extracted
 *   keys) is the only signal: check `npx sanity@latest functions logs upload-privacy`.
 * The checks of the scan itself (`the scan`, below) show which forms it catches.
 */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {existsSync, readFileSync} from 'node:fs'
import {createServer, type Server} from 'node:http'
import type {AddressInfo} from 'node:net'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {after, before, describe, it} from 'node:test'

import {createClient, type SanityClient} from '@sanity/client'

import {createSanityImageStore} from '../functions/image-privacy/sanity'
import {IMAGE_METADATA_OPTIONS} from '../functions/privacy/constants'
import {imageExtract, uploadAsset, uploadOptions} from '../functions/privacy/upload'
import {schemaTypes} from '../schemaTypes'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const THIS_FILE = fileURLToPath(import.meta.url)
const UPLOAD_HELPER = path.join(REPO_ROOT, 'studio/functions/privacy/upload.ts')
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.vercel', '.claude', '.sanity', '.build', 'dist', 'build', 'coverage', 'out', 'docs'])
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.sh'])
const PERSONAL = /['"](location|exif|image)['"]/
/** What an upload may extract: the placeholders and the palette. Never location, exif or image. */
const SAFE_METADATA = ['blurhash', 'thumbhash', 'lqip', 'palette']

/**
 * The source files of the repository: every file git tracks or would track (untracked files that
 * are not ignored), as they are in the working tree. A tracked file deleted in the working tree is
 * not there to read, so it is left out.
 */
function sourceFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
  const files = new Set<string>()
  for (const name of listed.split('\0')) {
    if (!name || !SOURCE_EXTENSIONS.has(path.extname(name))) continue
    if (name.split('/').some((segment) => SKIP_DIRS.has(segment))) continue
    const file = path.join(REPO_ROOT, name)
    if (existsSync(file)) files.add(file)
  }
  return [...files].sort()
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

/** Ways to name a `meta` request parameter, whatever its value (see the header). */
const META_PARAMETER = [
  {form: 'meta= (URL, shell or Python keyword)', pattern: /(?<![\w$.])meta=(?!=)/g},
  // Not when the value is an object or a type literal (`meta: {…}`): Sanity's `meta` is a list.
  {form: 'object or dict key meta', pattern: /[{,]\s*['"`]?meta['"`]?\s*:(?!:)(?!\s*\{)/g},
  // Only in a request's query: elsewhere `{meta}` is mostly destructuring or a returned object.
  {form: 'shorthand key {meta} in a query', pattern: /(?:\bURLSearchParams\(\s*|\b(?:query|params|searchParams)\s*[:=]\s*)\{[^{}]*?(?<![\w$.])meta\s*[,}]/g},
  {form: "URLSearchParams set/append('meta', …)", pattern: /\.(?:set|append)\(\s*['"`]meta['"`]/g},
  {form: "pair ['meta', …] or ('meta', …)", pattern: /[[(,]\s*[[(]\s*['"`]meta['"`]\s*,/g},
  {form: 'assignment .meta = …', pattern: /\.meta\s*=(?!=)/g},
  {form: "assignment ['meta'] = …", pattern: /\[\s*['"`]meta['"`]\s*\]\s*=(?!=)/g},
]

interface ScanResult {
  problems: string[]
  /** `assets.upload('file', …)` calls outside the helper. */
  fileUploads: number
  /** `assets.upload(…)` calls in the helper. */
  helperUploads: number
  /** `uploadAsset(…)` calls. */
  helperCalls: number
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length

/** The checks of the header over one source text. `helper`: the text is studio/functions/privacy/upload.ts. */
function scanSource(text: string, where: string, helper = false): ScanResult {
  const result: ScanResult = {problems: [], fileUploads: 0, helperUploads: 0, helperCalls: 0}
  const problem = (index: number, what: string) => result.problems.push(`${where}:${lineOf(text, index)}: ${what}`)
  for (const {form, pattern} of META_PARAMETER) {
    for (const match of text.matchAll(pattern)) problem(match.index, `a \`meta\` request parameter (${form}): ${match[0].replace(/\s+/g, ' ')}`)
  }
  for (const match of text.matchAll(/\b(extract|metadata)\s*:\s*\[([^\]]*)\]/g)) {
    if (PERSONAL.test(match[2])) problem(match.index, `asks for personal metadata: ${match[0].replace(/\s+/g, ' ')}`)
  }
  for (const match of text.matchAll(/\bassets\s*\.\s*upload\b/g)) {
    const rest = text.slice(match.index + match[0].length)
    const open = /^\s*\(/.exec(rest)
    if (!open) {
      if (!helper) problem(match.index, 'a reference to assets.upload that is not a call (an upload must go through uploadAsset)')
      continue
    }
    const call = callText(text, match.index + match[0].length + open[0].length - 1)
    if (helper) {
      result.helperUploads++
    } else if (!/^['"`]file['"`]$/.test(firstArgument(call))) {
      problem(match.index, `an upload that can be an image outside uploadAsset: ${call.slice(0, 80).replace(/\s+/g, ' ')}`)
    } else if (/\bextract\b/.test(call)) {
      problem(match.index, `\`extract\` on a file upload: ${call.slice(0, 80).replace(/\s+/g, ' ')}`)
    } else {
      result.fileUploads++
    }
  }
  for (const match of text.matchAll(/['"`]?\bassets['"`]?\s*\]?\s*\[\s*['"`]upload['"`]\s*\]/g)) {
    problem(match.index, `assets.upload reached by a computed name: ${match[0]}`)
  }
  result.helperCalls = [...text.matchAll(/\buploadAsset\s*\(/g)].length
  return result
}

const files = sourceFiles().filter((file) => file !== THIS_FILE)
const relative = (file: string) => path.relative(REPO_ROOT, file)

describe('IMAGE_METADATA_OPTIONS', () => {
  it('holds only the placeholders and the palette', () => {
    assert.ok(IMAGE_METADATA_OPTIONS.length > 0)
    for (const option of IMAGE_METADATA_OPTIONS) assert.ok(SAFE_METADATA.includes(option), `${option} is not one of ${SAFE_METADATA.join(', ')}`)
  })
})

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

describe('uploadAsset', () => {
  interface Received {
    path: string
    query: URLSearchParams
    bytes: number
  }
  const received: Received[] = []
  let server: Server
  let client: SanityClient
  const png = Buffer.from('89504e470d0a1a0a', 'hex')

  before(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = Buffer.concat(chunks)
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        received.push({path: url.pathname, query: url.searchParams, bytes: body.length})
        const image = url.pathname.includes('/assets/images/')
        const sha1 = createHash('sha1').update(body).digest('hex')
        response.writeHead(200, {'Content-Type': 'application/json'})
        response.end(JSON.stringify({document: {_id: `${image ? 'image' : 'file'}-${sha1}-${image ? '1x1-png' : 'bin'}`, _type: image ? 'sanity.imageAsset' : 'sanity.fileAsset', sha1hash: sha1, size: body.length}}))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const {port} = server.address() as AddressInfo
    client = createClient({projectId: 'test1234', dataset: 'test', apiVersion: '2025-02-19', useCdn: false, token: 'test-token', apiHost: `http://127.0.0.1:${port}`, useProjectHostname: false})
  })
  after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))

  const last = () => {
    const request = received.at(-1)
    assert.ok(request, 'the server received no request')
    return request
  }

  it('positive control: @sanity/client sends whatever `extract` asks for as `meta`', async () => {
    await client.assets.upload('image', png, {extract: ['location', 'exif']})
    assert.deepEqual(last().query.getAll('meta'), ['location', 'exif'])
  })

  it('asks for exactly IMAGE_METADATA_OPTIONS in an image upload without `extract`', async () => {
    const asset = await uploadAsset(client, 'image', png, {filename: 'a.png', contentType: 'image/png'})
    assert.equal(asset._type, 'sanity.imageAsset')
    const request = last()
    assert.match(request.path, /\/assets\/images\/test$/)
    assert.deepEqual(request.query.getAll('meta'), [...IMAGE_METADATA_OPTIONS])
    assert.equal(request.query.get('filename'), 'a.png')
  })

  it('passes an allowed subset through', async () => {
    await uploadAsset(client, 'image', png, {extract: ['lqip', 'palette']})
    assert.deepEqual(last().query.getAll('meta'), ['lqip', 'palette'])
  })

  it('refuses location, EXIF, camera data and unknown values before any request', async () => {
    const count = received.length
    for (const option of ['location', 'exif', 'image', 'none', 'LOCATION']) {
      assert.throws(() => uploadAsset(client, 'image', png, {extract: [option] as never}), /refused/, option)
    }
    assert.throws(() => imageExtract('location' as never), /must be a list/)
    assert.throws(
      () =>
        uploadOptions('image', {
          // @ts-expect-error: `location` is not an ImageMetadataOption, so TypeScript refuses it too.
          extract: ['lqip', 'location'],
        }),
      /refused: location/,
    )
    assert.equal(received.length, count)
  })

  it('refuses options it does not list, such as `meta` or `query`', async () => {
    const count = received.length
    assert.throws(() => uploadAsset(client, 'image', png, {meta: ['location']} as never), /not allowed here: meta/)
    assert.throws(() => uploadAsset(client, 'image', png, {query: {meta: 'exif'}} as never), /not allowed here: query/)
    assert.throws(() => uploadAsset(client, 'video' as never, png), /unknown asset type/)
    assert.equal(received.length, count)
  })

  it('sends no `meta` in a file upload, and refuses `extract` there', async () => {
    const asset = await uploadAsset(client, 'file', png, {filename: 'a.bin', source: {name: 'test', id: 'x'}})
    assert.equal(asset._type, 'sanity.fileAsset')
    const request = last()
    assert.match(request.path, /\/assets\/files\/test$/)
    assert.deepEqual(request.query.getAll('meta'), [])
    assert.equal(request.query.get('sourceName'), 'test')
    const count = received.length
    assert.throws(() => uploadAsset(client, 'file', png, {extract: ['lqip']}), /image uploads only/)
    assert.equal(received.length, count)
  })

  it("is what the image-privacy Function's store uploads its copies with", async () => {
    const store = createSanityImageStore(client as unknown as Parameters<typeof createSanityImageStore>[0], {deadline: Date.now() + 60_000})
    const copy = await store.uploadStripped(new Uint8Array(png), {_id: 'image-upload', _type: 'sanity.imageAsset', originalFilename: 'photo.png'} as never, 'image/png', 'digest-of-the-upload')
    assert.equal(copy.sha1hash, createHash('sha1').update(png).digest('hex'))
    const request = last()
    assert.match(request.path, /\/assets\/images\/test$/)
    assert.deepEqual(request.query.getAll('meta'), [...IMAGE_METADATA_OPTIONS])
    assert.equal(request.query.get('tag'), 'image-privacy.upload')
    assert.equal(request.query.get('sourceName'), 'image-privacy')
    assert.equal(request.query.get('sourceId'), 'digest-of-the-upload')
    assert.equal(request.query.get('filename'), 'photo.png')
  })
})

describe('the scan', () => {
  const flagged = (source: string, helper = false) => scanSource(source, 'fixture', helper).problems.length > 0
  // Recreate fix round 2, finding 2: the forms recheck 1 found unchecked, and the literal forms.
  const caught: Record<string, string> = {
    'URL query': 'await fetch(`${api}/assets/images/${dataset}?meta=location`, {method: "POST", body})',
    'URL query, second parameter': "const url = base + '?filename=a.jpg&meta=' + option",
    'request query object': "await client.request({method: 'POST', uri: '/assets/images/staging', query: {meta: ['location']}, body})",
    'URLSearchParams object': "const query = new URLSearchParams({meta: 'exif'})",
    'URLSearchParams object, key on its own line': 'const query = new URLSearchParams({\n  filename,\n  meta: LIST,\n})',
    'URLSearchParams shorthand': 'const query = new URLSearchParams({filename, meta})',
    'request query shorthand': "await client.request({method: 'POST', uri, query: {filename, meta}, body})",
    'URLSearchParams append': "url.searchParams.append('meta', option)",
    'URLSearchParams set': 'params.set("meta", "image")',
    'pairs': "new URLSearchParams([['meta', 'location']])",
    'property assignment': 'query.meta = LIST',
    'index assignment': "params['meta'] = LIST",
    'Python params dict': 'requests.post(url, params={"meta": "location"}, data=body)',
    'Python params pairs': 'requests.post(url, params=[("filename", name), ("meta", "location")], data=body)',
    'Python keyword': 'client.upload(path, meta=LIST)',
    'curl': 'curl -X POST "$API/assets/images/staging" -G --data-urlencode meta=exif --data-binary @photo.jpg',
    'curl form': 'curl -F "meta=location" "$API"',
    'extract literal': "await uploadAsset(client, 'image', body, {extract: ['lqip', 'location']})",
    'schema metadata literal': "options: {metadata: ['palette', 'exif']}",
    'image upload with a variable list': "await client.assets.upload('image', body, {extract: LIST})",
    'image upload without extract': "await client.assets.upload('image', body, {filename})",
    'upload of a type known at run time': 'await client.assets.upload(kind, body, options)',
    'file upload with extract': "await client.assets.upload('file', body, {extract: LIST})",
    'bound upload': 'const upload = client.assets.upload.bind(client.assets)',
    'computed name': "await client.assets['upload']('image', body)",
    'computed names': "await client['assets']['upload']('image', body)",
  }
  // Forms the repository uses for other things; none of them may be flagged.
  const allowed: Record<string, string> = {
    'import.meta': 'const require = createRequire(import.meta.url)',
    'a variable named meta': 'const meta = assetMap[key]\nif (meta && meta.length) use(meta)',
    'a box type': "{index: 3, handler: 'meta', sampleEntry: 'mebx'}",
    'a box builder': "const rebuilt = boxBytes('meta', concat(parts), fullHeader(meta))",
    'a box path': "removed: ['moov/meta']",
    'Python dict lookup': 'meta = read_json(path)\nmeta["pap"] = "enforced"',
    'HTML meta tag': '<meta name="viewport" content="width=device-width, initial-scale=1">',
    'page extract': "description: meta('meta[name=\"description\"]'),",
    'a file upload': "await client.assets.upload('file', createReadStream(output), {filename, contentType})",
    'an upload through the helper': "await uploadAsset(client, 'image', body, {extract: IMAGE_METADATA_OPTIONS})",
    'a page extract key': 'desktop: {status, extract: desktopExtract, log}',
    'destructuring and a returned object': 'const {file, video, meta, audio} = sampleMovie()\nreturn {file, video, meta, audio}',
    'a parameter with an object type': 'function reportHtml(\n  metrics: ImageMetrics[],\n  meta: {dataset: string; generatedAt: string},\n): string {',
  }

  for (const [form, source] of Object.entries(caught)) {
    it(`catches ${form}`, () => assert.ok(flagged(source), source))
  }
  for (const [form, source] of Object.entries(allowed)) {
    it(`allows ${form}`, () => assert.deepEqual(scanSource(source, 'fixture').problems, []))
  }
  it('allows the upload inside the helper only', () => {
    assert.equal(flagged('return client.assets.upload(kind, body as never, checked)', true), false)
    assert.equal(flagged('return client.assets.upload(kind, body as never, checked)'), true)
  })
})

describe('the repository', () => {
  const scans = files.map((file) => ({file, ...scanSource(readFileSync(file, 'utf8'), relative(file), file === UPLOAD_HELPER)}))

  it('has source files to check', () => {
    assert.ok(files.some((f) => relative(f).startsWith('studio/functions/')))
    assert.ok(files.some((f) => relative(f).startsWith('migration/')))
    assert.ok(files.includes(UPLOAD_HELPER), 'the upload helper is not among the source files')
    assert.ok(!files.some((f) => relative(f).split('/').includes('.build')), 'build output is scanned')
  })

  it('never sends a `meta` parameter, never lists personal metadata, and uploads images only through uploadAsset', () => {
    assert.deepEqual(scans.flatMap((s) => s.problems), [])
  })

  it('still reaches every upload', () => {
    const helper = scans.find((s) => s.file === UPLOAD_HELPER)
    assert.equal(helper?.helperUploads, 1, 'the helper makes exactly one upload call')
    const fileUploads = scans.reduce((n, s) => n + s.fileUploads, 0)
    const callers = scans.filter((s) => s.file !== UPLOAD_HELPER && s.helperCalls > 0).map((s) => relative(s.file))
    assert.ok(fileUploads >= 6, `found ${fileUploads} file uploads; the scan no longer reaches them`)
    assert.ok(callers.length >= 4, `found uploadAsset calls in ${callers.length} files (${callers.join(', ')}); the scan no longer reaches them`)
  })
})
