/**
 * Opportunity-centred sections — the taxonomy, the opportunity block, the schema that lets
 * the model emit it, and the prompt that asks for it.
 *
 * The failure this guards against is the codebase's usual one: nothing throws, the report is
 * just quietly worse. A category the prompt emits but no section holds renders as an orphan;
 * a field the prompt asks for but the Gemini schema omits never comes back; a legacy category
 * in a stored report with no home drops out of the founder's history.
 *
 * Run: npm run test:opportunity-sections
 */
import assert from 'node:assert/strict'
import {
  SIGNAL_CATEGORIES, SECTION_MAP, SECTIONS, SECTION_PRIORITY, CRITICAL_SECTIONS,
  CATEGORY_THEMES, OPPORTUNITY_CATEGORIES, LEGACY_CATEGORY_SECTIONS,
  sectionForCategory, splitSectionSignals, groupSectionsForDisplay,
} from '../src/services/signalTaxonomy.js'

let passed = 0
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

console.log('\nOpportunity sections\n')

await check('the four re-centred sections exist', () => {
  assert.equal(SECTIONS.OPPORTUNITIES, 'Opportunities')
  assert.equal(SECTIONS.CUSTOMERS, 'Customers')
  assert.equal(SECTIONS.FUNDING, 'Funding Opportunities')
  assert.equal(SECTIONS.SUPPLY, 'Vendors & Supply')
  for (const title of Object.values(SECTIONS)) {
    assert.ok(SECTION_MAP[title], `${title} has no SECTION_MAP entry`)
    assert.ok(Number.isFinite(SECTION_PRIORITY[title]), `${title} has no priority`)
  }
})

await check('categories land in the sections the founder asked for', () => {
  assert.equal(sectionForCategory('DemandSignal'), SECTIONS.OPPORTUNITIES)
  assert.equal(sectionForCategory('PartnershipOpportunity'), SECTIONS.OPPORTUNITIES)
  assert.equal(sectionForCategory('CustomerShift'), SECTIONS.CUSTOMERS)
  assert.equal(sectionForCategory('FundingOpportunity'), SECTIONS.FUNDING)
  assert.equal(sectionForCategory('CapitalClimate'), SECTIONS.FUNDING)
  assert.equal(sectionForCategory('SupplierShift'), SECTIONS.SUPPLY)
  // Others' money and others' market entry are competition, not the founder's funding or demand.
  assert.equal(sectionForCategory('CompetitorFunding'), SECTIONS.COMPETITION)
  assert.equal(sectionForCategory('MarketExpansion'), SECTIONS.COMPETITION)
  assert.equal(sectionForCategory('IndustryMomentum'), SECTIONS.ADJACENT)
})

await check('every emittable category has exactly one section and a theme', () => {
  const seen = new Map()
  for (const [section, cats] of Object.entries(SECTION_MAP)) {
    for (const c of cats) {
      assert.ok(!seen.has(c), `${c} is in both ${seen.get(c)} and ${section}`)
      seen.set(c, section)
    }
  }
  for (const c of SIGNAL_CATEGORIES) {
    assert.ok(seen.has(c), `${c} is emittable but has no section`)
    assert.ok(CATEGORY_THEMES[c], `${c} has no clustering theme`)
  }
})

await check('retired categories are not emitted but stored reports still group', () => {
  for (const [legacy, section] of Object.entries(LEGACY_CATEGORY_SECTIONS)) {
    assert.ok(!SIGNAL_CATEGORIES.includes(legacy), `${legacy} is retired and must not be emitted`)
    assert.equal(sectionForCategory(legacy), section)
    assert.ok(CATEGORY_THEMES[legacy], `${legacy} lost its theme — stored reports would cluster as 'general'`)
  }
  const out = groupSectionsForDisplay([
    { id: 'a', title: 'Funding Activity', category: 'FundingActivity', meta: { count: 1 }, subsections: [{ category: 'FundingActivity' }] },
    { id: 'b', title: 'Partnership Signal', category: 'PartnershipSignal', meta: { count: 1 }, subsections: [{ category: 'PartnershipSignal' }] },
  ])
  assert.deepEqual(out.map(s => s.title).sort(), [SECTIONS.FUNDING, SECTIONS.OPPORTUNITIES].sort())
})

await check('Opportunities is critical and outranks every other section', () => {
  assert.ok(CRITICAL_SECTIONS.includes(SECTIONS.OPPORTUNITIES))
  assert.ok(CRITICAL_SECTIONS.includes(SECTIONS.COMPETITION))
  const ranked = Object.values(SECTIONS).sort((a, b) => SECTION_PRIORITY[a] - SECTION_PRIORITY[b])
  assert.equal(ranked[0], SECTIONS.OPPORTUNITIES)
  assert.equal(ranked[1], SECTIONS.CUSTOMERS)
})

