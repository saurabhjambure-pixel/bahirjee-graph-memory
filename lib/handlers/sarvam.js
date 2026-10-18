import { applyApiSecurity } from '../_security.js';
import { requireAuthenticatedUser } from '../_auth.js';
import { fetchWithTimeout, ModelFailureTracker, buildModelList, createOpenAICompatHandlers } from '../_llmUtils.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIGURATION
// Sarvam exposes an OpenAI-compatible chat-completions endpoint. All connection
// details are env-overridable so the model/endpoint/auth can be corrected without
// a code change during testing.
//   SARVAM_API_KEY   — required
//   SARVAM_API_URL   — default https://api.sarvam.ai/v1/chat/completions
//   SARVAM_MODEL     — default sarvam-m
//   SARVAM_JSON_MODE — 'true' to send OpenAI response_format:json_object (off by
//                      default; many Sarvam deployments reject it — we rely on the
//                      prompt's JSON instruction + parseProviderJSON instead)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const SARVAM_API_URL = process.env.SARVAM_API_URL || 'https://api.sarvam.ai/v1/chat/completions';
const SARVAM_JSON_MODE = String(process.env.SARVAM_JSON_MODE || '').toLowerCase() === 'true';
const REQUEST_TIMEOUT_MS = 45000;
const VERCEL_DEADLINE_MS = 57000;

// Sarvam currently ships a single general model. buildModelList lets SARVAM_MODEL
// override the default and keeps the intra-provider retry structure consistent
// with the other OpenAI-compatible gateways.
const SARVAM_DEFAULT_MODELS = ['sarvam-m'];
const ACTION_MODELS = {
    buildContext:      SARVAM_DEFAULT_MODELS,
    mergeContext:      SARVAM_DEFAULT_MODELS,
    frameDecision:     SARVAM_DEFAULT_MODELS,
    generateQueries:   SARVAM_DEFAULT_MODELS,
    analyzeSignals:    SARVAM_DEFAULT_MODELS,
    generateSummary:   SARVAM_DEFAULT_MODELS,
    generateDecisionBrief: SARVAM_DEFAULT_MODELS,
    interpretShifts:   SARVAM_DEFAULT_MODELS,
    answerQuestion:    SARVAM_DEFAULT_MODELS,
    extractDocumentIntel: SARVAM_DEFAULT_MODELS,
};

const modelTracker = new ModelFailureTracker();

const SUPPORTED_ACTIONS = ['buildContext', 'mergeContext', 'frameDecision', 'generateQueries', 'analyzeSignals', 'generateSummary', 'generateDecisionBrief', 'interpretShifts', 'answerQuestion', 'extractDocumentIntel'];

