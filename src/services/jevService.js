/**
 * Jev client — typed decisions (scores, yes/no, choices) for the pipeline.
 *
 * Jev generates no text. It is used only where the pipeline already has a decision to make
 * over a known set of answers (which page to read in full, whether a page change matters,
 * how material a finding is), and in every one of those places the rule-based code still
 * produces the candidates and the fallback answer. This module is the only way pipeline
 * code reaches /api/jev, and it can never make a step fail:
 *
 *   - Every call returns answers or `null`; a null means "decide the old way".
 *   - No key → the gateway says PROVIDER_UNAVAILABLE once, and the client stops calling for
 *     the rest of the process instead of paying a round trip per item.
 *   - A run of failures with no success (vendor down, or a wire format that turned out
 *     wrong) trips a breaker, so ~200 calls cannot each wait out a timeout.
 *   - `decideEach` stops issuing requests past its deadline, so a slow vendor cannot push
 *     a step past its invocation budget.
 *
 * Each use case has a mode, from env `JEV_<USE_CASE>` (falling back to `JEV_MODE`):
 *   off     — never called
 *   shadow  — called and recorded on the report; changes nothing (the default)
 *   on      — allowed to influence the outcome in the narrow way its call site documents
 */

export const JEV_USE_CASES = Object.freeze(['deep_reads', 'triage', 'watch', 'synthesis', 'news', 'review']);
const MODES = new Set(['off', 'shadow', 'on']);
const DEFAULT_CONCURRENCY = 8;

const defaultReadEnv = (name) => (typeof process !== 'undefined' && process?.env?.[name]) || '';

export function jevMode(useCase, readEnv = defaultReadEnv) {
    const raw = String(
        readEnv(`JEV_${String(useCase).toUpperCase()}`) || readEnv('JEV_MODE') || 'shadow'
    ).trim().toLowerCase();
    return MODES.has(raw) ? raw : 'shadow';
}

export function jevConcurrency(readEnv = defaultReadEnv) {
    const n = Number(readEnv('JEV_CONCURRENCY'));
    return Number.isInteger(n) && n >= 1 && n <= 32 ? n : DEFAULT_CONCURRENCY;
}

// ─── question builders (wire shape: see lib/_jevWire.js) ─────────────────────

export const noulQuestion = (instructions) => ({ type: 'noul', instructions });
/** `levels` is an ordered array of 2–10 descriptions, lowest first. */
export const scoreQuestion = (instructions, levels) => ({ type: 'score', instructions, criteria: levels });
export const choiceQuestion = (instructions, options) => ({ type: 'choice', instructions, criteria: options });

// ─── answer readers — null whenever Jev did not give a usable answer ──────────

export const pYes = (a) => (a?.type === 'noul' && typeof a.p === 'number' ? a.p : null);
/** A score as a fraction of its scale: 0 = lowest level, 1 = highest. */
export const scoreFraction = (a) => (a?.type === 'score' && typeof a.fraction === 'number' ? a.fraction : null);

// ─── state ───────────────────────────────────────────────────────────────────

/**
 * Compact company context for a Jev state. Jev's accuracy falls as the state fills with
 * content unrelated to the decision, and the state shares 32k tokens with the questions, so
 * this keeps only the fields that discriminate relevance to this company.
 */
export function compactContext(context = {}) {
    const ctx = context || {};
    const list = (xs, n) => (Array.isArray(xs) ? xs : [])
        .map(x => (typeof x === 'string' ? x : x?.name || x?.entity_name || ''))
        .map(s => String(s).trim())
        .filter(Boolean)
        .slice(0, n);

    const competitors = list(ctx.competitive_map?.named_competitors, 12);
    const entities = list(ctx._trackedEntities, 20);
    const deps = [
        ...list(ctx.dependency_map?.infra_dependencies, 6),
        ...list(ctx.dependency_map?.platform_dependencies, 6),
        ...list(ctx.dependency_map?.regulatory_exposure, 6),
    ];

    return [
        `COMPANY: ${ctx.company_name || 'unknown'}`,
        ctx.industry && `INDUSTRY: ${ctx.industry}`,
        ctx.operating_geography && `GEOGRAPHY: ${ctx.operating_geography}`,
        list(ctx.customer_segments, 6).length && `CUSTOMERS: ${list(ctx.customer_segments, 6).join(', ')}`,
        competitors.length && `COMPETITORS: ${competitors.join(', ')}`,
        deps.length && `DEPENDENCIES: ${[...new Set(deps)].join(', ')}`,
        entities.length && `TRACKED: ${entities.join(', ')}`,
    ].filter(Boolean).join('\n');
}

// ~3k tokens. What the analyze model sees of one observation is at most ~7.5k chars
// (compressObservation), so this only ever bites a pathological row — and it guarantees one
// item can never push a request past Jev's 32k limit and turn into a 400 per item.
export const MAX_ITEM_CHARS = 12000;

/** Company context + the one item being judged — one item per request, per Jev's guidance. */
export function itemState(companyContext, label, text) {
    return `${companyContext}\n\n${label}:\n${String(text || '').trim().slice(0, MAX_ITEM_CHARS)}`;
}