await check('opportunity categories are exactly the three doors', () => {
  assert.deepEqual([...OPPORTUNITY_CATEGORIES].sort(), ['DemandSignal', 'FundingOpportunity', 'PartnershipOpportunity'])
})

await check('capital climate trails the funding opportunities, legacy rounds included', () => {
  const signals = [
    { category: 'CapitalClimate', signal_headline: 'c1' },
    { category: 'FundingOpportunity', signal_headline: 'o1' },
    { category: 'FundingActivity', signal_headline: 'legacy' },
  ]
  const split = splitSectionSignals(SECTIONS.FUNDING, signals)
  assert.deepEqual(split.primary.map(s => s.signal_headline), ['o1'])
  assert.deepEqual(split.trailing.map(s => s.signal_headline), ['c1', 'legacy'])
  assert.equal(split.trailingLabel, 'Capital climate')
  assert.ok(split.emptyPrimaryNote)

  const other = splitSectionSignals(SECTIONS.COMPETITION, signals)
  assert.equal(other.primary.length, 3)
  assert.equal(other.trailing.length, 0)
  assert.equal(other.trailingLabel, null)
  assert.deepEqual(splitSectionSignals(undefined, null).primary, [])
})

await check('no source file outside the taxonomy hard-codes the retired section title', async () => {
  const { readFileSync } = await import('node:fs')
  for (const file of ['src/services/intelligenceService.js', 'src/services/queryGenerator.js']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.ok(!src.includes("'Market & Demand'"), `${file} still names 'Market & Demand'`)
    assert.ok(!src.includes('sectionGroups.Partnerships'), `${file} still reads the retired Partnerships section`)
  }
})

await check('an empty Opportunities section retries for buyers AND partners', async () => {
  const { buildGapQueries } = await import('../src/services/intelligenceService.js')
  const qs = buildGapQueries(SECTIONS.OPPORTUNITIES, {
    industry: 'maternal health', operating_geography: 'India',
    customer_segments: [{ segment: 'District hospitals' }],
  })
  assert.ok(qs.some(q => /procurement|tender/i.test(q) && q.includes('District hospitals')), 'buyer query present')
  assert.ok(qs.some(q => /partner program|marketplace|reseller/i.test(q)), 'partnership query present')
})

await check('two empty critical sections share the gap-fill budget', async () => {
  const { planGapQueries } = await import('../src/services/intelligenceService.js')
  const qs = planGapQueries([SECTIONS.OPPORTUNITIES, SECTIONS.COMPETITION], {
    industry: 'maternal health', operating_geography: 'India',
    customer_segments: [{ segment: 'District hospitals' }, { segment: 'Private clinics' }],
    key_competitors: [{ name: 'Acme Health' }, { name: 'Beta Care' }],
  })
  assert.ok(qs.length <= 3, 'overall cap holds')
  assert.ok(qs.some(q => /competitor/i.test(q)), 'a Competition query survives')
  assert.ok(qs.some(q => /procurement|tender/i.test(q)), 'a buyer query survives')
  assert.ok(qs.some(q => /partner program|marketplace|reseller/i.test(q)), 'a partner query survives')
})

await check('opportunity block: deadline and amount survive only when found verbatim', async () => {
  const { groundOpportunityFields } = await import('../src/services/opportunityFields.js')
  const batch = 'BIRAC BIG scheme: grants of up to ₹50 lakh. Applications close 31 October 2026. https://birac.nic.in/big'
  const base = { category: 'FundingOpportunity', source_url: 'https://birac.nic.in/big' }
  const opp = (o) => ({ ...base, opportunity: { counterparty: 'BIRAC', trigger: 'BIG call 24 opened', ...o } })

  const [grounded] = groundOpportunityFields([opp({
    deadline: '2026-10-31', deadline_quote: 'Applications close 31 October 2026',
    amount: 'up to ₹50 lakh', fit: ['Seed stage', 'India'], unknowns: ['Whether devices qualify'],
  })], batch, { today: '2026-09-30' })
  assert.equal(grounded.opportunity.deadline, '2026-10-31')
  assert.equal(grounded.opportunity.amount, 'up to ₹50 lakh')
  assert.equal(grounded.opportunity.status, 'open')
  assert.deepEqual(grounded.opportunity.fit, ['Seed stage', 'India'])

  const [invented] = groundOpportunityFields([opp({
    deadline: '2026-11-15', deadline_quote: 'Deadline 15 November 2026', amount: '₹1 crore',
  })], batch, { today: '2026-09-30' })
  assert.equal(invented.opportunity.deadline, null, 'a deadline not in the source is removed')
  assert.equal(invented.opportunity.deadline_quote, null)
  assert.equal(invented.opportunity.amount, null, 'an amount not in the source is removed')
  assert.equal(invented.opportunity.status, 'unknown')

  const [closed] = groundOpportunityFields([opp({
    deadline: '2026-10-31', deadline_quote: 'Applications close 31 October 2026',
  })], batch, { today: '2026-11-02' })
  assert.equal(closed.opportunity.status, 'closed', 'kept, and honestly labelled closed')

  const [badDate] = groundOpportunityFields([opp({
    deadline: '31/10/2026', deadline_quote: 'Applications close 31 October 2026',
  })], batch, { today: '2026-09-30' })
  assert.equal(badDate.opportunity.deadline, null, 'a non-ISO deadline is not a date')
})

