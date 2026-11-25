import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compareText, diffTokens, tokenize } from '../src/text-diff.mjs'

/** Rebuilds both inputs from an edit script, to check the script is complete and in order. */
function replay(ops) {
  const a = []
  const b = []
  for (const { op, tokens } of ops) {
    if (op !== 'insert') a.push(...tokens)
    if (op !== 'delete') b.push(...tokens)
  }
  return { a, b }
}

test('identical texts have ratio 1 and no hunks', () => {
  const result = compareText('Hello  world\nagain', 'hello world again')
  assert.equal(result.ratio, 1)
  assert.deepEqual(result.hunks, [])
})

test('a replacement is one hunk with its context', () => {
  const result = compareText('built with Django and Wagtail (c)2026', 'built with Next.js and Sanity (c)2026')
  assert.deepEqual(
    result.hunks.map(({ old, new: added }) => [old, added]),
    [
      ['django', 'next.js'],
      ['wagtail', 'sanity'],
    ],
  )
  assert.equal(result.hunks[0].before, 'built with')
})

test('the edit script replays to both inputs on random cases', () => {
  let seed = 7
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  for (let round = 0; round < 200; round++) {
    const words = 'a b c d e f'.split(' ')
    const a = Array.from({ length: Math.floor(random() * 30) }, () => words[Math.floor(random() * words.length)])
    const b = Array.from({ length: Math.floor(random() * 30) }, () => words[Math.floor(random() * words.length)])
    const ops = diffTokens(a, b)
    assert.ok(ops, 'diff found')
    assert.deepEqual(replay(ops), { a, b })
  }
})

test('the edit script is minimal (equals the LCS length)', () => {
  const a = tokenize('the quick brown fox jumps over the lazy dog')
  const b = tokenize('the quick red fox jumped over the very lazy dog')
  const ops = diffTokens(a, b)
  const equal = ops.filter((group) => group.op === 'equal').reduce((sum, group) => sum + group.tokens.length, 0)
  assert.equal(equal, 7)
})

test('falls back to a bag-of-words ratio when the edit cap is exceeded', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `x${i}`).join(' ')
  const b = Array.from({ length: 3000 }, (_, i) => `y${i}`).join(' ')
  const result = compareText(a, b)
  assert.equal(result.hunks, null)
  assert.equal(result.ratio, 0)
})
