import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertGroundedGeneratedContent,
  findUngroundedCoverageClaims,
  UngroundedCoverageClaimError,
} from '../../backend/tenant/dist/content-integrity.js'

describe('Generated content integrity guard', () => {
  const context = {
    referenceMaterial: 'The approved source covers ISO 45001 and Section 4.2 requirements.',
    creatorInstructions: 'Use only the approved source material.',
  }

  test('accepts grounded authorities and does not mutate input', () => {
    const generated = { slides: [{ body: 'Follow ISO 45001 and Section 4.2.' }] }
    const before = structuredClone(generated)
    assert.deepEqual(findUngroundedCoverageClaims(generated, context), [])
    assertGroundedGeneratedContent(generated, context)
    assert.deepEqual(generated, before)
  })

  test('reports ungrounded claims with their nested path', () => {
    const claims = findUngroundedCoverageClaims(
      { slides: [{ content: { body: 'OSHA 1910 requires this control.' } }] },
      context,
    )
    assert.equal(claims.length, 1)
    assert.equal(claims[0].authority, 'OSHA')
    assert.equal(claims[0].path, '$.slides[0].content.body')
    assert.throws(
      () => assertGroundedGeneratedContent({ body: 'OSHA 1910 requires this control.' }, context),
      (error) => error instanceof UngroundedCoverageClaimError && error.code === 'UNGROUNDED_COVERAGE_CLAIM',
    )
  })

  test('supports a server-controlled authority allow-list', () => {
    assert.deepEqual(
      findUngroundedCoverageClaims(
        { body: 'Apply NFPA 70 controls.' },
        { ...context, allowedAuthorities: ['NFPA'] },
      ),
      [],
    )
  })

  test('does not trigger on ordinary words containing authority fragments', () => {
    assert.deepEqual(
      findUngroundedCoverageClaims({ body: 'The team follows a standard process.' }, context),
      [],
    )
  })

  test('bounds traversal of hostile nested content', () => {
    const generated = { nested: [] }
    let cursor = generated
    for (let index = 0; index < 30; index += 1) {
      cursor.nested = [{}]
      cursor = cursor.nested[0]
    }
    assert.doesNotThrow(() => findUngroundedCoverageClaims(generated, context))
  })
})