await check('opportunity block: stripped from non-opportunity categories and from doorless ones', async () => {
  const { groundOpportunityFields } = await import('../src/services/opportunityFields.js')
  const out = groundOpportunityFields([
    { category: 'CompetitorFunding', opportunity: { counterparty: 'X', trigger: 'raised' } },
    { category: 'DemandSignal', opportunity: { trigger: 'RFP issued' } },
    { category: 'PartnershipOpportunity' },
  ], 'text', { today: '2026-09-30' })
  assert.ok(!('opportunity' in out[0]), 'competitor funding is not a door')
  assert.ok(!('opportunity' in out[1]), 'no counterparty, no door')
  assert.ok(!('opportunity' in out[2]))
  assert.deepEqual(groundOpportunityFields(null, 'x'), [])
})

await check('opportunity deadline must state the exact date in the quote', async () => {
  const { groundOpportunityFields } = await import('../src/services/opportunityFields.js')
  const batch = 'Applications opened 1 September 2026'
  const base = { category: 'FundingOpportunity', source_url: 'https://example.com' }
  const opp = (o) => ({ ...base, opportunity: { counterparty: 'X', trigger: 'opened', ...o } })

  const [mismatched] = groundOpportunityFields([opp({
    deadline: '2027-01-01', deadline_quote: 'Applications opened 1 September 2026',
  })], batch, { today: '2026-09-30' })
  assert.equal(mismatched.opportunity.deadline, null, 'quote does not state that date')
  assert.equal(mismatched.opportunity.deadline_quote, null)
  assert.equal(mismatched.opportunity.status, 'unknown')
})

await check('impossible calendar dates are rejected', async () => {
  const { groundOpportunityFields } = await import('../src/services/opportunityFields.js')
  const batch = 'Deadline: February 31, 2026'
  const base = { category: 'FundingOpportunity', source_url: 'https://example.com' }
  const opp = (o) => ({ ...base, opportunity: { counterparty: 'X', trigger: 'opened', ...o } })

  const [impossible] = groundOpportunityFields([opp({
    deadline: '2026-02-31', deadline_quote: 'Deadline: February 31, 2026',
  })], batch, { today: '2026-09-30' })
  assert.equal(impossible.opportunity.deadline, null, 'impossible date rejected')
})

await check('deadline quote formats: ISO, full/short month names, ordinals, numeric day-first', async () => {
  const { groundOpportunityFields } = await import('../src/services/opportunityFields.js')
  const base = { category: 'FundingOpportunity', source_url: 'https://example.com' }
  const opp = (o) => ({ ...base, opportunity: { counterparty: 'X', trigger: 'opened', ...o } })

  // Full month name
  const [fullMonth] = groundOpportunityFields([opp({
    deadline: '2026-10-31', deadline_quote: 'Deadline: October 31, 2026',
  })], 'Deadline: October 31, 2026', { today: '2026-09-30' })
  assert.equal(fullMonth.opportunity.deadline, '2026-10-31')

  // Short month abbreviation with ordinal
  const [shortMonth] = groundOpportunityFields([opp({
    deadline: '2026-10-31', deadline_quote: 'closes 31st Oct 2026',
  })], 'closes 31st Oct 2026', { today: '2026-09-30' })
  assert.equal(shortMonth.opportunity.deadline, '2026-10-31')

  // Day-first numeric format
  const [numeric] = groundOpportunityFields([opp({
    deadline: '2026-10-31', deadline_quote: 'by 31/10/2026',
  })], 'by 31/10/2026', { today: '2026-09-30' })
  assert.equal(numeric.opportunity.deadline, '2026-10-31')

  // Wrong date in same month should not ground
  const [wrongDate] = groundOpportunityFields([opp({
    deadline: '2026-10-31', deadline_quote: '1 October 2026',
  })], '1 October 2026', { today: '2026-09-30' })
  assert.equal(wrongDate.opportunity.deadline, null, '1 October does not match 31')
})

await check('deadline equal to today is open, not closed', async () => {
  const { groundOpportunityFields } = await import('../src/services/opportunityFields.js')
  const batch = 'Due 2026-09-30'
  const base = { category: 'FundingOpportunity', source_url: 'https://example.com' }
  const opp = (o) => ({ ...base, opportunity: { counterparty: 'X', trigger: 'opened', ...o } })

  const [today] = groundOpportunityFields([opp({
    deadline: '2026-09-30', deadline_quote: 'Due 2026-09-30',
  })], batch, { today: '2026-09-30' })
  assert.equal(today.opportunity.status, 'open')
})

