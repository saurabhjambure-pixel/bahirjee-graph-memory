/**
 * Retrieval depth tests — source tiers, tier→provider mapping, and deep-read selection.
 *
 * These cover the levers that decide WHAT evidence a report is built from:
 *   - tier queries exist and carry a domain allowlist (steering away from news-only)
 *   - tier survives generation → flattening → execution
 *   - deep-read selection prefers long-form, stays diverse, and is deterministic
 *
 * Run: npm run test:retrieval
 */
import assert from 'node:assert/strict'
import { buildTierQueries, domainsForTier, exaCategoryForTier, sourceClassForTier, tierApplies, profileFromContext, SOURCE_TIERS, TIER_BUCKETS } from '../src/services/sourceTiers.js'
import { generateContextAwareQueries, flattenQueriesForTavily, MAX_QUERIES } from '../src/services/queryGenerator.js'
import { RUN_TIERS, resolveRunTier, depthGapsFor } from '../src/services/runTiers.js'
import { selectDeepReadTargets, QUERY_BUCKET_THEMES, QUERY_BUCKET_TIERS, capObservations, normalizeObservationUrl, planAnalyzeBatches, compressObservation, deepReadObservation, DEEP_READ_SNIPPET_CHARS } from '../src/services/intelligenceService.js'
import { isDeepReadSourceType } from '../src/services/observationService.js'

// ── Source tiers ────────────────────────────────────────────────────────────────
{
  // Unconditional tiers only: `supply` is gated on a physical supply chain and is
  // correctly absent for the default (unclassified) profile.
  const tierCount = Object.keys(SOURCE_TIERS).filter(t => !SOURCE_TIERS[t].requiresProfile).length
  const tiers = buildTierQueries({ industry: 'FinTech', vertical: 'payments', geo: 'India', year: 2026, limit: 3 })
  assert.equal(tiers.length, 3, 'expected 3 tier queries')
  assert.equal(new Set(tiers.map(t => t.tier)).size, 3, 'round-robin should cover every tier before repeating')

  // The floor must reach every tier before any tier gets depth, or a tier added to close
  // a coverage gap silently never runs.
  const full = buildTierQueries({
    industry: 'FinTech', vertical: 'payments', geo: 'India', year: 2026,
    limit: tierCount, entities: [{ name: 'RivalPay', category: 'competitor' }],
  })
  assert.equal(new Set(full.map(t => t.tier)).size, tierCount, 'every tier must be reachable at limit = tier count')

  // Depth goes to the thinnest-covered tiers, not to whichever key was declared first.
  const withDepth = buildTierQueries({
    industry: 'FinTech', vertical: 'payments', geo: 'India', year: 2026,
    limit: tierCount + 2, entities: [{ name: 'RivalPay', category: 'competitor' }],
  })
  const depthCounts = withDepth.reduce((acc, t) => ({ ...acc, [t.tier]: (acc[t.tier] || 0) + 1 }), {})
  assert.equal(depthCounts.reviews, 2, 'reviews is the thinnest-covered domain and must get depth first')
  assert.equal(depthCounts.government, 2, 'government tenders/policy is the second thinnest')

  // Entity-shaped templates must fill or drop — never emit quoted emptiness.
  const withEntity = buildTierQueries({
    industry: 'FinTech', vertical: 'payments', geo: 'India', year: 2026,
    limit: 99, entities: [{ name: 'RivalPay', category: 'competitor' }],
  })
  assert.ok(
    withEntity.some(t => t.tier === 'reviews' && t.query.includes('"RivalPay"')),
    'a review query must name an actual competitor'
  )
  const noEntity = buildTierQueries({ industry: 'FinTech', geo: 'India', year: 2026, limit: 99, entities: [] })
  assert.ok(!noEntity.some(t => /""/.test(t.query)), 'entity templates must drop, not emit empty quotes')
  assert.ok(!tiers.some(t => /[{}]/.test(t.query)), 'no unreplaced template placeholders')
  assert.ok(!tiers.some(t => /\s{2}/.test(t.query)), 'no double spaces from an empty variable')

  // An empty vertical must not leave artefacts behind.
  const noVertical = buildTierQueries({ industry: 'Logistics', vertical: '', geo: '', year: 2026, limit: 3 })
  assert.ok(!noVertical.some(t => /[{}]|\s{2}/.test(t.query)), 'empty vertical handled cleanly')

  assert.equal(buildTierQueries({ industry: 'X', limit: 0 }).length, 0, 'limit 0 yields nothing')
  // Must terminate rather than spin when templates run out.
  const supply = Object.values(SOURCE_TIERS).reduce((n, t) => n + t.templates.length, 0)
  assert.ok(buildTierQueries({ industry: 'X', limit: 999 }).length <= supply, 'cannot exceed template supply')
}

