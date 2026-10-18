import { PROMPTS } from '../../src/services/promptUtils.js';
import { applyApiSecurity } from '../_security.js';
import { requireAuthenticatedUser } from '../_auth.js';
import { parseProviderJSON, salvageTruncatedJSON, fetchWithTimeout, applyLlmMeta, ModelFailureTracker } from '../_llmUtils.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIGURATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const REQUEST_TIMEOUT_MS = 45000;
const VERCEL_FUNCTION_DEADLINE_MS = 55000; // Leave 5s buffer before Vercel's 60s limit
const MAX_SERVER_RETRIES = 2;
const SUPPORTED_ACTIONS = ['buildContext', 'mergeContext', 'frameDecision', 'generateQueries', 'analyzeSignals', 'generateSummary', 'generateDecisionBrief', 'answerQuestion', 'interpretShifts', 'triageDaily', 'weighDecision', 'deliberate', 'embed', 'extractDocumentIntel', 'graphAgentStep'];

// Embeddings for the RAG layer (uploaded documents). text-embedding-004 was retired on
// 2026-01-14 and ragService swallowed the failure, so document Q&A ran without its documents
// for months. gemini-embedding-001 truncates to 768 dims (Matryoshka) to match the
// vector(768) column in v7_rag_document_chunks.sql.
const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIMENSIONS = 768;
const EMBEDDING_TASK_TYPES = new Set(['RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY']);

