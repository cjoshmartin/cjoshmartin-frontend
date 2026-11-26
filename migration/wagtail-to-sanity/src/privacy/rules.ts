/**
 * What counts as personal metadata in an asset (owner decision, 2026-11-26: strip location and
 * personal metadata from every asset the public datasets serve, without re-encoding).
 *
 * The rules read the tag list of `exiftool -j -a -u -ee -G0:1:3` (src/privacy/exiftool.ts), whose
 * keys are "<family 0>:<family 1>:<family 3>:<tag name>", e.g. "EXIF:GPS:Main:GPSLatitude",
 * "MakerNotes:Apple:Main:ContentIdentifier", "QuickTime:Keys:Main:GPSCoordinates" or
 * "QuickTime:Track3:Doc12:GPSLatitude" (timed metadata, one document per sample). A tag is
 * personal when it is one of:
 *
 *   location     anything GPS, location, geotag, ISO 6709 or latitude/longitude, and the IPTC/XMP
 *                place fields (City, State, Country, Sub-location, ...)
 *   maker-notes  every maker note (family 0 MakerNotes): vendor data with device and photo
 *                identifiers, face and scene detection
 *   identifier   serial numbers and other device or capture identifiers (ImageUniqueID, Apple
 *                ContentIdentifier/PhotoIdentifier, camera and device ids, owner names)
 *   person       names of people (artist, author, creator, by-line, credit, copyright, rights,
 *                contact details) and face or person regions (XMP mwg-rs, MP regions)
 *
 * Videos also count a track that is neither video nor audio (`data-track`): timed metadata
 * (`mebx`) carries location, motion and camera details, and any other data track can.
 *
 * Not personal (kept): the orientation and the ICC profile (the owner decision keeps them), colour,
 * HDR and rendering data, image size and resolution, the camera make, model, lens and software
 * name (a device type, not a person or a device), capture settings, timestamps, free-text titles
 * and comments, and the document and instance ids that editing software (XMP xmpMM) writes: they
 * identify an editing session, not a person, a device or a place. A PDF's `Creator` is the
 * authoring application, not a person.
 */

export const PRIVACY_RULES_VERSION = 'personal-metadata-v1'

export type FindingCategory = 'location' | 'maker-notes' | 'identifier' | 'person' | 'data-track'

export interface Finding {
  /** The exiftool key ("<family 0>:<family 1>:<family 3>:<tag>"), or "Track<n>:<handler>/<entry>". */
  tag: string
  category: FindingCategory
}

export interface TagKey {
  family0: string
  family1: string
  family3: string
  name: string
}

/**
 * Splits an exiftool -G0:1:3 key; null for keys without groups (SourceFile). exiftool leaves out
 * the family 1 group when it equals the family 0 group ("ICC_Profile:Main:ProfileDescription",
 * "Composite:Main:GPSPosition", "QuickTime:Main:MediaData"), so a key has three or four parts.
 */
export function parseTagKey(key: string): TagKey | null {
  const parts = key.split(':')
  if (parts.length === 4) {
    const [family0, family1, family3, name] = parts as [string, string, string, string]
    return {family0, family1, family3, name}
  }
  if (parts.length === 3) {
    const [family0, family3, name] = parts as [string, string, string]
    return {family0, family1: family0, family3, name}
  }
  return null
}

/** Groups whose tags describe the file itself (exiftool's own and the file system's), never content. */
const FILE_GROUPS = new Set(['ExifTool', 'File', 'System'])

const LOCATION_NAME = /GPS|Location|ISO6709|GeoTag|Geolocation|Latitude|Longitude/i
const PLACE_NAMES = new Set([
  'City',
  'State',
  'Country',
  'CountryCode',
  'CountryName',
  'Province-State',
  'Sub-location',
  'Sublocation',
  'WorldRegion',
  'CountryPrimaryLocationCode',
  'CountryPrimaryLocationName',
])
const IDENTIFIER_NAME = /Serial|ImageUniqueID|ContentIdentifier|PhotoIdentifier|CameraIdentifier|CameraID|DeviceID|BodyID|OwnerName/i
const PERSON_NAMES = new Set([
  'Artist',
  'Author',
  'XPAuthor',
  'Creator',
  'By-line',
  'By-lineTitle',
  'Writer-Editor',
  'CaptionWriter',
  'Credit',
  'Contact',
  'Copyright',
  'CopyrightNotice',
  'Rights',
  'LastModifiedBy',
  'PersonInImage',
  'PersonInImageName',
  'Contributor',
  'Publisher',
])
/** Case-sensitive on purpose: "Face" and "Region" start a word in exiftool's CamelCase names. */
const PERSON_NAME_PART = /Face|Region|PersonInImage|CreatorContact|CreatorAddress|CreatorCity|CreatorCountry|CreatorPostalCode|CreatorRegion|CreatorWork|Email|Phone|Address/

