import { PortableText, type InferStrictComponents, type PortableTextComponentProps } from '@portabletext/react'
import { stegaClean } from '@sanity/client/stega'
import type { ReactNode } from 'react'

import { STLFileArea } from '@/app/components/STLFileAreaLazy'
import { getHeadings } from '@/lib/portableText'
import { hasAsset, imageUrl, scaledDimensions } from '@/sanity/lib/image'
import type { PortableTextBodyValue } from '@/sanity/lib/types'

import { CodeArea } from './CodeArea'
import YouTubeEmbed from './YouTubeEmbed'

/** Widest rendition of an inline image, the same width the old site's rich-text renditions had. */
const INLINE_IMAGE_WIDTH = 800

/** CSS classes Wagtail gave rich-text images for each layout (styled in app/globals.css). */
const IMAGE_LAYOUT_CLASSES: Record<string, string> = {
  fullwidth: 'richtext-image full-width',
  left: 'richtext-image left',
  right: 'richtext-image right',
}

type BodyItem = PortableTextBodyValue[number]
type TextBlock = Extract<BodyItem, { _type: 'block' }>
type MarkDefinition = NonNullable<TextBlock['markDefs']>[number]
type LinkDefinition = Extract<MarkDefinition, { _type: 'link' }>
type InternalLinkDefinition = Extract<MarkDefinition, { _type: 'internalLink' }>
type FileLinkDefinition = Extract<MarkDefinition, { _type: 'fileLink' }>

/** A text block with the id its heading gets, worked out once for the whole body. */
type RenderedTextBlock = TextBlock & { headingId?: string }
type RenderedItem = Exclude<BodyItem, TextBlock> | RenderedTextBlock

type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

const INTERNAL_LINK_PATHS: Record<string, (slug: string) => string> = {
  blogPost: (slug) => `/blog/${slug}`,
  project: (slug) => `/projects/${slug}`,
  flexPage: (slug) => `/flex/${slug}`,
}

function internalLinkHref(target: InternalLinkDefinition['target'] | undefined): string | null {
  if (!target) return null
  if (target._type === 'homePage') return '/'
  const slug = stegaClean(target.slug)
  return slug ? INTERNAL_LINK_PATHS[target._type](slug) : null
}

/** True when a text block contains an annotation that renders as a link. */
function blockHasLink(block: TextBlock): boolean {
  const linkKeys = new Set((block.markDefs ?? []).map((definition) => definition._key))
  return (block.children ?? []).some((child) => (child.marks ?? []).some((mark) => linkKeys.has(mark)))
}

function Heading({ value: block, children }: PortableTextComponentProps<RenderedTextBlock>) {
  const Tag: HeadingTag = block.style && block.style !== 'normal' && block.style !== 'blockquote' ? block.style : 'h2'
  const id = block.headingId

  // A link inside a heading can't be wrapped in another link, so those headings only get an id
  // (the old renderer did the same).
  if (!id || blockHasLink(block)) {
    return (
      <Tag id={id} className="rich-text-heading">
        {children}
      </Tag>
    )
  }

  return (
    <Tag id={id} className="rich-text-heading">
      <a
        href={`#${id}`}
        className="anchor-link"
        style={{ cursor: 'pointer', textDecoration: 'none', color: 'inherit' }}
      >
        {children}
        <span className="anchor-pound"> #</span>
      </a>
    </Tag>
  )
}

function LinkMark({ value: link, children }: { value?: LinkDefinition; children: ReactNode }) {
  const href = stegaClean(link?.href)
  if (!href) {
    return <>{children}</>
  }
  return link?.openInNewTab ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <a href={href}>{children}</a>
  )
}

function InternalLinkMark({ value: link, children }: { value?: InternalLinkDefinition; children: ReactNode }) {
  const href = internalLinkHref(link?.target)
  if (!href) {
    // Validation requires the reference, but it can point at a page that is not published yet.
    console.error(`PortableTextBody: internal link ${link?._key} points to a missing or unpublished page`)
    return <>{children}</>
  }
  return <a href={href}>{children}</a>
}

function FileLinkMark({ value: link, children }: { value?: FileLinkDefinition; children: ReactNode }) {
  const href = stegaClean(link?.url)
  if (!href) {
    console.error(`PortableTextBody: file link ${link?._key} has no file`)
    return <>{children}</>
  }
  return <a href={href}>{children}</a>
}

function ImageBlock({ value: image }: { value: Extract<BodyItem, { _type: 'imageBlock' }> }) {
  if (!hasAsset(image)) {
    console.error(`PortableTextBody: image block ${image._key} has no image`)
    return null
  }
  const { width, height } = scaledDimensions(image, INLINE_IMAGE_WIDTH)
  const layout = stegaClean(image.layout) ?? 'fullwidth'
  return (
    // A plain <img> like the old rich-text HTML: the Sanity image CDN already resizes and
    // re-encodes it, so next/image would only add a second optimization pass.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={stegaClean(image.alt) ?? ''}
      className={IMAGE_LAYOUT_CLASSES[layout] ?? IMAGE_LAYOUT_CLASSES.fullwidth}
      height={height}
      src={imageUrl(image, INLINE_IMAGE_WIDTH)}
      width={width}
      loading="lazy"
    />
  )
}

function YouTubeBlock({ value: youtube }: { value: Extract<BodyItem, { _type: 'youtube' }> }) {
  return <YouTubeEmbed url={youtube.url} />
}

function CodeBlock({ value: code }: { value: Extract<BodyItem, { _type: 'code' }> }) {
  return <CodeArea language={stegaClean(code.language)} code={stegaClean(code.code ?? '')} />
}