// Model tiers. Each is an ordered failover list; the lead is overridable by env. The 2.5
// family is absent on purpose: Google recorded 2026-10-16 as its shutdown.
//
//   heavy     — extraction everything downstream inherits (context, signals, doc intel, Q&A)
//   light     — small structured outputs (query generation, decision framing)
//   reasoning — the founder-facing judgment calls. 3.1 Pro is preview-only with no GA
//               successor, so its fallback is a GA Flash, not another Pro.
//
// `thinking` is the Gemini 3 thinkingLevel. 'minimal' is never used: 3.8 Flash rejects it,
// and a rejected level would fail every call over to the next model.
export const MODEL_TIERS = {
    heavy: { env: 'GEMINI_MODEL', thinking: 'low', defaults: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'] },
    light: { env: 'GEMINI_LIGHT_MODEL', thinking: 'low', defaults: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'] },
    reasoning: { env: 'GEMINI_REASONING_MODEL', thinking: 'medium', defaults: ['gemini-3.1-pro-preview', 'gemini-3.8-flash', 'gemini-3.6-flash'] },
};

// Bound for a pre-3 model pinned by env. See callGeminiJSON for the measurement behind it:
// unbounded thinking consumed 5790 of an 8000-token budget and truncated the output.
const LEGACY_THINKING_BUDGET = 1024;
const LEGACY_TEMPERATURE = 0.2;

const GEMINI_API_BASE = () => process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

export const isGemini3 = (model) => /^gemini-3/.test(String(model || ''));

/**
 * The generationConfig for one attempt on one model. Built per attempt, not per call:
 * failover changes the model, and Gemini 3 and 2.x take incompatible thinking settings.
 *
 * Gemini 3 takes `thinkingLevel` and rejects a request carrying both it and
 * `thinkingBudget`; Google also advises against temperature below its 1.0 default (it can
 * loop), so none is sent. A pre-3 model keeps exactly the settings it was tuned on.
 */
export function generationConfigFor(model, { maxOutputTokens, schema = null, json = true, thinking = null } = {}) {
    const config = { maxOutputTokens };
    if (json) config.response_mime_type = 'application/json';
    if (schema) config.responseSchema = schema;
    if (isGemini3(model)) {
        if (thinking) config.thinkingConfig = { thinkingLevel: thinking };
    } else {
        config.temperature = LEGACY_TEMPERATURE;
        if (thinking) config.thinkingConfig = { thinkingBudget: LEGACY_THINKING_BUDGET };
    }
    return config;
}

/** Ordered model list for a tier: a valid env lead first, then the defaults, deduped. */
export function modelsForTier(tier = 'heavy') {
    const spec = MODEL_TIERS[tier] || MODEL_TIERS.heavy;
    const lead = process.env[spec.env];
    const effectiveLead = lead && lead !== 'gemini-1.5-pro' ? lead : null;
    return effectiveLead
        ? [effectiveLead, ...spec.defaults.filter(m => m !== effectiveLead)]
        : [...spec.defaults];
}

const thinkingForTier = (tier) => (MODEL_TIERS[tier] || MODEL_TIERS.heavy).thinking;

// Safety settings shared across all Gemini JSON/text calls.
// Defined once here to avoid repetition in every request body.
const GEMINI_SAFETY_SETTINGS = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
];

// Cross-request model health: if a model exhausts retries (429/5xx) repeatedly, it
// enters a short cooldown and subsequent requests prefer the next model in the list.
const modelFailureTracker = new ModelFailureTracker();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function handler(req, res) {
    if (await applyApiSecurity(req, res, { routeKey: 'gemini', maxRequests: 25 })) return;
    if (!await requireAuthenticatedUser(req, res, { rateLimit: { routeKey: 'gemini', maxRequests: 25 } })) return;

    const { action, payload } = req.body || {};
    const handlerStartTime = Date.now();

    if (!SUPPORTED_ACTIONS.includes(action) || !payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'Invalid action or payload' });
    }

    // Warn if a deprecated model is pinned via env
    const envModel = process.env.GEMINI_MODEL;
    if (envModel === 'gemini-1.5-pro') {
        console.warn('[gemini] gemini-1.5-pro is deprecated and will be ignored. Using ordered model list instead.');
    }

    try {
        switch (action) {
            case 'buildContext':
                return await handleBuildContext(payload, res, handlerStartTime);
            case 'mergeContext':
                return await handleMergeContext(payload, res, handlerStartTime);
            case 'frameDecision':
                return await handleFrameDecision(payload, res, handlerStartTime);
            case 'generateQueries':
                return await handleGenerateQueries(payload, res, handlerStartTime);
            case 'analyzeSignals':
                return await handleAnalyzeSignals(payload, res, handlerStartTime);
            case 'generateSummary':
                return await handleGenerateSummary(payload, res, handlerStartTime);
            case 'generateDecisionBrief':
                return await handleGenerateDecisionBrief(payload, res, handlerStartTime);
            case 'answerQuestion':
                return await handleAnswerQuestion(payload, res, handlerStartTime);
            case 'interpretShifts':
                return await handleInterpretShifts(payload, res, handlerStartTime);
            case 'triageDaily':
                return await handleTriageDaily(payload, res, handlerStartTime);
            case 'weighDecision':
                return await handleWeighDecision(payload, res, handlerStartTime);
            case 'deliberate':
                return await handleDeliberate(payload, res, handlerStartTime);
            case 'extractDocumentIntel':
                return await handleExtractDocumentIntel(payload, res, handlerStartTime);
            case 'graphAgentStep':
                return await handleGraphAgentStep(payload, res, handlerStartTime);
            case 'embed':
                return await handleEmbed(payload, res);
            default:
                return res.status(400).json({ error: 'Invalid action' });
        }
    } catch (error) {
        console.error(`[Gemini] API Error (action=${action}):`, error.message);
        return res.status(500).json({ error: error.message, provider: 'gemini' });
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HANDLERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleBuildContext(payload, res, startTime) {
    const { url, linkedin, rawText } = payload;
    const prompt = PROMPTS.buildContext(url, linkedin, rawText);
    const meta = {};
    const result = await callGeminiJSON(prompt, { maxOutputTokens: 6000, startTime, meta });
    applyLlmMeta(res, meta);
    return res.json(result);
}

/**
 * Fold new sources into an existing context.
 *
 * maxOutputTokens is a quarter of buildContext's: a patch is small by construction, and a
 * generous ceiling here would just invite the model to restate the whole context — the
 * exact failure the patch schema exists to prevent.
 */
async function handleMergeContext(payload, res, startTime) {
    const { existingSummary, newSourceText, protectedFields } = payload;
    const prompt = PROMPTS.mergeContext(existingSummary, newSourceText, protectedFields || []);
    const meta = {};
    const result = await callGeminiJSON(prompt, { maxOutputTokens: 1500, startTime, meta });
    applyLlmMeta(res, meta);
    return res.json(result);
}

async function handleFrameDecision(payload, res, startTime) {
    const { rawText, context } = payload;
    if (!rawText || String(rawText).trim().length < 12) {
        return res.status(400).json({ error: 'rawText must describe a decision' });
    }
    const prompt = PROMPTS.frameDecision(rawText, context || {});
    const schema = {
        type: "OBJECT",
        properties: {
            raw_input: { type: "STRING" },
            decision_statement: { type: "STRING" },
            decision_type: { type: "STRING" },
            objective: { type: "STRING" },
            options: {
                type: "ARRAY",
                items: { type: "OBJECT", properties: { id: { type: "STRING" }, label: { type: "STRING" }, description: { type: "STRING" } }, required: ["label"] }
            },
            constraints: { type: "ARRAY", items: { type: "STRING" } },
            time_horizon: { type: "STRING" },
            geography: { type: "STRING" },
            stakeholders: { type: "ARRAY", items: { type: "STRING" } },
            success_criteria: { type: "ARRAY", items: { type: "STRING" } },
            sub_questions: { type: "ARRAY", items: { type: "STRING" } },
            unresolved_questions: { type: "ARRAY", items: { type: "STRING" } }
        },
        required: ["decision_statement", "options", "objective", "sub_questions"]
    };
    const meta = {};
    const result = await callGeminiJSON(prompt, { maxOutputTokens: 1800, schema, startTime, meta, tier: 'light' });
    applyLlmMeta(res, meta);
    return res.json(result);
}

async function handleExtractDocumentIntel(payload, res, startTime) {
    const { docText, companyHint, todayIso } = payload;
    if (!docText) return res.status(400).json({ error: 'docText required for extractDocumentIntel' });
    const prompt = PROMPTS.extractDocumentIntel(docText, companyHint, todayIso);
    const meta = {};
    const result = await callGeminiJSON(prompt, { maxOutputTokens: 4000, startTime, meta });
    applyLlmMeta(res, meta);
    return res.json(result);
}

async function handleGenerateQueries(payload, res, startTime) {
    const { context, competitors, dateStr } = payload;
    const prompt = PROMPTS.buildQuery(context, competitors, dateStr);

    const schema = {
        type: "OBJECT",
        properties: {
            competitor_intel: { type: "ARRAY", items: { type: "STRING" } },
            talent_signals: { type: "ARRAY", items: { type: "STRING" } },
            funding_intel: { type: "ARRAY", items: { type: "STRING" } },
            customer_shifts: { type: "ARRAY", items: { type: "STRING" } },
            regulatory_lens: { type: "ARRAY", items: { type: "STRING" } },
            market_expansion: { type: "ARRAY", items: { type: "STRING" } },
            industry_momentum: { type: "ARRAY", items: { type: "STRING" } }
        },
        required: [
            "competitor_intel",
            "talent_signals",
            "funding_intel",
            "customer_shifts",
            "regulatory_lens",
            "market_expansion",
            "industry_momentum"
        ]
    };

    // 1200, not the 400 this used to run on: Gemini 3 thinking tokens come out of the same
    // budget, and a low thinking level is a hint, not a cap. The list itself is ~300 tokens.
    const meta = {};
    const { parsed: result, usage } = await callGeminiJSONWithUsage(prompt, { maxOutputTokens: 1200, schema, startTime, meta, tier: 'light' });
    applyLlmMeta(res, { ...meta, tokens: usage?.totalTokenCount ?? null });
    return res.json({ ...result, _gemini_usage: usage });
}

/**
 * The signal shape Gemini is constrained to. Exported so a test can pin that every field
 * the prompt asks for is representable — a field missing here is silently never returned.
 *
 * Enforces the signal shape (schema-constrained JSON) instead of relying on parse/salvage.
 * None of the temporal fields are required — the model omits them when no real date
 * exists, and a REQUIRED date is an instruction to invent one.
 */
export function buildSignalResponseSchema(quoteBinding = false) {
    const schema = {
        type: "ARRAY",
        items: {
            type: "OBJECT",
            properties: {
                // Legacy name, still accepted so a response from a cached or older model
                // revision normalizes cleanly. `event_date` is the field we ask for.
                date: { type: "STRING" },
                // ── temporal contract (v27) ─────────────────────────────────
                // Constrained decoding can only emit properties present HERE. A field the
                // prompt asks for and the schema omits is silently unrepresentable — the
                // exact mismatch that produced an empty hero observation in every brief.
                event_date: { type: "STRING" },
                evidence_role: { type: "STRING" },
                date_confidence: { type: "STRING" },
                // How older evidence reaches the brief without being disguised as current:
                // attached to a recent anchor rather than emitted as its own signal.
                supporting_source_urls: { type: "ARRAY", items: { type: "STRING" } },
                category: { type: "STRING" },
                signal_headline: { type: "STRING" },
                the_move: { type: "STRING" },
                so_what_for_you: { type: "STRING" },
                // The reasoning layer: why the fact supports the read, and what would
                // overturn it. Declared here because constrained decoding can only emit
                // properties present in this schema (see the empty-observation bug).
                analyst_note: { type: "STRING" },
                timing_window: { type: "STRING" },
                entity_involved: { type: "STRING" },
                relevance_score: { type: "NUMBER" },
                confidence: { type: "STRING" },
                source_url: { type: "STRING" },
                // The door, for DemandSignal / PartnershipOpportunity / FundingOpportunity only.
                // Optional, never required: a required object is an instruction to invent one.
                // `status` is deliberately absent — opportunityFields.js computes it.
                opportunity: {
                    type: "OBJECT",
                    properties: {
                        counterparty: { type: "STRING" },
                        trigger: { type: "STRING" },
                        deadline: { type: "STRING" },
                        deadline_quote: { type: "STRING" },
                        amount: { type: "STRING" },
                        fit: { type: "ARRAY", items: { type: "STRING" } },
                        unknowns: { type: "ARRAY", items: { type: "STRING" } },
                    },
                },
            },
            required: ["category", "signal_headline", "the_move", "entity_involved", "source_url"]
        }
    };

    // Quote-binding harness (opt-in): require a verbatim evidence_quote per signal so the
    // client-side verifier can drop any signal whose supporting text isn't in the source.
    if (quoteBinding) {
        schema.items.properties.evidence_quote = { type: "STRING" };
        schema.items.required = [...schema.items.required, "evidence_quote"];
    }
    return schema;
}

async function handleAnalyzeSignals(payload, res, startTime) {
    const { context, searchResults, temporalPolicy, previousSignals, quoteBinding = false } = payload;
    const prompt = PROMPTS.buildSignals(context, searchResults, temporalPolicy, previousSignals, quoteBinding);

    const schema = buildSignalResponseSchema(quoteBinding);

    const meta = {};
    const result = await callGeminiJSON(prompt, { maxOutputTokens: 8000, schema, startTime, meta });
    applyLlmMeta(res, meta);
    return res.json(result);
}

/**
 * The summary's constrained-decoding schema. It must name EVERY field the prompt's OUTPUT
 * JSON asks for: Gemini emits only what the schema lists, so a field the prompt requests
 * and the schema omits is silently never written — no error, a brief that is just
 * quietly shorter. That is how `why_it_matters` shipped empty on every brief from
 * 2026-08-16, and why `headline` and `what_to_consider` were always derived rather than
 * written. scripts/gemini-request.test.mjs pins prompt keys ⊆ schema keys.
 */
export function buildSummarySchema() {
    return {
        type: "OBJECT",
        properties: {
            headline: { type: "STRING" },
            bahirjee_observation: { type: "STRING" },
            why_it_matters: { type: "STRING" },
            what_could_change_our_view: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: { text: { type: "STRING" }, watch_for: { type: "STRING" } },
                    required: ["text"]
                }
            },
            what_to_consider: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: { text: { type: "STRING" }, tradeoff: { type: "STRING" } },
                    required: ["text"]
                }
            },
            assumption_status: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: { statement: { type: "STRING" }, status: { type: "STRING" }, note: { type: "STRING" } },
                    required: ["statement", "status"]
                }
            },
            insights: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: {
                        type: { type: "STRING" },
                        text: { type: "STRING" }
                    },
                    required: ["type", "text"]
                }
            }
        },
        required: ["bahirjee_observation", "insights"]
    };
}

