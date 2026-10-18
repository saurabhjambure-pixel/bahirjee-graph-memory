/**
 * Target-layer round-trip tests.
 *
 * Same shape as scripts/context-reuse.test.mjs and scripts/agenda.test.mjs, and for the
 * same reason: every failure mode in this layer is silent. A CHECK frozen while the code
 * moved on rejects every row and the service counts the error and returns normally
 * (v25). A column missing from a .select() reads back undefined and throws nothing
 * (source_class). Both produce a working product and a quietly worse one.
 *
 * Run: npm run test:targets
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isUuid } from '../src/utils/uuid.js'
import { fileURLToPath } from 'node:url'
// A real, pure export — no supabase dependency — safe to import directly rather than
// re-deriving its URL-parsing logic in a test fixture.
import { extractTargetDomain } from '../src/services/reportService.js'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const migration = read('./migrations/v37_intelligence_targets.sql')

let passed = 0
const pending = []
const check = (name, fn) => {
  const run = async () => {
    try {
      await fn()
      passed++
      console.log(`  ✓ ${name}`)
    } catch (err) {
      console.error(`  ✗ ${name}\n    ${err.message}`)
      process.exitCode = 1
    }
  }
  pending.push(run())
}

console.log('\nv31 migration shape\n')

check('creates the three target tables', () => {
  for (const t of [
    'public.intelligence_targets',
    'public.intelligence_target_sources',
    'public.intelligence_target_relationships',
  ]) {
    assert.ok(
      new RegExp(`CREATE TABLE IF NOT EXISTS ${t.replace('.', '\\.')}`, 'i').test(migration),
      `missing CREATE TABLE for ${t}`
    )
  }
})

check('adds target_id to company_contexts, reports and intelligence_jobs', () => {
  for (const t of ['company_contexts', 'reports', 'intelligence_jobs']) {
    assert.ok(
      new RegExp(`ALTER TABLE public\\.${t}[\\s\\S]{0,200}?ADD COLUMN IF NOT EXISTS target_id`, 'i').test(migration),
      `${t} never gains target_id`
    )
  }
})

check('widens the three CHECK constraints the code outgrew', () => {
  assert.ok(/reports_report_kind_check[\s\S]{0,200}?'product'/i.test(migration), "report_kind CHECK missing 'product'")
  assert.ok(/intelligence_jobs_analysis_mode_check[\s\S]{0,200}?'product'/i.test(migration), "analysis_mode CHECK missing 'product'")
  assert.ok(/company_contexts_source_check[\s\S]{0,200}?'inherited'/i.test(migration), "company_contexts.source CHECK missing 'inherited'")
})

/**
 * The exact literal set a named CHECK constraint allows, parsed out of the migration
 * text — not a substring test. A substring test ('product' appears somewhere) would
 * still pass if the constraint also allowed an extra, unintended literal; comparing
 * SETS catches both a missing literal AND an extra one.
 */
function checkConstraintLiterals(constraintName) {
  const nameIdx = migration.indexOf(constraintName)
  assert.notEqual(nameIdx, -1, `constraint ${constraintName} not found in the migration`)
  const clauseStart = migration.indexOf('CHECK (', nameIdx)
  assert.notEqual(clauseStart, -1, `no CHECK clause found after ${constraintName}`)
  const clauseEnd = migration.indexOf(';', clauseStart)
  assert.notEqual(clauseEnd, -1, `unterminated CHECK clause for ${constraintName}`)
  const clause = migration.slice(clauseStart, clauseEnd)
  return new Set([...clause.matchAll(/'([^']+)'/g)].map((m) => m[1]))
}

function assertExactLiterals(constraintName, expected) {
  const actual = checkConstraintLiterals(constraintName)
  assert.deepEqual(
    [...actual].sort(),
    [...expected].sort(),
    `${constraintName} allows [${[...actual].sort().join(', ')}] but expected exactly ` +
    `[${[...expected].sort().join(', ')}] — an unpinned CHECK can drift from the code ` +
    `that writes it with no error anywhere (the v25 lesson)`
  )
}

check('pins intelligence_targets_type_check to its exact literal set', () => {
  assertExactLiterals('intelligence_targets_type_check', new Set(['company', 'product']))
})

check('pins intelligence_targets_status_check to its exact literal set', () => {
  assertExactLiterals('intelligence_targets_status_check', new Set(['draft', 'active', 'archived']))
})

check('pins intelligence_target_relationships_relation_check to its exact literal set', () => {
  assertExactLiterals('intelligence_target_relationships_relation_check', new Set(['belongs_to']))
})

check('enables RLS on all three new tables', () => {
  for (const t of [
    'intelligence_targets',
    'intelligence_target_sources',
    'intelligence_target_relationships',
  ]) {
    assert.ok(
      new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`, 'i').test(migration),
      `RLS not enabled on ${t}`
    )
  }
})

check('is idempotent — no bare CREATE TABLE or ADD COLUMN', () => {
  assert.ok(!/CREATE TABLE(?! IF NOT EXISTS)/i.test(migration), 'a CREATE TABLE lacks IF NOT EXISTS')
  assert.ok(!/ADD COLUMN(?! IF NOT EXISTS)/i.test(migration), 'an ADD COLUMN lacks IF NOT EXISTS')
})

check('one company target per (client_id, target_domain)', () => {
  assert.ok(
    /CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]{0,300}?intelligence_targets[\s\S]{0,300}?client_id, target_domain[\s\S]{0,200}?WHERE[\s\S]{0,120}?'company'/i.test(migration),
    'missing the partial unique index for company targets'
  )
})

check('the RPC takes p_target_id', () => {
  // Proves p_target_id is a DECLARED parameter with a UUID type in the signature —
  // not merely a string that appears somewhere nearby (which would pass even if
  // p_target_id only showed up in the function BODY, never declared as an argument).
  const sigStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.set_current_company_context')
  assert.notEqual(sigStart, -1, 'set_current_company_context not found')
  const parenOpen = migration.indexOf('(', sigStart)
  const returnsIdx = migration.indexOf('RETURNS', sigStart)
  assert.ok(parenOpen > -1 && returnsIdx > parenOpen, 'could not isolate the RPC signature')
  const paramList = migration.slice(parenOpen, returnsIdx)
  assert.match(
    paramList,
    /\bp_target_id\s+UUID\b/i,
    'p_target_id must be declared as a UUID parameter in the signature, not merely referenced in the body'
  )
})

check('grants EXECUTE on the RPC to authenticated, matching its own argument list', () => {
  // DROP FUNCTION IF EXISTS discards v26's GRANT along with the six-argument overload —
  // Postgres ties privileges to a function's exact signature, not its name, so the new
  // seven-argument function starts with none. Without a fresh GRANT, every context save
  // either 42501s (where default privileges are tightened, e.g. Supabase) or silently
  // falls back to PUBLIC's default privileges — either way a departure from this repo's
  // explicit grant-to-authenticated convention (v26, v29). Derive both argument lists
  // from the SQL itself rather than hardcoding the expected list here too, so a later
  // signature change that forgets to update the GRANT fails this test instead of only
  // failing in production.
  const sigStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.set_current_company_context')
  assert.notEqual(sigStart, -1, 'set_current_company_context not found')
  const parenOpen = migration.indexOf('(', sigStart)
  const returnsIdx = migration.indexOf('RETURNS', sigStart)
  assert.ok(parenOpen > -1 && returnsIdx > parenOpen, 'could not isolate the RPC signature')
  const closeParen = migration.indexOf(')', parenOpen)
  assert.ok(closeParen > -1 && closeParen < returnsIdx, 'could not find the signature\'s closing paren')
  const paramList = migration.slice(parenOpen + 1, closeParen)
  const createTypes = paramList
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^p_[a-z_]+\s+([A-Za-z][A-Za-z0-9]*)/)
      assert.ok(m, `could not parse a parameter type out of "${p}"`)
      return m[1].toUpperCase()
    })
  assert.ok(createTypes.length > 0, 'parsed no parameter types from the CREATE signature — parser broken')

  const grantMatch = migration.match(
    /GRANT EXECUTE ON FUNCTION public\.set_current_company_context\(([^)]*)\)\s+TO\s+authenticated;/i
  )
  assert.ok(grantMatch, 'no GRANT EXECUTE ... TO authenticated found for set_current_company_context')
  const grantTypes = grantMatch[1].split(',').map((t) => t.trim().toUpperCase()).filter(Boolean)

  assert.deepEqual(
    grantTypes, createTypes,
    `GRANT EXECUTE declares (${grantTypes.join(', ')}) but the CREATE signature declares ` +
    `(${createTypes.join(', ')}). A dropped function's grants do not carry over to its ` +
    `replacement, so a mismatched or missing GRANT here leaves the RPC uncallable by ` +
    `authenticated users, silently — saveCompanyContext catches and logs the failure ` +
    `rather than surfacing it.`
  )
})

check('the no-target branch creates a company target and continues, rather than raising', () => {
  // The regression this guards: nothing in the application ever creates a type='company'
  // target directly, and the v31 backfill only covers a client that already had a
  // company_contexts row or a report when the migration ran. Any workspace onboarded
  // afterward hits "no target" on its very first confirm. The old RAISE EXCEPTION here
  // made that fail loudly forever for every such workspace — not a keyword check: this
  // asserts the actual control flow, that the branch inserts INTO v_target_id and the
  // function falls through to use it, rather than stopping the function.
  const sigStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.set_current_company_context')
  assert.notEqual(sigStart, -1, 'set_current_company_context not found')
  const bodyEnd = migration.indexOf('\n$$;', sigStart)
  assert.notEqual(bodyEnd, -1, 'could not find the end of the function body')
  const body = migration.slice(sigStart, bodyEnd)

  // The tenancy RAISE EXCEPTION must still be there, unweakened.
  assert.match(
    body, /RAISE EXCEPTION 'not authorised for this client'/,
    'the tenancy check must still refuse an unauthorised caller'
  )

  // The specific "no target" RAISE EXCEPTION must be GONE.
  assert.ok(
    !/RAISE EXCEPTION 'no target for/.test(body),
    'the no-target branch still raises instead of creating the target'
  )

  // Isolate the second "IF v_target_id IS NULL THEN ... END IF" block — the first handles
  // p_target_id/lookup, this one is the create-on-miss branch.
  const ifBlocks = [...body.matchAll(/IF v_target_id IS NULL THEN[\s\S]*?\n\s*END IF;/g)]
  assert.equal(ifBlocks.length, 2, `expected exactly 2 "v_target_id IS NULL" branches, found ${ifBlocks.length}`)
  const createBlock = ifBlocks[1][0]

  assert.match(
    createBlock, /INSERT INTO public\.intelligence_targets/,
    'the no-target branch must insert a new intelligence_targets row'
  )
  assert.match(
    createBlock, /'company'/,
    'the created target must be a company target'
  )
  assert.match(
    createBlock, /RETURNING id INTO v_target_id/,
    'the insert must feed its id back into v_target_id so the function continues using it'
  )

  // The ON CONFLICT target must repeat uq_intelligence_targets_company's own predicate
  // EXACTLY — Postgres only infers a partial unique index from a matching WHERE clause, not
  // a mismatched or missing one. Read the real index definition rather than hardcoding it
  // twice, so a later change to the index and a forgotten matching change here fails this
  // test instead of only failing as "no unique or exclusion constraint matching the ON
  // CONFLICT specification" against a live database.
  const indexMatch = migration.match(
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_intelligence_targets_company\s*\n\s*ON public\.intelligence_targets \(([^)]+)\)\s*\n\s*WHERE ([^;]+);/
  )
  assert.ok(indexMatch, 'uq_intelligence_targets_company definition not found — repoint this test')
  const [, indexColumns, indexPredicate] = indexMatch

  const conflictMatch = createBlock.match(/ON CONFLICT \(([^)]+)\) WHERE ([^\n]+)\s*\n\s*DO UPDATE/)
  assert.ok(conflictMatch, 'the create-on-miss INSERT has no matching ON CONFLICT clause')
  const [, conflictColumns, conflictPredicate] = conflictMatch

  assert.equal(
    conflictColumns.trim(), indexColumns.trim(),
    `ON CONFLICT names (${conflictColumns.trim()}) but the partial index is on (${indexColumns.trim()})`
  )
  assert.equal(
    conflictPredicate.trim(), indexPredicate.trim(),
    `ON CONFLICT's WHERE (${conflictPredicate.trim()}) does not match the index's own ` +
    `predicate (${indexPredicate.trim()}) — a mismatched partial-index predicate makes ` +
    `Postgres refuse to infer the index at all`
  )
})

const contextService = read('../src/services/companyContextService.js')

console.log('\ncontext inheritance\n')

check('_product survives hydration; _decision still does not', async () => {
  const mod = await import('../src/services/companyContextService.js')
  const hydrated = mod.hydrateStoredContext({
    company_name: 'Acme',
    _product: { name: 'Widget', category: 'CRM' },
    _decision: { raw_input: 'should we?' },
    _trackedEntities: [{ name: 'Rival' }],
  })
  assert.ok(hydrated._product, '_product must survive — it is durable product identity')
  assert.equal(hydrated._decision, undefined, '_decision is one run\'s frame and must be stripped')
  assert.equal(hydrated._trackedEntities, undefined, '_trackedEntities is run-scoped')
})

