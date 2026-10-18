/**
 * Every Gemini call must bound its thinking spend — in the form its model accepts.
 *
 * Thinking tokens are drawn from maxOutputTokens. Leave them unbounded and the model can
 * spend the budget reasoning and never finish the JSON — the response comes back
 * finishReason=MAX_TOKENS and the gateway salvages whatever partial object it can.
 *
 * That is a silent quality failure, not an error: the run completes, the brief is written,
 * and only some of the signals are in it. Measured on a real 15-observation analyzeSignals
 * batch against an 8000-token budget, thinking took 5790 tokens and the same input yielded
 * 7, then 5, then 2 signals across three identical calls.
 *
 * Gemini 3 changed the shape of the bound: it takes a `thinkingLevel`, and a request that
 * carries both `thinkingLevel` and the older numeric `thinkingBudget` is a 400 — which the
 * gateway's failover would turn into "every call quietly runs on the next model". So this
 * pins the bound per model family, from the real config builder, for every model in every
 * tier — not a regex over the source.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MODEL_TIERS, generationConfigFor, isGemini3 } from '../lib/handlers/gemini.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'lib/handlers/gemini.js'), 'utf8');
// Scan code, not prose: comments document the `thinking: null` escape hatch.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

let passed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('\ngemini thinking bound');

const LEVELS = new Set(['low', 'medium', 'high']);

check('every tier declares a thinking level every one of its models accepts', () => {
  for (const [tier, spec] of Object.entries(MODEL_TIERS)) {
    assert.ok(LEVELS.has(spec.thinking),
      `${tier} uses thinking '${spec.thinking}'. 'minimal' is rejected by gemini-3.8-flash, and a `
      + `rejected level fails every call over to the next model.`);
  }
});

check('every model in every tier gets a bounded config in its own family\'s form', () => {
  for (const [tier, spec] of Object.entries(MODEL_TIERS)) {
    for (const model of spec.defaults) {
      const cfg = generationConfigFor(model, { maxOutputTokens: 8000, thinking: spec.thinking });
      const t = cfg.thinkingConfig || {};
      assert.ok(t.thinkingLevel || t.thinkingBudget > 0, `${tier}/${model}: thinking is unbounded`);
      assert.ok(!(t.thinkingLevel && t.thinkingBudget != null),
        `${tier}/${model}: sends both thinkingLevel and thinkingBudget — a 400 on Gemini 3`);
      if (isGemini3(model)) {
        assert.equal(t.thinkingLevel, spec.thinking, `${tier}/${model}: Gemini 3 must get a thinkingLevel`);
        assert.ok(!('temperature' in cfg), `${tier}/${model}: Google advises against temperature < 1.0 on Gemini 3`);
      }
    }
  }
});

check('an env-pinned pre-3 model keeps the numeric budget it was tuned on', () => {
  const cfg = generationConfigFor('gemini-2.5-flash', { maxOutputTokens: 8000, thinking: 'low' });
  assert.ok(cfg.thinkingConfig?.thinkingBudget > 0);
  assert.ok(!('thinkingLevel' in cfg.thinkingConfig));
  assert.equal(typeof cfg.temperature, 'number');
});

check('no call site opts out of the bound', () => {
  const optedOut = [...code.matchAll(/thinking:\s*null/g)];
  assert.deepEqual(
    optedOut.map(m => code.slice(Math.max(0, m.index - 60), m.index + 20)), [],
    'a call site passes `thinking: null`; that is the exact shape that truncated analyzeSignals. '
    + 'If it is deliberate, document why here and delete this assertion.'
  );
});

check('no request builds its generationConfig by hand', () => {
  // A hand-built config is how a call skips the per-model-family builder entirely.
  const literal = [...code.matchAll(/generationConfig:\s*\{/g)];
  assert.equal(literal.length, 0, 'every generationConfig must come from generationConfigFor()');
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