async function handleGenerateSummary(payload, res, startTime) {
    const { context, signals, synthesis, temporal } = payload;
    const prompt = PROMPTS.buildSummary(context, signals, synthesis, temporal);

    const schema = buildSummarySchema();

    const meta = {};
    // Reasoning tier: the founder-facing brief. maxOutputTokens covers medium-level thinking
    // plus the insights JSON (~2500); the ceiling costs nothing unless used.
    const result = await callGeminiJSON(prompt, { maxOutputTokens: 10240, schema, startTime, meta, tier: 'reasoning' });
    applyLlmMeta(res, meta);
    return res.json({ summary: result });
}

async function handleGenerateDecisionBrief(payload, res, startTime) {
    const { context, decision, signals, synthesis } = payload;
    const prompt = PROMPTS.generateDecisionBrief(context, decision, signals, synthesis);
    const schema = {
        type: "OBJECT",
        properties: {
            decision_snapshot: { type: "STRING" },
            current_read: { type: "STRING" },
            confidence: { type: "STRING" },
            option_assessments: {
                type: "ARRAY",
                items: { type: "OBJECT", properties: {
                    option_id: { type: "STRING" }, option_label: { type: "STRING" },
                    case_for: { type: "ARRAY", items: { type: "STRING" } },
                    case_against: { type: "ARRAY", items: { type: "STRING" } },
                    key_risks: { type: "ARRAY", items: { type: "STRING" } },
                    assumptions: { type: "ARRAY", items: { type: "STRING" } },
                    evidence_refs: { type: "ARRAY", items: { type: "STRING" } },
                    confidence: { type: "STRING" }
                }, required: ["option_id", "option_label", "case_for", "case_against", "key_risks", "assumptions", "evidence_refs", "confidence"] }
            },
            tradeoffs: { type: "ARRAY", items: { type: "STRING" } },
            unknowns: { type: "ARRAY", items: { type: "STRING" } },
            what_would_change_assessment: { type: "ARRAY", items: { type: "STRING" } },
            validation_steps: { type: "ARRAY", items: { type: "STRING" } },
            follow_up_questions: { type: "ARRAY", items: { type: "STRING" } }
        },
        required: ["decision_snapshot", "current_read", "option_assessments", "unknowns", "validation_steps"]
    };
    const meta = {};
    const result = await callGeminiJSON(prompt, { maxOutputTokens: 8192, schema, startTime, meta, tier: 'reasoning' });
    applyLlmMeta(res, meta);
    return res.json({ decisionBrief: result });
}

