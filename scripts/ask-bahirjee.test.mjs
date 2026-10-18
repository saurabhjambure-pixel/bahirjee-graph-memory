/**
 * Ask Bahirjee — the context round trip.
 *
 * This file exists because of a bug that shipped and ran in production for months without
 * a single error: `askBahirjee` built a compressed context STRING and passed it where
 * `PROMPTS.answerQuestion` reads OBJECT PROPERTIES.
 *
 * Every consequence was silent:
 *   • `context.company_name` → "Company: undefined"
 *   • `context._sourceDocuments` → {} → "No source documents available."
 *   • `context._decision` → falsy → the decision block never rendered, not even on a
 *     decision run, against a question the founder was asking about that very decision
 *   • and the template never interpolates a bare `${context}`, so the compressed string
 *     was not degraded — it was DISCARDED. Every answer came from the signal JSON and the
 *     question alone.
 *
 * The answers still read fluently, which is exactly why nobody noticed. A grounded answer
 * and an ungrounded one look the same until you check the sources.
 *
 * The invariant: every property the prompt reads off `context` must be one the caller
 * actually sends. Same shape as the observation-roundtrip and agenda tests.
 *
 * Run: npm run test:ask
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PROMPTS } from '../src/services/promptUtils.js'
import { buildAnswerContext } from '../src/services/intelligenceService.js'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const prompts = read('../src/services/promptUtils.js')
const service = read('../src/services/intelligenceService.js')
const gemini = read('../lib/handlers/gemini.js')
const llmUtils = read('../lib/_llmUtils.js')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 }
}

const FULL = {
  company_name: 'CareMother',
  industry: 'Maternal health tech',
  sensitivity_map: { regulatory: 'High' },
  _decision: { id: 'd1', decision_statement: 'Kerala or Maharashtra?' },
  _sourceDocuments: { website: 'W'.repeat(40000), linkedin: 'L'.repeat(9000), uploadedDoc: 'U'.repeat(30000) },
}

// ─── The round trip ─────────────────────────────────────────────────────────

check('every property the prompt reads off `context` is one buildAnswerContext sends', () => {
  const body = prompts.slice(prompts.indexOf('answerQuestion:'), prompts.indexOf('generateDecisionBrief:'))
  const reads = new Set([...body.matchAll(/context\??\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]))
  assert.ok(reads.size >= 4, `expected the prompt to read several fields, found ${reads.size}`)

  const sent = buildAnswerContext(FULL)
  for (const field of reads) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(sent, field),
      `the prompt reads context.${field} but buildAnswerContext never sends it — it would ` +
      `render as "undefined" in front of a founder, and nothing would throw`
    )
  }
})

check('the caller sends an object, never the compressed string', () => {
  const fn = service.slice(service.indexOf('export async function askBahirjee'))
  const payloadAt = fn.indexOf('const payload =')
  const payload = fn.slice(payloadAt, payloadAt + 400)
  assert.match(payload, /context: buildAnswerContext\(context\)/,
    'this is the whole bug: a string has no .company_name, no ._sourceDocuments and no ._decision')
  assert.ok(!/context: contextForQuestion/.test(fn))
})

check('the narrative digest has somewhere to go', () => {
  const fn = service.slice(service.indexOf('export async function askBahirjee'))
  assert.match(fn, /digest/,
    'the summary, top signals, memory cards and RAG excerpts are assembled at real cost; ' +
    'before the fix they were assembled and then dropped')
  const body = prompts.slice(prompts.indexOf('answerQuestion:'), prompts.indexOf('generateDecisionBrief:'))
  assert.match(body, /\$\{digest \?/, 'the prompt must actually render it')
})

check('BOTH gateway call sites forward the digest', () => {
  // answerQuestion is built in two places — gemini.js and the shared OpenAI-compat handler
  // used by claude/groq/sarvam. Fixing one leaves the other silently ungrounded, and which
  // one you hit depends on a provider env var.
  assert.match(gemini, /PROMPTS\.answerQuestion\(context, signal, question, digest \|\| ''\)/)
  assert.match(llmUtils, /PROMPTS\.answerQuestion\(context, signal, question, payload\.digest \|\| ''\)/)
})

// ─── What the founder actually gets ─────────────────────────────────────────

check('a real context renders every block, with nothing undefined', () => {
  const p = PROMPTS.answerQuestion(buildAnswerContext(FULL), { signal_headline: 'x' }, 'q?', 'Summary: ...')
  assert.match(p, /Company: CareMother/)
  assert.match(p, /Industry: Maternal health tech/)
  assert.match(p, /WEBSITE SOURCE/)
  assert.match(p, /WHAT YOU ALREADY KNOW/)
  assert.ok(!p.includes('undefined'), 'no field may leak the word "undefined" to a founder')
  assert.ok(!p.includes('No source documents available.'),
    'the source block must fire when documents were supplied')
})

check('the decision block fires on a decision run', () => {
  const p = PROMPTS.answerQuestion(buildAnswerContext(FULL), null, 'q?')
  assert.match(p, /DECISION CONTEXT/,
    'a founder asking a follow-up during a decision run was never told a decision was in ' +
    'play — this block has never once rendered')
  assert.match(p, /Kerala or Maharashtra/)
})

check('no decision, no decision block', () => {
  const p = PROMPTS.answerQuestion(buildAnswerContext({ ...FULL, _decision: null }), null, 'q?')
  assert.ok(!p.includes('DECISION CONTEXT'))
})

check('a missing context degrades to "unknown", never to "undefined"', () => {
  for (const c of [null, undefined, {}, 'a string, the old bug']) {
    const p = PROMPTS.answerQuestion(buildAnswerContext(c), null, 'q?')
    assert.ok(!p.includes('undefined'), `"${typeof c}" context leaked undefined`)
    assert.match(p, /Company: unknown/)
  }
})

// ─── Payload size ───────────────────────────────────────────────────────────

check('source documents are capped before they cross the wire', () => {
  const sent = buildAnswerContext(FULL)
  assert.equal(sent._sourceDocuments.website.length, 15000)
  assert.equal(sent._sourceDocuments.uploadedDoc.length, 10000)
  assert.equal(sent._sourceDocuments.linkedin.length, 5000, 'LinkedIn caps at 5000, matching the prompt')
  const small = buildAnswerContext({ _sourceDocuments: { website: 'short' } })
  assert.equal(small._sourceDocuments.website, 'short', 'under the cap, passed through whole')
  assert.equal(small._sourceDocuments.linkedin, undefined, 'an absent document stays absent, not empty-string')
})

check('the whole context is not shipped — only what the prompt reads', () => {
  const sent = buildAnswerContext({ ...FULL, _docIntel: { huge: 'x'.repeat(100000) }, signals: new Array(500) })
  assert.ok(!('_docIntel' in sent), 'this payload crosses HTTP on every question a founder asks')
  assert.ok(!('signals' in sent))
})

check('the advice guard survives the rewrite', () => {
  const body = prompts.slice(prompts.indexOf('answerQuestion:'), prompts.indexOf('generateDecisionBrief:'))
  assert.match(body, /Do NOT give advice/)
  assert.match(body, /Be explanatory, not prescriptive/)
  assert.match(body, /UNTRUSTED WEB CONTENT/,
    'the grounding documents are scraped from the public web and must stay fenced as data')
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
