/**
 * A product run is about the product.
 *
 * Found on a live run, 2026-10-08: "FetoMax by CareMother" searched
 * `"CareMother by Doto Health" competitors OR alternatives`, Janitri and iMumz, and never read
 * the FetoMax page. `_product` was read in exactly one place (the 4-query product lens) and
 * every other step kept naming the company. Following that turned up the server context
 * write (v30's RPC) demoting every current context on a domain, products included, and
 * writing target_id NULL rows nothing can read. Nothing threw anywhere.
 *
 * This pins, end to end where it can:
 *   - runSubject and everything that reads it (express, rivals, deep reads, prompts);
 *   - company runs are byte-for-byte what they were (golden values, not "looks similar");
 *   - what the server context write SENDS (fake PostgREST RPC log), and that it never falls
 *     back to the domain-scoped function;
 *   - the product profile the Desk collects survives createTarget into the inherited context;
 *   - v38's SQL is scoped by target everywhere it touches company_contexts.
 *
 * Run: npm run test:product-subject
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startFakePostgrest } from './_fakePostgrest.mjs'

const pg = await startFakePostgrest()
// Never the live project: npm does not load .env, but a shell that sourced it would.
delete process.env.VITE_SUPABASE_URL
process.env.SUPABASE_URL = pg.url
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const {
  runSubject, productSearchName, subjectDeepReadCandidates, withProductRivals, buildProductQueries,
} = await import('../src/services/productService.js')
const { buildExpressQueries } = await import('../src/services/queryGenerator.js')
const { PROMPTS } = await import('../src/services/promptUtils.js')
const { saveCompanyContextFromServer } = await import('../src/services/companyContextService.js')
const { createTarget } = await import('../src/services/targetService.js')

const REAL_CONSOLE = { log: console.log, warn: console.warn, error: console.error }
const quiet = async (fn) => {
  console.log = console.warn = console.error = () => {}
  try { return await fn() } finally { Object.assign(console, REAL_CONSOLE) }
}
let passed = 0
const check = async (name, fn) => {
  pg.reset()
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

const YEAR = new Date().getFullYear()
const COMPANY = {
  company_name: 'CareMother by Doto Health',
  industry: 'maternal health',
  operating_geography: 'India',
  key_competitors: [{ name: 'Janitri' }, { name: 'iMumz' }],
}
const PRODUCT = {
  ...COMPANY,
  _product: {
    target_id: '2d07a5b1-4679-4ef0-ab42-3d220a0dc5b9',
    name: 'FetoMax by CareMother',
    canonical_url: 'https://caremother.in/offering/fetomax',
    category: 'fetal monitoring device',
    competitor_products: ['Sonicaid', 'Daksh'],
  },
}

// ── The subject ────────────────────────────────────────────────────────────
console.log('\nrunSubject\n')

await check('a product context is about the product, made by the company', () => {
  const s = runSubject(PRODUCT)
  assert.equal(s.isProduct, true)
  assert.equal(s.name, 'FetoMax by CareMother')
  assert.equal(s.searchName, 'FetoMax')
  assert.equal(s.maker, 'CareMother by Doto Health')
  assert.equal(s.category, 'fetal monitoring device')
  assert.deepEqual(s.competitors, ['Sonicaid', 'Daksh'])
  assert.deepEqual(s.sourceUrls, ['https://caremother.in/offering/fetomax'])
})

await check('a company context is about the company', () => {
  const s = runSubject(COMPANY)
  assert.equal(s.isProduct, false)
  assert.equal(s.name, 'CareMother by Doto Health')
  assert.deepEqual(s.competitors, ['Janitri', 'iMumz'])
})

await check('an explicit non-product mode ignores a stray _product (it is a REUSABLE key)', () => {
  assert.equal(runSubject(PRODUCT, { analysisMode: 'company' }).isProduct, false)
  assert.equal(runSubject(PRODUCT, { analysisMode: 'product' }).isProduct, true)
})

await check('the search name drops a "by <maker>" label, but never down to nothing', () => {
  assert.equal(productSearchName('FetoMax by CareMother'), 'FetoMax')
  assert.equal(productSearchName('Pulse from Acme Labs'), 'Pulse')
  assert.equal(productSearchName('Linear'), 'Linear')
  assert.equal(productSearchName('X by Acme'), 'X by Acme')
})

// ── Express: the query the live run actually sent ──────────────────────────
console.log('\nexpress pass\n')

await check('a product run\'s express pass names the product, never asks who competes with the company', () => {
  const qs = buildExpressQueries(PRODUCT, 3)
  assert.equal(qs.length, 3)
  assert.ok(qs.every(q => !q.includes('"CareMother by Doto Health"')), `still searched the company: ${qs.join(' | ')}`)
  assert.equal(qs[0], `"FetoMax" review OR pricing OR launch ${YEAR}`)
  assert.equal(qs[1], `"Sonicaid" vs "FetoMax" ${YEAR}`)
})

await check('with no rival named yet, the product pass asks for its alternatives', () => {
  const { competitor_products, ...bare } = PRODUCT._product
  const qs = buildExpressQueries({ ...COMPANY, _product: bare }, 3)
  assert.equal(qs[1], `"FetoMax" alternatives OR competitors ${YEAR}`)
})

await check('a company run\'s express pass is exactly what it was', () => {
  assert.deepEqual(buildExpressQueries(COMPANY, 6), [
    `"Janitri" news OR announcement OR launch ${YEAR}`,
    `"CareMother by Doto Health" competitors OR alternatives ${YEAR}`,
    `"iMumz" funding OR partnership ${YEAR}`,
    `maternal health funding OR acquisition ${YEAR} India`,
    `maternal health regulation OR compliance change ${YEAR} India`,
    `"CareMother by Doto Health" customers OR reviews ${YEAR}`,
  ])
})

await check('the product lens quotes the searchable name, not the label', () => {
  const qs = buildProductQueries({ product: PRODUCT._product, context: COMPANY, limit: 4 })
  assert.ok(qs.some(q => q.includes('"FetoMax"')))
  assert.ok(qs.every(q => !q.includes('"FetoMax by CareMother"')))
})

// ── Rivals and deep reads ─────────────────────────────────────────────────
console.log('\nrivals and deep reads\n')

await check('rival products lead the watchlist, deduped, without mutating it', () => {
  const tracked = [{ name: 'Janitri', category: 'competitor' }, { name: 'daksh', category: 'competitor' }]
  const out = withProductRivals(tracked, ['Sonicaid', 'Daksh', ''])
  assert.deepEqual(out.map(e => e.name), ['Sonicaid', 'Janitri', 'daksh'])
  assert.equal(out[0].category, 'competitor')
  assert.equal(tracked.length, 2)
})

await check('the product page is pinned as a deep read, within a third of the budget', () => {
  const s = runSubject({
    ...PRODUCT,
    _product: { ...PRODUCT._product, pricing_url: 'https://caremother.in/pricing', changelog_url: 'https://caremother.in/news' },
  })
  const full = subjectDeepReadCandidates(s, 8)
  assert.deepEqual(full.map(c => c.url), ['https://caremother.in/offering/fetomax', 'https://caremother.in/pricing'])
  assert.equal(full[0].sourceClass, 'primary_company')
  assert.equal(subjectDeepReadCandidates(s, 3).length, 1, 'a shallow run spends one read on its own page, not all three')
  assert.deepEqual(subjectDeepReadCandidates(runSubject(COMPANY), 8), [])
})

await check('stepSearch takes the pinned reads out of the same budget', () => {
  const src = read('../src/services/intelligenceService.js')
  const at = src.indexOf('const pinned = subjectDeepReadCandidates(')
  assert.ok(at > -1, 'stepSearch never pins the product page')
  const block = src.slice(at, at + 1200)
  assert.match(block, /budget\(\)\.maxDeepReads - pinned\.length/, 'pinned reads must come out of maxDeepReads, not on top of it')
})

await check('stepGenerateQueries hands the generator the product and its rivals', () => {
  const src = read('../src/services/intelligenceService.js')
  const fn = src.slice(src.indexOf('async function stepGenerateQueries'), src.indexOf('async function stepSearch'))
  assert.match(fn, /withProductRivals\(trackedEntities, subject\.competitors\)/)
  assert.match(fn, /entities: queryEntities/)
  assert.match(fn, /companyName: subject\.searchName/)
})

await check('competitor discovery looks for rival PRODUCTS on a product run', () => {
  const src = read('../src/services/intelligenceService.js')
  const fn = src.slice(src.indexOf('async function stepDiscoverCompetitors'), src.indexOf('async function stepValidateExa'))
  assert.match(fn, /PRODUCT_MODE\) await discoverProductRivals/)
})

// ── Prompts ──────────────────────────────────────────────────────────────
console.log('\nprompts\n')

await check('the analyze and summary prompts name the product as the subject', () => {
  const sig = PROMPTS.buildSignals(PRODUCT, 'DATA')
  assert.match(sig, /SUBJECT OF THIS RUN: A PRODUCT/)
  assert.match(sig, /Evidence about FetoMax from anyone other than CareMother by Doto Health IS intelligence/)
  assert.match(PROMPTS.buildSummary(PRODUCT, []), /SUBJECT OF THIS RUN: A PRODUCT/)
})

await check('a company run\'s prompts carry no product block', () => {
  assert.doesNotMatch(PROMPTS.buildSignals(COMPANY, 'DATA'), /SUBJECT OF THIS RUN/)
  assert.doesNotMatch(PROMPTS.buildSummary(COMPANY, []), /SUBJECT OF THIS RUN/)
})

// ── The server context write ────────────────────────────────────────────────
console.log('\nserver context write\n')

await check('a product run writes to its product target', async () => {
  await quiet(() => saveCompanyContextFromServer({
    clientId: 'c1', websiteUrl: 'https://caremother.in', context: PRODUCT, targetId: 't-product',
  }))
  const call = pg.rpcCalls.find(c => c.name === 'set_current_company_context_service')
  assert.ok(call, 'no server RPC call')
  assert.equal(call.args.p_target_id, 't-product')
})

await check('a company run sends p_target_id null — the RPC resolves the company target', async () => {
  await quiet(() => saveCompanyContextFromServer({ clientId: 'c1', websiteUrl: 'https://caremother.in', context: COMPANY }))
  const call = pg.rpcCalls.find(c => c.name === 'set_current_company_context_service')
  assert.ok(Object.prototype.hasOwnProperty.call(call.args, 'p_target_id'), 'p_target_id must always be sent')
  assert.equal(call.args.p_target_id, null)
})

await check('before v38 the write is skipped — never retried against the domain-scoped function', async () => {
  pg.rpcResults.set_current_company_context_service = () => ({
    status: 404, body: { code: 'PGRST202', message: 'Could not find the function' },
  })
  const out = await quiet(() => saveCompanyContextFromServer({
    clientId: 'c1', websiteUrl: 'https://caremother.in', context: PRODUCT, targetId: 't-product',
  }))
  assert.equal(out, null)
  const calls = pg.rpcCalls.filter(c => c.name === 'set_current_company_context_service')
  assert.equal(calls.length, 1, 'a retry without p_target_id would reach v30\'s function, which demotes every row on the domain')
})

await check('stepPersist passes the product target, and only on a product run', () => {
  const src = read('../src/services/intelligenceService.js')
  const at = src.indexOf('await saveCompanyContextFromServer({')
  const call = src.slice(at, at + 900)
  assert.match(call, /targetId: ctx\.job\.analysisMode === PRODUCT_MODE \? \(ctx\.job\.targetId \|\| null\) : null/)
})

// ── createTarget: the profile the Desk collects ────────────────────────────
console.log('\ncreateTarget\n')

await check('category, positioning and rivals survive into the inherited product context', async () => {
  pg.db.intelligence_targets = [{
    id: 'parent', client_id: 'c1', type: 'company', name: 'CareMother', slug: 'caremother.in',
    status: 'active', target_domain: 'caremother.in',
  }]
  pg.db.company_contexts = [{
    id: 'cc1', client_id: 'c1', target_id: 'parent', target_domain: 'caremother.in', version: 1,
    is_current: true, context: COMPANY, source: 'built', built_from: {}, created_at: new Date().toISOString(),
  }]
  pg.rpcResults.set_current_company_context = (args) => ({
    body: { id: 'cc2', client_id: 'c1', target_id: args.p_target_id, target_domain: 'caremother.in', version: 1, is_current: true, context: args.p_context },
  })

  const res = await quiet(() => createTarget({
    clientId: 'c1', type: 'product', name: 'FetoMax by CareMother', targetDomain: 'caremother.in',
    parentTargetId: 'parent', sources: { canonicalUrl: 'https://caremother.in/offering/fetomax' },
    product: { category: 'fetal monitoring device', positioning: 'Portable CTG', competitor_products: ['Sonicaid'], name: 'ignored' },
  }))
  assert.equal(res.ok, true, res.message)

  const write = pg.rpcCalls.find(c => c.name === 'set_current_company_context')
  const p = write.args.p_context._product
  assert.equal(p.category, 'fetal monitoring device')
  assert.equal(p.positioning, 'Portable CTG')
  assert.deepEqual(p.competitor_products, ['Sonicaid'])
  assert.equal(p.name, 'FetoMax by CareMother', 'identity fields always win over the profile')
  assert.equal(write.args.p_target_id, res.target.id, 'written against the PRODUCT target, never the parent')
})

// ── The Desk ────────────────────────────────────────────────────────────────
console.log('\nDesk handlers\n')

const dashboard = read('../src/components/IntelligenceDashboard.jsx')
const between = (a, b) => dashboard.slice(dashboard.indexOf(a), dashboard.indexOf(b, dashboard.indexOf(a)))

await check('saving a product creates a server target and runs THAT, never a local id', () => {
  const fn = between('const registerProduct = async', 'const handleSaveDecision = async')
  assert.doesNotMatch(fn, /saveLocalProducts|prod_\$\{/, 'a local copy is a second card with an id no server knows')
  assert.match(fn, /if \(!result\.ok\)/, 'createTarget reports failure as { ok:false }; it never throws')
  assert.match(fn, /handleRunTarget\(saved\.target\)/)
  assert.match(fn, /t\.targetDomain === domain/, 'the parent must be THIS domain\'s company target, not the workspace\'s first')
  assert.match(fn, /competitor_products: inferred\.competitors/)
})

await check('archive and restore change the server target', () => {
  const fn = between('const setProductStatus = async', 'const handleRestoreProduct')
  assert.match(fn, /archiveTarget\(productId\)/)
  assert.match(fn, /restoreTarget\(productId\)/)
})

await check('Desk flows that set inputs and submit pass them explicitly', () => {
  assert.match(dashboard, /const handleUrlSubmit = async \(forceFresh = false, forceRebuild = false, override = null\)/)
  const submit = between('const handleUrlSubmit = async', '// Onboarding form prefill:')
  const afterOverride = submit.slice(submit.indexOf('\n', submit.indexOf('const question')))
  assert.doesNotMatch(afterOverride, /\burlInput\b|\banalysisMode\b|\bdecisionText\b/,
    'after resolving the override, handleUrlSubmit must not read the stale closure values')
  for (const [from, to] of [
    ['const handleAnchorCompany = async', 'const handleSaveProduct = async'],
    ['const handleSaveDecision = async', 'const handleSaveMonitoringSetup'],
    ['const handleRunComposite = async', 'const openIntakeFromDesk'],
  ]) {
    const fn = between(from, to)
    const calls = fn.match(/handleUrlSubmit\([^)]*\)/g) || []
    assert.ok(calls.length > 0, `${from} no longer submits`)
    for (const c of calls) assert.match(c, /handleUrlSubmit\(true, false, \{/, `${from}: ${c} reads last render's inputs`)
  }
})

await check('a decision never runs against the placeholder domain', () => {
  const fn = between('const handleSaveDecision = async', 'const handleSaveMonitoringSetup')
  assert.doesNotMatch(fn, /https:\/\/\$\{domain\}|targetDomain: domain\b/)
})

// ── v38 ───────────────────────────────────────────────────────────────────────
console.log('\nv38 migration\n')

const v38 = read('./migrations/v38_service_context_write_targets.sql')
const fnBody = (name) => {
  const start = v38.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  assert.ok(start > -1, `${name} is not defined in v38`)
  return v38.slice(start, v38.indexOf('$$;', start))
}

await check('the server RPC takes p_target_id and drops the old signature first', () => {
  const drop = v38.indexOf('DROP FUNCTION IF EXISTS public.set_current_company_context_service(UUID, TEXT, JSONB, TEXT, TEXT, JSONB, UUID);')
  const create = v38.indexOf('CREATE OR REPLACE FUNCTION public.set_current_company_context_service(')
  assert.ok(drop > -1 && drop < create, 'without the DROP, PostgREST can keep resolving the domain-scoped overload')
  assert.match(fnBody('set_current_company_context_service'), /\bp_target_id\s+UUID DEFAULT NULL/)
})

await check('every company_contexts statement in both RPCs is scoped by target_id', () => {
  for (const name of ['set_current_company_context_service', 'set_current_company_context']) {
    const body = fnBody(name)
    for (const stmt of body.split(';')) {
      // Only statements that READ or WRITE the table (the signature's RETURNS names it too).
      if (!/(UPDATE|FROM)\s+public\.company_contexts\b/.test(stmt)) continue
      if (/WHERE id = v_existing\.id/.test(stmt)) continue
      assert.match(stmt, /target_id = v_target_id/, `${name}: unscoped statement:\n${stmt.trim()}`)
      assert.doesNotMatch(stmt, /target_domain = p_target_domain/, `${name}: domain-scoped statement:\n${stmt.trim()}`)
    }
    assert.match(body, /p_target_domain, v_target_id, v_version, TRUE/, `${name} must insert target_id`)
  }
})

await check('an explicit target must belong to the client (service RPC trusts its caller, not its args)', () => {
  assert.match(fnBody('set_current_company_context_service'), /WHERE id = p_target_id AND client_id = p_client_id/)
})

await check('company targets are named after the company, never the workspace', () => {
  assert.doesNotMatch(v38, /v_client_name/)
  for (const name of ['set_current_company_context_service', 'set_current_company_context']) {
    assert.match(fnBody(name), /p_context->>'company_name'/)
  }
})

await check('browser roles cannot execute the new signature', () => {
  for (const role of ['public', 'authenticated', 'anon']) {
    assert.match(v38, new RegExp(
      `REVOKE ALL ON FUNCTION public\\.set_current_company_context_service\\(UUID, TEXT, JSONB, TEXT, TEXT, JSONB, UUID, UUID\\) FROM ${role};`))
  }
})

await check('the repair demotes before it re-points (or it trips the one-current index)', () => {
  const demote = v38.indexOf('WHERE r.id = c.id AND r.rn > 1')
  const repoint = v38.indexOf('SET target_id = d.dest')
  assert.ok(demote > -1 && repoint > -1 && demote < repoint)
})

await pg.close?.()
console.log(`\n${passed} checks passed\n`)
process.exit(process.exitCode || 0)