// callSarvamWithModelFallback is a hoisted function declaration — safe to reference here.
const H = createOpenAICompatHandlers(callSarvamWithModelFallback);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function handler(req, res) {
    if (await applyApiSecurity(req, res, { routeKey: 'sarvam', maxRequests: 30 })) return;
    if (!await requireAuthenticatedUser(req, res, { rateLimit: { routeKey: 'sarvam', maxRequests: 30 } })) return;

    const { action, payload } = req.body || {};
    const startTime = Date.now();

    if (!SUPPORTED_ACTIONS.includes(action) || !payload || typeof payload !== 'object') {
        return res.status(400).json({ error: `Unsupported action or payload for Sarvam: ${action}`, provider: 'sarvam' });
    }

    if (!process.env.SARVAM_API_KEY) {
        return res.status(503).json({ error: 'Sarvam not configured', code: 'PROVIDER_UNAVAILABLE', provider: 'sarvam' });
    }

    try {
        return await H[action](payload, res, startTime);
    } catch (error) {
        console.error(`[Sarvam] Error (action=${action}):`, error.message);
        return res.status(500).json({ error: error.message, provider: 'sarvam' });
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SARVAM API CORE — intra-provider model fallback
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function buildSarvamModels(action) {
    const defaults = ACTION_MODELS[action] || SARVAM_DEFAULT_MODELS;
    return buildModelList('SARVAM_MODEL', defaults);
}

async function callSarvamWithModelFallback(prompt, { maxTokens = 600, isJsonMode = false, action = 'unknown', startTime = Date.now(), meta = null } = {}) {
    const models = buildSarvamModels(action);
    let lastErr;

    for (const model of models) {
        if (modelTracker.isBlocked(model)) {
            console.warn(`[model-fallback] { provider: 'sarvam', skipping: '${model}', reason: 'blocked', action: '${action}' }`);
            continue;
        }

        const body = {
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            temperature: action === 'answerQuestion' ? 0.3 : 0.2,
            // response_format is opt-in — off by default because several Sarvam
            // deployments reject it. JSON is still enforced by the prompt + parseProviderJSON.
            ...(isJsonMode && SARVAM_JSON_MODE ? { response_format: { type: 'json_object' } } : {})
        };

        let attempt = 0;
        const maxAttemptsPerModel = 2;

        while (attempt < maxAttemptsPerModel) {
            try {
                const elapsed = Date.now() - startTime;
                const timeout = Math.min(REQUEST_TIMEOUT_MS, VERCEL_DEADLINE_MS - elapsed - 3000);
                if (timeout < 3000) throw new Error('Insufficient time budget for Sarvam request');

                const response = await fetchWithTimeout(
                    SARVAM_API_URL,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            // Send both auth styles: Sarvam's OpenAI-compatible endpoint accepts
                            // `Authorization: Bearer`, while some native routes expect
                            // `api-subscription-key`. Sending both authenticates regardless.
                            'Authorization': `Bearer ${process.env.SARVAM_API_KEY}`,
                            'api-subscription-key': process.env.SARVAM_API_KEY
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
                    console.log(`[Sarvam] ✅ Success (model=${model}, action=${action}, tokens=${data.usage?.total_tokens ?? '?'})`);
                    return text;
                }

                const status = response.status;
                const errBody = await response.json().catch(() => ({}));
                const errMsg = errBody.error?.message || errBody.message || '';
                const errCode = errBody.error?.code || '';

                // Auth errors — escalate immediately (no point retrying/switching models)
                if (status === 401 || status === 403) {
                    throw new Error(`Sarvam auth error ${status}: ${errMsg}`);
                }

                // Model deprecated/not found — switch immediately
                if (status === 404 || errCode === 'model_not_found' || errMsg.toLowerCase().includes('not found')) {
                    console.warn('[model-fallback]', { provider: 'sarvam', attempted: model, reason: 'MODEL_NOT_FOUND', switchingTo: models[models.indexOf(model) + 1] || 'none', action });
                    modelTracker.recordFailure(model);
                    break;
                }

                // Model overloaded / unavailable — retry once, then switch
                if (status === 503 || errMsg.toLowerCase().includes('overloaded') || errMsg.toLowerCase().includes('unavailable')) {
                    if (attempt === 0) {
                        console.warn(`[Sarvam] Overloaded (${model}). Retrying once...`);
                        await new Promise(r => setTimeout(r, 1500));
                        attempt++;
                        continue;
                    }
                    console.warn('[model-fallback]', { provider: 'sarvam', attempted: model, reason: 'OVERLOADED', switchingTo: models[models.indexOf(model) + 1] || 'none', action });
                    modelTracker.recordFailure(model);
                    break;
                }

                // Rate limited — retry once, then switch
                if (status === 429) {
                    const retryAfter = parseInt(response.headers?.get?.('retry-after') || '0', 10) * 1000;
                    if (attempt === 0) {
                        const waitMs = retryAfter || 8000;
                        console.warn(`[Sarvam] Rate limited (${model}). Waiting ${waitMs / 1000}s...`);
                        await new Promise(r => setTimeout(r, waitMs));
                        attempt++;
                        continue;
                    }
                    console.warn('[model-fallback]', { provider: 'sarvam', attempted: model, reason: 'RATE_LIMITED', switchingTo: models[models.indexOf(model) + 1] || 'none', action });
                    modelTracker.recordFailure(model);
                    break;
                }

                lastErr = new Error(`Sarvam ${status}: ${errMsg}`);
                modelTracker.recordFailure(model);
                break;

            } catch (err) {
                if (err.name === 'AbortError') {
                    if (attempt === 0) {
                        console.warn(`[Sarvam] Timeout on ${model} (attempt 1). Retrying...`);
                        attempt++;
                        continue;
                    }
                    console.warn('[model-fallback]', { provider: 'sarvam', attempted: model, reason: 'TIMEOUT', switchingTo: models[models.indexOf(model) + 1] || 'none', action });
                    modelTracker.recordFailure(model);
                    lastErr = err;
                    break;
                }
                if (err.message.includes('auth error') || err.message.includes('Insufficient time budget')) {
                    throw err;
                }
                lastErr = err;
                modelTracker.recordFailure(model);
                break;
            }
        }
    }

    console.error('[provider-escalation]', { provider: 'sarvam', action, reason: 'all_models_exhausted' });
    throw lastErr || new Error('All Sarvam models exhausted or blocked');
}
