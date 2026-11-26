/**
 * What counts as personal metadata in an asset (owner decision, 2026-11-26: strip location and
 * personal metadata from every asset the public datasets serve, without re-encoding).
 *
 * Version 2 (2026-11-26, privacy review): the migrated assets follow the same policy as new uploads.
 * The image-privacy Function keeps only the orientation, the ICC profile and the technical data a
 * decoder needs, and the video originals keep only their video and audio streams and what playback
 * needs. Version 1 kept camera make, model, lens and software, capture times with their UTC offsets
 * (the time zone is a coarse location), free-text comments and XMP editing ids; version 2 removes
 * them too, with the same strippers the Functions use (studio/functions/privacy: image-strip.ts
 * for images, isobmff-video.ts for videos). See src/privacy/scan.ts.
 *
 * These rules are the independent second check: they read the tag list of
 * `exiftool -j -a -u -ee -G0:1:3` (src/privacy/exiftool.ts), whose keys are
 * "<family 0>:<family 1>:<family 3>:<tag name>", e.g. "EXIF:GPS:Main:GPSLatitude",
 * "MakerNotes:Apple:Main:ContentIdentifier", "QuickTime:Keys:Main:GPSCoordinates" or
 * "QuickTime:Track3:Doc12:GPSLatitude" (timed metadata, one document per sample). A tag is
 * personal when it is one of:
 *
 *   location      anything GPS, location, geotag, ISO 6709 or latitude/longitude, and the IPTC/XMP
 *                 place fields (City, State, Country, Sub-location, ...)
 *   maker-notes   every maker note (family 0 MakerNotes): vendor data with device and photo
 *                 identifiers, face and scene detection
 *   identifier    serial numbers and other device or capture identifiers (ImageUniqueID, Apple
 *                 ContentIdentifier/PhotoIdentifier, camera and device ids, owner names) and the
 *                 document and instance ids editing software writes (XMP xmpMM)
 *   person        names of people (artist, author, creator, by-line, credit, copyright, rights,
 *                 contact details) and face or person regions (XMP mwg-rs, MP regions)
 *   device        the camera, phone or computer and its software: make, model, lens, software,
 *                 host computer, XMP creator tool and toolkit, Android model and version
 *   capture-time  when the picture or video was taken or edited, with its UTC offset (a zero
 *                 QuickTime time, which the strippers write, is not a time)
 *   comment       free text: user comments, descriptions, titles, keywords, ratings
 *
 * Videos also count a track that is neither video nor audio (`data-track`): timed metadata
 * (`mebx`) carries location, motion and camera details, and any other data track can.
 * src/privacy/scan.ts adds `metadata` findings: what the Functions' strippers would remove
 * (anything but technical data) and, for videos, metadata the exiftool scan does not see (unused
 * bytes in `mdat`, location signatures outside the samples).
 *
 * Not personal (kept): the orientation and the ICC profile (the owner decision keeps them; the
 * ICC profile's own description, dates and device fields describe the colour profile), colour,
 * HDR and rendering data, image size and resolution, codec and handler descriptions, a converted
 * MP4's encoder name (the converter's), and the application, producer and dates of a PDF (an
 * attached document, not a photo or a video; it carries what its author put in it).
 */

export const PRIVACY_RULES_VERSION = 'personal-metadata-v2'

export type FindingCategory =
  | 'location'
  | 'maker-notes'
  | 'identifier'
  | 'person'
  | 'device'
  | 'capture-time'
  | 'comment'
  | 'data-track'
  | 'metadata'

