// Word-level comparison of visible text: a similarity ratio and the differing hunks.
// Uses Myers' O(ND) diff, so long pages with few differences stay cheap.

/** Lower-cased words; punctuation-only tokens are kept, since code text matters too. */
export function tokenize(text) {
  return (text ?? '')
    .normalize('NFKC')
    .replace(/[​-‏⁠﻿]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Myers diff of two token arrays. Returns edit operations
 * [{op: 'equal'|'delete'|'insert', tokens: string[]}], or null when more than maxEdits edits
 * would be needed (the caller then falls back to a bag-of-words ratio).
 */
export function diffTokens(a, b, maxEdits = 2000) {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, maxEdits)
  const offset = max + 1
  let v = new Int32Array(2 * max + 3)
  const trace = []
  let found = false
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    const next = v.slice()
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      next[offset + k] = x
      if (x >= n && y >= m) {
        found = true
        break
      }
    }
    v = next
    if (found) {
      trace.push(v.slice())
      break
    }
  }
  if (!found) return null

  // Walk back through the trace to recover the edit script.
  const ops = []
  let x = n
  let y = m
  for (let d = trace.length - 2; d >= 0; d--) {
    const vd = trace[d]
    const k = x - y
    let prevK
    if (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) prevK = k + 1
    else prevK = k - 1
    const prevX = d === 0 ? 0 : vd[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ op: 'equal', token: a[x - 1] })
      x--
      y--
    }
    if (d === 0) break
    if (x === prevX) ops.push({ op: 'insert', token: b[y - 1] })
    else ops.push({ op: 'delete', token: a[x - 1] })
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    ops.push({ op: 'equal', token: a[x - 1] })
    x--
    y--
  }
  ops.reverse()

  const grouped = []
  for (const { op, token } of ops) {
    const last = grouped[grouped.length - 1]
    if (last && last.op === op) last.tokens.push(token)
    else grouped.push({ op, tokens: [token] })
  }
  return grouped
}

/** Dice coefficient on word multisets (fallback when the texts differ too much for a diff). */
function bagRatio(a, b) {
  if (a.length + b.length === 0) return 1
  const counts = new Map()
  for (const token of a) counts.set(token, (counts.get(token) ?? 0) + 1)
  let common = 0
  for (const token of b) {
    const left = counts.get(token) ?? 0
    if (left > 0) {
      common++
      counts.set(token, left - 1)
    }
  }
  return (2 * common) / (a.length + b.length)
}

/**
 * Compares two texts.
 * @returns {{ratio: number, oldWords: number, newWords: number, hunks: {old: string, new: string, before: string}[] | null}}
 */
export function compareText(oldText, newText) {
  const a = tokenize(oldText)
  const b = tokenize(newText)
  const ops = diffTokens(a, b)
  if (!ops) return { ratio: bagRatio(a, b), oldWords: a.length, newWords: b.length, hunks: null }
  let equal = 0
  const hunks = []
  let context = []
  for (let i = 0; i < ops.length; i++) {
    const group = ops[i]
    if (group.op === 'equal') {
      equal += group.tokens.length
      context = group.tokens.slice(-8)
      continue
    }
    // A delete followed by an insert (or the reverse) is one replacement hunk.
    const hunk = { before: context.join(' '), old: '', new: '' }
    let j = i
    while (j < ops.length && ops[j].op !== 'equal') {
      if (ops[j].op === 'delete') hunk.old += (hunk.old ? ' ' : '') + ops[j].tokens.join(' ')
      else hunk.new += (hunk.new ? ' ' : '') + ops[j].tokens.join(' ')
      j++
    }
    hunks.push(hunk)
    i = j - 1
  }
  const ratio = a.length + b.length === 0 ? 1 : (2 * equal) / (a.length + b.length)
  return { ratio, oldWords: a.length, newWords: b.length, hunks }
}
