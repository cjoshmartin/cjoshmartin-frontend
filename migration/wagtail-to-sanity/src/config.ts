/**
 * Paths, constants and secrets for the Wagtail -> Sanity migration.
 *
 * Migration data never lives in the repo. It lives in ~/cjoshmartin-migration (mode 700):
 *   wagtail-export.zip          the "Export for Sanity" zip from the Wagtail admin
 *   extracted/                  the unzipped export (export.json, dumpdata.json, manifest.json)
 *   gcs/                        local copy of the bucket's content folders
 *   video-mp4/media-<id>/       the Wagtail videos converted to MP4 (convert step)
 *   state/                      maps that make reruns converge (assets, MP4s, videos, ASCII art)
 *   transformed/<dataset>/      NDJSON written by the transform step
 *   reports/                    detailed data reports (never committed)
 */
import {existsSync} from 'node:fs'
import {homedir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

/** Sanity project of cjoshmartin.com. */
export const PROJECT_ID = 'j3vdh6ti'

/** Content Lake API version, the same date the Studio uses. */
export const API_VERSION = '2026-11-01'

/** Datasets this migration may write to. Production needs --confirm-production. */
export const DATASETS = ['staging', 'production'] as const
export type Dataset = (typeof DATASETS)[number]

/** The public bucket the Wagtail backend stored its files in. */
export const GCS_BUCKET = 'images-for-cms'
export const GCS_PUBLIC_BASE_URL = `https://storage.googleapis.com/${GCS_BUCKET}/`

/**
 * Bucket folders that hold content. images/ (renditions) is derived data and the other folders
 * (admin/, css/, wagtail*, rest_framework/) are Django static files; none of those are migrated.
 */
export const GCS_CONTENT_FOLDERS = [
  'original_images',
  'documents',
  'media',
  'media_thumbnails',
] as const
export type GcsContentFolder = (typeof GCS_CONTENT_FOLDERS)[number]

/** `source.name` on every Sanity asset uploaded by this migration. */
export const ASSET_SOURCE_NAME = 'wagtail'

/**
 * `source.id` of the asset holding a Wagtail video as it was uploaded (the `original` of its
 * video block). The converted MP4 has source {name: "video-to-mp4", id: <that asset's _id>}.
 */
export function mediaAssetSourceId(mediaId: number): string {
  return `media-${mediaId}`
}

const here = path.dirname(fileURLToPath(import.meta.url))

/** migration/wagtail-to-sanity/ */
export const PACKAGE_DIR = path.resolve(here, '..')

/** Repo root of cjoshmartin-frontend. */
export const REPO_DIR = path.resolve(PACKAGE_DIR, '..', '..')

/** The standalone Studio. Its schema is the target of this migration. */
export const STUDIO_DIR = path.join(REPO_DIR, 'studio')

/** The WP2 ASCII-art generator module (shared with the testimonial-ascii-art Function). */
export const ASCII_FUNCTION_DIR = path.join(STUDIO_DIR, 'functions', 'testimonial-ascii-art')

export interface DataPaths {
  root: string
  exportZip: string
  extracted: string
  exportJson: string
  dumpdataJson: string
  manifestJson: string
  gcs: string
  videoMp4: string
  state: string
  transformed: string
  reports: string
  liveSnapshot: string
  secretsFile: string
}

export function dataPaths(root: string = path.join(homedir(), 'cjoshmartin-migration')): DataPaths {
  const extracted = path.join(root, 'extracted')
  return {
    root,
    exportZip: path.join(root, 'wagtail-export.zip'),
    extracted,
    exportJson: path.join(extracted, 'export.json'),
    dumpdataJson: path.join(extracted, 'dumpdata.json'),
    manifestJson: path.join(extracted, 'manifest.json'),
    gcs: path.join(root, 'gcs'),
    videoMp4: path.join(root, 'video-mp4'),
    state: path.join(root, 'state'),
    transformed: path.join(root, 'transformed'),
    reports: path.join(root, 'reports'),
    liveSnapshot: path.join(root, 'live-api-snapshot'),
    secretsFile: path.join(root, 'secrets.env'),
  }
}

export interface Secrets {
  sanityWriteToken: string
}

/**
 * Reads the secrets from the environment. When they are not set, loads secrets.env from the
 * migration data folder first (the same file `set -a; . secrets.env` would read). Values are
 * never logged.
 */
export function loadSecrets(paths: DataPaths): Secrets {
  const needed = ['SANITY_WRITE_TOKEN'] as const
  if (needed.some((name) => !process.env[name]) && existsSync(paths.secretsFile)) {
    process.loadEnvFile(paths.secretsFile)
  }
  const missing = needed.filter((name) => !process.env[name])
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(', ')}. Set them in the environment or in ${paths.secretsFile}.`,
    )
  }
  if (process.env.SANITY_PROJECT_ID && process.env.SANITY_PROJECT_ID !== PROJECT_ID) {
    throw new Error(
      `SANITY_PROJECT_ID is ${process.env.SANITY_PROJECT_ID}, but this migration targets ${PROJECT_ID}`,
    )
  }
  return {
    sanityWriteToken: process.env.SANITY_WRITE_TOKEN as string,
  }
}

/** Public URL of a bucket object (path relative to the bucket root, e.g. "media/IMG_3151.MOV"). */
export function gcsPublicUrl(objectPath: string): string {
  return GCS_PUBLIC_BASE_URL + objectPath.split('/').map(encodeURIComponent).join('/')
}
