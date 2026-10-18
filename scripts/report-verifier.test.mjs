/**
 * Pre-publish verifier gate.
 *
 * Two properties matter most and are asserted here:
 *   1. gaps are DETECTED — a thin or one-sourced report must not ship silently
 *   2. gaps are never fixed by LOWERING THE BAR — the gap-fill retry runs the exact same
 *      filter chain as the first pass (the internal design log: "Fewer verified findings
 *      beat more plausible ones")
 *
 * Run: npm run test:report-verifier
 * (npm run test:verifier is the pre-persist verifier GATE — scripts/verifier-gate.test.mjs)
 */
import assert from 'node:assert/strict'
import {
  verifyReport,
  retryTargetsFor,
  sectionForCategory,
  VERIFIER_THRESHOLDS,
} from '../src/services/reportVerifier.js'
import { SIGNAL_CATEGORIES } from '../src/services/signalTaxonomy.js'
import { applySignalFilters } from '../src/services/intelligenceService.js'

/** A signal that passes every check, so tests can vary one dimension at a time. */
const good = (i, domain = `src${i}.com`, category = 'DemandSignal') => ({
  signal_headline: `Signal ${i}`,
  category,
  source_url: `https://${domain}/a/${i}`,
  date: '2026-07-01',
  so_what_for_you: 'This lands in your core buying centre and changes your pipeline.',
})

// ── Category → section mapping ──────────────────────────────────────────────────
{
  assert.equal(sectionForCategory('DemandSignal'), 'Opportunities')
  assert.equal(sectionForCategory('CustomerShift'), 'Customers')
  assert.equal(sectionForCategory('CompetitorFunding'), 'Competition')
  assert.equal(sectionForCategory('RegulatoryChange'), 'Regulatory')
  // TangentialTrend used to map to nothing and render as an unranked orphan section.
  // It now has a named home; every category the prompt emits must reach a section.
  assert.equal(sectionForCategory('TangentialTrend'), 'Adjacent & Macro')
  assert.equal(sectionForCategory('NotACategory'), null, 'unknown category yields no section')
  assert.equal(sectionForCategory(''), null)
  assert.equal(sectionForCategory(undefined), null)
}

// ── Every prompt category reaches a section ─────────────────────────────────────
{
  for (const category of SIGNAL_CATEGORIES) {
    assert.ok(
      sectionForCategory(category),
      `${category} is emittable by the prompt but maps to no display section`
    )
  }
}

// ── Healthy report passes ───────────────────────────────────────────────────────
{
  const signals = [
    good(1, 'a.com', 'DemandSignal'),
    good(2, 'b.com', 'CustomerShift'),
    good(3, 'c.com', 'CompetitorFunding'),
    good(4, 'd.com', 'CompetitorLaunch'),
  ]
  const r = verifyReport(signals)
  assert.equal(r.ok, true, `healthy report should pass, got: ${JSON.stringify(r.gaps)}`)
  assert.equal(r.gaps.length, 0)
  assert.equal(r.metrics.total, 4)
  assert.equal(r.metrics.domains, 4)
}

// ── No signals at all ───────────────────────────────────────────────────────────
{
  const r = verifyReport([])
  assert.equal(r.ok, false)
  assert.equal(r.gaps[0].type, 'no_signals')
  assert.equal(r.gaps[0].retryable, true, 'an empty report is worth one retry')
  assert.equal(verifyReport(null).ok, false, 'null input is safe')
}

// ── Empty critical section is flagged and targeted for retry ────────────────────
{
  // Competition populated, Opportunities empty.
  const signals = [
    good(1, 'a.com', 'CompetitorFunding'),
    good(2, 'b.com', 'CompetitorHiring'),
    good(3, 'c.com', 'CompetitorLaunch'),
    good(4, 'd.com', 'CompetitorLayoff'),
  ]
  const r = verifyReport(signals)
  assert.equal(r.ok, false, 'a missing critical section must fail the gate')

  const empty = r.gaps.find(g => g.type === 'empty_section')
  assert.ok(empty, 'empty_section gap present')
  assert.equal(empty.section, 'Opportunities')
  assert.deepEqual(retryTargetsFor(r.gaps), ['Opportunities'], 'retry targets the empty section')

  // Regulatory is intentionally NOT critical — it is genuinely quiet most weeks, and
  // flagging it would train the founder to ignore the disclosure.
  assert.ok(!r.gaps.some(g => g.section === 'Regulatory'), 'non-critical section not flagged')
}

