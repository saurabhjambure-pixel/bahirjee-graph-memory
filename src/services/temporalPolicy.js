/**
 * Temporal Policy — the single source of truth for "is this current?"
 *
 * The pipeline retrieves evidence across a wide date range and then has to answer one
 * question about every piece of it: is this a CURRENT event a founder should act on, is it
 * CONTEXT that explains a current event, or is it HISTORICAL background?
 *
 * Before this module the answer was implicit and wrong in a specific way: a signal's
 * timestamp was set at ingestion (`new Date()` when we transformed it), so a 2024 article
 * crawled today carried a 2026 timestamp into the news surface. Nothing threw. The brief
 * was just quietly presenting old material as news.
 *
 * Three windows, and they do NOT overlap in role:
 *
 *   current     6 calendar months   dated events — the only thing that may appear as news
 *   context    12 calendar months   reports, research, reviews, market material
 *   historical  everything older    retained forever, retrievable, never standalone news
 *
 * Nothing here deletes evidence. Classification decides where a piece of evidence may be
 * SHOWN, never whether it is kept. Historical evidence stays in the database and can be
 * attached to a recent anchor as labelled context.
 *
 * This module is pure: no Supabase, no provider calls, no React. That is deliberate —
 * date semantics are the thing most worth testing in isolation, and a module that imports
 * a database client cannot be tested that way.
 */

// ─── calendar arithmetic ────────────────────────────────────────────────────

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n) => String(n).padStart(2, '0');

const toIsoDay = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * Subtract whole CALENDAR months, not months × 30.
 *
 * The approximation this replaces (`months * 30 * 86400000`) drifts by five days over a
 * year, which puts the boundary somewhere a founder cannot predict. "Six months back from
 * September 19th" has to mean March 19th, because that is the sentence we have to be able
 * to say out loud when explaining why something is or isn't current.
 *
 * A target month too short for the source day clamps to that month's last day, so
 * March 31 minus one month is February 28 (or 29), never a silent roll into March 3.
 *
 * @param {Date|string} date
 * @param {number} months
 * @returns {string|null} YYYY-MM-DD, or null when the input is not a usable date
 */
export function subtractCalendarMonths(date, months) {
    const base = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(base?.getTime?.())) return null;

    const y = base.getUTCFullYear();
    const m = base.getUTCMonth() + 1; // 1-12
    const d = base.getUTCDate();

    const shifted = (y * 12 + (m - 1)) - Math.round(Number(months) || 0);
    const targetYear = Math.floor(shifted / 12);
    const targetMonth = (shifted % 12 + 12) % 12 + 1; // back to 1-12

    return toIsoDay(targetYear, targetMonth, Math.min(d, daysInMonth(targetYear, targetMonth)));
}

/**
 * Strict ISO day normalisation.
 *
 * Fuzzy input is REJECTED, never guessed. "Q3 2024" parsed optimistically becomes a
 * confident wrong date, and a confident wrong date is worse than an admitted missing one
 * (internal design log). An undated piece of evidence is handled honestly downstream;
 * a misdated one silently corrupts every window comparison it touches.
 *
 * Accepts: 'YYYY-MM-DD', a full ISO timestamp, or a Date. Everything else is null.
 */
export function normalizeIsoDate(value) {
    if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
    }
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    // Take the day portion of an ISO timestamp, but only when the rest looks like one.
    const candidate = /^\d{4}-\d{2}-\d{2}T/.test(trimmed) ? trimmed.slice(0, 10) : trimmed;

    const match = ISO_DAY.exec(candidate);
    if (!match) return null;

    const [, ys, ms, ds] = match;
    const year = Number(ys);
    const month = Number(ms);
    const day = Number(ds);

    // Reject 2026-13-01 and 2026-02-30 rather than letting Date roll them forward.
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > daysInMonth(year, month)) return null;

    return toIsoDay(year, month, day);
}