async function handleAnswerQuestion(payload, res, startTime) {
    const { context, signal, question, ragChunks, knowledgeChunks, staleFacts, webResults, compressedContext, memoryLine, digest } = payload;
    // Grounding digest forward: PROMPTS.answerQuestion(context, signal, question, digest || '')
    const prompt = PROMPTS.answerQuestion(context, signal, question, {
        ragChunks, knowledgeChunks, staleFacts, webResults, compressedContext, memoryLine, digest,
    });

    // JSON mode (v29): the envelope's sufficiency/stale_facts_cited is what lets
    // askBahirjee decide to escalate to the web on a real signal instead of a regex guess
    // at the answer text. Small schema, low token budget — this is a short Q&A answer, not
    // a report section.
    const schema = {
        type: "OBJECT",
        properties: {
            answer: { type: "STRING" },
            sufficiency: { type: "STRING" },
            stale_facts_cited: { type: "ARRAY", items: { type: "STRING" } }
        },
        required: ["answer", "sufficiency", "stale_facts_cited"]
    };
    const meta = {};
    const result = await callGeminiJSON(prompt, { maxOutputTokens: 1200, schema, startTime, meta, tier: 'heavy' });
    applyLlmMeta(res, meta);
    return res.json(result);
}

// RAG embeddings: batch-embed uploaded-document chunks (or a query) with Gemini.
// Returns { embeddings: number[][] } aligned to the input `texts` order.
async function handleEmbed(payload, res) {
    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) return res.status(503).json({ error: 'Gemini not configured', code: 'PROVIDER_UNAVAILABLE' });

    const texts = Array.isArray(payload.texts) ? payload.texts.filter(t => typeof t === 'string' && t.trim()) : [];
    if (texts.length === 0) return res.status(400).json({ error: 'texts[] required for embed' });
    if (texts.length > 100) return res.status(400).json({ error: 'Max 100 texts per embed request' });
    // A stored chunk and a search query are embedded differently; the model retrieves
    // better when told which one it is looking at.
    const taskType = EMBEDDING_TASK_TYPES.has(payload.taskType) ? payload.taskType : 'RETRIEVAL_DOCUMENT';

    const url = `${GEMINI_API_BASE()}/models/${EMBEDDING_MODEL}:batchEmbedContents`;
    const body = {
        requests: texts.map(t => ({
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text: t.slice(0, 8000) }] },
            taskType,
            outputDimensionality: EMBEDDING_DIMENSIONS
        }))
    };

    try {
        const response = await fetchWithTimeout(url, {
            method: 'POST',
            // Auth via header (not ?key= query param) so the key never lands in URL logs.
            headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GEMINI_KEY },
            body: JSON.stringify(body)
        }, REQUEST_TIMEOUT_MS);

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            console.error('[Gemini] embed error:', response.status, errText.slice(0, 300));
            return res.status(502).json({ error: `Embedding failed (${response.status})` });
        }

        const data = await response.json();
        const embeddings = (data.embeddings || []).map(e => e.values || []);
        // A vector of the wrong width would be rejected by the vector(768) column on insert —
        // or worse, compared against 768-dim vectors at query time. Refuse it here.
        if (embeddings.some(v => v.length !== EMBEDDING_DIMENSIONS)) {
            console.error('[Gemini] embed returned unexpected dimensions:', embeddings[0]?.length);
            return res.status(502).json({ error: `Embedding dimension mismatch (expected ${EMBEDDING_DIMENSIONS})` });
        }
        return res.json({ embeddings, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, taskType });
    } catch (err) {
        console.error('[Gemini] embed exception:', err.message);
        return res.status(500).json({ error: err.message });
    }
}

