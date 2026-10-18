/**
 * Temporal evidence tests — persistence, the LLM contract, packets and surfaces.
 *
 * The rule this whole file defends: temporal classification decides where evidence may be
 * SHOWN. It never decides whether evidence is KEPT. Every observation, signal and report
 * that existed before this feature still exists after it, and every one retrieved under it
 * is retained whatever window it falls in.
 *
 * That is why the migration assertions below are written as prohibitions. An additive
 * migration is easy to write and easy to quietly stop being additive six months later,
 * and the thing it would destroy — years of historical evidence — is the one asset in this
 * system that cannot be re-fetched.
 *
 * Run: npm run test:temporal-evidence
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

// ════════════════════════════════════════════════════════════════════════════
// MIGRATION — additive, idempotent, and incapable of destroying evidence
// ════════════════════════════════════════════════════════════════════════════

const MIGRATION_PATH = '../scripts/migrations/v27_temporal_evidence.sql'
let migration = ''
try {
  migration = read(MIGRATION_PATH)
} catch {
  console.error(`  ✗ ${MIGRATION_PATH} does not exist`)
  process.exitCode = 1
}

const sqlNoComments = migration
  .split('\n')
  .filter(l => !l.trim().startsWith('--'))
  .join('\n')

console.log('\nmigration is additive')

check('the migration file exists', () => {
  assert.ok(migration.length > 0, 'migration is empty or missing')
})

check('the migration contains no destructive statement', () => {
  // Not "we did not intend to delete" — "it is not possible for this file to delete".
  const forbidden = [
    /\bDELETE\s+FROM\b/i,
    /\bTRUNCATE\b/i,
    /\bDROP\s+TABLE\b/i,
    /\bDROP\s+COLUMN\b/i,
    /\bDROP\s+DATABASE\b/i,
    /\bDROP\s+SCHEMA\b/i,
  ]
  for (const pattern of forbidden) {
    assert.ok(
      !pattern.test(sqlNoComments),
      `migration contains a destructive statement matching ${pattern}`
    )
  }
})

check('the migration rewrites no existing row', () => {
  // A backfill UPDATE would overwrite provenance we cannot reconstruct. Legacy rows keep
  // NULL temporal fields and are read as "unknown", which is the honest answer.
  assert.ok(!/\bUPDATE\s+public\./i.test(sqlNoComments), 'migration UPDATEs existing rows')
})

check('every column add is idempotent', () => {
  const adds = sqlNoComments.match(/ADD COLUMN[^,;\n]*/gi) || []
  assert.ok(adds.length > 0, 'expected ADD COLUMN statements')
  for (const add of adds) {
    assert.match(add, /ADD COLUMN IF NOT EXISTS/i, `not idempotent: ${add.trim()}`)
  }
})

