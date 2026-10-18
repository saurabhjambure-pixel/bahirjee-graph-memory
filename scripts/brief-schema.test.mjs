/**
 * brief.v2 tests — the unified judgment shape.
 *
 * Three things here are load-bearing enough that a silent regression would undo the
 * repositioning rather than merely break a feature:
 *
 *   1. CONFIDENCE IS CAPPED BY TIER. A shallow run must be structurally incapable of
 *      reporting High. Without that the free tier self-reports High and there is nothing
 *      left to sell.
 *   2. NOTHING IS DROPPED. bahirjee_observation and insights have live consumers.
 *   3. THE ADVICE GUARD BINDS. The prompts were relaxed to permit judgment; this regex is
 *      the only executable thing between that and a generic advice chatbot.
 *
 * Run: npm run test:brief
 */
import assert from 'node:assert/strict'
import {
  normalizeBrief,
  calibrateConfidence,
  detectAdviceLeakage,
  auditBriefVoice,
  ADVICE_PHRASES,
  BRIEF_SCHEMA_VERSION,
} from '../src/services/briefSchema.js'

const richSignals = Array.from({ length: 14 }, (_, i) => ({
  source_url: `https://src${i % 7}.example.com/a${i}`,
  source_class: ['news', 'filing', 'review'][i % 3],
  the_move: `Competitor move ${i}`,
  relevance_score: 100 - i,
  analyst_note: `Reasoning ${i}. If their next openings are sales rather than support, this read is wrong.`,
}))

// ── Confidence is computed, never taken ─────────────────────────────────────────
{
  // The product mechanic: identical evidence, different tier, different ceiling.
  assert.equal(calibrateConfidence({ signals: richSignals, depth: 'full', claimed: 'High' }).level, 'High')
  assert.equal(
    calibrateConfidence({ signals: richSignals, depth: 'shallow', claimed: 'High' }).level,
    'Medium',
    'a shallow run must never reach High confidence — this is the paywall'
  )

  // The model may be humbler than the arithmetic, never more certain.
  assert.equal(calibrateConfidence({ signals: richSignals, depth: 'full', claimed: 'Low' }).level, 'Low')
  const overreach = calibrateConfidence({ signals: richSignals.slice(0, 2), depth: 'full', claimed: 'High' })
  assert.equal(overreach.level, 'Low', 'thin evidence caps at Low regardless of the claim')
  assert.equal(overreach.claimed, 'High', 'the overreach is recorded, not silently discarded')

  // Ungrounded signals must not inflate the count — the whole basis is traceable evidence.
  const ungrounded = Array.from({ length: 20 }, () => ({ source_url: null, source_class: 'news' }))
  assert.equal(calibrateConfidence({ signals: ungrounded, depth: 'full' }).evidence_count, 0)
  assert.equal(calibrateConfidence({ signals: [], depth: 'full' }).level, 'Low')

  // Calibration guard. This assertion used to pin the OPPOSITE: 70 signals across 70
  // domains with `source_class: null` had to reach High, because real runs produced zero
  // classes and gating on the field would have pinned every run to Low.
  //
  // That emptiness was a bug, not a fact about the world — getObservationsForRun never
  // selected source_class, so the label never reached attachSourceClass. With the round
  // trip repaired, breadth alone no longer buys High: 70 findings that are all one kind of
  // knowing are 70 versions of the same way of looking.
  const oneKindOfKnowing = Array.from({ length: 70 }, (_, i) => ({
    source_url: `https://d${i}.example.com/p`, source_class: 'news', relevance_score: 100 - i,
  }))
  assert.equal(
    calibrateConfidence({ signals: oneKindOfKnowing, depth: 'full' }).level, 'Low',
    'breadth without variety of source KIND is not high confidence'
  )

  // The volume ceiling still discriminates once the evidence is genuinely varied.
  const varied = Array.from({ length: 70 }, (_, i) => ({
    source_url: `https://d${i}.example.com/p`,
    source_class: ['news', 'filing', 'review', 'government'][i % 4],
    relevance_score: 100 - i,
  }))
  assert.equal(
    calibrateConfidence({ signals: varied, depth: 'full' }).level, 'High',
    'a broad, varied full run still reaches High — the tier distinction must survive'
  )
  assert.equal(
    calibrateConfidence({ signals: varied, depth: 'shallow' }).level, 'Medium',
    'and the same evidence on a shallow run must still cap below High'
  )

  // A shallow run says why it is capped, so the disclosure and the badge agree.
  assert.match(calibrateConfidence({ signals: richSignals, depth: 'shallow' }).basis, /shallow scan/i)
}

