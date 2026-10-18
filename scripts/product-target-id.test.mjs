/**
 * "invalid input syntax for type uuid: "prod_1791478297356"" — the desk minted a placeholder
 * id for a product it saved only in localStorage, swallowed the {ok:false} createTarget
 * RETURNS (its try/catch never fires), and asked the server to run the placeholder. Nothing
 * failed until the run itself, and the founder was shown Postgres's own message.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isUuid } from '../src/utils/uuid.js'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
let n = 0
const check = (name, fn) => {
  try { fn(); n++; console.log(`  ✓ ${name}`) } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1 }
}
console.log('\nproduct target ids\n')

check('a placeholder id is not a target id; a real one is', () => {
  assert.equal(isUuid('prod_1791478297356'), false)
  assert.equal(isUuid('comp_dhanda.app'), false)
  for (const v of ['', null, undefined, 42, {}]) assert.equal(isUuid(v), false)
  assert.equal(isUuid('6d61ca79-0476-41d2-b94e-99f3f2707066'), true)
})

const dash = read('src/components/IntelligenceDashboard.jsx')
const block = (name, until) => {
  const a = dash.indexOf(name)
  assert.ok(a >= 0, `${name} not found`)
  return dash.slice(a, dash.indexOf(until, a))
}

check('saving a product never mints a local id, and acts on createTarget\'s returned result', () => {
  const save = block('const registerProduct = async', 'const handleSaveDecision')
  assert.doesNotMatch(save, /prod_\$\{/, 'a placeholder product id must not be created')
  assert.doesNotMatch(save, /saveLocalProducts/, 'a product must not exist only in this browser')
  assert.match(save, /const result = await createTarget\(/)
  assert.match(save, /if \(!result\.ok\)/, 'a refused create must be handled, not ignored')
})
check('a failed save is shown to the founder and does not start a run', () => {
  const save = block('const handleSaveProduct = async', 'const handleSaveDecision')
  assert.match(save, /if \(!saved\.ok\)[\s\S]*toast\.error[\s\S]*return/)
  assert.ok(save.indexOf('toast.error') < save.indexOf('handleRunTarget'))
})
check('a product left over from the old local-only build is registered before it is run', () => {
  const run = block('const handleRunTarget = async', 'const handleOpenTargetBrief')
  assert.ok(run.indexOf('isUuid(target?.id)') >= 0 && run.indexOf('isUuid(target?.id)') < run.indexOf('submitIntelligenceJob'))
  assert.match(run, /registerProduct\(/)
})
check('the server refuses a non-uuid target id before it reaches Postgres', () => {
  const h = read('lib/handlers/intelligence.js')
  const fn = h.slice(h.indexOf('async function resolveRunTarget'))
  assert.ok(fn.indexOf('isUuid(targetId)') >= 0 && fn.indexOf('isUuid(targetId)') < fn.indexOf(".from('intelligence_targets')"))
})
console.log(`\n${n} passed`)
