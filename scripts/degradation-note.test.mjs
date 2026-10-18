/**
 * Each "Notes on this brief" line must say WHAT happened, not only what it means.
 *
 * Every degradation carries a `reason` (the check that failed, e.g. "Only 2 signal(s)
 * survived verification") and an `impact` (its consequence). The banner rendered
 * `impact || reason`, so whenever both existed the reason was dropped. A coverage gap then
 * read "Coverage: Searched again for this and still found nothing that met the evidence
 * bar." — a consequence of nothing in particular. That is the note the live brief showed on
 * 2026-10-18, with no way to tell which of five coverage checks had failed.
 *
 * Run: npm run test:degradation-note
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { formatDegradationNote } from '../src/utils/formatters.js'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

check('a coverage gap shows which check failed, then what was done about it', () => {
  assert.equal(
    formatDegradationNote({
      step: 'Coverage',
      reason: '75% of signals come from a single source (example.com).',
      impact: 'Searched again for this and still found nothing that met the evidence bar.',
    }),
    '75% of signals come from a single source (example.com). Searched again for this and still found nothing that met the evidence bar.'
  )
})

check('a reason with no closing punctuation gets a full stop before the impact', () => {
  assert.equal(
    formatDegradationNote({
      reason: 'Tavily failed on all 6 searches; every source came from the Exa fallback',
      impact: 'Sources may be narrower than usual.',
    }),
    'Tavily failed on all 6 searches; every source came from the Exa fallback. Sources may be narrower than usual.'
  )
})

check('only one of reason / impact present: that one is shown', () => {
  assert.equal(formatDegradationNote({ reason: 'Only reason.' }), 'Only reason.')
  assert.equal(formatDegradationNote({ impact: 'Only impact.' }), 'Only impact.')
})

check('identical reason and impact are not repeated', () => {
  assert.equal(formatDegradationNote({ reason: 'Same text.', impact: 'Same text.' }), 'Same text.')
})

check('whitespace is trimmed and empty or missing input yields an empty string', () => {
  assert.equal(formatDegradationNote({ reason: '  Padded  ', impact: '   ' }), 'Padded')
  assert.equal(formatDegradationNote({}), '')
  assert.equal(formatDegradationNote(null), '')
})

check('the banner renders notes through the formatter, not impact || reason', () => {
  const workspace = read('../src/components/intelligence/ReportWorkspace.jsx')
  assert.match(workspace, /formatDegradationNote\(d\)/)
  assert.doesNotMatch(workspace, /d\.impact\s*\|\|\s*d\.reason/)
})

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
