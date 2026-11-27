import {StreamLanguage} from '@codemirror/language'
import {codeInput} from '@sanity/code-input'
import {EarthGlobeIcon} from '@sanity/icons/EarthGlobe'
import {HomeIcon} from '@sanity/icons/Home'
import {RocketIcon} from '@sanity/icons/Rocket'
import {visionTool} from '@sanity/vision'
import type {ComponentType} from 'react'
import {defineConfig, defineSingleton, type WorkspaceOptions} from 'sanity'
import {presentationTool} from 'sanity/presentation'
import {structureTool} from 'sanity/structure'

import {VideoConversionDocumentInput} from './components/VideoConversionWatcher'
import {
  API_VERSION,
  PRODUCTION_DATASET,
  PROJECT_ID,
  SITE_URL,
  STAGING_DATASET,
  VERCEL_PREVIEW_ORIGIN,
} from './lib/constants'
import {resolve} from './presentation/resolve'
import {HOME_PAGE_ID, schemaTypes} from './schemaTypes'
import {structure} from './structure'

/**
 * Site the Presentation tool opens. Defaults to production; set SANITY_STUDIO_PREVIEW_URL
 * (for example http://localhost:3000) when running `sanity dev` against a local Next.js app.
 */
const PREVIEW_URL = process.env.SANITY_STUDIO_PREVIEW_URL || SITE_URL

/**
 * Origins allowed to talk to Presentation: local dev, this project's Vercel preview deployments
 * and the live site. Any allowed origin can read drafts through the preview iframe, so Vercel is
 * limited to this project and team instead of every *.vercel.app site.
 */
const PREVIEW_ORIGINS = [
  'http://localhost:*',
  VERCEL_PREVIEW_ORIGIN,
  'https://cjoshmartin.com',
  'https://www.cjoshmartin.com',
]

/** Actions removed from the home page singleton so it can never disappear from the site. */
const HOME_PAGE_REMOVED_ACTIONS = new Set(['delete', 'duplicate', 'unpublish'])

interface WorkspaceSettings {
  name: string
  dataset: string
  subtitle: string
  icon: ComponentType
}

/** Both workspaces share the schema, structure and plugins; only the dataset differs. */
function workspace({name, dataset, subtitle, icon}: WorkspaceSettings): WorkspaceOptions {
  return {
    name,
    basePath: `/${name}`,
    title: 'cjoshmartin.com',
    subtitle,
    icon,
    projectId: PROJECT_ID,
    dataset,
    plugins: [
      structureTool({structure}),
      presentationTool({
        previewUrl: {
          initial: PREVIEW_URL,
          previewMode: {enable: '/api/draft-mode/enable'},
        },
        allowOrigins: PREVIEW_ORIGINS,
        resolve,
      }),
      visionTool({defaultApiVersion: API_VERSION, defaultDataset: dataset}),
      codeInput({
        codeModes: [
          {
            name: 'cpp',
            loader: () =>
              import('@codemirror/legacy-modes/mode/clike').then(({cpp}) =>
                StreamLanguage.define(cpp),
              ),
          },
        ],
      }),
    ],
    schema: {types: schemaTypes},
    // Restarts stuck video conversions while a document that can hold videos is open.
    form: {components: {input: VideoConversionDocumentInput}},
    document: {
      singletons: [
        defineSingleton({
          documentId: HOME_PAGE_ID,
          schemaType: 'homePage',
          title: 'Home',
          icon: HomeIcon,
        }),
      ],
      actions: (prev, context) =>
        context.schemaType === 'homePage'
          ? prev.filter(({action}) => !action || !HOME_PAGE_REMOVED_ACTIONS.has(action))
          : prev,
    },
  }
}

export default defineConfig([
  workspace({
    name: 'production',
    dataset: PRODUCTION_DATASET,
    subtitle: 'Production (live site)',
    icon: EarthGlobeIcon,
  }),
  workspace({
    name: 'staging',
    dataset: STAGING_DATASET,
    subtitle: 'Staging (test copy)',
    icon: RocketIcon,
  }),
])