// ── Tier → provider steering ────────────────────────────────────────────────────
{
  assert.ok(domainsForTier('research').includes('arxiv.org'), 'research tier includes arxiv')
  assert.ok(domainsForTier('analyst').includes('mckinsey.com'), 'analyst tier includes mckinsey')
  assert.ok(domainsForTier('reviews').includes('g2.com'), 'reviews tier includes g2')
  assert.equal(domainsForTier('bogus'), null, 'unknown tier must not steer')

  // Geo-keyed tiers must route to the founder's own market, not a default one.
  const inGov = domainsForTier('government', 'Bengaluru, India')
  assert.ok(inGov.includes('pib.gov.in'), 'an Indian founder gets Indian government sources')
  assert.ok(!inGov.includes('gov.uk'), 'and not British ones')

  const ukGov = domainsForTier('government', 'United Kingdom')
  assert.ok(ukGov.includes('gov.uk') && !ukGov.includes('pib.gov.in'), 'UK routes to UK')

  const inNews = domainsForTier('regional_news', 'India')
  assert.ok(inNews.includes('entrackr.com'), 'Indian press for an Indian founder')
  assert.ok(inNews.includes('reuters.com'), 'global outlets always ride along')

  // An unparseable geography must still produce a usable allowlist.
  const unknown = domainsForTier('government', 'Mars')
  assert.ok(unknown?.length > 0, 'unknown geo still steers rather than falling back to the open web')

  // Geo-agnostic tiers ignore geography entirely.
  assert.deepEqual(domainsForTier('reviews', 'India'), domainsForTier('reviews', 'UK'))

  // Source classes must all be values the v20 CHECK constraint accepts.
  const VALID_CLASSES = new Set(['primary_company','filing','tender','government','review','social','research','analyst','news','code'])
  for (const tier of Object.keys(SOURCE_TIERS)) {
    const cls = sourceClassForTier(tier)
    assert.ok(cls && VALID_CLASSES.has(cls), `${tier} must declare a source_class the DB accepts (got ${cls})`)
  }

  assert.equal(exaCategoryForTier('research'), 'research paper')
  assert.equal(exaCategoryForTier('analyst'), 'pdf')
  assert.equal(exaCategoryForTier('discourse'), null, 'discourse intentionally uncategorised')
  assert.equal(exaCategoryForTier('bogus'), null)
}

