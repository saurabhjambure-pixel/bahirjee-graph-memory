import { applyApiSecurity } from '../_security.js';
import { requireAuthenticatedUser } from '../_auth.js';
import { parseProviderJSON, salvageTruncatedJSON, fetchWithTimeout, ModelFailureTracker, buildModelList, createOpenAICompatHandlers } from '../_llmUtils.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIGURATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 50000;
const VERCEL_DEADLINE_MS = 57000;

// claude-sonnet-4-6: 200K context, best analytical quality — primary for all heavy tasks
// claude-haiku-4-5-20251001: 200K context, fast + cheap — fallback for rate limits
const ACTION_MODELS = {
    buildContext:      ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    mergeContext:      ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    frameDecision:     ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
    generateQueries:   ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
    analyzeSignals:    ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    generateSummary:   ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    generateDecisionBrief: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    interpretShifts:   ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
    answerQuestion:    ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    // Extraction is verbatim-quote bound, not analytical — Haiku is accurate and cheap here.
    extractDocumentIntel: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
};

// Per-action token budgets (Claude is more efficient — outputs are dense)
const ACTION_MAX_TOKENS = {
    buildContext:      6000,
    generateQueries:   500,
    analyzeSignals:    8000,
    generateSummary:   2500,
    generateDecisionBrief: 5000,
    interpretShifts:   800,
    answerQuestion:    700,
    extractDocumentIntel: 4000,
};

const modelTracker = new ModelFailureTracker();

const SUPPORTED_ACTIONS = ['buildContext', 'mergeContext', 'frameDecision', 'generateQueries', 'analyzeSignals', 'generateSummary', 'generateDecisionBrief', 'interpretShifts', 'answerQuestion', 'extractDocumentIntel'];

