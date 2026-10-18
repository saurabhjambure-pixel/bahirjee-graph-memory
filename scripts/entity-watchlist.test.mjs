/**
 * Entity watchlist + primary source mapping tests.
 *
 * Neither module had any test. Both were silently producing junk:
 *
 *   1. `adjacent_solutions` holds APPROACHES ("Traditional 3PL Providers"), not companies,
 *      but they were filed as category 'competitor'. That made resolveDomain construct a
 *      homepage out of the category name — entity_sources really contains
 *      https://logisticsconsultingfirms.com/pricing — and made the verifier's
 *      competitor-validation gate demand evidence for a thing no evidence can exist about.
 *
 *   2. A URL the LLM emitted alongside a competitor was labelled 'observed', a confidence
 *      whose own docstring says "seen somewhere real". That unlocked the full four-page
 *      treatment, which is how delhivery.com/changelog and ecomexpress.in/pricing were
 *      written as tracked sources. Meanwhile validateCompetitorViaExa was resolving those
 *      companies' real homepages and throwing them away.
 *
 *   3. tracked_entities.category has a CHECK constraint that was never widened past the
 *      original five, while the generator has been emitting 'customer', 'investor' and
 *      'partner' since document intel shipped — the entities its own comment calls "the
 *      highest-signal entities we get". Postgres rejected every one; storeEntityWatchlist
 *      counted the error and returned normally. Same failure shape as the source_type
 *      drift that observation-source-types.test.mjs exists to prevent.
 *
 * Run: npm run test:watchlist
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateEntityWatchlist, generateEntityRelationships, normalizeTrackedEntities } from '../src/services/entityWatchlistGenerator.js'
import { buildStartupContext } from '../src/services/contextBuilder.js'
import { mapPrimarySources, resolveDomain } from '../src/services/primarySourceMapper.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

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

const withId = (entities) => entities.map((e, i) => ({ ...e, id: `e${i}` }))
const urlsFor = (name, sources) => sources.filter(s => s.entity_name === name).map(s => s.url)

// ─── 1. adjacent solutions are not competitors ──────────────────────────────

const context = {
  competitive_map: {
    named_competitors: [
      { name: 'Shiprocket', url: 'https://www.shiprocket.in', resolved_url: 'https://shiprocket.in' },
      { name: 'Delhivery', url: 'https://www.delhivery.com' },
    ],
    adjacent_solutions: [
      { name: 'Traditional 3PL Providers', approach: 'Outsourced fulfilment' },
      { name: 'Logistics Consulting Firms', approach: 'Advisory' },
    ],
  },
  dependency_map: {
    infra_dependencies: [{ name: 'AWS' }],
  },
}

const entities = generateEntityWatchlist(context)
const byName = Object.fromEntries(entities.map(e => [e.name, e]))

check('an adjacent solution is categorised "adjacent", never "competitor"', () => {
  assert.equal(byName['Traditional 3PL Providers'].category, 'adjacent')
  assert.equal(byName['Logistics Consulting Firms'].category, 'adjacent')
})

check('adjacent solutions stay on the watchlist', () => {
  // They are dropped from competitor treatment, not from the run — they still carry
  // useful market context.
  assert.equal(entities.length, 5)
})

const sources = mapPrimarySources(withId(entities))

check('no URL is ever constructed from a category name', () => {
  const junk = sources.filter(s => /logisticsconsultingfirms|traditional3plproviders/i.test(s.url))
  assert.deepEqual(junk, [], `constructed a domain from an approach: ${junk.map(s => s.url).join(', ')}`)
  assert.deepEqual(urlsFor('Traditional 3PL Providers', sources), [])
  assert.deepEqual(urlsFor('Logistics Consulting Firms', sources), [])
})

// ─── 2. only a looked-up domain is called "observed" ────────────────────────

check('an Exa-resolved homepage is "observed" and earns full coverage', () => {
  const shiprocket = sources.filter(s => s.entity_name === 'Shiprocket')
  assert.ok(shiprocket.length > 0, 'a resolved competitor must produce sources')
  assert.ok(
    shiprocket.every(s => s.domain_confidence === 'observed'),
    `expected observed, got ${[...new Set(shiprocket.map(s => s.domain_confidence))].join(', ')}`
  )
  assert.deepEqual(
    shiprocket.map(s => s.source_type).sort(),
    ['careers', 'changelog', 'press', 'pricing'],
    'a verified domain is worth the full page set'
  )
})

check('a model-supplied URL is NOT called observed, and is treated as a guess', () => {
  const delhivery = sources.filter(s => s.entity_name === 'Delhivery')
  assert.ok(
    delhivery.every(s => s.domain_confidence === 'model_claimed'),
    'a URL the LLM wrote has not been seen anywhere real'
  )
  assert.deepEqual(
    delhivery.map(s => s.source_type).sort(),
    ['changelog', 'pricing'],
    'an unverified domain gets only the two pages worth the fetch — this is what stopped ' +
    'delhivery.com/careers and delhivery.com/blog being written as tracked sources'
  )
})

check('a curated domain is still "known"', () => {
  const aws = sources.filter(s => s.entity_name === 'AWS')
  assert.ok(aws.every(s => s.domain_confidence === 'known' || s.source_type === 'status'))
  assert.ok(aws.some(s => s.url === 'https://health.aws.amazon.com/health/status'))
})

check('an unverified infra domain gets no guessed status page', () => {
  const [entity] = withId([{ name: 'Some Vendor', category: 'infra', metadata: { url: 'https://somevendor.io' } }])
  const vendor = mapPrimarySources([entity])
  assert.deepEqual(
    vendor.filter(s => s.source_type === 'status'), [],
    'guessing status.X on top of an unverified X compounds two unknowns'
  )
})

// ─── 2b. relationship edges derive from the SAME entities, not a second walk ────

check('every competitor becomes a competes_with edge, adjacent solutions get none', () => {
  const relations = generateEntityRelationships(entities)
  const byName = Object.fromEntries(relations.map(r => [r.name, r.relation]))
  assert.equal(byName['Shiprocket'], 'competes_with')
  assert.equal(byName['Delhivery'], 'competes_with')
  assert.equal(byName['AWS'], 'depends_on')
  assert.ok(
    !('Traditional 3PL Providers' in byName) && !('Logistics Consulting Firms' in byName),
    'an adjacent solution is a category of approach, not a company — no relation in the ' +
    "vocabulary honestly describes one, so it must get no edge at all, not a wrong one"
  )
  assert.equal(relations.length, 3, 'exactly the 2 competitors + 1 infra dependency, no more')
})

check('a major integration is integrates_with, not the generic depends_on', () => {
  const docContext = {
    dependency_map: { major_integrations: [{ name: 'Slack' }] },
  }
  const docEntities = generateEntityWatchlist(docContext)
  const relations = generateEntityRelationships(docEntities)
  assert.deepEqual(relations, [{ name: 'Slack', relation: 'integrates_with', evidenceUrl: null }])
})

check('a relationship carries its evidence URL when the entity has one', () => {
  const relations = generateEntityRelationships(entities)
  const shiprocket = relations.find(r => r.name === 'Shiprocket')
  assert.equal(
    shiprocket.evidenceUrl, 'https://shiprocket.in',
    'prefer resolved_url (an index actually returned it) over the model-supplied url'
  )
})

// ─── 3. the schema permits every category the generator emits ───────────────

check('tracked_entities.category permits every category the code emits', () => {
  const docContext = {
    competitive_map: {
      named_competitors: [{ name: 'Rival' }],
      category_peers: [{ name: 'Peer' }],
      adjacent_solutions: [{ name: 'An Approach' }],
    },
    dependency_map: {
      infra_dependencies: [{ name: 'Infra Co' }],
      platform_dependencies: [{ name: 'Platform Co' }],
      regulatory_exposure: [{ name: 'A Regulator' }],
      major_integrations: [{ name: 'An Integration' }],
    },
    internal_relationships: {
      customers: [{ name: 'A Customer', segment: 'Enterprise' }],
      investors: [{ name: 'An Investor', round: 'Seed' }],
      partners: [{ name: 'A Partner', relationship: 'Channel' }],
    },
  }
  const emitted = new Set(generateEntityWatchlist(docContext).map(e => e.category))
  assert.ok(emitted.has('customer'), 'the fixture must exercise document-derived entities')

  // Latest migration wins, ordered by version number — lexical sort puts v6 after v22.
  const files = readdirSync(join(ROOT, 'scripts/migrations'))
    .filter(f => f.endsWith('.sql'))
    .map(f => ({ file: f, version: Number(/^v(\d+)/.exec(f)?.[1] ?? -1) }))
    .sort((a, b) => a.version - b.version)

  let permitted = null
  for (const { file } of files) {
    const sql = readFileSync(join(ROOT, 'scripts/migrations', file), 'utf8')
    if (!/tracked_entities/i.test(sql)) continue
    const m = /category\s+IN\s*\(([^)]*)\)/i.exec(sql)
    if (m) permitted = new Set([...m[1].matchAll(/'([a-z_]+)'/gi)].map(x => x[1]))
  }
  assert.ok(permitted, 'no migration constrains tracked_entities.category — expected v25')

  const rejected = [...emitted].filter(c => !permitted.has(c))
  assert.deepEqual(
    rejected, [],
    `generateEntityWatchlist emits ${rejected.join(', ')}, which the CHECK rejects. ` +
    `Postgres refuses the row, storeEntityWatchlist counts an error and returns normally, ` +
    `and the entity vanishes with no failure anywhere.`
  )
})


// ─── 4. a correction on the review screen actually reaches the watchlist ────
//
// enrichContextWithOnboarding runs in handleOnboardingComplete — BEFORE the founder ever
// sees ContextReviewScreen. It snapshots context.key_competitors into
// _startupContext.competitive_map.named_competitors (contextBuilder.extractCompetitiveMap),
// and generateEntityWatchlist reads THAT, never context.key_competitors.
//
// So for as long as the structured layer was derived only once, deleting a wrong competitor
// on the review screen changed nothing that mattered: it stayed on the watchlist, kept its
// entry in _primarySources, and kept being fetched by Source Watch every week. The founder
// was told the correction was accepted. Nothing threw. The run was simply wrong about who
// the company competes with.
//
// The fix is a second, deterministic pass over the REVIEWED context at confirm time
// (runConfirmContext). These two checks pin the mechanism and the wiring separately —
// either one alone can pass while the founder's edit is still discarded.

const REVIEWED_ONBOARDING = { revenueModel: 'Subscription', customerType: 'B2B' }

const contextBeforeEdit = {
  company_name: 'Acme',
  industry: 'Logistics',
  key_competitors: [
    { name: 'Shiprocket', url: 'https://shiprocket.in' },
    { name: 'Delhivery', url: 'https://delhivery.com' },
  ],
}

check('re-deriving from the edited context drops the deleted competitor', () => {
  const before = generateEntityWatchlist(
    buildStartupContext({ onboardingData: REVIEWED_ONBOARDING, autoInferred: contextBeforeEdit })
  )
  assert.ok(
    before.some(e => e.name === 'Delhivery'),
    'fixture is wrong — Delhivery must be on the watchlist before the edit'
  )

  // Exactly what ContextReviewScreen's delete button does to contextData.
  const contextAfterEdit = {
    ...contextBeforeEdit,
    key_competitors: contextBeforeEdit.key_competitors.filter(c => c.name !== 'Delhivery'),
  }

  const after = generateEntityWatchlist(
    buildStartupContext({ onboardingData: REVIEWED_ONBOARDING, autoInferred: contextAfterEdit })
  )
  assert.deepEqual(
    after.filter(e => e.name === 'Delhivery'), [],
    'a competitor deleted on the review screen must not survive re-derivation — if it ' +
    'does, extractCompetitiveMap has stopped reading key_competitors'
  )
  assert.ok(after.some(e => e.name === 'Shiprocket'), 'the deletion must not take the others with it')
})

check('re-deriving mints a new context_version_id', () => {
  const a = buildStartupContext({ onboardingData: REVIEWED_ONBOARDING, autoInferred: contextBeforeEdit })
  const b = buildStartupContext({ onboardingData: REVIEWED_ONBOARDING, autoInferred: contextBeforeEdit })
  assert.ok(a.context_version_id && b.context_version_id, 'both passes must carry a version id')
  assert.notEqual(
    a.context_version_id, b.context_version_id,
    'each derivation must mint its own id — this run\'s entities are stored under it, and ' +
    'reusing the previous one files them under the generation that did not produce them'
  )
})

check('the confirm path re-derives the structured layer from the reviewed context', () => {
  // The behavioural check above proves re-derivation works. This one proves it is
  // actually wired into the only path that spends a run.
  const dashboard = readFileSync(join(ROOT, 'src/components/IntelligenceDashboard.jsx'), 'utf8')
  const start = dashboard.indexOf('const runConfirmContext')
  assert.notEqual(start, -1, 'runConfirmContext not found — repoint this test')
  const body = dashboard.slice(start, dashboard.indexOf('const handleQnA', start))

  assert.match(
    body, /enrichContextWithOnboarding\(/,
    'runConfirmContext must re-run enrichContextWithOnboarding over the reviewed context. ' +
    'Without it, every edit made on ContextReviewScreen is dropped before the job is created.'
  )
  // The job must carry the RE-DERIVED context. Re-deriving and then submitting the stale
  // object is the same bug with extra steps — and the stale form is easy to reintroduce by
  // accident, because `contextData,` as an object shorthand looks like nothing at all.
  const staleForms = [
    [/\bcontextData\s*,/, 'object shorthand `contextData,` in the submit payload'],
    [/contextData:\s*contextData\b/, 'explicit `contextData: contextData`'],
    [/resumeIntelligenceJob\(\s*activeJobId\s*,\s*contextData\s*\)/, 'bare contextData passed to resumeIntelligenceJob'],
  ]
  const submitStart = body.indexOf('submitIntelligenceJob(')
  assert.notEqual(submitStart, -1, 'runConfirmContext no longer submits a job — repoint this test')
  const payload = body.slice(submitStart, body.indexOf('});', submitStart))

  for (const [pattern, label] of staleForms) {
    const haystack = label.includes('resumeIntelligenceJob') ? body : payload
    assert.ok(
      !pattern.test(haystack),
      `runConfirmContext still sends the pre-review context (${label}). Every edit made on ` +
      `ContextReviewScreen — deleted competitors included — is discarded before the job exists.`
    )
  }
})

check('a watchlist derived by an older client build is re-filed on the server', () => {
  // The exact shape three production runs (2026-10-02 → 10-06) carried: adjacent solutions
  // as `competitor`, discriminated only by source_field.
  const legacy = [
    { name: 'Cinquo', category: 'competitor', metadata: { source_field: 'named_competitors' } },
    { name: 'Zoho Inventory', category: 'competitor', metadata: { source_field: 'adjacent_solutions', sub_category: 'adjacent' } },
    { name: 'Salla', category: 'competitor', metadata: { source_field: 'category_peers', sub_category: 'peer' } },
  ]
  const { entities, changed } = normalizeTrackedEntities(legacy)
  assert.equal(changed, 1)
  assert.deepEqual(entities.map(e => e.category), ['competitor', 'adjacent', 'competitor'])
  assert.equal(legacy[1].category, 'competitor', 'input is not mutated')
  assert.equal(mapPrimarySources(entities).some(s => /zoho/i.test(JSON.stringify(s))), false, 'an adjacent solution gets no invented domain')
  const again = normalizeTrackedEntities(entities)
  assert.equal(again.changed, 0, 'idempotent')
  assert.equal(again.entities, entities)
})

check('an evidence-discovered competitor is never given a guessed domain, but a resolved homepage is trusted', () => {
  const bare = { name: 'Grexa AI', category: 'competitor', metadata: { source: 'evidence' } }
  assert.equal(resolveDomain(bare), null, 'no ${name}.com construction for a name only an article mentioned')
  const resolved = { ...bare, metadata: { ...bare.metadata, resolved_url: 'https://grexa.ai' } }
  assert.deepEqual(resolveDomain(resolved), { domain: 'grexa.ai', confidence: 'observed' })
  // The founder's own competitors keep the old fallback — this is scoped to evidence.
  assert.equal(resolveDomain({ name: 'Cinquo', category: 'competitor', metadata: { source: 'inferred' } })?.confidence, 'guessed')
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