// ── Conditional tiers stay off unless the company profile calls for them ────────
{
  const software = profileFromContext({ company_dna: { business_model: 'software' } })
  const hardware = profileFromContext({ company_dna: { business_model: 'hardware' } })
  const explicit = profileFromContext({ company_dna: { has_physical_supply_chain: true } })
  const unknown = profileFromContext({})

  assert.equal(tierApplies('supply', software), false, 'a SaaS company must not get freight news')
  assert.equal(tierApplies('supply', hardware), true, 'a hardware company must')
  assert.equal(tierApplies('supply', explicit), true, 'the explicit flag alone is enough')
  assert.equal(tierApplies('supply', unknown), false, 'an unclassified company defaults to OFF')
  assert.equal(tierApplies('reviews', unknown), true, 'unconditional tiers are unaffected')

  // research and technology are conditional too. They used to run for everyone, which is
  // how a logistics brief came back citing github.com, doi.org and researchgate.net.
  assert.equal(tierApplies('technology', software), true, 'a software company may publish code')
  assert.equal(tierApplies('technology', unknown), false, 'an unclassified company defaults to OFF')
  assert.equal(tierApplies('research', unknown), false, 'and gets no academic tier either')
  assert.equal(
    tierApplies('research', profileFromContext({ company_dna: { business_model: 'biotech' } })), true,
    'a field genuinely driven by literature still gets it'
  )

  // The coarse business_model enum cannot separate an operations business with a software
  // platform from a developer-tools company — both report 'software'. The explicit flag is
  // what carries the distinction, and it must win over the fallback.
  const opsWithPlatform = profileFromContext({
    company_dna: { business_model: 'software', has_physical_supply_chain: true },
  })
  assert.equal(tierApplies('technology', opsWithPlatform), false,
    'a 3PL running an AI platform is not a company whose rivals publish open source')
  assert.equal(tierApplies('supply', opsWithPlatform), true, 'but it does move physical goods')
  assert.equal(
    tierApplies('technology', profileFromContext({
      company_dna: { business_model: 'services', competes_on_public_technology: true },
    })), true,
    'the explicit flag overrides the coarse fallback in the permissive direction too'
  )

  // The gate must remove the tier from the BUDGET, not merely from the results — an
  // inapplicable tier that still consumes a reserved query has cost the founder a search.
  const args = { industry: 'x', geo: 'India', year: 2026, limit: 99, entities: [{ name: 'R' }] }
  const softQueries = buildTierQueries({ ...args, profile: software })
  const hardQueries = buildTierQueries({ ...args, profile: hardware })
  const noneQueries = buildTierQueries({ ...args, profile: unknown })
  assert.ok(!softQueries.some(q => q.tier === 'supply'), 'supply spends no budget for software')
  assert.ok(hardQueries.some(q => q.tier === 'supply'), 'and does for hardware')
  assert.ok(!noneQueries.some(q => ['supply', 'research', 'technology'].includes(q.tier)),
    'an unclassified company spends nothing on any conditional tier')
  // Compared against the no-conditional-tier baseline, so each side isolates its own gate
  // rather than trading one conditional tier for another.
  assert.ok(hardQueries.length > noneQueries.length, 'the conditional tier genuinely adds queries')
  assert.ok(softQueries.length > noneQueries.length, 'and so does the technology tier')
}

// ── The entity budget rotates instead of restarting at index 0 ──────────────────
{
  // The defect this pins: each category iterated its entity list from index 0 and stopped
  // at its own budget, which is ~1 once the tier, doc and demand floors are taken. Ten
  // categories therefore spent ten queries on the SAME first competitor and never named
  // the other eleven. Measured on the run that prompted this fix: the lead competitor was
  // named 8 times, every other tracked entity 0 times, 1 of 12 covered. The verifier then
  // reported "10 of 12 tracked competitors have no supporting evidence" — true, and
  // impossible to fix downstream, because no query had ever asked about them.
  const competitors = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel']
    .map(name => ({ name, category: 'competitor', metadata: {} }))

  const generated = generateContextAwareQueries({
    entities: competitors,
    signalWeights: {
      competitive_moves: 0.9, hiring_shifts: 0.8, funding_shifts: 0.7,
      pricing_changes: 0.6, market_expansion: 0.5, talent_migration: 0.4,
    },
    marketProfile: { industry: 'Logistics' },
    geography: 'India',
    companyName: 'Acme',
  })

  const text = Object.values(generated).flat().join(' | ').toLowerCase()
  const named = competitors.filter(c => text.includes(c.name.toLowerCase()))

  assert.equal(
    named.length, competitors.length,
    `every tracked entity must be named at least once when the budget allows it; ` +
    `unnamed: ${competitors.filter(c => !named.includes(c)).map(c => c.name).join(', ')}`
  )

  // And no single entity may monopolise the way the lead competitor used to. The bound is
  // loose on purpose: the entity-shaped TIER templates and the `competitor_name` fill both
  // reach for entities[0] independently of this cursor, so a small lead is expected and
  // correct. What must not recur is one entity taking the entire entity budget.
  const mentions = competitors.map(c =>
    (text.match(new RegExp(c.name.toLowerCase(), 'g')) || []).length
  )
  const busiest = Math.max(...mentions)
  assert.ok(
    busiest <= 3,
    `one entity was named ${busiest} times across ${mentions.reduce((a, b) => a + b, 0)} mentions — ` +
    `that is the starvation shape the cursor exists to prevent`
  )
}

