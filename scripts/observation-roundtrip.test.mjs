/**
 * Observation round-trip tests.
 *
 * This file exists because of a bug in the same family as the one
 * observation-source-types.test.mjs was written for, and with the same shape: nothing
 * failed, the report was just quietly worse.
 *
 * `getObservationsForRun` reads a run's observations back from Postgres — the stepped
 * pipeline does not carry them through `step_outputs`, so the analyze step reads through
 * this function and nothing else. Its `.select()` listed eight columns and its row mapper
 * emitted nine fields. The missing one was `source_class`.
 *
 * Consequence: observations were written to the database WITH their provenance, read back
 * WITHOUT it, and `attachSourceClass` — which needs at least one classified observation to
 * build its lookup — found an empty map and returned early on every batch. A live run
 * produced 90 signals, all of them grounded, and not one carrying a source class. The
 * founder-facing brief printed "0 kinds of source." The verifier's source-class diversity
 * gate had never fired for anyone. The data was in Postgres the whole time.
 *
 * The invariant that catches this: EVERY column the mapper reads off a row must appear in
 * the select list that produced that row. A field the pipeline consumes cannot be one the
 * query never asked for.
 *
 * Run: npm run test:observation-roundtrip
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SERVICE = fileURLToPath(new URL('../src/services/observationService.js', import.meta.url))
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

// ─── helpers ────────────────────────────────────────────────────────────────

/** Isolate one exported function's body by brace matching from its declaration. */
function functionBody(name) {
  const start = source.indexOf(`export async function ${name}`)
  assert.notEqual(start, -1, `${name} not found — this test is pinned to it`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  throw new Error(`unbalanced braces in ${name}`)
}

/**
 * Every column name the function can ask Postgres for.
 *
 * Covers both the literal `.select('a, b')` form and the `const X_COLUMNS = 'a, b'`
 * + template-literal form, because the fix for the original bug introduced the second
 * one (a fallback select for databases that predate v20).
 */
function selectedColumns(body) {
  const columns = new Set()
  const collect = (literal) => {
    for (const col of literal.split(',')) {
      const name = col.trim()
      if (name && /^[a-z_][a-z0-9_]*$/i.test(name)) columns.add(name)
    }
  }
  // A literal passed straight to .select().
  for (const m of body.matchAll(/\.select\(\s*['"]([^'"]*)['"]/g)) collect(m[1])
  // A named column-list constant.
  for (const m of body.matchAll(/const\s+[A-Z_]*COLUMNS[A-Z_]*\s*=\s*['"]([^'"]*)['"]/g)) collect(m[1])
  // A template literal composing a list from one of the above. Interpolations are dropped
  // because the constants they name are collected in their own right; what matters here
  // are the extra columns appended alongside them.
  for (const m of body.matchAll(/`([^`]*)`/g)) collect(m[1].replace(/\$\{[^}]*\}/g, ''))
  return columns
}

/** Every column the mapper reads off a returned row. */
function mappedColumns(body) {
  return new Set([...body.matchAll(/\brow\.([a-z_][a-z0-9_]*)/gi)].map(m => m[1]))
}

// ─── 1. the invariant ───────────────────────────────────────────────────────

const body = functionBody('getObservationsForRun')
const selected = selectedColumns(body)
const mapped = mappedColumns(body)

check('every column the mapper reads is selected', () => {
  assert.ok(mapped.size > 0, 'found no row.* reads — the parser is broken, not the code')
  const missing = [...mapped].filter(c => !selected.has(c))
  assert.deepEqual(
    missing, [],
    `getObservationsForRun maps ${missing.join(', ')} but never selects ${missing.length === 1 ? 'it' : 'them'}. ` +
    `A column absent from the select arrives undefined on every row, silently. ` +
    `Selected: [${[...selected].sort().join(', ')}]`
  )
})

// ─── 2. the specific field that was lost ────────────────────────────────────

check('source_class survives the round trip', () => {
  assert.ok(selected.has('source_class'), 'source_class must be requested from Postgres')
  assert.ok(mapped.has('source_class'), 'source_class must be mapped onto the in-memory observation')
})

check('the write path stores source_class', () => {
  // Read and write must agree about the field's existence, or the round trip is broken at
  // the other end and this test would still pass.
  assert.match(
    source, /source_class:\s*result\.source_class/,
    'storeObservations must persist source_class for getObservationsForRun to read back'
  )
})

// ─── 3. the read degrades the same way the write does ───────────────────────

check('a database without v20 loses the label, not the evidence', () => {
  // storeObservations already retries without source_class when the column is absent.
  // The read must do the same: PostgREST answers an unknown column with an error and no
  // rows, so an unguarded select would return ZERO observations on a pre-v20 database —
  // turning a missing label into a missing report. Losing provenance is survivable;
  // losing the evidence is not.
  assert.match(body, /42703/, 'the read path must handle an undefined-column error')
  assert.ok(
    /sourceClassColumnAvailable/.test(body),
    'the read path must share the write path\'s column-availability flag'
  )
  const fallback = body.slice(body.indexOf('42703'))
  assert.ok(
    /run\(\s*BASE_COLUMNS\s*\)/.test(fallback),
    'the fallback must re-run the query without source_class rather than returning []'
  )
})

// ─── 4. the analyze step still reads through this function ──────────────────

check('the pipeline still reads observations through getObservationsForRun', () => {
  // If the analyze step ever stops going through here, this test guards nothing and
  // should be repointed rather than left passing vacuously.
  const pipeline = readFileSync(
    fileURLToPath(new URL('../src/services/intelligenceService.js', import.meta.url)), 'utf8'
  )
  assert.match(
    pipeline, /getObservationsForRun\s*\(/,
    'intelligenceService no longer calls getObservationsForRun — repoint this test'
  )
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