await check('model-supplied status is ignored; computed from deadline only', async () => {
  const { groundOpportunityFields } = await import('../src/services/opportunityFields.js')
  const batch = 'Applications close 31 October 2026'
  const base = { category: 'FundingOpportunity', source_url: 'https://example.com' }
  const opp = (o) => ({ ...base, opportunity: { counterparty: 'X', trigger: 'opened', ...o } })

  const [ignored] = groundOpportunityFields([opp({
    deadline: '2026-10-31', deadline_quote: 'Applications close 31 October 2026',
    status: 'closed',  // model says closed, but deadline is in future
  })], batch, { today: '2026-09-30' })
  assert.equal(ignored.opportunity.status, 'open', 'computed status overrides model')
})

await check('non-string counterparty is treated as absent', async () => {
  const { groundOpportunityFields } = await import('../src/services/opportunityFields.js')
  const out = groundOpportunityFields([
    { category: 'FundingOpportunity', opportunity: { counterparty: { name: 'X' }, trigger: 'opened' } },
  ], 'text', { today: '2026-09-30' })
  assert.ok(!('opportunity' in out[0]), 'object counterparty strips the block')
})

await check('amount must contain digit and not be preceded by digit or separator in batch', async () => {
  const { groundOpportunityFields } = await import('../src/services/opportunityFields.js')
  const base = { category: 'FundingOpportunity', source_url: 'https://example.com' }
  const opp = (o) => ({ ...base, opportunity: { counterparty: 'X', trigger: 'opened', ...o } })

  // Amount grounded when not preceded by digit
  const [standalone] = groundOpportunityFields([opp({
    amount: '50 lakh',
  })], 'grants of 50 lakh', { today: '2026-09-30' })
  assert.equal(standalone.opportunity.amount, '50 lakh')

  // Amount NOT grounded when preceded by digit
  const [preceded] = groundOpportunityFields([opp({
    amount: '50 lakh',
  })], 'up to ₹150 lakh', { today: '2026-09-30' })
  assert.equal(preceded.opportunity.amount, null, 'amount preceded by digit is not grounded')
})

await check('the opportunity block survives the full signal filter chain', async () => {
  const { applySignalFilters } = await import('../src/services/intelligenceService.js')
  const batch = 'Stripe opened its Partner Ecosystem to Indian ISVs. Source: https://stripe.com/partners/india'
  const [kept] = applySignalFilters([{
    category: 'PartnershipOpportunity', signal_headline: 'Stripe opens partner programme to Indian ISVs',
    entity_involved: 'Stripe', source_url: 'https://stripe.com/partners/india',
    so_what_for_you: 'Your billing integration is now eligible for a listed co-sell route.',
    opportunity: { counterparty: 'Stripe', trigger: 'Partner Ecosystem opened to Indian ISVs', fit: ['Integrates with Stripe'] },
  }], batch, 'Bahirjee')
  assert.ok(kept, 'signal survived')
  assert.equal(kept.opportunity.counterparty, 'Stripe')
  assert.equal(kept.opportunity.status, 'unknown')
  assert.deepEqual(kept.opportunity.fit, ['Integrates with Stripe'])
})

await check('groundOpportunityFields tolerates null and primitive entries without throwing', async () => {
  const { groundOpportunityFields } = await import('../src/services/opportunityFields.js')
  const out = groundOpportunityFields([null, 'abc', { category: 'DemandSignal' }], 'x')
  assert.equal(out.length, 3)
  assert.equal(out[0], null)
  assert.equal(out[1], 'abc')
  assert.deepEqual(out[2], { category: 'DemandSignal' })
})

await check('amount must stand alone: not preceded by digit/separator, not followed by digit', async () => {
  const { groundOpportunityFields } = await import('../src/services/opportunityFields.js')
  const base = { category: 'FundingOpportunity', source_url: 'https://example.com' }
  const opp = (o) => ({ ...base, opportunity: { counterparty: 'X', trigger: 'opened', ...o } })

  // $ not grounded when preceded by digit
  const [dollarPreceded] = groundOpportunityFields([opp({
    amount: '$5',
  })], 'grant of $50 million', { today: '2026-09-30' })
  assert.equal(dollarPreceded.opportunity.amount, null, 'preceded by digit')

  // Thousands separator: 50,000 not grounded inside 1,50,000
  const [thousandsPreceded] = groundOpportunityFields([opp({
    amount: '50,000',
  })], 'fund of 1,50,000 total', { today: '2026-09-30' })
  assert.equal(thousandsPreceded.opportunity.amount, null, 'preceded by comma')

  // Amount at the very start grounded
  const [atStart] = groundOpportunityFields([opp({
    amount: '₹50 lakh',
  })], '₹50 lakh is available', { today: '2026-09-30' })
  assert.equal(atStart.opportunity.amount, '₹50 lakh', 'at start is grounded')

  // Amount with context grounded
  const [withContext] = groundOpportunityFields([opp({
    amount: 'up to $250,000',
  })], 'grants of up to $250,000 available', { today: '2026-09-30' })
  assert.equal(withContext.opportunity.amount, 'up to $250,000')
})

