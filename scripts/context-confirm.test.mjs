/**
 * "Is this you?" — the correction round trip.
 *
 * The new confirmation screen replaces a 573-line field editor. Both write the founder's
 * corrections into `_userEdits.{fields,removed}`, and everything downstream depends on
 * that record: `applyContextPatch` refuses to overwrite any path in `fields`, and
 * `stepMemory` refuses to re-add any name in `removed`.
 *
 * If the new screen recorded edits in a slightly different shape, founder corrections would
 * silently stop being honoured on the next merge and NOTHING WOULD ERROR — the exact
 * failure this codebase is most vulnerable to. So the test is not "does the screen work";
 * it is "does a correction made through the new screen reach applyContextPatch with the
 * same meaning as one made through the old".
 *
 * Run: npm run test:context-confirm
 */
import assert from 'node:assert/strict'
import {
  buildContextSentences,
  applySentenceEdit,
  editFieldFor,
  splitListPhrase,
  listPhrase,
  MIN_SENTENCES_FOR_CONFIRM,
} from '../src/services/recognition.js'
import { applyContextPatch } from '../src/services/intelligenceService.js'

const baseContext = () => ({
  operating_geography: 'Maharashtra and Gujarat',
  strategic_anchors: {
    operational_reality: 'Warehouse management software',
    buyer_type: { primary: 'Mid-Market' },
    narrative_lens: 'Faster implementation than incumbents',
  },
  customer_segments: [{ name: 'third-party logistics firms', pain_point: 'Manual stock reconciliation' }],
  key_competitors: [
    { name: 'Holisol', url: 'https://holisol.in', why_competitor: 'same segment', evidence_quote: 'q' },
    { name: 'Stockarea' },
    { name: 'Increff' },
  ],
  dependency_map: { regulatory_exposure: ['GST e-way bill compliance'] },
})

const sentenceById = (ctx, id) => buildContextSentences(ctx).find(s => s.id === id)

// ── 1. the shape ContextReviewScreen has always written ─────────────────────
{
  const ctx = baseContext()
  const next = applySentenceEdit(ctx, sentenceById(ctx, 'sells'), 'Freight audit software')

  assert.ok(Array.isArray(next._userEdits.fields), '_userEdits.fields must be an array')
  assert.ok(Array.isArray(next._userEdits.removed), '_userEdits.removed must be an array, even when nothing was removed')
  assert.ok(next._userEdits.at, '_userEdits.at must be stamped')
  assert.deepEqual(next._userEdits.fields, ['strategic_anchors.operational_reality'], 'the dotted path, exactly as the old screen records it')
  assert.equal(next.strategic_anchors.operational_reality, 'Freight audit software', 'the value must actually be written')

  // The input is never mutated: the dashboard holds contextData in state and relies on a
  // new object to re-render.
  assert.equal(ctx.strategic_anchors.operational_reality, 'Warehouse management software', 'the source context must not be mutated')
  assert.equal(ctx._userEdits, undefined, 'the source context must not gain _userEdits')
}
console.log('  ✓ writes _userEdits in the shape the old screen writes')

// ── 2. the record is honoured by applyContextPatch ──────────────────────────
{
  const ctx = baseContext()
  const corrected = applySentenceEdit(ctx, sentenceById(ctx, 'sells'), 'Freight audit software')

  // A later run tries to "update" the field the founder just fixed, with evidence.
  const patch = {
    updates: [{
      field: 'strategic_anchors.operational_reality',
      new_value: 'Warehouse management software',
      evidence_quote: 'They describe themselves as a warehouse management platform.',
    }],
  }
  const { context: merged, receipt } = applyContextPatch(corrected, patch, corrected._userEdits)

  assert.equal(merged.strategic_anchors.operational_reality, 'Freight audit software', 'the correction must survive the merge')
  assert.ok(
    receipt.rejected.updates.some(r => r.field === 'strategic_anchors.operational_reality'),
    'and the merge must SAY it refused the update, not silently drop it'
  )

  // Control: without the record, the same patch overwrites. This is what a mis-shaped
  // _userEdits would silently cause.
  const { context: unprotected } = applyContextPatch(baseContext(), patch, {})
  assert.equal(unprotected.strategic_anchors.operational_reality, 'Warehouse management software',
    'without the record the field IS overwritten — which is what makes the record load-bearing')
}
console.log('  ✓ a correction survives a later merge, and the merge says it refused')