// ── Verifier warnings cap confidence ────────────────────────────────────────────
{
  // The defect this closes: a live run reported High off 90 findings across 58 domains
  // while the same verdict recorded that 100% of those findings had unverifiable dates and
  // 10 of 12 tracked competitors had no supporting evidence. Both numbers were computed,
  // printed, and ignored by the one number the founder reads.
  const varied = Array.from({ length: 70 }, (_, i) => ({
    source_url: `https://d${i}.example.com/p`,
    source_class: ['news', 'filing', 'review', 'government'][i % 4],
    relevance_score: 100 - i,
  }))
  const gate = (id, status) => ({ id, status, detail: `${id} detail`, blocking: false })

  assert.equal(
    calibrateConfidence({ signals: varied, depth: 'full', gates: [gate('date_confidence', 'pass')] }).level,
    'High',
    'a passing gate costs nothing'
  )
  assert.equal(
    calibrateConfidence({ signals: varied, depth: 'full', gates: [gate('date_confidence', 'warn')] }).level,
    'Medium',
    'one unresolved check is a caveat'
  )

  const capped = calibrateConfidence({
    signals: varied,
    depth: 'full',
    gates: [gate('date_confidence', 'warn'), gate('competitor_validation', 'warn')],
  })
  assert.equal(capped.level, 'Low', 'two unresolved checks are a pattern')
  assert.deepEqual(
    capped.capped_by, ['date_confidence', 'competitor_validation'],
    'a capped run must be distinguishable from one that simply had thin evidence'
  )
  assert.match(capped.basis, /Held at Low by 2 unresolved checks/, 'the cap must be stated, not merely applied')
  assert.match(capped.basis, /date_confidence detail/, 'and it must say which checks')

  // A model claim can still only lower, never raise, past the cap.
  assert.equal(
    calibrateConfidence({ signals: varied, depth: 'full', claimed: 'High', gates: [gate('x', 'warn'), gate('y', 'warn')] }).level,
    'Low'
  )
  // Absent gates behave exactly as before — every report written before this shipped.
  assert.equal(calibrateConfidence({ signals: varied, depth: 'full' }).level, 'High')
  assert.deepEqual(calibrateConfidence({ signals: varied, depth: 'full' }).capped_by, [])
}