check('every source literal the code writes is in the v31 CHECK', () => {
  const inCheck = (migration.match(/company_contexts_source_check[\s\S]{0,300}?CHECK \(source IN \(([^)]+)\)/i) || [])[1] || ''
  const allowed = [...inCheck.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  const written = [...contextService.matchAll(/source\s*[:=]\s*'([a-z_]+)'/g)].map((m) => m[1])
  for (const s of new Set(written)) {
    assert.ok(allowed.includes(s), `companyContextService writes source '${s}' but the CHECK rejects it`)
  }
})

check('target_id is selected wherever the mapper reads it', () => {
  if (!/target_id/.test(contextService)) throw new Error('service never references target_id')
  assert.ok(/CONTEXT_COLUMNS[\s\S]{0,400}?target_id/.test(contextService),
    'target_id read by the mapper but absent from the column list')
})

/**
 * Isolate one function's body by brace matching. Same technique as
 * scripts/context-reuse.test.mjs's functionBody — duplicated deliberately rather than
 * shared, since these test files are each pinned to one migration slice on their own.
 */
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

console.log('\ndomain-only lookup collision (multi-target)\n')

check('the domain-only path resolves the COMPANY target from intelligence_targets before querying company_contexts', () => {
  // v31 moved the one-current unique index to (client_id, target_id). A product target
  // carries its parent's target_domain verbatim, so once product contexts exist, a
  // company_contexts query filtered on target_domain alone can match more than one
  // is_current row. getCurrentCompanyContext must resolve the COMPANY target's id first
  // and filter by THAT — proven here by requiring the intelligence_targets lookup to
  // appear, textually, before the company_contexts query, and to filter type='company'.
  // A regex that merely checks the string 'intelligence_targets' appears anywhere in the
  // file (e.g. in a comment) would pass even if the fix were never made — this walks the
  // actual function body.
  const body = functionBody(contextService, 'getCurrentCompanyContext')

  const targetLookupIdx = body.indexOf("from('intelligence_targets')")
  assert.notEqual(
    targetLookupIdx, -1,
    'getCurrentCompanyContext never queries intelligence_targets — the domain-only branch ' +
    'is still vulnerable to matching multiple company_contexts rows once product contexts exist'
  )

  const companyContextsIdx = body.indexOf("from('company_contexts')")
  assert.notEqual(companyContextsIdx, -1, 'getCurrentCompanyContext never queries company_contexts')
  assert.ok(
    targetLookupIdx < companyContextsIdx,
    'the intelligence_targets lookup must run BEFORE the company_contexts query — resolving ' +
    'the target id afterward cannot narrow the query that already ran'
  )

  const lookupSlice = body.slice(targetLookupIdx, companyContextsIdx)
  assert.match(
    lookupSlice, /\.eq\('type',\s*'company'\)/,
    "the intelligence_targets lookup must filter type = 'company' — without it the lookup " +
    "could resolve to a PRODUCT target and point the reader at the wrong company's context"
  )
  assert.match(
    lookupSlice, /\.eq\('client_id',\s*clientId\)/,
    'the intelligence_targets lookup must stay tenant-scoped'
  )

  // The resolved id must actually be the filter used against company_contexts, not merely
  // looked up and discarded.
  const queryBuildIdx = body.indexOf('.eq(\'target_id\'', companyContextsIdx)
  assert.notEqual(
    queryBuildIdx, -1,
    'company_contexts is never filtered by the resolved target_id after the lookup — the ' +
    'fix must narrow the actual query, not just read intelligence_targets and ignore it'
  )
})

check('a multi-row result (PGRST116) is handled distinctly from a missing table (42P01), and logs loudly', () => {
  // maybeSingle() does NOT throw when a query matches more than one row — it returns
  // { error: { code: 'PGRST116' } }. Before this fix, only '42P01' (table missing) was
  // special-cased, so a violated one-current invariant read identically to "no context
  // found" and fell through to the report fallback with nothing logged anywhere — the
  // exact silent-degradation shape this codebase keeps paying for.
  const body = functionBody(contextService, 'getCurrentCompanyContext')

  const pgrst116Idx = body.indexOf('PGRST116')
  assert.notEqual(pgrst116Idx, -1, 'getCurrentCompanyContext never checks for PGRST116')

  const p42Idx = body.indexOf("'42P01'")
  assert.notEqual(p42Idx, -1, '42P01 handling must still be present — this fix must not remove it')
  assert.notEqual(
    pgrst116Idx, p42Idx,
    'PGRST116 must be its own branch, not folded into (or aliased with) the 42P01 check — ' +
    'they mean different things: one is a missing table, the other is a broken invariant'
  )

  // The PGRST116 branch must actually log, and must name enough to act on: which client,
  // which domain. A generic "lookup failed" message is not enough to distinguish this from
  // ordinary noise.
  const branch = body.slice(pgrst116Idx, pgrst116Idx + 1200)
  assert.match(branch, /console\.(error|warn)/, 'the PGRST116 branch must log loudly, not stay silent')
  assert.match(branch, /clientId/, 'the PGRST116 log must name the client')
  assert.match(branch, /targetDomain/, 'the PGRST116 log must name the domain')
})

check('the missing-table fallback for the target lookup stays genuinely silent', () => {
  // Requirement: on a deployment where v31 (intelligence_targets) has not been applied,
  // falling back to the domain-only query must behave exactly as it does today — no new
  // console noise for the ordinary "table doesn't exist yet" case. This is what makes the
  // fix safe to ship ahead of the migration.
  const body = functionBody(contextService, 'getCurrentCompanyContext')
  const targetLookupIdx = body.indexOf("from('intelligence_targets')")
  assert.notEqual(targetLookupIdx, -1, 'getCurrentCompanyContext never queries intelligence_targets')
  const companyContextsIdx = body.indexOf("from('company_contexts')")
  const lookupSlice = body.slice(targetLookupIdx, companyContextsIdx)

  assert.match(lookupSlice, /42P01/, 'the target lookup must recognise the Postgres "table missing" code')
  assert.match(lookupSlice, /PGRST205/, 'the target lookup must recognise the PostgREST "table missing" code')

  // Whatever guards the 42P01/PGRST205 branch must NOT be paired with a console call on
  // that same branch — i.e. the missing-table path must not log.
  const missingTableGuard = lookupSlice.match(/targetError\.code\s*!==\s*'42P01'[\s\S]{0,120}?PGRST205/)
  assert.ok(
    missingTableGuard,
    'expected a single guard excluding BOTH missing-table codes before any warning is logged'
  )
})

console.log('\nproduct query lens\n')

check('the lens never over-subscribes a tier budget', async () => {
  const { RUN_TIERS } = await import('../src/services/runTiers.js')
  const { buildProductQueries } = await import('../src/services/productService.js')
  const product = {
    name: 'Widget', category: 'CRM', canonical_url: 'https://acme.com/widget',
    competitor_products: ['Rival Pro'],
  }
  const context = { company_name: 'Acme', operating_geography: 'India', industry: 'software' }

  for (const tierName of ['shallow', 'full']) {
    const tier = RUN_TIERS[tierName]
    const queries = buildProductQueries({
      product, context, entities: [], limit: tier.inquiryQueryFloor,
    })
    assert.ok(queries.length >= 1, `${tierName} must get at least one product query`)
    assert.ok(
      queries.length <= tier.inquiryQueryFloor,
      `${tierName}: ${queries.length} queries exceeds the inquiry floor of ${tier.inquiryQueryFloor}`
    )
    assert.ok(queries.every((q) => typeof q === 'string' && q.trim().length > 0), 'empty query emitted')
  }
})

check('the lens is off for the daily and decision tiers', async () => {
  const { RUN_TIERS } = await import('../src/services/runTiers.js')
  assert.equal(RUN_TIERS.shallow.productLens, true)
  assert.equal(RUN_TIERS.full.productLens, true)
  assert.equal(RUN_TIERS.daily.productLens, false, 'pursuit runs are Agenda-driven, not product-driven')
  assert.equal(RUN_TIERS.decision.productLens, false, 'the decision lens owns that floor')
})

check('a product with no name yields no queries rather than templated junk', async () => {
  const { buildProductQueries, normalizeProductProfile } = await import('../src/services/productService.js')
  assert.equal(normalizeProductProfile({ name: '   ' }), null)
  assert.deepEqual(buildProductQueries({ product: null, context: {}, entities: [], limit: 4 }), [])
})

const pipeline = read('../src/services/intelligenceService.js')

console.log('\npipeline seams\n')

check('stepContext sets _product from the job, mirroring _decision', () => {
  assert.ok(/PRODUCT_MODE/.test(pipeline), 'intelligenceService never imports PRODUCT_MODE')
  assert.ok(
    /analysisMode === PRODUCT_MODE[\s\S]{0,200}?state\.context\._product\s*=/.test(pipeline),
    'stepContext never sets state.context._product'
  )
})

check('stepGenerateQueries adds the product lens beside the decision lens', () => {
  assert.ok(
    /queries\.product_lens\s*=\s*buildProductQueries\(/.test(pipeline),
    'no product_lens assignment in stepGenerateQueries'
  )
})

check('the lens is gated on the tier flag, not just the mode', () => {
  assert.ok(
    /productLens/.test(pipeline),
    'product_lens must consult RUN_TIERS[tier].productLens so daily/decision runs cannot spend it'
  )
})

console.log('\nfix pass 1 — reusable-key leak guards\n')

check('the product lens gate requires analysisMode === PRODUCT_MODE, and does not use an || fallback on _product', () => {
  // _decision is RUN-SCOPED (companyContextService.RUN_SCOPED_KEYS) — stripped on reuse, so
  // it cannot outlive the run that set it, which is what makes the decision lens's
  // `analysisMode === DECISION_MODE || contextJson._decision` gate safe. _product is
  // REUSABLE (companyContextService.REUSABLE_KEYS) — designed to survive into later runs.
  // Mirroring that || pattern here would let ANY route that deposits a _product on
  // state.context (reuse, hydration, a stale job field) silently turn on product research
  // for a run that never asked for it. This walks the actual if-guard text, not just a
  // substring match, so a regression that re-adds || anywhere near the gate is caught even
  // if PRODUCT_MODE still appears elsewhere in the function.
  const body = functionBody(pipeline, 'stepGenerateQueries')
  const assignIdx = body.indexOf('queries.product_lens = buildProductQueries(')
  assert.notEqual(assignIdx, -1, 'no product_lens assignment in stepGenerateQueries')

  const ifIdx = body.lastIndexOf('if (', assignIdx)
  assert.notEqual(ifIdx, -1, 'no if-guard found before the product_lens assignment')
  const condEnd = body.indexOf(') {', ifIdx)
  assert.notEqual(condEnd, -1, 'unterminated if-guard before the product_lens assignment')
  const condition = body.slice(ifIdx, condEnd + 1)

  assert.match(
    condition, /ctx\.job\.analysisMode\s*===\s*PRODUCT_MODE/,
    'the product-lens gate must require ctx.job.analysisMode === PRODUCT_MODE explicitly — a ' +
    'bare productProfile check alone lets the lens fire on a run that never asked for product mode'
  )
  assert.match(
    condition, /budget\(\)\.productLens/,
    'the product-lens gate must still consult the tier flag'
  )
  assert.doesNotMatch(
    condition, /\|\|/,
    'the product-lens if-guard must not use an || fallback — mirroring the decision lens ' +
    'pattern is unsafe here because _product (unlike _decision) survives reuse'
  )
})

check('stepContext deletes _product when the run is not product mode', () => {
  // Defence in depth for the gate above: even if some other path deposits a foreign
  // _product onto state.context (report fallback, hydration of a stored context, a stale
  // ctx.job.productContext), a non-product-mode run must not carry it out of stepContext.
  const body = functionBody(pipeline, 'stepContext')
  assert.match(
    body, /analysisMode\s*!==\s*PRODUCT_MODE[\s\S]{0,200}?delete\s+state\.context\._product/,
    'stepContext never deletes state.context._product on a non-product-mode run'
  )
  // Must actually log when it deletes something — a silent delete would hide the fact that
  // a leak path still exists somewhere upstream.
  const guardIdx = body.search(/analysisMode\s*!==\s*PRODUCT_MODE[\s\S]{0,200}?delete\s+state\.context\._product/)
  const nearby = body.slice(Math.max(0, guardIdx - 200), guardIdx + 400)
  assert.match(nearby, /console\.(warn|error)/, 'the _product deletion must log — a silent delete hides an upstream leak')
})

check('getCurrentCompanyContext does not fall back to a report when targetId was supplied', () => {
  // A product shares its parent company's target_domain verbatim, and getLastReportForUrl
  // filters on client_id + target_domain only (no target scoping) — so the report fallback
  // could hand back a sibling product's report, or the parent company's report, either way
  // carrying a foreign _product. When the caller resolved this call to a specific target and
  // the stored-context lookup found nothing, the function must return null rather than fall
  // through to that fallback.
  const body = functionBody(contextService, 'getCurrentCompanyContext')
  const fallbackIdx = body.indexOf("getLastReportForUrl(clientId, websiteUrl)")
  assert.notEqual(fallbackIdx, -1, 'getCurrentCompanyContext no longer calls getLastReportForUrl')

  const guardSlice = body.slice(0, fallbackIdx)
  const guardMatch = guardSlice.match(/if\s*\(\s*targetId\s*\)\s*\{[\s\S]*?return\s+null[\s\S]*?\}/)
  assert.ok(
    guardMatch,
    'no "if (targetId) { ... return null ... }" guard found before the report-fallback call — ' +
    'a targetId-scoped lookup that misses must not fall through to the domain-only report fallback'
  )
  // The guard must be the LAST thing that runs before the fallback code, not merely present
  // somewhere earlier and then bypassed by other logic — i.e. it must sit directly upstream.
  const guardEnd = guardSlice.lastIndexOf(guardMatch[0]) + guardMatch[0].length
  const between = guardSlice.slice(guardEnd)
  assert.doesNotMatch(
    between, /getLastReportForUrl/,
    'something between the targetId guard and the fallback call still reaches getLastReportForUrl'
  )
})

check('the company path strips _product from a report-fallback context', () => {
  // Reached only when targetId was NOT supplied (the guard above returns before this for a
  // targetId call). A report fallback is domain-only, so a report that happens to belong to
  // a product sharing this domain must not leak its _product into a company context.
  const body = functionBody(contextService, 'getCurrentCompanyContext')
  const fallbackIdx = body.indexOf("getLastReportForUrl(clientId, websiteUrl)")
  assert.notEqual(fallbackIdx, -1, 'getCurrentCompanyContext no longer calls getLastReportForUrl')

  const returnIdx = body.indexOf('origin: \'report_fallback\'', fallbackIdx)
  assert.notEqual(returnIdx, -1, 'no report_fallback return found after the getLastReportForUrl call')

  const between = body.slice(fallbackIdx, returnIdx)
  assert.match(
    between, /const\s*\{\s*_product\s*,\s*\.\.\.\s*\w+\s*\}\s*=\s*report\.context/,
    '_product must be destructured off report.context before it is returned to the company path'
  )
  assert.doesNotMatch(
    body.slice(returnIdx, returnIdx + 400), /context:\s*report\.context\b/,
    'the report_fallback return must not use the raw report.context — it still carries _product'
  )
})

console.log('\ntarget service\n')

check('every column the mapper reads is in TARGET_COLUMNS', async () => {
  const src = read('../src/services/targetService.js')
  const cols = (src.match(/export const TARGET_COLUMNS = \[([\s\S]*?)\]/) || [])[1] || ''
  const selected = new Set([...cols.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))
  const mapper = (src.match(/function mapTarget\(row\)[\s\S]*?\n}/) || [])[0] || ''
  const readCols = [...mapper.matchAll(/row\.([a-z_]+)/g)].map((m) => m[1])
  assert.ok(readCols.length > 0, 'mapTarget reads nothing — is it named differently?')
  for (const c of new Set(readCols)) {
    assert.ok(selected.has(c), `mapTarget reads row.${c} but TARGET_COLUMNS never selects it`)
  }
})

check('createTarget checks both follow-up insert errors and rolls back the target row on failure', () => {
  // Finding 1: createTarget commits the target row, then inserts sources and (for a
  // product) the belongs_to relationship. Before this fix, neither insert's error was
  // checked, so a founder could be told 'ok: true' with no canonical_url on file and no
  // link to their company. This walks the actual function body rather than the whole
  // file, so it fails specifically when the check is removed, not on unrelated edits.
  const src = read('../src/services/targetService.js')
  const body = functionBody(src, 'createTarget')

  assert.match(
    body,
    /const\s*\{\s*error:\s*sourcesError\s*\}\s*=\s*await supabase\.from\('intelligence_target_sources'\)\.insert/,
    'createTarget must destructure and check the error returned by the sources insert'
  )
  assert.match(
    body, /relError\s*=\s*relResult\.error/,
    'createTarget must capture the error returned by the relationship insert'
  )
  assert.match(
    body, /if\s*\(\s*sourcesError\s*\|\|\s*relError\s*\)/,
    'createTarget must branch on either follow-up insert failing'
  )
  assert.match(
    body, /\.from\('intelligence_targets'\)\s*\.delete\(\)\s*\.eq\('id',\s*target\.id\)/,
    'a follow-up insert failure must delete the just-created target row (rollback), not leave it orphaned'
  )
  assert.match(
    body, /return\s*\{\s*ok:\s*false/,
    'a follow-up insert failure must return ok: false, never a silent success'
  )
})

check('every column the sources mapper reads is in SOURCE_COLUMNS', async () => {
  // Same round trip as TARGET_COLUMNS/mapTarget above, mirrored for mapSources — it had
  // no pin of its own. They happen to agree today; that is exactly the drift that has
  // silently cost this codebase evidence before (source_class, v25).
  const src = read('../src/services/targetService.js')
  const cols = (src.match(/export const SOURCE_COLUMNS = \[([\s\S]*?)\]/) || [])[1] || ''
  const selected = new Set([...cols.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))
  const mapper = (src.match(/function mapSources\(row\)[\s\S]*?\n}/) || [])[0] || ''
  const readCols = [...mapper.matchAll(/row\.([a-z_]+)/g)].map((m) => m[1])
  assert.ok(readCols.length > 0, 'mapSources reads nothing — is it named differently?')
  for (const c of new Set(readCols)) {
    assert.ok(selected.has(c), `mapSources reads row.${c} but SOURCE_COLUMNS never selects it`)
  }
})

check('type and status literals match the v31 CHECKs', async () => {
  const mod = await import('../src/services/targetService.js')
  const typeCheck = (migration.match(/intelligence_targets_type_check[\s\S]{0,200}?CHECK \(type IN \(([^)]+)\)/i) || [])[1] || ''
  const statusCheck = (migration.match(/intelligence_targets_status_check[\s\S]{0,200}?CHECK \(status IN \(([^)]+)\)/i) || [])[1] || ''
  const allowedTypes = [...typeCheck.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  const allowedStatuses = [...statusCheck.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  assert.deepEqual([...mod.TARGET_TYPES].sort(), allowedTypes.sort(), 'TARGET_TYPES drifted from the CHECK')
  assert.deepEqual([...mod.TARGET_STATUSES].sort(), allowedStatuses.sort(), 'TARGET_STATUSES drifted from the CHECK')
})

check('listTargets returns [] for an unconfigured client, rather than throwing', async () => {
  const mod = await import('../src/services/targetService.js')
  // No Supabase client configured in this test process (no credentials), so `supabase` is
  // null and this only exercises the `if (!supabase || !clientId) return []` guard at the
  // top of listTargets — it never reaches the try/catch, so it does NOT prove anything
  // about the missing-table branch. See the next check for that.
  const out = await mod.listTargets('11111111-1111-1111-1111-111111111111')
  assert.deepEqual(out, [], 'listTargets must fail soft when unconfigured')
})

check('the missing-table branch suppresses logging; every other error still logs', () => {
  // Cannot exercise this branch by calling listTargets in this process — there is no live
  // Supabase client to make it error, and the top-level guard above returns before the
  // try/catch is ever reached. So this asserts the actual guard structure in the source:
  // every place listTargets can receive an error, the console.error is conditioned on
  // NOT being a MISSING_TABLE_CODES member, so a missing table stays silent (an
  // un-migrated deployment must not spam logs) while any other error — a real outage, a
  // permissions error, a malformed query — still logs loudly.
  const src = read('../src/services/targetService.js')
  const body = functionBody(src, 'listTargets')

  // The outer catch (targets query itself, or anything that throws).
  const outerCatchIdx = body.lastIndexOf('} catch (err) {')
  assert.notEqual(outerCatchIdx, -1, 'listTargets has no catch block')
  const outerCatch = body.slice(outerCatchIdx)
  assert.match(
    outerCatch,
    /if\s*\(\s*!MISSING_TABLE_CODES\.has\(err\?\.code\)\s*\)\s*\{[\s\S]{0,120}?console\.error/,
    'the outer catch must guard console.error behind !MISSING_TABLE_CODES.has(err?.code)'
  )

  // The two follow-up queries (sources, relationships) added for Finding 2 — each must
  // carry the same guard, independently, since either can fail without the other.
  for (const label of ['sources', 'relationships']) {
    const errVar = label === 'sources' ? 'sourcesRes' : 'relsRes'
    const re = new RegExp(
      `if\\s*\\(\\s*${errVar}\\.error\\s*&&\\s*!MISSING_TABLE_CODES\\.has\\(${errVar}\\.error\\.code\\)\\s*\\)\\s*\\{[\\s\\S]{0,120}?console\\.error`
    )
    assert.match(body, re, `the ${label} follow-up query must guard console.error the same way`)
  }
})

check('slugify is stable and url-safe', async () => {
  const { slugify } = await import('../src/services/targetService.js')
  assert.equal(slugify('  Widget  Pro!  '), 'widget-pro')
  assert.equal(slugify('Acme/Widget'), 'acme-widget')
  assert.ok(slugify('///').length > 0, 'a slug must never be empty')
})

console.log('\ncontext snapshot\n')

/**
 * Isolate a `calleeName(...)` call's argument text by paren-matching, starting the
 * search at `fromIdx`. Same brace/paren-matching discipline as `functionBody` above —
 * a substring match on the callee name alone can't tell you what was actually passed.
 */
function callArguments(source, calleeName, fromIdx = 0) {
  const callIdx = source.indexOf(`${calleeName}(`, fromIdx)
  assert.notEqual(callIdx, -1, `${calleeName}( not found`)
  const parenStart = callIdx + calleeName.length
  let depth = 0
  let end = -1
  for (let i = parenStart; i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')' && --depth === 0) { end = i; break }
  }
  assert.notEqual(end, -1, `unbalanced parens in ${calleeName}(...)`)
  return source.slice(parenStart + 1, end)
}

/**
 * The value bound to `key` inside an object-literal argument block, handling both the
 * explicit (`key: value`) and shorthand (`key,` — equivalent to `key: key`) forms. A
 * key that never appears returns undefined.
 */
function boundValue(argsBlock, key) {
  const re = new RegExp(`\\b${key}\\s*(?::\\s*([A-Za-z0-9_$.]+))?\\s*[,}]`)
  const m = argsBlock.match(re)
  if (!m) return undefined
  return m[1] || key // shorthand `key,` binds to the local variable of the same name
}

check('inheritance is a snapshot, not a reference', async () => {
  const src = read('../src/services/targetService.js')
  assert.ok(/export async function inheritCompanyContext/.test(src), 'no inheritCompanyContext')
  const fn = (src.match(/export async function inheritCompanyContext[\s\S]*?\n}/) || [])[0]
  assert.ok(/saveCompanyContext/.test(fn), 'inheritance must WRITE a row, not point at the parent')
  assert.ok(/'inherited'/.test(fn), "the written row must be source='inherited'")
  assert.ok(/_product/.test(fn), 'the snapshot must carry the _product overlay')

  // The snapshot must be built by SPREADING parent.context into a brand-new object, not
  // by aliasing or mutating it — `{ ...parent.context, _product: profile }` copies the
  // parent's own-enumerable keys at this instant. A bare alias (`context = parent.context`)
  // or an in-place mutation (`parent.context.foo = ...`) would leave the product pointed
  // at the SAME object the company context reuses on its next run — a later company-context
  // edit would then reach an already-created product.
  const spreadMatch = fn.match(
    /const\s+(\w+)\s*=\s*\{\s*\.\.\.\s*parent\.context\s*,[\s\S]*?_product\s*:\s*profile[\s\S]*?\}\s*;/
  )
  assert.ok(
    spreadMatch,
    'the snapshot must be built as `const <name> = { ...parent.context, _product: profile }` — ' +
    'a mutation of parent.context or a bare alias would let a later company-context edit reach ' +
    'an already-created product'
  )
  const snapshotVar = spreadMatch[1]

  assert.doesNotMatch(
    fn, /parent\.context\s*\.\s*\w+\s*=(?!=)/,
    'inheritCompanyContext must not assign onto parent.context directly — that mutates the shared object'
  )
  assert.doesNotMatch(
    fn, /parent\.context\s*\[[^\]]*\]\s*=(?!=)/,
    'inheritCompanyContext must not assign onto parent.context via bracket notation'
  )

  // The variable actually spread must be the one passed to saveCompanyContext's `context`
  // key — proving the snapshot is used, not merely built and discarded in favour of
  // parent.context itself.
  const args = callArguments(fn, 'saveCompanyContext')
  const bound = boundValue(args, 'context')
  assert.equal(
    bound, snapshotVar,
    `saveCompanyContext's context key binds '${bound}', not the spread snapshot '${snapshotVar}' — ` +
    'passing parent.context directly would share the SAME object between company and product'
  )
})

check('a product with no parent context is refused, never given {}', () => {
  const src = read('../src/services/targetService.js')
  const fn = (src.match(/export async function inheritCompanyContext[\s\S]*?\n}/) || [])[0] || ''
  assert.ok(/ok:\s*false/.test(fn), 'a missing parent context must return ok:false')
})