await check('deadline quote forms: optional leading zero on day, optional period after month abbr, sept', async () => {
  const { groundOpportunityFields } = await import('../src/services/opportunityFields.js')
  const base = { category: 'FundingOpportunity', source_url: 'https://example.com' }
  const opp = (o) => ({ ...base, opportunity: { counterparty: 'X', trigger: 'opened', ...o } })

  // Leading zero on day
  const [leadingZero] = groundOpportunityFields([opp({
    deadline: '2026-11-01', deadline_quote: 'Due 01 Nov 2026',
  })], 'Due 01 Nov 2026', { today: '2026-09-30' })
  assert.equal(leadingZero.opportunity.deadline, '2026-11-01')

  // Period after month abbreviation
  const [periodAbbr] = groundOpportunityFields([opp({
    deadline: '2026-10-31', deadline_quote: 'Oct. 31, 2026',
  })], 'Oct. 31, 2026', { today: '2026-09-30' })
  assert.equal(periodAbbr.opportunity.deadline, '2026-10-31')

  // Sept as September abbreviation
  const [sept] = groundOpportunityFields([opp({
    deadline: '2026-09-15', deadline_quote: '15 Sept 2026',
  })], '15 Sept 2026', { today: '2026-09-30' })
  assert.equal(sept.opportunity.deadline, '2026-09-15')
})

await check('round-trip date validation: quote states ISO string but date is impossible', async () => {
  const { groundOpportunityFields } = await import('../src/services/opportunityFields.js')
  const batch = 'closes 2026-02-31'
  const base = { category: 'FundingOpportunity', source_url: 'https://example.com' }
  const opp = (o) => ({ ...base, opportunity: { counterparty: 'X', trigger: 'opened', ...o } })

  const [impossible] = groundOpportunityFields([opp({
    deadline: '2026-02-31', deadline_quote: 'closes 2026-02-31',
  })], batch, { today: '2026-09-30' })
  assert.equal(impossible.opportunity.deadline, null, 'round-trip rejects impossible date')
})

await check('quoteStatesDate is exported and works correctly', async () => {
  const { quoteStatesDate } = await import('../src/services/opportunityFields.js')
  assert.equal(quoteStatesDate('Applications close 31 October 2026', '2026-10-31'), true)
  assert.equal(quoteStatesDate('Applications close 1 October 2026', '2026-10-31'), false)
})

await check('quoteStatesDate: every month word grounds only its own full date', async () => {
  const { quoteStatesDate } = await import('../src/services/opportunityFields.js')
  const full = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  full.forEach((name, i) => {
    const mm = String(i + 1).padStart(2, '0')
    const iso = `2026-${mm}-15`
    const abbrev = name.slice(0, 3)
    for (const quote of [
      `closes 30 ${name} 2026`,
      `${name} 2026`,
      `15 ${name}`,
      `the ${name.toLowerCase()} intake`,
      `15 ${name} 2025`,
    ]) {
      assert.equal(quoteStatesDate(quote, iso), false, `${quote} must not state ${iso}`)
    }
    assert.equal(quoteStatesDate(`15 ${name} 2026`, iso), true, `15 ${name} 2026`)
    assert.equal(quoteStatesDate(`${abbrev}. 15, 2026`, iso), true, `${abbrev}. 15, 2026`)
  })
  assert.equal(quoteStatesDate('Sept 15 2026', '2026-09-15'), true)
  assert.equal(quoteStatesDate('15 Sept 2026', '2026-09-15'), true)
  for (const q of ['closes 30 Sept 2026', 'September 30 2026', 'Sept 2026', '15 sep', 'the september intake', '15 Sept']) {
    assert.equal(quoteStatesDate(q, '2026-09-15'), false, q)
  }
})

await check('quoteStatesDate: day numbers are matched on boundaries', async () => {
  const { quoteStatesDate } = await import('../src/services/opportunityFields.js')
  for (const q of ['11 Nov 2026', '21 Nov 2026', '10 Nov 2026']) {
    assert.equal(quoteStatesDate(q, '2026-11-01'), false, q)
  }
  assert.equal(quoteStatesDate('01 Nov 2026', '2026-11-01'), true)
  assert.equal(quoteStatesDate('1 Nov 2026', '2026-11-01'), true)
})

