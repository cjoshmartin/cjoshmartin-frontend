/**
 * Step 1: extract.
 *
 * - Unzips the Wagtail export and checks every file against the manifest (bytes + sha256).
 * - Mirrors the bucket's content folders to gcs/ with `gsutil -m rsync -r -d`.
 * - Hashes every local file and reconciles files against the Wagtail image, document and
 *   media records. Every discrepancy must be one of KNOWN_DISCREPANCIES (with its evidence);
 *   anything else fails the step.
 * - Fails if migrated content references a record whose file is missing.
 *
 * Writes state/inventory.json (used by later steps) and reports/wp3/extract-inventory.json.
 */
import {existsSync, mkdirSync, readdirSync, statSync} from 'node:fs'
import path from 'node:path'

import {GCS_BUCKET, GCS_CONTENT_FOLDERS, type DataPaths} from '../config'
import {KNOWN_DISCREPANCIES, SHA1_FIELDS, sha1Matches, type KnownDiscrepancy} from '../discrepancies'
import {collectReferences, type Reference} from '../references'
import {groupBy, hashFile, log, readJson, run, stableStringify, writeJson} from '../util'
import {loadExport, type Manifest} from '../wagtail'

export interface InventoryFile {
  /** Path relative to the bucket root, e.g. "original_images/austin.jpeg". */
  path: string
  folder: string
  size: number
  sha1: string
}

export interface Inventory {
  exportGeneratedAt: string
  files: InventoryFile[]
  /** Wagtail image id -> bucket path of the bytes to migrate (absent when the file is missing). */
  imageFiles: Record<string, string>
  /** Wagtail document id -> bucket path. */
  documentFiles: Record<string, string>
  /** Wagtail media id -> bucket path of the video. */
  mediaFiles: Record<string, string>
  /** Wagtail media id -> bucket path of its thumbnail. */
  mediaThumbnails: Record<string, string>
  discrepancies: (KnownDiscrepancy & {observed: Record<string, unknown>})[]
  references: {
    total: number
    images: number[]
    documents: number[]
    media: number[]
    pages: number[]
    toMissingFiles: Reference[]
    toHashMismatches: Reference[]
  }
  counts: Record<string, number>
}

const EXPECTED_ZIP_ENTRIES = ['dumpdata.json', 'export.json', 'manifest.json']

async function unzipExport(paths: DataPaths): Promise<Manifest> {
  if (!existsSync(paths.exportZip)) throw new Error(`Export zip not found: ${paths.exportZip}`)
  const listing = await run('unzip', ['-Z1', paths.exportZip])
  const entries = listing.stdout.split('\n').filter(Boolean).sort()
  if (stableStringify(entries) !== stableStringify(EXPECTED_ZIP_ENTRIES)) {
    throw new Error(`Unexpected zip entries: ${entries.join(', ')}`)
  }
  mkdirSync(paths.extracted, {recursive: true, mode: 0o700})
  await run('unzip', ['-o', '-q', paths.exportZip, '-d', paths.extracted])
  const manifest = readJson<Manifest>(paths.manifestJson)
  if (manifest.format_version !== 1) {
    throw new Error(`Unsupported manifest format_version ${manifest.format_version}`)
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = path.join(paths.extracted, name)
    const size = statSync(file).size
    const sha256 = await hashFile(file, 'sha256')
    if (size !== expected.bytes || sha256 !== expected.sha256) {
      throw new Error(
        `${name} does not match the manifest: ${size} bytes sha256 ${sha256}, expected ${expected.bytes} bytes sha256 ${expected.sha256}`,
      )
    }
    log(`  ${name}: ${size} bytes, sha256 matches the manifest`)
  }
  const missing = ['export.json', 'dumpdata.json'].filter((n) => !manifest.files[n])
  if (missing.length) throw new Error(`Manifest has no checksum for ${missing.join(', ')}`)
  return manifest
}

async function syncBucket(paths: DataPaths): Promise<void> {
  for (const folder of GCS_CONTENT_FOLDERS) {
    const local = path.join(paths.gcs, folder)
    mkdirSync(local, {recursive: true, mode: 0o700})
    log(`  gsutil rsync gs://${GCS_BUCKET}/${folder}/ -> ${local}/`)
    await run('gsutil', ['-m', '-q', 'rsync', '-r', '-d', `gs://${GCS_BUCKET}/${folder}/`, `${local}/`], {
      timeoutMs: 60 * 60 * 1000,
    })
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else if (entry.isFile()) out.push(full)
    else throw new Error(`Unexpected non-file entry in the bucket mirror: ${full}`)
  }
  return out
}

