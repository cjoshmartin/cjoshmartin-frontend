import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { sameOriginRedirect } from '../lib/sameOriginRedirect.ts'

const SITE = 'https://cjoshmartin.com'

describe('sameOriginRedirect', () => {
  it('keeps a path on this site, with its query and hash', () => {
    assert.equal(
      sameOriginRedirect('/blog/interview-practice?x=1#intro', SITE).href,
      'https://cjoshmartin.com/blog/interview-practice?x=1#intro',
    )
    assert.equal(sameOriginRedirect('/', SITE).href, 'https://cjoshmartin.com/')
  })

  it('falls back to the home page when the value is missing or not a path', () => {
    for (const value of [null, '', 'blog', 'https://evil.com/', 'javascript:alert(1)']) {
      assert.equal(sameOriginRedirect(value, SITE).href, 'https://cjoshmartin.com/', String(value))
    }
  })

  it('rejects every form that resolves to another host', () => {
    // searchParams.get() has already decoded %09, %0A and %0D into the raw characters.
    const attacks = [
      '//evil.com',
      '/\\evil.com',
      '/\t/evil.com',
      '/\n/evil.com',
      '/\r/evil.com',
      '/\t\\evil.com',
      '/\r\n/evil.com/path',
      '/\\/evil.com',
      '///evil.com',
    ]
    for (const value of attacks) {
      const target = sameOriginRedirect(value, SITE)
      assert.equal(target.origin, SITE, JSON.stringify(value))
      assert.equal(target.href, 'https://cjoshmartin.com/', JSON.stringify(value))
    }
  })

  it('uses the origin of the request, so preview deployments stay on their own host', () => {
    assert.equal(
      sameOriginRedirect('/projects', 'https://preview-abc.vercel.app').href,
      'https://preview-abc.vercel.app/projects',
    )
    assert.equal(
      sameOriginRedirect('/\t/cjoshmartin.com', 'https://preview-abc.vercel.app').href,
      'https://preview-abc.vercel.app/',
    )
  })
})