// ── Thin report ─────────────────────────────────────────────────────────────────
{
  const r = verifyReport([good(1, 'a.com'), good(2, 'b.com', 'CompetitorFunding')])
  assert.ok(r.gaps.some(g => g.type === 'thin_report'), 'below minSignals is flagged')
  assert.equal(VERIFIER_THRESHOLDS.minSignals, 4)
}

// ── Source diversity + concentration ────────────────────────────────────────────
{
  // Four signals, all one outlet: one story, not four.
  const sameDomain = [
    good(1, 'only.com', 'DemandSignal'),
    good(2, 'only.com', 'CustomerShift'),
    good(3, 'only.com', 'CompetitorFunding'),
    good(4, 'only.com', 'CompetitorLaunch'),
  ]
  const r = verifyReport(sameDomain)
  assert.ok(r.gaps.some(g => g.type === 'low_source_diversity'), 'single-domain set fails diversity')

  // Dominant-but-not-sole source.
  const skewed = [
    good(1, 'big.com', 'DemandSignal'),
    good(2, 'big.com', 'CustomerShift'),
    good(3, 'big.com', 'MarketExpansion'),
    good(4, 'big.com', 'IndustryMomentum'),
    good(5, 'small.com', 'CompetitorFunding'),
  ]
  const skewedResult = verifyReport(skewed)
  assert.ok(
    skewedResult.gaps.some(g => g.type === 'source_concentration'),
    '80% from one domain is flagged as concentration'
  )
}

// ── Non-retryable defects are marked as such ────────────────────────────────────
{
  // Both critical sections are covered, so the ONLY defect under test is the missing
  // citations — otherwise an empty section would contribute its own (retryable) gap and
  // mask what this case is checking.
  const covered = ['DemandSignal', 'CustomerShift', 'CompetitorFunding', 'CompetitorLaunch']

  // Missing citations: more searching cannot repair signals we already hold.
  const noSources = covered.map((category, i) => ({ ...good(i + 1, `x${i}.com`, category), source_url: '' }))
  const r = verifyReport(noSources)
  const missing = r.gaps.find(g => g.type === 'missing_sources')
  assert.ok(missing, 'missing sources flagged')
  assert.equal(missing.retryable, false, 'missing citations are not retryable')
  assert.ok(!r.gaps.some(g => g.type === 'empty_section'), 'fixture covers both critical sections')
  assert.deepEqual(retryTargetsFor(r.gaps), [], 'non-retryable gaps produce no retry targets')

  const lowDates = covered.map((category, i) => ({ ...good(i + 1, `d${i}.com`, category), date_confidence: 'low' }))
  const dateGap = verifyReport(lowDates).gaps.find(g => g.type === 'low_date_confidence')
  assert.ok(dateGap, 'low date confidence flagged')
  assert.equal(dateGap.retryable, false, 'unverifiable dates are not retryable')

  // Signals carry event_date / published_date, not `date`. Dated signals must not count as undated.
  const eventDated = covered.map((category, i) => {
    const { date, ...rest } = good(i + 1, `e${i}.com`, category)
    return { ...rest, event_date: '2026-07-01', date_confidence: 'high' }
  })
  assert.ok(!verifyReport(eventDated).gaps.find(g => g.type === 'low_date_confidence'),
    'a signal dated by event_date is not unverifiable')

  assert.deepEqual(retryTargetsFor(null), [], 'null gaps are safe')
}

