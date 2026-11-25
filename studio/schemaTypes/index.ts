import type {SchemaTypeDefinition} from 'sanity'

import {blogPost} from './documents/blog-post'
import {flexPage} from './documents/flex-page'
import {homePage} from './documents/home-page'
import {medium} from './documents/medium'
import {person} from './documents/person'
import {project} from './documents/project'
import {redirect} from './documents/redirect'
import {service} from './documents/service'
import {technology} from './documents/technology'
import {testimonial} from './documents/testimonial'
import {blockContent} from './objects/block-content'
import {divider} from './objects/divider'
import {imageBlock} from './objects/image-block'
import {imageWithAlt} from './objects/image-with-alt'
import {legacy} from './objects/legacy'
import {seo} from './objects/seo'
import {stlModel} from './objects/stl-model'
import {video} from './objects/video'
import {youtube} from './objects/youtube'

export * from './constants'

/**
 * Every schema type defined by this Studio. The `code` type comes from @sanity/code-input and the
 * `mux.*` types from sanity-plugin-mux-input; their plugins register them in sanity.config.ts.
 */
export const schemaTypes: SchemaTypeDefinition[] = [
  // Documents
  homePage,
  blogPost,
  project,
  flexPage,
  person,
  testimonial,
  service,
  medium,
  technology,
  redirect,
  // Objects
  blockContent,
  imageWithAlt,
  imageBlock,
  youtube,
  stlModel,
  video,
  divider,
  seo,
  legacy,
]

export {
  blockContent,
  blogPost,
  divider,
  flexPage,
  homePage,
  imageBlock,
  imageWithAlt,
  legacy,
  medium,
  person,
  project,
  redirect,
  seo,
  service,
  stlModel,
  technology,
  testimonial,
  video,
  youtube,
}
