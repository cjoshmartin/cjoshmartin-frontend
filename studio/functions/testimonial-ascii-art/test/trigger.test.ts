/**
 * Recursion guard and image-removed handling: the blueprint filter (evaluated with groq-js,
 * the GROQ implementation the Functions tooling uses locally) and planAsciiArtUpdate must agree,
 * and applying the Function's own patch must stop the filter from matching.
 */
import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {evaluate, parse} from 'groq-js'

import {
  planAsciiArtUpdate,
  TESTIMONIAL_ASCII_ART_FILTER,
  TESTIMONIAL_ASCII_ART_PROJECTION,
  type TestimonialArtEventData,
} from '../trigger'

const A = 'image-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-800x800-jpg'
const B = 'image-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-400x400-jpg'

type Doc = Record<string, unknown> & {_id: string; _type: string}

const image = (ref: string) => ({_type: 'image', asset: {_type: 'reference', _ref: ref}})

async function filterMatches(doc: Doc, dataset = 'staging'): Promise<boolean> {
  const tree = parse(`*[${TESTIMONIAL_ASCII_ART_FILTER}]._id`)
  const result = await (
    await evaluate(tree, {dataset: [doc], sanity: {projectId: 'j3vdh6ti', dataset}})
  ).get()
  return (result as string[]).includes(doc._id)
}

async function project(doc: Doc): Promise<TestimonialArtEventData> {
  const tree = parse(`*[_id == $id][0]${TESTIMONIAL_ASCII_ART_PROJECTION}`)
  return (await (
    await evaluate(tree, {dataset: [doc], params: {id: doc._id}})
  ).get()) as TestimonialArtEventData
}

/** What the handler's patch does to the document. */
function applyPlan(doc: Doc, plan: ReturnType<typeof planAsciiArtUpdate>): Doc {
  if (plan.action === 'generate')
    return {...doc, asciiArt: '<span>...</span>\n', asciiArtSource: plan.assetId}
  if (plan.action === 'clear') {
    const {asciiArt: _art, asciiArtSource: _source, ...rest} = doc
    return rest as Doc
  }
  return doc
}

const cases: {name: string; doc: Doc; expected: ReturnType<typeof planAsciiArtUpdate>['action']}[] =
  [
    {
      name: 'new testimonial with a photo',
      doc: {_id: 't1', _type: 'testimonial', image: image(A)},
      expected: 'generate',
    },
    {
      name: 'photo replaced',
      doc: {_id: 't2', _type: 'testimonial', image: image(B), asciiArt: 'x', asciiArtSource: A},
      expected: 'generate',
    },
    {
      name: 'art generated from the current photo',
      doc: {_id: 't3', _type: 'testimonial', image: image(A), asciiArt: 'x', asciiArtSource: A},
      expected: 'none',
    },
    {
      name: 'empty-string art (unsupported image) from the current photo',
      doc: {_id: 't3b', _type: 'testimonial', image: image(A), asciiArt: '', asciiArtSource: A},
      expected: 'none',
    },
    {
      name: 'source recorded but art missing',
      doc: {_id: 't4', _type: 'testimonial', image: image(A), asciiArtSource: A},
      expected: 'generate',
    },
    {
      name: 'photo removed',
      doc: {_id: 't5', _type: 'testimonial', asciiArt: 'x', asciiArtSource: A},
      expected: 'clear',
    },
    {
      name: 'photo field kept but asset removed',
      doc: {
        _id: 't6',
        _type: 'testimonial',
        image: {_type: 'image'},
        asciiArt: 'x',
        asciiArtSource: A,
      },
      expected: 'clear',
    },
    {
      name: 'only a stale source left',
      doc: {_id: 't7', _type: 'testimonial', asciiArtSource: A},
      expected: 'clear',
    },
    {
      name: 'no photo and no art',
      doc: {_id: 't8', _type: 'testimonial', firstName: 'No'},
      expected: 'none',
    },
    {
      name: 'draft with a new photo',
      doc: {_id: 'drafts.t9', _type: 'testimonial', image: image(B)},
      expected: 'generate',
    },
    {
      name: 'other document type',
      doc: {_id: 'p1', _type: 'person', image: image(A)},
      expected: 'none',
    },
  ]

describe('planAsciiArtUpdate and the blueprint filter', () => {
  for (const c of cases) {
    it(`${c.name}: ${c.expected}`, async () => {
      const data = await project(c.doc)
      const plan = planAsciiArtUpdate(data)
      assert.equal(plan.action, c.expected)
      if (plan.action === 'generate')
        assert.equal(plan.assetId, (c.doc.image as {asset: {_ref: string}}).asset._ref)
      assert.equal(
        await filterMatches(c.doc),
        c.expected !== 'none',
        'filter agrees with the planner',
      )
    })
  }

  it('does not run for datasets other than production and staging', async () => {
    const doc: Doc = {_id: 't1', _type: 'testimonial', image: image(A)}
    assert.equal(await filterMatches(doc, 'production'), true)
    assert.equal(await filterMatches(doc, 'staging'), true)
    assert.equal(await filterMatches(doc, 'restore-test'), false)
  })

  it('projects missing fields as null', async () => {
    assert.deepEqual(await project({_id: 't8', _type: 'testimonial'}), {
      _id: 't8',
      _type: 'testimonial',
      imageAssetId: null,
      asciiArtSource: null,
      hasAsciiArt: false,
    })
    assert.deepEqual(
      await project({
        _id: 't3',
        _type: 'testimonial',
        image: image(A),
        asciiArt: 'x',
        asciiArtSource: A,
      }),
      {
        _id: 't3',
        _type: 'testimonial',
        imageAssetId: A,
        asciiArtSource: A,
        hasAsciiArt: true,
      },
    )
  })
})

describe('recursion guard', () => {
  it("the Function's own patch does not match the filter again", async () => {
    for (const c of cases.filter((c) => c.expected !== 'none')) {
      const after = applyPlan(c.doc, planAsciiArtUpdate(await project(c.doc)))
      assert.equal(await filterMatches(after), false, `${c.name}: patched document still matches`)
      assert.equal(planAsciiArtUpdate(await project(after)).action, 'none')
    }
  })

  it('a stale patch for an older photo makes the filter match again until the art catches up', async () => {
    // Photo A -> run 1 starts; editor switches to B -> run 2 finishes first; run 1 lands last.
    let doc: Doc = {_id: 't1', _type: 'testimonial', image: image(B)}
    doc = applyPlan(doc, {action: 'generate', assetId: B})
    doc = applyPlan(doc, {action: 'generate', assetId: A})
    assert.equal(await filterMatches(doc), true)
    const plan = planAsciiArtUpdate(await project(doc))
    assert.deepEqual(plan, {action: 'generate', assetId: B})
    doc = applyPlan(doc, plan)
    assert.equal(await filterMatches(doc), false)
    assert.equal(doc.asciiArtSource, B)
  })

  it('image removed while art was being generated: the late patch is cleared again', async () => {
    let doc: Doc = {_id: 't1', _type: 'testimonial'}
    doc = applyPlan(doc, {action: 'generate', assetId: A})
    assert.equal(planAsciiArtUpdate(await project(doc)).action, 'clear')
    doc = applyPlan(doc, {action: 'clear'})
    assert.equal(await filterMatches(doc), false)
    assert.equal('asciiArt' in doc || 'asciiArtSource' in doc, false)
  })
})
