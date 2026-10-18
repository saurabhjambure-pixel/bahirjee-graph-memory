import { applyApiSecurity } from '../_security.js';
import { requireAuthenticatedUser } from '../_auth.js';
import { fetchWithTimeout, ModelFailureTracker, buildModelList, createOpenAICompatHandlers } from '../_llmUtils.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIGURATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 30000; // Groq's LPU is fast — tight timeout
const VERCEL_DEADLINE_MS = 57000;

// Per-action model preferences based on Groq rate limits:
// - llama-4-scout: 30K TPM → best for large-context analytical tasks
// - llama-3.3-70b-versatile: 12K TPM → quality reasoning and prose
// - llama-3.1-8b-instant: 6K TPM, 14.4K RPD → fast, simple, high throughput
// TPM budget strategy:
//   scout (30K TPM): handles bulk/multi-batch workloads (buildContext, analyzeSignals)
//   70b  (12K TPM): preserved for quality-critical single calls (generateQueries, generateSummary, interpretShifts, answerQuestion)
//   8b   (14.4K RPD, 6K TPM): lightweight fast tasks (removed)
const ACTION_MODELS = {
    buildContext:      ['meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    mergeContext:      ['meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    frameDecision:     ['llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct'],
    generateQueries:   ['llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.1-8b-instant'],
    analyzeSignals:    ['meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    generateSummary:   ['llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.1-8b-instant'],
    generateDecisionBrief: ['llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct'],
    interpretShifts:   ['llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct'],
    answerQuestion:    ['llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct'],
    extractDocumentIntel: ['llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct'],
};

// Session-scoped failure tracker (per serverless function instance)
const modelTracker = new ModelFailureTracker();

const SUPPORTED_ACTIONS = ['buildContext', 'mergeContext', 'frameDecision', 'generateQueries', 'analyzeSignals', 'generateSummary', 'generateDecisionBrief', 'interpretShifts', 'answerQuestion', 'extractDocumentIntel'];

// Shared action handlers — prompt construction + JSON parsing are identical across providers.
// callGroqWithModelFallback is a function declaration (hoisted), so this is safe at module level.
const H = createOpenAICompatHandlers(callGroqWithModelFallback);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function handler(req, res) {
    if (await applyApiSecurity(req, res, { routeKey: 'groq', maxRequests: 30 })) return;
    if (!await requireAuthenticatedUser(req, res, { rateLimit: { routeKey: 'groq', maxRequests: 30 } })) return;

    const { action, payload } = req.body || {};
    const startTime = Date.now();

    if (!SUPPORTED_ACTIONS.includes(action) || !payload || typeof payload !== 'object') {
        return res.status(400).json({ error: `Unsupported action or payload for Groq: ${action}`, provider: 'groq' });
    }

    if (!process.env.GROQ_API_KEY) {
        return res.status(503).json({ error: 'Groq not configured', code: 'PROVIDER_UNAVAILABLE', provider: 'groq' });
    }

    try {
        return await H[action](payload, res, startTime);
    } catch (error) {
        console.error(`[Groq] Error (action=${action}):`, error.message);
        return res.status(500).json({ error: error.message, provider: 'groq' });
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GROQ API CORE — intra-provider model fallback
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function buildGroqModels(action) {
    const defaults = ACTION_MODELS[action] || ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
    return buildModelList('GROQ_MODEL', defaults);
}

async function callGroqWithModelFallback(prompt, { maxTokens = 600, isJsonMode = false, action = 'unknown', startTime = Date.now(), meta = null } = {}) {
    const models = buildGroqModels(action);
    let lastErr;

    for (const model of models) {
        if (modelTracker.isBlocked(model)) {
            console.warn(`[model-fallback] { provider: 'groq', skipping: '${model}', reason: 'blocked', action: '${action}' }`);
            continue;
        }

        const body = {
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            temperature: action === 'answerQuestion' ? 0.3 : 0.2,
            ...(isJsonMode ? { response_format: { type: 'json_object' } } : {})
        };

        let attempt = 0;
        const maxAttemptsPerModel = 2;

        while (attempt < maxAttemptsPerModel) {
            try {
                const elapsed = Date.now() - startTime;
                const timeout = Math.min(REQUEST_TIMEOUT_MS, VERCEL_DEADLINE_MS - elapsed - 3000);
                if (timeout < 3000) throw new Error('Insufficient time budget for Groq request');

                const response = await fetchWithTimeout(
                    GROQ_API_URL,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
                        },
                        body: JSON.stringify(body)
                    },
                    timeout
                );

                if (response.ok) {
                    const data = await response.json();
                    const text = data.choices?.[0]?.message?.content || '';
                    modelTracker.reset(model);
                    if (meta) { meta.model = model; meta.tokens = data.usage?.total_tokens ?? null; }
                    console.log(`[Groq] ✅ Success (model=${model}, action=${action})`);
                    return text;
                }

                const status = response.status;
                const errBody = await response.json().catch(() => ({}));
                const errMsg = errBody.error?.message || '';
                const errCode = errBody.error?.code || '';

                // Auth errors — escalate immediately
                if (status === 401 || status === 403) {
                    throw new Error(`Groq auth error ${status}: ${errMsg}`);
                }

                // Model deprecated/not found — switch immediately
                if (status === 404 || errCode === 'model_not_found' || errMsg.toLowerCase().includes('deprecated') || errMsg.toLowerCase().includes('not found')) {
                    console.warn('[model-fallback]', { provider: 'groq', attempted: model, reason: 'MODEL_DEPRECATED', errorCode: status, switchingTo: models[models.indexOf(model) + 1] || 'none', action, timestamp: new Date().toISOString() });
                    modelTracker.recordFailure(model);
                    break;
                }

                // JSON generation failure (400) — model can't produce valid JSON, switch immediately
                if (status === 400 && (errMsg.toLowerCase().includes('failed to generate json') || errMsg.toLowerCase().includes('json'))) {
                    console.warn('[model-fallback]', { provider: 'groq', attempted: model, reason: 'JSON_GENERATION_FAILED', errorCode: 400, switchingTo: models[models.indexOf(model) + 1] || 'none', action, timestamp: new Date().toISOString() });
                    modelTracker.recordFailure(model);
                    break;
                }

                // Model overloaded — retry once, then switch
                if (status === 503 || errMsg.toLowerCase().includes('overloaded') || errMsg.toLowerCase().includes('unavailable')) {
                    if (attempt === 0) {
                        console.warn(`[Groq] Model overloaded (${model}). Retrying once...`);
                        await new Promise(r => setTimeout(r, 1000));
                        attempt++;
                        continue;
                    }
                    console.warn('[model-fallback]', { provider: 'groq', attempted: model, reason: 'MODEL_OVERLOADED', errorCode: status, switchingTo: models[models.indexOf(model) + 1] || 'none', action, timestamp: new Date().toISOString() });
                    modelTracker.recordFailure(model);
                    break;
                }

                // 429 — distinguish model-specific vs account-level
                if (status === 429) {
                    const isAccountLevel = errCode === 'rate_limit_exceeded' && !errMsg.toLowerCase().includes('model');
                    if (isAccountLevel) {
                        throw new Error(`Groq account-level rate limit: ${errMsg}`);
                    }
                    console.warn('[model-fallback]', { provider: 'groq', attempted: model, reason: 'MODEL_RATE_LIMITED', errorCode: 429, switchingTo: models[models.indexOf(model) + 1] || 'none', action, timestamp: new Date().toISOString() });
                    modelTracker.recordFailure(model);
                    break;
                }

                lastErr = new Error(`Groq ${status}: ${errMsg}`);
                modelTracker.recordFailure(model);
                break;

            } catch (err) {
                if (err.name === 'AbortError') {
                    if (attempt === 0) {
                        console.warn(`[Groq] Timeout on ${model} (attempt 1). Retrying...`);
                        attempt++;
                        continue;
                    }
                    console.warn('[model-fallback]', { provider: 'groq', attempted: model, reason: 'TIMEOUT', switchingTo: models[models.indexOf(model) + 1] || 'none', action, timestamp: new Date().toISOString() });
                    modelTracker.recordFailure(model);
                    lastErr = err;
                    break;
                }
                if (err.message.includes('auth error') || err.message.includes('account-level rate limit') || err.message.includes('Insufficient time budget')) {
                    throw err;
                }
                lastErr = err;
                modelTracker.recordFailure(model);
                break;
            }
        }
    }

    // All models exhausted
    console.error('[provider-escalation]', { provider: 'groq', action, reason: 'all_models_exhausted', timestamp: new Date().toISOString() });
    throw lastErr || new Error('All Groq models exhausted or blocked');
}
