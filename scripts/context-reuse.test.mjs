/**
 * Company-context reuse round-trip tests.
 *
 * This file exists because company_contexts has the exact shape that has cost this
 * codebase real evidence twice already: a table with more than one writer, a row mapper,
 * and a CHECK constraint that the code can outgrow — where every failure mode is silent.
 *
 *   • observation-roundtrip: a column missing from a `.select()` read back as undefined,
 *     and `attachSourceClass` returned early on every batch for months.
 *   • v25_entity_categories: a CHECK frozen at five values while the code emitted eight;
 *     Postgres rejected every row and `storeEntityWatchlist` counted the error and
 *     returned normally, so uploaded decks contributed nothing to the watchlist.
 *
 * Both produced a working product and a quietly worse report. The invariants below are
 * the two that would have caught them, applied before the same thing happens a third time:
 *
 *   1. Every column the row mapper reads must appear in the select list.
 *   2. Every `source:` literal the code can write must appear in the CHECK constraint.
 *   3. `is_current` is written from exactly one path — the RPC — because two writers
 *      racing on a partial unique index is a 500 in the founder's face.
 *   4. hydrateStoredContext strips what must not be replayed and keeps what reuse is for.
 *
 * Run: npm run test:context-reuse
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

const service = read('../src/services/companyContextService.js')
const migration = read('./migrations/v26_company_contexts.sql')
// The CURRENT definition of set_current_company_context_service. v30 created it; v38
// replaced it (target-scoped, + p_target_id). Point this at whichever migration last
// defines it, or the signature check below compares the code against a dead function.
const serviceWriteMigration = read('./migrations/v38_service_context_write_targets.sql')

/** Every JS/JSX file that could possibly write to company_contexts. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(js|jsx|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE_FILES = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'lib'))]

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
 * Isolate one function's body by brace matching.
 *
 * Skips the parameter list first: saveCompanyContext destructures its argument, so the
 * first `{` after the declaration opens the PARAMETER pattern, not the body. Matching
 * from there returns the destructuring and every assertion over it passes vacuously.
 */
function functionBody(source, name) {
  const start = source.search(new RegExp(`(export\\s+)?(async\\s+)?function\\s+${name}\\b`))
  assert.notEqual(start, -1, `${name} not found — this test is pinned to it`)

  // Walk the parameter list to its matching ')'.
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

/**
 * Single-quoted string literals in a chunk of source, with line comments removed first.
 *
 * A prose apostrophe in a comment ("this run's entities") otherwise opens a quote that
 * closes on the next real string literal, swallowing whichever entry follows it — which
 * is precisely how this test first reported _startupContext as missing when it was there.
 */
function quotedStrings(chunk) {
  const withoutComments = chunk.replace(/\/\/[^\n]*/g, '')
  return new Set([...withoutComments.matchAll(/'([^']+)'/g)].map(m => m[1]))
}

/**
 * Column names declared by company_contexts' CREATE TABLE, plus any ALTER TABLE ADD
 * COLUMN — v26's own, and every later migration's. v37 widens company_contexts with
 * target_id in a DIFFERENT file (scripts/migrations/v37_intelligence_targets.sql); a
 * COLUMNS set built from v26 alone would reject that column forever, which is the same
 * staleness latestDefinitionOf() below exists to avoid for the RPC signature.
 */
function migrationColumns() {
  const start = migration.indexOf('CREATE TABLE IF NOT EXISTS public.company_contexts')
  assert.notEqual(start, -1, 'company_contexts CREATE TABLE not found')
  const open = migration.indexOf('(', start)
  let depth = 0
  let body = ''
  for (let i = open; i < migration.length; i++) {
    if (migration[i] === '(') depth++
    else if (migration[i] === ')' && --depth === 0) { body = migration.slice(open + 1, i); break }
  }
  const columns = new Set()
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('--')) continue
    const m = trimmed.match(/^([a-z_][a-z0-9_]*)\s+[A-Z]/)
    if (m) columns.add(m[1])
  }

  const dir = fileURLToPath(new URL('./migrations/', import.meta.url))
  for (const file of readdirSync(dir)) {
    if (!/^v(\d+)_.*\.sql$/.test(file)) continue
    const text = readFileSync(join(dir, file), 'utf8')
    // Scope to statements that alter company_contexts specifically, not every table a
    // later migration happens to touch (v31 also widens reports and intelligence_jobs).
    // The lazy [\s\S]{0,80}? must not be allowed to run past the end of THIS statement —
    // otherwise a short statement sitting between an `ALTER TABLE public.company_contexts`
    // and a DIFFERENT table's `ADD COLUMN` (e.g. a DROP CONSTRAINT) can let that other
    // table's column get misattributed as company_contexts', loosening exactly the guard
    // this function exists to provide. Stop the match at the statement terminator (`;`)
    // or the start of the next `ALTER TABLE`, whichever comes first.
    for (const m of text.matchAll(/ALTER TABLE public\.company_contexts(?:(?!;|ALTER TABLE)[\s\S]){0,80}?ADD COLUMN IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/gi)) {
      columns.add(m[1].toLowerCase())
    }
  }
  return columns
}