async function handleInterpretShifts(payload, res, startTime) {
    const { context, shifts, blindSpots, opportunities } = payload;
    const prompt = PROMPTS.interpretShifts(context, shifts, blindSpots, opportunities);

    const schema = {
        type: "OBJECT",
        properties: {
            interpretations: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: {
                        finding_type: { type: "STRING" },
                        theme: { type: "STRING" },
                        indication: { type: "STRING" },
                        company_relevance: { type: "STRING" },
                        stability_assessment: { type: "STRING" },
                        uncertainty_notes: { type: "STRING" },
                        confidence_reasoning: { type: "STRING" }
                    },
                    required: ["finding_type", "theme", "indication"]
                }
            },
            landscape_summary: { type: "STRING" }
        },
        required: ["interpretations"]
    };

    const meta = {};
    // Reasoning tier: interpreting what the shifts mean. (Previously ran on sarvam-m, the
    // weakest model in the stack.) maxOutputTokens covers medium-level thinking + the JSON.
    const result = await callGeminiJSON(prompt, { maxOutputTokens: 6000, schema, startTime, meta, tier: 'reasoning' });
    applyLlmMeta(res, meta);
    return res.json(result);
}

async function handleTriageDaily(payload, res, startTime) {
    const { context, candidates, unmatchedChanges } = payload;
    const prompt = PROMPTS.triageDaily(context, candidates, unmatchedChanges);

    const schema = {
        type: "OBJECT",
        properties: {
            material: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: {
                        question_id: { type: "STRING" },
                        why: { type: "STRING" },
                        queries: { type: "ARRAY", items: { type: "STRING" } }
                    },
                    required: ["question_id", "why"]
                }
            },
            summary: { type: "STRING" }
        },
        // `material` is required so an empty morning returns `[]` rather than omitting the
        // field — an absent array and a deliberate "nothing moved" are the same JSON but
        // very different facts, and only one of them means the model actually looked.
        required: ["material"]
    };

    // BULK TIER ON PURPOSE. This fires every morning for every client, so it is the one
    // call in the system whose cost is multiplied by the calendar. It is also a narrow
    // judgment over a small, structured input — "would this change the answer to that
    // question?" — which is what Flash is for. The reasoning tier stays reserved for the
    // 1-2 calls per week a founder actually reads (see the internal design log: upgrade
    // the model where a human reads the output, never a per-item step).
    const meta = {};
    const result = await callGeminiJSON(prompt, { maxOutputTokens: 1500, schema, startTime, meta, tier: 'heavy' });
    applyLlmMeta(res, meta);
    return res.json(result);
}

/**
 * Track 2 graph agent — ONE step of the bounded loop in lib/_graphAgent.js.
 * The model picks a tool + typed args; Cypher is never generated. Light tier:
 * the step is a routing decision over a small structured input, not judgment.
 */
async function handleGraphAgentStep(payload, res, startTime) {
    const { question, observations, stepsUsed, maxSteps } = payload || {};
    if (!question || typeof question !== 'string') {
        return res.status(400).json({ error: 'question required' });
    }
    const prompt = PROMPTS.graphAgentStep({
        question,
        observations: Array.isArray(observations) ? observations : [],
        stepsUsed: Number(stepsUsed) || 0,
        maxSteps: Number(maxSteps) || 4,
    });
    const schema = {
        type: "OBJECT",
        properties: {
            done: { type: "BOOLEAN" },
            tool: { type: "STRING" },
            args: {
                type: "OBJECT",
                properties: {
                    entity: { type: "STRING" },
                    from_entity: { type: "STRING" },
                    to_entity: { type: "STRING" },
                    depth: { type: "NUMBER" },
                    since: { type: "STRING" },
                    limit: { type: "NUMBER" }
                }
            },
            answer: { type: "STRING" }
        },
        required: ["done", "args"],
        propertyOrdering: ["done", "tool", "args", "answer"]
    };
    const meta = {};
    const result = await callGeminiJSON(prompt, { maxOutputTokens: 1200, schema, startTime, meta, tier: 'light' });
    applyLlmMeta(res, meta);
    return res.json(result);
}

async function handleWeighDecision(payload, res, startTime) {
    const { context, frame, signals, existingCriteria } = payload;
    const prompt = PROMPTS.weighDecision(context, frame, signals, existingCriteria || []);

    const schema = {
        type: "OBJECT",
        properties: {
            criteria: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: {
                        id: { type: "STRING" }, name: { type: "STRING" },
                        weight: { type: "NUMBER" }, why: { type: "STRING" }
                    },
                    required: ["id", "name"]
                }
            },
            scores: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: {
                        option_id: { type: "STRING" }, criterion_id: { type: "STRING" },
                        score: { type: "NUMBER" }, basis: { type: "STRING" },
                        evidence_refs: { type: "ARRAY", items: { type: "NUMBER" } }
                    },
                    // `basis` is required alongside the score: an unexplained number is not
                    // a judgment, and the founder is being asked to argue with these.
                    required: ["option_id", "criterion_id", "score", "basis"]
                }
            },
            unknowns: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: { text: { type: "STRING" }, would_settle_it: { type: "STRING" } },
                    required: ["text"]
                }
            }
        },
        required: ["criteria", "scores"]
    };

    // REASONING TIER. This is the rule from the internal design log applied exactly:
    // upgrade the model where a human reads the output, never on a per-item step. A founder
    // reads every basis sentence here and may take them into a board meeting — this is the
    // most consequential single call in the product, and it happens once per decision.
    const meta = {};
    const result = await callGeminiJSON(prompt, {
        maxOutputTokens: 8192, schema, startTime, meta, tier: 'reasoning',
    });
    applyLlmMeta(res, meta);
    return res.json(result);
}