// ── Every historical brief shape maps onto v2 ───────────────────────────────────
{
  // An empty run persists `brief` as a plain STRING, and rows in that shape are already
  // in the database — which is why the READ path normalizes too.
  const fromString = normalizeBrief('No material shifts detected in selected signal rings.', { tier: 'shallow' })
  assert.equal(fromString.schema, BRIEF_SCHEMA_VERSION)
  assert.equal(fromString.confidence.level, 'Low')
  assert.ok(fromString.what_could_change_our_view.length >= 1, 'even an empty run says what would change the view')
  assert.doesNotThrow(() => normalizeBrief(null, {}))
  assert.doesNotThrow(() => normalizeBrief(undefined, {}))

  // Company brief: the three live consumers keep their fields.
  const company = normalizeBrief(
    { bahirjee_observation: 'You are exposed on pricing.', insights: [{ type: 'risk', text: 'x' }] },
    { kind: 'company', signals: richSignals, tier: 'full', context: { contradictions: [{ observation: 'Site claims enterprise, pricing says SMB.' }] } }
  )
  assert.equal(company.bahirjee_observation, 'You are exposed on pricing.', 'BahirjeeObservationHero reads this')
  assert.equal(company.insights.length, 1, 'buildReportMemory rewrites insights[i] — dropping them breaks continuity')
  assert.equal(company.our_read, company.bahirjee_observation, 'our_read is an alias, not a new required key')

  // what_changed is deterministic and every item carries its source.
  assert.ok(company.what_changed.length > 0)
  for (const item of company.what_changed) {
    assert.ok(item.evidence_refs?.[0], 'every what_changed item must carry a source URL')
    assert.ok(item.text, 'and actual text')
  }

  // The two fields that were computed every run and shown to nobody now surface.
  assert.ok(
    company.what_could_change_our_view.some(f => /enterprise/i.test(f.text)),
    'context.contradictions must reach the brief'
  )
  assert.ok(
    company.what_could_change_our_view.some(f => /sales rather than support/i.test(f.text)),
    "each signal's analyst_note falsifier must reach the brief"
  )

  // A falsifier must actually falsify, and must not carry a bare hostname as its label.
  {
    const confirming = normalizeBrief(
      { bahirjee_observation: 'The read.' },
      {
        kind: 'company',
        signals: [{
          source_url: 'https://www.dhl.com/discover/b2b/retail-logistics',
          entity_involved: 'DHL',
          relevance_score: 99,
          the_move: 'x',
          // A live brief published exactly this under "what could change our view".
          analyst_note: 'Sellers increasingly rely on omni-channel routes. This trend is a strong driver for growth.',
        }],
      }
    )
    assert.ok(
      !confirming.what_could_change_our_view.some(f => /strong driver for growth/i.test(f.text)),
      'a confirmation must never be published as a falsifier — it turns the one adversarial section into more agreement'
    )
    for (const f of confirming.what_could_change_our_view) {
      assert.ok(
        !/^[a-z0-9-]+\.(com|in|net|org|io|ai)$/i.test(String(f.watch_for || '')),
        `watch_for must not be a bare hostname, got "${f.watch_for}"`
      )
    }

    const falsifying = normalizeBrief(
      { bahirjee_observation: 'The read.' },
      {
        kind: 'company',
        signals: [{
          source_url: 'https://www.dhl.com/discover/b2b/retail-logistics',
          entity_involved: 'DHL',
          relevance_score: 99,
          the_move: 'x',
          analyst_note: 'They lead on omni-channel. If their next quarter shows falling volumes, this read is wrong.',
        }],
      }
    )
    const kept = falsifying.what_could_change_our_view.find(f => /falling volumes/i.test(f.text))
    assert.ok(kept, 'a genuine falsifier must still reach the brief')
    assert.equal(kept.watch_for, 'DHL', 'watch_for names where it would show up, not the citation')
  }

  // Decision brief maps onto the same shape without losing its option comparison.
  const decision = normalizeBrief(
    {
      decision_snapshot: 'Enter the US?',
      current_read: 'The evidence favours holding.',
      confidence: 'High',
      what_would_change_assessment: ['A funded US entrant in this niche.'],
      validation_steps: ['Talk to five US buyers.'],
      tradeoffs: ['Speed trades against margin.'],
      option_assessments: [{ option_label: 'Enter now' }, { option_label: 'Hold' }],
    },
    { kind: 'decision', signals: richSignals, tier: 'shallow' }
  )
  assert.equal(decision.kind, 'decision')
  assert.equal(decision.our_read, 'The evidence favours holding.', 'current_read is the decision brief\'s our_read')
  assert.equal(decision.confidence.level, 'Medium', 'a shallow decision brief is capped too')
  assert.equal(decision.option_assessments.length, 2, 'option assessments survive normalization')
  assert.ok(decision.what_to_consider.length >= 2, 'validation_steps + tradeoffs become considerations')
  assert.ok(decision.what_could_change_our_view.some(f => /funded US entrant/i.test(f.text)))

  // Idempotent — the write path and the read path both call this.
  const twice = normalizeBrief(company, { kind: 'company', signals: richSignals, tier: 'full' })
  assert.equal(twice.our_read, company.our_read)
  assert.equal(twice.what_changed.length, company.what_changed.length)
  assert.equal(twice.insights.length, company.insights.length)
  assert.equal(twice.schema, BRIEF_SCHEMA_VERSION)
}

