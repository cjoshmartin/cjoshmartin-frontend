/**
 * Recreates a dataset from a verified export, so that its revision history starts fresh
 * (docs/sanity-migration/reports/dataset-recreate.md).
 *
 * Why: both datasets are public, and a public dataset's History API answers without a token
 * (`/data/history/<dataset>/documents/<id>?time=` or `?revision=`). Its revisions from before the
 * privacy work name every deleted upload (an asset id is its CDN path), some of which held a
 * location, and old asset revisions carry `source.url` links to the unstripped bucket files.
 * Deleting the dataset and importing a clean export is the only way to drop those revisions.
 *
 * The commands, in the order of a run (scripts/recreate-dataset.sh does the delete, create and
 * import in between):
 *
 *   npm run recreate -- snapshot --dataset <ds> --out <file>
 *       Every document (raw perspective: published, drafts, release versions, system documents)
 *       with every field, the counts per type, the asset documents and their sorted sha1s.
 *   npm run recreate -- history-baseline --dataset <ds> --snapshot <file> --ids-from <file>... --out <file>
 *       What the History API holds before the delete: each current document's transactions, and
 *       for every deleted id (every asset id named in the --ids-from files that is not in the
 *       dataset, plus every other id the current documents' transactions touched) its
 *       transactions and whether an anonymous request reads it back.
 *   npm run recreate -- verify-export --snapshot <file> --dir <unpacked export> --ids-from <file>... --out <file>
 *       The export holds exactly the snapshot: every document (asset references rewritten back),
 *       every asset document's fields (assets.json) and every asset file with its sha1 and size.
 *       Every file is scanned with the privacy step's scan (exiftool -ee and the Functions' image
 *       and in-place video checks: no personal tag, no non-zero mdat byte outside the samples, no
 *       location signature outside the samples), and no document names an asset that is not in
 *       the export.
 *   npm run recreate -- restore-assets --dataset <ds> --snapshot <file> [--confirm-production]
 *       After the import: patches every asset document back to its snapshot, field by field (the
 *       import sets the fields through a separate patch after each upload, and leaves out the
 *       ones the export does not keep, such as `mimeType`). Identity fields (`_id`, `sha1hash`,
 *       `size`, `path`, `url`, `assetId`, `extension`) must already be equal; `uploadId` belongs
 *       to the new blob; `_createdAt` cannot be set on an existing document and is counted.
 *   npm run recreate -- compare --dataset <ds> --snapshot <file> --out <file>
 *       Every document equals the snapshot, ignoring `_rev`, `_createdAt`, `_updatedAt` (and an
 *       asset's `uploadId`); `_createdAt` differences are counted separately.
 *   npm run recreate -- history-check --dataset <ds> --baseline <file> --import-start <iso> --out <file>
 *       After the import: the History API knows none of the deleted ids (with a token or
 *       anonymously, at every time and revision the baseline read), and every current document's
 *       history starts at the import.
 *
 * Secrets come from ~/cjoshmartin-migration/secrets.env (SANITY_READ_TOKEN for reads,
 * SANITY_WRITE_TOKEN for restore-assets); they are never printed. Snapshots, baselines and
 * exports name deleted asset ids and hold unpublished drafts, so they stay in
 * ~/cjoshmartin-migration/dataset-exports (mode 700) and are never committed. What this prints
 * uses counts and 8-hex prefixes only.
 */
import {createHash} from 'node:crypto'
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs'
import path from 'node:path'

import {createClient, type SanityClient} from '@sanity/client'

import {API_VERSION, dataPaths, DATASETS, PROJECT_ID, type Dataset} from './config'
import {danglingAssetPointers} from './privacy/pointers'
import {scanLocalFile} from './privacy/scan'
import {mapLimit} from './sanity'
import {personalMetadataExifKeys} from './steps/privacy'
import {
  ASSET_IDENTITY_FIELDS,
  ASSET_UNRESTORABLE_FIELDS,
  ASSET_UPLOAD_FIELDS,
  assetIdsInText,
  differingFields,
  EXPORT_ASSET_EXCLUDED,
  exportFileName,
  exportPointer,
  isAssetDoc,
  isAssetId,
  isSystemDoc,
  prefix,
  summarize,
  unrewriteAssets,
  VOLATILE_FIELDS,
  without,
  type SanityDoc,
  type Snapshot,
  type SnapshotSummary,
} from './recreate-lib'
import {log, stableStringify, writeJson} from './util'

/** History API version (the documented one). */
const HISTORY_API_VERSION = 'v2021-06-07'

// ---------------------------------------------------------------------------------------------
// Arguments, clients, HTTP