// ── Tier survives the generation → flattening path ──────────────────────────────
{
  const generated = generateContextAwareQueries({
    entities: [
      { name: 'RivalPay', category: 'competitor', metadata: {} },
      { name: 'AWS', category: 'infra', metadata: {} },
    ],
    signalWeights: { competitive_moves: 0.9, hiring_shifts: 0.6, funding_shifts: 0.5 },
    marketProfile: { industry: 'FinTech', vertical: 'payments' },
    geography: 'India',
    companyName: 'Acme',
  })
  const flat = flattenQueriesForTavily(generated)

  // Conditional tiers are excluded: this fixture has no physical supply chain, so
  // `supply` correctly contributes nothing. Every unconditional tier must survive.
  for (const bucket of TIER_BUCKETS) {
    const tier = bucket.replace(/^tier_/, '')
    if (SOURCE_TIERS[tier]?.requiresProfile) {
      assert.equal(flat[bucket]?.length ?? 0, 0, `${bucket} is conditional and must not fire unprompted`)
      continue
    }
    assert.ok(flat[bucket]?.length > 0, `${bucket} must survive flattening (not be folded into a theme bucket)`)
  }
  assert.ok(Object.values(flat).flat().length <= MAX_QUERIES, 'total queries stay within budget')

  // Every bucket the flattener can emit must have a theme, or its queries are dropped
  // silently at the flatten step — the exact failure that hid competitor_discovery and
  // adjacent_trends for months.
  for (const bucket of Object.keys(flat)) {
    assert.ok(QUERY_BUCKET_THEMES[bucket], `bucket "${bucket}" has no theme mapping — its queries would be discarded`)
  }
  // And every tier bucket must resolve back to a real tier, or it loses its allowlist.
  for (const bucket of TIER_BUCKETS) {
    assert.ok(SOURCE_TIERS[QUERY_BUCKET_TIERS[bucket]], `${bucket} must map to a real tier`)
  }
}

// ── Deep-read selection ─────────────────────────────────────────────────────────
{
  const candidates = [
    { url: 'https://news.example.com/a', score: 0.99, queryIdx: 0, rank: 0, tier: null },
    { url: 'https://news.example.com/b', score: 0.98, queryIdx: 0, rank: 1, tier: null },
    { url: 'https://news.example.com/c', score: 0.97, queryIdx: 0, rank: 2, tier: null },
    { url: 'https://mckinsey.com/report.pdf', score: 0.40, queryIdx: 1, rank: 0, tier: 'analyst' },
    { url: 'https://arxiv.org/abs/1234', score: 0.30, queryIdx: 2, rank: 0, tier: 'research' },
    { url: 'https://news.example.com/d', score: 0.90, queryIdx: 3, rank: 0, tier: null },
  ]

  const picked = selectDeepReadTargets(candidates, 5)
  const urls = picked.map(c => c.url)

  // Long-form outranks higher-scoring news.
  assert.equal(urls[0], 'https://mckinsey.com/report.pdf', 'PDF should rank first')
  assert.equal(urls[1], 'https://arxiv.org/abs/1234', 'tier source should rank ahead of news')

  // Diversity: with enough candidates to choose from, no single query may supply
  // more than DEEP_READ_PER_QUERY_CAP reads.
  const perQuery = picked.reduce((m, c) => m.set(c.queryIdx, (m.get(c.queryIdx) ?? 0) + 1), new Map())
  assert.ok([...perQuery.values()].every(n => n <= 2), 'per-query cap respected when candidates are plentiful')

  assert.equal(picked.length, 5, 'budget fully spent')
  assert.equal(new Set(urls).size, urls.length, 'no duplicate URLs')

  // Determinism: shuffled input must produce identical output.
  const shuffled = [...candidates].reverse()
  assert.deepEqual(
    selectDeepReadTargets(shuffled, 5).map(c => c.url),
    urls,
    'selection must not depend on candidate arrival order'
  )

  // Scarce candidates: the diversity cap must NOT leave paid-for reads unspent.
  // Backfill deliberately overrides the per-query cap here — an unused read budget is a
  // worse outcome than a less diverse one, and this is the documented tradeoff.
  const scarce = [
    { url: 'https://n.example.com/a', score: 0.99, queryIdx: 0 },
    { url: 'https://n.example.com/b', score: 0.98, queryIdx: 0 },
    { url: 'https://n.example.com/c', score: 0.97, queryIdx: 0 },
    { url: 'https://mck.example.com/r.pdf', score: 0.40, queryIdx: 1, tier: 'analyst' },
  ]
  const scarcePicked = selectDeepReadTargets(scarce, 4)
  assert.equal(scarcePicked.length, 4, 'budget spent even when it breaches the per-query cap')
  assert.equal(scarcePicked[0].url, 'https://mck.example.com/r.pdf', 'long-form still ranks first')
  assert.equal(new Set(scarcePicked.map(c => c.url)).size, 4, 'backfill must not duplicate')

  // Dedupe keeps the higher-scoring instance of a repeated URL.
  const dupes = [
    { url: 'https://x.com/p', score: 0.2, queryIdx: 0 },
    { url: 'https://x.com/p', score: 0.8, queryIdx: 1 },
  ]
  const deduped = selectDeepReadTargets(dupes, 5)
  assert.equal(deduped.length, 1, 'duplicate URLs collapse')
  assert.equal(deduped[0].score, 0.8, 'higher-scoring duplicate wins')
}

