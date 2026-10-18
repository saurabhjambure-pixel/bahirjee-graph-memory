/**
 * TypeSafe Jev wire format — the ONLY module that knows the vendor's request/response shape.
 *
 * Jev returns typed decisions, not text. One request carries one `state` (the thing being
 * judged) and up to 32 named questions about it:
 *   - choice: pick one of ≤64 named options          → { choice, probabilities, confidence }
 *   - score:  place the state on 2–10 ordered levels → { score (0-based, may be fractional),
 *                                                       probabilities keyed "0","1",…, confidence }
 *   - noul:   yes/no                                  → { noul: P(yes) }
 *
 * Source: LiteLLM's TypeSafe pass-through docs (POST /v1/systemone, questions keyed by name,
 * `criteria` as {option: meaning} for choice and an ordered array for score). docs.typesafe.ai
 * could not be read from the environment this was written in, so this module is written to
 * be the single place to correct — every caller goes through validateRequest /
 * buildRequestBody / parseResponse, and parseResponse never throws: a shape it does not
 * recognise yields null answers, which callers treat as "Jev did not answer" and fall back.
 */

export const JEV_LIMITS = Object.freeze({
    maxQuestions: 32,
    maxChoiceOptions: 64,
    minScoreLevels: 2,
    maxScoreLevels: 10,
    // Shared by the state and every question definition.
    maxInputTokens: 32000,
});

const QUESTION_TYPES = new Set(['choice', 'score', 'noul']);
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Conservative: 4 chars/token under-counts dense text, so round up. */
export function estimateTokens(value) {
    return Math.ceil(String(value ?? '').length / 4);
}

export function estimateRequestTokens({ state, questions }) {
    let total = estimateTokens(state);
    for (const q of Object.values(questions || {})) {
        total += estimateTokens(q?.instructions);
        total += estimateTokens(JSON.stringify(q?.criteria ?? ''));
    }
    return total;
}

/** `{ ok: true, tokens }` or `{ ok: false, error }`. Checked before anything is sent. */
export function validateRequest({ state, questions } = {}) {
    if (typeof state !== 'string' || !state.trim()) return { ok: false, error: 'state must be a non-empty string' };
    if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
        return { ok: false, error: 'questions must be an object keyed by question name' };
    }
    const entries = Object.entries(questions);
    if (entries.length === 0) return { ok: false, error: 'at least one question is required' };
    if (entries.length > JEV_LIMITS.maxQuestions) return { ok: false, error: `at most ${JEV_LIMITS.maxQuestions} questions per request` };

    for (const [name, q] of entries) {
        if (!NAME.test(name)) return { ok: false, error: `invalid question name "${name}"` };
        if (!q || !QUESTION_TYPES.has(q.type)) return { ok: false, error: `${name}: type must be choice, score or noul` };
        if (typeof q.instructions !== 'string' || !q.instructions.trim()) return { ok: false, error: `${name}: instructions required` };
        if (q.type === 'choice') {
            const options = q.criteria && typeof q.criteria === 'object' && !Array.isArray(q.criteria) ? Object.keys(q.criteria) : [];
            if (options.length < 2 || options.length > JEV_LIMITS.maxChoiceOptions) {
                return { ok: false, error: `${name}: choice needs 2–${JEV_LIMITS.maxChoiceOptions} options in criteria` };
            }
        }
        if (q.type === 'score') {
            const levels = Array.isArray(q.criteria) ? q.criteria : [];
            if (levels.length < JEV_LIMITS.minScoreLevels || levels.length > JEV_LIMITS.maxScoreLevels
                || levels.some(l => typeof l !== 'string' || !l.trim())) {
                return { ok: false, error: `${name}: score needs ${JEV_LIMITS.minScoreLevels}–${JEV_LIMITS.maxScoreLevels} ordered level descriptions` };
            }
        }
    }

    const tokens = estimateRequestTokens({ state, questions });
    if (tokens > JEV_LIMITS.maxInputTokens) {
        return { ok: false, error: `request is ~${tokens} tokens; the limit is ${JEV_LIMITS.maxInputTokens} (state + questions)` };
    }
    return { ok: true, tokens };
}

export function buildRequestBody({ state, questions }, model = 'jev-latest') {
    const out = {};
    for (const [name, q] of Object.entries(questions)) {
        out[name] = { type: q.type, instructions: q.instructions };
        if (q.criteria !== undefined) out[name].criteria = q.criteria;
    }
    return { model, state, questions: out };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp01 = (v) => (v == null ? null : Math.min(1, Math.max(0, v)));

/**
 * Normalize the vendor response into answers the pipeline can use without knowing the
 * vendor: `{ model, answers: { name: { type, … } } }`.
 *   noul   → { type, p }                       P(yes) in [0,1]
 *   score  → { type, score, levels, fraction } fraction = score/(levels-1) in [0,1]
 *   choice → { type, choice, confidence }
 * Any value that is missing or malformed becomes null — never a guess.
 */
export function parseResponse(json, questions = {}) {
    const raw = json?.answers && typeof json.answers === 'object' ? json.answers : {};
    const answers = {};
    for (const [name, q] of Object.entries(questions)) {
        const a = raw[name] || {};
        if (q.type === 'noul') {
            answers[name] = { type: 'noul', p: clamp01(num(a.noul) ?? num(a.probability)) };
        } else if (q.type === 'score') {
            const levels = Array.isArray(q.criteria) ? q.criteria.length : 0;
            const score = num(a.score);
            const valid = score != null && levels >= 2 && score >= 0 && score <= levels - 1;
            answers[name] = {
                type: 'score',
                score: valid ? score : null,
                levels,
                fraction: valid ? score / (levels - 1) : null,
                confidence: clamp01(num(a.confidence)),
            };
        } else {
            const options = q.criteria && typeof q.criteria === 'object' ? Object.keys(q.criteria) : [];
            const choice = typeof a.choice === 'string' && options.includes(a.choice) ? a.choice : null;
            answers[name] = { type: 'choice', choice, confidence: clamp01(num(a.confidence)) };
        }
    }
    return { model: typeof json?.model === 'string' ? json.model : null, answers };
}