export interface Finding {
  /**
   * The exiftool key ("<family 0>:<family 1>:<family 3>:<tag>"), "Track<n>:<handler>/<entry>", or
   * "ImageStrip:<item>" / "Container:<problem>" for `metadata` findings (src/privacy/scan.ts).
   */
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
/** XMP xmpMM and Photoshop ids that link a file to its editing sessions and source files. */
const EDITING_ID_NAME = /^(DocumentID|InstanceID|OriginalDocumentID|PreservedFileName|DocumentAncestors|DerivedFrom.*|History.*|Ingredients.*|Manifest.*|Pantry.*)$/
/** The camera, phone or computer and its software. */
const DEVICE_NAME = /^(Make|Model|Software|HostComputer|ProcessingSoftware|CreatorTool|XMPToolkit|Lens|LensID|LensInfo|LensMake|LensModel|LensSpecification|LensType|CameraModelName|UniqueCameraModel|LocalizedCameraModel|Android.*)$/
/** Capture and editing times, and their UTC offsets. */
const CAPTURE_TIME_NAME = /^(DateTime|DateTimeOriginal|DateTimeDigitized|DateTimeCreated|CreateDate|ModifyDate|MetadataDate|CreationDate|ContentCreateDate|TrackCreateDate|TrackModifyDate|MediaCreateDate|MediaModifyDate|DateCreated|TimeCreated|DigitalCreationDate|DigitalCreationTime|DigitalCreationDateTime|SubSecTime.*|SubSecDateTime.*|SubSecCreateDate|SubSecModifyDate|OffsetTime.*|TimeZone|TimeZoneOffset)$/
/** Free text. */
const COMMENT_NAME = /^(UserComment|ImageDescription|XPComment|XPSubject|XPTitle|XPKeywords|Comment|Description|Caption-Abstract|Headline|Keywords|Subject|Title|Label|Rating|RatingPercent|Instructions|Notes)$/
/**
 * Groups whose device, time and text tags describe something other than the capture: the ICC
 * profile (kept by the owner decision; its device fields and date are the profile's) and PDF
 * documents (their application, producer, dates and title are the document's).
 */
const DESCRIBES_OTHER = new Set(['ICC_Profile', 'PDF'])

/** Whether a date value is unset: QuickTime writes zero times as "0000:00:00 00:00:00". */
function isZeroTime(value: unknown): boolean {
  if (value === undefined || value === null) return true
  const text = String(value).trim()
  return text === '' || /^0000:00:00(?: 00:00:00)?/.test(text)
}
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

/**
 * The category of one exiftool tag, or null when it is not personal. `value` decides only for
 * capture times: a zero time is no time.
 */
export function classifyTag(key: string, value?: unknown): FindingCategory | null {
  const tag = parseTagKey(key)
  if (!tag) return null
  // A JPEG COM segment is reported in the File group.
  if (tag.family0 === 'File' && tag.name === 'Comment') return 'comment'
  if (FILE_GROUPS.has(tag.family0)) return null
  if (tag.family0 === 'MakerNotes' || tag.name.startsWith('MakerNote')) return 'maker-notes'
  if (tag.family1 === 'GPS' || LOCATION_NAME.test(tag.name) || PLACE_NAMES.has(tag.name)) return 'location'
  if (IDENTIFIER_NAME.test(tag.name)) return 'identifier'
  // A PDF's Creator (and Producer) name the application that made it.
  if (tag.family0 === 'PDF' && tag.name === 'Creator') return null
  if (PERSON_NAMES.has(tag.name) || PERSON_NAME_PART.test(tag.name)) return 'person'
  if (DESCRIBES_OTHER.has(tag.family0)) return null
  if (tag.family1.startsWith('XMP') && EDITING_ID_NAME.test(tag.name)) return 'identifier'
  if (DEVICE_NAME.test(tag.name)) return 'device'
  if (CAPTURE_TIME_NAME.test(tag.name)) return isZeroTime(value) ? null : 'capture-time'
  if (COMMENT_NAME.test(tag.name)) return 'comment'
  return null
}

/** Every personal tag in an exiftool tag list, sorted by key. */
export function findPersonalTags(tags: Readonly<Record<string, unknown>>): Finding[] {
  const findings: Finding[] = []
  for (const [key, value] of Object.entries(tags)) {
    const category = classifyTag(key, value)
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