// ── Demand intelligence ─────────────────────────────────────────────────────────
{
  const segments = [
    { segment: 'Rural banking agents', pain_points: ['cash liquidity', 'KYC delays'] },
    { segment: 'Micro-lenders', pain_points: ['default risk'] },
    { segment: 'Payment aggregators', pain_points: [] },
  ]
  const baseArgs = {
    signalWeights: { competitive_moves: 0.9, hiring_shifts: 0.6, funding_shifts: 0.5 },
    marketProfile: { industry: 'FinTech', vertical: 'payments', target_persona: 'CFO' },
    geography: 'India',
    companyName: 'Acme',
  }

  // 1. The no-upload path: segments alone must produce demand queries.
  const noDoc = generateContextAwareQueries({
    ...baseArgs,
    entities: [{ name: 'RivalPay', category: 'competitor', metadata: {} }],
    customerSegments: segments,
  })
  const demand = noDoc.demand_signals || []
  assert.ok(demand.length > 0, 'segments alone must generate demand queries (no upload required)')
  assert.ok(
    demand.some(q => q.includes('Rural banking agents')),
    'demand queries must name an actual customer segment, not just the industry'
  )
  assert.ok(!demand.some(q => /[{}]/.test(q)), 'no unreplaced placeholders in demand queries')

  // Pain points must actually be used — they were dead data before this change.
  assert.ok(
    demand.some(q => q.includes('cash liquidity') || q.includes('KYC delays') || q.includes('default risk')),
    'pain_points must reach the query layer'
  )

  // 2. Bucket survival: demand_signals must not be folded into customer_shifts.
  const flatNoDoc = flattenQueriesForTavily(noDoc)
  assert.ok(flatNoDoc.demand_signals?.length > 0, 'demand_signals must survive flattening as its own bucket')
  assert.ok(Object.values(flatNoDoc).flat().length <= MAX_QUERIES, 'total queries stay within MAX_QUERIES')

  // 3. Absorptive floor: doc-named customers count toward the demand floor, so adding
  //    them must NOT stack a second full reservation on top of the doc floor.
  const docCustomers = Array.from({ length: 3 }, (_, i) => ({
    name: `BigAccount${i}`,
    category: 'customer',
    metadata: { source: 'internal_doc' },
  }))
  const withDoc = generateContextAwareQueries({
    ...baseArgs,
    entities: [{ name: 'RivalPay', category: 'competitor', metadata: {} }, ...docCustomers],
    customerSegments: segments,
  })
  assert.ok(
    (withDoc.demand_signals || []).length < demand.length,
    'doc-named customers must absorb demand-floor slots rather than adding to them'
  )
  assert.ok(Object.values(flattenQueriesForTavily(withDoc)).flat().length <= MAX_QUERIES, 'budget still respected with doc entities')

  // 4. Competitor coverage must survive the new floor — the failure mode the plan flagged.
  const competitorQueries = [
    ...(withDoc.competitive_moves || []),
    ...(withDoc.product_removals || []),
    ...(withDoc.hiring_shifts || []),
    ...(withDoc.funding_shifts || []),
  ]
  assert.ok(competitorQueries.length > 0, 'demand floor must not starve competitor/entity coverage')

  // 5. Demand queries require a buyer anchor — a segment or, failing that, a persona.
  //    With no segments the persona query still fires: it names a real buyer and asks
  //    about budget, which is demand-shaped. What must NEVER happen is bare-industry filler.
  const noSegments = generateContextAwareQueries({
    ...baseArgs,
    entities: [{ name: 'RivalPay', category: 'competitor', metadata: {} }],
    customerSegments: [],
  })
  const personaOnly = noSegments.demand_signals || []
  assert.ok(personaOnly.every(q => q.includes('CFO')), 'with no segments, demand queries must still name the buyer persona')

  // With neither a segment nor a persona there is no buyer to anchor on — emit nothing
  // rather than falling back to the generic industry query this change exists to kill.
  const noAnchor = generateContextAwareQueries({
    ...baseArgs,
    marketProfile: { industry: 'FinTech', vertical: 'payments' }, // no target_persona
    entities: [{ name: 'RivalPay', category: 'competitor', metadata: {} }],
    customerSegments: [],
  })
  assert.equal((noAnchor.demand_signals || []).length, 0, 'no buyer anchor ⇒ no demand queries (never generic filler)')

  // 6. Bare-string segments (a looser context shape) must still work.
  const bareStrings = generateContextAwareQueries({
    ...baseArgs,
    entities: [],
    customerSegments: ['Rural banking agents', 'Micro-lenders'],
  })
  assert.ok((bareStrings.demand_signals || []).length > 0, 'bare-string segments supported')
}