check('every index is idempotent', () => {
  const indexes = sqlNoComments.match(/CREATE\s+(UNIQUE\s+)?INDEX[^(]*/gi) || []
  assert.ok(indexes.length > 0, 'expected CREATE INDEX statements')
  for (const idx of indexes) {
    assert.match(idx, /IF NOT EXISTS/i, `not idempotent: ${idx.trim()}`)
  }
})

check('no new column is NOT NULL — legacy rows have no temporal provenance', () => {
  const adds = sqlNoComments.match(/ADD COLUMN IF NOT EXISTS[^,;\n]*/gi) || []
  for (const add of adds) {
    assert.ok(
      !/NOT\s+NULL/i.test(add),
      `NOT NULL on a new column would reject every legacy row: ${add.trim()}`
    )
  }
})

check('CHECK constraints admit NULL so legacy rows stay valid', () => {
  // A CHECK on an enum column must not become a de-facto NOT NULL. Every constraint
  // added here has to spell out its null case.
  const checks = sqlNoComments.match(/CHECK\s*\([^;]*?\)\s*(?:NOT VALID)?\s*;/gis) || []
  assert.ok(checks.length > 0, 'expected CHECK constraints on the new enum columns')
  for (const c of checks) {
    assert.match(c, /IS NULL/i, `CHECK does not admit NULL: ${c.slice(0, 120)}`)
  }
})

check('constraint creation is guarded so a re-run does not error', () => {
  assert.match(
    sqlNoComments, /DO\s+\$\$/i,
    'ADD CONSTRAINT has no IF NOT EXISTS in Postgres; guard it in a DO block'
  )
})

console.log('\nmigration adds the columns the code writes')

const OBSERVATION_COLUMNS = ['retrieval_window', 'retrieval_start_date']
const SIGNAL_COLUMNS = [
  'event_date', 'published_date', 'retrieved_at',
  'temporal_role', 'date_confidence', 'supporting_evidence',
]
const NEWS_COLUMNS = ['event_date', 'temporal_role', 'supporting_evidence']

/**
 * Columns the migration adds to a given table.
 *
 * Parsed from the ALTER statements rather than searched for as loose text, so a column
 * added to the wrong table cannot pass by appearing somewhere in the file.
 */
function columnsAddedTo(table) {
  const pattern = new RegExp(
    `ALTER TABLE\\s+public\\.${table}\\s+ADD COLUMN IF NOT EXISTS\\s+(\\w+)`, 'gi'
  )
  return new Set([...sqlNoComments.matchAll(pattern)].map(m => m[1]))
}

check('observations gains its retrieval provenance columns', () => {
  const added = columnsAddedTo('observations')
  for (const col of OBSERVATION_COLUMNS) {
    assert.ok(added.has(col), `observations missing ${col} (got: ${[...added].join(', ')})`)
  }
})

check('structured_signals gains its temporal columns', () => {
  const added = columnsAddedTo('structured_signals')
  for (const col of SIGNAL_COLUMNS) {
    assert.ok(added.has(col), `structured_signals missing ${col} (got: ${[...added].join(', ')})`)
  }
})

check('news_items gains its temporal columns', () => {
  const added = columnsAddedTo('news_items')
  for (const col of NEWS_COLUMNS) {
    assert.ok(added.has(col), `news_items missing ${col} (got: ${[...added].join(', ')})`)
  }
})

check('supporting_evidence defaults to an empty array, not NULL', () => {
  // The readers iterate it. A NULL default would make every consumer guard, and one of
  // them would forget.
  const matches = migration.match(/supporting_evidence[^,;\n]*/g) || []
  assert.ok(matches.length >= 2, 'expected supporting_evidence on both signal tables')
  for (const m of matches.filter(x => x.includes('JSONB'))) {
    assert.match(m, /DEFAULT\s+'\[\]'::jsonb/i, `no empty-array default: ${m}`)
  }
})

check('the query indexes the surfaces actually run are created', () => {
  assert.match(migration, /\(company_id,\s*event_date\s+DESC\)/i)
  assert.match(migration, /\(company_id,\s*temporal_role,\s*is_visible\)/i)
})

console.log('\nfresh installs and upgraded databases agree')

check('the observations schema file mirrors the new columns', () => {
  // A column that exists only in a migration is invisible to anyone reading the schema,
  // and a fresh install would be missing it entirely.
  const schema = read('../sql/create_observations_table.sql')
  for (const col of OBSERVATION_COLUMNS) {
    assert.ok(schema.includes(col), `sql/create_observations_table.sql missing ${col}`)
  }
})

check('the context-signals schema file mirrors the new columns', () => {
  const schema = read('../sql/context_signals_schema.sql')
  const signalsBlock = schema.split('CREATE TABLE IF NOT EXISTS public.structured_signals')[1] || ''
  const newsBlock = schema.split('CREATE TABLE IF NOT EXISTS public.news_items')[1] || ''
  for (const col of ['event_date', 'temporal_role', 'date_confidence', 'supporting_evidence']) {
    assert.ok(signalsBlock.includes(col), `structured_signals schema missing ${col}`)
  }
  for (const col of NEWS_COLUMNS) {
    assert.ok(newsBlock.includes(col), `news_items schema missing ${col}`)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// WRITE PATH — new columns must not take the batch down with them
// ════════════════════════════════════════════════════════════════════════════

console.log('\nthe write survives an un-migrated database')

const observationService = read('../src/services/observationService.js')

check('storeObservations writes the retrieval window', () => {
  for (const col of OBSERVATION_COLUMNS) {
    assert.ok(observationService.includes(col), `observationService never writes ${col}`)
  }
})

check('the temporal columns degrade instead of failing the whole batch', () => {
  // This is the exact failure v20 caused: PostgREST rejects the WHOLE batch on one
  // unknown column, storeObservations counts the error and returns normally, and the
  // stepped pipeline — which reads observations back from Postgres — produces an empty
  // report with no error anywhere. v24 is still unapplied on production, so a new column
  // that cannot degrade is not a hypothetical risk here.
  assert.match(
    observationService, /PGRST204[\s\S]{0,400}retrieval_window/,
    'no PGRST204 fallback naming retrieval_window'
  )
  assert.match(
    observationService, /retrieval_window,\s*retrieval_start_date,\s*\.\.\.rest/,
    'the fallback must strip BOTH temporal columns and retry'
  )
})

check('the retrieval window is gated behind an availability flag, like source_class', () => {
  assert.match(
    observationService, /temporalColumnsAvailable/,
    'expected a module-scope availability flag so the probe happens once per session'
  )
})

const signalTransformer = read('../src/services/structuredSignalTransformer.js')
const newsScorer = read('../src/services/newsScorer.js')

check('storeStructuredSignals persists every temporal field', () => {
  const body = signalTransformer.slice(signalTransformer.indexOf('export async function storeStructuredSignals'))
  for (const col of SIGNAL_COLUMNS) {
    assert.ok(body.includes(col), `structured_signals write never sets ${col}`)
  }
})

check('the signal write degrades when the temporal columns are missing', () => {
  const body = signalTransformer.slice(signalTransformer.indexOf('export async function storeStructuredSignals'))
  assert.match(
    body, /PGRST204[\s\S]{0,200}TEMPORAL_COLUMNS/,
    'expected a PGRST204 fallback covering the temporal column set'
  )
  assert.match(body, /stripTemporal/, 'the fallback must strip the columns and retry')
})

check('storeNewsItems persists the anchor date and its context', () => {
  const body = newsScorer.slice(newsScorer.indexOf('export async function storeNewsItems'))
  for (const col of NEWS_COLUMNS) {
    assert.ok(body.includes(col), `news_items write never sets ${col}`)
  }
})

check('the news write degrades when the temporal columns are missing', () => {
  const body = newsScorer.slice(newsScorer.indexOf('export async function storeNewsItems'))
  assert.match(body, /PGRST204/)
})

check('no write path uses ingestion time as an event date', () => {
  // The original bug in one line: `timestamp: new Date().toISOString()` was the only
  // date a news item had. event_date must never be assigned from a fresh clock read.
  for (const [name, src] of [['transformer', signalTransformer], ['newsScorer', newsScorer]]) {
    assert.ok(
      !/event_date:\s*new Date\(\)/.test(src),
      `${name} assigns event_date from the current clock`
    )
    assert.ok(
      !/event_date:.*Date\.now\(\)/.test(src),
      `${name} assigns event_date from Date.now()`
    )
  }
})

// ════════════════════════════════════════════════════════════════════════════
// LLM CONTRACT — the model is TOLD the cutoffs instead of guessing them
// ════════════════════════════════════════════════════════════════════════════

const { PROMPTS } = await import('../src/services/promptUtils.js')
const { buildTemporalPolicy } = await import('../src/services/temporalPolicy.js')

const POLICY = buildTemporalPolicy(new Date('2026-09-19T11:30:00.000Z'))

const SEARCH_RESULTS = [
  { job: 'RivalPay pricing', data: 'RivalPay cut interchange fees.', url: 'https://ex.com/a', published_date: '2026-07-02' },
]
const CONTEXT = { company_name: 'Acme', operating_geography: 'India', key_competitors: ['RivalPay'] }

const signalsPrompt = PROMPTS.buildSignals(CONTEXT, SEARCH_RESULTS, POLICY, [], false)

console.log('\nthe analyze prompt carries the real cutoffs')

check('the prompt states the exact current cutoff date', () => {
  // The old signature took `startDate` and `lookbackMonths` and interpolated NEITHER into
  // the prompt body. The model was asked to judge recency with no idea what "recent"
  // meant, and both parameters were dead weight through three call sites.
  assert.ok(
    signalsPrompt.includes('2026-03-19'),
    'the six-month cutoff does not appear in the prompt'
  )
})

check('the prompt states the exact context cutoff date', () => {
  assert.ok(signalsPrompt.includes('2025-09-19'), 'the twelve-month cutoff does not appear')
})

check('the prompt states today, so "recent" is anchored', () => {
  assert.ok(signalsPrompt.includes('2026-09-19'))
})

check('the prompt forbids an old source standing alone as a current signal', () => {
  const lowered = signalsPrompt.toLowerCase()
  assert.ok(
    /must not|never|do not/.test(lowered) && lowered.includes('historical'),
    'no prohibition on presenting historical evidence as a current move'
  )
})

check('the prompt asks for evidence_role on every signal', () => {
  assert.ok(signalsPrompt.includes('evidence_role'))
  for (const role of ['anchor', 'supporting_context', 'historical_context']) {
    assert.ok(signalsPrompt.includes(role), `prompt never mentions ${role}`)
  }
})

check('the prompt asks for event_date and forbids substituting today', () => {
  assert.ok(signalsPrompt.includes('event_date'))
  const lowered = signalsPrompt.toLowerCase()
  assert.ok(
    lowered.includes("today's date") || lowered.includes('today\u2019s date'),
    'the prompt must explicitly forbid substituting the current date'
  )
})

check('the prompt offers supporting_source_urls for linking old evidence to a new event', () => {
  // The alternative to dropping old evidence: attach it to a recent anchor. If the
  // prompt does not offer the field, the model has only two options for a 2024 source —
  // present it as current, or discard it. Both are wrong.
  assert.ok(signalsPrompt.includes('supporting_source_urls'))
})

check('the prompt still refuses to invent a date it does not have', () => {
  const lowered = signalsPrompt.toLowerCase()
  assert.ok(
    lowered.includes('omit') || lowered.includes('null'),
    'an undated source must remain representable without fabrication'
  )
})

console.log('\nthe constrained schema can express the contract')

const geminiSource = read('../lib/handlers/gemini.js')
const analyzeHandler = geminiSource.slice(
  geminiSource.indexOf('async function handleAnalyzeSignals'),
  geminiSource.indexOf('async function handleGenerateSummary')
)

// The schema is read from the real object the gateway sends, not sliced out of source text.
const { buildSignalResponseSchema } = await import('../lib/handlers/gemini.js')
const TEMPORAL_FIELDS = ['event_date', 'evidence_role', 'date_confidence', 'supporting_source_urls']

check('the analyze schema declares every temporal field', () => {
  // Constrained decoding can only emit properties present in the schema. A field the
  // prompt asks for and the schema omits is silently unrepresentable — this exact
  // mismatch produced an empty hero observation in every brief for months.
  for (const quoteBinding of [false, true]) {
    const props = buildSignalResponseSchema(quoteBinding).items.properties
    for (const field of TEMPORAL_FIELDS) {
      assert.ok(field in props, `schema is missing ${field} (quoteBinding=${quoteBinding})`)
    }
  }
})

check('supporting_source_urls is typed as an array of strings', () => {
  for (const quoteBinding of [false, true]) {
    assert.deepEqual(
      buildSignalResponseSchema(quoteBinding).items.properties.supporting_source_urls,
      { type: 'ARRAY', items: { type: 'STRING' } }
    )
  }
})

check('no temporal field is REQUIRED — a missing date must stay representable', () => {
  for (const quoteBinding of [false, true]) {
    const required = buildSignalResponseSchema(quoteBinding).items.required
    assert.ok(Array.isArray(required) && required.length > 0, 'could not find the required list')
    for (const field of ['event_date', 'date_confidence', 'supporting_source_urls']) {
      assert.ok(
        !required.includes(field),
        `${field} is required — the model would fabricate one rather than omit it`
      )
    }
  }
})

check('the temporal policy reaches the analyze gateway', () => {
  assert.match(analyzeHandler, /temporalPolicy/, 'gemini.js never reads temporalPolicy from the payload')
  const llmUtils = read('../lib/_llmUtils.js')
  const analyze = llmUtils.slice(llmUtils.indexOf('async analyzeSignals'))
  assert.match(analyze.slice(0, 600), /temporalPolicy/, '_llmUtils.js does not forward temporalPolicy')
})

check('every analyze call site shares one policy instead of recomputing a window', () => {
  // Three payload sites each did `Date.now() - months * 30 * 86400000` independently,
  // so a long run could judge the same evidence against different boundaries depending
  // on which step reached it.
  const pipeline = read('../src/services/intelligenceService.js')
  const payloads = [...pipeline.matchAll(/callLLMWithRetry\('analyzeSignals'/g)]
  assert.ok(payloads.length >= 2, 'expected several analyze call sites')
  const stale = pipeline.match(/startDate:\s*new Date\(Date\.now\(\)[^\n]*lookbackMonths/g) || []
  assert.deepEqual(stale, [], `analyze payload still computes its own startDate:\n${stale.join('\n')}`)
  assert.equal(
    (pipeline.match(/temporalPolicy: runPolicy\(state\)/g) || []).length >= 3, true,
    'every analyze path must pass the run policy'
  )
})

// ════════════════════════════════════════════════════════════════════════════
// EVIDENCE PACKETS — projection, not deletion
// ════════════════════════════════════════════════════════════════════════════

const {
  normalizeSignalTemporalFields,
  attachSupportingEvidence,
  projectEvidenceForSurface,
  buildEvidencePackets,
  MAX_SUPPORTING_PER_ANCHOR,
  MAX_HISTORICAL_PER_ANCHOR,
} = await import('../src/services/evidencePackets.js')

console.log('\nsignal normalisation')

check('the legacy `date` field normalises to event_date', () => {
  // Every signal in every stored report uses `date`. Dropping it would make the entire
  // report history temporally unreadable.
  const out = normalizeSignalTemporalFields({ date: '2026-07-11', source_url: 'https://ex.com/a' }, POLICY)
  assert.equal(out.event_date, '2026-07-11')
  assert.equal(out.temporal_role, 'anchor')
})

check('event_date wins over the legacy field when both are present', () => {
  const out = normalizeSignalTemporalFields({ date: '2024-01-01', event_date: '2026-07-11' }, POLICY)
  assert.equal(out.event_date, '2026-07-11')
})

check('ingestion time never becomes an event date', () => {
  const out = normalizeSignalTemporalFields(
    { source_url: 'https://ex.com/a' },
    POLICY,
    { retrievedAt: '2026-09-19T10:00:00Z' }
  )
  assert.equal(out.event_date, null)
  assert.notEqual(out.temporal_role, 'anchor')
  assert.equal(out.retrieved_at, '2026-09-19T10:00:00Z', 'retrieved_at is still recorded, just not used as the event date')
})

check('a model-claimed anchor role is overridden by the actual date', () => {
  // The model is asked for evidence_role and will sometimes get it wrong. The date is
  // checkable; the claim is not. The date wins.
  const out = normalizeSignalTemporalFields(
    { event_date: '2024-03-01', evidence_role: 'anchor' }, POLICY
  )
  assert.equal(out.temporal_role, 'historical_context')
})

check('the legacy freshness chip still reflects the new classification', () => {
  const old = normalizeSignalTemporalFields({ event_date: '2024-03-01' }, POLICY)
  assert.equal(old.freshness, 'background', 'the Background chip must keep working')
  const current = normalizeSignalTemporalFields({ event_date: '2026-07-11' }, POLICY)
  assert.notEqual(current.freshness, 'background')
})

check('normalisation does not mutate the input signal', () => {
  const input = { date: '2026-07-11', signal_headline: 'x' }
  const before = JSON.stringify(input)
  normalizeSignalTemporalFields(input, POLICY)
  assert.equal(JSON.stringify(input), before)
})

console.log('\nlinking old evidence to a recent anchor')

const ANCHOR = {
  signal_headline: 'RivalPay cut interchange fees 15%',
  entity_involved: 'RivalPay',
  category: 'CompetitorPricing',
  event_date: '2026-07-11',
  relevance_score: 9,
  source_url: 'https://news.example.com/rivalpay-cuts',
}
const HISTORICAL = {
  signal_headline: 'RivalPay raised interchange in 2024',
  entity_involved: 'RivalPay',
  category: 'CompetitorPricing',
  event_date: '2024-03-04',
  relevance_score: 6,
  source_url: 'https://archive.example.com/rivalpay-2024',
}
const UNRELATED = {
  signal_headline: 'Unrelated logistics report',
  entity_involved: 'Globex',
  category: 'SupplyChain',
  event_date: '2024-05-01',
  relevance_score: 5,
  source_url: 'https://archive.example.com/globex',
}

check('a 2024 source supporting a 2026 event becomes one anchor with context', () => {
  const { anchors } = buildEvidencePackets({ signals: [ANCHOR, HISTORICAL], policy: POLICY })
  assert.equal(anchors.length, 1, 'the old source must not become its own current signal')
  assert.equal(anchors[0].event_date, '2026-07-11')
  assert.equal(anchors[0].supporting_evidence.length, 1)
  assert.equal(anchors[0].supporting_evidence[0].source_url, HISTORICAL.source_url)
  assert.equal(anchors[0].supporting_evidence[0].temporal_role, 'historical_context')
})

check('attached context is LABELLED, so the UI cannot render it as current', () => {
  const { anchors } = buildEvidencePackets({ signals: [ANCHOR, HISTORICAL], policy: POLICY })
  const ctx = anchors[0].supporting_evidence[0]
  assert.equal(ctx.label, 'Historical context')
  assert.equal(ctx.event_date, '2024-03-04')
})

check('an explicit supporting URL is honoured when it exists in the batch', () => {
  const anchor = { ...ANCHOR, supporting_source_urls: [HISTORICAL.source_url] }
  const { anchors } = buildEvidencePackets({ signals: [anchor, HISTORICAL], policy: POLICY })
  assert.equal(anchors[0].supporting_evidence.length, 1)
  assert.equal(anchors[0].supporting_evidence[0].source_url, HISTORICAL.source_url)
})

check('an explicit URL NOT in the batch is refused, not fetched or invented', () => {
  // Same rule as source grounding: a URL the model produced that no observation
  // contains is a fabrication, and attaching it would launder it into the report.
  const anchor = { ...ANCHOR, supporting_source_urls: ['https://fabricated.example.com/x'] }
  const { anchors } = buildEvidencePackets({ signals: [anchor, HISTORICAL], policy: POLICY })
  const urls = anchors[0].supporting_evidence.map(e => e.source_url)
  assert.ok(!urls.includes('https://fabricated.example.com/x'))
})

check('unrelated old evidence is not attached to an anchor it has nothing to do with', () => {
  const { anchors } = buildEvidencePackets({ signals: [ANCHOR, UNRELATED], policy: POLICY })
  assert.equal(anchors[0].supporting_evidence.length, 0)
})

check('an anchor never cites itself as its own supporting evidence', () => {
  const dup = { ...ANCHOR }
  const { anchors } = buildEvidencePackets({ signals: [ANCHOR, dup], policy: POLICY })
  for (const a of anchors) {
    assert.ok(!a.supporting_evidence.some(e => e.source_url === a.source_url))
  }
})

check('duplicate supporting URLs are attached once', () => {
  const twin = { ...HISTORICAL, signal_headline: 'same source, different framing' }
  const { anchors } = buildEvidencePackets({ signals: [ANCHOR, HISTORICAL, twin], policy: POLICY })
  const urls = anchors[0].supporting_evidence.map(e => e.source_url)
  assert.equal(new Set(urls).size, urls.length)
})

check('exact-entity matches outrank category-only matches', () => {
  const categoryOnly = {
    signal_headline: 'Category-wide pricing pressure', entity_involved: 'SomeOtherCo',
    category: 'CompetitorPricing', event_date: '2025-11-01', relevance_score: 10,
    source_url: 'https://ex.com/category',
  }
  const { anchors } = buildEvidencePackets({
    signals: [ANCHOR, HISTORICAL, categoryOnly], policy: POLICY,
  })
  assert.equal(
    anchors[0].supporting_evidence[0].source_url, HISTORICAL.source_url,
    'the same-entity source must rank first even with a lower relevance score'
  )
})

check('attachment is capped so a card is not buried in context', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    signal_headline: `RivalPay history ${i}`, entity_involved: 'RivalPay',
    category: 'CompetitorPricing',
    event_date: i % 2 === 0 ? '2024-03-04' : '2025-11-01',
    relevance_score: 5, source_url: `https://archive.example.com/h${i}`,
  }))
  const { anchors } = buildEvidencePackets({ signals: [ANCHOR, ...many], policy: POLICY })
  const attached = anchors[0].supporting_evidence
  const supporting = attached.filter(e => e.temporal_role === 'supporting_context')
  const historical = attached.filter(e => e.temporal_role === 'historical_context')
  assert.ok(supporting.length <= MAX_SUPPORTING_PER_ANCHOR, `${supporting.length} supporting attached`)
  assert.ok(historical.length <= MAX_HISTORICAL_PER_ANCHOR, `${historical.length} historical attached`)
})

console.log('\nNOTHING IS DELETED')

check('every input signal survives projection somewhere', () => {
  // The load-bearing guarantee of this whole feature. Classification decides where
  // evidence may be SHOWN. It never decides whether evidence is KEPT.
  const input = [ANCHOR, HISTORICAL, UNRELATED, { signal_headline: 'undated', source_url: 'https://ex.com/u' }]
  const packets = buildEvidencePackets({ signals: input, policy: POLICY })
  const retained = projectEvidenceForSurface(packets, 'internal_evidence')
  assert.equal(retained.length, input.length, 'evidence was lost during projection')
  for (const original of input) {
    assert.ok(
      retained.some(r => r.source_url === original.source_url),
      `${original.source_url} disappeared`
    )
  }
})

check('an unmatched historical signal is retained, just not surfaced', () => {
  const packets = buildEvidencePackets({ signals: [ANCHOR, UNRELATED], policy: POLICY })
  assert.ok(projectEvidenceForSurface(packets, 'internal_evidence').some(s => s.source_url === UNRELATED.source_url))
  assert.ok(!projectEvidenceForSurface(packets, 'current_news').some(s => s.source_url === UNRELATED.source_url))
})

check('buildEvidencePackets does not mutate or reorder its input array', () => {
  const input = [ANCHOR, HISTORICAL]
  const before = JSON.stringify(input)
  buildEvidencePackets({ signals: input, policy: POLICY })
  assert.equal(JSON.stringify(input), before)
})

console.log('\nsurface projections')

const PACKETS = buildEvidencePackets({
  signals: [ANCHOR, HISTORICAL, UNRELATED, { signal_headline: 'undated thing', source_url: 'https://ex.com/u' }],
  policy: POLICY,
})

check('current_news carries anchors only', () => {
  const news = projectEvidenceForSurface(PACKETS, 'current_news')
  assert.equal(news.length, 1)
  assert.equal(news[0].temporal_role, 'anchor')
})

check('an undated source never reaches current_news', () => {
  const news = projectEvidenceForSurface(PACKETS, 'current_news')
  assert.ok(!news.some(n => n.source_url === 'https://ex.com/u'))
})

check('signal_cards carry anchors with their context available', () => {
  const cards = projectEvidenceForSurface(PACKETS, 'signal_cards')
  assert.ok(cards.every(c => c.temporal_role === 'anchor'))
  assert.ok(Array.isArray(cards[0].supporting_evidence))
})

check('summary gets anchors plus attached context, and no standalone history', () => {
  const summary = projectEvidenceForSurface(PACKETS, 'summary')
  assert.ok(summary.every(s => s.temporal_role === 'anchor'))
})

check('an unknown surface returns nothing rather than leaking everything', () => {
  assert.deepEqual(projectEvidenceForSurface(PACKETS, 'not_a_surface'), [])
})

check('a run with no current evidence yields no anchors but keeps its context', () => {
  const packets = buildEvidencePackets({ signals: [HISTORICAL, UNRELATED], policy: POLICY })
  assert.equal(projectEvidenceForSurface(packets, 'current_news').length, 0)
  assert.equal(projectEvidenceForSurface(packets, 'internal_evidence').length, 2)
  assert.equal(packets.counts.anchors, 0)
  assert.equal(packets.counts.historicalContext, 2)
})

console.log('\ntelemetry')

check('the packet reports the counts a run needs to disclose', () => {
  for (const key of [
    'anchors', 'supportingContext', 'historicalContext', 'undated', 'anchorsWithSupport',
  ]) {
    assert.ok(typeof PACKETS.counts[key] === 'number', `counts.${key} missing`)
  }
  assert.equal(PACKETS.counts.anchors, 1)
  assert.equal(PACKETS.counts.undated, 1)
  assert.equal(PACKETS.counts.anchorsWithSupport, 1)
})

console.log('\nthe pipeline integrates the projection')

check('the freshness downgrade is replaced by real classification', () => {
  // The old block capped relevance and set a chip using `lookbackMonths * 30 * 86400000`.
  // It was presentation-only and did not gate the news surface at all.
  const pipeline = read('../src/services/intelligenceService.js')
  assert.ok(
    !/windowStart = Date\.now\(\) - lookbackMonths \* 30 \* 86400000/.test(pipeline),
    'the ad-hoc freshness window is still being recomputed'
  )
  assert.match(pipeline, /buildEvidencePackets/, 'the pipeline never builds evidence packets')
})

const { applyEvidencePackets } = await import('../src/services/intelligenceService.js')

check('the pipeline keeps the full signal set beside the projections', () => {
  // state.analyze.signals is read by a dozen consumers and is the retained evidence set.
  // The projections are additive siblings, never a replacement.
  const state = { temporalPolicy: POLICY, analyze: { signals: [] } }
  const input = [ANCHOR, HISTORICAL, UNRELATED]
  applyEvidencePackets(state, input)

  assert.equal(state.analyze.signals.length, 3, 'signals must remain the complete set')
  assert.equal(state.analyze.currentSignals.length, 1, 'only the dated recent event is current')
  assert.equal(state.analyze.internalEvidence.length, 3)
  assert.ok(state.analyze.evidencePackets, 'packets are not exposed on the state')
  assert.equal(state.analyze.temporalCounts.historicalContext, 2)
})

check('classification uses the run policy rather than a fresh clock', () => {
  const state = { temporalPolicy: POLICY, analyze: { signals: [] } }
  applyEvidencePackets(state, [ANCHOR])
  assert.equal(state.analyze.evidencePackets.policy.current.startDate, '2026-03-19')
})

check('a run whose evidence is all historical reports zero anchors, not zero evidence', () => {
  const state = { temporalPolicy: POLICY, analyze: { signals: [] } }
  applyEvidencePackets(state, [HISTORICAL, UNRELATED])
  assert.equal(state.analyze.currentSignals.length, 0)
  assert.equal(state.analyze.signals.length, 2, 'the evidence is still there')
})

// ════════════════════════════════════════════════════════════════════════════
// SURFACES — what the founder actually sees
// ════════════════════════════════════════════════════════════════════════════

const { transformToStructuredSignals } = await import('../src/services/structuredSignalTransformer.js')
const { scoreAndFilterNews } = await import('../src/services/newsScorer.js')

const ENTITIES = [{ id: 'e1', name: 'RivalPay', category: 'competitor' }]
const EXPOSURE = { demand: 1, cost: 1, capital: 1, distribution: 1, regulation: 1, talent: 1 }

console.log('\nthe transformer preserves time')

check('event_date, published_date and temporal_role survive the transform', () => {
  // The transformer used to stamp `timestamp: new Date()` and drop the signal's date
  // entirely. That single line is why a 2024 article reached a news card dated today.
  const [out] = transformToStructuredSignals({
    geminiSignals: [{
      signal_headline: 'RivalPay cut fees', the_move: 'cut interchange', entity_involved: 'RivalPay',
      source_url: 'https://ex.com/a', event_date: '2026-07-11',
      published_date: '2026-07-12', temporal_role: 'anchor', date_confidence: 'high',
      supporting_evidence: [{ source_url: 'https://ex.com/old', label: 'Historical context' }],
    }],
    entities: ENTITIES,
  })
  assert.equal(out.event_date, '2026-07-11')
  assert.equal(out.published_date, '2026-07-12')
  assert.equal(out.temporal_role, 'anchor')
  assert.equal(out.date_confidence, 'high')
  assert.equal(out.supporting_evidence.length, 1)
})

check('timestamp stays ingestion time and retrieved_at is recorded beside it', () => {
  const [out] = transformToStructuredSignals({
    geminiSignals: [{ signal_headline: 'x', entity_involved: 'RivalPay', source_url: 'https://ex.com/a', event_date: '2026-07-11' }],
    entities: ENTITIES,
  })
  assert.ok(out.timestamp, 'timestamp is still set for compatibility')
  assert.ok(out.retrieved_at, 'retrieved_at must be recorded')
  assert.equal(out.event_date, '2026-07-11', 'the event date must not be overwritten by ingestion time')
  assert.notEqual(
    out.event_date, out.timestamp.slice(0, 10),
    'the event date and the ingestion date must be independently sourced'
  )
})

check('a signal with no event date does not get one invented', () => {
  const [out] = transformToStructuredSignals({
    geminiSignals: [{ signal_headline: 'x', entity_involved: 'RivalPay', source_url: 'https://ex.com/a' }],
    entities: ENTITIES,
  })
  assert.equal(out.event_date, null)
})

console.log('\ncurrent news carries anchors only')

const anchorSignal = {
  entity_name: 'RivalPay', domain: 'cost', event_type: 'pricing_change', magnitude_score: 9,
  source_type: 'primary', source_url: 'https://ex.com/new', raw_headline: 'RivalPay cut fees',
  event_date: '2026-07-11', temporal_role: 'anchor',
}
const contextSignal = { ...anchorSignal, source_url: 'https://ex.com/ctx', raw_headline: 'Sector report', event_date: '2025-11-01', temporal_role: 'supporting_context' }
const historicalSignal = { ...anchorSignal, source_url: 'https://ex.com/old', raw_headline: '2024 price rise', event_date: '2024-03-04', temporal_role: 'historical_context' }
const legacySignal = { ...anchorSignal, source_url: 'https://ex.com/legacy', raw_headline: 'Legacy row', event_date: null, temporal_role: null }

check('supporting and historical signals are excluded from current news', () => {
  const items = scoreAndFilterNews({
    signals: [anchorSignal, contextSignal, historicalSignal], entities: ENTITIES, exposureWeights: EXPOSURE,
  })
  const urls = items.map(i => i.source_url)
  assert.deepEqual(urls, ['https://ex.com/new'])
})

check('a legacy row with no temporal role does NOT present as current', () => {
  // Every stored signal predating v27 has temporal_role null. Treating unknown as
  // current would reintroduce the exact bug on the entire existing corpus.
  const items = scoreAndFilterNews({ signals: [legacySignal], entities: ENTITIES, exposureWeights: EXPOSURE })
  assert.equal(items.length, 0)
})

check('an anchor keeps its event date through scoring', () => {
  const [item] = scoreAndFilterNews({ signals: [anchorSignal], entities: ENTITIES, exposureWeights: EXPOSURE })
  assert.equal(item.event_date, '2026-07-11')
  assert.equal(item.temporal_role, 'anchor')
})

check('news items carry their anchor context forward', () => {
  const withContext = { ...anchorSignal, supporting_evidence: [{ source_url: 'https://ex.com/old', label: 'Historical context' }] }
  const [item] = scoreAndFilterNews({ signals: [withContext], entities: ENTITIES, exposureWeights: EXPOSURE })
  assert.equal(item.supporting_evidence.length, 1)
})

check('exposure scoring is unchanged for anchors', () => {
  // Restricting the input set must not quietly re-rank what remains.
  const [item] = scoreAndFilterNews({ signals: [anchorSignal], entities: ENTITIES, exposureWeights: EXPOSURE })
  assert.ok(item.exposure_relevance_score > 0)
})

check('historical evidence is filtered from NEWS, not from storage', () => {
  // scoreAndFilterNews decides one surface. It must not be mistaken for a delete.
  const scorerSrc = read('../src/services/newsScorer.js')
  assert.ok(!/delete |\.remove\(|DELETE FROM/i.test(scorerSrc), 'the scorer must never delete')
})

console.log('\nstepNews feeds the projection')

check('stepNews builds structured signals from the current projection', () => {
  const pipeline = read('../src/services/intelligenceService.js')
  const body = pipeline.slice(pipeline.indexOf('async function stepNews'), pipeline.indexOf('async function stepNews') + 3000)
  assert.match(body, /currentSignals/, 'stepNews still transforms every signal, not the anchors')
})

console.log('\nthe UI labels time')

const dashboard = read('../src/components/IntelligenceDashboard.jsx')

check('the signal card distinguishes current from historical context', () => {
  assert.match(dashboard, /temporal_role/, 'the card never reads temporal_role')
  assert.ok(
    dashboard.includes('Historical context') || dashboard.includes('Historical'),
    'no historical label in the card'
  )
})

check('supporting evidence renders as labelled context, not as another signal', () => {
  assert.match(dashboard, /supporting_evidence/)
})

check('a legacy signal with no temporal role renders without a fabricated date', () => {
  // Shared reports of existing briefs must keep working, with no invented "Current" chip.
  const start = dashboard.indexOf('const temporalChip')
  assert.notEqual(start, -1, 'the card defines no temporal band chip')
  const chip = dashboard.slice(start, start + 900)
  assert.match(
    chip, /temporalRole === 'anchor'\s*\n?\s*\?\s*\{ label: 'Current'/,
    'the Current label must be gated on an explicit anchor role, never on the absence of one'
  )
  // And the date rendered is the event date, with no fallback to a clock read.
  assert.match(dashboard, /const eventDate = signal\.event_date \|\| signal\.date \|\| null/)
  assert.ok(
    !/eventDate \|\| new Date\(\)/.test(dashboard),
    'the card must never fall back to today when a signal has no date'
  )
})

const workspace = read('../src/components/intelligence/ReportWorkspace.jsx')

check('current anchors lead a section, and legacy ordering is untouched', () => {
  assert.match(workspace, /temporal_role === 'anchor'/, 'the workspace does not order anchors first')
  // A stable partition, not a sort: a section where nothing (or everything) is an anchor
  // must come back in exactly its original order.
  assert.match(workspace, /anchors\.length === 0 \|\| anchors\.length === list\.length\) return list/)
  assert.match(workspace, /return \[\.\.\.anchors, \.\.\.list\.filter\(s => s\?\.temporal_role !== 'anchor'\)\]/)
})

check('both report surfaces render through the same card', () => {
  // The shared read-only path must show the same temporal semantics as the authenticated
  // one. It does so by construction — one SignalCard — and that is worth pinning, because
  // a second card implementation is how the two would drift.
  const viewer = read('../src/components/ReportViewer.jsx')
  assert.match(viewer, /import \{[^}]*SignalCard[^}]*\} from '\.\/IntelligenceDashboard'/)
})

check('every React hook used by the touched components is imported', () => {
  // A missing hook import is invisible to `vite build` and throws only when the component
  // mounts — which, for a report surface, means in front of the founder.
  for (const [name, src] of [['ReportWorkspace', workspace], ['IntelligenceDashboard', dashboard]]) {
    // The React import is not reliably the first line — IntelligenceDashboard.jsx opens
    // with a blank one. Find the statement rather than assuming its position.
    const importLine = (src.match(/import\s+React[^;]*from\s+'react';/) || [''])[0]
    assert.ok(importLine, `${name} has no React import to check`)
    const used = new Set([...src.matchAll(/\b(use[A-Z]\w+)\(/g)].map(m => m[1]))
    for (const hook of ['useMemo', 'useState', 'useEffect', 'useRef']) {
      if (used.has(hook)) {
        assert.ok(importLine.includes(hook), `${name} uses ${hook} without importing it`)
      }
    }
  }
})

// ════════════════════════════════════════════════════════════════════════════
// OBSERVABILITY — the run can say what it found, and what it did not
// ════════════════════════════════════════════════════════════════════════════

console.log('\ntelemetry the run reports')

const pipelineSrc = read('../src/services/intelligenceService.js')

check('the run records every temporal count', () => {
  const state = { temporalPolicy: POLICY, analyze: { signals: [] } }
  applyEvidencePackets(state, [ANCHOR, HISTORICAL, UNRELATED, { signal_headline: 'u', source_url: 'https://ex.com/u' }])
  const c = state.analyze.temporalCounts
  assert.equal(c.anchors, 1)
  // Undated evidence is counted on its own, not folded into supporting context. A run
  // that is mostly undated has a RETRIEVAL problem, not a judgement one, and the
  // disclosure needs to be able to say which.
  assert.equal(c.supportingContext, 0)
  assert.equal(c.historicalContext, 2)
  assert.equal(c.undated, 1)
  assert.equal(c.anchorsWithSupport, 1)
  assert.equal(c.total, 4, 'the total must equal what went in')
  assert.equal(
    c.anchors + c.supportingContext + c.historicalContext + c.undated, c.total,
    'the bands must be disjoint and exhaustive — evidence falling between them is evidence lost'
  )
})

check('provider fallback is tallied per retrieval window', () => {
  // A Tavily outage that hits only the context window is a different problem from one
  // that hits current events, and the old single {tavily, exa} tally could not tell
  // them apart — so "the brief looks thin" had no diagnosis attached.
  assert.match(pipelineSrc, /servedByWindow/, 'search never tallies provider use per window')
})

check('the current-news count is reported against the anchor count it came from', () => {
  const news = pipelineSrc.slice(pipelineSrc.indexOf('async function stepNews'))
  assert.match(news.slice(0, 3000), /counts\.anchors/, 'stepNews never reports its anchor base')
})

check('a run with no current evidence says so rather than going quiet', () => {
  assert.match(
    pipelineSrc, /No current event verified/i,
    'a run that verified nothing current must state it'
  )
})

check('the temporal disclosure never blocks the report', () => {
  // Advisory only, by design. This change must not add a new way for a run to fail to
  // publish — the founder gets a labelled brief, not no brief.
  const block = pipelineSrc.slice(pipelineSrc.indexOf('export function applyEvidencePackets'))
  const body = block.slice(0, block.indexOf('\n}\n'))
  assert.ok(!/throw /.test(body), 'classification must not throw')
  assert.ok(!/recordDegradation/.test(body), 'a temporal finding is not a degradation')
})

console.log('\ndocumentation')

check('the execution brief documents the temporal policy', () => {
  const doc = read('../docs/PROJECT_EXECUTION_BRIEF.md')
  for (const phrase of ['six-month', 'twelve-month', 'historical']) {
    assert.ok(doc.toLowerCase().includes(phrase), `docs never mention ${phrase}`)
  }
  assert.ok(
    /retrieved_at|ingestion time/i.test(doc),
    'docs must state that retrieval time is never an event date'
  )
  assert.ok(
    /not deleted|never deleted|no.{0,12}deletion|retained/i.test(doc),
    'docs must state the no-deletion guarantee'
  )
})

console.log('\nretention audit')

check('no module in this feature can delete historical evidence', () => {
  // The static equivalent of the rg audit, kept here so it runs on every change rather
  // than once at review time.
  for (const rel of [
    '../src/services/temporalPolicy.js',
    '../src/services/evidencePackets.js',
    '../scripts/migrations/v27_temporal_evidence.sql',
  ]) {
    // Comments are stripped first: this file's own prose explains that it truncates
    // nothing, and a prohibition that trips on its own documentation is noise.
    const src = read(rel)
      .split('\n')
      .filter(l => !l.trim().startsWith('--') && !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    for (const pattern of [/DELETE FROM/i, /TRUNCATE/i, /\.delete\(/, /\.remove\(/, /purge/i]) {
      assert.ok(!pattern.test(src), `${rel} matches ${pattern}`)
    }
  }
})

console.log(`\n${passed} checks passed`)
if (process.exitCode) console.error('FAILED')
