/**
 * Entity spine tests (v31_entity_spine.sql).
 *
 * tracked_entities is keyed on lowercased name (sql/context_signals_schema.sql). "Stripe",
 * "stripe.com" and "Stripe Inc" each open a separate row with its own occurrence_count in
 * brief_cards and its own entity_id in structured_signals — three parallel, non-joining
 * histories for the same competitor. v31 adds a canonical_domain identity and a lightweight
 * relationship graph, in Postgres.
 *
 * This file is the drift guard for the two places that failure shape has already bitten this
 * codebase (v25's category CHECK, v17's corroborating_urls): every relation value
 * generateEntityRelationships can write must be inside the migration's CHECK, and every
 * write path this session added must degrade — not fail the whole entity — when v31 has not
 * been applied yet.
 *
 * Run: npm run test:entity-spine
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { generateEntityRelationships } from '../src/services/entityWatchlistGenerator.js'
import { resolveDomain } from '../src/services/primarySourceMapper.js'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

const migration = read('./migrations/v31_entity_spine.sql')
const entityWatchlist = read('../src/services/entityWatchlistGenerator.js')
const primarySourceMapper = read('../src/services/primarySourceMapper.js')
const companyMemory = read('../src/services/companyMemoryService.js')
const intelligenceService = read('../src/services/intelligenceService.js')

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

/** Isolate one function's body by brace matching (same helper as context-reuse.test.mjs). */
function functionBody(source, name) {
  const start = source.search(new RegExp(`(export\\s+)?(async\\s+)?function\\s+${name}\\b`))
  assert.notEqual(start, -1, `${name} not found — this test is pinned to it`)
  const paramOpen = source.indexOf('(', start)
  let parens = 0
  let afterParams = -1
  for (let i = paramOpen; i < source.length; i++) {
    if (source[i] === '(') parens++
    else if (source[i] === ')' && --parens === 0) { afterParams = i + 1; break }
  }
  assert.notEqual(afterParams, -1, `unbalanced parens in ${name}`)
  const open = source.indexOf('{', afterParams)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}

// ─── 1. canonical_domain: nullable identity, not a forced one ──────────────

check('canonical_domain permits any number of NULLs per company', () => {
  const idx = migration.match(/CREATE UNIQUE INDEX IF NOT EXISTS uq_tracked_entities_company_domain\s*\nON public\.tracked_entities \(([^)]*)\)\s*\nWHERE ([^;]*);/)
  assert.ok(idx, 'uq_tracked_entities_company_domain not found in v28')
  assert.match(idx[1], /company_id/, 'must be scoped per company, like every other tracked_entities constraint')
  assert.match(idx[1], /canonical_domain/)
  assert.match(
    idx[2], /canonical_domain IS NOT NULL/,
    'without the partial WHERE, every entity with no resolvable domain (a regulator, an ' +
    'adjacent solution) would collide on the shared NULL the moment a company has two of them'
  )
})

check('only known/observed confidence ever reaches canonical_domain', () => {
  const body = functionBody(entityWatchlist, 'storeEntityWatchlist')
  assert.match(
    body, /UNVERIFIED_DOMAIN_CONFIDENCE\.has\(resolved\.confidence\)/,
    'a model_claimed or guessed domain must not anchor identity — getting this wrong merges ' +
    'two different companies under one row, which is worse than the dedup it would have bought'
  )
  // Drift guard: this file's own trust bar for "identity" must not silently diverge from
  // primarySourceMapper's trust bar for "worth a fetch" — same lesson as v25's category CHECK.
  const local = entityWatchlist.match(/const UNVERIFIED_DOMAIN_CONFIDENCE = new Set\(\[([^\]]*)\]\)/)
  const upstream = primarySourceMapper.match(/const UNVERIFIED_CONFIDENCE = new Set\(\[([^\]]*)\]\)/)
  assert.ok(local && upstream, 'one of the two confidence sets was not found — parser or code moved')
  assert.equal(local[1].trim(), upstream[1].trim(), 'the two trust bars must name the same tiers')
})

check('resolveDomain confidence tiers used by canonical_domain are exactly known/observed/model_claimed/guessed', () => {
  // Direct behavioural check, not just a source match: an entity with only a model-claimed
  // URL must resolve to a confidence in UNVERIFIED_DOMAIN_CONFIDENCE (excluded), and one
  // with a resolved_url must not.
  const claimed = resolveDomain({ name: 'X', category: 'competitor', metadata: { url: 'https://x-claimed.com' } })
  const observed = resolveDomain({ name: 'Y', category: 'competitor', metadata: { resolved_url: 'https://y-observed.com' } })
  assert.equal(claimed.confidence, 'model_claimed')
  assert.equal(observed.confidence, 'observed')
})

// ─── 2. relation vocabulary stays inside the CHECK (the v25 lesson, again) ─