async function handleDeliberate(payload, res, startTime) {
    const { context, frame, framework, signals, answers } = payload;
    const prompt = PROMPTS.deliberate(context, frame, framework, signals, answers || {});

    // One schema covering all four lenses, every block optional. The prompt names which one
    // to fill, and normaliseLens keeps only the block belonging to the chosen lens — so a
    // model that fills the wrong one produces nothing rather than a mismatched brief.
    const labelled = { type: "OBJECT", properties: { label: { type: "STRING" }, why: { type: "STRING" } } };
    const optioned = { type: "OBJECT", properties: { option: { type: "STRING" }, what: { type: "STRING" }, why: { type: "STRING" }, test: { type: "STRING" }, cost: { type: "STRING" } } };

    const schema = {
        type: "OBJECT",
        properties: {
            lens: {
                type: "OBJECT",
                properties: {
                    unnamed_options: { type: "ARRAY", items: labelled },
                    reality_tests: { type: "ARRAY", items: optioned },
                    outside_view: { type: "STRING" },
                    tripwire: { type: "OBJECT", properties: { condition: { type: "STRING" }, then: { type: "STRING" } } },
                    asymmetry: { type: "STRING" },
                    unrecoverable: { type: "ARRAY", items: optioned },
                    recoverable: { type: "ARRAY", items: optioned },
                    smallest_reversible_step: { type: "STRING" },
                    compounds: { type: "ARRAY", items: labelled },
                    buys_time: { type: "ARRAY", items: labelled },
                    defer: { type: "ARRAY", items: labelled },
                    bar: { type: "STRING" },
                    clears_bar: { type: "ARRAY", items: optioned },
                    cost_of_waiting: { type: "STRING" }
                }
            },
            unknowns: {
                type: "ARRAY",
                items: { type: "OBJECT", properties: { text: { type: "STRING" }, would_settle_it: { type: "STRING" } }, required: ["text"] }
            }
        },
        required: ["lens"]
    };

    // Reasoning tier, same justification as weighDecision: a founder reads every line of
    // this and may repeat it to a board. Once per decision, never per item.
    const meta = {};
    const result = await callGeminiJSON(prompt, {
        maxOutputTokens: 8192, schema, startTime, meta, tier: 'reasoning',
    });
    applyLlmMeta(res, meta);
    return res.json(result);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GEMINI API CORE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function hasTimeBudget(startTime, requiredMs = 10000) {
    const elapsed = Date.now() - startTime;
    const remaining = VERCEL_FUNCTION_DEADLINE_MS - elapsed;
    return remaining >= requiredMs;
}

async function executeWithRetry(url, options, { maxRetries = MAX_SERVER_RETRIES, startTime = Date.now() } = {}) {
    let attempt = 0;

    while (attempt <= maxRetries) {
        if (attempt > 0 && !hasTimeBudget(startTime, 15000)) {
            console.warn(`[Gemini] ⏰ Time budget exhausted after ${attempt} attempts. Failing fast.`);
            throw new Error(`Gemini API: Time budget exhausted after ${attempt} retries. Elapsed: ${Date.now() - startTime}ms`);
        }

        try {
            const elapsed = Date.now() - startTime;
            const maxTimeForThisRequest = Math.min(REQUEST_TIMEOUT_MS, VERCEL_FUNCTION_DEADLINE_MS - elapsed - 2000);

            if (maxTimeForThisRequest < 5000) {
                throw new Error('Insufficient time remaining for Gemini request');
            }

            const response = await fetchWithTimeout(url, options, maxTimeForThisRequest);

            if (response.ok) {
                return await response.json();
            }

            if (response.status === 429 || response.status >= 500) {
                const isRateLimit = response.status === 429;

                if (attempt >= maxRetries) {
                    const errData = await response.json().catch(() => ({}));
                    const msg = errData.error?.message || (isRateLimit ? 'Resource exhausted' : 'Server error');
                    const modelMatch = url.match(/models\/([^:]+)/);
                    const modelName = modelMatch ? modelMatch[1] : 'unknown';
                    const exhausted = new Error(`Gemini ${response.status} on ${modelName}: ${msg} (exhausted ${maxRetries} retries)`);
                    exhausted.status = response.status;
                    exhausted.nonRetryable = true;
                    throw exhausted;
                }

                let baseDelay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
                const retryAfterHeader = response.headers.get('retry-after');
                if (retryAfterHeader) {
                    baseDelay = Math.max(baseDelay, Number(retryAfterHeader) * 1000);
                }
                const maxAffordableDelay = VERCEL_FUNCTION_DEADLINE_MS - (Date.now() - startTime) - 15000;
                baseDelay = Math.min(baseDelay, maxAffordableDelay, 20000);

                if (baseDelay < 1000) {
                    console.warn(`[Gemini] ⏰ Cannot afford retry delay. Failing fast.`);
                    const errData = await response.json().catch(() => ({}));
                    throw new Error(`Gemini ${response.status}: ${errData.error?.message || 'Rate limited'} (no time for retry)`);
                }

                const waitMs = Math.floor(baseDelay + Math.random() * 2000);
                console.warn(`[Gemini] ⚠️ ${response.status}. Retry in ${(waitMs / 1000).toFixed(1)}s (${attempt + 1}/${maxRetries})`);
                await new Promise(r => setTimeout(r, waitMs));
                attempt++;
                continue;
            }

            // Any other 4xx is the request, not the network: an unsupported parameter, a
            // retired model id. Resending it to the same model gets the same answer, and this
            // used to burn two retries before failing over — so a setting one model rejects
            // silently moved every call to the fallback. Fail over now, and say why.
            const errData = await response.json().catch(() => ({}));
            const rejected = new Error(`Gemini Error ${response.status}: ${errData.error?.message || 'Unknown Error'}`);
            rejected.status = response.status;
            rejected.nonRetryable = true;
            throw rejected;

        } catch (error) {
            if (error.nonRetryable || attempt >= maxRetries) throw error;
            if (!hasTimeBudget(startTime, 10000)) throw error;

            console.warn(`[Gemini] ⚠️ Network error (${error.message}). Retry ${attempt + 1}/${maxRetries}`);
            const waitMs = Math.pow(2, attempt) * 2000 + (Math.random() * 1000);
            await new Promise(r => setTimeout(r, waitMs));
            attempt++;
        }
    }
}

async function callGeminiJSON(prompt, options = {}) {
    if (!process.env.GEMINI_API_KEY) throw new Error("Missing Gemini API Key");
    const { maxOutputTokens = 1400, schema = null, startTime = Date.now(), meta = null, tier = 'heavy', thinking = thinkingForTier(tier) } = options;

    // Thinking tokens count against maxOutputTokens, so unbounded thinking starves the JSON
    // and trips MAX_TOKENS truncation/salvage. Measured on a real 15-observation
    // analyzeSignals batch on gemini-2.5-flash (8000 maxOutputTokens):
    //
    //   unbounded : 38.5s  finishReason=MAX_TOKENS  thinking=5790  output=2196  JSON unparseable
    //   1024      : 17.2s  finishReason=STOP        thinking= 820  output=1997  8-11 signals
    //
    // Thinking was taking 72% of the budget and the batch was silently losing signals —
    // the same input yielded 7, then 5, then 2 across three runs. So every call bounds
    // thinking by default: a thinkingLevel on Gemini 3 (a hint, not a hard cap — which is
    // why x-llm-thoughts / x-llm-finish now report what each call actually spent), a numeric
    // budget on an env-pinned older model. Pass `thinking: null` to deliberately opt out.
    const requestFor = (model, text = prompt) => ({
        contents: [{ parts: [{ text }] }],
        generationConfig: generationConfigFor(model, { maxOutputTokens, schema, thinking }),
        safetySettings: GEMINI_SAFETY_SETTINGS
    });

    const { data, model } = await geminiGenerate(requestFor, { startTime, models: modelsForTier(tier), meta });
    if (meta) meta.model = model;

    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const blockReason = data.promptFeedback?.blockReason;
    const text = candidate?.content?.parts?.[0]?.text;

    if (finishReason === 'RECITATION' && hasTimeBudget(startTime, 15000)) {
        console.warn('[Gemini] ⚠️ RECITATION detected. Retrying with anti-recitation prefix...');
        const antiRecitationPrompt = `IMPORTANT: Generate ONLY original analysis. Do not quote or reproduce source material verbatim. Paraphrase all findings in your own words.\n\n${prompt}`;
        try {
            // Retry on the SAME model that produced the RECITATION (no failover, no extra retries).
            const retryData = await geminiGenerateOnModel(model, requestFor(model, antiRecitationPrompt), { maxRetries: 0, startTime });
            const retryText = retryData.candidates?.[0]?.content?.parts?.[0]?.text;
            if (retryText) {
                console.log('[Gemini] ✅ Anti-recitation retry succeeded');
                recordUsage(meta, retryData);
                return parseProviderJSON(retryText);
            }
        } catch (retryErr) {
            console.warn('[Gemini] Anti-recitation retry also failed:', retryErr.message);
        }
    }

    if (!text) {
        const diag = [];
        if (blockReason) diag.push(`Blocked by API: ${blockReason}`);
        if (finishReason && finishReason !== 'STOP') diag.push(`Finish reason: ${finishReason}`);
        if (!data.candidates || data.candidates.length === 0) diag.push('No candidates returned');
        if (candidate && !candidate.content) diag.push('Candidate has no content (likely safety filter)');
        const safetyRatings = candidate?.safetyRatings?.filter(r => r.probability !== 'NEGLIGIBLE');
        if (safetyRatings?.length) diag.push(`Safety flags: ${safetyRatings.map(r => `${r.category}=${r.probability}`).join(', ')}`);
        console.error('[Gemini] Empty response diagnostics:', diag.join(' | '));
        throw new Error(`Empty Gemini response. ${diag.join('. ') || 'No diagnostics available.'}`);
    }

    recordUsage(meta, data);

    if (finishReason === 'MAX_TOKENS') {
        console.warn(`[Gemini] ⚠️ Response truncated (MAX_TOKENS). Salvaging partial results...`);
        if (meta) meta.salvaged = true;
        return salvageTruncatedJSON(text);
    }

    return parseProviderJSON(text);
}

/**
 * Copy what a call actually spent into `meta`, for the x-llm-* headers. `thoughts` and
 * `finish` are what reveal a thinking level eating the output budget: a run whose calls
 * finish MAX_TOKENS with most of their tokens in thoughts is truncating, not concluding.
 */
function recordUsage(meta, data) {
    if (!meta) return;
    const usage = data?.usageMetadata || {};
    meta.tokens = usage.totalTokenCount ?? null;
    meta.thoughts = usage.thoughtsTokenCount ?? null;
    meta.finish = data?.candidates?.[0]?.finishReason || null;
}

async function callGeminiJSONWithUsage(prompt, options = {}) {
    if (!process.env.GEMINI_API_KEY) throw new Error("Missing Gemini API Key");
    const { maxOutputTokens = 400, schema = null, startTime = Date.now(), meta = null, tier = 'heavy', thinking = thinkingForTier(tier) } = options;

    const requestFor = (model, text = prompt) => ({
        contents: [{ parts: [{ text }] }],
        generationConfig: generationConfigFor(model, { maxOutputTokens, schema, thinking }),
        safetySettings: GEMINI_SAFETY_SETTINGS
    });

    const sumUsage = (a, b) => {
        if (!a) return b || null;
        if (!b) return a || null;
        const n = (v) => Number(v || 0);
        return {
            promptTokenCount: n(a.promptTokenCount) + n(b.promptTokenCount),
            candidatesTokenCount: n(a.candidatesTokenCount) + n(b.candidatesTokenCount),
            totalTokenCount: n(a.totalTokenCount) + n(b.totalTokenCount)
        };
    };

    let totalUsage = null;
    const { data, model } = await geminiGenerate(requestFor, { startTime, models: modelsForTier(tier), meta });
    totalUsage = sumUsage(totalUsage, data.usageMetadata || null);
    recordUsage(meta, data);
    if (meta) meta.model = model;

    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const blockReason = data.promptFeedback?.blockReason;
    const text = candidate?.content?.parts?.[0]?.text;

    if (finishReason === 'RECITATION' && hasTimeBudget(startTime, 15000)) {
        console.warn('[Gemini] ⚠️ RECITATION detected. Retrying with anti-recitation prefix...');
        const antiRecitationPrompt = `IMPORTANT: Generate ONLY original analysis. Do not quote or reproduce source material verbatim. Paraphrase all findings in your own words.\n\n${prompt}`;
        try {
            // Retry on the SAME model that produced the RECITATION (no failover, no extra retries).
            const retryData = await geminiGenerateOnModel(model, requestFor(model, antiRecitationPrompt), { maxRetries: 0, startTime });
            totalUsage = sumUsage(totalUsage, retryData.usageMetadata || null);
            const retryText = retryData.candidates?.[0]?.content?.parts?.[0]?.text;
            if (retryText) {
                console.log('[Gemini] ✅ Anti-recitation retry succeeded');
                return { parsed: parseProviderJSON(retryText), usage: totalUsage, model };
            }
        } catch (retryErr) {
            console.warn('[Gemini] Anti-recitation retry also failed:', retryErr.message);
        }
    }

    if (!text) {
        const diag = [];
        if (blockReason) diag.push(`Blocked by API: ${blockReason}`);
        if (finishReason && finishReason !== 'STOP') diag.push(`Finish reason: ${finishReason}`);
        if (!data.candidates || data.candidates.length === 0) diag.push('No candidates returned');
        if (candidate && !candidate.content) diag.push('Candidate has no content (likely safety filter)');
        const safetyRatings = candidate?.safetyRatings?.filter(r => r.probability !== 'NEGLIGIBLE');
        if (safetyRatings?.length) diag.push(`Safety flags: ${safetyRatings.map(r => `${r.category}=${r.probability}`).join(', ')}`);
        console.error('[Gemini] Empty response diagnostics:', diag.join(' | '));
        throw new Error(`Empty Gemini response. ${diag.join('. ') || 'No diagnostics available.'}`);
    }

    if (finishReason === 'MAX_TOKENS') {
        console.warn(`[Gemini] ⚠️ Response truncated (MAX_TOKENS). Salvaging partial results...`);
        return { parsed: salvageTruncatedJSON(text), usage: totalUsage, model };
    }

    return { parsed: parseProviderJSON(text), usage: totalUsage, model };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MODEL RESOLUTION & FAILOVER — ordered list, health-aware, header auth
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// A tier's order, minus models currently in a failure cooldown. Never returns empty — if
// every model is cooling down we still attempt the full ordered list.
function getHealthyOrderedModels(baseList = null) {
    const ordered = baseList ? [...baseList] : modelsForTier('heavy');
    const healthy = ordered.filter(m => !modelFailureTracker.isBlocked(m));
    return healthy.length ? healthy : ordered;
}

function buildGeminiFetchOptions(bodyObj) {
    return {
        method: 'POST',
        // Auth via header (not ?key= query param) so the key never lands in URL logs.
        headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': process.env.GEMINI_API_KEY
        },
        body: JSON.stringify(bodyObj)
    };
}

// Single call against one specific model (used by the failover loop and by the
// same-model RECITATION retry).
async function geminiGenerateOnModel(model, bodyObj, { startTime, maxRetries = MAX_SERVER_RETRIES } = {}) {
    const url = `${GEMINI_API_BASE()}/models/${model}:generateContent`;
    return executeWithRetry(url, buildGeminiFetchOptions(bodyObj), { startTime, maxRetries });
}

// Primary generate with cross-model failover: when a model fails (retries exhausted, or a
// request it rejects outright), record the failure and fall through to the next healthy
// model. `requestFor(model)` builds the body per attempt — Gemini 3 and older models need
// different generation settings, so a body built for one can be rejected by the next.
//
// Every model that failed before the one that answered is recorded in `meta.fallbacks`
// and reaches provenance as x-llm-fallbacks: a call served by a fallback is otherwise
// indistinguishable from one served by the lead model.
async function geminiGenerate(requestFor, { startTime = Date.now(), maxRetries = MAX_SERVER_RETRIES, models: preferredModels = null, meta = null } = {}) {
    if (!process.env.GEMINI_API_KEY) throw new Error('Missing Gemini API Key');
    const models = getHealthyOrderedModels(preferredModels);
    let lastError = null;

    for (let i = 0; i < models.length; i++) {
        const model = models[i];
        try {
            const data = await geminiGenerateOnModel(model, requestFor(model), { startTime, maxRetries });
            modelFailureTracker.reset(model); // recovered — clear its cooldown
            return { data, model };
        } catch (err) {
            lastError = err;
            modelFailureTracker.recordFailure(model);
            if (meta) meta.fallbacks = [...(meta.fallbacks || []), `${model}:${err.status || 'error'}`];
            const isLastModel = i === models.length - 1;
            if (isLastModel || !hasTimeBudget(startTime, 8000)) throw err;
            console.warn(`[Gemini] Model ${model} failed (${err.message}). Falling back to ${models[i + 1]}.`);
        }
    }

    throw lastError || new Error('All Gemini models exhausted');
}