const COLUMNS = migrationColumns()

/**
 * The migration file with the highest v-number that (re)defines a given function.
 *
 * set_current_company_context is redefined in v31 with a 7th parameter, in a
 * different file. A test that always reads v26 checks a SUPERSEDED definition
 * forever — which is exactly how v31 silently dropping SECURITY DEFINER went
 * undetected by a suite specifically built to catch it. Scan every migration under
 * scripts/migrations/ for a `CREATE OR REPLACE FUNCTION public.<name>` and take the
 * one with the highest v-number, so whichever migration is actually live gets checked.
 * Matched with the opening paren: `set_current_company_context` is a prefix of
 * `set_current_company_context_service`, and v38 defines both — service first.
 */
function latestDefinitionOf(fnName) {
  const dir = fileURLToPath(new URL('./migrations/', import.meta.url))
  const candidates = readdirSync(dir)
    .filter((f) => /^v(\d+)_.*\.sql$/.test(f))
    .filter((f) => readFileSync(join(dir, f), 'utf8').includes(`CREATE OR REPLACE FUNCTION public.${fnName}(`))
  assert.ok(candidates.length > 0, `no migration under scripts/migrations/ defines public.${fnName}`)
  candidates.sort((a, b) => Number(a.match(/^v(\d+)/)[1]) - Number(b.match(/^v(\d+)/)[1]))
  const file = candidates[candidates.length - 1]
  return { file, source: readFileSync(join(dir, file), 'utf8') }
}

const LATEST_SET_CURRENT_CONTEXT_RPC = latestDefinitionOf('set_current_company_context')

/**
 * Same staleness hazard as latestDefinitionOf above, for a named CHECK constraint
 * instead of a function: v31 widens company_contexts_source_check to add 'inherited'
 * via DROP CONSTRAINT + ADD CONSTRAINT, in a different file from the one that first
 * created it. A test hardcoded to v26 would check a superseded constraint forever —
 * passing today only because nothing had yet written source='inherited', and about to
 * fail permanently the moment something did, even though the migration already allows
 * it. Scan every migration under scripts/migrations/ for an ADD CONSTRAINT of this
 * name and take the one with the highest v-number.
 */
function latestConstraintDefinitionOf(constraintName) {
  const dir = fileURLToPath(new URL('./migrations/', import.meta.url))
  const candidates = readdirSync(dir)
    .filter((f) => /^v(\d+)_.*\.sql$/.test(f))
    .filter((f) => readFileSync(join(dir, f), 'utf8').includes(`ADD CONSTRAINT ${constraintName}`))
  assert.ok(candidates.length > 0, `no migration under scripts/migrations/ adds constraint ${constraintName}`)
  candidates.sort((a, b) => Number(a.match(/^v(\d+)/)[1]) - Number(b.match(/^v(\d+)/)[1]))
  const file = candidates[candidates.length - 1]
  return { file, source: readFileSync(join(dir, file), 'utf8') }
}

const LATEST_SOURCE_CHECK = latestConstraintDefinitionOf('company_contexts_source_check')

// ─── 1. the read round trip ─────────────────────────────────────────────────

check('every column the row mapper reads is selected', () => {
  const mapper = functionBody(service, 'readContextRow')
  const mapped = new Set([...mapper.matchAll(/\brow\.([a-z_][a-z0-9_]*)/gi)].map(m => m[1]))
  assert.ok(mapped.size > 0, 'found no row.* reads — the parser is broken, not the code')

  const selectList = service.match(/const CONTEXT_COLUMNS\s*=\s*'([^']*)'/)
  assert.ok(selectList, 'CONTEXT_COLUMNS constant not found')
  const selected = new Set(selectList[1].split(',').map(c => c.trim()).filter(Boolean))

  const missing = [...mapped].filter(c => !selected.has(c))
  assert.deepEqual(
    missing, [],
    `readContextRow maps ${missing.join(', ')} but CONTEXT_COLUMNS never selects ` +
    `${missing.length === 1 ? 'it' : 'them'}. A column absent from the select arrives ` +
    `undefined on every row, silently. Selected: [${[...selected].sort().join(', ')}]`
  )
})