interface Args {
  command: string
  flags: Map<string, string[]>
}

function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv
  if (!command) throw new Error('usage: npm run recreate -- <command> [--flag value]...')
  const flags = new Map<string, string[]>()
  let current: string | null = null
  for (const arg of rest) {
    if (arg.startsWith('--')) {
      current = arg.slice(2)
      if (!flags.has(current)) flags.set(current, [])
    } else if (current) {
      flags.get(current)!.push(arg)
    } else {
      throw new Error(`unexpected argument ${arg}`)
    }
  }
  return {command, flags}
}

function flag(args: Args, name: string): string {
  const values = args.flags.get(name)
  if (!values || values.length !== 1) throw new Error(`--${name} <value> is required (once)`)
  return values[0]!
}

function datasetFlag(args: Args): Dataset {
  const dataset = flag(args, 'dataset')
  if (!(DATASETS as readonly string[]).includes(dataset)) throw new Error(`--dataset must be one of ${DATASETS.join(', ')}`)
  return dataset as Dataset
}

function loadEnv(): void {
  const file = dataPaths().secretsFile
  if ((!process.env.SANITY_READ_TOKEN || !process.env.SANITY_WRITE_TOKEN) && existsSync(file)) process.loadEnvFile(file)
  if (process.env.SANITY_PROJECT_ID && process.env.SANITY_PROJECT_ID !== PROJECT_ID) {
    throw new Error(`SANITY_PROJECT_ID is ${process.env.SANITY_PROJECT_ID}, but this tool targets ${PROJECT_ID}`)
  }
}

function token(name: 'SANITY_READ_TOKEN' | 'SANITY_WRITE_TOKEN'): string {
  loadEnv()
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set (environment or ${dataPaths().secretsFile})`)
  return value
}

function client(dataset: Dataset, tokenName: 'SANITY_READ_TOKEN' | 'SANITY_WRITE_TOKEN'): SanityClient {
  return createClient({projectId: PROJECT_ID, dataset, apiVersion: API_VERSION, token: token(tokenName), useCdn: false, perspective: 'raw'})
}

async function fetchAll(c: SanityClient): Promise<SanityDoc[]> {
  const docs = await c.fetch<SanityDoc[]>('*[] | order(_id asc)', {}, {perspective: 'raw'})
  if (!Array.isArray(docs)) throw new Error('the query returned no array')
  return docs
}

interface HttpResult {
  status: number
  body: string
}

async function httpGet(url: string, bearer?: string): Promise<HttpResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {headers: {'User-Agent': 'cjoshmartin-dataset-recreate', ...(bearer ? {Authorization: `Bearer ${bearer}`} : {})}})
      const body = await response.text()
      if ((response.status === 429 || response.status >= 500) && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
        continue
      }
      return {status: response.status, body}
    } catch (error) {
      if (attempt >= 5) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
    }
  }
}

export interface Transaction {
  id: string
  timestamp: string
  documentIDs: string[]
}

/** A document's transactions (token: the History API's transaction log needs one). */
async function transactions(dataset: Dataset, id: string, bearer: string): Promise<Transaction[]> {
  const url = `https://${PROJECT_ID}.api.sanity.io/${HISTORY_API_VERSION}/data/history/${dataset}/transactions/${encodeURIComponent(id)}?excludeContent=true`
  const result = await httpGet(url, bearer)
  if (result.status !== 200) throw new Error(`transactions of ${prefix(id)}: HTTP ${result.status}`)
  return result.body
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const tx = JSON.parse(line) as {id: string; timestamp: string; documentIDs?: string[]}
      return {id: tx.id, timestamp: tx.timestamp, documentIDs: tx.documentIDs ?? []}
    })
}

export type AnonymousRead = 'content' | 'nothing'

/** What an anonymous History API request returns for a document at a time or revision. */
async function anonymousRead(dataset: Dataset, id: string, at: {time: string} | {revision: string}): Promise<{read: AnonymousRead; status: number}> {
  const query = 'time' in at ? `time=${encodeURIComponent(at.time)}` : `revision=${encodeURIComponent(at.revision)}`
  const url = `https://${PROJECT_ID}.api.sanity.io/${HISTORY_API_VERSION}/data/history/${dataset}/documents/${encodeURIComponent(id)}?${query}`
  const result = await httpGet(url)
  if (result.status === 200) {
    const parsed = JSON.parse(result.body) as {documents?: unknown[]}
    if (!Array.isArray(parsed.documents)) throw new Error(`history document ${prefix(id)}: unexpected answer`)
    return {read: parsed.documents.length > 0 ? 'content' : 'nothing', status: 200}
  }
  if (result.status >= 400 && result.status < 500 && result.status !== 429) return {read: 'nothing', status: result.status}
  throw new Error(`history document ${prefix(id)}: HTTP ${result.status}`)
}