check('a target becomes runnable only once inheritance succeeds', () => {
  const src = read('../src/services/targetService.js')
  const body = functionBody(src, 'createTarget')
  assert.match(body, /'active'/, "createTarget never promotes a product out of 'draft'")
  assert.match(
    body, /inheritCompanyContext/,
    'createTarget must inherit before promoting — otherwise a draft can never be run'
  )

  // The promotion must be GATED on the inheritance result, not merely follow a call to
  // it — a version that called inheritCompanyContext and ignored what it returned must
  // fail this check. Find the captured result variable, then require an `if (!<var>.ok)`
  // guard that returns, appearing strictly before the promotion update.
  const callMatch = body.match(/const\s+(\w+)\s*=\s*await\s+inheritCompanyContext\(/)
  assert.ok(callMatch, "createTarget must capture inheritCompanyContext's result in a variable")
  const resultVar = callMatch[1]
  const callIdx = body.indexOf(callMatch[0])

  const afterCall = body.slice(callIdx)
  const guardRe = new RegExp(`if\\s*\\(\\s*!\\s*${resultVar}\\.ok\\s*\\)\\s*\\{[\\s\\S]{0,300}?return\\b`)
  const guardMatch = afterCall.match(guardRe)
  assert.ok(
    guardMatch,
    `createTarget must check ${resultVar}.ok and return before promoting — a call to ` +
    'inheritCompanyContext whose result is ignored must not reach promotion'
  )
  const guardIdx = callIdx + afterCall.indexOf(guardMatch[0])

  const promoteIdx = body.indexOf("status: 'active'")
  assert.notEqual(promoteIdx, -1, 'no promotion to active found')
  assert.ok(
    guardIdx < promoteIdx,
    'the ok-check on the inheritance result must appear BEFORE the promotion to active'
  )
})

check('_product never lands on the company target context', async () => {
  // Finding 2: this check previously asserted `/targetId(?![a-zA-Z])/` against the whole
  // function body — but `targetId` is a mandated parameter name, so that substring is
  // ALWAYS present, even when the write is scoped to `parentTargetId` instead. Proven
  // inert by the reviewer: changing `targetId,` to `targetId: parentTargetId,` in the
  // real saveCompanyContext call left this check (and all 38 others) passing. That
  // regression would demote and replace the COMPANY's own current context with a
  // product-tainted one, for every future company run.
  //
  // This version extracts the saveCompanyContext(...) call's actual argument block and
  // asserts what its `targetId` key is bound to — the product's own `targetId`, never
  // `parentTargetId` — handling both the explicit (`targetId: targetId`) and shorthand
  // (`targetId,`) forms.
  const src = read('../src/services/targetService.js')
  const fn = (src.match(/export async function inheritCompanyContext[\s\S]*?\n}/) || [])[0] || ''
  assert.ok(fn, 'inheritCompanyContext not found')

  const args = callArguments(fn, 'saveCompanyContext')
  const bound = boundValue(args, 'targetId')
  assert.ok(bound, 'the saveCompanyContext(...) call never binds a targetId key')
  assert.equal(
    bound, 'targetId',
    `saveCompanyContext's targetId key binds '${bound}', not the product's own 'targetId' — ` +
    'binding parentTargetId here would demote and replace the COMPANY\'s own current context ' +
    'with a product-tainted one, for every future company run'
  )
  assert.notEqual(
    bound, 'parentTargetId',
    'saveCompanyContext must not bind targetId to parentTargetId — the exact regression this check exists to catch'
  )
})

console.log('\ncreateTarget: promotion and parent domain\n')

check('createTarget checks the promotion update error and reports failure honestly, without rolling back', () => {
  // Finding 1: promoting a newly-created target to 'active' can itself fail. Before this
  // fix, `error` was never read from that update — `promoted` came back undefined, the
  // code fell back to the pre-update `target` (still 'draft'), and returned ok:true. The
  // founder was told the product was created when both the UI card and the server-side
  // run path refuse to run a draft target, with no message saying why.
  //
  // Unlike a failed follow-up insert (sources/relationship), this failure must NOT roll
  // the target back: the row, its sources and (for a product) its inherited context are
  // all valid, and a retry can still promote it.
  const src = read('../src/services/targetService.js')
  const body = functionBody(src, 'createTarget')

  const promoteIdx = body.indexOf(".update({ status: 'active'")
  assert.notEqual(promoteIdx, -1, 'no promotion to active found')

  const promoteBlock = body.slice(Math.max(0, promoteIdx - 200), promoteIdx + 200)
  assert.match(
    promoteBlock,
    /const\s*\{\s*data:\s*promoted\s*,\s*error:\s*promoteError\s*\}\s*=\s*await supabase/,
    'createTarget must destructure the error from the promotion update, not just `data: promoted`'
  )

  const afterPromote = body.slice(promoteIdx)
  const errGuardMatch = afterPromote.match(/if\s*\(\s*promoteError\s*\)\s*\{[\s\S]{0,500}?\n\s{8}\}/)
  assert.ok(errGuardMatch, 'createTarget never checks promoteError after the promotion update')
  assert.match(errGuardMatch[0], /ok:\s*false/, 'a failed promotion must return ok: false')
  assert.doesNotMatch(
    errGuardMatch[0], /\.delete\(\)/,
    'a failed promotion must NOT delete the target row — the row and its context are still ' +
    'valid and a retry can still promote it'
  )
})

check("createTarget refuses a product whose targetDomain does not match its parent's", () => {
  // Finding 4: the file's own header states a product carries its parent's target_domain
  // VERBATIM, and that this is load-bearing — it is why the Agenda, Reads and both crons
  // needed no changes. The parent lookup selected id/client_id/type but never verified
  // target_domain, leaving the invariant resting entirely on caller discipline.
  const src = read('../src/services/targetService.js')
  const body = functionBody(src, 'createTarget')
  assert.match(
    body, /\.select\('id,\s*client_id,\s*type,\s*target_domain'\)/,
    'the parent lookup must select target_domain alongside id, client_id and type'
  )
  assert.match(
    body, /parent\.target_domain\s*!==\s*targetDomain/,
    "createTarget must compare the parent's target_domain against the product's targetDomain"
  )
  assert.doesNotMatch(
    body, /targetDomain\s*=\s*parent\.target_domain/,
    "a domain mismatch must be a refusal, not a silent rewrite of the caller's targetDomain"
  )
})