check('every selected column exists in the migration', () => {
  const selected = service.match(/const CONTEXT_COLUMNS\s*=\s*'([^']*)'/)[1]
    .split(',').map(c => c.trim()).filter(Boolean)
  const missing = selected.filter(c => !COLUMNS.has(c))
  assert.deepEqual(
    missing, [],
    `CONTEXT_COLUMNS asks Postgres for ${missing.join(', ')}, which v26 never creates. ` +
    `PostgREST answers an unknown column with an error and NO rows — so this would not ` +
    `degrade the context, it would lose it entirely. Columns: [${[...COLUMNS].sort().join(', ')}]`
  )
})

// ─── 2. the write round trip ────────────────────────────────────────────────

check('every RPC argument maps to a real column', () => {
  const writer = functionBody(service, 'saveCompanyContext')
  const args = [...writer.matchAll(/\bp_([a-z_][a-z0-9_]*)\s*:/g)].map(m => m[1])
  assert.ok(args.length > 0, 'saveCompanyContext passes no p_* arguments — parser broken')

  const missing = args.filter(a => !COLUMNS.has(a))
  assert.deepEqual(
    missing, [],
    `saveCompanyContext sends p_${missing.join(', p_')} but v26 has no such column`
  )
})

check('the RPC signature accepts exactly what the writer sends', () => {
  // Checked against the LATEST definition of the function (v31 redefines it with a 7th
  // parameter in a different file) — not hardcoded to v26, which would keep passing
  // forever even if a later migration stopped declaring an argument saveCompanyContext
  // still sends. See latestDefinitionOf() above.
  const { file, source } = LATEST_SET_CURRENT_CONTEXT_RPC
  const writer = functionBody(service, 'saveCompanyContext')
  const sent = new Set([...writer.matchAll(/\b(p_[a-z_][a-z0-9_]*)\s*:/g)].map(m => m[1]))

  const sigStart = source.indexOf('CREATE OR REPLACE FUNCTION public.set_current_company_context(')
  assert.notEqual(sigStart, -1, `set_current_company_context not found in ${file}`)
  const sig = source.slice(sigStart, source.indexOf('RETURNS', sigStart))
  const declared = new Set([...sig.matchAll(/\b(p_[a-z_][a-z0-9_]*)\s+[A-Z]/g)].map(m => m[1]))
  assert.ok(sent.size > 0 && declared.size > 0, 'parsed no arguments on one side — parser broken')

  const unknown = [...sent].filter(a => !declared.has(a))
  assert.deepEqual(
    unknown, [],
    `saveCompanyContext sends ${unknown.join(', ')}, which the RPC (checked against ` +
    `${file}) does not declare. PostgREST resolves RPCs by argument name — a mismatch ` +
    `is a 404 at runtime, and saveCompanyContext swallows it, so the next run silently ` +
    `rebuilds. Declared: [${[...declared].sort().join(', ')}]`
  )
})

// ─── 3. the CHECK constraint keeps up with the code (the v25 lesson) ────────

check('every source value the code writes is allowed by the CHECK', () => {
  // Checked against the LATEST definition of the constraint (v31 widens it to add
  // 'inherited', in a different file) — not hardcoded to v26. See
  // latestConstraintDefinitionOf() above.
  const { file, source } = LATEST_SOURCE_CHECK
  const constraint = source.match(/company_contexts_source_check[\s\S]{0,200}?CHECK \(source IN \(([^)]*)\)\)/)
  assert.ok(constraint, `company_contexts_source_check not found in ${file}`)
  const allowed = new Set(
    [...constraint[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1])
  )

  // Every literal passed as a `source` to saveCompanyContext anywhere in src/ or lib/.
  const written = new Set()
  for (const file of SOURCE_FILES) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/saveCompanyContext\(\{[^}]*?source:\s*'([a-z_]+)'/gs)) {
      written.add(m[1])
    }
    for (const m of text.matchAll(/source\s*=\s*'([a-z_]+)'\s*,\s*builtFrom/g)) written.add(m[1])
  }

  assert.ok(
    written.size > 0,
    'found no saveCompanyContext source literals — either nothing writes contexts yet ' +
    'or the scan is broken; either way this check is guarding nothing'
  )
  const rejected = [...written].filter(s => !allowed.has(s))
  assert.deepEqual(
    rejected, [],
    `the code writes source='${rejected.join("', '")}' but the CHECK allows only ` +
    `[${[...allowed].sort().join(', ')}]. This is the v25 failure exactly: Postgres ` +
    `rejects the row, saveCompanyContext logs a warning and returns null, the run ` +
    `succeeds, and the context is never stored. Add the value to the migration.`
  )
})