// ── The bar is not lowered for gap-fill signals ─────────────────────────────────
// stepVerify routes retried signals through applySignalFilters — the SAME chain the main
// analysis batches use. Proving that chain still rejects weak evidence proves a gap fill
// cannot smuggle in something a first-pass signal would have been dropped for.
{
  const batchText = 'Acme raised a Series B. Source: https://real.com/news'
  const candidates = [
    // Legitimate: cited URL appears in the batch, and it carries a read.
    { signal_headline: 'ok', entity_involved: 'Acme', source_url: 'https://real.com/news',
      so_what_for_you: 'Your closest competitor just extended its runway considerably.' },
    // Ungrounded: cites a URL never shown to the model.
    { signal_headline: 'hallucinated', entity_involved: 'Acme', source_url: 'https://invented.com/x',
      so_what_for_you: 'This should be dropped for citing a source we never supplied.' },
    // No read.
    { signal_headline: 'no-read', entity_involved: 'Acme', source_url: 'https://real.com/news' },
  ]

  const kept = applySignalFilters(candidates, batchText, 'Bahirjee').map(s => s.signal_headline)
  assert.deepEqual(kept, ['ok'], 'gap-fill path drops ungrounded and read-less signals')
}

// ── The gap-fill retry is bounded to once per run ───────────────────────────────
// A self-triggering retry without a hard ceiling is how a bounded retry becomes a loop
// that bills real money (internal design log). With `retried` already true, stepVerify
// must disclose the gap and attempt NO further retrieval — asserted by stubbing fetch and
// requiring that nothing reaches the network.
{
  const { stepVerify } = await import('../src/services/intelligenceService.js')

  let networkCalls = 0
  const realFetch = global.fetch
  global.fetch = async (...args) => { networkCalls += 1; return realFetch(...args) }

  const makeCtx = () => ({
    timer: { canAfford: () => true, logStep() {} },
    onProgress() {},
    stepped: false,
    job: { clientId: null, userId: null },
  })

  // Gaps exist (only two signals, one section) but the retry is already spent.
  const state = {
    context: { company_name: 'Acme', industry: 'fintech', operating_geography: 'India' },
    memory: { lookbackMonths: 12, previousSignalsTail: [] },
    analyze: { signals: [good(1, 'a.com', 'DemandSignal'), good(2, 'b.com', 'CustomerShift')] },
    verify: { retried: true },
    degradations: [],
  }

  await stepVerify(state, makeCtx())

  assert.equal(networkCalls, 0, 'no retrieval attempted once the retry is spent')
  assert.equal(state.verify.retried, true, 'retry flag stays spent')
  assert.ok(state.degradations.length > 0, 'surviving gaps are disclosed to the founder')
  assert.ok(
    state.degradations.some(d => /still found nothing/i.test(d.impact || '')),
    'disclosure states that a retry was already attempted'
  )

  // A clean report must record nothing and touch nothing.
  const healthy = {
    context: { company_name: 'Acme' },
    memory: { lookbackMonths: 12, previousSignalsTail: [] },
    analyze: {
      signals: [
        good(1, 'a.com', 'DemandSignal'),
        good(2, 'b.com', 'CustomerShift'),
        good(3, 'c.com', 'CompetitorFunding'),
        good(4, 'd.com', 'CompetitorLaunch'),
      ],
    },
    degradations: [],
  }
  networkCalls = 0
  await stepVerify(healthy, makeCtx())
  assert.equal(networkCalls, 0, 'a passing report triggers no retrieval')
  assert.equal(healthy.degradations.length, 0, 'a passing report discloses nothing')

  // An already-empty analysis is skipped entirely rather than crashing.
  const emptyState = { analyze: { empty: true }, degradations: [] }
  await stepVerify(emptyState, makeCtx())
  assert.equal(emptyState.degradations.length, 0, 'empty analysis is a no-op')

  global.fetch = realFetch
}

