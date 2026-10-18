/**
 * Context assembly tests.
 *
 * Three defects, all measured on one live run (Edgistify, 2026-09-02):
 *
 *   1. packSources treated a reservation as a CEILING as well as a floor. That run had a
 *      150,000-char limit and 121,402 chars of input — it fit with 28,598 to spare — and
 *      still discarded 36,111 chars of LinkedIn, because LinkedIn's 20,000 reservation
 *      capped it. Nothing was traded for that; it was simply lost.
 *
 *   2. The company's own website was never read. The direct extract only ran when Tavily
 *      returned under 3,000 chars; it returned 68,341. So the context was built entirely
 *      from third-party pages ABOUT the company — and then labelled "COMPANY WEBSITE
 *      (8 pages)", where 8 was the Tavily result count.
 *
 *   3. A scrape was accepted on `length > 200` alone. A LinkedIn auth wall is tens of
 *      thousands of characters of navigation and locale links; it passes a length check
 *      comfortably and then takes a RESERVED seat ahead of first-party content.
 *
 * Run: npm run test:context-assembly
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { packSources, applyContextPatch, summarizeContextForMerge } from '../src/services/intelligenceService.js'

const SERVICE = fileURLToPath(new URL('../src/services/intelligenceService.js', import.meta.url))
const source = readFileSync(SERVICE, 'utf8')

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

// ─── 1. a reservation is a floor, not a ceiling ─────────────────────────────

check('unused headroom goes back to a source that wanted more', () => {
  // The exact shape of the live run: limit is nowhere near binding.
  const packed = packSources([
    { label: 'WEB', text: 'w'.repeat(68341), budget: Infinity },
    { label: 'LI', text: 'l'.repeat(53061), budget: 20000 },
  ], 150000)

  const liKept = (packed.text.match(/l/g) || []).length
  const webKept = (packed.text.match(/w/g) || []).length

  assert.equal(webKept, 68341, 'the unbounded source keeps everything it has')
  assert.equal(
    liKept, 53061,
    `LinkedIn had 53061 chars and 28598 chars of headroom were free, but only ${liKept} survived — ` +
    'a reservation must guarantee a minimum, not impose a maximum'
  )
  assert.equal(packed.totalChars, 121402)
})

check('the reservation still holds when the limit IS binding', () => {
  // The property the reservation exists for: a long unbounded source must not be able to
  // evict a reserved one. This is what the headroom reclaim must not break.
  const packed = packSources([
    { label: 'DOC', text: 'd'.repeat(9000), budget: 8000 },
    { label: 'WEB', text: 'w'.repeat(500000), budget: Infinity },
  ], 50000)

  const docKept = (packed.text.match(/d/g) || []).length
  assert.ok(docKept >= 7000, `the reserved source kept only ${docKept} of its 8000-char floor`)
  assert.ok(packed.text.length <= 50000 + 200, 'and the limit is still respected')
})

check('a source that needs less than it reserved donates the surplus', () => {
  // The original behaviour, which must survive.
  const packed = packSources([
    { label: 'LI', text: 'l'.repeat(100), budget: 20000 },
    { label: 'WEB', text: 'w'.repeat(90000), budget: Infinity },
  ], 50000)
  assert.equal((packed.text.match(/l/g) || []).length, 100)
  assert.ok((packed.text.match(/w/g) || []).length > 45000, 'the surplus reached the unbounded source')
})

// ─── 2. provenance labels say what the content actually is ──────────────────

check('third-party search results are never labelled as the company website', () => {
  assert.ok(
    !/COMPANY WEBSITE \(\$\{(?:pageCount|resultCount)\} pages\)/.test(source),
    'search results must not be presented to the model under a first-party header'
  )
  assert.match(source, /WEB RESEARCH \(\$\{resultCount\} third-party sources\)/,
    'third-party sources must be labelled as third-party')
  assert.match(source, /COMPANY WEBSITE \(First-party/,
    'and the company\'s own site labelled as first-party')
})

check('the founder\'s own URL is read unconditionally', () => {
  // The regression to prevent: re-gating the direct read behind a size check on the
  // Tavily result, which in practice means never reading it.
  const fn = source.slice(source.indexOf('async function getDeepContextData'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.ok(
    !/if\s*\(\s*tavilyText\.length\s*<\s*\d+\s*\)/.test(body),
    'the direct page read must not be conditional on how much Tavily returned'
  )
  assert.match(body, /fetchPageExtract\(normalizedUrl\)/, 'and must still happen')
  assert.match(body, /ownSiteText:/, 'returned separately so the caller can label it honestly')
})

// ─── 3. volume is not signal ────────────────────────────────────────────────

check('a login wall is rejected however long it is', () => {
  assert.match(source, /function looksLikeAuthWall/, 'the guard must exist')
  // Every accept path must consult it, or a wall still reaches the context window.
  const accepts = [...source.matchAll(/\.length > 200/g)]
  assert.ok(accepts.length > 0, 'the length checks are still there to be strengthened')
  for (const m of accepts) {
    const window = source.slice(m.index, m.index + 200)
    assert.match(
      window, /looksLikeAuthWall/,
      'a length check with no content check accepts tens of thousands of chars of ' +
      'navigation boilerplate and gives it a reserved seat in the context'
    )
  }
})


// ─── merging new sources into a context that already exists ─────────────────
//
// The merge path is where defect (1) above would recur most expensively. The stored
// context's digest and the new sources share one budget; if the digest were allowed to
// carry _sourceDocuments (30,000 chars of prior website text by construction), it would
// evict the very sources the founder just added — and the merge would report, entirely
// sincerely, that the new pages said nothing.

check('the merge digest never carries _sourceDocuments', () => {
  const digest = summarizeContextForMerge({
    company_name: 'Acme',
    _sourceDocuments: { website: 'W'.repeat(30000), linkedin: 'L'.repeat(10000) },
  })
  assert.ok(!digest.includes('WWWW'), 'the stored website text must not reach the merge prompt')
  assert.ok(!digest.includes('LLLL'), 'the stored LinkedIn text must not reach the merge prompt')
  assert.ok(
    digest.length < 4000,
    `the digest is ${digest.length} chars — it must stay small enough that the new sources ` +
    `own the budget, or a merge silently becomes a re-read of what we already had`
  )
  assert.match(digest, /Acme/, 'the digest must still say who the company is')
})

check('the merge reads only what was added', () => {
  const body = source.slice(source.indexOf('export async function enrichStoredContext'))
  const fn = body.slice(0, body.indexOf('\n}\n'))
  assert.ok(
    !/getDeepContextData|fetchLinkedInContext|\/search/.test(fn),
    'enrichStoredContext must not run Tavily or re-fetch LinkedIn — skipping them IS the ' +
    'difference in cost between "add sources" and "rebuild from scratch"'
  )
  assert.match(fn, /fetchPageExtract/, 'it must read the supplied pages')
  assert.match(fn, /MAX_ADDED_SOURCE_URLS/, 'the number of pages read in one round must be capped')
})

check('a correction outranks a model update', () => {
  const { context, receipt } = applyContextPatch(
    { industry: 'Logistics', company_dna: { funding_stage: 'Seed' } },
    {
      updates: [
        { field: 'industry', new_value: 'Retail', evidence_quote: 'a page said retail', confidence: 90 },
        { field: 'company_dna.funding_stage', new_value: 'Series B', evidence_quote: 'raised $40M' },
      ],
    },
    { fields: ['industry'], removed: [] }
  )
  assert.equal(context.industry, 'Logistics', 'a field the founder corrected must not be overwritten')
  assert.equal(context.company_dna.funding_stage, 'Series B', 'an untouched field must still update')
  assert.deepEqual(receipt.rejected.updates.map(r => r.field), ['industry'])
  assert.match(receipt.rejected.updates[0].reason, /corrected/, 'the receipt must say WHY it was skipped')
})

check('a deleted entity is never re-added by a merge', () => {
  const { context, receipt } = applyContextPatch(
    { key_competitors: [{ name: 'Shiprocket' }] },
    { additions: { key_competitors: [{ name: 'Delhivery' }, { name: 'Ecom Express' }] } },
    { fields: [], removed: ['Delhivery'] }
  )
  const names = context.key_competitors.map(c => c.name)
  assert.deepEqual(names, ['Shiprocket', 'Ecom Express'])
  assert.deepEqual(receipt.rejected.additions.map(r => r.name), ['Delhivery'])
})

check('an update with no evidence quote is dropped', () => {
  // Same bar documentIntelService holds for uploaded documents: quote or drop. An
  // unsupported claim here would propagate into every downstream step as established fact.
  const { context, receipt } = applyContextPatch(
    { industry: 'Logistics' },
    { updates: [{ field: 'industry', new_value: 'Retail', confidence: 95 }] },
    {}
  )
  assert.equal(context.industry, 'Logistics')
  assert.match(receipt.rejected.updates[0].reason, /evidence/)
})

check('applyContextPatch does not mutate its inputs', () => {
  const original = { industry: 'Logistics', key_competitors: [{ name: 'A' }] }
  const snapshot = JSON.stringify(original)
  applyContextPatch(
    original,
    { updates: [{ field: 'industry', new_value: 'Retail', evidence_quote: 'q' }],
      additions: { key_competitors: [{ name: 'B' }] } },
    {}
  )
  assert.equal(JSON.stringify(original), snapshot, 'the caller holds this object as React state')
})

check('additions dedupe against what is already there', () => {
  const { context } = applyContextPatch(
    { key_competitors: [{ name: 'Shiprocket' }] },
    { additions: { key_competitors: [{ name: 'shiprocket' }, { name: 'Delhivery' }] } },
    {}
  )
  assert.deepEqual(
    context.key_competitors.map(c => c.name), ['Shiprocket', 'Delhivery'],
    'name matching must be case-insensitive, as it is everywhere else in the watchlist path'
  )
})

// ─── per-fact provenance (v27 follow-up) ─────────────────────────────────────
//
// applyContextPatch is the one place a stored context's facts change after the founder has
// already reviewed it once — every accepted update/addition needs a record of when it was
// (re)confirmed and from where, or describeContextStaleness has nothing but the whole
// context's age to report, which is the exact quiet-degradation failure it exists to fix.

check('applyContextPatch never reads a date from the patch itself', () => {
  const body = source.slice(
    source.indexOf('export function applyContextPatch'),
    source.indexOf('export function applyContextPatch') + source.slice(source.indexOf('export function applyContextPatch')).indexOf('\n}\n')
  )
  assert.ok(
    !/\bu\.as_of\b|\bitem\.as_of\b|\bp\.as_of\b|patch\.as_of/.test(body),
    'as_of must come from this function\'s own clock (new Date()), never a field the model ' +
    'or a client supplied on the patch — the same rule promptUtils.js states for signal ' +
    'dates, applied to context facts instead'
  )
  assert.match(body, /new Date\(\)\.toISOString\(\)/, 'the ledger must be stamped with the server\'s own clock')
})

check('an accepted update stamps _factProvenance with its source and confidence', () => {
  const { context } = applyContextPatch(
    { company_dna: { funding_stage: 'Seed' } },
    { updates: [{
      field: 'company_dna.funding_stage', new_value: 'Series B',
      evidence_quote: 'raised $40M', confidence: 80, source_url: 'https://example.com/press',
    }] },
    {}
  )
  const entry = context._factProvenance['company_dna.funding_stage']
  assert.ok(entry, 'an accepted update must leave a provenance entry')
  assert.equal(entry.source_url, 'https://example.com/press')
  assert.equal(entry.confidence, 80)
  assert.ok(entry.as_of && !Number.isNaN(new Date(entry.as_of).getTime()), 'as_of must be a real timestamp')
})

check('a rejected update never touches _factProvenance', () => {
  const { context } = applyContextPatch(
    { industry: 'Logistics', _factProvenance: { industry: { as_of: '2020-01-01T00:00:00.000Z', source_url: null, confidence: null } } },
    { updates: [{ field: 'industry', new_value: 'Retail', evidence_quote: 'q' }] },
    { fields: ['industry'], removed: [] } // founder corrected it — the update must be rejected
  )
  assert.equal(
    context._factProvenance.industry.as_of, '2020-01-01T00:00:00.000Z',
    'a rejected update must not refresh the stamp — that would make a dropped correction ' +
    'look freshly reconfirmed'
  )
})

check('a fact the merge did not touch keeps its existing stamp', () => {
  const { context } = applyContextPatch(
    {
      company_dna: { funding_stage: 'Seed', team_size: '1-10' },
      _factProvenance: { 'company_dna.team_size': { as_of: '2020-01-01T00:00:00.000Z', source_url: 'https://old.example.com', confidence: 50 } },
    },
    { updates: [{ field: 'company_dna.funding_stage', new_value: 'Series A', evidence_quote: 'q' }] },
    {}
  )
  assert.equal(
    context._factProvenance['company_dna.team_size'].as_of, '2020-01-01T00:00:00.000Z',
    'a merge must only refresh the facts it actually confirmed — untouched facts keep their age'
  )
  assert.ok(context._factProvenance['company_dna.funding_stage'], 'the touched fact must get a fresh entry')
})

check('a new competitor addition is stamped, an already-present one is not re-stamped', () => {
  const { context } = applyContextPatch(
    {
      key_competitors: [{ name: 'Shiprocket' }],
      _factProvenance: { 'key_competitors:shiprocket': { as_of: '2020-01-01T00:00:00.000Z', source_url: null, confidence: null } },
    },
    // Shiprocket is re-offered (already present, so addList dedupes it silently) alongside
    // a genuinely new competitor — only the new one may be stamped.
    { additions: { key_competitors: [{ name: 'Shiprocket' }, { name: 'Delhivery', source_url: 'https://example.com/news' }] } },
    {}
  )
  assert.equal(
    context._factProvenance['key_competitors:shiprocket'].as_of, '2020-01-01T00:00:00.000Z',
    'an already-present competitor re-offered by the model was not newly confirmed by this merge'
  )
  assert.equal(context._factProvenance['key_competitors:delhivery'].source_url, 'https://example.com/news')
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