// ─── 4. one writer for is_current ───────────────────────────────────────────

check('is_current is only ever written by the RPC', () => {
  const offenders = []
  for (const file of SOURCE_FILES) {
    const text = readFileSync(file, 'utf8')
    if (/\.(update|insert|upsert)\(\s*\{[^}]*is_current/s.test(text)) offenders.push(file)
  }
  assert.deepEqual(
    offenders.map(f => f.split('/').pop()), [],
    'is_current must be flipped only inside set_current_company_context. Demoting the ' +
    'old row and inserting the new one in two client statements races on ' +
    'uq_company_contexts_current, and the loser gets a constraint violation mid-confirm.'
  )
})

check('the RPC demotes before it inserts', () => {
  // Checked against the LATEST definition of the function (v31 redefines it with a 7th
  // parameter in a different file) — not hardcoded to v26, which would keep passing
  // forever even if a later migration reordered the demote/insert and reintroduced the
  // race this check exists to catch. See latestDefinitionOf() above.
  const { file, source } = LATEST_SET_CURRENT_CONTEXT_RPC
  const fn = source.slice(source.indexOf('CREATE OR REPLACE FUNCTION public.set_current_company_context('))
  const demote = fn.indexOf('SET is_current = FALSE')
  const insert = fn.indexOf('INSERT INTO public.company_contexts')
  assert.ok(demote > -1, `the RPC (checked against ${file}) never demotes the previous current row`)
  assert.ok(insert > -1, `the RPC (checked against ${file}) never inserts`)
  assert.ok(
    demote < insert,
    `the RPC (checked against ${file}) inserts the new current row before demoting the ` +
    'old one — that violates uq_company_contexts_current within the transaction'
  )
})

check('the RPC enforces tenancy itself', () => {
  // Checked against the LATEST definition of the function (v31 redefines it with a 7th
  // parameter in a different file) — not hardcoded to v26, which would keep passing
  // forever even if a later migration silently dropped SECURITY DEFINER. See
  // latestDefinitionOf() above.
  const { file, source } = LATEST_SET_CURRENT_CONTEXT_RPC
  const fn = source.slice(source.indexOf('CREATE OR REPLACE FUNCTION public.set_current_company_context('))

  assert.match(
    fn, /SECURITY DEFINER/,
    `the RPC must be SECURITY DEFINER to bypass RLS atomically (checked against ${file}, ` +
    'the latest definition of set_current_company_context)'
  )

  // The tenancy guard's exact phrasing has legitimately differed between migrations
  // (v26 vs v31), so this asserts the SEMANTIC invariant rather than one literal
  // string: the guard clause (everything before its RAISE EXCEPTION) must reference
  // an admin bypass, the caller's identity, and the tenant column together — not just
  // that all three tokens appear ANYWHERE in the function body.
  const guardEnd = fn.search(/RAISE EXCEPTION 'not authoris/i)
  assert.notEqual(
    guardEnd, -1,
    `no tenancy guard found in ${file} — expected a RAISE EXCEPTION 'not authoris...' guard`
  )
  const guard = fn.slice(0, guardEnd)
  for (const [token, why] of [
    [/public\.is_admin\(\)/, 'an admin bypass (public.is_admin())'],
    [/auth\.uid\(\)/, "the caller's identity (auth.uid())"],
    [/client_id/, 'the tenant column (client_id)'],
  ]) {
    assert.match(
      guard, token,
      `a SECURITY DEFINER function bypasses RLS, so its tenancy guard must check ` +
      `${why} before raising — otherwise any authenticated user can overwrite any ` +
      `tenant's context (checked against ${file})`
    )
  }
})

// ─── 5. hydrateStoredContext: what is replayed and what is not ──────────────

check('_decision never survives reuse', () => {
  const list = service.match(/const RUN_SCOPED_KEYS = \[([^\]]*)\]/s)
  assert.ok(list, 'RUN_SCOPED_KEYS not found')
  const stripped = quotedStrings(list[1])

  assert.ok(
    stripped.has('_decision'),
    'handleCreateJob reads contextData._decision (lib/handlers/intelligence.js). A stored ' +
    'decision frame replayed on a plain company run would fabricate a decision brief ' +
    'nobody asked for.'
  )
  for (const key of ['_startupContext', '_trackedEntities', '_primarySources', '_signalWeights']) {
    assert.ok(
      stripped.has(key),
      `${key} must be re-derived at confirm — replaying it files this run's entities ` +
      `under the previous context_version_id, with no error anywhere`
    )
  }
  for (const key of ['_companyMemory', '_memorySeed', '_founderNotes']) {
    assert.ok(stripped.has(key), `${key} is rewritten per run by stepMemory and must not be replayed`)
  }
})

check('the reusable payload is kept', () => {
  const list = service.match(/const RUN_SCOPED_KEYS = \[([^\]]*)\]/s)
  const stripped = quotedStrings(list[1])
  const reusable = service.match(/export const REUSABLE_KEYS = \[([^\]]*)\]/s)
  assert.ok(reusable, 'REUSABLE_KEYS not found')

  const keep = quotedStrings(reusable[1])
  assert.ok(keep.size > 0, 'REUSABLE_KEYS parsed empty — the parser is broken, not the code')
  for (const key of keep) {
    assert.ok(
      !stripped.has(key),
      `${key} is listed as reusable AND stripped. Reuse exists to carry the founder's ` +
      `corrections and their documents forward; stripping them makes it pointless.`
    )
  }

  // Named explicitly, not just covered by the loop above: stripping this on reuse would
  // reset every fact's staleness clock to "just built" on every single run, silently
  // undoing the entire point of the provenance ledger (v27 follow-up).
  assert.ok(
    keep.has('_factProvenance'),
    '_factProvenance must be reusable — it is the record of when each fact was last ' +
    'actually confirmed, not run-scoped state'
  )
})