// ── Source-class provenance ─────────────────────────────────────────────────────
{
  const { attachSourceClass } = await import('../src/services/intelligenceService.js')

  const observations = [
    { url: 'https://sec.gov/filing/1', source_class: 'filing' },
    { url: 'https://g2.com/review/x', source_class: 'review' },
    { url: 'https://blog.example.com/post', source_class: null },
  ]

  const stamped = attachSourceClass([
    { source_url: 'https://sec.gov/filing/1' },
    { source_url: 'https://g2.com/review/x/' },          // trailing slash must still match
    { source_url: 'https://blog.example.com/post' },      // observation had no class
    { source_url: 'https://unrelated.com/z' },            // not in this batch at all
  ], observations)

  assert.equal(stamped[0].source_class, 'filing')
  assert.equal(stamped[1].source_class, 'review', 'trailing-slash difference must not lose provenance')
  assert.equal(stamped[2].source_class, undefined, 'an unclassified observation confers no class')
  assert.equal(stamped[3].source_class, undefined, 'an unmatched URL is never guessed at')

  // The join must use the SAME normalizer as filterGroundedSignals, which runs one step
  // earlier on the same pair of URLs. While this compared raw strings, a signal could
  // ground as `exact` and then fail to inherit its own observation's class purely because
  // the model wrote a different scheme or dropped a `www.` — which is how a live run
  // reached 90 grounded signals and zero source classes.
  const cosmetic = attachSourceClass([
    { source_url: 'http://sec.gov/filing/1' },            // scheme differs
    { source_url: 'https://www.g2.com/review/x' },        // www. differs
    { source_url: 'https://SEC.gov/Filing/1' },           // case differs
  ], observations)

  assert.equal(cosmetic[0].source_class, 'filing', 'scheme must not lose provenance')
  assert.equal(cosmetic[1].source_class, 'review', 'a www. prefix must not lose provenance')
  assert.equal(cosmetic[2].source_class, 'filing', 'case must not lose provenance')

  // A class the model invented must be overwritten by what we actually retrieved —
  // provenance is resolved from our own records, never accepted from the LLM.
  const lying = attachSourceClass([{ source_url: 'https://g2.com/review/x', source_class: 'filing' }], observations)
  assert.equal(lying[0].source_class, 'review', 'a model-supplied class must not survive')

  assert.deepEqual(attachSourceClass([], observations), [], 'empty input is safe')
  assert.equal(attachSourceClass(null, observations), null, 'null input is safe')
}

// ── Source-class diversity gate ─────────────────────────────────────────────────
{
  const sig = (cls, i) => ({
    category: 'DemandSignal', source_url: `https://s${i}.example.com/a`,
    date: '2026-07-01', source_class: cls,
  })

  // All one class → flagged.
  const oneClass = verifyReport([sig('news', 1), sig('news', 2), sig('news', 3), sig('news', 4), sig('news', 5)])
  assert.ok(
    oneClass.gaps.some(g => g.type === 'low_source_class_diversity'),
    'a brief built entirely from press coverage must be flagged'
  )

  // Mixed classes → not flagged.
  const mixed = verifyReport([sig('news', 1), sig('news', 2), sig('filing', 3), sig('tender', 4), sig('review', 5)])
  assert.ok(
    !mixed.gaps.some(g => g.type === 'low_source_class_diversity'),
    'a mixed evidence base must pass'
  )
  assert.equal(mixed.metrics.distinctSourceClasses, 4)
  assert.equal(mixed.metrics.sourceClasses.news, 2, 'per-class counts power the evidence-base strip')

  // Unclassified signals must not be read as narrowness — untiered search carries no
  // class by design, and firing on that would flag every run that predates provenance.
  const unclassified = verifyReport([sig(null, 1), sig(null, 2), sig(null, 3), sig(null, 4), sig(null, 5)])
  assert.ok(
    !unclassified.gaps.some(g => g.type === 'low_source_class_diversity'),
    'an unclassified run must not be flagged for narrowness it has not been shown to have'
  )
}

console.log('report verifier tests passed')
