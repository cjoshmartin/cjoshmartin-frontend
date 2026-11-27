/**
 * Helpers to compare two testimonial ASCII-art HTML strings (Python vs TypeScript output):
 * parse the lxml-formatted markup back into cells, then measure grid, character and color
 * differences.
 */
import {CHARS_BY_DENSITY} from '../generate'

export interface Cell {
  char: string
  rgb: [number, number, number]
}

export interface ParsedArt {
  rows: Cell[][]
}

const CELL = /<span style="color: #([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})">(.*?)<\/span>|<br\/>/g

function unescapeText(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** Parses the lxml-pretty-printed markup back into a grid of (char, color) cells. */
export function parseArt(html: string): ParsedArt {
  const rows: Cell[][] = [[]]
  for (const match of html.matchAll(CELL)) {
    if (match[0] === '<br/>') {
      rows.push([])
      continue
    }
    const char = unescapeText(match[4])
    if (char.length !== 1) throw new Error(`cell with ${char.length} characters: ${match[0]}`)
    rows[rows.length - 1].push({
      char,
      rgb: [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)],
    })
  }
  return {rows}
}

/** All ramp positions of a character (')' appears twice in ascii-magic's ramp). */
function rampPositions(char: string): number[] {
  const positions: number[] = []
  for (let i = 0; i < CHARS_BY_DENSITY.length; i++)
    if (CHARS_BY_DENSITY[i] === char) positions.push(i)
  if (positions.length === 0)
    throw new Error(`character ${JSON.stringify(char)} is not on the ramp`)
  return positions
}

/** Smallest ramp distance between two characters, resolving the duplicated ')' in favor of the closer slot. */
function rampDistance(a: string, b: string): number {
  let best = Infinity
  for (const i of rampPositions(a))
    for (const j of rampPositions(b)) best = Math.min(best, Math.abs(i - j))
  return best
}

export interface ArtComparison {
  sameGrid: boolean
  oldGrid: string
  newGrid: string
  cells: number
  exactChars: number
  withinOneStep: number
  meanRampDistance: number
  maxRampDistance: number
  meanColorDiff: number
  maxColorDiff: number
}

/**
 * Cell-by-cell comparison. When the grids differ there is nothing to compare cell by cell:
 * the ratios are 0 and the distances NaN, and sameGrid is false.
 */
export function compareArt(oldArt: ParsedArt, newArt: ParsedArt): ArtComparison {
  const oldGrid = `${oldArt.rows[0]?.length ?? 0}x${oldArt.rows.length}`
  const newGrid = `${newArt.rows[0]?.length ?? 0}x${newArt.rows.length}`
  const sameGrid =
    oldArt.rows.length === newArt.rows.length &&
    oldArt.rows.every((row, y) => row.length === newArt.rows[y].length)
  if (!sameGrid) {
    return {
      sameGrid,
      oldGrid,
      newGrid,
      cells: 0,
      exactChars: 0,
      withinOneStep: 0,
      meanRampDistance: NaN,
      maxRampDistance: NaN,
      meanColorDiff: NaN,
      maxColorDiff: NaN,
    }
  }
  let cells = 0
  let exact = 0
  let withinOne = 0
  let rampSum = 0
  let rampMax = 0
  let colorSum = 0
  let colorMax = 0
  oldArt.rows.forEach((row, y) =>
    row.forEach((oldCell, x) => {
      const newCell = newArt.rows[y][x]
      cells++
      const d = rampDistance(oldCell.char, newCell.char)
      if (oldCell.char === newCell.char) exact++
      if (d <= 1) withinOne++
      rampSum += d
      rampMax = Math.max(rampMax, d)
      for (let c = 0; c < 3; c++) {
        const diff = Math.abs(oldCell.rgb[c] - newCell.rgb[c])
        colorSum += diff
        colorMax = Math.max(colorMax, diff)
      }
    }),
  )
  return {
    sameGrid,
    oldGrid,
    newGrid,
    cells,
    exactChars: exact / cells,
    withinOneStep: withinOne / cells,
    meanRampDistance: rampSum / cells,
    maxRampDistance: rampMax,
    meanColorDiff: colorSum / (cells * 3),
    maxColorDiff: colorMax,
  }
}