/**
 * How material one source is to the company — the triage question, shared by the pipeline's
 * triage step and scripts/jev-shadow.mjs so the harness measures the question that ships.
 * Levels are ordered lowest first; scoreFraction() maps them to 0, 1/3, 2/3, 1.
 */
export const MATERIALITY_LEVELS = Object.freeze([
    'Unrelated to this company, its market, customers, competitors or dependencies',
    'Background on the wider market with no specific bearing on this company',
    'Relevant: concerns this company\'s market, customers, competitors or dependencies',
    'Directly material: a move by, or a change to, this company\'s competitors, customers, dependencies or regulators',
]);

export function materialityRequest(companyContext, sourceText) {
    return {
        state: itemState(companyContext, 'SOURCE', sourceText),
        questions: {
            material: scoreQuestion('How material is this source to the company described above?', [...MATERIALITY_LEVELS]),
        },
    };
}

/**
 * Whether reading a search result in full would add material detail — the deep-read question.
 * Asked of the snippet the search returned, before any page is fetched, so it prices the
 * read rather than the page.
 */
export const DEEP_READ_LEVELS = Object.freeze([
    'The snippet already carries everything the full page would add',
    'The full page would add detail, but little that bears on this company',
    'The full page likely holds material detail on this company\'s market, customers, competitors or dependencies',
    'The substance is below the fold and directly material to this company',
]);

export function deepReadRequest(companyContext, { title = '', url = '', snippet = '' } = {}) {
    return {
        state: itemState(companyContext, 'SEARCH RESULT', `TITLE: ${title}\nURL: ${url}\nSNIPPET: ${snippet}`),
        questions: {
            depth: scoreQuestion('Would reading this page in full add material detail beyond the snippet, for the company described above?', [...DEEP_READ_LEVELS]),
        },
    };
}

/**
 * Is a structural finding supported by the evidence behind it? One yes/no per finding the
 * deterministic engines produced — the engines still decide what is a candidate; this asks
 * whether this run's evidence for the theme actually shows it. `kind` is 'shift',
 * 'blind_spot' or 'opportunity'.
 */
export function findingRequest(companyContext, { kind, theme, finding = {}, companyName = 'the company', evidence = '' }) {
    const t = `"${theme}"`;
    const rivals = (finding.competitor_entities || []).slice(0, 5).join(', ') || 'competitors';
    const question = {
        shift: `Does the evidence show a change in direction in ${t} — something starting, accelerating or breaking — rather than more of the same?`,
        blind_spot: `Does the evidence show ${rivals} active in ${t} in a way ${companyName} is not?`,
        opportunity: finding.opportunity_type === 'missed'
            ? `Does the evidence show several competitors active in ${t} while ${companyName} is absent?`
            : `Does the evidence show buyers seeking, budgeting for or switching solutions in ${t}?`,
    }[kind];
    if (!question) return null;
    const described = [
        `KIND: ${kind.replace('_', ' ')}${finding.shift_type ? ` (${finding.shift_type})` : ''}${finding.opportunity_type ? ` (${finding.opportunity_type})` : ''}`,
        `THEME: ${theme}`,
        finding.evidence && `ENGINE NOTE: ${finding.evidence}`,
        `EVIDENCE:\n${evidence || '(none this run)'}`,
    ].filter(Boolean).join('\n');
    return { state: itemState(companyContext, 'FINDING', described), questions: { supported: noulQuestion(question) } };
}

/**
 * Is a tracked page's change substantive? Asked of the diff sourceWatch already computed, so
 * Jev judges exactly what the analyzer would be shown.
 */
export function pageChangeRequest(companyContext, changeText) {
    return {
        state: itemState(companyContext, 'PAGE CHANGE', changeText),
        questions: {
            substantive: noulQuestion(
                'Is this a substantive change to pricing, packaging, product, hiring, availability or service status — '
                + 'rather than cosmetic, boilerplate, navigation, date or tracking text?'
            ),
        },
    };
}

/**
 * The brief review's two questions (JEV_REVIEW). Both catch what attest's phrase lists
 * cannot: an instruction written without any banned phrase, and a "what could change our
 * view" item that restates the read instead of naming what would overturn it.
 */
export function adviceRequest(companyContext, text) {
    return {
        state: itemState(companyContext, 'BRIEF TEXT', text),
        questions: {
            instructs: noulQuestion(
                'Does this text tell the reader what to do — an instruction, recommendation or next step — '
                + 'rather than state what the evidence shows and how strongly?'
            ),
        },
    };
}

export function falsifierRequest(companyContext, read, condition) {
    return {
        state: itemState(companyContext, 'THE READ AND ONE STATED CONDITION', `READ: ${read}\nCONDITION: ${condition}`),
        questions: {
            overturns: noulQuestion(
                'Does the condition name something that, if it happened or were found, would show the read to be wrong — '
                + 'rather than restate, support or merely elaborate the read?'
            ),
        },
    };
}

