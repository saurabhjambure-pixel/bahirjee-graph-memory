import { jsonrepair } from 'jsonrepair';
import { PROMPTS } from '../src/services/promptUtils.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// JSON PARSING — 5-strategy pipeline with jsonrepair
// Shared by api/gemini.js, api/deepseek.js, api/groq.js
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const parseProviderJSON = (text) => {
    if (!text || typeof text !== 'string') {
        throw new Error("Empty or invalid LLM response");
    }

    // Strategy 1: Clean markdown code blocks and parse directly
    let clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

    try {
        return JSON.parse(clean);
    } catch (e1) {
        // Strategy 2: Extract JSON object/array from surrounding text
        const jsonMatch = clean.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[1]);
            } catch (e2) {
                // Continue to next strategy
            }
        }

        // Strategy 3: jsonrepair — handles trailing commas, missing quotes, etc.
        try {
            const repaired = jsonrepair(clean);
            return JSON.parse(repaired);
        } catch (e3) {
            // Continue to next strategy
        }

        // Strategy 4: Manual fixes for provider-specific issues
        try {
            let fixed = clean;
            fixed = fixed.replace(/,\s*([}\]])/g, '$1');
            fixed = fixed.replace(/([^"\\])"([^"]*?)$/gm, '$1"$2"');
            const openBraces = (fixed.match(/\{/g) || []).length;
            const closeBraces = (fixed.match(/\}/g) || []).length;
            const openBrackets = (fixed.match(/\[/g) || []).length;
            const closeBrackets = (fixed.match(/\]/g) || []).length;
            for (let i = 0; i < openBrackets - closeBrackets; i++) fixed += ']';
            for (let i = 0; i < openBraces - closeBraces; i++) fixed += '}';
            return JSON.parse(fixed);
        } catch (e4) {
            // Strategy 5: Truncate to last complete JSON element
            try {
                const lastBrace = clean.lastIndexOf('}');
                const lastBracket = clean.lastIndexOf(']');
                const lastValid = Math.max(lastBrace, lastBracket);
                if (lastValid > 0) {
                    const truncated = clean.substring(0, lastValid + 1);
                    try {
                        return JSON.parse(jsonrepair(truncated));
                    } catch {
                        return JSON.parse(truncated);
                    }
                }
            } catch (e5) {
                // All strategies failed
            }
            console.error('[LLM] Failed to parse JSON. Raw text preview:', text.substring(0, 500));
            throw new Error(`Failed to parse LLM response: ${e1.message}. Preview: ${text.substring(0, 200)}...`);
        }
    }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SALVAGE — Extract partial results from truncated JSON (MAX_TOKENS responses)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function salvageTruncatedJSON(text) {
    let clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

    // Try direct parse first (unlikely but cheap)
    try { return JSON.parse(clean); } catch (e) { /* expected */ }

    // Try jsonrepair on the truncated text — often can close brackets properly
    try {
        const repaired = jsonrepair(clean);
        return JSON.parse(repaired);
    } catch (e) { /* continue */ }

    // Case 1: Truncated array of objects — extract all complete objects
    const objectMatches = [...clean.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
    if (objectMatches.length > 0) {
        const objects = [];
        for (const m of objectMatches) {
            try {
                objects.push(JSON.parse(m[0]));
            } catch (e) {
                try {
                    objects.push(JSON.parse(jsonrepair(m[0])));
                } catch { /* skip malformed objects */ }
            }
        }

        if (objects.length > 0) {
            const keyMatch = clean.match(/^\s*\{\s*"(\w+)"\s*:\s*\[/);
            if (keyMatch) {
                console.warn(`[LLM] Salvaged ${objects.length} items from truncated "${keyMatch[1]}" array`);
                return { [keyMatch[1]]: objects };
            }
            console.warn(`[LLM] Salvaged ${objects.length} items from truncated array`);
            return objects;
        }
    }

    // Case 2: Truncated object — try to close it
    try {
        let fixed = clean;
        fixed = fixed.replace(/,\s*$/, '');
        const openBraces = (fixed.match(/\{/g) || []).length;
        const closeBraces = (fixed.match(/\}/g) || []).length;
        const openBrackets = (fixed.match(/\[/g) || []).length;
        const closeBrackets = (fixed.match(/\]/g) || []).length;
        for (let i = 0; i < openBrackets - closeBrackets; i++) fixed += ']';
        for (let i = 0; i < openBraces - closeBraces; i++) fixed += '}';
        return JSON.parse(fixed);
    } catch (e) { /* last resort failed */ }

    // Nothing could be parsed or salvaged. Returning [] here would be
    // indistinguishable from a legitimate "no results" response and would
    // silently drop the entire payload (e.g. all signals) with no error. Signal
    // the failure so the caller/handler surfaces it instead of persisting empties.
    console.error('[LLM] Could not salvage truncated JSON. Preview:', text.substring(0, 300));
    throw new Error('Failed to salvage truncated JSON response (no parseable content recovered)');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NETWORK HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MODEL FAILURE TRACKER — session-scoped, in-memory, per-provider instance
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class ModelFailureTracker {
    constructor(windowMs = 5 * 60 * 1000, threshold = 3) {
        this._windowMs = windowMs;
        this._threshold = threshold;
        this._failures = {}; // { modelName: [timestamp, ...] }
    }

    recordFailure(modelName) {
        const now = Date.now();
        const prev = this._failures[modelName] || [];
        this._failures[modelName] = [...prev, now];
        const blocked = this.isBlocked(modelName);
        if (blocked) {
            console.warn(`[model-tracker] Model "${modelName}" is now blocked (${this._threshold} failures in ${this._windowMs / 60000}min window)`);
        }
        return blocked;
    }

    isBlocked(modelName) {
        const now = Date.now();
        const failures = this._failures[modelName] || [];
        const recent = failures.filter(t => now - t < this._windowMs);
        return recent.length >= this._threshold;
    }

    reset(modelName) {
        delete this._failures[modelName];
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MODEL LIST BUILDER — shared env-override pattern for all OpenAI-compat providers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Build an ordered model list with optional env-var override at position 0.
 * Identical logic was previously duplicated in groq.js, deepseek.js, sarvam.js.
 *
 * @param {string} envVarName  - e.g. 'GROQ_MODEL'
 * @param {string[]} defaults  - e.g. ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']
 * @returns {string[]}
 */
export function buildModelList(envVarName, defaults) {
    const envModel = process.env[envVarName];
    if (!envModel) return defaults;
    if (!defaults.includes(envModel)) return [envModel, ...defaults];
    return [envModel, ...defaults.filter(m => m !== envModel)];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SHARED ACTION HANDLERS — for OpenAI-compatible providers (Groq, DeepSeek, Sarvam)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Factory that returns the 7 shared action handler functions.
 * Eliminates ~150 lines of duplicated handler code across Groq, DeepSeek, Sarvam.
 *
 * @param {Function} callFn - Provider-specific call function.
 *   Signature: (prompt, { maxTokens, isJsonMode, action, startTime, ...extras }) => Promise<string>
 * @returns {Object} handlers keyed by action name
 */
// Surface per-call provenance (model + token usage + salvage flag) as response headers
// so the client can record which model served each action and at what token cost.
// Must be called before res.json() sends the response.
export function applyLlmMeta(res, meta) {
    if (!res || typeof res.setHeader !== 'function' || !meta) return;
    if (meta.model) res.setHeader('x-llm-model', String(meta.model));
    if (meta.tokens != null) res.setHeader('x-llm-tokens', String(meta.tokens));
    if (meta.salvaged) res.setHeader('x-llm-salvaged', '1');
    // Thinking tokens and finish reason: the only way to see a thinking level consuming the
    // output budget. Fallbacks: which models failed before the one that answered.
    if (meta.thoughts != null) res.setHeader('x-llm-thoughts', String(meta.thoughts));
    if (meta.finish) res.setHeader('x-llm-finish', String(meta.finish));
    if (Array.isArray(meta.fallbacks) && meta.fallbacks.length) res.setHeader('x-llm-fallbacks', meta.fallbacks.join(','));
}

export function createOpenAICompatHandlers(callFn) {
    return {
        async buildContext(payload, res, startTime) {
            const { url, linkedin, rawText } = payload;
            const prompt = PROMPTS.buildContext(url, linkedin, rawText);
            const meta = {};
            const text = await callFn(prompt, { maxTokens: 6000, isJsonMode: true, action: 'buildContext', startTime, meta });
            applyLlmMeta(res, meta);
            return res.json(parseProviderJSON(text));
        },

        async mergeContext(payload, res, startTime) {
            const { existingSummary, newSourceText, protectedFields } = payload;
            const prompt = PROMPTS.mergeContext(existingSummary, newSourceText, protectedFields || []);
            const meta = {};
            const text = await callFn(prompt, { maxTokens: 1500, isJsonMode: true, action: 'mergeContext', startTime, meta });
            applyLlmMeta(res, meta);
            return res.json(parseProviderJSON(text));
        },

        async frameDecision(payload, res, startTime) {
            const prompt = PROMPTS.frameDecision(payload.rawText, payload.context || {});
            const meta = {};
            const text = await callFn(prompt, { maxTokens: 1800, isJsonMode: true, action: 'frameDecision', startTime, meta });
            applyLlmMeta(res, meta);
            return res.json(parseProviderJSON(text));
        },

        async generateQueries(payload, res, startTime) {
            const { context, competitors, dateStr } = payload;
            const prompt = PROMPTS.buildQuery(context, competitors, dateStr);
            const meta = {};
            const text = await callFn(prompt, { maxTokens: 400, isJsonMode: true, action: 'generateQueries', startTime, meta });
            applyLlmMeta(res, meta);
            return res.json(parseProviderJSON(text));
        },

        async analyzeSignals(payload, res, startTime) {
            const { context, searchResults, temporalPolicy, previousSignals } = payload;
            const prompt = PROMPTS.buildSignals(context, searchResults, temporalPolicy, previousSignals);
            const meta = {};
            const text = await callFn(prompt, { maxTokens: 8000, isJsonMode: true, action: 'analyzeSignals', startTime, meta });
            try {
                const parsed = parseProviderJSON(text);
                applyLlmMeta(res, meta);
                return res.json(parsed);
            } catch {
                meta.salvaged = true;
                applyLlmMeta(res, meta);
                return res.json(salvageTruncatedJSON(text));
            }
        },

        async generateSummary(payload, res, startTime) {
            const { context, signals, synthesis, temporal } = payload;
            const prompt = PROMPTS.buildSummary(context, signals, synthesis, temporal);
            const meta = {};
            const text = await callFn(prompt, { maxTokens: 2500, isJsonMode: true, action: 'generateSummary', startTime, meta });
            applyLlmMeta(res, meta);
            return res.json({ summary: parseProviderJSON(text) });
        },

        async generateDecisionBrief(payload, res, startTime) {
            const { context, decision, signals, synthesis } = payload;
            const prompt = PROMPTS.generateDecisionBrief(context, decision, signals, synthesis);
            const meta = {};
            const text = await callFn(prompt, { maxTokens: 5000, isJsonMode: true, action: 'generateDecisionBrief', startTime, meta });
            applyLlmMeta(res, meta);
            return res.json({ decisionBrief: parseProviderJSON(text) });
        },

        async interpretShifts(payload, res, startTime) {
            const { context, shifts, blindSpots, opportunities } = payload;
            const prompt = PROMPTS.interpretShifts(context, shifts, blindSpots, opportunities);
            const meta = {};
            const text = await callFn(prompt, { maxTokens: 800, isJsonMode: true, action: 'interpretShifts', startTime, meta });
            try {
                const parsed = parseProviderJSON(text);
                applyLlmMeta(res, meta);
                return res.json(parsed);
            } catch {
                meta.salvaged = true;
                applyLlmMeta(res, meta);
                return res.json(salvageTruncatedJSON(text));
            }
        },

        async answerQuestion(payload, res, startTime) {
            const { context, signal, question } = payload;
            const prompt = PROMPTS.answerQuestion(context, signal, question, payload.digest || '');
            const meta = {};
            const text = await callFn(prompt, { maxTokens: 600, isJsonMode: false, action: 'answerQuestion', startTime, meta });
            applyLlmMeta(res, meta);
            return res.json({ answer: text });
        },

        async extractDocumentIntel(payload, res, startTime) {
            const { docText, companyHint, todayIso } = payload;
            if (!docText) return res.status(400).json({ error: 'docText required for extractDocumentIntel' });
            const prompt = PROMPTS.extractDocumentIntel(docText, companyHint, todayIso);
            const meta = {};
            const text = await callFn(prompt, { maxTokens: 4000, isJsonMode: true, action: 'extractDocumentIntel', startTime, meta });
            applyLlmMeta(res, meta);
            return res.json(parseProviderJSON(text));
        },
    };
}