// ── URL normalization collapses the same page across channels ───────────────────
{
  const same = [
    'https://example.com/article',
    'http://example.com/article',
    'https://www.example.com/article/',
    'https://example.com/article?utm_source=newsletter&utm_medium=email',
    'https://EXAMPLE.com/article',
  ].map(normalizeObservationUrl)
  assert.equal(new Set(same).size, 1, 'scheme, www, trailing slash and utm params are all noise')

  // But real differences must survive — over-merging silently deletes evidence.
  assert.notEqual(normalizeObservationUrl('https://example.com/a'), normalizeObservationUrl('https://example.com/b'))
  assert.notEqual(normalizeObservationUrl('https://example.com/x?id=1'), normalizeObservationUrl('https://example.com/x?id=2'))
  assert.notEqual(normalizeObservationUrl('https://a.example.com/p'), normalizeObservationUrl('https://b.example.com/p'))
  assert.equal(normalizeObservationUrl(''), '')
  assert.ok(normalizeObservationUrl('not a url'), 'unparseable input still yields a key rather than merging')
}

// ── The observation cap thins every class instead of deleting the rare ones ──────
{
  // Reproduces the real arrival order: search first (all news), connectors last. A plain
  // slice() would keep only news and drop every tender and filing — while still logging
  // a correct-looking "capped to N".
  const obs = [
    ...Array.from({ length: 180 }, (_, i) => ({ url: `https://n${i}.com`, source_class: 'news' })),
    ...Array.from({ length: 20 }, (_, i) => ({ url: `https://p${i}.com`, source_class: 'primary_company' })),
    ...Array.from({ length: 12 }, (_, i) => ({ url: `https://t${i}.com`, source_class: 'tender' })),
    ...Array.from({ length: 8 }, (_, i) => ({ url: `https://f${i}.com`, source_class: 'filing' })),
    ...Array.from({ length: 30 }, (_, i) => ({ url: `https://u${i}.com` })),   // unclassified
  ]

  const capped = capObservations(obs, 100)
  assert.equal(capped.length, 100, 'cap is respected')

  const counts = capped.reduce((a, o) => ({ ...a, [o.source_class || 'unclassified']: (a[o.source_class || 'unclassified'] || 0) + 1 }), {})
  assert.equal(counts.tender, 12, 'every tender survives — they are rare and irreplaceable')
  assert.equal(counts.filing, 8, 'every filing survives')
  assert.equal(counts.primary_company, 20, 'every primary-source page survives')
  assert.ok(counts.news < 180, 'the abundant class absorbs the cut')

  // Order must be preserved: selection decides what survives, not what the model sees together.
  const idx = capped.map(o => obs.indexOf(o))
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), 'original ordering is preserved')

  // Under the cap, nothing changes at all.
  const small = obs.slice(0, 50)
  assert.equal(capObservations(small, 200), small, 'a run under the cap is returned untouched')
  assert.deepEqual(capObservations([], 10), [], 'empty input is safe')
}