check('every relation generateEntityRelationships can write is allowed by the CHECK', () => {
  const constraint = migration.match(/relation TEXT NOT NULL CHECK \(relation IN \(([^)]*)\)\)/s)
  assert.ok(constraint, 'entity_relationships relation CHECK not found in v28')
  const allowed = new Set([...constraint[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]))

  const written = new Set()
  const map = entityWatchlist.match(/const CATEGORY_TO_RELATION = \{([^}]*)\}/s)
  assert.ok(map, 'CATEGORY_TO_RELATION not found — this test is pinned to it')
  for (const m of map[1].matchAll(/:\s*'([a-z_]+)'/g)) written.add(m[1])
  // integrates_with is written conditionally (sub_category === 'integration'), not through
  // the map — the static scan above would miss it if this literal ever moved or was renamed.
  assert.match(entityWatchlist, /'integrates_with'/, 'integrates_with literal not found in generateEntityRelationships')
  written.add('integrates_with')

  const rejected = [...written].filter(r => !allowed.has(r))
  assert.deepEqual(
    rejected, [],
    `generateEntityRelationships can write relation='${rejected.join("', '")}' but the CHECK ` +
    `allows only [${[...allowed].sort().join(', ')}]. Postgres rejects the row and ` +
    `storeEntityRelationships counts it as an error — the exact v25 failure shape, applied ` +
    `to relationships instead of categories.`
  )
})

check('generateEntityRelationships never emits a relation the CHECK does not allow (behavioural)', () => {
  const constraint = migration.match(/relation TEXT NOT NULL CHECK \(relation IN \(([^)]*)\)\)/s)
  const allowed = new Set([...constraint[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]))
  const entities = [
    { name: 'A', category: 'competitor' }, { name: 'B', category: 'infra' },
    { name: 'C', category: 'platform' }, { name: 'D', category: 'regulator' },
    { name: 'E', category: 'customer' }, { name: 'F', category: 'investor' },
    { name: 'G', category: 'partner' }, { name: 'H', category: 'adjacent' },
    { name: 'I', category: 'industry_body' },
    { name: 'J', category: 'platform', metadata: { sub_category: 'integration' } },
  ]
  const relations = generateEntityRelationships(entities)
  assert.ok(relations.length > 0, 'fixture produced no relations — parser or generator moved')
  for (const r of relations) assert.ok(allowed.has(r.relation), `emitted disallowed relation '${r.relation}'`)
})

// ─── 3. every write path degrades on an unmigrated database ────────────────
//
// The same lesson as structuredSignalTransformer.js's corroborating_urls (v17): a NEW
// optional column must retry without it, not fail the whole call. Getting this wrong here
// is worse than usual — storeEntityWatchlist's canonical_domain write sits in the SAME
// upsert as name/category/metadata, so an unguarded failure would stop entities from being
// stored at all on any database that has not yet run v28, not just fail to gain the feature.

check('storeEntityWatchlist retries without canonical_domain on a database that has not run v28', () => {
  const body = functionBody(entityWatchlist, 'storeEntityWatchlist')
  assert.match(body, /PGRST204/, 'must detect the specific "column not found" error, not fail generically')
  assert.match(body, /canonical_domain/i)
  assert.match(
    body, /hasCanonicalDomain\s*=\s*false/,
    'must remember the column is missing and stop sending it for the rest of this call — ' +
    'retrying it on every single entity would double every failed upsert'
  )
})

check('storeEntityWatchlist upsert always includes canonical_domain when the column IS available', () => {
  const body = functionBody(entityWatchlist, 'storeEntityWatchlist')
  assert.match(
    body, /hasCanonicalDomain \? row : /,
    'the row sent must depend on whether the column is known available — a body that always ' +
    'strips it would silently stop writing canonical_domain even on a fully migrated database'
  )
})

check('persistReportMemory retries without brief_cards.entity_id on a database that has not run v28', () => {
  const body = functionBody(companyMemory, 'persistReportMemory')
  assert.match(body, /PGRST204/)
  assert.match(body, /entity_id/i)
  assert.match(body, /hasEntityId\s*=\s*false/)
})

// ─── 4. brief_cards.entity_id self-heals instead of staying null forever ───

check("a card's entity_id is taken fresh from the incoming card every run, never preserved from the existing row", () => {
  const body = functionBody(companyMemory, 'mergeExistingCard')
  assert.match(
    body, /entity_id:\s*incoming\.entity_id/,
    'a card first seen before its entity had a tracked_entities row (entity_id: null) must ' +
    'pick up the real id the moment fetchEntityIdsByName can resolve it — preserving ' +
    'existing.entity_id would leave it null forever'
  )
  assert.ok(
    !/entity_id:\s*existing\??\.entity_id/.test(body),
    'must not fall back to the stale existing entity_id ahead of the fresh one'
  )
})

// ─── 5. RLS mirrors every other tenant-scoped table ─────────────────────────

check('entity_relationships RLS is scoped by company_id, with an admin override, like every sibling table', () => {
  const start = migration.indexOf('CREATE TABLE IF NOT EXISTS public.entity_relationships')
  assert.notEqual(start, -1)
  const section = migration.slice(start)
  assert.match(section, /ALTER TABLE public\.entity_relationships ENABLE ROW LEVEL SECURITY/)
  assert.match(
    section, /company_id IN \(SELECT client_id FROM public\.profiles WHERE id = auth\.uid\(\)\)/,
    'tenant policy must scope by company_id, the same join every other entity-adjacent table uses'
  )
  assert.match(section, /public\.is_admin\(\)/, 'admin override must exist, like every other table')
})

// ─── 6. actually wired in, not wired-but-off ────────────────────────────────

check('generateEntityRelationships and storeEntityRelationships are called from stepPersist', () => {
  assert.match(
    intelligenceService, /generateEntityRelationships\(/,
    'v28 adding relationship derivation nobody calls is exactly the state this migration exists to end'
  )
  assert.match(intelligenceService, /storeEntityRelationships\(/)
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