await check('amount trailing boundary: a decimal or thousands continuation is not the same figure', async () => {
  const { groundOpportunityFields } = await import('../src/services/opportunityFields.js')
  const base = { category: 'FundingOpportunity', source_url: 'https://example.com' }
  const opp = (o) => ({ ...base, opportunity: { counterparty: 'X', trigger: 'opened', ...o } })
  const [decimal] = groundOpportunityFields([opp({ amount: '$5' })], 'up to $5.5m', { today: '2026-09-30' })
  assert.equal(decimal.opportunity.amount, null, '$5 inside $5.5m')
  const [thousands] = groundOpportunityFields([opp({ amount: '$5' })], 'a $5,000 grant', { today: '2026-09-30' })
  assert.equal(thousands.opportunity.amount, null, '$5 inside $5,000')
  const [sentence] = groundOpportunityFields([opp({ amount: '$50' })], 'Awards of $50. Applications open', { today: '2026-09-30' })
  assert.equal(sentence.opportunity.amount, '$50', 'sentence-ending period is fine')
  const [atEnd] = groundOpportunityFields([opp({ amount: '$50' })], 'Awards of $50.', { today: '2026-09-30' })
  assert.equal(atEnd.opportunity.amount, '$50', 'period at end of text is fine')
})

await check('Gemini signal schema can represent the opportunity block', async () => {
  const { buildSignalResponseSchema } = await import('../lib/handlers/gemini.js')
  const schema = buildSignalResponseSchema(false)
  const opp = schema.items.properties.opportunity
  assert.ok(opp, 'constrained decoding cannot emit a property the schema omits')
  for (const key of ['counterparty', 'trigger', 'deadline', 'deadline_quote', 'amount', 'fit', 'unknowns']) {
    assert.ok(opp.properties[key], `opportunity.${key} missing from the schema`)
  }
  assert.ok(!('status' in opp.properties), 'status is computed, never asked of the model')
  assert.ok(!schema.items.required.includes('opportunity'), 'optional: most signals are not doors')
  assert.ok(buildSignalResponseSchema(true).items.required.includes('evidence_quote'))
  assert.ok(!schema.items.required.includes('evidence_quote'))
})

await check('signal prompt defines every new category and asks for the opportunity block', async () => {
  const { PROMPTS } = await import('../src/services/promptUtils.js')
  const { buildTemporalPolicy } = await import('../src/services/temporalPolicy.js')
  const prompt = PROMPTS.buildSignals({
    company_name: 'Acme', operating_geography: 'India',
    company_dna: { funding_stage: 'seed' },
    dependency_map: { infra_dependencies: ['AWS'], platform_dependencies: ['Stripe'], major_integrations: [{ name: 'Salesforce' }] },
  }, 'raw', buildTemporalPolicy(new Date('2026-09-30')), [], false)

  for (const c of ['PartnershipOpportunity', 'FundingOpportunity', 'CapitalClimate', 'SupplierShift', 'CustomerShift']) {
    const mentions = prompt.split(c).length - 1
    assert.ok(mentions >= 2, `${c} is listed but never defined (${mentions} mention)`)
  }
  for (const retired of ['FundingActivity', 'PartnershipSignal']) {
    assert.ok(!prompt.includes(retired), `retired category ${retired} still in the prompt`)
  }
  assert.ok(prompt.includes('"opportunity"'), 'output format asks for the opportunity block')
  assert.ok(prompt.includes('deadline_quote'))
  assert.ok(/Known Dependencies: AWS, Stripe, Salesforce/.test(prompt), 'vendors are named so SupplierShift can be recognised')
})

await check('advice guard catches opportunity-shaped instructions and spares third-person facts', async () => {
  const { detectAdviceLeakage } = await import('../src/services/briefSchema.js')
  for (const text of ['This call is worth applying to.', 'You could reach out to their partner team.', 'Pursue this opportunity before March.',
    'You could apply to this grant before it closes.', 'Apply to this programme.']) {
    assert.ok(detectAdviceLeakage(text).length > 0, `not caught: ${text}`)
  }
  for (const text of [
    'Applications close 31 October 2026.',
    'The DPDP consent rules apply before the 2027 audit cycle.',
    'Those limits apply now to every lender.',
    'Rival said it will reach out to 800 clinics.',
    'Rival would pursue this segment aggressively.',
    'The DPDP rules apply to this sector from April 2027.',
    'The same caps apply to this segment of lenders.',
  ]) {
    assert.equal(detectAdviceLeakage(text).length, 0, `false positive on a fact: ${text}`)
  }
})

