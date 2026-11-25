/**
 * Compares two datasets this migration imported into (normally staging and production).
 *
 *   npm run compare -- --datasets staging,production
 *
 * Both datasets are read in full (raw perspective: published documents, drafts, versions and
 * assets; system documents under `_.` are skipped) and compared on:
 *
 *   ids           documents and assets that exist in only one of the two datasets
 *   counts        documents per type, published and drafts
 *   documents     every document in both must be equal, ignoring _rev, _createdAt, _updatedAt and
 *                 _system. Assets may also differ in uploadId (one per upload) and in path and url,
 *                 which contain the dataset name. An asset whose metadata only has extra keys on
 *                 one side (the upload asked Sanity to extract more, e.g. thumbHash) while every
 *                 shared key is equal is listed as explained; any other asset difference counts.
 *   portableText  sha256 of every blockContent field (the fields come from the Studio schema),
 *                 per document and field, plus one digest over all of them; the same digests of
 *                 transformed/<dataset>/data.ndjson tie the datasets to the transform output
 *   ndjson        sha256 of both transformed files, and the ids of documents that differ
 *
 * `secrets.mux` (the Mux plugin's token document) is never read into the report: only whether it
 * exists is listed. Writes reports/wp3/compare-<a>-<b>.json and .md (ids and hashes only, no
 * content) and exits non-zero when the datasets differ.
 */
import {existsSync, readFileSync} from 'node:fs'
import path from 'node:path'
import {parseArgs} from 'node:util'

import {
  ASSET_TYPES,
  MUX_SECRETS_ID,
  comparable,
  countByType,
  differingFields,
  digest,
  extraMetadataKeys,
  portableTextHashes,
  sha256,
  type Doc,
} from './comparison'
import {DATASETS, dataPaths, loadSecrets, type Dataset} from './config'
import {sanityClient} from './sanity'
import {ndjsonPath, readNdjson} from './steps/transform'
import {loadStudioSchema} from './transform/schema'
import {log, stableStringify, writeJson, writeText} from './util'

