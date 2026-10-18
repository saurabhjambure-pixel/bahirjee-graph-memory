/**
 * Context-first Q&A tests (v29 — Move 5 of the company-context plan).
 *
 * askBahirjee's INTENT was always "answer from context, then the web" — but two real bugs
 * meant that intent never actually reached the model:
 *
 *   1. askBahirjee built a rich contextForQuestion STRING and sent it as payload.context.
 *      answerQuestion's template did PROPERTY ACCESS on it (context.company_name,
 *      context._sourceDocuments, context._decision) — a string has none of those, so every
 *      real call rendered "Company: undefined" / "No source documents available" and threw
 *      away everything askBahirjee had just assembled.
 *   2. The handler called callGeminiText (free-form text), not callGeminiJSON, so there was
 *      no way to return a structured sufficiency signal — every escalation decision was a
 *      regex guess at the answer's wording.
 *
 * This file pins the fix: the real context object reaches the template, the response is a
 * real { answer, sufficiency, stale_facts_cited } envelope, and escalation is a genuine
 * decision — including that the model can never invent a "stale fact" to force one.
 *
 * Run: npm run test:qna-retrieval
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  askBahirjee, configureIntelligenceRuntime, resetIntelligenceRuntime,
} from '../src/services/intelligenceService.js'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const intelligenceService = read('../src/services/intelligenceService.js')
const promptUtils = read('../src/services/promptUtils.js')
const gemini = read('../lib/handlers/gemini.js')
const ragService = read('../src/services/ragService.js')

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

const checkAsync = async (name, fn) => {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`)
    process.exitCode = 1
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
const daysAgoIso = (n) => new Date(Date.now() - n * 86400000).toISOString()

/**
 * Mocks intelligenceRuntime.postJson so askBahirjee runs its REAL logic end to end with no
 * network access. Dispatches by URL/action the same way callProviderAPI/fetchTavilySearch
 * actually call it. `answerQueue[n]` is returned for the (n+1)th answerQuestion call — index
 * 0 is always Stage 1; index 1, if reached, is Stage 2's retry with webResults attached.
 */
function mockRuntime(answerQueue, tavilyResults = [{ url: 'https://example.com/finding', content: 'x'.repeat(600) }]) {
  const calls = { gemini: 0, search: 0, embed: 0 }
  const postJson = async (url, body) => {
    if (url.includes('/search')) { calls.search++; return jsonResponse({ results: tavilyResults }) }
    if (url.includes('/gemini')) {
      if (body.action === 'embed') {
        calls.embed++
        return jsonResponse({ embeddings: (body.payload?.texts || []).map(() => new Array(768).fill(0.01)) })
      }
      if (body.action === 'answerQuestion') {
        const i = calls.gemini++
        return jsonResponse(answerQueue[Math.min(i, answerQueue.length - 1)])
      }
    }
    throw new Error(`unexpected postJson call to ${url}`)
  }
  return { postJson, calls }
}

const LONG_ANSWER = 'A confident, sufficiently detailed answer that clears the eighty character minimum this codebase already treats as a floor for quality.'

// ─── 1. the data-flow bug: context must reach the template as an object ─────

