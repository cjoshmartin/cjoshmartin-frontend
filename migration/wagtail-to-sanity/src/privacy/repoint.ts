/**
 * Finds where documents use asset ids and builds the patches that move them to the stripped copies.
 * Pure functions, no I/O.
 *
 * An asset id is used as a reference (`_ref`, for example `image.asset._ref`, a video block's
 * `file.asset._ref` and `original.asset._ref`) and in a few plain string fields the contract
 * defines:
 *
 *   asciiArtSource                 testimonial: the photo the ASCII art was made from
 *   <video>.conversion.sourceAssetId / outputAssetId
 *                                  video contract v2: the upload that was converted and the MP4
 *   source.id                      on a video-to-mp4 MP4 asset: the upload it was made from
 *
 * `privacy.strippedFrom` (round-1 copies only; copies now record a keyed digest,
 * `privacy.strippedFromDigest`, which is no asset id) and `privacy.replacementAssetId` on asset
 * documents record where a stripped copy came from (src/privacy/marker.ts). They name a deleted
 * upload on purpose, so they are provenance, not uses: they are reported separately and never moved.
 *
 * Every other string that equals an asset id is reported as unknown, and the privacy step stops
 * before writing anything: moving an id it does not understand could break a document.
 *
 * Replacing a reference keeps everything around it (crop, hotspot, alt text, caption, the block's
 * key), because only the id string changes.
 */

export interface Occurrence {
  /** Patch path, e.g. `body[_key=="ab12"].original.asset._ref`, `asciiArtSource`, `source.id`. */
  path: string
  /** The asset id found there. */
  id: string
  /** `reference` for a `_ref`, otherwise the field name the contract defines. */
  kind: 'reference' | 'asciiArtSource' | 'conversion' | 'source' | 'provenance'
}

const ASSET_TYPES = new Set(['sanity.imageAsset', 'sanity.fileAsset'])

function segment(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key
}

/**
 * Every place `doc` uses one of `ids`, split into the ones the contract defines (`known`), any other
 * string equal to an id (`unknown`), and the provenance fields of stripped copies (`provenance`,
 * not a use). The document's own `_id` is not a use.
 */
export function findAssetIdOccurrences(
  doc: {_id: string; _type: string; [field: string]: unknown},
  ids: ReadonlySet<string>,
): {known: Occurrence[]; unknown: Occurrence[]; provenance: Occurrence[]} {
  const known: Occurrence[] = []
  const unknown: Occurrence[] = []
  const provenance: Occurrence[] = []
  const isAsset = ASSET_TYPES.has(doc._type)

  const visit = (value: unknown, at: string, key: string | number | null, parentKey: string | null, depth: number) => {
    if (typeof value === 'string') {
      if (!ids.has(value) || at === '_id') return
      const occurrence = (kind: Occurrence['kind']) => known.push({path: at, id: value, kind})
      if (key === '_ref') occurrence('reference')
      else if (depth === 1 && key === 'asciiArtSource') occurrence('asciiArtSource')
      else if (parentKey === 'conversion' && (key === 'sourceAssetId' || key === 'outputAssetId')) occurrence('conversion')
      else if (isAsset && depth === 2 && parentKey === 'source' && key === 'id') occurrence('source')
      else if (isAsset && depth === 2 && parentKey === 'privacy' && (key === 'strippedFrom' || key === 'replacementAssetId')) provenance.push({path: at, id: value, kind: 'provenance'})
      else unknown.push({path: at, id: value, kind: 'reference'})
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const itemKey = item && typeof item === 'object' && typeof (item as {_key?: unknown})._key === 'string' ? (item as {_key: string})._key : null
        const selector = itemKey !== null ? `[_key==${JSON.stringify(itemKey)}]` : `[${index}]`
        visit(item, `${at}${selector}`, index, typeof key === 'string' ? key : parentKey, depth + 1)
      })
      return
    }
    if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) {
        visit(child, segment(at, childKey), childKey, typeof key === 'string' ? key : null, depth + 1)
      }
    }
  }
  for (const [field, value] of Object.entries(doc)) visit(value, field, field, null, 1)
  return {known, unknown, provenance}
}

/** The `set` operations that move every known occurrence to its replacement id. */
export function replacementSet(occurrences: readonly Occurrence[], replacements: ReadonlyMap<string, string>): Record<string, string> {
  const set: Record<string, string> = {}
  for (const occurrence of occurrences) {
    const replacement = replacements.get(occurrence.id)
    if (!replacement) throw new Error(`No replacement for ${occurrence.id} at ${occurrence.path}`)
    set[occurrence.path] = replacement
  }
  return set
}

/**
 * Applies a replacement set to a copy of the document (paths as built by findAssetIdOccurrences),
 * for checking what a patch will produce before it is sent.
 */
export function applyReplacementSet<T>(doc: T, set: Readonly<Record<string, string>>): T {
  const copy = structuredClone(doc)
  for (const [pathText, replacement] of Object.entries(set)) {
    const tokens = pathText.match(/[^.[\]]+|\[_key=="(?:[^"\\]|\\.)*"\]|\[\d+\]/g)
    if (!tokens) throw new Error(`Cannot parse path ${pathText}`)
    let target: unknown = copy
    for (const [index, token] of tokens.entries()) {
      const last = index === tokens.length - 1
      let next: unknown
      let assign: (value: string) => void
      if (token.startsWith('[_key==')) {
        const key = JSON.parse(token.slice('[_key=='.length, -1)) as string
        const items = target as {_key?: string}[]
        const position = items.findIndex((item) => item?._key === key)
        if (position < 0) throw new Error(`${pathText}: no item with _key ${key}`)
        next = items[position]
        assign = (value) => ((items as unknown[])[position] = value)
      } else if (token.startsWith('[')) {
        const position = Number(token.slice(1, -1))
        next = (target as unknown[])[position]
        assign = (value) => ((target as unknown[])[position] = value)
      } else {
        const object = target as Record<string, unknown>
        next = object[token]
        assign = (value) => (object[token] = value)
      }
      if (last) assign(replacement)
      else target = next
    }
  }
  return copy
}