async function main(): Promise<void> {
  const {values} = parseArgs({
    options: {
      datasets: {type: 'string', default: 'staging,production'},
      'data-dir': {type: 'string'},
    },
    strict: true,
    allowPositionals: false,
  })
  const names = values.datasets.split(',').map((s) => s.trim())
  if (names.length !== 2 || names[0] === names[1] || !names.every((n) => (DATASETS as readonly string[]).includes(n))) {
    throw new Error(`--datasets must name two different datasets out of ${DATASETS.join(', ')}, e.g. staging,production`)
  }
  const [a, b] = names as [Dataset, Dataset]
  const paths = dataPaths(values['data-dir'])
  const secrets = loadSecrets(paths)
  const schema = await loadStudioSchema()
  const differences: string[] = []

  const read = async (dataset: Dataset) => {
    log(`compare: reading ${dataset}`)
    const docs = await sanityClient(dataset, secrets).fetch<Doc[]>(
      `*[!(_id in path("_.**")) && _id != $secrets]`,
      {secrets: MUX_SECRETS_ID},
    )
    const hasMuxSecrets = await sanityClient(dataset, secrets).fetch<boolean>(`defined(*[_id == $secrets][0]._id)`, {
      secrets: MUX_SECRETS_ID,
    })
    return {docs, byId: new Map(docs.map((d) => [d._id, d])), hasMuxSecrets}
  }
  const left = await read(a)
  const right = await read(b)

  // --- ids ----------------------------------------------------------------------------------
  const kind = (doc: Doc) => (ASSET_TYPES.has(doc._type) ? 'assets' : 'documents')
  const emptyIds = () => ({count: {[a]: 0, [b]: 0} as Record<string, number>, onlyIn: {[a]: [], [b]: []} as Record<string, string[]>})
  const ids = {documents: emptyIds(), assets: emptyIds()}
  for (const [name, side, other] of [[a, left, right], [b, right, left]] as const) {
    for (const doc of side.docs) {
      const entry = ids[kind(doc)]
      entry.count[name]!++
      if (!other.byId.has(doc._id)) entry.onlyIn[name]!.push(doc._id)
    }
  }
  for (const [what, entry] of Object.entries(ids)) {
    for (const name of [a, b]) {
      entry.onlyIn[name]!.sort()
      for (const id of entry.onlyIn[name]!) differences.push(`${what}: ${id} is only in ${name}`)
    }
  }

  // --- counts -------------------------------------------------------------------------------
  const counts = {[a]: countByType(left.docs), [b]: countByType(right.docs)}
  for (const type of [...new Set([...Object.keys(counts[a]!), ...Object.keys(counts[b]!)])].sort()) {
    const x = counts[a]![type]
    const y = counts[b]![type]
    if (stableStringify(x) !== stableStringify(y)) {
      differences.push(`counts: ${type} is ${stableStringify(x ?? {})} in ${a} and ${stableStringify(y ?? {})} in ${b}`)
    }
  }

  // --- documents ----------------------------------------------------------------------------
  let compared = 0
  let identical = 0
  const differentDocuments: {_id: string; fields: string[]}[] = []
  const explained: string[] = []
  for (const doc of left.docs) {
    const other = right.byId.get(doc._id)
    if (!other) continue
    compared++
    const x = comparable(doc, a)
    const y = comparable(other, b)
    if (stableStringify(x) === stableStringify(y)) {
      identical++
      continue
    }
    const fields = differingFields(x, y)
    const extra =
      ASSET_TYPES.has(doc._type) && fields.length === 1 && fields[0] === 'metadata'
        ? extraMetadataKeys(x.metadata, y.metadata)
        : null
    if (extra) {
      const sides = [
        ...extra.onlyInA.map((k) => `metadata.${k} only in ${a}`),
        ...extra.onlyInB.map((k) => `metadata.${k} only in ${b}`),
      ]
      explained.push(`${doc._id}: ${sides.join(', ')} (extracted at upload; every other metadata field is equal)`)
      continue
    }
    differentDocuments.push({_id: doc._id, fields})
    differences.push(`documents: ${doc._id} differs in ${fields.join(', ')}`)
  }

  // --- Portable Text ------------------------------------------------------------------------
  const ndjson = Object.fromEntries(
    [a, b].map((name) => {
      const file = ndjsonPath(paths, name)
      if (!existsSync(file)) throw new Error(`No transform output for ${name}: ${file}`)
      return [name, {file, sha256: sha256(readFileSync(file, 'utf8')), docs: readNdjson(file) as Doc[]}]
    }),
  ) as Record<Dataset, {file: string; sha256: string; docs: Doc[]}>
  const blockCount = (docs: Doc[]) =>
    docs.reduce(
      (n, doc) =>
        n + (schema.portableTextFields[doc._type] ?? []).reduce((m, f) => m + (Array.isArray(doc[f]) ? (doc[f] as unknown[]).length : 0), 0),
      0,
    )
  const ptLeft = portableTextHashes(left.docs, schema.portableTextFields)
  const ptRight = portableTextHashes(right.docs, schema.portableTextFields)
  const ptDifferent: string[] = []
  for (const key of [...new Set([...ptLeft.keys(), ...ptRight.keys()])].sort()) {
    if (ptLeft.get(key) !== ptRight.get(key)) {
      ptDifferent.push(key)
      differences.push(`portableText: ${key} is ${ptLeft.get(key)?.slice(0, 12) ?? 'absent'} in ${a} and ${ptRight.get(key)?.slice(0, 12) ?? 'absent'} in ${b}`)
    }
  }
  const portableText = {
    fieldsByType: schema.portableTextFields,
    fields: {[a]: ptLeft.size, [b]: ptRight.size},
    blocks: {[a]: blockCount(left.docs), [b]: blockCount(right.docs)},
    digest: {
      [a]: digest(ptLeft),
      [b]: digest(ptRight),
      [`${a} NDJSON`]: digest(portableTextHashes(ndjson[a].docs, schema.portableTextFields)),
      [`${b} NDJSON`]: digest(portableTextHashes(ndjson[b].docs, schema.portableTextFields)),
    },
    different: ptDifferent,
    hashes: Object.fromEntries([...ptLeft].map(([key, hash]) => [key, {[a]: hash, [b]: ptRight.get(key) ?? null}])),
  }
  for (const name of [a, b]) {
    if (portableText.digest[name] !== portableText.digest[`${name} NDJSON`]) {
      differences.push(`portableText: ${name} does not match its own transform output (${ndjson[name].file})`)
    }
  }

  // --- NDJSON -------------------------------------------------------------------------------
  const ndjsonById = (name: Dataset) => new Map(ndjson[name].docs.map((d) => [d._id, stableStringify(d)]))
  const nx = ndjsonById(a)
  const ny = ndjsonById(b)
  const ndjsonDifferent = [...new Set([...nx.keys(), ...ny.keys()])].filter((id) => nx.get(id) !== ny.get(id)).sort()
  for (const id of ndjsonDifferent) differences.push(`ndjson: ${id} differs between the two transform outputs`)

  const result = {
    datasets: [a, b],
    comparedAt: new Date().toISOString(),
    status: differences.length ? 'different' : 'identical',
    ids,
    counts,
    documents: {compared, identical, explained, different: differentDocuments},
    portableText,
    ndjson: {
      [a]: {file: ndjson[a].file, sha256: ndjson[a].sha256, documents: ndjson[a].docs.length},
      [b]: {file: ndjson[b].file, sha256: ndjson[b].sha256, documents: ndjson[b].docs.length},
      byteIdentical: ndjson[a].sha256 === ndjson[b].sha256,
      differentIds: ndjsonDifferent,
    },
    muxSecretsDocument: {[a]: left.hasMuxSecrets, [b]: right.hasMuxSecrets},
    differences,
  }
  const base = path.join(paths.reports, 'wp3', `compare-${a}-${b}`)
  writeJson(`${base}.json`, result)

  const allTypes = [...new Set([...Object.keys(counts[a]!), ...Object.keys(counts[b]!)])].sort()
  const fmt = (c?: {published: number; drafts: number; versions: number}) =>
    c ? `${c.published} + ${c.drafts} drafts${c.versions ? ` + ${c.versions} versions` : ''}` : '0'
  const md = [
    `# ${a} vs ${b}`,
    '',
    `Result: **${result.status.toUpperCase()}** (${differences.length} differences), ${result.comparedAt}`,
    '',
    `- Documents: ${ids.documents.count[a]} in ${a}, ${ids.documents.count[b]} in ${b}; assets: ${ids.assets.count[a]} and ${ids.assets.count[b]}.`,
    `- Compared ${compared} ids present in both: ${identical} identical (assets ignoring uploadId and the dataset name in path/url), ${explained.length} explained, ${differentDocuments.length} different.`,
    `- Portable Text: ${portableText.fields[a]} / ${portableText.fields[b]} blockContent fields, ${portableText.blocks[a]} / ${portableText.blocks[b]} blocks. Digest ${a} \`${portableText.digest[a]!.slice(0, 16)}\`, ${b} \`${portableText.digest[b]!.slice(0, 16)}\` (NDJSON: \`${portableText.digest[`${a} NDJSON`]!.slice(0, 16)}\`, \`${portableText.digest[`${b} NDJSON`]!.slice(0, 16)}\`).`,
    `- NDJSON: ${a} \`${ndjson[a].sha256.slice(0, 16)}\`, ${b} \`${ndjson[b].sha256.slice(0, 16)}\` (${result.ndjson.byteIdentical ? 'byte-identical' : `${ndjsonDifferent.length} documents differ`}).`,
    `- \`secrets.mux\` (not compared): ${a} ${left.hasMuxSecrets ? 'present' : 'absent'}, ${b} ${right.hasMuxSecrets ? 'present' : 'absent'}.`,
    '',
    `| Type | ${a} | ${b} |`,
    '|---|---|---|',
    ...allTypes.map((type) => `| ${type} | ${fmt(counts[a]![type])} | ${fmt(counts[b]![type])} |`),
    '',
    ...(differences.length ? ['## Differences', '', ...differences.map((d) => `- ${d}`), ''] : []),
    ...(explained.length ? ['## Explained', '', ...explained.map((e) => `- ${e}`), ''] : []),
  ].join('\n')
  writeText(`${base}.md`, md + '\n')

  log(`compare: ${a} ${ids.documents.count[a]} documents + ${ids.assets.count[a]} assets, ${b} ${ids.documents.count[b]} + ${ids.assets.count[b]}`)
  log(`compare: ${identical}/${compared} shared ids identical, ${explained.length} explained; Portable Text digest ${a} ${portableText.digest[a]!.slice(0, 16)}, ${b} ${portableText.digest[b]!.slice(0, 16)}`)
  log(`compare: NDJSON ${result.ndjson.byteIdentical ? 'byte-identical' : `differs in ${ndjsonDifferent.length} documents`}; report ${base}.md`)
  if (differences.length) {
    throw new Error(`${a} and ${b} differ (${differences.length}):\n- ${differences.slice(0, 50).join('\n- ')}`)
  }
  log(`compare: ${a} and ${b} are identical`)
}

main().catch((error: unknown) => {
  process.stderr.write(`\ncompare FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exit(1)
})