// ── Run tiers ───────────────────────────────────────────────────────────────────
// The free tier buys LESS RESEARCH, not less display. These pin the two ways that can
// silently stop being true: floors that over-subscribe the budget, and a shallow run
// that quietly costs the same as a full one.
{
  // The failure this exists to catch: the full-tier floors were each sized against a
  // 22-query budget and sum to 17. Reused verbatim at 8 they would consume the entire
  // budget on source tiers, and the run would say nothing about the question asked.
  for (const [name, tier] of Object.entries(RUN_TIERS)) {
    const floors = tier.docQueryFloor + tier.tierQueryFloor + tier.demandQueryFloor
    assert.ok(
      floors < tier.maxQueries,
      `${name}: reserved floors (${floors}) must leave room inside maxQueries (${tier.maxQueries})`
    )
    assert.ok(tier.inquiryQueryFloor >= 1, `${name}: the founder's own question must keep a reserved slot`)
  }

  // Shallow is genuinely cheaper on every axis that costs money. Cost scales with
  // observations (each may add an analyze batch), not with searches.
  const shallow = resolveRunTier('shallow')
  const full = resolveRunTier('full')
  for (const key of ['maxQueries', 'maxDeepReads', 'searchResultsPerQuery', 'maxObservations', 'maxSummarySignals']) {
    assert.ok(shallow[key] < full[key], `shallow.${key} must be below full.${key}`)
  }
  assert.equal(shallow.sourceWatch, false, 'shallow must not spend fetches on source watch')
  assert.equal(shallow.connectors, false, 'shallow must not call connectors')
  assert.ok(full.sourceWatch && full.connectors, 'full tier keeps every source')

  // Unknown/missing names resolve to full — cron and admin runs never carry a tier, and
  // silently downgrading them would thin the scheduled runs that make watch worthwhile.
  assert.equal(resolveRunTier(undefined).name, 'full')
  assert.equal(resolveRunTier('nonsense').name, 'full')
  assert.equal(resolveRunTier(null).name, 'full')

  // Generation actually honours the budget it is handed.
  const entities = [
    { name: 'Acme', category: 'competitor' }, { name: 'Globex', category: 'competitor' },
    { name: 'AWS', category: 'infra' }, { name: 'RBI', category: 'regulator' },
    { name: 'BigCo', category: 'customer', metadata: { source: 'internal_doc' } },
  ]
  const genArgs = {
    entities,
    signalWeights: { competitor_moves: 5, funding: 4, regulatory: 3, customer_shifts: 3, pricing_changes: 2 },
    marketProfile: { industry: 'logistics' },
    geography: 'India',
    companyName: 'Test',
    customerSegments: ['3PL operators'],
    tierProfile: {},
  }
  const countQueries = (buckets) => {
    const flat = flattenQueriesForTavily(buckets)
    return Array.isArray(flat) ? flat.length : Object.values(flat).flat().length
  }
  const shallowCount = countQueries(generateContextAwareQueries({ ...genArgs, runBudget: shallow }))
  const fullCount = countQueries(generateContextAwareQueries({ ...genArgs, runBudget: full }))

  assert.ok(shallowCount <= shallow.maxQueries, `shallow generated ${shallowCount} queries, over its ${shallow.maxQueries} cap`)
  assert.ok(fullCount <= full.maxQueries, `full generated ${fullCount} queries, over its ${full.maxQueries} cap`)
  assert.ok(shallowCount < fullCount, 'a shallow run must issue strictly fewer queries than a full one')

  // The default is full, so nothing that omits runBudget is silently downgraded.
  assert.equal(countQueries(generateContextAwareQueries(genArgs)), fullCount, 'omitting runBudget must behave as full')

  // Depth gaps are the paywall copy. Empty for full — that is what lets the same
  // component render for both tiers with no CTA on the paid side.
  assert.deepEqual(depthGapsFor('full', { skippedWatch: true, skippedConnectors: true }), [])
  const gaps = depthGapsFor('shallow', { skippedWatch: true, skippedConnectors: true })
  assert.ok(gaps.length >= 3, 'a shallow run must say what a full one would have added')
  // The TOTAL a run actually issues, not just the planned budget: express queries are
  // additive (they cannot come out of maxQueries without over-subscribing the floors), so
  // a full run really does spend maxQueries + expressQueries. Naming the smaller number
  // here would understate the very thing the founder is being asked to pay for.
  const fullSearches = full.maxQueries + (full.expressQueries || 0)
  const shallowSearches = shallow.maxQueries + (shallow.expressQueries || 0)
  assert.ok(gaps.some(g => g.includes(String(fullSearches))), 'depth gaps should name the real full-run search count')
  assert.ok(gaps.some(g => g.includes(String(shallowSearches))), 'depth gaps should name the real shallow search count')
  // Built from what the run actually skipped, so the copy cannot drift from the pipeline.
  assert.equal(depthGapsFor('shallow', { skippedWatch: false, skippedConnectors: false }).length, 2)
}

