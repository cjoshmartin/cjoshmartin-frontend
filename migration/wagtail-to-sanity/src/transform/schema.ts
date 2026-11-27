/**
 * Compiles the Studio's schema (studio/schemaTypes plus the `code` type from @sanity/code-input,
 * exactly as sanity.config.ts registers them) so the rich-text conversion uses the real
 * `blockContent` definition: its styles, lists, decorators, annotations and block types. Nothing
 * about the schema is duplicated here.
 *
 * The Studio packages resolve from studio/node_modules, so `npm ci` must have run in studio/.
 */
import {existsSync} from 'node:fs'
import path from 'node:path'

import {Schema} from '@sanity/schema'
import {builtinTypes, groupProblems, validateSchema} from '@sanity/schema/_internal'
import type {ArraySchemaType, ObjectSchemaType} from '@sanity/types'

import {STUDIO_DIR} from '../config'

export interface StudioSchema {
  blockContent: ArraySchemaType
  /** Names of the decorators, annotations, styles and lists the block type allows. */
  block: {
    styles: string[]
    lists: string[]
    decorators: string[]
    annotations: string[]
  }
  /** Non-block member types of blockContent (imageBlock, youtube, code, ...). */
  blockObjects: string[]
  /** Document type -> names of its top-level blockContent fields (e.g. blogPost -> ["body"]). */
  portableTextFields: Record<string, string[]>
  /** Studio constants (stored codes and option lists). */
  constants: typeof import('../../../../studio/schemaTypes/constants')
  validation: typeof import('../../../../studio/schemaTypes/shared/validation')
}

let cached: Promise<StudioSchema> | undefined

export function loadStudioSchema(): Promise<StudioSchema> {
  cached ??= compile()
  return cached
}

async function compile(): Promise<StudioSchema> {
  const studioModules = path.join(STUDIO_DIR, 'node_modules')
  for (const pkg of ['sanity', '@sanity/code-input']) {
    if (!existsSync(path.join(studioModules, pkg, 'package.json'))) {
      throw new Error(`${pkg} is not installed in ${studioModules}; run "npm ci" in ${STUDIO_DIR}`)
    }
  }
  const {schemaTypes} = (await import(path.join(STUDIO_DIR, 'schemaTypes', 'index.ts'))) as {
    schemaTypes: unknown[]
  }
  const constants = (await import(
    path.join(STUDIO_DIR, 'schemaTypes', 'constants.ts')
  )) as StudioSchema['constants']
  const validation = (await import(
    path.join(STUDIO_DIR, 'schemaTypes', 'shared', 'validation.ts')
  )) as StudioSchema['validation']
  const {codeSchema} = (await import(path.join(studioModules, '@sanity/code-input', 'dist', 'index.js'))) as {
    codeSchema: unknown
  }

  const types = [...schemaTypes, codeSchema]
  const errors = groupProblems(
    validateSchema(types as never, {parentTypes: builtinTypes} as never).getTypes(),
  ).filter((group) => group.problems.some((problem) => problem.severity === 'error'))
  if (errors.length) throw new Error(`The Studio schema has errors: ${JSON.stringify(errors)}`)

  const schema = Schema.compile({name: 'cjoshmartin-migration', types: [...builtinTypes, ...types]})
  const blockContent = schema.get('blockContent') as ArraySchemaType | undefined
  if (!blockContent || blockContent.jsonType !== 'array') throw new Error('blockContent is not an array type')
  const blockType = blockContent.of.find((member) => member.name === 'block') as ObjectSchemaType | undefined
  if (!blockType) throw new Error('blockContent has no block member')

  const fieldOptions = (name: string) =>
    (blockType.fields.find((f) => f.name === name)?.type as {options?: {list?: {value: string}[]}} | undefined)
      ?.options?.list?.map((item) => item.value) ?? []
  const marksField = blockType.fields.find((f) => f.name === 'markDefs')?.type as ArraySchemaType | undefined
  const childrenField = blockType.fields.find((f) => f.name === 'children')?.type as ArraySchemaType | undefined
  const span = childrenField?.of.find((m) => m.name === 'span') as
    | (ObjectSchemaType & {decorators?: {value: string}[]})
    | undefined
  const decorators = (span?.decorators ?? []).map((d) => d.value)

  const portableTextFields: Record<string, string[]> = {}
  for (const name of schema.getTypeNames()) {
    const type = schema.get(name) as ObjectSchemaType | undefined
    if (type?.type?.name !== 'document') continue
    const fields = type.fields.filter((f) => f.type.name === 'blockContent').map((f) => f.name)
    if (fields.length) portableTextFields[name] = fields
  }
  if (Object.keys(portableTextFields).length === 0) throw new Error('No document type has a blockContent field')

  const result: StudioSchema = {
    blockContent,
    block: {
      styles: fieldOptions('style'),
      lists: fieldOptions('listItem'),
      decorators,
      annotations: marksField?.of.map((m) => m.name) ?? [],
    },
    blockObjects: blockContent.of.filter((m) => m.name !== 'block').map((m) => m.name),
    portableTextFields,
    constants,
    validation,
  }
  for (const [what, list] of Object.entries(result.block)) {
    if (list.length === 0) throw new Error(`Could not read the ${what} of the blockContent block type`)
  }
  return result
}