console.log('\napi route\n')

check('the route is registered in the single router', () => {
  const router = read('../api/router.js')
  assert.ok(
    /'intelligence-targets':\s*\(\)\s*=>\s*import\('\.\.\/lib\/handlers\/intelligence-targets\.js'\)/.test(router),
    'intelligence-targets is not registered in api/router.js'
  )
})

check('the handler applies security before anything else', () => {
  const h = read('../lib/handlers/intelligence-targets.js')
  assert.ok(/export async function handler/.test(h), 'handler must be a named export')
  const body = (h.match(/export async function handler[\s\S]*?\n}/) || [])[0]
  const secIdx = body.indexOf('applyApiSecurity')
  const authIdx = body.indexOf('requireAuthenticatedUser')
  assert.ok(secIdx > -1, 'applyApiSecurity is never called')
  assert.ok(authIdx === -1 || secIdx < authIdx, 'applyApiSecurity must run before auth')
})

check('no new file was added under api/', async () => {
  const { readdirSync } = await import('node:fs')
  const apiDir = fileURLToPath(new URL('../api', import.meta.url))
  const files = readdirSync(apiDir).filter((f) => /\.js$/.test(f))
  assert.deepEqual(files, ['router.js'], `api/ must contain only router.js, found: ${files.join(', ')}`)
})

check('the handler shares the target literals rather than redefining them', () => {
  const h = read('../lib/handlers/intelligence-targets.js')
  assert.ok(
    /import \{[\s\S]*?TARGET_TYPES[\s\S]*?\} from '\.\.\/\.\.\/src\/services\/targetService\.js'/.test(h),
    'the handler must import the target literals, not redefine them'
  )
  for (const sym of ['TARGET_TYPES', 'TARGET_STATUSES', 'TARGET_COLUMNS']) {
    assert.ok(
      !new RegExp(`const ${sym}\\s*=`).test(h),
      `${sym} is redefined in the handler — a second copy is invisible to the CHECK-drift test`
    )
  }
  assert.ok(!/function slugify/.test(h), 'slugify is redefined in the handler')
})

check('the client id comes from the session, never the body', () => {
  const h = read('../lib/handlers/intelligence-targets.js')
  assert.ok(
    /auth\.profile\.client_id/.test(h),
    'the handler must derive client_id from the authenticated profile'
  )
})

console.log('\nmethod dispatch (behavioural)\n')

/**
 * Finding 2: every check above is a static regex over source text — none of them actually
 * calls the handler, so the route being two-thirds dead (applyApiSecurity's allowedMethods
 * defaults to ['POST'], and the handler called it without an override, so GET and PATCH
 * 405'd unconditionally before req.method dispatch ever ran) passed every check in this
 * file. This is the one BEHAVIOURAL check: it imports the real handler and drives real
 * method dispatch through the real applyApiSecurity() call site inside it — so removing
 * `allowedMethods` from that call site (restoring the exact bug) must fail this check.
 *
 * To stay deterministic and free of any live network call in this process (no real Supabase
 * project or credentials, no Redis), every request below is sent with:
 *   - NO Origin header — isOriginAllowed treats a missing Origin as a non-browser/
 *     server-to-server caller and returns true unconditionally (lib/_security.js), so CORS
 *     never needs a configured allowlist here.
 *   - NO Authorization header and NO internal-key header, with DEV_AUTH_BYPASS forced off
 *     for the duration of this check.
 * That combination guarantees requireAuthenticatedUser stops at "no bearer token" (401) or,
 * if this process has no Supabase admin env configured, at "Supabase admin env not
 * configured" (500) — in both cases BEFORE any query reaches a database. Rate limiting falls
 * back to the in-memory store automatically since no KV_REST_API_URL/UPSTASH_REDIS_REST_URL
 * is set in this process, so it needs no stubbing either. Neither 401 nor 500 is 405, which
 * is exactly the signal that proves method dispatch — not just CORS or rate limiting — ran
 * to completion for GET, POST and PATCH alike.
 *
 * NOT covered here: what GET/POST/PATCH actually DO once authenticated — that needs a live
 * Supabase project and stays the job of the static checks elsewhere in this file (column
 * pins, rollback/parent-domain logic walked out of the source). This check proves only that
 * the method is never rejected before business logic runs, which is precisely Finding 1's
 * defect and the gap Finding 2 names.
 */
function createMockRes() {
  return {
    statusCode: null,
    headers: {},
    body: undefined,
    ended: false,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
    end() { this.ended = true; return this },
    setHeader(name, value) { this.headers[name] = value; return this },
  }
}

function createMockReq(method) {
  return {
    method,
    headers: {},   // no origin, no authorization, no internal key — see comment above
    query: {},
    body: {},
    socket: { remoteAddress: '127.0.0.1' },
  }
}

async function withDevBypassForcedOff(fn) {
  const saved = process.env.DEV_AUTH_BYPASS
  delete process.env.DEV_AUTH_BYPASS
  try {
    await fn()
  } finally {
    if (saved === undefined) delete process.env.DEV_AUTH_BYPASS
    else process.env.DEV_AUTH_BYPASS = saved
  }
}

check('GET, POST and PATCH all reach method dispatch — none is rejected with 405', async () => {
  const { handler } = await import('../lib/handlers/intelligence-targets.js')
  await withDevBypassForcedOff(async () => {
    for (const method of ['GET', 'POST', 'PATCH']) {
      const req = createMockReq(method)
      const res = createMockRes()
      await handler(req, res)
      assert.notEqual(
        res.statusCode, 405,
        `${method} /api/intelligence-targets was rejected with 405 — applyApiSecurity's ` +
        `allowedMethods defaults to ['POST'], so the handler must pass allowedMethods: ` +
        `['GET', 'POST', 'PATCH'] explicitly (Finding 1)`
      )
      assert.ok(
        Number.isInteger(res.statusCode),
        `${method} /api/intelligence-targets never called res.status(...) — the handler did not respond`
      )
    }
  })
})

check('a genuinely unsupported method (DELETE) is still rejected — the fix must not fall open', async () => {
  const { handler } = await import('../lib/handlers/intelligence-targets.js')
  await withDevBypassForcedOff(async () => {
    const req = createMockReq('DELETE')
    const res = createMockRes()
    await handler(req, res)
    assert.equal(
      res.statusCode, 405,
      'DELETE must still 405 — allowedMethods must name exactly GET, POST and PATCH, not widen further'
    )
  })
})

console.log('\nrunning a product\n')

check('the run handler resolves targetId server-side', () => {
  const h = read('../lib/handlers/intelligence.js')
  assert.ok(/resolveRunTarget/.test(h), 'no server-side target resolution')
  const fn = (h.match(/async function resolveRunTarget[\s\S]*?\n}/) || [])[0]
  assert.ok(fn, 'resolveRunTarget is not defined')
  // The client_id ownership comparison and the archived/draft/missing-canonical-url guards
  // are NOT checked by keyword here — a regex asserting `target.client_id !== clientId` or
  // the word "archived" appears is satisfied by dead code like
  // `if (false && target.client_id !== clientId)`, which a mutation audit found (this file
  // used to assert exactly that regex, and it passed against the dead-code version). All
  // four guards are instead exercised for real, below, by actually invoking
  // resolveRunTarget against fixture targets.
})

/**
 * Load the REAL resolveRunTarget out of lib/handlers/intelligence.js and instantiate it as
 * a callable function via `new Function`, the same technique arrowConstBody's callers use
 * below for handleOpenTargetBrief. resolveRunTarget is a plain top-level `async function`
 * declaration that only ever touches its own parameters (auth, clientId, targetId) — no
 * closure over anything else in the module — so its extracted text is self-contained and
 * safe to instantiate standalone.
 */
function loadResolveRunTarget() {
  const h = read('../lib/handlers/intelligence.js')
  const fn = (h.match(/async function resolveRunTarget[\s\S]*?\n}/) || [])[0]
  assert.ok(fn, 'resolveRunTarget is not defined')
  // The function is evaluated on its own, so what it imports from the module is handed in.
  const factory = new Function('isUuid', `${fn}\nreturn resolveRunTarget;`)
  return factory(isUuid)
}

/**
 * A minimal stand-in for auth.supabaseAdmin that serves a fixed `target` row from
 * `intelligence_targets` and a fixed `sources` row from `intelligence_target_sources` —
 * exactly the two queries resolveRunTarget issues, in order.
 */
function fakeTargetsAdmin({ target, sources = null }) {
  const chain = (row) => ({
    select() { return this },
    eq() { return this },
    maybeSingle: async () => ({ data: row, error: null }),
  })
  return {
    from(table) {
      if (table === 'intelligence_targets') return chain(target)
      if (table === 'intelligence_target_sources') return chain(sources)
      throw new Error(`fakeTargetsAdmin: unexpected table "${table}"`)
    },
  }
}

// Genuine behavioural checks for the three status/setup guards inside resolveRunTarget.
// Each one actually INVOKES the real, extracted function against a fixture target and
// asserts it throws the specific rejection — not that some keyword appears in the source.
// `if (false && target.status === 'archived')` reads as source containing "archived" (the
// old check passed it) but never actually rejects an archived target (this one catches it).

check('resolveRunTarget genuinely refuses an archived target', async () => {
  const resolveRunTarget = loadResolveRunTarget()
  const admin = fakeTargetsAdmin({
    target: {
      id: '00000000-0000-4000-8000-0000000000a1', client_id: 'client-1', type: 'company', name: 'Acme',
      status: 'archived', target_domain: 'acme.com',
    },
  })
  await assert.rejects(
    () => resolveRunTarget({ supabaseAdmin: admin }, 'client-1', '00000000-0000-4000-8000-0000000000a1'),
    (err) => {
      assert.equal(err.statusCode, 409, 'an archived target must be rejected with 409')
      assert.match(err.message, /archived/i, 'the rejection must name the target as archived')
      return true
    },
    'resolveRunTarget did not reject an archived target — it must never be run'
  )
})

check('resolveRunTarget genuinely refuses a draft target', async () => {
  const resolveRunTarget = loadResolveRunTarget()
  const admin = fakeTargetsAdmin({
    target: {
      id: '00000000-0000-4000-8000-0000000000a2', client_id: 'client-1', type: 'company', name: 'Acme',
      status: 'draft', target_domain: 'acme.com',
    },
  })
  await assert.rejects(
    () => resolveRunTarget({ supabaseAdmin: admin }, 'client-1', '00000000-0000-4000-8000-0000000000a2'),
    (err) => {
      assert.equal(err.statusCode, 409, 'a draft target must be rejected with 409')
      assert.match(err.message, /not set up|draft/i, 'the rejection must say the target is not set up yet')
      return true
    },
    'resolveRunTarget did not reject a draft target — it is not finished being set up'
  )
})

check('resolveRunTarget genuinely refuses a product with no canonical URL', async () => {
  const resolveRunTarget = loadResolveRunTarget()
  const admin = fakeTargetsAdmin({
    target: {
      id: '00000000-0000-4000-8000-0000000000a3', client_id: 'client-1', type: 'product', name: 'Widget',
      status: 'active', target_domain: 'acme.com',
    },
    sources: { canonical_url: null, linkedin_url: null, supporting_urls: [], documents: [] },
  })
  await assert.rejects(
    () => resolveRunTarget({ supabaseAdmin: admin }, 'client-1', '00000000-0000-4000-8000-0000000000a3'),
    (err) => {
      assert.equal(err.statusCode, 409, 'a product with no canonical_url must be rejected with 409')
      assert.match(err.message, /no page/i, 'the rejection must say there is nothing to read yet')
      return true
    },
    'resolveRunTarget did not reject a product target with no canonical_url — there is nothing for it to read'
  )
})

check('resolveRunTarget genuinely allows an active target through (control)', async () => {
  // Without a passing control case, all three checks above could be satisfied by a
  // resolveRunTarget that unconditionally throws — proving nothing about the specific
  // guards. This confirms the same harness resolves a legitimate active target normally.
  const resolveRunTarget = loadResolveRunTarget()
  const admin = fakeTargetsAdmin({
    target: {
      id: '00000000-0000-4000-8000-0000000000a4', client_id: 'client-1', type: 'company', name: 'Acme',
      status: 'active', target_domain: 'acme.com',
    },
    sources: { canonical_url: 'https://acme.com', linkedin_url: null, supporting_urls: [], documents: [] },
  })
  const result = await resolveRunTarget({ supabaseAdmin: admin }, 'client-1', '00000000-0000-4000-8000-0000000000a4')
  assert.equal(result.target.id, '00000000-0000-4000-8000-0000000000a4')
  assert.equal(result.productContext, null, 'a company target carries no productContext')
})

check('resolveRunTarget genuinely refuses a target owned by a different client', async () => {
  // The regression this guards: `if (false && target.client_id !== clientId)` reads as
  // source containing the comparison (a keyword/regex check on the source text passes it
  // unchanged) but never actually rejects a cross-tenant target. Only a real invocation,
  // like the archived/draft/control cases above, catches that shape.
  const resolveRunTarget = loadResolveRunTarget()
  const admin = fakeTargetsAdmin({
    target: {
      id: '00000000-0000-4000-8000-0000000000a5', client_id: 'client-2', type: 'company', name: 'Someone Else Inc',
      status: 'active', target_domain: 'someoneelse.com',
    },
  })
  await assert.rejects(
    () => resolveRunTarget({ supabaseAdmin: admin }, 'client-1', '00000000-0000-4000-8000-0000000000a5'),
    (err) => {
      assert.equal(err.statusCode, 403, 'a target owned by another client must be rejected with 403')
      return true
    },
    'resolveRunTarget did not refuse a target belonging to a different client — a caller ' +
    'must never be able to run, and see the evidence for, another tenant\'s target'
  )
})

check('resolveRunTarget refuses a placeholder id without ever querying Postgres', async () => {
  // `prod_<timestamp>` is what the desk used to mint for a product saved only in the browser.
  const resolveRunTarget = loadResolveRunTarget()
  const admin = { from() { throw new Error('a non-uuid id must not reach the database') } }
  await assert.rejects(
    () => resolveRunTarget({ supabaseAdmin: admin }, 'client-1', 'prod_1791478297356'),
    (err) => {
      assert.equal(err.statusCode, 400)
      assert.doesNotMatch(err.message, /uuid|syntax/i, 'the founder must not be shown a Postgres error')
      return true
    }
  )
})