const dayDiff = (fromIso, toIso) => {
    const a = Date.parse(`${fromIso}T00:00:00Z`);
    const b = Date.parse(`${toIso}T00:00:00Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.round((b - a) / 86400000);
};

// ─── the policy ─────────────────────────────────────────────────────────────

export const CURRENT_WINDOW_MONTHS = 6;
export const CONTEXT_WINDOW_MONTHS = 12;

/**
 * Build the run's temporal policy from a single clock reading.
 *
 * One policy object is built per run and threaded through retrieval, prompting and
 * classification. That matters: the pipeline previously recomputed `Date.now() - months *
 * 30 * 86400000` in six separate places, so a long run could classify the same evidence
 * against two different boundaries depending on which step reached it.
 *
 * @param {Date} [now]
 */
export function buildTemporalPolicy(now = new Date()) {
    const clock = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
    const endDate = clock.toISOString().slice(0, 10);

    return {
        current: {
            startDate: subtractCalendarMonths(clock, CURRENT_WINDOW_MONTHS),
            endDate,
            months: CURRENT_WINDOW_MONTHS,
        },
        context: {
            startDate: subtractCalendarMonths(clock, CONTEXT_WINDOW_MONTHS),
            endDate,
            months: CONTEXT_WINDOW_MONTHS,
        },
        // Older evidence is never bounded away. It is retained, it stays retrievable, and
        // it may be attached to a recent anchor as labelled context — it simply cannot
        // stand alone as current news.
        historical: { mode: 'on_demand' },
        generatedAt: clock.toISOString(),
    };
}

// ─── classification ─────────────────────────────────────────────────────────

/**
 * Decide what a piece of evidence IS, temporally.
 *
 * Date precedence, in order, with no fallback past the end of it:
 *   1. eventDate      — when the thing actually happened (confidence: high)
 *   2. publishedDate  — when the source reported it       (confidence: medium)
 *   3. nothing        — undated                           (confidence: low)
 *
 * `retrievedAt` is ingestion time and is NEVER used as an event date. That substitution is
 * the entire bug this module exists to prevent. The one exception is spelled out below and
 * is not a substitution at all: a Source Watch diff.
 *
 * @param {Object} evidence
 * @param {string|Date|null} evidence.eventDate     When the event happened, per the source
 * @param {string|Date|null} evidence.publishedDate When the source published
 * @param {string|Date|null} evidence.retrievedAt   When WE fetched it (ingestion)
 * @param {string|null} evidence.sourceClass        filing / tender / primary_company / …
 * @param {string|null} evidence.sourceType         which provider fetched it
 * @param {boolean} evidence.observedChange         Source Watch saw this page's hash change
 * @param {Object} policy  from buildTemporalPolicy()
 * @returns {{temporalRole: string, effectiveDate: string|null, dateKind: string|null,
 *            dateConfidence: string, ageDays: number|null}}
 */
export function classifyEvidenceDate(evidence, policy) {
    const e = evidence || {};
    const p = policy || buildTemporalPolicy();

    const eventDate = normalizeIsoDate(e.eventDate);
    const publishedDate = normalizeIsoDate(e.publishedDate);

    let effectiveDate = eventDate || publishedDate || null;
    let dateKind = eventDate ? 'event' : (publishedDate ? 'published' : null);
    let dateConfidence = eventDate ? 'high' : (publishedDate ? 'medium' : 'low');

    // ── The one place ingestion time IS event time ──────────────────────────
    // Source Watch re-reads an entity's own pages and emits an observation ONLY where the
    // content hash changed since the last run. The diff is itself the evidence that the
    // change is new: the page said something else last time we looked. So for a watch
    // diff, "when we observed it" genuinely bounds when it happened.
    //
    // Note the guard: this only applies when the evidence is otherwise undated. A watch
    // hit on a page carrying a real 2024 date stays 2024 — an observed change does not
    // launder an old date into a new one.
    if (!effectiveDate && e.observedChange === true) {
        const observed = normalizeIsoDate(e.retrievedAt);
        if (observed) {
            effectiveDate = observed;
            dateKind = 'event';
            // Medium, not high: we know the change happened within the interval since the
            // last run, not on the exact day we noticed it.
            dateConfidence = 'medium';
        }
    }

    // Undated evidence supports; it never anchors. The general web index returns no
    // published_date at all, so this is the common case, not an edge case — and it is
    // precisely the material that used to become "news" on the strength of its crawl time.
    if (!effectiveDate) {
        return {
            temporalRole: 'supporting_context',
            effectiveDate: null,
            dateKind: null,
            dateConfidence: 'low',
            ageDays: null,
        };
    }

    const ageDays = dayDiff(effectiveDate, p.current.endDate);

    // A date after today cannot be verified as having happened. It must not anchor current
    // news, but calling it historical would be absurd. It supports, with low confidence.
    if (effectiveDate > p.current.endDate) {
        return {
            temporalRole: 'supporting_context',
            effectiveDate,
            dateKind,
            dateConfidence: 'low',
            ageDays,
        };
    }

    // Boundaries are inclusive at both ends: the six-month cutoff date is current.
    const temporalRole = effectiveDate >= p.current.startDate
        ? 'anchor'
        : (effectiveDate >= p.context.startDate ? 'supporting_context' : 'historical_context');

    return { temporalRole, effectiveDate, dateKind, dateConfidence, ageDays };
}

/**
 * Only a DATED anchor may reach a current surface.
 *
 * The second half of this condition is not redundant. It is the backstop for a row whose
 * `temporal_role` was written by an older build, a legacy database row, or a model that
 * claimed a role it could not support. A role without a date is not a current event.
 */
export function isCurrentAnchor(classification) {
    if (!classification) return false;
    return classification.temporalRole === 'anchor' && Boolean(classification.effectiveDate);
}

// ─── provider parameters ────────────────────────────────────────────────────

/**
 * Express a named window in the form the search provider actually honours.
 *
 * Tavily honours `days` only on topic 'news' and start_date/end_date only on the other
 * topics. Sending both would let the ignored half look like it was applied — which is how
 * five of seven themes ran effectively unbounded while passing a lookback.
 *
 * The 'profile' window is deliberately EMPTY rather than wide. Context assembly wants the
 * company's own homepage, and a date window on topic 'general' filters undated pages OUT,
 * so a bounded profile lookup would lose exactly the page it was sent for.
 *
 * @param {'current'|'context'|'profile'} windowName
 * @param {Object} policy
 * @param {'news'|'general'} [topic]
 */
export function buildDateWindowParams(windowName, policy, topic = 'general') {
    const p = policy || buildTemporalPolicy();
    const window = windowName === 'current' ? p.current : (windowName === 'context' ? p.context : null);

    // 'profile' and anything unrecognised go out unbounded rather than guessed at.
    if (!window) return {};

    if (topic === 'news') {
        const days = dayDiff(window.startDate, window.endDate);
        // Tavily clamps to 1..365 server-side; mirror it so the request says what it means.
        return { days: Math.min(365, Math.max(1, days ?? 1)) };
    }

    return { start_date: window.startDate, end_date: window.endDate };
}
