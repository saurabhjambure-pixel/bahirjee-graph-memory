/**
 * Observation source_type tests.
 *
 * This file exists because of a bug that cost two entire evidence classes and produced no
 * error anywhere. `observations.source_type` carries a CHECK constraint. v14 froze it at
 * ('tavily', 'firecrawl', 'exa'). v20 then shipped Source Watch ('source_watch') and the
 * connectors ('connector'), both of which write observations. Postgres rejected every one
 * of those rows with SQLSTATE 23514; storeObservations() counted the error and returned
 * normally; the stepped pipeline reads observations back FROM Postgres, so the analyze step
 * simply found nothing. Source Watch paid its full scrape latency every run and contributed
 * zero evidence to the brief.
 *
 * Nothing failed. The report was just quietly thinner. That is the worst failure shape this
 * codebase has, and it is only catchable by pinning code and schema against each other.
 *
 * Three rules:
 *   1. The migration's CHECK list and OBSERVATION_SOURCE_TYPES agree, exactly.
 *   2. Every source_type literal the code emits onto an observation is permitted.
 *   3. Rule 2 keeps working when a NEW file starts producing observations — the scan is
 *      over the whole tree with a documented exclusion list, not a hardcoded file list.
 *
 * Run: npm run test:observations
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { OBSERVATION_SOURCE_TYPES } from '../src/services/observationService.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MIGRATIONS = join(ROOT, 'scripts/migrations')

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

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Pull the permitted values out of the LATEST migration that constrains
 * observations.source_type. Ordering is by version number, not filename sort — v6 must not
 * beat v22, and lexical sort puts 'v6' after 'v22'.
 */
function permittedFromMigrations() {
  const files = readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.sql'))
    .map(f => ({ file: f, version: Number(/^v(\d+)/.exec(f)?.[1] ?? -1) }))
    .sort((a, b) => a.version - b.version)

  let latest = null
  for (const { file } of files) {
    // Strip `--` comments BEFORE matching. A prose comment inside the CHECK block that
    // happens to contain a ')' or an apostrophe otherwise truncates the value list and the
    // migration reads as "constrains nothing" — which silently falls back to an older file
    // and reports the wrong permitted set. (This test found that in its own first draft.)
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
      .split('\n')
      .map(line => line.replace(/--.*$/, ''))
      .join('\n')

    // Only CHECKs on the observations table. v21 constrains entity_sources.source_type,
    // which is a different column on a different table with its own vocabulary.
    if (!/observations/i.test(sql)) continue
    if (!/ALTER TABLE\s+public\.observations|CREATE TABLE[^;]*observations/is.test(sql)) continue
    const match = /CHECK\s*\(\s*source_type\s+IN\s*\(([^)]*)\)/is.exec(sql)
    if (!match) continue

    const values = [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1])
    if (values.length > 0) latest = { file, values }
  }
  assert.ok(latest, 'no migration constrains observations.source_type')
  return latest
}

/**
 * Every .js/.jsx file under the source roots, minus node_modules.
 *
 * Server code lives in `lib/` on `main` (behind the single `api/router.js` function) but
 * still in `api/` on branches that predate that refactor, so both are scanned and a missing
 * one is skipped rather than throwing. `src/` is required — if THAT is gone, the scan is
 * silently covering nothing and the assert below should fail loudly instead.
 */
function sourceFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.jsx?$/.test(entry)) out.push(full)
    }
  }
  const exists = (d) => { try { return statSync(d).isDirectory() } catch { return false } }

  const srcRoot = join(ROOT, 'src')
  assert.ok(exists(srcRoot), 'src/ not found — the source scan would cover nothing')
  walk(srcRoot)

  for (const optional of ['lib', 'api']) {
    const dir = join(ROOT, optional)
    if (exists(dir)) walk(dir)
  }
  assert.ok(out.length > 0, 'source scan found no files — the walk is broken')
  return out
}

/**
 * Files that write `source_type` to a table OTHER than observations. Every entry needs a
 * reason — this list is the only thing standing between "the scan is precise" and "the scan
 * was silenced until it went green".
 */
const NOT_OBSERVATIONS = new Map([
  ['src/services/primarySourceMapper.js',
    'entity_sources.source_type — pricing/changelog/careers/press/status/regulatory (v21)'],
  ['src/services/structuredSignalTransformer.js',
    'structured_signals.source_type — primary/secondary (v6 phase 3)'],
])

// ─── 1. migration and code agree ────────────────────────────────────────────

console.log('\nobservations.source_type')

const migration = permittedFromMigrations()

check('the latest migration and OBSERVATION_SOURCE_TYPES list the same values', () => {
  assert.deepEqual(
    [...migration.values].sort(),
    [...OBSERVATION_SOURCE_TYPES].sort(),
    `${migration.file} permits [${migration.values.join(', ')}] but the code declares `
    + `[${OBSERVATION_SOURCE_TYPES.join(', ')}]. Changing one without the other is the bug `
    + `this test exists to catch.`
  )
})

check('the values that regressed are permitted', () => {
  // Named explicitly so a future "tidy-up" that drops them fails loudly rather than
  // silently restoring the v20-v22 data loss.
  for (const t of ['source_watch', 'connector']) {
    assert.ok(
      OBSERVATION_SOURCE_TYPES.includes(t),
      `'${t}' must stay permitted — Source Watch and the connectors emit it`
    )
  }
})

// ─── 2. no code emits an unpermitted value ──────────────────────────────────

check('every source_type emitted onto an observation is permitted', () => {
  const permitted = new Set(OBSERVATION_SOURCE_TYPES)
  const offenders = []

  for (const file of sourceFiles()) {
    const rel = relative(ROOT, file)
    if (NOT_OBSERVATIONS.has(rel)) continue

    const src = readFileSync(file, 'utf8')
    // Literal assignments only. `source_type: sourceType` is a variable and cannot be
    // checked statically — those live in intelligenceService's searchQuery, where the
    // variable is assigned from the same literal set a few lines above.
    for (const m of src.matchAll(/source_type:\s*'([^']+)'/g)) {
      if (!permitted.has(m[1])) offenders.push(`${rel}: '${m[1]}'`)
    }
  }

  assert.deepEqual(
    offenders, [],
    `these write an observation source_type the database will reject:\n    `
    + offenders.join('\n    ')
    + `\n  Add the value to OBSERVATION_SOURCE_TYPES *and* to a new migration.`
  )
})

check('the exclusion list still describes files that exist', () => {
  // A stale exclusion silently un-scans a file that was renamed into an observation writer.
  for (const [rel] of NOT_OBSERVATIONS) {
    assert.doesNotThrow(
      () => statSync(join(ROOT, rel)),
      `${rel} is excluded from the scan but no longer exists — re-check the exclusion list`
    )
  }
})

// ─── 3. the write path rejects an unknown value before Postgres does ────────

check('OBSERVATION_SOURCE_TYPES is frozen', () => {
  // The set is a schema mirror, not a runtime knob. Mutating it at runtime would let a
  // caller "permit" a value the database still rejects.
  assert.ok(Object.isFrozen(OBSERVATION_SOURCE_TYPES))
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
