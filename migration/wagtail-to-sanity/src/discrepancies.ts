/**
 * Every difference between the Wagtail file records and the files in the bucket, with the
 * evidence that explains it. The extract step compares what it finds with this list and fails
 * on anything that is not listed here (or listed but no longer found), so a new or changed
 * discrepancy can never slip through unexplained.
 *
 * Evidence comes from export.json, dumpdata.json (wagtailcore.modellogentry) and the bucket
 * listing (`gsutil ls -l`, object creation times; the bucket has no object versioning, so every
 * object has exactly one generation and overwritten bytes are gone).
 *
 * Wagtail stored files through django-storages' Google Cloud backend, which overwrites an object
 * when a new upload has the same name (GS_FILE_OVERWRITE defaults to true) instead of picking a
 * new name. That is the cause of the hash mismatches below.
 *
 * A sha1 whose Sanity asset was deleted (the privacy step replaced it with a copy without personal
 * metadata) is given by its first 8 hex digits only: the repository is public, and a full sha1 is
 * the deleted asset's id and CDN path. The other sha1s are given in full. Compare a sha1 of this
 * list with sha1Matches, never with ===.
 */

/** The fields of a discrepancy that hold a sha1 (full, or the first 8 hex digits). */
export const SHA1_FIELDS: ReadonlySet<string> = new Set(['recordedSha1', 'bucketSha1', 'sha1'])

const FULL_SHA1 = /^[0-9a-f]{40}$/
const SHA1_PREFIX = /^[0-9a-f]{8}$/

/**
 * Whether `observed` is the sha1 an explanation names as `explained`: the same string, or a full
 * sha1 that starts with the 8 hex digits `explained` gives.
 */
export function sha1Matches(observed: unknown, explained: string): boolean {
  if (typeof observed !== 'string') return false
  if (observed === explained) return true
  return SHA1_PREFIX.test(explained) && FULL_SHA1.test(observed) && observed.startsWith(explained)
}

export interface ImageHashMismatch {
  kind: 'image-hash-mismatch'
  recordId: number
  file: string
  recordedSha1: string
  bucketSha1: string
  explanation: string
}

export interface ImageFileMissing {
  kind: 'image-file-missing'
  recordId: number
  file: string
  recordedSha1: string
  explanation: string
}

export interface SharedFile {
  kind: 'image-records-share-file'
  recordIds: number[]
  file: string
  explanation: string
}

export interface OrphanFile {
  kind: 'file-without-record'
  file: string
  sha1: string
  explanation: string
}

export type KnownDiscrepancy = ImageHashMismatch | ImageFileMissing | SharedFile | OrphanFile

const OVERWRITE_NOTE =
  'django-storages overwrote the object when a later upload used the same file name. The site ' +
  'serves the current bytes (its renditions were generated from them), so the migration uploads ' +
  'the current bytes; the Sanity asset sha1 is the bucket sha1, not the stale recorded hash.'

const ORPHAN_NOTE =
  'No Wagtail image record points at it and no record has its sha1. Image ids have a single ' +
  'gap (id 4, logged as deleted on 2024-02-15), so it was not left behind by a deleted record; ' +
  'how it got into the bucket is not recorded. Uploaded as a standalone asset (D14: every ' +
  'content file migrates).'