function StlModelBlock({ value: model }: { value: Extract<BodyItem, { _type: 'stlModel' }> }) {
  const url = stegaClean(model.fileUrl)
  if (!url) {
    console.error(`PortableTextBody: STL block ${model._key} has no file`)
    return null
  }
  return <STLFileArea value={{ scale: model.scale, file: { url, title: stegaClean(model.fileName) ?? '' } }} />
}

/** MIME type of the converted files (`OUTPUT_MIME_TYPE` in studio/functions/video-to-mp4/settings.ts). */
const MP4_MIME_TYPE = 'video/mp4'

/**
 * Same behaviour as the old `<video autoPlay loop playsInline controls muted>`, playing the block's
 * converted MP4 from the Sanity CDN. The query only gives a URL for a block whose `file` is its
 * converted MP4 (video contract v2), so a block that is still being converted, or whose
 * conversion failed, renders nothing: its `file` is then the original upload, which the site never
 * serves. The Studio shows the editor where each video stands, and a failed conversion blocks
 * publishing.
 */
function VideoBlock({ value: video }: { value: Extract<BodyItem, { _type: 'video' }> }) {
  const url = stegaClean(video.url)
  if (!url) {
    const status = stegaClean(video.status)
    if (!video.hasFile) {
      // Validation requires a file, but a draft can be saved without one, and the asset can be deleted.
      console.error(`PortableTextBody: video block ${video._key} has no video file`)
    } else if (status === 'failed') {
      console.error(`PortableTextBody: video block ${video._key} is not shown: its MP4 conversion failed`)
    } else {
      // A new upload: the video-to-mp4 Function is converting it, and SanityLive shows it when done.
      console.warn(`PortableTextBody: video block ${video._key} is not shown until its MP4 conversion is ready`)
    }
    return null
  }
  const filename = stegaClean(video.filename) ?? 'the video'
  return (
    // Keyed by the URL: a <source> change does not reload a <video>, so when a conversion finishes
    // (and SanityLive re-renders the page with the MP4) React mounts a new element instead.
    <video key={url} autoPlay loop muted playsInline controls preload="metadata">
      <source src={url} type={MP4_MIME_TYPE} />
      <a href={url}>Download {filename}</a>
    </video>
  )
}

function DividerBlock() {
  return <hr />
}

const components = {
  block: {
    h1: Heading,
    h2: Heading,
    h3: Heading,
    h4: Heading,
    h5: Heading,
    h6: Heading,
  },
  marks: {
    link: LinkMark,
    internalLink: InternalLinkMark,
    fileLink: FileLinkMark,
  },
  types: {
    imageBlock: ImageBlock,
    youtube: YouTubeBlock,
    code: CodeBlock,
    stlModel: StlModelBlock,
    video: VideoBlock,
    divider: DividerBlock,
  },
} satisfies InferStrictComponents<RenderedItem[]>

/** Blocks that were their own StreamField blocks in Wagtail, rendered outside any wrapper. */
const STANDALONE_TYPES = new Set(['code', 'stlModel', 'video'])

/**
 * Migrated rich-text items have keys like `1e2b8879-ycnuw`: the first 8 characters of the Wagtail
 * StreamField block they came from, then the Draftail block key. Items created in the Studio have
 * plain random keys and all share one group.
 */
function richTextGroupOf(key: string): string {
  return /^([0-9a-f]{8})-[a-z0-9]+$/.exec(key)?.[1] ?? 'studio'
}

interface Segment {
  key: string
  wrapped: boolean
  items: RenderedItem[]
}

/**
 * Splits the body the way the old page markup was split: each run of rich text (paragraphs,
 * headings, lists, inline images, YouTube embeds and dividers) sits in one <div>, and code, STL and
 * video blocks stand on their own. Pages lay their content out as a flex column with a gap, so this
 * keeps the gaps between the same elements as before.
 */
function toSegments(items: RenderedItem[]): Segment[] {
  const segments: Segment[] = []
  let currentGroup: string | null = null

  for (const item of items) {
    if (STANDALONE_TYPES.has(item._type)) {
      segments.push({ key: item._key, wrapped: false, items: [item] })
      currentGroup = null
      continue
    }
    const group = richTextGroupOf(item._key)
    const last = segments[segments.length - 1]
    if (last?.wrapped && group === currentGroup) {
      last.items.push(item)
    } else {
      segments.push({ key: item._key, wrapped: true, items: [item] })
      currentGroup = group
    }
  }

  return segments
}

/**
 * Renders a rich-text body the way the old Wagtail HTML rendered: headings get an id (from the
 * shared algorithm in lib/portableText.ts, so the blog outline links match) and a "#" anchor,
 * images use the `richtext-image` classes, YouTube blocks use the oEmbed markup, and code, STL and
 * video blocks use the same viewers as before.
 */
export default function PortableTextBody({ value }: { value: PortableTextBodyValue | null | undefined }) {
  if (!value || value.length === 0) {
    return null
  }

  const headingIds = new Map(getHeadings(value).map((heading) => [heading.key, heading.id]))
  const items: RenderedItem[] = value.map((item) =>
    item._type === 'block' && headingIds.has(item._key) ? { ...item, headingId: headingIds.get(item._key) } : item,
  )

  return (
    <>
      {toSegments(items).map((segment) =>
        segment.wrapped ? (
          <div key={segment.key}>
            <PortableText value={segment.items} components={components} />
          </div>
        ) : (
          <PortableText key={segment.key} value={segment.items} components={components} />
        ),
      )}
    </>
  )
}