await check('the no-advice ban is scoped to Bahirjee\'s words; quoted fields stay verbatim', async () => {
  const { PROMPTS } = await import('../src/services/promptUtils.js')
  const { buildTemporalPolicy } = await import('../src/services/temporalPolicy.js')
  const prompt = PROMPTS.buildSignals({ company_name: 'Acme', dependency_map: { infra_dependencies: 'not-an-array' } },
    'raw', buildTemporalPolicy(new Date('2026-09-30')), [], false)
  assert.ok(prompt.includes('copied exactly as the source wrote them'), 'quoted fields are exempt from the verb ban')
  assert.ok(/every other field you write in your own words/.test(prompt))
  assert.ok(prompt.includes('EXISTING CUSTOMER') && prompt.includes('CustomerShift**'), 'CustomerShift bullet markers moved; update this test')
  const customerShiftBullet = prompt.split('EXISTING CUSTOMER')[1].split('CustomerShift**')[0]
  assert.ok(customerShiftBullet.length > 100, 'CustomerShift bullet slice is unexpectedly short')
  assert.ok(!/switching vendors/.test(customerShiftBullet), 'vendor-switching is not CustomerShift')
  assert.ok(prompt.includes('Known Dependencies: None named'), 'non-array dependency fields do not crash or leak')
})

await check('month 00 or 13+ never throws: the deadline is dropped and the filter chain survives', async () => {
  const { groundOpportunityFields } = await import('../src/services/opportunityFields.js')
  const { applySignalFilters } = await import('../src/services/intelligenceService.js')
  const base = { category: 'FundingOpportunity', source_url: 'https://example.com/call' }
  const opp = (o) => ({ ...base, opportunity: { counterparty: 'X', trigger: 'opened', ...o } })
  const cases = [
    ['2026-13-01', 'Proposals due 01/13/2026'],
    ['2026-00-10', 'Proposals due 2026-00-10'],
    ['2026-13-01', 'Proposals due 2026-13-01'],
    ['2026-10-00', 'Proposals due 2026-10-00'],
  ]
  for (const [deadline, quote] of cases) {
    let out
    assert.doesNotThrow(() => { out = groundOpportunityFields([opp({ deadline, deadline_quote: quote })], quote, { today: '2026-09-30' }) }, `${deadline} threw`)
    assert.equal(out[0].opportunity.deadline, null, `${deadline} must not ground`)
  }
  const batch = 'Call open. Proposals due 01/13/2026. Source: https://example.com/call'
  let kept
  assert.doesNotThrow(() => {
    kept = applySignalFilters([{
      ...opp({ deadline: '2026-13-01', deadline_quote: 'Proposals due 01/13/2026' }),
      signal_headline: 'Call opened', entity_involved: 'X',
      so_what_for_you: 'Your product is eligible under the stated scope.',
    }], batch, 'Bahirjee')
  }, 'applySignalFilters must survive a bad month')
  assert.equal(kept.length, 1, 'the batch is kept, only the deadline is dropped')
  assert.equal(kept[0].opportunity.deadline, null)
})

await check('ambiguous numeric dates do not ground; unambiguous ones and month names do', async () => {
  const { quoteStatesDate } = await import('../src/services/opportunityFields.js')
  assert.equal(quoteStatesDate('Applications due 02/01/2027', '2027-01-02'), false, 'day-first reading of an ambiguous date')
  assert.equal(quoteStatesDate('Applications due 02/01/2027', '2027-02-01'), false, 'month-first reading of an ambiguous date')
  assert.equal(quoteStatesDate('Applications due 31/10/2026', '2026-10-31'), true)
  assert.equal(quoteStatesDate('Applications due 10/31/2026', '2026-10-31'), true)
  assert.equal(quoteStatesDate('Applications due 05/05/2026', '2026-05-05'), true, 'day === month is unambiguous')
  assert.equal(quoteStatesDate('Applications due 2 January 2027', '2027-01-02'), true)
  assert.equal(quoteStatesDate('Applications due 2027-01-02', '2027-01-02'), true)
})

await check('opportunityStatusOn is computed from the deadline and the clock, never stored status', async () => {
  const { opportunityStatusOn } = await import('../src/services/opportunityFields.js')
  assert.equal(opportunityStatusOn({ deadline: '2026-10-01', status: 'closed' }, '2026-09-30'), 'open')
  assert.equal(opportunityStatusOn({ deadline: '2026-09-30', status: 'closed' }, '2026-09-30'), 'open', 'due today is still open')
  assert.equal(opportunityStatusOn({ deadline: '2026-09-29', status: 'open' }, '2026-09-30'), 'closed', 'a stored report opened after the deadline')
  assert.equal(opportunityStatusOn({ deadline: null, status: 'open' }, '2026-09-30'), 'unknown')
  assert.equal(opportunityStatusOn({}, '2026-09-30'), 'unknown')
  assert.equal(opportunityStatusOn(null, '2026-09-30'), 'unknown')
  assert.equal(opportunityStatusOn({ deadline: '2026-13-01' }, '2026-09-30'), 'unknown', 'a malformed stored deadline does not throw or claim a status')
  assert.equal(opportunityStatusOn({ deadline: 'soon' }, '2026-09-30'), 'unknown')
  assert.ok(['open', 'closed'].includes(opportunityStatusOn({ deadline: '2999-01-01' })), 'default today works')
})