export const KNOWN_DISCREPANCIES: KnownDiscrepancy[] = [
  {
    kind: 'image-hash-mismatch',
    recordId: 3,
    file: 'original_images/bad_ideas.png',
    recordedSha1: '0a0cced9218965ddef92ee014f5789a5efb73294',
    bucketSha1: '46c0bedf',
    explanation:
      'Record 3 (uploaded 2024-02-15T18:05:33Z, 908,149 bytes, 2784x1798) points at an object ' +
      'that was rewritten on 2024-08-29T23:44:03Z with 227,110 bytes (992x1166) that are ' +
      'byte-identical to original_images/bad_ideass.png (record 21). No Wagtail record or log ' +
      'entry matches that time; the rendition images/bad_ideas.max-165x165.png was regenerated ' +
      'two seconds later. The live project page 5 already shows these bytes (it links ' +
      'original_images/bad_ideas.png directly). The 2784x1798 original is not recoverable. ' +
      'Referenced by page 5 content_image.',
  },
  {
    kind: 'image-hash-mismatch',
    recordId: 7,
    file: 'original_images/IMG_9514.jpg',
    recordedSha1: '52ca3deabbc1f685ffcc894ef4ce5b101a791d22',
    bucketSha1: 'c447bc43',
    explanation:
      'Record 7 (2024-02-15, 184x245, 11,160 bytes) and record 28 (2024-03-15T23:27:05Z, ' +
      '4032x3024) use the same file name. The object was created 2024-03-15T23:27:04Z and its ' +
      'sha1 equals record 28\'s file_hash. ' +
      OVERWRITE_NOTE +
      ' Record 7 is not referenced by any migrated content.',
  },
  {
    kind: 'image-hash-mismatch',
    recordId: 33,
    file: 'original_images/68210293554__B6DC7299-3528-444D-BE9A-23151FDA681F.jpg',
    recordedSha1: '05ef1cc032a6201729e94fdfb5868d2b4444c0ba',
    bucketSha1: '94eeebf0',
    explanation:
      'Record 33 (2024-03-17T16:56:17Z) and record 36 (2024-03-17T17:19:14Z) use the same file ' +
      'name. The object was created 2024-03-17T17:19:14Z and its sha1 equals record 36\'s ' +
      'file_hash. ' +
      OVERWRITE_NOTE +
      ' Record 33 is not referenced by any migrated content.',
  },
  {
    kind: 'image-hash-mismatch',
    recordId: 80,
    file: 'original_images/Screenshot_2024-08-05_at_4.40.35PM.png',
    recordedSha1: 'b506f937290ceba398b68a37ee2f3f51e57b603f',
    bucketSha1: 'f392b7b8',
    explanation:
      'Record 80 (2024-08-05T21:40:51Z) and record 81 (2024-08-05T21:44:28Z) use the same file ' +
      'name. The object was created 2024-08-05T21:44:27Z and its sha1 equals record 81\'s ' +
      'file_hash. ' +
      OVERWRITE_NOTE +
      ' Record 80 is not referenced by any migrated content.',
  },
  {
    kind: 'image-file-missing',
    recordId: 5,
    file: 'original_images/bad_ideas2.png',
    recordedSha1: '46c0bedf',
    explanation:
      'The object no longer exists (its rendition images/bad_ideas2.max-165x165.png from ' +
      '2024-02-15T18:06:23Z shows it once did). Record 5 is not referenced by any migrated ' +
      'content, and its recorded sha1 is byte-identical to original_images/bad_ideass.png ' +
      '(record 21), which is migrated, so no image content is lost.',
  },
  {
    kind: 'image-records-share-file',
    recordIds: [48, 50],
    file: 'original_images/ezgif.com-gif-maker-11.gif',
    explanation:
      'The same GIF was uploaded twice (2024-03-24T02:14:50Z and 02:20:06Z) under the same ' +
      'name; both records have the same file_hash as the object. One Sanity asset serves both ' +
      'records. Neither record is referenced by migrated content.',
  },
  {
    kind: 'image-records-share-file',
    recordIds: [95, 97],
    file: 'original_images/Screenshot_2025-04-23_at_12.18.48AM.png',
    explanation:
      'The same screenshot was uploaded twice (2025-04-23T05:19:49Z and 16:09:13Z) under the ' +
      'same name; both records have the same file_hash as the object. One Sanity asset serves ' +
      'both records (record 95 is used by page 23).',
  },
  {
    kind: 'file-without-record',
    file: 'original_images/IMG_5861.JPG',
    sha1: '7adc0977',
    explanation: 'Object created 2024-03-01T07:23:04Z. ' + ORPHAN_NOTE,
  },
  {
    kind: 'file-without-record',
    file: 'original_images/l_9b2d50321e9961d76b0e4ee281eee759.jpg',
    sha1: 'f991425d',
    explanation: 'Object created 2024-03-02T04:37:06Z. ' + ORPHAN_NOTE,
  },
  {
    kind: 'file-without-record',
    file: 'original_images/IMG_9232.JPG',
    sha1: 'aa53a247',
    explanation: 'Object created 2024-08-29T16:09:00Z. ' + ORPHAN_NOTE,
  },
  {
    kind: 'file-without-record',
    file: 'original_images/Sun_Symbol_of_the_National_Flag_of_the_Philippines.svg.png',
    sha1: '14fe8d47',
    explanation: 'Object created 2025-05-29T03:08:33Z. ' + ORPHAN_NOTE,
  },
  {
    kind: 'file-without-record',
    file: 'documents/Josh Martin - Resume - 2025.pdf',
    sha1: '9ba389784dd9e3fe31a468b8a899813c84fff370',
    explanation:
      'Object created 2025-09-10T18:01:40Z. Its name contains spaces, which Django\'s storage ' +
      'layer would have replaced with underscores, so it was put in the bucket directly rather ' +
      'than uploaded through Wagtail; there is no document record. Uploaded as a standalone file ' +
      'asset (D14).',
  },
]