function readSnapshot(file: string): Snapshot {
  return JSON.parse(readFileSync(file, 'utf8')) as Snapshot
}

/**
 * Ids to probe from local files: a JSON file `{"ids": [...]}` gives any document ids verbatim
 * (for example scratch documents of earlier live tests); any other file gives every asset id
 * named in it (inventories in any format).
 */
function idsFromFiles(files: readonly string[]): Set<string> {
  const ids = new Set<string>()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    let listed: unknown = null
    if (file.endsWith('.json')) {
      try {
        listed = (JSON.parse(text) as {ids?: unknown}).ids
      } catch {
        listed = null
      }
    }
    if (Array.isArray(listed)) {
      for (const id of listed) if (typeof id === 'string' && id !== '') ids.add(id)
    } else {
      for (const id of assetIdsInText(text)) ids.add(id)
    }
  }
  return ids
}

// ---------------------------------------------------------------------------------------------
// snapshot

async function snapshot(args: Args): Promise<number> {
  const dataset = datasetFlag(args)
  const out = flag(args, 'out')
  // The write (Editor) token sees what the migration's validation sees; reads only.
  const documents = await fetchAll(client(dataset, 'SANITY_WRITE_TOKEN'))
  const snap: Snapshot = {dataset, takenAt: new Date().toISOString(), apiVersion: API_VERSION, documents, summary: summarize(documents)}
  writeJson(out, snap)
  const s = snap.summary
  log(`snapshot ${dataset}: ${s.documents} documents (${s.systemDocuments.length} system), ${s.images} image + ${s.files} file assets`)
  for (const [type, counts] of Object.entries(s.byType)) log(`  ${type}: ${counts.published} published, ${counts.drafts} drafts, ${counts.versions} versions`)
  log(`  asset sha1 list digest ${createHash('sha256').update(s.assetSha1s.join('\n')).digest('hex').slice(0, 16)}`)
  return 0
}

// ---------------------------------------------------------------------------------------------
// history-baseline / history-check

export interface ProbeTarget {
  id: string
  /** Where the id came from: an inventory file, or a transaction of a current document. */
  source: 'inventory' | 'transaction' | 'both'
  transactions: Transaction[]
  /** Fixed probe times for ids without transactions. */
  times: string[]
  /** Anonymous reads before the delete: how many of the probes returned content. */
  anonymousContent: number
  anonymousProbes: number
}

export interface HistoryBaseline {
  dataset: string
  takenAt: string
  current: {id: string; transactions: Transaction[]}[]
  deleted: ProbeTarget[]
}

function probesOf(target: {transactions: Transaction[]; times?: string[]}): ({time: string} | {revision: string})[] {
  const probes: ({time: string} | {revision: string})[] = []
  for (const tx of target.transactions) probes.push({time: tx.timestamp}, {revision: tx.id})
  for (const time of target.times ?? []) probes.push({time})
  return probes
}