// ── 3. deleting a competitor is recorded, not merely absent ─────────────────
{
  const ctx = baseContext()
  const edited = applySentenceEdit(ctx, sentenceById(ctx, 'rivals'), 'Holisol and Stockarea')

  assert.equal(edited.key_competitors.length, 2, 'the struck-out competitor is gone')
  assert.deepEqual(edited._userEdits.removed, ['Increff'], 'and is RECORDED as removed — absence alone is indistinguishable from "never found"')
  assert.equal(edited.key_competitors[0].url, 'https://holisol.in', 'a surviving competitor keeps the evidence already gathered about it')
  assert.equal(edited.key_competitors[0].why_competitor, 'same segment', 'including why it was a competitor')

  // The next run rediscovers Increff. It must not come back.
  const { context: merged, receipt } = applyContextPatch(
    edited,
    { additions: { key_competitors: [{ name: 'Increff', url: 'https://increff.com' }] } },
    edited._userEdits
  )
  assert.ok(!merged.key_competitors.some(c => c.name === 'Increff'), 'a removed competitor must not be re-added')
  assert.ok(receipt.rejected.additions.some(r => /Increff/.test(r.name || '')), 'and the merge must say it refused to re-add it')
}
console.log('  ✓ a deleted competitor stays deleted, and its evidence-mates survive')

// ── 4. an inferred risk edit lands on the founder's own field ───────────────
{
  // "What would hurt most" fell back to a regulatory exposure the founder did not author.
  // Editing that sentence means "here is my actual risk" — it must not rewrite the
  // regulatory exposure list.
  const ctx = baseContext()
  const risk = sentenceById(ctx, 'risk')
  assert.equal(risk.field, 'dependency_map.regulatory_exposure', 'this fixture exercises the inferred path')
  assert.equal(editFieldFor(risk), 'strategic_anchors.primary_risk', 'an edit redirects to the founder\'s own field')

  const edited = applySentenceEdit(ctx, risk, 'A competitor undercutting our entry tier')
  assert.equal(edited.strategic_anchors.primary_risk, 'A competitor undercutting our entry tier')
  assert.deepEqual(edited.dependency_map.regulatory_exposure, ['GST e-way bill compliance'], 'the inferred list is untouched')
  assert.deepEqual(edited._userEdits.fields, ['strategic_anchors.primary_risk'], 'the recorded field names where we WROTE, not where we read')

  // When the founder's own field already holds the value, read and write agree.
  const owned = { ...baseContext(), strategic_anchors: { ...baseContext().strategic_anchors, primary_risk: 'Losing the entry tier' } }
  const ownedRisk = sentenceById(owned, 'risk')
  assert.equal(ownedRisk.field, 'strategic_anchors.primary_risk')
  assert.equal(editFieldFor(ownedRisk), 'strategic_anchors.primary_risk', 'no redirect when the value came from the founder\'s field')
}
console.log('  ✓ an inferred risk edit does not rewrite what it was inferred from')

// ── 5. the list phrase round-trips ──────────────────────────────────────────
{
  for (const names of [['A'], ['A', 'B'], ['A', 'B', 'C']]) {
    assert.deepEqual(splitListPhrase(listPhrase(names)), names, `"${listPhrase(names)}" must split back to its parts`)
  }
  assert.deepEqual(splitListPhrase('Holisol, Stockarea and Increff'), ['Holisol', 'Stockarea', 'Increff'])
  assert.deepEqual(splitListPhrase('Holisol & Stockarea'), ['Holisol', 'Stockarea'], 'an ampersand is how people actually type this')
  assert.deepEqual(splitListPhrase(''), [], 'an empty phrase yields no names rather than one empty one')
}
console.log('  ✓ the competitor list survives a render/parse round trip')

// ── 6. an unchanged value is not a correction ───────────────────────────────
{
  // Recording a no-op edit would tell applyContextPatch to protect a field the founder
  // never disagreed with, freezing it against every future run. The screen guards this
  // before calling in; the writer must also refuse an empty value outright.
  const ctx = baseContext()
  assert.equal(applySentenceEdit(ctx, sentenceById(ctx, 'sells'), '  '), ctx, 'an empty edit is a no-op and returns the same object')
  assert.equal(applySentenceEdit(ctx, null, 'x'), ctx, 'a missing sentence is a no-op')
}
console.log('  ✓ an empty edit records nothing')

// ── 7. degrading rather than showing blanks ─────────────────────────────────
{
  assert.equal(buildContextSentences({}).length, 0, 'an empty context yields no sentences')
  const thin = buildContextSentences({ strategic_anchors: { operational_reality: 'Logistics software' } })
  assert.ok(thin.length < MIN_SENTENCES_FOR_CONFIRM, 'a thin context falls below the threshold, so the screen hands over to the full editor')
  for (const s of buildContextSentences(baseContext())) {
    assert.ok(s.value && s.value.trim(), `sentence ${s.id} must never render a blank value`)
    assert.ok(s.field, `sentence ${s.id} must name a field, or its correction cannot be recorded`)
  }
}
console.log('  ✓ thin context degrades to the full editor rather than showing blanks')

console.log('context-confirm tests passed')