check('resolveRunTarget does not swallow a failed sources lookup', () => {
  const h = read('../lib/handlers/intelligence.js')
  const fn = (h.match(/async function resolveRunTarget[\s\S]*?\n}/) || [])[0]
  assert.ok(fn, 'resolveRunTarget is not defined')

  const sourcesIdx = fn.indexOf('intelligence_target_sources')
  assert.notEqual(sourcesIdx, -1, 'the sources lookup is gone — repoint this test')

  // The target lookup just above already does `if (error) throw error` — the sources
  // lookup must match it, or a transient DB failure here reads as "this product has no
  // sources" (a 409 telling the founder to fix something that is not broken) instead of
  // surfacing as the 500 it actually is.
  const nearby = fn.slice(Math.max(0, sourcesIdx - 200), sourcesIdx)
  assert.match(
    nearby, /const\s*\{\s*data:\s*sources,\s*error:\s*\w+\s*\}\s*=\s*await/,
    'the intelligence_target_sources query must destructure `error`, not just `data`'
  )

  const after = fn.slice(sourcesIdx)
  assert.match(
    after, /if\s*\(\s*\w*[Ee]rror\w*\s*\)\s*throw\s+\w*[Ee]rror\w*/,
    'a failed sources lookup must be thrown, not silently treated as "no sources"'
  )
})

check('a {targetId}-only request is not rejected before the target is resolved', () => {
  const h = read('../lib/handlers/intelligence.js')
  const fn = (h.match(/async function handleCreateJob[\s\S]*?\n}\n/) || [])[0]
  assert.ok(fn, 'handleCreateJob is not defined')

  const resolveIdx = fn.indexOf('resolveRunTarget(')
  assert.notEqual(resolveIdx, -1, 'handleCreateJob never resolves the target')

  const requiredIdx = fn.indexOf('Valid websiteUrl required')
  assert.notEqual(requiredIdx, -1, 'the websiteUrl-required message is gone — repoint this test')

  assert.ok(
    resolveIdx < requiredIdx,
    'the target must be resolved BEFORE the websiteUrl requirement is enforced, or a ' +
    '{targetId}-only request — exactly how the frontend calls this — 400s before the ' +
    'product target that would have supplied its own URL is ever looked at'
  )

  // The requirement itself must be conditioned on the run NOT resolving to a product
  // target. An unconditional check here is exactly what makes a targetId-only request fail,
  // no matter where in the function it sits.
  assert.match(
    fn, /if\s*\(\s*!isProductRun\s*&&\s*!websiteUrl\s*\)\s*\{[\s\S]{0,80}?Valid websiteUrl required/,
    'the websiteUrl requirement must be gated on !isProductRun — a product run supplies its own URL'
  )
})

check('the tier still comes from the reservation, never the target', () => {
  const h = read('../lib/handlers/intelligence.js')
  const fn = (h.match(/async function resolveRunTarget[\s\S]*?\n}/) || [])[0] || ''
  assert.ok(!/runTier|run_tier/.test(fn), 'target resolution must not touch the run tier')

  // A bare /reserveFounderRun/ match on the whole file is satisfied by the function's own
  // declaration — it would still pass with the call to it deleted from handleCreateJob
  // entirely. Anchor on handleCreateJob's own body and assert the call actually appears
  // inside it.
  const createFn = (h.match(/async function handleCreateJob[\s\S]*?\n}\n/) || [])[0]
  assert.ok(createFn, 'handleCreateJob is not defined')
  assert.ok(
    /reserveFounderRun\(/.test(createFn),
    'handleCreateJob never calls reserveFounderRun — the tier authority is unwired'
  )
})

check('serializeJob exposes target_id', () => {
  const jobs = read('../lib/_intelligenceJobs.js')
  assert.ok(/target_id:\s*job\.target_id/.test(jobs), 'serializeJob never returns target_id')
})

console.log('\ncreateIntelligenceJob survives a pre-v31 database\n')

/**
 * A minimal stand-in for supabaseAdmin.from('intelligence_jobs') that mimics PostgREST's
 * PGRST204 — the real failure mode on a database that has not run v31 — whenever the
 * insert payload names a `target_id` key at all, exactly like naming an unknown column.
 * Succeeds otherwise, returning the payload back as the "row".
 */
function fakeJobsAdminMissingTargetColumn() {
  let insertCount = 0
  return {
    insertCount: () => insertCount,
    from(table) {
      assert.equal(table, 'intelligence_jobs', `unexpected table "${table}"`)
      return {
        insert(payload) {
          insertCount++
          return {
            select() { return this },
            single: async () => ('target_id' in payload)
              ? { data: null, error: {
                  code: 'PGRST204',
                  message: "Could not find the 'target_id' column of 'intelligence_jobs' in the schema cache",
                } }
              : { data: { id: 'job-1', ...payload }, error: null },
          }
        },
      }
    },
  }
}

check('a company run survives an unmigrated database — the column is dropped and retried', async () => {
  const { createIntelligenceJob, __jobColumnCache } = await import('../lib/_intelligenceJobs.js')
  __jobColumnCache.reset()
  const admin = fakeJobsAdminMissingTargetColumn()

  const job = await createIntelligenceJob(admin, {
    clientId: 'client-1', createdBy: 'user-1', websiteUrl: 'https://acme.com',
    jobOrigin: 'founder', requestedByRole: 'client_user',
    // No targetId: this is a plain company run.
  })

  assert.ok(job && job.id, 'createIntelligenceJob threw or returned nothing for a plain company run')
  assert.ok(!('target_id' in job), 'the retried insert still carried the missing target_id column')
})

check('a decision run survives an unmigrated database the same way', async () => {
  const { createIntelligenceJob, __jobColumnCache } = await import('../lib/_intelligenceJobs.js')
  __jobColumnCache.reset()
  const admin = fakeJobsAdminMissingTargetColumn()

  const job = await createIntelligenceJob(admin, {
    clientId: 'client-1', createdBy: 'user-1', websiteUrl: 'https://acme.com',
    jobOrigin: 'founder', requestedByRole: 'client_user',
    analysisMode: 'decision', decisionId: 'dec-1', decisionContext: { raw_input: 'x' },
  })

  assert.ok(job && job.id, 'createIntelligenceJob threw or returned nothing for a decision run')
})

check('a product (target-scoped) run refuses rather than silently dropping its target', async () => {
  const { createIntelligenceJob, __jobColumnCache, TargetMigrationRequiredError } =
    await import('../lib/_intelligenceJobs.js')
  __jobColumnCache.reset()
  const admin = fakeJobsAdminMissingTargetColumn()

  await assert.rejects(
    () => createIntelligenceJob(admin, {
      clientId: 'client-1', createdBy: 'user-1', websiteUrl: 'https://acme.com/product',
      jobOrigin: 'founder', requestedByRole: 'client_user',
      analysisMode: 'product', targetId: 'target-1',
    }),
    (err) => {
      assert.ok(
        err instanceof TargetMigrationRequiredError || err.code === 'MIGRATION_REQUIRED',
        `expected a migration-required refusal, got: ${err.message}`
      )
      assert.match(
        err.message, /v37_intelligence_targets\.sql/,
        'the refusal must name the migration that needs to be applied'
      )
      return true
    },
    'a product run on an unmigrated database must be refused, not silently created as a ' +
    'targetless job that would then run — and report — as a plain company run'
  )
  assert.equal(admin.insertCount(), 1, 'a target-scoped run must not retry without target_id')
})

check('a cached "column missing" verdict from a prior company run does not leak into a later product run', async () => {
  // The unsafe shape this guards against: an optimistic-skip cache (like reportService's
  // columnState) learns "target_id is unavailable" from one call and then pre-emptively
  // omits it on every later call within the TTL — including a product run, which would
  // silently lose its target instead of failing loudly.
  const { createIntelligenceJob, __jobColumnCache, TargetMigrationRequiredError } =
    await import('../lib/_intelligenceJobs.js')
  __jobColumnCache.reset()
  const admin = fakeJobsAdminMissingTargetColumn()

  const companyJob = await createIntelligenceJob(admin, {
    clientId: 'client-1', createdBy: 'user-1', websiteUrl: 'https://acme.com',
    jobOrigin: 'founder', requestedByRole: 'client_user',
  })
  assert.ok(companyJob?.id, 'the priming company run should itself succeed')

  await assert.rejects(
    () => createIntelligenceJob(admin, {
      clientId: 'client-1', createdBy: 'user-1', websiteUrl: 'https://acme.com/product',
      jobOrigin: 'founder', requestedByRole: 'client_user',
      analysisMode: 'product', targetId: 'target-1',
    }),
    (err) => err instanceof TargetMigrationRequiredError || err.code === 'MIGRATION_REQUIRED',
    'a product run must still be refused after target_id is cached as missing from an ' +
    'earlier company run — the cache must never cause a silent drop for a target-scoped run'
  )
})

console.log('\nTargetSetupScreen: canonical URL validation\n')

/**
 * Isolate the body of a `const <name> = async (...) => { ... }` arrow function by
 * brace-matching from its opening `{`. `functionBody` above only matches a `function
 * <name>(...)` declaration, which handleSave is not — it's an arrow function bound to a
 * const, same as the rest of this component's handlers.
 */
function arrowConstBody(source, constName) {
  const declMatch = source.match(new RegExp(`const\\s+${constName}\\s*=\\s*async\\s*\\([^)]*\\)\\s*=>\\s*\\{`))
  assert.ok(declMatch, `${constName} not found as a "const ${constName} = async (...) => { ... }" arrow function`)
  const openIdx = source.indexOf(declMatch[0]) + declMatch[0].length - 1
  let depth = 0
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(openIdx, i + 1)
  }
  throw new Error(`unbalanced braces in ${constName}`)
}

check('handleSave submits validateWebsiteUrl\'s normalized output, not the raw input', () => {
  // Finding 1: the canonical-URL input is type="url" but there is no <form> and the
  // submit button is type="button", so the browser's native URL validation never fires.
  // Before this fix, the raw trimmed string went straight to createTarget, which checks
  // only that it is non-empty — "asdf" produced an active, unscrapeable target.
  //
  // A regex asserting the identifier `validateWebsiteUrl` merely appears in the file
  // would pass even if the call's result were computed and discarded. This isolates
  // handleSave's actual body and proves three things about the real control flow: (1)
  // validateWebsiteUrl is called on the raw canonicalUrl state, (2) an invalid result
  // returns before createTarget is ever reached, and (3) the value bound to
  // sources.canonicalUrl inside the createTarget(...) call is the validator's own
  // `.normalized` field on that same result variable — not `canonicalUrl` (raw) and not
  // `canonicalUrl.trim()` (the pre-fix behaviour).
  const src = read('../src/components/intelligence/TargetSetupScreen.jsx')

  assert.match(
    src, /import\s*\{\s*validateWebsiteUrl\s*\}\s*from\s*'\.\.\/\.\.\/utils\/urlValidation'/,
    'TargetSetupScreen must import validateWebsiteUrl from src/utils/urlValidation.js'
  )

  const fn = arrowConstBody(src, 'handleSave')

  const validateMatch = fn.match(/const\s+(\w+)\s*=\s*validateWebsiteUrl\(\s*canonicalUrl\s*\)/)
  assert.ok(
    validateMatch,
    'handleSave must call validateWebsiteUrl(canonicalUrl) and capture its result — a call ' +
    'whose return value is never bound cannot gate submission or supply a normalized value'
  )
  const resultVar = validateMatch[1]
  const validateIdx = fn.indexOf(validateMatch[0])

  // Invalid input must stop the submission before createTarget is called at all — not
  // merely before some later step.
  const createIdx = fn.indexOf('await createTarget(')
  assert.notEqual(createIdx, -1, 'handleSave never calls createTarget')
  assert.ok(validateIdx < createIdx, 'validateWebsiteUrl must run before createTarget is called')

  const guardSlice = fn.slice(validateIdx, createIdx)
  assert.match(
    guardSlice, new RegExp(`if\\s*\\(\\s*!\\s*${resultVar}\\.ok\\s*\\)\\s*\\{[\\s\\S]*?return`),
    `handleSave must check !${resultVar}.ok and return before reaching createTarget — a ` +
    'validation failure that does not stop submission still lets a raw invalid string through'
  )

  // The value actually passed as sources.canonicalUrl inside the createTarget(...) call
  // must be <resultVar>.normalized — proving the NORMALIZED value is what gets persisted,
  // not the raw canonicalUrl state and not a re-derived .trim() of it.
  const createArgs = callArguments(fn, 'createTarget', createIdx)
  const sourcesMatch = createArgs.match(/sources\s*:\s*\{([\s\S]*?)\n\s{12}\}/)
  assert.ok(sourcesMatch, 'could not isolate the sources: {...} block passed to createTarget')
  const canonicalUrlBound = boundValue(sourcesMatch[1], 'canonicalUrl')
  assert.equal(
    canonicalUrlBound, `${resultVar}.normalized`,
    `createTarget's sources.canonicalUrl binds '${canonicalUrlBound}', not ` +
    `'${resultVar}.normalized' — submitting the raw string (or a re-trim of it) means what ` +
    'is stored is not what the validator actually approved'
  )
})

console.log('\ndesk\n')

check('the Desk renders the targets band between today and the agenda', () => {
  const desk = read('../src/components/intelligence/Desk.jsx')
  assert.ok(/TargetList/.test(desk), 'Desk does not render TargetList')
  const todayIdx = desk.indexOf('today-heading')
  const targetsIdx = desk.indexOf('<TargetList')
  const agendaIdx = desk.indexOf('<AgendaPanel')
  assert.ok(todayIdx > -1 && targetsIdx > -1 && agendaIdx > -1, 'a band is missing')
  assert.ok(todayIdx < targetsIdx, 'targets must come after today')
  assert.ok(targetsIdx < agendaIdx, 'targets must come before the agenda')
})

check('archiving never deletes reports', () => {
  const svc = read('../src/services/targetService.js')
  const fn = (svc.match(/export const archiveTarget[\s\S]{0,200}/) || [])[0] || ''
  assert.ok(/status: 'archived'/.test(fn), 'archive must set a status, not delete')
  // Scoped to updateTarget — the function archiveTarget actually calls — not the whole
  // file: targetService.js also has a narrow, separately-tested rollback delete() in
  // createTarget for a target row that never finished being created (no report, never
  // promoted out of draft). That is a different feature, already pinned above by
  // 'createTarget checks both follow-up insert errors and rolls back the target row on
  // failure', and this check must not collide with it.
  const updateFn = functionBody(svc, 'updateTarget')
  assert.ok(!/\.delete\(\)/.test(updateFn), 'archiveTarget must never issue a delete')
})

check('every interactive control is a real button with an accessible name', () => {
  for (const f of ['TargetCard.jsx', 'TargetList.jsx', 'TargetSetupScreen.jsx']) {
    const src = read(`../src/components/intelligence/${f}`)
    // Clickable divs are unreachable by keyboard. Buttons and anchors are not.
    assert.ok(!/<div[^>]*onClick=/.test(src), `${f} has a click handler on a div`)
    // An icon-only button needs a label a screen reader can announce.
    const iconOnly = [...src.matchAll(/<button(?![^>]*aria-label)[^>]*>\s*<[A-Z][a-zA-Z]*\s[^>]*\/>\s*<\/button>/g)]
    assert.equal(iconOnly.length, 0, `${f} has an icon-only button with no aria-label`)
  }
})

check('the new components use tokens, never raw colours', () => {
  for (const f of ['TargetCard.jsx', 'TargetList.jsx', 'TargetSetupScreen.jsx']) {
    const src = read(`../src/components/intelligence/${f}`)
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(src), `${f} hardcodes a hex colour`)
    assert.ok(!/\b(?:text|bg|border)-slate-\d/.test(src), `${f} uses a raw slate-* scale`)
  }
})