async function historyBaseline(args: Args): Promise<number> {
  const dataset = datasetFlag(args)
  const snap = readSnapshot(flag(args, 'snapshot'))
  if (snap.dataset !== dataset) throw new Error('the snapshot is of another dataset')
  const out = flag(args, 'out')
  const bearer = token('SANITY_READ_TOKEN')
  const currentIds = new Set(snap.documents.map((d) => d._id))

  log(`history-baseline ${dataset}: transactions of ${currentIds.size} current documents`)
  const current = await mapLimit([...currentIds].sort(), 6, async (id) => ({id, transactions: await transactions(dataset, id, bearer)}))
  const fromTransactions = new Set<string>()
  for (const doc of current) for (const tx of doc.transactions) for (const other of tx.documentIDs) if (!currentIds.has(other)) fromTransactions.add(other)
  const fromInventories = new Set([...idsFromFiles(args.flags.get('ids-from') ?? [])].filter((id) => !currentIds.has(id)))
  const deletedIds = [...new Set([...fromTransactions, ...fromInventories])].sort()
  log(`  deleted ids: ${fromInventories.size} from the local files (${[...fromInventories].filter(isAssetId).length} asset ids), ${fromTransactions.size} from transactions, ${deletedIds.length} in all`)

  // Fixed times for ids the transaction log does not show: the dataset's first and last
  // transaction and the middle.
  const allTimes = current.flatMap((d) => d.transactions.map((t) => t.timestamp)).sort()
  const first = allTimes[0]
  const last = allTimes.at(-1)
  const fixedTimes = first && last ? [first, new Date((Date.parse(first) + Date.parse(last)) / 2).toISOString(), last] : []

  const deleted = await mapLimit(deletedIds, 6, async (id): Promise<ProbeTarget> => {
    const txs = await transactions(dataset, id, bearer)
    const target: ProbeTarget = {
      id,
      source: fromInventories.has(id) && fromTransactions.has(id) ? 'both' : fromInventories.has(id) ? 'inventory' : 'transaction',
      transactions: txs,
      times: txs.length === 0 ? fixedTimes : [],
      anonymousContent: 0,
      anonymousProbes: 0,
    }
    for (const probe of probesOf(target)) {
      const {read} = await anonymousRead(dataset, id, probe)
      target.anonymousProbes++
      if (read === 'content') target.anonymousContent++
    }
    return target
  })
  const baseline: HistoryBaseline = {dataset, takenAt: new Date().toISOString(), current, deleted}
  writeJson(out, baseline)
  const withTx = deleted.filter((d) => d.transactions.length > 0)
  const readable = deleted.filter((d) => d.anonymousContent > 0)
  log(`  current documents: ${current.reduce((n, d) => n + d.transactions.length, 0)} transactions, earliest ${first ?? 'none'}`)
  log(`  deleted ids with transactions: ${withTx.length} (assets ${withTx.filter((d) => isAssetId(d.id)).length}); readable anonymously: ${readable.length}; anonymous probes ${deleted.reduce((n, d) => n + d.anonymousProbes, 0)}, with content ${deleted.reduce((n, d) => n + d.anonymousContent, 0)}`)
  return 0
}

export interface HistoryCheck {
  dataset: string
  checkedAt: string
  importStart: string
  deleted: {ids: number; withTransactions: number; anonymousProbes: number; anonymousContent: number; failures: string[]}
  current: {ids: number; checked: number; transactionsBeforeImport: number; earliest: string | null; anonymousProbes: number; anonymousContent: number; failures: string[]}
  pass: boolean
}

async function historyCheck(args: Args): Promise<number> {
  const dataset = datasetFlag(args)
  const baseline = JSON.parse(readFileSync(flag(args, 'baseline'), 'utf8')) as HistoryBaseline
  if (baseline.dataset !== dataset) throw new Error('the baseline is of another dataset')
  const importStart = flag(args, 'import-start')
  if (Number.isNaN(Date.parse(importStart))) throw new Error('--import-start must be an ISO time')
  const out = flag(args, 'out')
  const bearer = token('SANITY_READ_TOKEN')

  const deletedFailures: string[] = []
  let deletedWithTx = 0
  let deletedProbes = 0
  let deletedContent = 0
  log(`history-check ${dataset}: ${baseline.deleted.length} deleted ids`)
  await mapLimit(baseline.deleted, 6, async (target) => {
    const txs = await transactions(dataset, target.id, bearer)
    if (txs.length > 0) {
      deletedWithTx++
      deletedFailures.push(`${prefix(target.id)}: ${txs.length} transactions`)
    }
    // Every time and revision the baseline read, plus the fixed times.
    for (const probe of probesOf({transactions: target.transactions, times: [...target.times, importStart]})) {
      const {read} = await anonymousRead(dataset, target.id, probe)
      deletedProbes++
      if (read === 'content') {
        deletedContent++
        deletedFailures.push(`${prefix(target.id)}: anonymous read at ${'time' in probe ? probe.time : 'a revision'}`)
      }
    }
  })

  // Every current document: no transaction before the import, and no anonymous read at an old
  // time or revision (the baseline's) or just before the import.
  const live = await fetchAll(client(dataset, 'SANITY_READ_TOKEN'))
  const before = new Date(Date.parse(importStart) - 1000).toISOString()
  const oldById = new Map(baseline.current.map((c) => [c.id, c.transactions]))
  const currentFailures: string[] = []
  let txBefore = 0
  let earliest: string | null = null
  let currentProbes = 0
  let currentContent = 0
  await mapLimit(live, 6, async (doc) => {
    const txs = await transactions(dataset, doc._id, bearer)
    for (const tx of txs) {
      if (earliest === null || tx.timestamp < earliest) earliest = tx.timestamp
      if (Date.parse(tx.timestamp) < Date.parse(importStart)) {
        txBefore++
        currentFailures.push(`${prefix(doc._id)}: transaction at ${tx.timestamp}`)
      }
    }
    if (txs.length === 0 && !isSystemDoc(doc)) currentFailures.push(`${prefix(doc._id)}: no transaction at all`)
    const old = oldById.get(doc._id) ?? []
    for (const probe of [...probesOf({transactions: old}), {time: before}]) {
      const {read} = await anonymousRead(dataset, doc._id, probe)
      currentProbes++
      if (read === 'content') {
        currentContent++
        currentFailures.push(`${prefix(doc._id)}: anonymous read at ${'time' in probe ? probe.time : 'an old revision'}`)
      }
    }
  })
  const result: HistoryCheck = {
    dataset,
    checkedAt: new Date().toISOString(),
    importStart,
    deleted: {ids: baseline.deleted.length, withTransactions: deletedWithTx, anonymousProbes: deletedProbes, anonymousContent: deletedContent, failures: deletedFailures},
    current: {ids: live.length, checked: live.length, transactionsBeforeImport: txBefore, earliest, anonymousProbes: currentProbes, anonymousContent: currentContent, failures: currentFailures},
    pass: deletedFailures.length === 0 && currentFailures.length === 0,
  }
  writeJson(out, result)
  log(`  deleted ids: ${result.deleted.ids}; with transactions ${deletedWithTx}; anonymous probes ${deletedProbes}, with content ${deletedContent}`)
  log(`  current documents: ${live.length}; transactions before the import ${txBefore}; earliest ${earliest ?? 'none'}; anonymous probes ${currentProbes}, with content ${currentContent}`)
  for (const failure of [...deletedFailures, ...currentFailures].slice(0, 20)) log(`  FAIL ${failure}`)
  log(`history-check ${dataset}: ${result.pass ? 'PASS' : 'FAIL'}`)
  return result.pass ? 0 : 1
}