// createOpenAICompatHandlers expects callFn to return a text string.
// callClaudeWithModelFallback returns the raw text content from Claude's response.
const H = createOpenAICompatHandlers(callClaudeWithModelFallback);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function handler(req, res) {
    if (await applyApiSecurity(req, res, { routeKey: 'claude', maxRequests: 30 })) return;
    if (!await requireAuthenticatedUser(req, res, { rateLimit: { routeKey: 'claude', maxRequests: 30 } })) return;

    const { action, payload } = req.body || {};
    const startTime = Date.now();

    if (!SUPPORTED_ACTIONS.includes(action) || !payload || typeof payload !== 'object') {
        return res.status(400).json({ error: `Unsupported action or payload for Claude: ${action}`, provider: 'claude' });
    }

    if (!process.env.CLAUDE_API_KEY) {
        return res.status(503).json({ error: 'Claude not configured', code: 'PROVIDER_UNAVAILABLE', provider: 'claude' });
    }

    try {
        return await H[action](payload, res, startTime);
    } catch (error) {
        console.error(`[Claude] Error (action=${action}):`, error.message);
        return res.status(500).json({ error: error.message, provider: 'claude' });
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CLAUDE API CORE — intra-provider model fallback
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function buildClaudeModels(action) {
    const defaults = ACTION_MODELS[action] || ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
    return buildModelList('CLAUDE_MODEL', defaults);
}

async function callClaudeWithModelFallback(prompt, {
    maxTokens, isJsonMode = false, action = 'unknown', startTime = Date.now(), meta = null
} = {}) {
    const resolvedMaxTokens = maxTokens || ACTION_MAX_TOKENS[action] || 1500;
    const models = buildClaudeModels(action);
    let lastErr;

    for (const model of models) {
        if (modelTracker.isBlocked(model)) {
            console.warn(`[model-fallback] { provider: 'claude', skipping: '${model}', reason: 'blocked', action: '${action}' }`);
            continue;
        }

        const systemPrompt = isJsonMode
            ? 'You are a precise JSON-outputting analyst. Return ONLY valid JSON — no markdown, no code fences, no explanation. Your entire response must be parseable by JSON.parse().'
            : 'You are a precise strategic intelligence analyst. Be concise and specific.';

        const body = {
            model,
            max_tokens: resolvedMaxTokens,
            temperature: action === 'answerQuestion' ? 0.3 : 0.1,
            system: systemPrompt,
            messages: [{ role: 'user', content: prompt }],
        };

        let attempt = 0;
        const maxAttemptsPerModel = 2;

        while (attempt < maxAttemptsPerModel) {
            try {
                const elapsed = Date.now() - startTime;
                const timeout = Math.min(REQUEST_TIMEOUT_MS, VERCEL_DEADLINE_MS - elapsed - 3000);
                if (timeout < 3000) throw new Error('Insufficient time budget for Claude request');

                const response = await fetchWithTimeout(
                    CLAUDE_API_URL,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': process.env.CLAUDE_API_KEY,
                            'anthropic-version': ANTHROPIC_VERSION,
                        },
                        body: JSON.stringify(body),
                    },
                    timeout
                );

                if (response.ok) {
                    const data = await response.json();
                    // Anthropic response: { content: [{ type: 'text', text: '...' }] }
                    const text = data.content?.[0]?.text || '';
                    modelTracker.reset(model);
                    if (meta) {
                        meta.model = model;
                        meta.tokens = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0) || null;
                    }
                    console.log(`[Claude] ✅ Success (model=${model}, action=${action}, tokens=${data.usage?.output_tokens || '?'})`);
                    return text;
                }

                const status = response.status;
                const errBody = await response.json().catch(() => ({}));
                const errMsg = errBody.error?.message || errBody.message || '';
                const errType = errBody.error?.type || '';

                if (status === 401) throw new Error(`Claude auth error: ${errMsg}`);

                if (status === 404 || errType === 'not_found_error') {
                    console.warn('[model-fallback]', { provider: 'claude', attempted: model, reason: 'MODEL_NOT_FOUND', switchingTo: models[models.indexOf(model) + 1] || 'none', action });
                    modelTracker.recordFailure(model);
                    break;
                }

                if (status === 529 || errType === 'overloaded_error') {
                    if (attempt === 0) {
                        console.warn(`[Claude] Overloaded (${model}). Retrying in 2s...`);
                        await new Promise(r => setTimeout(r, 2000));
                        attempt++;
                        continue;
                    }
                    console.warn('[model-fallback]', { provider: 'claude', attempted: model, reason: 'OVERLOADED', switchingTo: models[models.indexOf(model) + 1] || 'none', action });
                    modelTracker.recordFailure(model);
                    break;
                }

                if (status === 429 || errType === 'rate_limit_error') {
                    const retryAfter = parseInt(response.headers?.get?.('retry-after') || '0', 10) * 1000;
                    const waitMs = retryAfter || 10000;
                    if (attempt === 0) {
                        console.warn(`[Claude] Rate limited (${model}). Waiting ${waitMs / 1000}s...`);
                        await new Promise(r => setTimeout(r, waitMs));
                        attempt++;
                        continue;
                    }
                    console.warn('[model-fallback]', { provider: 'claude', attempted: model, reason: 'RATE_LIMITED', switchingTo: models[models.indexOf(model) + 1] || 'none', action });
                    modelTracker.recordFailure(model);
                    break;
                }

                lastErr = new Error(`Claude ${status}: ${errMsg}`);
                modelTracker.recordFailure(model);
                break;

            } catch (err) {
                if (err.name === 'AbortError') {
                    if (attempt === 0) {
                        console.warn(`[Claude] Timeout on ${model} (attempt 1). Retrying...`);
                        attempt++;
                        continue;
                    }
                    console.warn('[model-fallback]', { provider: 'claude', attempted: model, reason: 'TIMEOUT', switchingTo: models[models.indexOf(model) + 1] || 'none', action });
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

    console.error('[provider-escalation]', { provider: 'claude', action, reason: 'all_models_exhausted' });
    throw lastErr || new Error('All Claude models exhausted or blocked');
}