check('the Desk keeps rendering when the target store is empty', () => {
  const desk = read('../src/components/intelligence/Desk.jsx')
  assert.ok(
    /targets\.length\s*>\s*0|targets\?\.\length|targets && targets\.length/.test(desk),
    'the targets band must be conditional so an un-migrated deployment renders a clean Desk'
  )
})

console.log('\nfinal review: four wiring defects\n')

// A mutation audit of this suite found that most of its assertions check for a KEYWORD
// somewhere in a file rather than a PROPERTY actually holding — a check that passes
// whether or not the wiring it names exists. The four checks below each isolate the
// real object or argument list being built and assert what a specific key is BOUND to,
// the same discipline callArguments/boundValue/arrowConstBody above exist for.

check(
  "IntelligenceDashboard wires <Desk>'s onRunTarget to a handler that actually starts a job for the clicked target",
  () => {
    const src = read('../src/components/IntelligenceDashboard.jsx')
    const deskIdx = src.indexOf('<Desk')
    assert.notEqual(deskIdx, -1, 'IntelligenceDashboard never renders <Desk>')
    const deskClose = src.indexOf('/>', deskIdx)
    assert.notEqual(deskClose, -1, 'could not find the end of the <Desk ... /> element')
    const deskProps = src.slice(deskIdx, deskClose)

    const propMatch = deskProps.match(/onRunTarget=\{([^}]+)\}/)
    assert.ok(
      propMatch,
      'Desk is rendered without an onRunTarget prop — every "Run intelligence" click stays ' +
      'the no-op this finding names: a spinner turns on and off, and nothing happens'
    )
    const bound = propMatch[1].trim()
    assert.doesNotMatch(
      bound, /^(null|undefined)$/,
      'onRunTarget is bound to null/undefined — identical to Desk\'s own default prop value, ' +
      'i.e. identical to never passing it at all'
    )

    // Resolve to the actual handler's body, whether it is a plain function declaration or
    // (as implemented) a `const x = async (...) => {...}` arrow bound to a name. A bare
    // substring match on the JSX prop text alone would still pass if the bound identifier
    // were a stub that never touches the network — exactly the shape a superficial fix
    // could take.
    assert.match(
      bound, /^[A-Za-z_$][\w$]*$/,
      `onRunTarget is bound to an inline expression ("${bound}") rather than a named handler — ` +
      'cannot verify what it actually does'
    )
    const handlerBody = arrowConstBody(src, bound)

    assert.match(
      handlerBody, /submitIntelligenceJob\(/,
      `${bound} never calls submitIntelligenceJob — it must reuse the existing job-submission ` +
      'path (the same client helper, the same job-polling and phase transitions), not invent a second one'
    )
    const argsBlock = callArguments(handlerBody, 'submitIntelligenceJob')
    const targetIdBound = boundValue(argsBlock, 'targetId')
    assert.equal(
      targetIdBound, 'target.id',
      `submitIntelligenceJob's targetId is bound to "${targetIdBound}", not target.id — the server ` +
      'resolves the entire run from this id, so the wrong value (or none) runs nothing real'
    )
  }
)

check(
  "the persist path binds report_kind to product mode and target_id to the job's own target",
  () => {
    // 1) intelligenceService.js: the ARGUMENT OBJECT actually passed to saveReport at the
    //    one real call site (persist), not merely somewhere PRODUCT_MODE is imported.
    // boundValue only resolves a single identifier/member-path token, and this binding is
    // a short-circuit expression (`ctx.job.targetId || null`), so isolate it directly —
    // same technique as boundValue, widened to stop at the key's own trailing comma.
    const persistArgs = callArguments(pipeline, 'saveReport')
    const targetIdMatch = persistArgs.match(/\btargetId\s*:\s*([^,\n]+)/)
    assert.ok(targetIdMatch, 'the saveReport(...) call never binds a targetId key')
    assert.equal(
      targetIdMatch[1].trim(), 'ctx.job.targetId || null',
      `saveReport's targetId argument is bound to "${targetIdMatch[1].trim()}", not ` +
      'ctx.job.targetId || null — a product run would be persisted with no link back to the target that produced it'
    )

    // 2) reportService.js: the OBJECT ACTUALLY WRITTEN to the reports table.
    const svc = read('../src/services/reportService.js')
    const saveBody = functionBody(svc, 'saveReport')

    const reportKindMatch = saveBody.match(/report_kind:\s*([^\n]+),/)
    assert.ok(reportKindMatch, 'saveReport never binds report_kind in its write payload')
    assert.match(
      reportKindMatch[1], /PRODUCT_MODE/,
      `saveReport writes report_kind bound to "${reportKindMatch[1].trim()}" — it never branches ` +
      "on PRODUCT_MODE, so a product run is still persisted as report_kind='company'"
    )

    const targetIdColMatch = saveBody.match(/\btarget_id:\s*([^\n,]+)/)
    assert.ok(targetIdColMatch, 'saveReport never binds target_id in its write payload')
    assert.equal(
      targetIdColMatch[1].trim(), 'targetId || null',
      `saveReport writes target_id bound to "${targetIdColMatch[1].trim()}", not targetId || null`
    )
  }
)

check("Desk.jsx forwards TargetList's onOpenBrief argument rather than dropping it", () => {
  const desk = read('../src/components/intelligence/Desk.jsx')
  const targetListIdx = desk.indexOf('<TargetList')
  assert.notEqual(targetListIdx, -1, 'Desk no longer renders TargetList')
  const targetListClose = desk.indexOf('/>', targetListIdx)
  assert.notEqual(targetListClose, -1, 'could not find the end of the <TargetList ... /> element')
  const props = desk.slice(targetListIdx, targetListClose)

  const propMatch = props.match(/onOpenBrief=\{([^}]+)\}/)
  assert.ok(propMatch, 'TargetList is rendered without an onOpenBrief prop')
  const bound = propMatch[1].trim()

  // The pre-fix shape was `onOpenBrief ? () => onOpenBrief() : null` — a wrapper that
  // calls the prop with NO arguments, discarding whatever TargetCard passed. Asserting
  // "a prop named onOpenBrief exists" would still pass with that wrapper in place; this
  // asserts what happens to the argument, which is the actual bug.
  assert.doesNotMatch(
    bound, /\(\s*\)\s*=>\s*onOpenBrief\s*\(\s*\)/,
    `onOpenBrief is bound to "${bound}" — a zero-argument wrapper discards the target ` +
    "TargetCard passed, so a click on any card opens the company's brief under that card's name"
  )
  assert.ok(
    bound === 'onOpenBrief' || /^\(\s*[\w$]+\s*\)\s*=>\s*onOpenBrief\(\s*[\w$]+\s*\)$/.test(bound),
    `onOpenBrief is bound to "${bound}" — expected a direct pass-through (onOpenBrief) or an ` +
    'arrow that forwards its own argument to onOpenBrief, not a rebinding that loses it'
  )
})

check(
  "a target run's website URL is derived from the resolved target's target_domain, never from canonical_url",
  () => {
    const h = read('../lib/handlers/intelligence.js')
    const fn = (h.match(/async function handleCreateJob[\s\S]*?\n}\n/) || [])[0]
    assert.ok(fn, 'handleCreateJob is not defined')

    const match = fn.match(/const effectiveWebsiteUrl\s*=\s*([\s\S]*?);/)
    assert.ok(match, 'handleCreateJob never binds effectiveWebsiteUrl')
    const expr = match[1]

    assert.doesNotMatch(
      expr, /canonical_url/,
      `effectiveWebsiteUrl is bound to "${expr.trim()}" — it still reads the product's own ` +
      "canonical_url as the run's identity, which can file the report under a domain the Desk, " +
      'the Agenda, Reads, daily_checks and both crons are not keyed on and can never find'
    )
    assert.match(
      expr, /runTarget\.target\.target_domain/,
      `effectiveWebsiteUrl is bound to "${expr.trim()}" — it must derive from the resolved ` +
      "target's own target_domain (the parent company's domain, carried verbatim per v31) " +
      'whenever a target was resolved'
    )
  }
)

console.log('\nfinal fix pass — N1/N2/N3, and T1–T5 mutation coverage\n')

// T3: the check above ("a target run's website URL is derived...") only proves
// effectiveWebsiteUrl is DEFINED correctly. It says nothing about whether the job insert
// actually USES it — C4's expression can be left in place, computed, and simply never
// referenced by the call that matters. This isolates the createIntelligenceJob(...) call's
// own argument block and asserts what its websiteUrl KEY is bound to.
check(
  "handleCreateJob's createIntelligenceJob call binds websiteUrl to effectiveWebsiteUrl, never the caller's raw websiteUrl (T3)",
  () => {
    const h = read('../lib/handlers/intelligence.js')
    const fn = (h.match(/async function handleCreateJob[\s\S]*?\n}\n/) || [])[0]
    assert.ok(fn, 'handleCreateJob is not defined')

    const args = callArguments(fn, 'createIntelligenceJob')
    const bound = boundValue(args, 'websiteUrl')
    assert.equal(
      bound, 'effectiveWebsiteUrl',
      `createIntelligenceJob's websiteUrl argument is bound to "${bound}", not effectiveWebsiteUrl ` +
      "— C4's whole point (identity decoupled from source) is computed two lines above and then " +
      "never used: a product run would file its job under the caller's raw websiteUrl instead of " +
      "the resolved target's own target_domain, making the run invisible to the Desk, the Agenda, " +
      'Reads, daily_checks and both crons — all keyed on target_domain'
    )
  }
)

// N4: the T4/N1 check below proves the targetId ARGUMENT is bound correctly once
// saveCompanyContext is actually called — it says nothing about whether the call happens
// at all. The GUARD wrapping it used to be `if (profile?.client_id && urlInput)`, and
// handleRunTarget (the real path a founder uses: Desk → Run on a product card) never sets
// urlInput — so on that path the guard was false and saveCompanyContext was never called,
// silently discarding every review edit. This isolates the REAL runConfirmContext body and
// actually RUNS it, twice, with every free variable it closes over stubbed out: once
// simulating a product run (urlInput empty, exactly as handleRunTarget leaves it) and once
// simulating today's company run (urlInput set) — proving the guard now fires for both, and
// with the right websiteUrl/targetId in each case, not merely that it fires for the one
// urlInput happens to be set for.
function runConfirmContextHarness({ urlInput, jobResponse }) {
  const src = read('../src/components/IntelligenceDashboard.jsx')
  const body = arrowConstBody(src, 'runConfirmContext')

  const calls = { saveCompanyContext: [], setPhase: [] }
  const confirmingContextRef = { current: false }
  const setReadinessGate = () => {}
  const setIsConfirmingContext = () => {}
  const setStatusMsg = () => {}
  const contextData = { _userEdits: { fields: [], removed: [] } } // no _onboardingData: enrichContextWithOnboarding must not be called
  const enrichContextWithOnboarding = () => { throw new Error('must not be called when contextData has no _onboardingData') }
  const setContextData = () => { throw new Error('must not be called when finalContext === contextData') }
  const activeJobId = null // exercise the submit branch, same as a fresh run
  const resumeIntelligenceJob = async () => { throw new Error('must not be called when activeJobId is null') }
  const linkedinInput = null
  const submitIntelligenceJob = async () => jobResponse
  const analysisMode = 'company'
  const setActiveJobId = () => {}
  const profile = { client_id: 'client-1' }
  const contextOrigin = 'inherited'
  const saveCompanyContext = async (args) => { calls.saveCompanyContext.push(args) }
  const setPhase = (p) => { calls.setPhase.push(p) }

  const factory = new Function(
    'confirmingContextRef', 'setReadinessGate', 'setIsConfirmingContext', 'setStatusMsg',
    'contextData', 'enrichContextWithOnboarding', 'setContextData', 'activeJobId',
    'resumeIntelligenceJob', 'urlInput', 'linkedinInput', 'submitIntelligenceJob',
    'analysisMode', 'setActiveJobId', 'profile', 'contextOrigin', 'saveCompanyContext', 'setPhase',
    `return async () => ${body}`
  )
  const runConfirmContext = factory(
    confirmingContextRef, setReadinessGate, setIsConfirmingContext, setStatusMsg,
    contextData, enrichContextWithOnboarding, setContextData, activeJobId,
    resumeIntelligenceJob, urlInput, linkedinInput, submitIntelligenceJob,
    analysisMode, setActiveJobId, profile, contextOrigin, saveCompanyContext, setPhase
  )
  return { runConfirmContext, calls }
}

check(
  "runConfirmContext saves context for a PRODUCT run even though urlInput is empty (N4)",
  async () => {
    // Exactly how handleRunTarget leaves things: urlInput was never touched, but the job
    // the server just created/resumed knows its own website_url (the parent's domain, by
    // v31 design) and its own target_id.
    const { runConfirmContext, calls } = runConfirmContextHarness({
      urlInput: '',
      jobResponse: { id: 'job-1', current_step: 'Queued', website_url: 'parent-company.com', target_id: 'product-9' },
    })
    await runConfirmContext()
    assert.equal(
      calls.saveCompanyContext.length, 1,
      'saveCompanyContext was never called for a product run with empty urlInput — a guard ' +
      "still keyed on urlInput silently discards every review edit made on the Desk → Run " +
      'path, which never sets urlInput at all'
    )
    assert.equal(
      calls.saveCompanyContext[0].websiteUrl, 'parent-company.com',
      "the saved websiteUrl must come from the job's own website_url when urlInput is empty"
    )
    assert.equal(
      calls.saveCompanyContext[0].targetId, 'product-9',
      "the saved targetId must still be the product's own target, never the company's"
    )
  }
)

check(
  "runConfirmContext still saves context for a COMPANY run exactly as before (N4 control)",
  async () => {
    const { runConfirmContext, calls } = runConfirmContextHarness({
      urlInput: 'acme.com',
      jobResponse: { id: 'job-2', current_step: 'Queued', website_url: 'acme.com', target_id: null },
    })
    await runConfirmContext()
    assert.equal(calls.saveCompanyContext.length, 1, 'a company run must still save its reviewed context')
    assert.equal(calls.saveCompanyContext[0].websiteUrl, 'acme.com')
    assert.equal(calls.saveCompanyContext[0].targetId, null, 'a company run must never bind a targetId')
  }
)

