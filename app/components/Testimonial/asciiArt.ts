/*
 * Testimonial ASCII art is stored as HTML: ascii-magic's markup, written by the
 * testimonial-ascii-art Function and by the migration. The site never injects that HTML. It parses
 * the field against the exact markup the generator produces and renders React elements from it, so
 * anything else in the field (written with a token, or by a faulty Function run) cannot reach the
 * page as markup.
 *
 * Accepted markup:
 * - an optional wrapping `<span>` … `</span>` (lxml adds it when there is more than one element)
 * - colored characters: `<span style="color: #rrggbb">c</span>`
 * - line breaks: `<br/>` (also `<br>` and `<br />`)
 * - whitespace between them, which is kept because it renders as spacing
 * - in character text, the entities `&amp;`, `&lt;`, `&gt;`, `&quot;` and `&#39;`
 *
 * Kept free of app imports so unit tests can load it.
 */

export type AsciiArtPiece =
  | { type: 'char'; color: string; text: string }
  | { type: 'br' }
  | { type: 'space'; text: string }

export interface AsciiArt {
  /** Whitespace before and after the wrapping span, rendered as text like the HTML was. */
  leading: string
  trailing: string
  /** Whether the pieces sit inside a wrapping `<span>`. */
  wrapped: boolean
  pieces: AsciiArtPiece[]
}

export type AsciiArtParseResult = { ok: true; art: AsciiArt } | { ok: false; reason: string }

const WRAPPED = /^(\s*)<span>([\s\S]*)<\/span>(\s*)$/
// Global, not sticky (the app targets ES5): a match that does not start where the previous one
// ended means something unexpected sits in between, which rejects the art.
const TOKEN = /<span style="color: ?#([0-9a-fA-F]{6});?">((?:[^<>&]|&(?:amp|lt|gt|quot|#39);)*)<\/span>|<br ?\/?>|(\s+)/g
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

function decodeText(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]!)
}

function tokenize(markup: string): { pieces: AsciiArtPiece[] } | { reason: string } {
  const pieces: AsciiArtPiece[] = []
  TOKEN.lastIndex = 0
  while (TOKEN.lastIndex < markup.length) {
    const at = TOKEN.lastIndex
    const match = TOKEN.exec(markup)
    if (!match || match.index !== at) {
      return { reason: `unexpected markup at character ${at}: ${JSON.stringify(markup.slice(at, at + 40))}` }
    }
    if (match[1] !== undefined) {
      pieces.push({ type: 'char', color: `#${match[1].toLowerCase()}`, text: decodeText(match[2] ?? '') })
    } else if (match[3] !== undefined) {
      pieces.push({ type: 'space', text: match[3] })
    } else {
      pieces.push({ type: 'br' })
    }
  }
  return { pieces }
}

/** Parses the stored `asciiArt` value. An empty value is valid art with no pieces. */
export function parseAsciiArt(html: string): AsciiArtParseResult {
  const wrapped = WRAPPED.exec(html)
  const leading = wrapped ? wrapped[1]! : ''
  const trailing = wrapped ? wrapped[3]! : ''
  const result = tokenize(wrapped ? wrapped[2]! : html)
  if ('reason' in result) {
    return { ok: false, reason: result.reason }
  }
  return { ok: true, art: { leading, trailing, wrapped: Boolean(wrapped), pieces: result.pieces } }
}
