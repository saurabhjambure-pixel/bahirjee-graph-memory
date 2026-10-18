/**
 * The daily plan — what, if anything, is worth Bahirjee's attention today.
 *
 * This is the "Bahirjee decides" step, and the most important thing about it is that its
 * most common correct output is NOTHING. A Chief Intelligence Officer who reports every
 * morning is noise; one who is quiet for eight days and then says "this one matters" is
 * worth having. Today the pipeline has no such concept — a quiet week costs exactly the
 * same as a loud one and produces exactly as much text.
 *
 * THE LADDER. Four rungs, cheapest first, and most days it stops at the first:
 *
 *   Sense      hash-diff a rotating slice of tracked pages      ~free, no LLM, daily
 *   Triage     one small call: is any of this material?         ~$0.002, only if something moved
 *   Pursue     ≤4 queries → one analyze batch → one Read        ~$0.04, ~2×/week
 *   Synthesize the weekly full run, unchanged                   ~$0.30, weekly
 *
 * THIS MODULE IS PURE — no network, no database, no clock of its own. Everything it needs
 * arrives as an argument, so the routing is testable without credentials, exactly like
 * connectorRegistry.js. The LLM judgment (is this change MATERIAL to that question?) is
 * deliberately NOT here: this module decides what is worth asking about and what it may
 * cost. The asking happens in the handler.
 *
 * See scripts/daily-plan.test.mjs and lib/handlers/cron-daily.js.
 */

import { rankAgenda } from './agendaService.js';
import { RUN_TIERS } from './runTiers.js';

/**
 * At most ONE Read per company per day.
 *
 * This is a product rule expressed as a constant, not a cost control. The complaint this
 * whole design answers is "the entire pipeline runs and dumps everything at once"; a loop
 * that can emit five items in a morning has recreated the same problem at a faster
 * cadence. One thing, or nothing.
 */
export const MAX_PURSUITS_PER_DAY = 1;

/**
 * A question nobody has moved in this long is worth spending a search on even if no page
 * changed. Without this the loop can only react to pages, and a question whose answer
 * lives in the news would sit open forever.
 */
export const QUESTION_DUE_DAYS = 7;

/**
 * How many questions may be described to the triage model. The prompt has to stay small
 * for the call to stay cheap enough to make daily, and the Agenda is ranked before it is
 * truncated, so the cut falls at the bottom.
 */
export const MAX_TRIAGE_CANDIDATES = 6;

/** How many changed pages the triage model sees, for the same reason. */
export const MAX_TRIAGE_CHANGES = 8;

/**
 * The daily budget — re-exported from the tier registry, never redefined.
 *
 * It was originally declared here as its own object, and that was a seven-fold overspend on
 * a timer: `configureIntelligenceRuntime` resolves a budget BY NAME through
 * `resolveRunTier`, unknown names fall back to `full`, and "daily" was not registered. Every
 * pursuit ran at 22 queries and 200 observations instead of 4 and 30, silently.
 *
 * One definition, in the registry that resolution actually consults.
 */