// T4 / N1: urlInput is, by design, the PARENT company's domain for a product run (seeded
// from job.website_url on a mid-build reload; or simply stale after the founder cancels the
// context gate and runs a product from the Desk instead). Any saveCompanyContext(...) write
// keyed off it — or with no targetId bound at all — resolves the v31 RPC's p_target_id to
// the COMPANY target and silently demotes the founder-approved company context. This
// isolates runConfirmContext's own saveCompanyContext(...) call and asserts what its
// targetId KEY is bound to: the run actually in flight (the job just resumed/submitted),
// never urlInput.
check(
  "runConfirmContext's saveCompanyContext call binds targetId to the in-flight job's own target, never to urlInput (T4 / N1)",
  () => {
    const src = read('../src/components/IntelligenceDashboard.jsx')
    const fn = arrowConstBody(src, 'runConfirmContext')

    const args = callArguments(fn, 'saveCompanyContext')
    // boundValue only resolves a bare identifier/member-path token; this binding is a
    // short-circuit expression (`job.target_id || null`), so isolate it directly — same
    // technique the "persist path" check above uses for ctx.job.targetId || null.
    const match = args.match(/\btargetId\s*:\s*([^,\n]+)/)
    assert.ok(
      match,
      "runConfirmContext's saveCompanyContext(...) call never binds a targetId key — a product " +
      "run's reviewed context would then always be written against the COMPANY's own target (N1)"
    )
    const bound = match[1].trim()
    assert.equal(
      bound, 'job.target_id || null',
      `saveCompanyContext's targetId argument is bound to "${bound}", not job.target_id || null. ` +
      '`job` here is the response from the resumeIntelligenceJob/submitIntelligenceJob call just ' +
      "above — the one value that actually names the run in flight (serializeJob's own target_id, " +
      "unchanged since job creation). Binding anything derived from urlInput, or nothing at all, " +
      'reopens N1: a hit on the company target for every product run.'
    )
    assert.doesNotMatch(
      bound, /urlInput/,
      'targetId must not be derived from urlInput in any form — that is exactly the N1 regression ' +
      "this check exists to catch (urlInput holds the PARENT company's domain during a product run)"
    )
  }
)

// T2 / C3: a product that has never been run must show "hasn't been read yet", never
// another subject's brief. Rather than grep the source for the word "return" (which a
// helpful-looking `await loadReport(history[0])` added right before that return would
// still satisfy), this extracts the REAL handleOpenTargetBrief body and executes it with
// controlled stand-ins for every free variable it closes over — genuine behaviour, not a
// text match — then asserts what it actually did when the target's own lookup resolves to
// nothing.
check(
  "a never-run product's Latest-brief click never falls back to the company's own report (T2 / C3)",
  async () => {
    const src = read('../src/components/IntelligenceDashboard.jsx')
    const body = arrowConstBody(src, 'handleOpenTargetBrief')

    const calls = { loadReport: [] }
    const loadReport = async (report) => { calls.loadReport.push(report) }
    // Stands in for the company's own most recent brief. If handleOpenTargetBrief ever
    // falls through to this for a product, THIS is what would render under the product's name.
    const history = [{ id: 'company-report-1', website_url: 'acme.com' }]
    const getLastReportForTarget = async () => ({ data: null, error: null }) // never run
    const profile = { client_id: 'client-1' }
    let toastCount = 0
    const toast = Object.assign(() => { toastCount += 1 }, { error: () => { toastCount += 1 } })
    const mapReportRowToAppReport = (row) => row

    const factory = new Function(
      'loadReport', 'history', 'getLastReportForTarget', 'profile', 'toast', 'mapReportRowToAppReport',
      `return async (target) => ${body}`
    )
    const handleOpenTargetBrief = factory(
      loadReport, history, getLastReportForTarget, profile, toast, mapReportRowToAppReport
    )

    await handleOpenTargetBrief({ id: 'product-1', type: 'product', name: 'Widget' })

    assert.deepEqual(
      calls.loadReport, [],
      'a never-run product must open NO report at all — any loadReport(...) call here (with ' +
      "getLastReportForTarget resolving nothing) can only be a fallback to the company's own " +
      "history — exactly the C3 regression this check exists to catch: one subject's evidence " +
      "presented under another subject's name"
    )
    assert.equal(toastCount, 1, 'the founder must be told the product has not been read yet, exactly once')
  }
)

// T3 / N3 (mutation hardening): the check above only exercises the "never run" branch,
// where mapReportRowToAppReport is never reached at all — an identity stub there cannot
// tell a real mapping call apart from no call. This exercises the "found a report" branch
// instead, with a NON-identity stub that records every call, and asserts (a) it was
// actually called with the raw row handleOpenTargetBrief fetched, and (b) the value hitting
// loadReport is that stub's OWN return value — not the raw row. Deleting the mapping call
// in the real source (`await loadReport(data)` instead of `await
// loadReport(mapReportRowToAppReport(data))`) makes (a) fail; routing around the stub's
// return value makes (b) fail. Either regression silently hides a shallow product run's
// timestamp and depth gaps (N3) behind an unmapped raw row.
check(
  "a found product brief is routed through mapReportRowToAppReport, and loadReport receives ITS return value, not the raw row",
  async () => {
    const src = read('../src/components/IntelligenceDashboard.jsx')
    const body = arrowConstBody(src, 'handleOpenTargetBrief')

    const calls = { loadReport: [], mapReportRowToAppReport: [] }
    const loadReport = async (report) => { calls.loadReport.push(report) }
    const history = [{ id: 'company-report-1', website_url: 'acme.com' }]
    const rawRow = { id: 'product-report-1', context: {}, website_url: 'acme.com', report_kind: 'product' }
    const getLastReportForTarget = async () => ({ data: rawRow, error: null })
    const profile = { client_id: 'client-1' }
    const toast = Object.assign(() => {}, { error: () => {} })
    // Deliberately NOT an identity function — the returned object is a distinct value
    // (a new wrapper, not even a spread of the input) so "loadReport got the raw row"
    // and "loadReport got the mapped row" can never be confused with each other.
    const mapReportRowToAppReport = (row) => {
      calls.mapReportRowToAppReport.push(row)
      return { __mapped: true, sourceId: row.id }
    }

    const factory = new Function(
      'loadReport', 'history', 'getLastReportForTarget', 'profile', 'toast', 'mapReportRowToAppReport',
      `return async (target) => ${body}`
    )
    const handleOpenTargetBrief = factory(
      loadReport, history, getLastReportForTarget, profile, toast, mapReportRowToAppReport
    )

    await handleOpenTargetBrief({ id: 'product-1', type: 'product', name: 'Widget' })

    assert.equal(
      calls.mapReportRowToAppReport.length, 1,
      'mapReportRowToAppReport was never called — a found product report must be mapped ' +
      'before it reaches loadReport, the same as every other raw-row call site in this file'
    )
    assert.equal(
      calls.mapReportRowToAppReport[0], rawRow,
      'mapReportRowToAppReport must be called with the raw row getLastReportForTarget returned'
    )
    assert.equal(calls.loadReport.length, 1, 'loadReport must be called exactly once for a found report')
    assert.deepEqual(
      calls.loadReport[0], { __mapped: true, sourceId: 'product-report-1' },
      "loadReport must receive mapReportRowToAppReport's OWN return value — not the raw row " +
      '(that would be { __mapped: true, ... } vs the untouched rawRow object) — a bypass here ' +
      'is invisible to an identity stub but silently ships a product report with no timestamp ' +
      'and no depth-gap disclosure'
    )
  }
)

/**
 * Isolate a `marker { ... }` block (an `if` statement here) by brace-matching from the
 * marker's own opening brace, INCLUDING the marker text itself — so the returned string can
 * be pasted directly into a function body and executed as-is.
 */
function ifBlockBody(source, marker) {
  const idx = source.indexOf(marker)
  assert.notEqual(idx, -1, `"${marker}" not found — this test is pinned to it`)
  const open = source.indexOf('{', idx)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(idx, i + 1)
  }
  throw new Error(`unbalanced braces after "${marker}"`)
}

/**
 * A minimal, REAL in-memory interpreter for the handful of PostgREST-style filter chain
 * calls the list endpoint actually uses (.eq, .neq, .or, .order, .limit) — enough to execute
 * the genuine extracted server code against a fixture row set and observe what it actually
 * returns, rather than asserting the filter text merely appears somewhere in the source.
 * `.neq` mirrors real SQL: `column <> value` is NULL (excluded), never true, when the
 * column itself is NULL — the exact subtlety a bare `.neq('report_kind', 'product')` gets
 * wrong for a pre-migration row and the reason this check exists.
 */
function fakeReportsSource(rows) {
  return {
    from(table) {
      assert.equal(table, 'reports', 'the list endpoint must query the reports table')
      const state = { filters: [], limit: null }
      const builder = {
        select() { return builder },
        eq(col, val) { state.filters.push({ type: 'eq', col, val }); return builder },
        neq(col, val) { state.filters.push({ type: 'neq', col, val }); return builder },
        or(expr) { state.filters.push({ type: 'or', expr }); return builder },
        order() { return builder },
        limit(n) { state.limit = n; return builder },
        then(resolve, reject) {
          try {
            let result = rows.filter((row) => state.filters.every((f) => {
              if (f.type === 'eq') return row[f.col] === f.val
              if (f.type === 'neq') return row[f.col] != null && row[f.col] !== f.val
              if (f.type === 'or') {
                const terms = f.expr.split(',').map((t) => {
                  const [col, op, ...rest] = t.split('.')
                  return { col, op, val: rest.join('.') }
                })
                return terms.some((t) => {
                  if (t.op === 'is' && t.val === 'null') return row[t.col] === null || row[t.col] === undefined
                  if (t.op === 'neq') return row[t.col] !== t.val
                  if (t.op === 'eq') return row[t.col] === t.val
                  return false
                })
              }
              return true
            }))
            if (state.limit != null) result = result.slice(0, state.limit)
            resolve({ data: result, error: null })
          } catch (err) {
            reject(err)
          }
        },
      }
      return builder
    },
  }
}

// T5 / N2: the company card's "Latest brief", the Desk's quiet-day invitation, lastReadAt
// and the history drawer all read from ONE list — GET /api/report?list=1 — so proving this
// one server-side lookup excludes product reports proves the property for all four
// consumers at once. This executes the REAL extracted LIST MODE code (brace-matched out of
// lib/handlers/report.js, not paraphrased) against a fixture row set through a real —
// if minimal — filter interpreter, so a regression that removes or weakens the filter is
// caught by what the endpoint actually returns.
check(
  'the company-scoped history list excludes product reports, including ones written before report_kind existed (T5 / N2)',
  async () => {
    const h = read('../lib/handlers/report.js')
    const block = ifBlockBody(h, 'if (req.query?.list) {')

    const rows = [
      { id: 'r-company-null', created_at: '2024-01-05', client_id: 'client-1', created_by: 'user-1', report_kind: null },
      { id: 'r-company-explicit', created_at: '2024-01-04', client_id: 'client-1', created_by: 'user-1', report_kind: 'company' },
      { id: 'r-decision', created_at: '2024-01-03', client_id: 'client-1', created_by: 'user-1', report_kind: 'decision' },
      { id: 'r-product', created_at: '2024-01-02', client_id: 'client-1', created_by: 'user-1', report_kind: 'product' },
      { id: 'r-other-client', created_at: '2024-01-06', client_id: 'client-2', created_by: 'user-2', report_kind: null },
    ]
    const supabaseAdmin = fakeReportsSource(rows)
    const profile = { client_id: 'client-1' }
    const user = { id: 'user-1' }
    const req = { query: { list: '1' } }
    const res = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this },
      json(payload) { this.body = payload; return this },
    }

    const factory = new Function(
      'req', 'res', 'supabaseAdmin', 'profile', 'user',
      `return (async () => { ${block} })()`
    )
    await factory(req, res, supabaseAdmin, profile, user)

    assert.equal(res.statusCode, 200, 'the fixture request must succeed')
    const ids = (res.body?.reports || []).map((r) => r.id)

    assert.ok(
      !ids.includes('r-product'),
      'a product report (report_kind=\'product\') must never appear in the company-scoped ' +
      'history list — this is what the company card, the quiet-day invitation, lastReadAt and ' +
      'the history drawer all read history[0] from'
    )
    assert.ok(
      ids.includes('r-company-null'),
      "a report written before report_kind existed (NULL) must still appear — SQL's " +
      "`NULL <> 'product'` is NULL, not true, so a bare .neq('report_kind','product') would " +
      'silently drop every pre-migration company report from this list, which is its own ' +
      'quiet-loss regression'
    )
    assert.ok(ids.includes('r-company-explicit'), "an explicit report_kind='company' row must still appear")
    assert.ok(ids.includes('r-decision'), 'a decision report is not a product report and must still appear')
    assert.ok(
      !ids.includes('r-other-client'),
      "the list must stay scoped to the caller's own client — never another client's reports"
    )
  }
)

/**
 * A minimal, REAL in-memory interpreter for the query-builder chain getLastReportForUrl
 * actually uses (.eq, .or, .order, .limit, .maybeSingle) — same discipline as
 * fakeReportsSource above, extended with .maybeSingle() since getLastReportForUrl calls
 * that instead of awaiting the builder directly. Rows are trusted to already be given in
 * the order `.order('created_at', {ascending:false})` would produce — this fixture is not
 * about proving ORDER BY works, it is about proving the product-exclusion filter is
 * actually present in both queries the function issues.
 */
function fakeReportsQueryBuilder(rows) {
  return {
    from(table) {
      assert.equal(table, 'reports', 'getLastReportForUrl must query the reports table')
      const state = { filters: [], limit: null }
      const builder = {
        select() { return builder },
        eq(col, val) { state.filters.push({ type: 'eq', col, val }); return builder },
        or(expr) { state.filters.push({ type: 'or', expr }); return builder },
        order() { return builder },
        limit(n) { state.limit = n; return builder },
        async maybeSingle() {
          let result = rows.filter((row) => state.filters.every((f) => {
            if (f.type === 'eq') return row[f.col] === f.val
            if (f.type === 'or') {
              const terms = f.expr.split(',').map((t) => {
                const [col, op, ...rest] = t.split('.')
                return { col, op, val: rest.join('.') }
              })
              return terms.some((t) => {
                if (t.op === 'is' && t.val === 'null') return row[t.col] === null || row[t.col] === undefined
                if (t.op === 'neq') return row[t.col] !== t.val
                if (t.op === 'eq') return row[t.col] === t.val
                return false
              })
            }
            return true
          }))
          if (state.limit != null) result = result.slice(0, state.limit)
          return { data: result[0] || null, error: null }
        },
      }
      return builder
    },
  }
}