export async function extract(paths: DataPaths, options: {syncGcs: boolean}): Promise<Inventory> {
  log('extract: unzip export and verify manifest checksums')
  await unzipExport(paths)
  const data = loadExport(paths.exportJson)

  if (options.syncGcs) {
    log('extract: mirror bucket content folders')
    await syncBucket(paths)
  } else {
    log('extract: --no-gcs-sync given, using the existing local mirror')
  }

  log('extract: hash local files')
  const files: InventoryFile[] = []
  for (const folder of GCS_CONTENT_FOLDERS) {
    const dir = path.join(paths.gcs, folder)
    if (!existsSync(dir)) throw new Error(`Missing local mirror folder ${dir} (run without --no-gcs-sync)`)
    for (const full of listFiles(dir).sort()) {
      files.push({
        path: path.relative(paths.gcs, full).split(path.sep).join('/'),
        folder,
        size: statSync(full).size,
        sha1: await hashFile(full, 'sha1'),
      })
    }
  }
  const byPath = new Map(files.map((f) => [f.path, f]))

  // --- Reconcile records against files -------------------------------------------------
  const observed: {key: string; discrepancy: Record<string, unknown>}[] = []
  const imageFiles: Record<string, string> = {}
  for (const image of data.images) {
    const file = byPath.get(image.file)
    if (!file) {
      observed.push({
        key: `image-file-missing:${image.id}`,
        discrepancy: {kind: 'image-file-missing', recordId: image.id, file: image.file, recordedSha1: image.file_hash},
      })
      continue
    }
    imageFiles[String(image.id)] = image.file
    if (image.file_hash && file.sha1 !== image.file_hash) {
      observed.push({
        key: `image-hash-mismatch:${image.id}`,
        discrepancy: {
          kind: 'image-hash-mismatch',
          recordId: image.id,
          file: image.file,
          recordedSha1: image.file_hash,
          bucketSha1: file.sha1,
        },
      })
    }
  }
  // Several records pointing at one object, all with the object's hash (pure duplicates).
  for (const [file, records] of groupBy(data.images, (i) => i.file)) {
    if (records.length < 2) continue
    const current = byPath.get(file)
    if (current && records.every((r) => r.file_hash === current.sha1)) {
      const ids = records.map((r) => r.id).sort((a, b) => a - b)
      observed.push({
        key: `image-records-share-file:${ids.join(',')}`,
        discrepancy: {kind: 'image-records-share-file', recordIds: ids, file},
      })
    }
  }
  const imagePaths = new Set(data.images.map((i) => i.file))
  const documentPaths = new Set(data.documents.map((d) => d.file))
  const documentFiles: Record<string, string> = {}
  for (const doc of data.documents) {
    const file = byPath.get(doc.file)
    if (!file) {
      observed.push({key: `document-file-missing:${doc.id}`, discrepancy: {kind: 'document-file-missing', recordId: doc.id, file: doc.file}})
      continue
    }
    documentFiles[String(doc.id)] = doc.file
    if (doc.file_hash && file.sha1 !== doc.file_hash) {
      observed.push({
        key: `document-hash-mismatch:${doc.id}`,
        discrepancy: {kind: 'document-hash-mismatch', recordId: doc.id, file: doc.file, recordedSha1: doc.file_hash, bucketSha1: file.sha1},
      })
    }
  }
  const mediaFiles: Record<string, string> = {}
  const mediaThumbnails: Record<string, string> = {}
  const mediaPaths = new Set<string>()
  for (const media of data.media) {
    if (media.type !== 'video') throw new Error(`media ${media.id} has type ${media.type}; only video is supported`)
    if (!byPath.has(media.file)) {
      observed.push({key: `media-file-missing:${media.id}`, discrepancy: {kind: 'media-file-missing', recordId: media.id, file: media.file}})
    } else {
      mediaFiles[String(media.id)] = media.file
    }
    mediaPaths.add(media.file)
    if (media.thumbnail) {
      mediaPaths.add(media.thumbnail)
      if (!byPath.has(media.thumbnail)) {
        observed.push({key: `media-thumbnail-missing:${media.id}`, discrepancy: {kind: 'media-thumbnail-missing', recordId: media.id, file: media.thumbnail}})
      } else {
        mediaThumbnails[String(media.id)] = media.thumbnail
      }
    }
  }
  for (const file of files) {
    const known =
      (file.folder === 'original_images' && imagePaths.has(file.path)) ||
      (file.folder === 'documents' && documentPaths.has(file.path)) ||
      ((file.folder === 'media' || file.folder === 'media_thumbnails') && mediaPaths.has(file.path))
    if (!known) {
      observed.push({
        key: `file-without-record:${file.path}`,
        discrepancy: {kind: 'file-without-record', file: file.path, sha1: file.sha1},
      })
    }
  }

  // --- Compare with the explained list ------------------------------------------------
  const knownByKey = new Map<string, KnownDiscrepancy>()
  for (const k of KNOWN_DISCREPANCIES) {
    const key =
      k.kind === 'image-records-share-file'
        ? `${k.kind}:${k.recordIds.join(',')}`
        : k.kind === 'file-without-record'
          ? `${k.kind}:${k.file}`
          : `${k.kind}:${k.recordId}`
    knownByKey.set(key, k)
  }
  const problems: string[] = []
  const discrepancies: Inventory['discrepancies'] = []
  for (const {key, discrepancy} of observed) {
    const known = knownByKey.get(key)
    if (!known) {
      problems.push(`unexplained discrepancy ${key}: ${JSON.stringify(discrepancy)}`)
      continue
    }
    // Every observed value must equal the explained one (hashes, files, ids).
    // A sha1 may be explained by its first 8 hex digits (see src/discrepancies.ts).
    const {explanation: _explanation, ...knownFacts} = known
    for (const [field, value] of Object.entries(knownFacts)) {
      const same =
        SHA1_FIELDS.has(field) && typeof value === 'string'
          ? sha1Matches(discrepancy[field], value)
          : stableStringify(discrepancy[field]) === stableStringify(value)
      if (!same) {
        problems.push(`discrepancy ${key}: ${field} is ${JSON.stringify(discrepancy[field])}, the explanation expects ${JSON.stringify(value)}`)
      }
    }
    discrepancies.push({...known, observed: discrepancy})
    knownByKey.delete(key)
  }
  for (const key of knownByKey.keys()) {
    problems.push(`explained discrepancy ${key} was not observed any more; update src/discrepancies.ts`)
  }

  // --- References from migrated content -------------------------------------------------
  const references = collectReferences(data)
  const imageIds = new Set(data.images.map((i) => i.id))
  const documentIds = new Set(data.documents.map((d) => d.id))
  const mediaIds = new Set(data.media.map((m) => m.id))
  const pageIds = new Set(data.pages.map((p) => p.id))
  for (const ref of references) {
    const exists =
      ref.kind === 'image' ? imageIds.has(ref.id)
      : ref.kind === 'document' ? documentIds.has(ref.id)
      : ref.kind === 'media' ? mediaIds.has(ref.id)
      : pageIds.has(ref.id)
    if (!exists) problems.push(`${ref.location} references ${ref.kind} ${ref.id}, which has no record in the export`)
  }
  const toMissingFiles = references.filter(
    (r) =>
      (r.kind === 'image' && imageIds.has(r.id) && !imageFiles[String(r.id)]) ||
      (r.kind === 'document' && documentIds.has(r.id) && !documentFiles[String(r.id)]) ||
      (r.kind === 'media' && mediaIds.has(r.id) && !mediaFiles[String(r.id)]),
  )
  for (const ref of toMissingFiles) {
    problems.push(`${ref.location} references ${ref.kind} ${ref.id}, whose file is missing from the bucket`)
  }
  const mismatchIds = new Set(
    discrepancies.filter((d) => d.kind === 'image-hash-mismatch').map((d) => (d as {recordId: number}).recordId),
  )
  const toHashMismatches = references.filter((r) => r.kind === 'image' && mismatchIds.has(r.id))

  const uniqueSorted = (kind: Reference['kind']) =>
    [...new Set(references.filter((r) => r.kind === kind).map((r) => r.id))].sort((a, b) => a - b)

  const counts: Record<string, number> = {
    imageRecords: data.images.length,
    documentRecords: data.documents.length,
    mediaRecords: data.media.length,
    filesTotal: files.length,
    ...Object.fromEntries(
      GCS_CONTENT_FOLDERS.map((folder) => [`files:${folder}`, files.filter((f) => f.folder === folder).length]),
    ),
    bytesTotal: files.reduce((sum, f) => sum + f.size, 0),
    imageRecordsWithFile: Object.keys(imageFiles).length,
    distinctImageFilesReferencedByRecords: new Set(Object.values(imageFiles)).size,
  }

  const inventory: Inventory = {
    exportGeneratedAt: data.generated_at,
    files,
    imageFiles,
    documentFiles,
    mediaFiles,
    mediaThumbnails,
    discrepancies,
    references: {
      total: references.length,
      images: uniqueSorted('image'),
      documents: uniqueSorted('document'),
      media: uniqueSorted('media'),
      pages: uniqueSorted('page'),
      toMissingFiles,
      toHashMismatches,
    },
    counts,
  }
  writeJson(path.join(paths.state, 'inventory.json'), inventory)
  writeJson(path.join(paths.reports, 'wp3', 'extract-inventory.json'), inventory)

  if (problems.length) {
    throw new Error(`extract found ${problems.length} problem(s):\n- ${problems.join('\n- ')}`)
  }
  log(
    `extract: ${files.length} files (${GCS_CONTENT_FOLDERS.map((f) => `${f} ${counts[`files:${f}`]}`).join(', ')}), ` +
      `${data.images.length} image / ${data.documents.length} document / ${data.media.length} media records, ` +
      `${discrepancies.length} explained discrepancies, ${references.length} references (none to missing files)`,
  )
  return inventory
}
