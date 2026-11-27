import {getPublishedId, type CustomValidator} from 'sanity'

import {API_VERSION} from '../../lib/constants'

interface UniqueOptions {
  /** Compare with GROQ `lower()` on both sides. */
  caseInsensitive?: boolean
  message: string
}

/**
 * Validator that fails when another document of the same `_type` already has the same value in
 * `field`. Drafts, published documents and release versions of the document being validated are
 * ignored, the same way Sanity's own slug uniqueness check works.
 *
 * `field` is a top-level field name from this Studio's schema, never user input.
 */
export function uniqueInType(
  field: string,
  options: UniqueOptions,
): CustomValidator<string | undefined> {
  return async (value, context) => {
    const candidate = value?.trim()
    if (!candidate) return true

    const {document} = context
    if (!document) {
      throw new Error('`document` was not provided in the validation context')
    }

    const comparison = options.caseInsensitive
      ? `lower(${field}) == lower($value)`
      : `${field} == $value`

    const duplicateExists = await context
      .getClient({apiVersion: API_VERSION})
      .withConfig({perspective: 'raw'})
      .fetch<boolean>(
        `defined(*[_type == $type && !sanity::versionOf($published) && ${comparison}][0]._id)`,
        {type: document._type, published: getPublishedId(document._id), value: candidate},
        {tag: `validation.unique-${field}`},
      )

    return duplicateExists ? options.message : true
  }
}