await check('dedupe keeps the door: a merged pair carries the grounded deadline of whichever had one', async () => {
  const { deduplicateSignals } = await import('../src/services/intelligenceService.js')
  const door = { counterparty: 'BIRAC', trigger: 'BIG call opened', deadline: '2026-10-31', deadline_quote: 'close 31 October 2026', amount: null, fit: [], unknowns: [], status: 'open' }
  const mk = (over) => ({
    category: 'FundingOpportunity', entity_involved: 'BIRAC', signal_headline: 'BIRAC opens BIG grant call for medtech startups',
    source_url: 'https://a.example/x', relevance_score: 5, ...over,
  })
  // Winner (higher relevance) has no deadline; the duplicate does.
  let [one] = deduplicateSignals([
    mk({ relevance_score: 8, source_url: 'https://a.example/1', opportunity: { ...door, deadline: null, deadline_quote: null, status: 'unknown' } }),
    mk({ relevance_score: 4, source_url: 'https://b.example/2', opportunity: door }),
  ])
  assert.equal(one.opportunity.deadline, '2026-10-31', 'the grounded deadline survives the merge')
  assert.equal(one.relevance_score, 8, 'the winner still wins the card')
  // Winner has no opportunity block at all.
  ;[one] = deduplicateSignals([
    mk({ relevance_score: 8, source_url: 'https://a.example/1' }),
    mk({ relevance_score: 4, source_url: 'https://b.example/2', opportunity: door }),
  ])
  assert.equal(one.opportunity?.deadline, '2026-10-31')
  // Loser is the FIRST one kept.
  ;[one] = deduplicateSignals([
    mk({ relevance_score: 4, source_url: 'https://b.example/2', opportunity: door }),
    mk({ relevance_score: 8, source_url: 'https://a.example/1' }),
  ])
  assert.equal(one.opportunity?.deadline, '2026-10-31')
  // A winner that already has a deadline keeps its own.
  ;[one] = deduplicateSignals([
    mk({ relevance_score: 8, opportunity: { ...door, deadline: '2026-12-01' } }),
    mk({ relevance_score: 4, source_url: 'https://b.example/2', opportunity: door }),
  ])
  assert.equal(one.opportunity.deadline, '2026-12-01')
  // A different category is a different kind of thing: nothing is carried across.
  ;[one] = deduplicateSignals([
    mk({ relevance_score: 8, category: 'CompetitorFunding' }),
    mk({ relevance_score: 4, source_url: 'https://b.example/2', opportunity: door }),
  ])
  assert.ok(!one.opportunity, 'no door is grafted onto a different category')
})

await check('a cost bet with only supplier evidence is not reported untested', async () => {
  const { detectUntestedBets } = await import('../src/services/blindSpotEngine.js')
  const ctx = { _startupContext: { strategic_assumptions: [{ statement: 'Component costs stay flat', domain: 'Cost', sensitivity: 'High' }] } }
  assert.equal(detectUntestedBets(ctx, [{ theme: 'supplier_dynamics' }]).length, 0)
  assert.equal(detectUntestedBets(ctx, [{ title: 'Vendor price change' }]).length, 0)
  assert.equal(detectUntestedBets(ctx, [{ theme: 'competitor_activity' }]).length, 1, 'unrelated evidence still leaves it untested')
})

await check('the no-funding-call note appears only when this run looked for capital climate', () => {
  const legacy = splitSectionSignals(SECTIONS.FUNDING, [{ category: 'FundingActivity', signal_headline: 'old round' }])
  assert.equal(legacy.emptyPrimaryNote, null, 'a legacy report never searched for open calls')
  assert.equal(legacy.trailing.length, 1)
  const empty = splitSectionSignals(SECTIONS.FUNDING, [])
  assert.equal(empty.emptyPrimaryNote, null)
  const current = splitSectionSignals(SECTIONS.FUNDING, [{ category: 'CapitalClimate', signal_headline: 'c' }])
  assert.ok(current.emptyPrimaryNote, 'a new-era run with only capital climate says no call surfaced')
})

await check('the schema pins the opportunity field TYPES, not just their presence', async () => {
  const { buildSignalResponseSchema } = await import('../lib/handlers/gemini.js')
  const opp = buildSignalResponseSchema(false).items.properties.opportunity
  for (const key of ['fit', 'unknowns']) {
    assert.deepEqual(opp.properties[key], { type: 'ARRAY', items: { type: 'STRING' } }, `${key} must be an array of strings`)
  }
  for (const key of ['counterparty', 'trigger', 'deadline', 'deadline_quote', 'amount']) {
    assert.equal(opp.properties[key].type, 'STRING', `${key} must be a string`)
  }
})

console.log(`\n${passed} passed${process.exitCode ? ' — FAILURES above' : ''}\n`)