// ---------------------------------------------------------------------------------------------
// verify-export

export interface ExportVerification {
  snapshotTakenAt: string
  dir: string
  documents: {snapshot: number; exported: number; equal: number; differing: string[]; missing: string[]; unexpected: string[]}
  systemDocuments: {inSnapshot: string[]; inExport: string[]}
  assets: {snapshot: number; filesPresent: number; sha1AndSizeMatch: number; metaEqual: number; failures: string[]; extraFiles: string[]}
  privacy: {scanned: number; withFindings: string[]; unreadable: string[]; danglingPointers: number; locationOrExif: string[]}
  pass: boolean
}

function sha1Of(file: string): string {
  return createHash('sha1').update(readFileSync(file)).digest('hex')
}

async function verifyExport(args: Args): Promise<number> {
  const snap = readSnapshot(flag(args, 'snapshot'))
  const dir = flag(args, 'dir')
  const out = flag(args, 'out')
  const ndjson = readdirSync(dir).filter((f) => f.endsWith('.ndjson'))
  if (ndjson.length !== 1) throw new Error(`expected one .ndjson file in the export, found ${ndjson.length}`)
  const exported = readFileSync(path.join(dir, ndjson[0]!), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as SanityDoc)
  const assetMap = existsSync(path.join(dir, 'assets.json')) ? (JSON.parse(readFileSync(path.join(dir, 'assets.json'), 'utf8')) as Record<string, Record<string, unknown>>) : {}

  // Documents (assets are exported as files plus assets.json, not as documents).
  const snapDocs = snap.documents.filter((d) => !isAssetDoc(d) && !isSystemDoc(d))
  const pointers = new Map(snap.documents.filter(isAssetDoc).map((a) => [exportPointer(a._id), a._id]))
  const exportedById = new Map(exported.map((d) => [d._id, unrewriteAssets(d, pointers) as SanityDoc]))
  const differing: string[] = []
  const missing: string[] = []
  let equal = 0
  for (const doc of snapDocs) {
    const got = exportedById.get(doc._id)
    if (!got) missing.push(doc._id)
    else if (stableStringify(got) === stableStringify(doc)) equal++
    else differing.push(`${doc._id}: ${differingFields(got, doc).join(', ')}`)
  }
  const snapIds = new Set(snap.documents.map((d) => d._id))
  const unexpected = exported.map((d) => d._id).filter((id) => !snapIds.has(id) || isAssetDoc(snap.documents.find((d) => d._id === id)!))

  // Assets: file, sha1, size, and the asset document fields kept in assets.json.
  const assets = snap.documents.filter(isAssetDoc)
  const failures: string[] = []
  let present = 0
  let matching = 0
  let metaEqual = 0
  const expectedFiles = new Set<string>()
  const fileOf = new Map<string, string>()
  for (const asset of assets) {
    const {folder, name} = exportFileName(asset._id)
    expectedFiles.add(`${folder}/${name}`)
    const file = path.join(dir, folder, name)
    if (!existsSync(file)) {
      failures.push(`${prefix(asset._id)}: file missing from the export`)
      continue
    }
    present++
    fileOf.set(asset._id, file)
    const sha1 = sha1Of(file)
    const size = statSync(file).size
    if (sha1 === asset.sha1hash && size === asset.size) matching++
    else failures.push(`${prefix(asset._id)}: sha1 or size differs from the asset document`)
    const key = `${asset._type === 'sanity.imageAsset' ? 'image' : 'file'}-${sha1}`
    const meta = assetMap[key]
    const expected = without(asset, EXPORT_ASSET_EXCLUDED)
    if (meta && stableStringify(meta) === stableStringify(expected)) metaEqual++
    else failures.push(`${prefix(asset._id)}: assets.json ${meta ? `differs in ${differingFields(meta, expected).join(', ')}` : 'has no entry'}`)
  }
  const extraFiles: string[] = []
  for (const folder of ['images', 'files'] as const) {
    if (!existsSync(path.join(dir, folder))) continue
    for (const name of readdirSync(path.join(dir, folder))) if (!expectedFiles.has(`${folder}/${name}`)) extraFiles.push(`${folder}/${name.slice(0, 8)}`)
  }
  if (Object.keys(assetMap).length !== assets.length) failures.push(`assets.json has ${Object.keys(assetMap).length} entries for ${assets.length} assets`)

  // Privacy: every file with the privacy step's scan; the documents name no missing asset; no
  // asset document holds extracted location or personal EXIF.
  log(`verify-export: scanning ${fileOf.size} files`)
  const scans = await mapLimit([...fileOf.entries()], 6, async ([id, file]) => {
    const asset = assets.find((a) => a._id === id)!
    return {id, scan: await scanLocalFile(file, {convertedMp4: (asset.source as {name?: string} | undefined)?.name === 'video-to-mp4'})}
  })
  const withFindings = scans.filter((s) => s.scan.findings.length > 0).map((s) => `${prefix(s.id)}: ${s.scan.findings.map((f) => f.tag).join(', ')}`)
  const unreadable = scans.filter((s) => s.scan.unreadable).map((s) => `${prefix(s.id)}: ${s.scan.unreadable}`)
  const assetIds = new Set(assets.map((a) => a._id))
  const dangling = danglingAssetPointers([...snapDocs, ...assets, ...exportedById.values()], assetIds)
  const locationOrExif: string[] = []
  for (const asset of assets) {
    const metadata = (asset.metadata ?? {}) as Record<string, unknown>
    if (metadata.location !== undefined && metadata.location !== null) locationOrExif.push(`${prefix(asset._id)}: metadata.location`)
    const keys = personalMetadataExifKeys(metadata.exif)
    if (keys.length) locationOrExif.push(`${prefix(asset._id)}: metadata.exif ${keys.join(', ')}`)
    if ((asset.privacy as {strippedFrom?: unknown} | undefined)?.strippedFrom !== undefined) locationOrExif.push(`${prefix(asset._id)}: privacy.strippedFrom`)
  }

  const result: ExportVerification = {
    snapshotTakenAt: snap.takenAt,
    dir,
    documents: {snapshot: snapDocs.length, exported: exported.length, equal, differing, missing, unexpected},
    systemDocuments: {inSnapshot: snap.summary.systemDocuments, inExport: exported.filter(isSystemDoc).map((d) => d._id)},
    assets: {snapshot: assets.length, filesPresent: present, sha1AndSizeMatch: matching, metaEqual, failures, extraFiles},
    privacy: {scanned: scans.length, withFindings, unreadable, danglingPointers: dangling.length, locationOrExif},
    pass:
      differing.length === 0 &&
      missing.length === 0 &&
      unexpected.length === 0 &&
      failures.length === 0 &&
      extraFiles.length === 0 &&
      present === assets.length &&
      matching === assets.length &&
      metaEqual === assets.length &&
      withFindings.length === 0 &&
      unreadable.length === 0 &&
      dangling.length === 0 &&
      locationOrExif.length === 0,
  }
  writeJson(out, result)
  log(`  documents: ${equal}/${snapDocs.length} equal; ${differing.length} differing, ${missing.length} missing, ${unexpected.length} unexpected; system documents in the export: ${result.systemDocuments.inExport.length}`)
  log(`  assets: ${present}/${assets.length} files, ${matching} with the asset's sha1 and size, ${metaEqual} assets.json entries equal; ${extraFiles.length} extra files`)
  log(`  privacy: ${scans.length} files scanned, ${withFindings.length} with findings, ${unreadable.length} unreadable; ${dangling.length} pointers to missing assets; ${locationOrExif.length} asset documents with location/EXIF/strippedFrom`)
  for (const line of [...differing.map((d) => `document ${prefix(d)}… ${d.split(': ')[1]}`), ...missing.map(prefix), ...failures, ...withFindings, ...unreadable, ...locationOrExif].slice(0, 30)) log(`  FAIL ${line}`)
  log(`verify-export: ${result.pass ? 'PASS' : 'FAIL'}`)
  return result.pass ? 0 : 1
}