/** P(yes) as the confidence band the report already speaks in. */
export function confidenceBand(p) {
    if (typeof p !== 'number' || !Number.isFinite(p)) return null;
    return p >= 0.7 ? 'High' : p >= 0.4 ? 'Medium' : 'Low';
}

/**
 * A score for ranking where an unanswered item must sort as neither good nor bad. Jev's
 * absence is not a low score: ranking a failed call below every answered one would make an
 * outage look like a verdict.
 */
export const NEUTRAL_FRACTION = 0.5;
export const rankFraction = (f) => (typeof f === 'number' && Number.isFinite(f) ? f : NEUTRAL_FRACTION);

/**
 * Record what a use case did on the run state, so every report says which Jev decisions ran,
 * in which mode, and how many answered versus failed open. `failed === n` on a report means
 * the gateway or wire format is wrong — in shadow mode that costs nothing but this line.
 */
export function recordJevUse(state, { useCase, mode, n = 0, answered = 0, failed = 0, skipped = 0, ...extra }) {
    if (!state) return;
    // Additive: a use case that runs in slices (per search wave, per triage slice) records
    // once per slice, and the report must show the run's total, not the last slice's.
    const prev = state.jev?.[useCase] || {};
    state.jev = {
        ...(state.jev || {}),
        [useCase]: {
            ...prev,
            ...extra,
            mode,
            n: (prev.n || 0) + n,
            answered: (prev.answered || 0) + answered,
            failed: (prev.failed || 0) + failed,
            skipped: (prev.skipped || 0) + skipped,
        },
    };
}

// ─── client ──────────────────────────────────────────────────────────────────

/**
 * @param {Object}   opts
 * @param {Function} opts.post      (url, body) => fetch-like Response — the pipeline runtime's postJson
 * @param {string}   opts.endpoint  default '/api/jev'
 * @param {Function} opts.onCall    ({ ok, tokens, model, latencyMs, useCase }) — spend/provenance hook
 */
export function createJevClient({ post, endpoint = '/api/jev', onCall = () => {}, readEnv = defaultReadEnv } = {}) {
    let unavailable = false;

    async function decide({ state, questions, useCase = null }) {
        if (unavailable || typeof post !== 'function') return null;
        const t0 = Date.now();
        try {
            const res = await post(endpoint, { state, questions });
            if (!res?.ok) {
                const body = await res?.json?.().catch(() => ({})) ?? {};
                // No key, or not permitted: nothing later in this process will succeed either.
                if (body?.code === 'PROVIDER_UNAVAILABLE' || res?.status === 403) unavailable = true;
                onCall({ ok: false, tokens: 0, model: null, latencyMs: Date.now() - t0, useCase });
                return null;
            }
            const header = (name) => (res.headers?.get ? res.headers.get(name) : null);
            const body = await res.json();
            onCall({ ok: true, tokens: Number(header('x-llm-tokens')) || 0, model: header('x-llm-model'), latencyMs: Date.now() - t0, useCase });
            return body?.answers && typeof body.answers === 'object' ? body.answers : null;
        } catch {
            onCall({ ok: false, tokens: 0, model: null, latencyMs: Date.now() - t0, useCase });
            return null;
        }
    }

    /**
     * One request per item. `build(item, index)` returns `{ state, questions }`, or null to
     * skip that item. Returns `{ results, n, answered, failed, skipped }` where `results[i]`
     * is the answers for items[i] or null — a null is always "decide the old way", never
     * "Jev said no".
     *
     * `deadlineMs` is a hard bound: the call resolves by then even if requests are still in
     * flight (each may otherwise wait out the gateway's timeout). An answer that arrives
     * after the deadline is discarded and its item counted as skipped, so what the caller
     * holds never changes after it has moved on.
     */
    async function decideEach(items, build, { useCase = null, concurrency = jevConcurrency(readEnv), deadlineMs = null } = {}) {
        const list = Array.isArray(items) ? items : [];
        const results = new Array(list.length).fill(null);
        const started = Date.now();
        // One full wave failing with no success at all means the vendor is down or the wire
        // format is wrong. Stop there instead of paying a timeout per remaining item.
        const breakAfter = Math.max(4, concurrency);
        let next = 0, answered = 0, failed = 0, tripped = false, closed = false;

        const worker = async () => {
            for (;;) {
                if (closed) return;
                const i = next++;
                if (i >= list.length) return;
                const expired = deadlineMs != null && Date.now() - started > deadlineMs;
                if (unavailable || tripped || expired) continue;
                const request = build(list[i], i);
                if (!request) continue;
                const answers = await decide({ ...request, useCase });
                if (closed) return;
                if (answers) { results[i] = answers; answered++; }
                else {
                    failed++;
                    if (answered === 0 && failed >= breakAfter) tripped = true;
                }
            }
        };

        const all = Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));
        if (deadlineMs == null) {
            await all;
        } else {
            let timer;
            await Promise.race([all, new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, deadlineMs)); })]);
            clearTimeout(timer);
        }
        closed = true;
        return { results, n: list.length, answered, failed, skipped: list.length - answered - failed };
    }

    return { decide, decideEach, isUnavailable: () => unavailable };
}
