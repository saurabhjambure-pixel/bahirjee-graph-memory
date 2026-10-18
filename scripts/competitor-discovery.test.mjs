import assert from 'node:assert/strict'
import {
  discoverCompetitors, mergeEvidenceEntities, cleanEntityName, MAX_DISCOVERED_PER_RUN,
  isStaleEvidenceEntity, refreshSeenEvidence, staleEvidenceRows, EVIDENCE_MAX_AGE_DAYS,
} from '../src/services/competitorDiscovery.js'

let n = 0
const check = (name, fn) => {
  try { fn(); n++; console.log(`  ✓ ${name}`) } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1 }
}
console.log('\ncompetitor discovery\n')

const sig = (category, entity, url = `https://${String(entity).replace(/\W/g, '').toLowerCase() || 'x'}.com/a`) =>
  ({ category, entity_involved: entity, source_url: url, signal_headline: `${entity} moved` })

// The Dhanda run (2026-10-06): the watchlist held Appmaker, Cinquo, ReviewPro, Salla, Zaapi, …
// while the evidence named these.
const TRACKED = ['Appmaker', 'Cinquo', 'ReviewPro', 'Salla', 'Zaapi', 'Zoho Inventory', 'Google My Business']
  .map(name => ({ name, category: 'competitor', metadata: {} }))
const DHANDA = [
  sig('CompetitorFunding', 'Grexa AI'),
  sig('CompetitorLaunch', 'LocalTuneUp'),
  sig('CompetitorLaunch', 'Localith'),
  sig('CompetitorLaunch', 'GMB Rank Checker'),
  sig('CompetitorLaunch', 'GBPPromote (TOTOSLocal One Private Limited)'),
  sig('CompetitorLaunch', 'Jio Haptik'),
  // Not competitors, whatever the entity looks like:
  sig('TangentialTrend', 'Bain & Company'),
  sig('IndustryMomentum', 'Adobe'),
  sig('PartnershipOpportunity', 'Zoho'),
  sig('RegulatoryChange', 'Ministry of Electronics and Information Technology (MeitY)'),
]

check('promotes the competitors the evidence named, and only those', () => {
  const found = discoverCompetitors(DHANDA, TRACKED, { companyName: 'Dhanda' })
  const six = ['Grexa AI', 'LocalTuneUp', 'Localith', 'GMB Rank Checker', 'GBPPromote', 'Jio Haptik']
  assert.equal(found.length, MAX_DISCOVERED_PER_RUN, 'six qualify; the per-run cap keeps five')
  assert.ok(found.every(f => six.includes(f.name)), `only competitor-category names: ${found.map(f => f.name)}`)
  assert.ok(found.every(f => f.category === 'competitor' && f.metadata.source === 'evidence'))
  assert.ok(found.every(f => f.metadata.evidence_urls.length >= 1), 'each carries the URL that justified it')
  for (const notCompetitor of ['Bain', 'Adobe', 'Zoho', 'Ministry']) {
    assert.ok(!found.some(f => f.name.includes(notCompetitor)), notCompetitor)
  }
})
check('a competitor already on the watchlist is not promoted again (fuzzy)', () => {
  const found = discoverCompetitors([sig('CompetitorLaunch', 'Cinquo Technologies'), sig('CompetitorLaunch', 'review pro')], TRACKED)
  assert.equal(found.filter(f => /cinquo/i.test(f.name)).length, 0)
  assert.equal(found.length, 0, '"review pro" is a spacing variant of the tracked ReviewPro')
})
check('the founder\'s own company is never promoted', () => {
  assert.deepEqual(discoverCompetitors([sig('CompetitorLaunch', 'Dhanda')], [], { companyName: 'Dhanda' }), [])
})
check('a signal without a source URL cannot promote anything', () => {
  assert.deepEqual(discoverCompetitors([{ category: 'CompetitorLaunch', entity_involved: 'Ghost Co', source_url: '' }], []), [])
})
check('bodies, joint programmes and categories are not companies', () => {
  for (const bad of ['Ministry of MSME', 'DPIIT / ONDC', 'Local Digital Agencies', 'Retail Platforms', '', null, 'x']) {
    assert.equal(cleanEntityName(bad), null, String(bad))
  }
  assert.equal(cleanEntityName('GBPPromote (TOTOSLocal One Private Limited)'), 'GBPPromote')
})
check('promotion per run is capped and ranked by independent sources', () => {
  const many = Array.from({ length: 9 }, (_, i) => sig('CompetitorLaunch', `Rival${i}x`))
  many.push(sig('CompetitorFunding', 'Rival8x', 'https://other.com/1'))
  const found = discoverCompetitors(many, [])
  assert.equal(found.length, MAX_DISCOVERED_PER_RUN)
  assert.equal(found[0].name, 'Rival8x', 'two independent sources outrank one')
})
check('stored evidence entities join the watchlist after the founder\'s and never displace them', () => {
  const stored = [
    { name: 'Grexa AI', category: 'competitor', metadata: { source: 'evidence' } },
    { name: 'Cinquo', category: 'competitor', metadata: { source: 'evidence' } },     // already tracked
    { name: 'Appmaker', category: 'competitor', metadata: { source: 'inferred' } },   // not evidence-sourced
  ]
  const merged = mergeEvidenceEntities(TRACKED, stored)
  assert.deepEqual(merged.slice(0, TRACKED.length), TRACKED)
  assert.deepEqual(merged.slice(TRACKED.length).map(e => e.name), ['Grexa AI'])
  assert.equal(mergeEvidenceEntities(TRACKED, []), TRACKED, 'nothing to add returns the same list')
})