check('hydrateStoredContext does not mutate its argument', () => {
  const body = functionBody(service, 'hydrateStoredContext')
  assert.match(
    body, /\{\s*\.\.\.storedContext\s*\}/,
    'hydrateStoredContext must clone before deleting — the caller holds the same object ' +
    'as React state, and deleting through it would wipe the review screen mid-render'
  )
})

// ─── 6. the hash is stable and is not the page hasher ───────────────────────

check('the context hash is order-independent', () => {
  const body = functionBody(service, 'stableStringify')
  assert.match(
    body, /Object\.keys\(value\)\.sort\(\)/,
    'stableStringify must sort keys, or the same context re-serialized in a different ' +
    'order hashes differently and every confirm mints a spurious version'
  )
})

check('the context hash is not sourceWatch.hashContent', () => {
  assert.ok(
    !/from '\.\/sourceWatch/.test(service),
    'sourceWatch.hashContent normalizes page furniture: it strips dates and 16+ char ' +
    'hex runs and lowercases everything. Applied to a context it would collapse two ' +
    'genuinely different companies whose only difference was a slug or a funding date.'
  )
  assert.match(service, /crypto\.subtle\.digest\('SHA-256'/, 'hashContext must actually hash')
})

// ─── 7. the fallback that makes this work on day one ────────────────────────

check('a company with no stored row falls back to its last brief', () => {
  const body = functionBody(service, 'getCurrentCompanyContext')
  assert.match(
    body, /getLastReportForUrl/,
    'without the fallback, every existing company (Paynearby, CareMother) would rebuild ' +
    'from scratch until someone happened to confirm a run — the feature would appear to ' +
    'do nothing for exactly the users it was built for'
  )
  assert.match(body, /report_fallback/, 'the fallback must label its origin so the UI can be honest about it')
  assert.match(
    body, /42P01/,
    'a database without v26 applied must fall through to the report, not throw — the ' +
    'migration window is the moment this code is most likely to be running unmigrated'
  )
})

check('the lookup is keyed on domain, not client alone', () => {
  const body = functionBody(service, 'getCurrentCompanyContext')
  assert.match(body, /extractTargetDomain/, 'the match key is the normalized domain')
  assert.match(body, /\.eq\('target_domain'/, 'the query must filter on target_domain')
  assert.match(body, /\.eq\('client_id'/, 'the query must stay tenant-scoped')
})

// ─── 8. the server-write path (v27) ──────────────────────────────────────────
//
// set_current_company_context (v26) authorises through auth.uid(), which is null for
// every server-driven run — the stepped worker, the weekly cron, an admin re-run with
// no browser session at confirm time. Those runs could read company_contexts but never
// write it. v27 adds a sibling RPC that trusts its caller by ROLE (service_role only,
// via REVOKE) instead of by auth.uid() — a different trust boundary, so it needs its
// own tenancy check here: not "does the RPC verify auth.uid()" but "is the RPC actually
// unreachable by the roles a browser session can hold."

check('the server RPC has no grant reachable from a browser session', () => {
  const fn = serviceWriteMigration.slice(
    serviceWriteMigration.indexOf('CREATE OR REPLACE FUNCTION public.set_current_company_context_service')
  )
  assert.match(fn, /SECURITY DEFINER/, 'the RPC must be SECURITY DEFINER to bypass RLS atomically')
  for (const role of ['public', 'authenticated', 'anon']) {
    assert.match(
      serviceWriteMigration,
      new RegExp(`REVOKE ALL ON FUNCTION public\\.set_current_company_context_service[^;]*FROM ${role};`),
      `no REVOKE FROM ${role} — without it, this function skips v26's auth.uid() check ` +
      `entirely and would let any ${role === 'public' ? 'caller' : role} overwrite any tenant's context`
    )
  }
})

check('every server-RPC argument maps to a real column or is attribution-only', () => {
  const writer = functionBody(service, 'saveCompanyContextFromServer')
  const args = [...writer.matchAll(/\bp_([a-z_][a-z0-9_]*)\s*:/g)].map(m => m[1])
  assert.ok(args.length > 0, 'saveCompanyContextFromServer passes no p_* arguments — parser broken')

  // created_by is a real column (v26); it just isn't sourced from auth.uid() here.
  const missing = args.filter(a => !COLUMNS.has(a) && a !== 'created_by')
  assert.deepEqual(
    missing, [],
    `saveCompanyContextFromServer sends p_${missing.join(', p_')} but company_contexts has no such column`
  )
})

check('the server RPC signature accepts exactly what saveCompanyContextFromServer sends', () => {
  const writer = functionBody(service, 'saveCompanyContextFromServer')
  const sent = new Set([...writer.matchAll(/\b(p_[a-z_][a-z0-9_]*)\s*:/g)].map(m => m[1]))

  const sigStart = serviceWriteMigration.indexOf('CREATE OR REPLACE FUNCTION public.set_current_company_context_service')
  assert.notEqual(sigStart, -1, 'set_current_company_context_service not found in v27')
  const sig = serviceWriteMigration.slice(sigStart, serviceWriteMigration.indexOf('RETURNS', sigStart))
  const declared = new Set([...sig.matchAll(/\b(p_[a-z_][a-z0-9_]*)\s+[A-Z]/g)].map(m => m[1]))
  assert.ok(sent.size > 0 && declared.size > 0, 'parsed no arguments on one side — parser broken')

  const unknown = [...sent].filter(a => !declared.has(a))
  assert.deepEqual(
    unknown, [],
    `saveCompanyContextFromServer sends ${unknown.join(', ')}, which the RPC does not declare. ` +
    `PostgREST resolves RPCs by argument name — a mismatch is a 404 at runtime, and ` +
    `saveCompanyContextFromServer swallows it, so a server-driven run silently keeps not writing. ` +
    `Declared: [${[...declared].sort().join(', ')}]`
  )
})

check('the server RPC demotes before it inserts', () => {
  const fn = serviceWriteMigration.slice(
    serviceWriteMigration.indexOf('CREATE OR REPLACE FUNCTION public.set_current_company_context_service')
  )
  const demote = fn.indexOf('SET is_current = FALSE')
  const insert = fn.indexOf('INSERT INTO public.company_contexts')
  assert.ok(demote > -1, 'the server RPC never demotes the previous current row')
  assert.ok(insert > -1, 'the server RPC never inserts')
  assert.ok(
    demote < insert,
    'the server RPC inserts before demoting — that races the browser RPC on ' +
    'uq_company_contexts_current exactly like the v26 bug this pattern already fixed once'
  )
})

check('saveCompanyContextFromServer is wired into the pipeline it exists to fix', () => {
  const pipeline = read('../src/services/intelligenceService.js')
  assert.match(
    pipeline, /saveCompanyContextFromServer/,
    'v27 adding a server-write path nobody calls is the exact "wired-but-off" state this ' +
    'migration exists to end — stepPersist must call it'
  )
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
