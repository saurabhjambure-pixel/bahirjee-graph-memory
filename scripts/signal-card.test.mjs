/**
 * Signal-card presentation tests.
 *
 * The card's headline and its factual line are written by the model from the same
 * evidence, and they routinely came out as the same sentence twice. The redesign drops the
 * factual line when it is the headline reworded — which means a presentation rule can now
 * withhold a sentence from the founder. That is the shape of failure this codebase keeps
 * paying for, so the rule is pinned here rather than trusted.
 *
 * The bias is deliberate and asymmetric: dropping a genuine fact is much worse than
 * showing a near-duplicate, so every ambiguous case must resolve to SHOW.
 *
 * Run: npm run test:signal-card
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { addsBeyondHeadline, factTokens, RESTATEMENT_OVERLAP } from '../src/services/signalPresentation.js'

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`)
    process.exitCode = 1
  }
}

// ─── the case this was built for ────────────────────────────────────────────
// Taken verbatim from a live card. The founder read the figure, then read it again.

const REAL_HEADLINE = 'B2B Market Research Market projected to reach $47.58B in 2026, growing at 8.66% CAGR to 2032'
const REAL_MOVE = 'The B2B Market Research Market is estimated at USD 47.58 billion in 2026 and is projected to grow by USD 78.54 billion at a CAGR of 8.66% by 2032.'

check('a reworded headline is recognised as a restatement', () => {
  assert.equal(
    addsBeyondHeadline(REAL_MOVE, REAL_HEADLINE), false,
    'this exact pair is what the redesign exists to stop showing twice'
  )
})

check('"$47.58B" and "USD 47.58 billion" are the same fact', () => {
  // Without magnitude normalisation the two spellings never match, the overlap looks tiny,
  // and the duplicate check silently never fires on the case it was written for.
  const compact = factTokens('reach $47.58B in 2026')
  const spelled = factTokens('USD 47.58 billion in 2026')
  for (const token of ['47.58', 'billion', '2026']) {
    assert.ok(compact.has(token), `compact form lost "${token}"`)
    assert.ok(spelled.has(token), `spelled form lost "${token}"`)
  }
})

// ─── the direction that must never regress ──────────────────────────────────

check('a move carrying genuinely new facts is kept', () => {
  assert.equal(
    addsBeyondHeadline(
      'Shiprocket raised $40M in a Series D led by Zomato on 12 August, its second round in 14 months, taking headcount past 2,000.',
      'Shiprocket closes new funding round'
    ),
    true,
    'names, amounts, dates and investors the headline never mentioned must survive'
  )
})

check('a move about a different subject is kept', () => {
  assert.equal(
    addsBeyondHeadline(
      'The Reserve Bank tightened settlement windows for prepaid instruments, effective 1 April.',
      'Competitor launches a rewards programme'
    ),
    true
  )
})

check('an empty or missing headline never suppresses the move', () => {
  // A card with no headline has nothing else to show; suppressing here would render a
  // signal with no factual content at all.
  assert.equal(addsBeyondHeadline('Acme raised $40M.', ''), true)
  assert.equal(addsBeyondHeadline('Acme raised $40M.', null), true)
  assert.equal(addsBeyondHeadline('Acme raised $40M.', undefined), true)
})

check('an empty move is not rendered as an empty paragraph', () => {
  assert.equal(addsBeyondHeadline('', 'Some headline'), false)
  assert.equal(addsBeyondHeadline(null, 'Some headline'), false)
  assert.equal(addsBeyondHeadline('   ', 'Some headline'), false)
})

check('the threshold is a majority, not a hair-trigger', () => {
  // A rule that fires below half-overlap would start eating genuinely different sentences.
  assert.ok(
    RESTATEMENT_OVERLAP >= 0.5 && RESTATEMENT_OVERLAP <= 0.8,
    `RESTATEMENT_OVERLAP is ${RESTATEMENT_OVERLAP}; below 0.5 it suppresses real content, ` +
    `above 0.8 it stops catching rewordings`
  )
})

check('stopwords alone cannot make two sentences look alike', () => {
  // "The ... is ... of the ... in ..." overlaps heavily on function words. If those counted,
  // any two English sentences would read as duplicates of each other.
  assert.equal(
    addsBeyondHeadline(
      'The board of the company is in favour of the merger with Northwind.',
      'The chief executive of the firm is in the running for the role.'
    ),
    true
  )
})

// ─── the component still routes through it ──────────────────────────────────

check('the card decides via addsBeyondHeadline, not an inline expression', () => {
  const dashboard = readFileSync(
    fileURLToPath(new URL('../src/components/IntelligenceDashboard.jsx', import.meta.url)), 'utf8'
  )
  assert.match(
    dashboard, /addsBeyondHeadline\(moveText, headline\)/,
    'if the component stops calling this, the rule above is guarding nothing'
  )
  // The fact must never be dropped for any reason other than redundancy.
  assert.match(
    dashboard, /showMove = Boolean\(moveText\) && addsBeyondHeadline/,
    'the only two reasons to hide the factual line are "empty" and "already said"'
  )
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