const NOW = Date.parse('2026-10-07T00:00:00Z')
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString()
const ev = (name, seenDaysAgo, extra = {}) => ({ name, category: 'competitor', is_active: true, metadata: { source: 'evidence', last_seen_at: daysAgo(seenDaysAgo) }, ...extra })

check('a promoted competitor ages out after it stops appearing', () => {
  assert.equal(isStaleEvidenceEntity(ev('Old Co', EVIDENCE_MAX_AGE_DAYS + 1), NOW), true)
  assert.equal(isStaleEvidenceEntity(ev('Recent Co', EVIDENCE_MAX_AGE_DAYS - 1), NOW), false)
})
check('only evidence-promoted entities can age out — the founder\'s own list never does', () => {
  const founders = { name: 'Cinquo', category: 'competitor', metadata: { source: 'inferred', last_seen_at: daysAgo(900) } }
  assert.equal(isStaleEvidenceEntity(founders, NOW), false)
  assert.equal(isStaleEvidenceEntity({ name: 'X', metadata: { source: 'internal_doc' } }, NOW), false)
})
check('no usable date means keep, not retire', () => {
  assert.equal(isStaleEvidenceEntity({ name: 'X', category: 'competitor', metadata: { source: 'evidence' } }, NOW), false)
  assert.equal(isStaleEvidenceEntity({ name: 'X', metadata: { source: 'evidence', last_seen_at: 'garbage' } }, NOW), false)
})
check('falls back to the row\'s updated_at for entities stored before last_seen_at existed', () => {
  const legacy = { name: 'Legacy', category: 'competitor', updated_at: daysAgo(200), metadata: { source: 'evidence' } }
  assert.equal(isStaleEvidenceEntity(legacy, NOW), true)
})
check('an entity named again is stamped seen — in any signal category — and nothing else changes', () => {
  const list = [ev('Grexa AI', 50), ev('Quiet Co', 50), { name: 'Cinquo', category: 'competitor', metadata: { source: 'inferred' } }]
  const out = refreshSeenEvidence(list, [{ category: 'CapitalClimate', entity_involved: 'Grexa AI (India)' }], '2026-10-07T00:00:00.000Z')
  assert.equal(out[0].metadata.last_seen_at, '2026-10-07T00:00:00.000Z')
  assert.equal(out[1], list[1], 'unmentioned entity is untouched')
  assert.equal(out[2], list[2], 'founder entity is untouched')
  assert.equal(list[0].metadata.last_seen_at, daysAgo(50), 'input is not mutated')
})
check('stale evidence is neither merged into the next watchlist nor left active', () => {
  const stored = [ev('Fresh Co', 5), ev('Stale Co', 90)]
  assert.deepEqual(mergeEvidenceEntities([], stored, { now: NOW }).map(e => e.name), ['Fresh Co'])
  assert.deepEqual(staleEvidenceRows(stored, { now: NOW }).map(e => e.name), ['Stale Co'])
  assert.deepEqual(staleEvidenceRows([ev('Stale Co', 90, { is_active: false })], { now: NOW }), [], 'already retired')
})
check('discovery stamps last_seen_at so a new promotion starts its clock', () => {
  const [found] = discoverCompetitors([sig('CompetitorLaunch', 'Brand New Co')], [], { now: '2026-10-07T00:00:00.000Z' })
  assert.equal(found.metadata.last_seen_at, '2026-10-07T00:00:00.000Z')
})
console.log(`\n${n} passed`)