/** The category of one exiftool tag, or null when it is not personal. */
export function classifyTag(key: string): FindingCategory | null {
  const tag = parseTagKey(key)
  if (!tag || FILE_GROUPS.has(tag.family0)) return null
  if (tag.family0 === 'MakerNotes' || tag.name.startsWith('MakerNote')) return 'maker-notes'
  if (tag.family1 === 'GPS' || LOCATION_NAME.test(tag.name) || PLACE_NAMES.has(tag.name)) return 'location'
  if (IDENTIFIER_NAME.test(tag.name)) return 'identifier'
  // A PDF's Creator (and Producer) name the application that made it.
  if (tag.family0 === 'PDF' && tag.name === 'Creator') return null
  if (PERSON_NAMES.has(tag.name) || PERSON_NAME_PART.test(tag.name)) return 'person'
  return null
}

/** Every personal tag in an exiftool tag list, sorted by key. */
export function findPersonalTags(tags: Readonly<Record<string, unknown>>): Finding[] {
  const findings: Finding[] = []
  for (const key of Object.keys(tags)) {
    const category = classifyTag(key)
    if (category) findings.push({tag: key, category})
  }
  return findings.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
}

/** Track handlers that are not personal data: the picture and the sound. */
export const MEDIA_HANDLERS: ReadonlySet<string> = new Set(['vide', 'soun'])

/** A `data-track` finding for each track that is neither video nor audio. */
export function findDataTracks(tracks: readonly {index: number; handler: string; sampleEntry: string}[]): Finding[] {
  return tracks
    .filter((t) => !MEDIA_HANDLERS.has(t.handler))
    .map((t) => ({tag: `Track${t.index}:${t.handler}/${t.sampleEntry}`, category: 'data-track' as const}))
}

/**
 * The 80-byte header of a binary STL file is free text that exiftool does not read. A header is
 * accepted when it is blank or one of the known exporter signatures below; anything else is
 * reported as `person` (unreviewed free text), so a name or a path in it is never waved through.
 */
const KNOWN_STL_HEADERS: readonly RegExp[] = [
  // Autodesk Fusion / Inventor (ATF translator) with its default colour.
  /^STLB ATF [\d.]+ COLOR=[\s\S]{4}\s*$/,
]

export interface StlHeader {
  binary: boolean
  /** Printable view of the header (non-printable bytes as "."), at most 80 characters. */
  text: string
  known: boolean
}

/**
 * Reads the header of an STL model from its first bytes (at least 84 for a binary model) and the
 * file's size: binary when the size is 84 + 50 bytes per facet, ASCII ("solid <name>") otherwise.
 */
export function readStlHeader(head: Buffer, fileSize: number): StlHeader {
  const binary = head.length >= 84 && fileSize === 84 + 50 * head.readUInt32LE(80)
  if (!binary) {
    // ASCII STL: "solid <name>" on the first line; the name is free text.
    const firstLine = head.toString('latin1', 0, Math.min(head.length, 256)).split(/\r?\n/)[0] ?? ''
    const name = firstLine.replace(/^solid\s*/, '').trim()
    return {binary: false, text: firstLine.slice(0, 80), known: firstLine.startsWith('solid') && name === ''}
  }
  const latin1 = head.toString('latin1', 0, 80)
  const text = latin1.replace(/[^\x20-\x7e]/g, '.')
  const known = latin1.trim() === '' || /^\0*$/.test(latin1) || KNOWN_STL_HEADERS.some((pattern) => pattern.test(latin1))
  return {binary: true, text, known}
}

export function findStlHeaderFindings(header: StlHeader): Finding[] {
  return header.known ? [] : [{tag: `STL:Header:Main:${header.binary ? 'BinaryHeader' : 'SolidName'}`, category: 'person'}]
}