// ---------------------------------------------------------------------------------------------
// restore-assets / compare

async function restoreAssets(args: Args): Promise<number> {
  const dataset = datasetFlag(args)
  if (dataset === 'production' && !args.flags.has('confirm-production')) throw new Error('production needs --confirm-production')
  const snap = readSnapshot(flag(args, 'snapshot'))
  if (snap.dataset !== dataset) throw new Error('the snapshot is of another dataset')
  const dryRun = args.flags.has('dry-run')
  const c = client(dataset, 'SANITY_WRITE_TOKEN')
  const live = new Map((await fetchAll(c)).filter(isAssetDoc).map((d) => [d._id, d]))
  const wanted = snap.documents.filter(isAssetDoc)
  const problems: string[] = []
  const patches: {id: string; rev: string; set: Record<string, unknown>; unset: string[]}[] = []
  const fieldCounts: Record<string, number> = {}
  for (const asset of wanted) {
    const got = live.get(asset._id)
    if (!got) {
      problems.push(`${prefix(asset._id)}: missing after the import`)
      continue
    }
    for (const field of ASSET_IDENTITY_FIELDS) {
      if (stableStringify(got[field]) !== stableStringify(asset[field])) problems.push(`${prefix(asset._id)}: identity field ${field} differs`)
    }
    const ignore = [...VOLATILE_FIELDS, ...ASSET_UPLOAD_FIELDS, ...ASSET_UNRESTORABLE_FIELDS, ...ASSET_IDENTITY_FIELDS] as string[]
    const fields = differingFields(without(got, ignore), without(asset, ignore))
    if (fields.length === 0) continue
    const set: Record<string, unknown> = {}
    const unset: string[] = []
    for (const field of fields) {
      fieldCounts[field] = (fieldCounts[field] ?? 0) + 1
      if (asset[field] === undefined) unset.push(field)
      else set[field] = asset[field]
    }
    patches.push({id: asset._id, rev: String(got._rev), set, unset})
  }
  const extra = [...live.keys()].filter((id) => !wanted.some((a) => a._id === id))
  for (const id of extra) problems.push(`${prefix(id)}: an asset that is not in the snapshot`)
  log(`restore-assets ${dataset}: ${wanted.length} assets in the snapshot, ${live.size} in the dataset; ${patches.length} to patch; fields: ${JSON.stringify(fieldCounts)}`)
  for (const problem of problems) log(`  FAIL ${problem}`)
  if (problems.length > 0) return 1
  if (dryRun) return 0
  for (const batch of chunks(patches, 25)) {
    const tx = c.transaction()
    for (const p of batch) {
      tx.patch(p.id, (patch) => {
        let next = patch.ifRevisionId(p.rev)
        if (Object.keys(p.set).length) next = next.set(p.set)
        if (p.unset.length) next = next.unset(p.unset)
        return next
      })
    }
    await tx.commit({visibility: 'sync', tag: 'dataset-recreate.restore-assets'})
  }
  // Read back: every asset equals its snapshot except the fields above.
  const after = new Map((await fetchAll(c)).filter(isAssetDoc).map((d) => [d._id, d]))
  const ignore = [...VOLATILE_FIELDS, ...ASSET_UPLOAD_FIELDS, ...ASSET_UNRESTORABLE_FIELDS] as string[]
  const createdAtDiffers = wanted.filter((a) => after.get(a._id)?._createdAt !== a._createdAt).length
  const still = wanted.filter((a) => {
    const got = after.get(a._id)
    return !got || differingFields(without(got, ignore), without(a, ignore)).length > 0
  })
  log(`restore-assets ${dataset}: patched ${patches.length}; ${wanted.length - still.length}/${wanted.length} equal to the snapshot (ignoring ${ignore.join(', ')}); _createdAt is the import time on ${createdAtDiffers}`)
  for (const a of still.slice(0, 20)) log(`  FAIL ${prefix(a._id)}: ${differingFields(without(after.get(a._id) ?? {}, ignore), without(a, ignore)).join(', ')}`)
  return still.length === 0 ? 0 : 1
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export interface DatasetComparison {
  dataset: string
  comparedAt: string
  snapshotTakenAt: string
  ignored: string[]
  documents: {snapshot: number; dataset: number; equal: number; differing: string[]; missing: string[]; extra: string[]}
  createdAtDiffers: {assets: number; other: number}
  systemDocuments: {snapshot: string[]; dataset: string[]; differing: string[]}
  summary: {snapshot: SnapshotSummary; dataset: SnapshotSummary}
  pass: boolean
}

async function compare(args: Args): Promise<number> {
  const dataset = datasetFlag(args)
  const snap = readSnapshot(flag(args, 'snapshot'))
  if (snap.dataset !== dataset) throw new Error('the snapshot is of another dataset')
  const out = flag(args, 'out')
  const live = await fetchAll(client(dataset, 'SANITY_WRITE_TOKEN'))
  const ignoredBase = ['_rev', '_createdAt', '_updatedAt']
  const ignoreFor = (doc: SanityDoc) => (isAssetDoc(doc) ? [...ignoredBase, ...ASSET_UPLOAD_FIELDS] : ignoredBase)
  const liveById = new Map(live.map((d) => [d._id, d]))
  const snapById = new Map(snap.documents.map((d) => [d._id, d]))
  const differing: string[] = []
  const missing: string[] = []
  const systemDiffering: string[] = []
  let equal = 0
  let createdAssets = 0
  let createdOther = 0
  for (const doc of snap.documents) {
    const got = liveById.get(doc._id)
    if (!got) {
      missing.push(doc._id)
      continue
    }
    const fields = differingFields(without(got, ignoreFor(doc)), without(doc, ignoreFor(doc)))
    if (fields.length === 0) equal++
    else if (isSystemDoc(doc)) systemDiffering.push(`${doc._id}: ${fields.join(', ')}`)
    else differing.push(`${doc._id}: ${fields.join(', ')}`)
    if (got._createdAt !== doc._createdAt) {
      if (isAssetDoc(doc)) createdAssets++
      else createdOther++
    }
  }
  const extra = live.map((d) => d._id).filter((id) => !snapById.has(id))
  const nonSystemMissing = missing.filter((id) => !id.startsWith('_.'))
  const result: DatasetComparison = {
    dataset,
    comparedAt: new Date().toISOString(),
    snapshotTakenAt: snap.takenAt,
    ignored: [...ignoredBase, 'uploadId (assets)'],
    documents: {snapshot: snap.documents.length, dataset: live.length, equal, differing, missing, extra},
    createdAtDiffers: {assets: createdAssets, other: createdOther},
    systemDocuments: {snapshot: snap.summary.systemDocuments, dataset: live.filter(isSystemDoc).map((d) => d._id).sort(), differing: systemDiffering},
    summary: {snapshot: snap.summary, dataset: summarize(live)},
    pass: differing.length === 0 && missing.length === 0 && extra.length === 0 && systemDiffering.length === 0,
  }
  writeJson(out, result)
  log(`compare ${dataset}: ${equal}/${snap.documents.length} equal (ignoring ${result.ignored.join(', ')}); ${differing.length} differing, ${nonSystemMissing.length} missing (+${missing.length - nonSystemMissing.length} system), ${extra.length} extra; system documents differing ${systemDiffering.length}`)
  log(`  _createdAt differs on ${createdAssets} assets and ${createdOther} other documents`)
  log(`  asset sha1 lists ${stableStringify(result.summary.snapshot.assetSha1s) === stableStringify(result.summary.dataset.assetSha1s) ? 'equal' : 'DIFFER'}; counts per type ${stableStringify(result.summary.snapshot.byType) === stableStringify(result.summary.dataset.byType) ? 'equal' : 'DIFFER'}`)
  for (const line of [...differing, ...systemDiffering, ...missing, ...extra].slice(0, 30)) log(`  FAIL ${prefix(line)}… ${line.includes(': ') ? line.split(': ')[1] : ''}`)
  log(`compare ${dataset}: ${result.pass ? 'PASS' : 'FAIL'}`)
  return result.pass ? 0 : 1
}

// ---------------------------------------------------------------------------------------------

const COMMANDS: Record<string, (args: Args) => Promise<number>> = {
  snapshot,
  'history-baseline': historyBaseline,
  'history-check': historyCheck,
  'verify-export': verifyExport,
  'restore-assets': restoreAssets,
  compare,
}

const args = parseArgs(process.argv.slice(2))
const command = COMMANDS[args.command]
if (!command) {
  process.stderr.write(`unknown command ${args.command}; one of ${Object.keys(COMMANDS).join(', ')}\n`)
  process.exit(2)
}
command(args).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`\nrecreate ${args.command} FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exit(1)
  },
)