// ── The advice guard ────────────────────────────────────────────────────────────
{
  // The phrases the repositioning actually turns on, pinned INDEPENDENTLY of
  // ADVICE_PHRASES. Iterating the exported list only would be tautological — deleting a
  // phrase would delete its own test, which is exactly how a guard rots to nothing.
  const MUST_DETECT = [
    'you should', 'we recommend', 'act now', 'you need to',
    'the next step is', 'make sure to', 'it is advisable', 'focus on',
  ]
  for (const phrase of MUST_DETECT) {
    assert.ok(ADVICE_PHRASES.includes(phrase), `"${phrase}" was removed from the banned list`)
    assert.ok(
      detectAdviceLeakage(`Some lead-in ${phrase} something.`).includes(phrase),
      `"${phrase}" is listed but not detected`
    )
  }

  // Everything still on the list must also actually fire.
  for (const phrase of ADVICE_PHRASES) {
    assert.ok(
      detectAdviceLeakage(`Some lead-in ${phrase} something.`).includes(phrase),
      `"${phrase}" is listed but not detected`
    )
  }

  // Judgment in every allowed form must pass clean, or the guard makes the prompt
  // unusable and someone will delete it.
  const allowed = [
    'The evidence currently favours holding because three of five signals point at slowing demand. It stops favouring holding if the regulator moves before Q3.',
    'Speed and margin trade against each other here: entering now costs roughly a third of gross margin.',
    'This turns on whether US buyers procure annually, which nothing found here answers.',
  ]
  for (const line of allowed) {
    assert.deepEqual(detectAdviceLeakage(line), [], `a legitimate judgment tripped the guard: "${line}"`)
  }

  // The audit walks exactly the judgment-bearing fields.
  const leaks = auditBriefVoice({
    our_read: 'We recommend raising now.',
    why_it_matters: 'Demand is shifting.',
    what_to_consider: [{ text: 'You should focus on enterprise.' }, { text: 'Speed trades against margin.' }],
  })
  const fields = leaks.map(l => l.field)
  assert.ok(fields.includes('our_read'), 'our_read is audited')
  assert.ok(fields.includes('what_to_consider[0]'), 'each consideration is audited individually')
  assert.ok(!fields.includes('what_to_consider[1]'), 'a clean consideration is not flagged')
  assert.ok(!fields.includes('why_it_matters'), 'clean prose is not flagged')
  assert.deepEqual(auditBriefVoice(null), [], 'a missing brief is safe')
}

console.log('brief schema tests passed')

