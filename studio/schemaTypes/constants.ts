/**
 * Stored codes and option lists shared by several schema types.
 *
 * The stored values (DEV/MAK, CLI/PER) are the codes Wagtail used. They are kept as-is so that
 * existing URLs such as /projects?project_type=PER keep working. Only the titles shown in the
 * Studio are human-readable.
 */

export const AUDIENCE_OPTIONS = [
  {title: 'Developer', value: 'DEV'},
  {title: 'Maker', value: 'MAK'},
] as const

export type Audience = (typeof AUDIENCE_OPTIONS)[number]['value']

/** Wagtail's default for `project_audience` and `audience`. */
export const DEFAULT_AUDIENCE: Audience = 'DEV'

export const PROJECT_TYPE_OPTIONS = [
  {title: 'Client', value: 'CLI'},
  {title: 'Personal', value: 'PER'},
] as const

export type ProjectType = (typeof PROJECT_TYPE_OPTIONS)[number]['value']

/** Wagtail's default for `project_type`. */
export const DEFAULT_PROJECT_TYPE: ProjectType = 'CLI'

export const IMAGE_LAYOUT_OPTIONS = [
  {title: 'Full width', value: 'fullwidth'},
  {title: 'Left', value: 'left'},
  {title: 'Right', value: 'right'},
] as const

export type ImageLayout = (typeof IMAGE_LAYOUT_OPTIONS)[number]['value']

export const DEFAULT_IMAGE_LAYOUT: ImageLayout = 'fullwidth'

/**
 * Languages offered in code blocks. `value` is what gets stored and is the language name the
 * frontend passes to Prism (the same choices the Wagtail code block had). `mode` picks the
 * CodeMirror highlighter used inside the Studio when the stored name differs from the editor's
 * mode name. `cpp` has no built-in mode in @sanity/code-input; sanity.config.ts registers one.
 */
export const CODE_LANGUAGES = [
  {title: 'Python', value: 'python'},
  {title: 'JavaScript', value: 'javascript'},
  {title: 'JSON', value: 'json'},
  {title: 'CSS', value: 'css'},
  {title: 'Markup', value: 'markup', mode: 'html'},
  {title: 'HTML', value: 'html'},
  {title: 'Go', value: 'go', mode: 'golang'},
  {title: 'Bash', value: 'bash', mode: 'sh'},
  {title: 'YAML', value: 'yaml'},
  {title: 'C++', value: 'cpp'},
] as const

export type CodeLanguage = (typeof CODE_LANGUAGES)[number]['value']

/** Wagtail's default code block language. */
export const DEFAULT_CODE_LANGUAGE: CodeLanguage = 'bash'

/** Document types an `internalLink` annotation can point at. */
export const INTERNAL_LINK_TYPES = ['blogPost', 'project', 'flexPage', 'homePage'] as const

/** Fixed `_id` of the home page singleton. */
export const HOME_PAGE_ID = 'homePage'