check('askBahirjee sends the real context object, not a pre-flattened string', () => {
  const start = intelligenceService.indexOf('export async function askBahirjee')
  const body = intelligenceService.slice(start, intelligenceService.indexOf('\n}\n', start))
  assert.match(
    body, /basePayload\s*=\s*\{\s*context,/,
    'payload.context must be the context object itself — a pre-rendered string reaches ' +
    'answerQuestion\'s template, which does property access (context.company_name, ' +
    'context._sourceDocuments) that a string has none of. That was the bug: every real call ' +
    'rendered "Company: undefined" and discarded everything else assembled for the prompt.'
  )
})

check('answerQuestion reads context as an object, and handles signal === null explicitly', () => {
  const start = promptUtils.indexOf('answerQuestion: (context, signal, question')
  assert.notEqual(start, -1, 'answerQuestion signature not found — this test is pinned to it')
  const body = promptUtils.slice(start, promptUtils.indexOf('\n  },', start))
  assert.match(body, /context\?\.\_sourceDocuments|context\._sourceDocuments/, 'must still read the real _sourceDocuments field')
  assert.match(
    body, /signal\s*\?/,
    'must branch on signal being present — StrategicInteractionHub.jsx already calls ' +
    'onAsk(null, question) for a general question; a template that always says "a follow-up ' +
    'about a specific signal" misdescribes every one of those to the model'
  )
})

// ─── 2. the response-shape bug: a structured envelope, not free text ────────

check('the gemini handler uses JSON mode for answerQuestion, not free-form text', () => {
  const start = gemini.indexOf('async function handleAnswerQuestion')
  assert.notEqual(start, -1)
  const body = gemini.slice(start, gemini.indexOf('\n}\n', start))
  assert.match(body, /callGeminiJSON\(/, 'callGeminiText returns an unparsed string — there is nowhere for sufficiency to live in that')
  assert.match(body, /sufficiency/, 'the schema must declare sufficiency')
  assert.match(body, /stale_facts_cited/, 'the schema must declare stale_facts_cited')
})

check('callGeminiText was removed, not left as dead code', () => {
  assert.ok(
    !/function callGeminiText/.test(gemini),
    'handleAnswerQuestion was its only caller; leaving it after the JSON-mode switch is ' +
    'unreferenced code with no test or comment explaining why it is still there'
  )
})

// ─── 3. escalation is a real decision — the model cannot invent a reason ────

check('askBahirjee only escalates on a stale-fact citation the ledger actually has', () => {
  const start = intelligenceService.indexOf('export async function askBahirjee')
  const body = intelligenceService.slice(start, intelligenceService.indexOf('\n}\n', start))
  assert.match(
    body, /knownStaleFields\.has\(/,
    'the model\'s stale_facts_cited must be checked against staleFacts computed by THIS ' +
    'process (listStaleFacts) — trusting the citation blind lets a model force a web ' +
    'escalation by naming any field, real or not'
  )
})

check('askBahirjee never reads a date field out of the LLM response for staleness', () => {
  const start = intelligenceService.indexOf('export async function askBahirjee')
  const body = intelligenceService.slice(start, intelligenceService.indexOf('\n}\n', start))
  assert.ok(
    !/envelope\.as_of|envelope\.date/.test(body),
    'staleness must come from listStaleFacts (context._factProvenance, this process\'s own ' +
    'clock) — never from anything the model returned'
  )
  assert.match(body, /listStaleFacts\(context\)/)
})

// ─── 4. Stage 1 → 2 → 3 behaviour, exercised for real (mocked network only) ─

await checkAsync('a high-sufficiency Stage 1 answer never triggers a web search', async () => {
  const { postJson, calls } = mockRuntime([
    { answer: LONG_ANSWER, sufficiency: 'high', stale_facts_cited: [] },
  ])
  configureIntelligenceRuntime({ postJson })
  try {
    const answer = await askBahirjee({ company_name: 'Acme', _factProvenance: {} }, null, 'What do we know?')
    assert.equal(answer, LONG_ANSWER)
    assert.equal(calls.search, 0, 'Stage 1 was sufficient — Tavily must never be called')
  } finally {
    resetIntelligenceRuntime()
  }
})

await checkAsync('a low-sufficiency Stage 1 answer escalates to the web and returns Stage 2\'s answer', async () => {
  // Deliberately well-formed, ordinary-length text with NO low-quality wording — this
  // proves sufficiency drives escalation on its own, separately from the old
  // isLowQualityAnswer text regex (callLLMWithRetry's OWN internal quality-retry loop
  // matches that regex and would otherwise re-call answerQuestion itself before askBahirjee
  // ever sees a result, which is a different, unrelated mechanism this test must not trip).
  const stage2 = 'A confident Stage two answer built from the web search results this question just triggered.'
  const { postJson, calls } = mockRuntime([
    { answer: 'The company appears to operate in this space, though the sources on hand only speak to it in general terms.', sufficiency: 'low', stale_facts_cited: [] },
    { answer: stage2, sufficiency: 'high', stale_facts_cited: [] },
  ])
  configureIntelligenceRuntime({ postJson })
  try {
    const answer = await askBahirjee({ company_name: 'Acme', _factProvenance: {} }, null, 'What changed recently?')
    assert.equal(calls.search, 1, 'Stage 1 was insufficient — Tavily must be called exactly once')
    assert.equal(answer, stage2)
  } finally {
    resetIntelligenceRuntime()
  }
})

await checkAsync('a model-invented "stale fact" not in the ledger does not force escalation', async () => {
  const { postJson, calls } = mockRuntime([
    // Cites a field, but _factProvenance below has NO entries at all — nothing is stale.
    { answer: LONG_ANSWER, sufficiency: 'high', stale_facts_cited: ['company_dna.funding_stage'] },
  ])
  configureIntelligenceRuntime({ postJson })
  try {
    const answer = await askBahirjee({ company_name: 'Acme', _factProvenance: {} }, null, 'What is the funding stage?')
    assert.equal(calls.search, 0, 'the cited field is not in this context\'s ledger — it must not force a web check')
    assert.equal(answer, LONG_ANSWER)
  } finally {
    resetIntelligenceRuntime()
  }
})

await checkAsync('a genuinely stale cited fact forces escalation even at "high" sufficiency', async () => {
  const stage2 = 'A confident Stage two answer that reconfirms the funding stage from a fresh web search.'
  const context = {
    company_name: 'Acme',
    _factProvenance: { 'company_dna.funding_stage': { as_of: daysAgoIso(120), source_url: null, confidence: null } },
  }
  const { postJson, calls } = mockRuntime([
    { answer: LONG_ANSWER, sufficiency: 'high', stale_facts_cited: ['company_dna.funding_stage'] },
    { answer: stage2, sufficiency: 'high', stale_facts_cited: [] },
  ])
  configureIntelligenceRuntime({ postJson })
  try {
    const answer = await askBahirjee(context, null, 'What is the funding stage?')
    assert.equal(calls.search, 1, 'the ledger genuinely has this field 120 days stale — it must force a web check')
    assert.equal(answer, stage2)
  } finally {
    resetIntelligenceRuntime()
  }
})

await checkAsync('Stage 3 write-back is attempted but never breaks the answer when it fails', async () => {
  // No Supabase credentials in this test environment — ingestObservation's own `if
  // (!supabase)` guard makes this a graceful no-op, which is exactly the case being pinned:
  // a write-back failure must never surface to the caller or change the returned answer.
  const stage2 = 'A confident Stage two answer that should reach the caller regardless of the write-back outcome.'
  const { postJson } = mockRuntime([
    { answer: 'The available sources only speak to this in passing, without much specific detail either way.', sufficiency: 'low', stale_facts_cited: [] },
    { answer: stage2, sufficiency: 'high', stale_facts_cited: [] },
  ])
  configureIntelligenceRuntime({ postJson })
  try {
    const answer = await askBahirjee(
      { company_name: 'Acme', _factProvenance: {} }, null, 'Any updates?', [],
      { clientId: 'test-client-id' }
    )
    assert.equal(answer, stage2)
  } finally {
    resetIntelligenceRuntime()
  }
})

// ─── 5. the knowledge store is actually wired in, not wired-but-off ─────────

check('askBahirjee accepts and forwards knowledgeChunks to the prompt payload', () => {
  const start = intelligenceService.indexOf('export async function askBahirjee')
  const body = intelligenceService.slice(start, intelligenceService.indexOf('\n}\n', start))
  assert.match(body, /knowledgeChunks/, 'v29 adding a knowledge store nobody reads from is exactly the state this migration exists to end')
})

check('IntelligenceDashboard and ReportViewer both retrieve knowledgeChunks before asking', () => {
  const dashboard = read('../src/components/IntelligenceDashboard.jsx')
  const viewer = read('../src/components/ReportViewer.jsx')
  for (const [name, src] of [['IntelligenceDashboard.jsx', dashboard], ['ReportViewer.jsx', viewer]]) {
    assert.match(src, /kinds:\s*\[['"]signal['"],\s*['"]observation['"]\]/, `${name} must fetch signal/observation chunks, not just uploaded_doc ones`)
  }
})

check('stepPersist embeds this run\'s signals via ingestSignals', () => {
  assert.match(intelligenceService, /ingestSignals\(/, 'stepPersist must call ingestSignals so a later question can retrieve THIS run\'s signals')
})

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`)
