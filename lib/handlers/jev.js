import { applyApiSecurity } from '../_security.js';
import { requireAuthenticatedUser, hasValidInternalApiKey } from '../_auth.js';
import { fetchWithTimeout, applyLlmMeta } from '../_llmUtils.js';
import { validateRequest, buildRequestBody, parseResponse } from '../_jevWire.js';

// Jev gateway — typed decisions (choice / score / yes-no) from TypeSafe's System One model.
//
// Env:
//   JEV_API_KEY  — required; without it every call returns PROVIDER_UNAVAILABLE and the
//                  pipeline falls back to its rule-based behaviour
//   JEV_MODEL    — default 'jev-latest'
//   JEV_API_URL  — default https://api.typesafe.ai/v1/systemone (tests point it at a fake)
//
// Body: { state: string, questions: { name: { type, instructions, criteria } } }.
// Response: { model, answers } normalised by lib/_jevWire.js, so no caller knows the
// vendor's shape.

// Jev reports 70–500ms per decision. Anything this slow is an outage; failing fast keeps a
// pipeline step inside its invocation budget, and the caller falls back.
const JEV_TIMEOUT_MS = 8000;

export async function handler(req, res) {
    // High per-IP ceiling on purpose: the only callers are pipeline steps calling in-process,
    // and they all report 127.0.0.1 — one run's triage alone makes ~200 calls.
    if (await applyApiSecurity(req, res, { routeKey: 'jev', maxRequests: 3000 })) return;
    if (!await requireAuthenticatedUser(req, res, { rateLimit: { routeKey: 'jev', maxRequests: 30 } })) return;

    // Server-only. Nothing in the browser needs a Jev decision, and admitting user tokens
    // would let any signed-in user spend the account's Jev quota directly.
    if (!hasValidInternalApiKey(req)) {
        return res.status(403).json({ error: 'Jev is only callable by the pipeline', provider: 'jev' });
    }

    const apiKey = process.env.JEV_API_KEY;
    if (!apiKey) {
        return res.status(503).json({ error: 'Jev not configured', code: 'PROVIDER_UNAVAILABLE', provider: 'jev' });
    }

    const { state, questions } = req.body || {};
    const check = validateRequest({ state, questions });
    if (!check.ok) return res.status(400).json({ error: check.error, provider: 'jev' });

    const model = process.env.JEV_MODEL || 'jev-latest';
    const url = process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone';

    try {
        const response = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(buildRequestBody({ state, questions }, model)),
        }, JEV_TIMEOUT_MS);

        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
            const message = json?.error?.message || (typeof json?.error === 'string' ? json.error : null) || 'error';
            console.warn(`[Jev] upstream ${response.status}: ${message}`);
            return res.status(502).json({ error: `Jev ${response.status}: ${message}`, provider: 'jev', upstreamStatus: response.status });
        }

        const parsed = parseResponse(json, questions);
        // Output is free; input is what Jev bills, so the estimate is what spend records.
        applyLlmMeta(res, { model: parsed.model || model, tokens: check.tokens });
        return res.json(parsed);
    } catch (err) {
        console.warn('[Jev] request failed:', err.message);
        return res.status(502).json({ error: `Jev request failed: ${err.message}`, provider: 'jev' });
    }
}