// ── Deep reads reach the model ──────────────────────────────────────────────────
// A deep read used to lose to its own search result about half the time (the dedupe kept
// whichever random UUID sorted first), read back labelled [Search] (the mapper checked for
// 'firecrawl' long after deep reads became 'parallel_ai'), and when it did survive, arrived
// cut to the same 1,200 chars as the snippet. The paid read added close to nothing.
{
  const log = console.log
  console.log = () => {}
  try {
    const url = 'https://analyst.example.com/outlook-2026.pdf'
    const page = ['Market Outlook 2026', '', ...Array.from({ length: 60 }, (_, i) =>
      `${i === 20 ? 'FINDING_BELOW_THE_FOLD ' : ''}${i === 50 ? 'BEYOND_THE_SLICE ' : ''}Paragraph ${i}: ${'segment pricing dynamics and demand. '.repeat(4)}`)].join('\n')
    const candidate = {
      url: 'http://www.analyst.example.com/outlook-2026.pdf/', title: 'Outlook 2026', theme: 'research',
      query: 'q', sourceClass: 'analyst', published_date: '2026-03-01', score: 0.5, queryIdx: 0,
    }
    assert.equal(selectDeepReadTargets([candidate])[0].published_date, '2026-03-01', 'selection must carry the search date to the read')

    const deep = { id: 'deep', ...deepReadObservation(candidate, { source: 'parallel_ai', text: page, title: null, publishDate: null }) }
    const search = { id: 'search', url, score: 0.6, data: `TITLE: Outlook\nURL: ${url}\nCONTENT: ${page}` }

    // Order-independent: the deep read stands in for its URL whichever row sorts first.
    for (const rows of [[search, deep], [deep, search]]) {
      assert.deepEqual(planAnalyzeBatches(rows).order, ['deep'], 'the deep read must replace its own search result in analysis')
    }

    // Round trip: what the write path stores must read back as a deep read.
    assert.equal(isDeepReadSourceType(deep.source_type), true, 'a parallel_ai row must read back as a deep read')
    assert.equal(isDeepReadSourceType('firecrawl'), true, 'pre-v23 deep reads still read back as deep reads')
    assert.equal(isDeepReadSourceType('tavily'), false)

    // An Exa-fallback read must not be stored as plain 'exa': that label means an Exa SEARCH
    // result, so the read would come back compressed and deduped as a snippet (v27).
    const exaRead = deepReadObservation(candidate, { source: 'exa', text: page, publishDate: null })
    assert.equal(exaRead.source_type, 'exa_extract', 'an Exa extract is stored under its own label')
    assert.equal(isDeepReadSourceType(exaRead.source_type), true, 'and reads back as a deep read')
    assert.equal(isDeepReadSourceType('exa'), false, 'an Exa search row is still a search row')

    // The model sees below the fold, and the slice is still a slice.
    const text = compressObservation(deep, 0)
    assert.ok(text.startsWith('[1] [Deep] '), 'a deep read must be labelled as one')
    assert.ok(text.includes('FINDING_BELOW_THE_FOLD'), 'content past the snippet budget must reach the model')
    assert.ok(!text.includes('BEYOND_THE_SLICE'), 'a deep read is bounded, not passed whole')
    assert.ok(text.length <= DEEP_READ_SNIPPET_CHARS + 500, `deep read compressed to ${text.length} chars`)
    assert.ok(!compressObservation(search, 0).includes('FINDING_BELOW_THE_FOLD'), 'search rows keep the snippet budget')

    // An extract with no line breaks used to pass whole, promoted to its own "title".
    const oneLine = compressObservation({ url, isDeepRead: true, data: 'x '.repeat(20000) }, 0)
    assert.ok(oneLine.length <= DEEP_READ_SNIPPET_CHARS + 500, `single-line extract compressed to ${oneLine.length} chars`)

    // The deep read must not know less than the row it replaces.
    assert.equal(deep.published_date, '2026-03-01', 'inherit the search date when the extractor finds none')
    assert.equal(
      deepReadObservation(candidate, { source: 'parallel_ai', text: page, publishDate: '2026-04-09' }).published_date,
      '2026-04-09', "the extractor's own date wins when it has one"
    )
    assert.equal(deepReadObservation(candidate, { source: 'parallel_ai', text: 'too short' }), null, 'a thin extract yields nothing')
  } finally {
    console.log = log
  }
}

console.log('retrieval depth tests passed')