// C1 (finding 1): getLastReportForUrl feeds `recentBrief` on IntelligenceDashboard, which
// reaches ContextGateScreen's "You already have a brief for this company" and the
// recent-report prompt modal — both founder-facing, both presenting whatever this function
// returns UNDER THE COMPANY'S NAME. Unlike the list endpoint (T5/N2 above), this function
// had no report_kind filter at all before this fix. This executes the REAL, extracted
// function body against a fixture row set through the real (if minimal) filter
// interpreter above, proving BOTH queries it issues — the target_domain lookup and the
// website_url fallback — exclude product reports, and that a pre-migration NULL
// report_kind still resolves as a company report in both.
check(
  "getLastReportForUrl excludes product reports on both the domain query and the website_url fallback (C1)",
  async () => {
    const svc = read('../src/services/reportService.js')
    const fn = (svc.match(/export async function getLastReportForUrl[\s\S]*?\n}/) || [])[0]
    assert.ok(fn, 'getLastReportForUrl is not defined')

    const factory = new Function(
      'supabase', 'extractTargetDomain',
      `return async (clientId, websiteUrl) => { ${fn.slice(fn.indexOf('{') + 1, -1)} }`
    )

    // Domain-query path: a product report is the most recent row for this domain, and
    // must be skipped in favour of the company's own (older) report.
    const domainRows = [
      { id: 'r-product', client_id: 'client-1', target_domain: 'acme.com', website_url: 'https://acme.com', report_kind: 'product' },
      { id: 'r-company-null', client_id: 'client-1', target_domain: 'acme.com', website_url: 'https://acme.com', report_kind: null },
    ]
    const getLastReportForUrlDomain = factory(fakeReportsQueryBuilder(domainRows), extractTargetDomain)
    const domainResult = await getLastReportForUrlDomain('client-1', 'https://acme.com')
    assert.equal(
      domainResult?.data?.id, 'r-company-null',
      `getLastReportForUrl's domain query returned "${domainResult?.data?.id}", not the ` +
      "company report — a product report is surfacing as the COMPANY's own latest brief " +
      "(ContextGateScreen's \"View it\", the recent-report prompt modal), and a pre-v31 " +
      'NULL report_kind must still resolve as company'
    )

    // website_url fallback path: target_domain deliberately does not match, forcing the
    // function past the domain branch into the website_url query — which must apply the
    // SAME exclusion, not a weaker one.
    const fallbackRows = [
      { id: 'r-product-fb', client_id: 'client-1', target_domain: 'zzz-no-match.example', website_url: 'https://widget.acme.com', report_kind: 'product' },
      { id: 'r-company-fb', client_id: 'client-1', target_domain: 'zzz-no-match.example', website_url: 'https://widget.acme.com', report_kind: 'company' },
    ]
    const getLastReportForUrlFallback = factory(fakeReportsQueryBuilder(fallbackRows), extractTargetDomain)
    const fallbackResult = await getLastReportForUrlFallback('client-1', 'https://widget.acme.com')
    assert.equal(
      fallbackResult?.data?.id, 'r-company-fb',
      `getLastReportForUrl's website_url fallback query returned "${fallbackResult?.data?.id}", ` +
      'not the company report — the fallback query must exclude products exactly like the ' +
      'domain query does, not fall back to unfiltered behaviour'
    )
  }
)

console.log('\nclose-out pass 3 — archived company targets and mutation-weak spots\n')

/**
 * Split a comma-separated SQL list at its TOP-LEVEL commas only — a naive `.split(',')`
 * breaks on `COALESCE(a, b)`, which both the RPC's create-branch INSERT and the v31
 * backfill's SELECT list use for the `name` column.
 */
function splitTopLevelCommas(str) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of str) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

/** The two "IF v_target_id IS NULL THEN ... END IF" blocks inside the RPC's body. */
function rpcTargetResolutionBlocks() {
  const sigStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.set_current_company_context')
  assert.notEqual(sigStart, -1, 'set_current_company_context not found')
  const bodyEnd = migration.indexOf('\n$$;', sigStart)
  assert.notEqual(bodyEnd, -1, 'could not find the end of the function body')
  const body = migration.slice(sigStart, bodyEnd)

  const ifBlocks = [...body.matchAll(/IF v_target_id IS NULL THEN[\s\S]*?\n\s*END IF;/g)]
  assert.equal(ifBlocks.length, 2, `expected exactly 2 "v_target_id IS NULL" branches, found ${ifBlocks.length}`)
  return { lookupBlock: ifBlocks[0][0], createBlock: ifBlocks[1][0] }
}

check(
  "the domain-lookup branch excludes archived company targets (Important 1a)",
  () => {
    // Regression: an ARCHIVED company target used to be found by this lookup just like an
    // active one — v_target_id came back non-NULL, and the create-on-miss branch below was
    // skipped entirely. Context then silently attached to a target that listTargets hides
    // and resolveRunTarget refuses to run, with nothing raised anywhere.
    const { lookupBlock } = rpcTargetResolutionBlocks()

    const selectMatch = lookupBlock.match(
      /SELECT id INTO v_target_id\s*\n\s*FROM public\.intelligence_targets\s*\n\s*WHERE ([^;]+?)\s*\n\s*LIMIT 1;/
    )
    assert.ok(selectMatch, 'could not isolate the domain-lookup SELECT ... WHERE clause')
    const whereClause = selectMatch[1]

    assert.match(
      whereClause, /status\s*<>\s*'archived'/,
      "the company-target lookup has no \"status <> 'archived'\" filter — an archived " +
      'company target is found, v_target_id comes back non-NULL, and the create branch ' +
      'below is skipped entirely, so context silently attaches to an archived, unrunnable ' +
      'target'
    )
    assert.match(whereClause, /type\s*=\s*'company'/, 'the lookup must still be scoped to company targets')
    assert.match(whereClause, /client_id\s*=\s*p_client_id/, 'the lookup must still be tenant-scoped')

    // Must match uq_intelligence_targets_company's own predicate, not an unrelated
    // "status <> 'archived'" string somewhere else in the migration.
    const indexMatch = migration.match(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_intelligence_targets_company\s*\n\s*ON public\.intelligence_targets \(([^)]+)\)\s*\n\s*WHERE ([^;]+);/
    )
    assert.ok(indexMatch, 'uq_intelligence_targets_company definition not found — repoint this test')
    const [, , indexPredicate] = indexMatch
    assert.match(
      indexPredicate, /status\s*<>\s*'archived'/,
      'the partial index itself no longer excludes archived rows — repoint this test'
    )
  }
)

check(
  "the RPC's created company target is 'active', not any other status (Minor 2)",
  () => {
    // Mutation-weak spot: nothing pinned the literal status value the create-branch INSERT
    // writes. A wrong status here matters more than it looks — lib/handlers/intelligence.js
    // refuses to run a draft target, so a single wrong token would make every NEW
    // workspace's company target unrunnable, silently. This walks the actual columns/values
    // lists positionally rather than grepping for the string 'active' anywhere in the
    // block, which a status of 'active' appearing in an unrelated comment could satisfy.
    const { createBlock } = rpcTargetResolutionBlocks()

    const insertMatch = createBlock.match(
      /INSERT INTO public\.intelligence_targets \(([^)]+)\)\s*\n\s*VALUES \(([\s\S]*?)\)\s*\n\s*-- uq_intelligence_targets_company/
    )
    assert.ok(insertMatch, 'could not isolate the create-branch INSERT ... VALUES clause')
    const [, columnsRaw, valuesRaw] = insertMatch

    const columns = splitTopLevelCommas(columnsRaw)
    const values = splitTopLevelCommas(valuesRaw)
    assert.equal(columns.length, values.length, 'columns/values arity mismatch in the create-branch INSERT')

    const statusIdx = columns.indexOf('status')
    assert.notEqual(statusIdx, -1, 'the create-branch INSERT never names a status column')
    assert.equal(
      values[statusIdx], "'active'",
      `the created company target's status is ${values[statusIdx]}, not 'active' — ` +
      'lib/handlers/intelligence.js refuses to run a draft target, so this would make every ' +
      "new workspace's company target unrunnable with no error anywhere"
    )
  }
)

check(
  "the RPC's created company target uses the bare domain as its slug, matching the backfill (Minor 3)",
  () => {
    // Mutation-weak spot: nothing pinned the slug expression either. Three writers create
    // company targets — this RPC, the v31 backfill above it, and targetService.createTarget
    // — and the first two must not drift from each other.
    const { createBlock } = rpcTargetResolutionBlocks()

    const insertMatch = createBlock.match(
      /INSERT INTO public\.intelligence_targets \(([^)]+)\)\s*\n\s*VALUES \(([\s\S]*?)\)\s*\n\s*-- uq_intelligence_targets_company/
    )
    assert.ok(insertMatch, 'could not isolate the create-branch INSERT ... VALUES clause')
    const [, columnsRaw, valuesRaw] = insertMatch

    const columns = splitTopLevelCommas(columnsRaw)
    const values = splitTopLevelCommas(valuesRaw)
    assert.equal(columns.length, values.length, 'columns/values arity mismatch in the create-branch INSERT')

    const slugIdx = columns.indexOf('slug')
    assert.notEqual(slugIdx, -1, 'the create-branch INSERT never names a slug column')
    assert.equal(
      values[slugIdx], 'p_target_domain',
      `the created company target's slug is ${values[slugIdx]}, not p_target_domain — the ` +
      "RPC and the backfill must not drift on what a company target's slug is"
    )

    // Cross-check against the backfill's own slug expression (first backfill INSERT, the
    // company_contexts-driven one) — both must key the slug off the bare target_domain
    // column, not a hardcoded literal or the display name.
    const backfillMatch = migration.match(
      /INSERT INTO public\.intelligence_targets \(client_id, type, name, slug, status, target_domain\)\s*\n\s*SELECT DISTINCT ON \(c\.client_id, c\.target_domain\)\s*\n([\s\S]*?)\nFROM public\.company_contexts/
    )
    assert.ok(backfillMatch, 'could not isolate the company_contexts backfill SELECT list')
    const backfillCols = splitTopLevelCommas(backfillMatch[1])
    // Column order in the backfill SELECT mirrors the INSERT column list: client_id, type,
    // name, slug, status, target_domain.
    assert.equal(
      backfillCols[3], 'c.target_domain',
      `the backfill's slug expression is ${backfillCols[3]}, not c.target_domain — repoint ` +
      'this test if the backfill legitimately changed shape'
    )
  }
)

console.log('\njob column cache — TTL must be finite (Minor 4)\n')

check(
  "the job column cache's target_id TTL is finite: it stays disabled shortly after disabling, and re-enables well after (Minor 4)",
  async () => {
    // Mutation-weak spot: __jobColumnCache.backdate exists specifically so this TTL can be
    // exercised for real. Setting JOB_COLUMN_RECHECK_MS to Infinity would restore exactly
    // the one-way latch src/services/reportService.js documents (line ~114) as a bug it
    // already fixed — a warm instance that once saw target_id missing would skip it for
    // the rest of its life, even minutes after the migration was applied. Asserting only
    // that RECHECK_MS "looks like a number" would still pass if it were set to Infinity
    // (Infinity is typeof 'number'), so this proves the BEHAVIOUR: a large-but-finite
    // backdate must cross the TTL and re-enable the column.
    const { __jobColumnCache } = await import('../lib/_intelligenceJobs.js')
    __jobColumnCache.reset()

    assert.ok(
      Number.isFinite(__jobColumnCache.RECHECK_MS),
      `RECHECK_MS is ${__jobColumnCache.RECHECK_MS} — it must be a finite number of ` +
      'milliseconds, or the column is disabled forever once missed once'
    )

    assert.equal(__jobColumnCache.isAvailable('target_id'), true, 'target_id starts available')

    __jobColumnCache.markMissing('target_id', '')
    assert.equal(
      __jobColumnCache.isAvailable('target_id'), false,
      'markMissing must actually disable the column'
    )

    // A moment later it must still be disabled.
    __jobColumnCache.backdate('target_id', 1000)
    assert.equal(
      __jobColumnCache.isAvailable('target_id'), false,
      'target_id re-enabled after only 1 second — the recheck interval is far too short, ' +
      'or the TTL check is not actually gating anything'
    )

    // Ten years later it MUST be available again. Only a genuinely finite TTL can be
    // crossed by a finite backdate — an Infinity recheck interval would keep this false no
    // matter how far back disabledAt is pushed.
    __jobColumnCache.backdate('target_id', 10 * 365 * 24 * 60 * 60 * 1000)
    assert.equal(
      __jobColumnCache.isAvailable('target_id'), true,
      'target_id never re-enables no matter how much time passes — the recheck interval is ' +
      'effectively infinite, recreating the one-way latch bug reportService.js already fixed'
    )

    __jobColumnCache.reset()
  }
)

console.log('\nmigration ordering (production-apply safety)\n')

check('the file is wrapped in one transaction — BEGIN near the top, COMMIT at the end', () => {
  // A partial application of this file is hard to recover from (see the header comment
  // and scripts/migrations/v37_APPLY.md's rollback section). Wrapping the whole file in
  // BEGIN/COMMIT is what makes "the SQL editor reported an error partway through" mean
  // "nothing happened" instead of "half the schema changed". This does not merely check
  // that the strings BEGIN; and COMMIT; appear somewhere — it requires BEGIN; to be the
  // first statement (only comments/blank lines may precede it) and COMMIT; to be the
  // very last thing in the file, so a stray extra statement tacked on after COMMIT;
  // (which would silently run un-transacted) is also caught.
  const withoutLeadingComments = migration.replace(/^(\s*--[^\n]*\n|\s*\n)*/, '')
  assert.match(
    withoutLeadingComments, /^BEGIN;/,
    'BEGIN; must be the first statement in the file (only comments/blank lines may precede it)'
  )
  assert.match(
    migration.trim(), /COMMIT;$/,
    'COMMIT; must be the last statement in the file — anything after it would run outside the transaction'
  )
})

check('the RPC swap runs BEFORE the one-current index swap', () => {
  // The hazard this pins: section 7 drops the OLD domain-scoped unique index
  // (uq_company_contexts_current) and replaces it with a target-scoped one. If that
  // happened before the RPC swap, there would be a window in which the old 6-argument
  // set_current_company_context still resolves and writes target_id = NULL on every call
  // — and because NULL <> NULL in Postgres, the new partial unique index on
  // (client_id, target_id) does not constrain those rows, while the old protective index
  // is already gone. Two is_current rows for one company become reachable. Swapping the
  // RPC first (dropping the old 6-arg overload outright) closes that window. This check
  // proves the ORDER in the file text, not merely that both pieces exist somewhere.
  const rpcSwapIdx = migration.indexOf(
    'DROP FUNCTION IF EXISTS public.set_current_company_context(UUID, TEXT, JSONB, TEXT, TEXT, JSONB);'
  )
  assert.notEqual(rpcSwapIdx, -1, 'the 6-argument DROP FUNCTION for set_current_company_context was not found')

  // Exact match including the trailing semicolon, so this cannot accidentally match the
  // CREATE UNIQUE INDEX ... uq_company_contexts_current_target statement that follows it
  // (uq_company_contexts_current is a string-prefix of uq_company_contexts_current_target).
  const indexSwapIdx = migration.indexOf('DROP INDEX IF EXISTS public.uq_company_contexts_current;')
  assert.notEqual(indexSwapIdx, -1, 'the DROP INDEX for uq_company_contexts_current was not found')

  assert.ok(
    rpcSwapIdx < indexSwapIdx,
    'the RPC swap (DROP FUNCTION of the 6-argument overload) must appear BEFORE the ' +
    'one-current index swap (DROP INDEX of uq_company_contexts_current) — reordering this ' +
    'reopens the target_id = NULL window described in the file\'s header comment'
  )

  // The new function definition itself — not just the DROP — must also precede the index
  // swap, so the window is closed by the time the index changes, not merely started.
  const createIdx = migration.indexOf('CREATE OR REPLACE FUNCTION public.set_current_company_context')
  assert.notEqual(createIdx, -1, 'set_current_company_context CREATE OR REPLACE not found')
  assert.ok(
    createIdx < indexSwapIdx,
    'the new 7-argument set_current_company_context must be created before the one-current index swap'
  )
})

await Promise.all(pending)
console.log(`\n${passed} checks passed\n`)
