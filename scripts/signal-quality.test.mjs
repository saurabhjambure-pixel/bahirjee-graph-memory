/**
 * Signal quality guards — the rules that decide whether a signal is worth showing:
 *   1. it must carry a READ ("so what for you"), not just a headline
 *   2. it must be about someone OTHER than the founder's own company
 *
 * Both were written against real defects in a live CareMother run: a signal that rendered
 * an empty "Where It Touches You" panel, and "CareMother deployed 114 monitors" scoring
 * 10/10 — the founder being told their own news.
 *
 * Also pinned here: stepAnalyze must disclose a batch that failed after retries rather than
 * only logging it. See the comment in that block for why it is a source assertion rather
 * than a call into stepAnalyze itself.
 *
 * Run: npm run test:signals
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { filterReadableSignals, filterSelfSignals } from '../src/services/intelligenceService.js'

// ── Read guard ──────────────────────────────────────────────────────────────────
{
  const signals = [
    { signal_headline: 'A', so_what_for_you: 'This lands squarely in your core agent network.' },
    { signal_headline: 'B' },                                   // no read at all (the CDSS defect)
    { signal_headline: 'C', so_what_for_you: '   ' },            // whitespace only
    { signal_headline: 'D', so_what_for_you: 'too short' },      // below the 15-char floor
    { signal_headline: 'E', strategic_implication: 'Your compliance surface just grew wider.' },
    { signal_headline: 'F', intelligence_assessment: 'Budget pressure is reaching your buyers.' },
  ]
  const kept = filterReadableSignals(signals)
  const heads = kept.map(s => s.signal_headline)

  assert.deepEqual(heads, ['A', 'E', 'F'], 'keeps only signals carrying a usable read')
  assert.ok(!heads.includes('B'), 'signal with no read is dropped (would render an empty panel)')
  assert.ok(!heads.includes('C'), 'whitespace-only read is dropped')
  assert.equal(filterReadableSignals([]).length, 0, 'empty input is safe')
  assert.equal(filterReadableSignals(null).length, 0, 'null input is safe')
}

// ── Self-signal guard ───────────────────────────────────────────────────────────
{
  const company = 'CareMother'
  const signals = [
    // The real defect: the founder's own deployment, reported back to them at 10/10.
    { signal_headline: 'own-deploy', entity_involved: 'CareMother by Doto Health' },
    { signal_headline: 'competitor', entity_involved: 'Janitri' },
    // Company named ALONGSIDE an outside actor — the outside actor is the news, so keep.
    { signal_headline: 'mixed', entity_involved: 'Janitri, CareMother' },
    { signal_headline: 'buyer', entity_involved: 'Health Family Welfare Department Gujarat' },
    { signal_headline: 'no-entity' },
  ]
  const kept = filterSelfSignals(signals, company).map(s => s.signal_headline)

  assert.ok(!kept.includes('own-deploy'), 'self-only signal is dropped')
  assert.ok(kept.includes('competitor'), 'competitor signal survives')
  assert.ok(kept.includes('mixed'), 'company named alongside an outside actor survives')
  assert.ok(kept.includes('buyer'), 'buyer/demand signal survives')
  assert.ok(kept.includes('no-entity'), 'signal with no named entity is not silently dropped')

  // Legal-suffix and casing noise must not defeat the match (normalizeBrandToken).
  const noisy = [{ signal_headline: 'x', entity_involved: 'caremother technologies pvt' }]
  assert.equal(filterSelfSignals(noisy, 'CareMother').length, 0, 'suffix/case noise still matches self')

  // Guard must no-op rather than nuke everything when the company name is unusable.
  assert.equal(filterSelfSignals(signals, '').length, signals.length, 'empty company name = no filtering')
  assert.equal(filterSelfSignals(signals, 'ab').length, signals.length, 'too-short token = no filtering')
}

// ── stepAnalyze discloses a batch lost to a failed LLM call ────────────────────
//
// A batch that exhausts callLLMWithRetry's own retries used to be caught, logged to the
// server console, and otherwise dropped — the report shipped thinner with nothing telling
// the founder why. Same failure shape as the write-time evidence loss in
// appendObservations()/observation-source-types.test.mjs: non-blocking was implemented as
// invisible instead of disclosed.
//
// stepAnalyze is not exported and is wired to callLLMWithRetry, ctx.timer and ctx.stepped —
// reaching it as a pure function would mean mocking the LLM gateway and the pipeline's
// invocation-budget timer, which is a bigger fixture than this guard is worth. So, like
// scripts/security-smoke-tests.mjs does for handler wiring, this pins the source shape
// directly: the catch block must count the failure and the loop must record a degradation
// for it. A refactor that moves this logic should carry the assertion with it, not delete it.
{
  const src = fs.readFileSync(new URL('../src/services/intelligenceService.js', import.meta.url), 'utf8')
  const start = src.indexOf('async function stepAnalyze')
  // The step's own section-comment marks the end. Not `\nasync function stepVerify` — that
  // export is `export async function stepVerify`, so a leading-`async` anchor never matched
  // and silently sliced to end-of-file (caught when this test was written).
  const end = src.indexOf('// ─── summary', start)
  const stepAnalyzeSrc = start >= 0 && end > start ? src.slice(start, end) : ''

  assert.ok(stepAnalyzeSrc.length > 0, 'stepAnalyze not found (or its trailing marker moved) — update the slice boundaries')

  // Brace-matching regex is the wrong tool here: `${a.cursor + 1}` inside the very log line
  // this checks for contains a literal `}` that a naive `[^}]*` stops on before it ever
  // reaches the assignment below it (also caught while writing this test). Check the two
  // literal statements occur, in order, rather than trying to regex-parse a brace-balanced
  // block.
  const catchIdx = stepAnalyzeSrc.indexOf('catch (err) {')
  assert.ok(catchIdx >= 0, 'stepAnalyze must catch a per-batch failure')
  const counterIdx = stepAnalyzeSrc.indexOf('failedBatches++', catchIdx)
  assert.ok(
    counterIdx > catchIdx && counterIdx < catchIdx + 300,
    'a failed analysis batch must increment a failure counter close to where it is caught, not just log and continue silently'
  )

  const guardIdx = stepAnalyzeSrc.indexOf('if (failedBatches > 0)')
  assert.ok(guardIdx > counterIdx, 'stepAnalyze must check failedBatches after the retry loop')
  const degradeIdx = stepAnalyzeSrc.indexOf('recordDegradation(', guardIdx)
  assert.ok(
    degradeIdx > guardIdx && degradeIdx < guardIdx + 100,
    'stepAnalyze must call recordDegradation when any batch failed, so the founder sees the gap'
  )
}

console.log('signal quality tests passed')