// ── Stated bets are load-bearing ────────────────────────────────────────────────
// `strategic_assumptions` had four write sites and zero readers for its entire existence,
// while the onboarding form told founders it "improves blind spot detection". These pin
// the three consumers that made that claim true.
{
  const { PROMPTS } = await import('../src/services/promptUtils.js')
  const { detectUntestedBets } = await import('../src/services/blindSpotEngine.js')
  const { generateContextAwareQueries, flattenQueriesForTavily } = await import('../src/services/queryGenerator.js')
  const { resolveRunTier } = await import('../src/services/runTiers.js')

  const bets = [
    { statement: 'Enterprise buyers will increase SaaS budgets', domain: 'Demand', sensitivity: 'High' },
    { statement: 'Regulation will not touch our category', domain: 'Regulation', sensitivity: 'High' },
    { statement: 'Cloud costs stay flat', domain: 'Cost', sensitivity: 'Low' },
  ]
  const ctxWith = { company_name: 'Acme', _startupContext: { strategic_assumptions: bets } }
  const ctxWithout = { company_name: 'Acme' }

  // 1. Both brief prompts must show the bets and ask for a verdict on each.
  for (const [name, withBets, without] of [
    ['buildSummary', PROMPTS.buildSummary(ctxWith, [], {}), PROMPTS.buildSummary(ctxWithout, [], {})],
    ['generateDecisionBrief', PROMPTS.generateDecisionBrief(ctxWith, {}, [], {}), PROMPTS.generateDecisionBrief(ctxWithout, {}, [], {})],
  ]) {
    assert.ok(/STATED BETS/.test(withBets), `${name} does not show the founder's bets`)
    assert.ok(/Enterprise buyers will increase SaaS budgets/.test(withBets), `${name} does not include the bet text`)
    assert.ok(/assumption_status/.test(withBets), `${name} does not ask for a verdict on each bet`)
    // And must stay clean when there are none — an empty bets block is prompt noise.
    assert.ok(!/STATED BETS/.test(without), `${name} shows an empty bets block`)
    assert.ok(!/assumption_status/.test(without), `${name} asks for assumption_status with no bets`)
  }

  // 2. A High-sensitivity bet whose domain drew no evidence IS a blind spot — the literal
  //    claim the onboarding form makes.
  const patterns = [{ theme: 'customer_demand_shift' }, { theme: 'competitor_activity' }]
  const untested = detectUntestedBets(ctxWith, patterns)
  assert.equal(untested.length, 1, 'exactly the regulation bet should be untested')
  assert.match(untested[0].statement, /Regulation will not touch/)
  assert.ok(!untested.some(b => /Cloud costs/.test(b.statement)), 'a Low-sensitivity bet must not be reported')
  assert.deepEqual(detectUntestedBets({}, patterns), [], 'no bets is safe')
  // With no patterns at all, nothing was tested — so every High-sensitivity bet is a blind
  // spot, not just the one whose domain went uncovered.
  assert.equal(detectUntestedBets(ctxWith, []).length, 2, 'a run that found nothing tested no bets')

  // 3. Bets reserve retrieval budget on BOTH tiers, or they never steer anything.
  const genArgs = {
    entities: [{ name: 'Rival', category: 'competitor' }],
    signalWeights: { competitor_moves: 5, regulatory: 3 },
    marketProfile: { industry: 'logistics' }, geography: 'India', companyName: 'Acme',
    customerSegments: [], tierProfile: {},
  }
  for (const tier of ['shallow', 'full']) {
    const buckets = generateContextAwareQueries({ ...genArgs, runBudget: resolveRunTier(tier), strategicAssumptions: bets })
    const flat = Object.values(flattenQueriesForTavily(buckets)).flat()
    assert.ok(
      flat.some(q => /Regulation will not touch/.test(q)),
      `${tier}: a High-sensitivity bet reserved no query — strategic_assumptions is write-only again`
    )
    assert.ok(!flat.some(q => /Cloud costs/.test(q)), `${tier}: a Low-sensitivity bet should not spend budget`)
  }

  // A bucket missing from QUERY_BUCKET_THEMES is silently dropped before search — the
  // documented fate of competitor_discovery and adjacent_trends.
  const { QUERY_BUCKET_THEMES } = await import('../src/services/intelligenceService.js')
  assert.ok(QUERY_BUCKET_THEMES.assumption_lens, 'assumption_lens has no theme mapping and would be dropped')
  assert.ok(QUERY_BUCKET_THEMES.decision_lens, 'decision_lens has no theme mapping and would be dropped')
}

console.log('stated bet tests passed')