export const DAILY_BUDGET = RUN_TIERS.daily;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Normalise a URL enough to match a changed page against a question's watch list. */
function urlKey(url) {
    return String(url || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/[/?#]+$/, '');
}

/** Has this question gone long enough without moving to be worth a search of its own? */
export function isQuestionDue(question, now = Date.now()) {
    if (!question || question.status !== 'open') return false;
    // Staleness is measured from movement, never from being looked at — a question checked
    // every morning that never resolves is the interesting one.
    const movedAt = Date.parse(question.last_moved_at || question.opened_at || '');
    if (!Number.isFinite(movedAt)) return true;
    return (now - movedAt) >= QUESTION_DUE_DAYS * DAY_MS;
}

/**
 * Decide whether today is worth climbing the ladder for, and with what.
 *
 * @param {Object[]} agenda   open questions, as returned by listAgenda
 * @param {Object[]} changes  pages whose content hash moved, from sourceWatch
 *                            [{ url, entityName, sourceType, summary }]
 * @param {number}   now
 * @returns {{ action: 'quiet'|'triage', reason: string, candidates: Object[],
 *             unmatchedChanges: Object[], budget: Object }}
 *
 * `reason` is written to daily_checks.note and read by the Desk, so it is a plain sentence
 * a founder could see — not a status code.
 */
export function planDailyWork({ agenda = [], changes = [], now = Date.now() } = {}) {
    const ranked = rankAgenda(agenda, now);
    const quiet = (reason) => ({ action: 'quiet', reason, candidates: [], unmatchedChanges: [], budget: DAILY_BUDGET });

    // Attach each changed page to the question that was watching it.
    const byUrl = new Map();
    for (const q of ranked) {
        for (const u of q.watchUrls || []) {
            const k = urlKey(u);
            if (k) byUrl.set(k, q.id);
        }
    }

    const changesByQuestion = new Map();
    const unmatched = [];
    for (const c of changes) {
        const qid = byUrl.get(urlKey(c?.url));
        if (qid) {
            if (!changesByQuestion.has(qid)) changesByQuestion.set(qid, []);
            changesByQuestion.get(qid).push(c);
        } else {
            unmatched.push(c);
        }
    }

    const due = ranked.filter(q => isQuestionDue(q, now));

    if (changes.length === 0 && due.length === 0) {
        return quiet(
            ranked.length === 0
                ? 'Nothing open to pursue yet.'
                : 'Checked the watched pages. Nothing moved, and nothing on the agenda is overdue.'
        );
    }

    // Candidates, most urgent first: questions whose own pages moved outrank questions that
    // are merely overdue, because a changed page is evidence and an overdue question is only
    // a hunch.
    const withChanges = ranked.filter(q => changesByQuestion.has(q.id));
    const overdueOnly = due.filter(q => !changesByQuestion.has(q.id));

    const candidates = [...withChanges, ...overdueOnly]
        .slice(0, MAX_TRIAGE_CANDIDATES)
        .map(q => ({
            questionId: q.id,
            question: q.question,
            watchFor: q.watchFor || null,
            priority: q.priority,
            watchQueries: q.watchQueries || [],
            changes: changesByQuestion.get(q.id) || [],
        }));

    // A page can move without any question watching it. That is still worth judging — the
    // Agenda is not the only thing that can matter — but it is ranked last and capped.
    if (candidates.length === 0 && unmatched.length === 0) {
        return quiet('Checked the watched pages. Nothing moved that any open question was waiting on.');
    }

    const moved = changes.length;
    return {
        action: 'triage',
        reason: moved > 0
            ? `${moved} watched page${moved === 1 ? '' : 's'} changed.`
            : `${due.length} question${due.length === 1 ? '' : 's'} overdue for a look.`,
        candidates,
        unmatchedChanges: unmatched.slice(0, MAX_TRIAGE_CHANGES),
        budget: DAILY_BUDGET,
    };
}

/**
 * Turn the triage model's verdict into a bounded pursuit, or into silence.
 *
 * PURE, and it is the guard rail on the model: the model says what is material, this
 * function decides what that is allowed to cost. A verdict naming four questions still
 * produces at most one pursuit, and a verdict naming a question that is not in the
 * candidate set produces none at all — the model cannot invent work.
 *
 * @param {Object}   verdict     { material: [{ question_id, why, queries? }], ... }
 * @param {Object[]} candidates  from planDailyWork
 */
export function planPursuit(verdict, candidates = [], { budget = DAILY_BUDGET } = {}) {
    const none = (reason) => ({ pursue: false, reason, questionId: null, queries: [], budget });

    const material = Array.isArray(verdict?.material) ? verdict.material : [];
    if (material.length === 0) {
        // The model looked and concluded nothing here clears the bar. That is a real
        // outcome and it is recorded as one, not as a failure.
        return none(verdict?.summary || 'Looked at what moved. None of it changes the read.');
    }

    const byId = new Map(candidates.map(c => [c.questionId, c]));

    // Candidates arrive ranked; honouring that order means the model's ordering cannot
    // quietly outrank the founder's pins and sensitivities. The slice is where
    // MAX_PURSUITS_PER_DAY is actually enforced: a verdict naming four material questions
    // still produces one Read.
    const [chosen] = candidates
        .filter(c => material.some(m => m?.question_id === c.questionId))
        .slice(0, MAX_PURSUITS_PER_DAY);
    if (!chosen) {
        return none('Looked at what moved. Nothing tied back to an open question.');
    }

    const named = material.find(m => m.question_id === chosen.questionId);

    // Queries: the model may propose, but the question's own stored watch_queries come
    // first — they were written when the question was framed, with the whole brief in view.
    const proposed = Array.isArray(named?.queries) ? named.queries : [];
    const queries = [...(byId.get(chosen.questionId)?.watchQueries || []), ...proposed]
        .map(q => String(q || '').trim())
        .filter(Boolean)
        // Templates whose variable never resolved must drop, not emit quoted emptiness —
        // the lesson that produced `"" review complaints OR switching away 2026`.
        .filter(q => !/^["']?\s*["']?$/.test(q))
        .filter((q, i, all) => all.indexOf(q) === i)
        .slice(0, budget.maxQueries);

    if (queries.length === 0) {
        return none('Something moved, but there is no search that would settle it.');
    }

    return {
        pursue: true,
        reason: named?.why || 'This bears on an open question.',
        questionId: chosen.questionId,
        queries,
        budget,
    };
}
