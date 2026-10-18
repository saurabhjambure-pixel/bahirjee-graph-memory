/**
 * A decision you can come back to.
 *
 * `decision_briefs` has existed since v19, describes itself as holding "durable identities
 * that can be revisited with fresh evidence", and has never had a read path. This is that
 * read path, plus the write that makes a revisit worth anything.
 *
 * ── The loop this closes ─────────────────────────────────────────────────────
 * A decision session ends by putting its load-bearing assumptions on the Agenda. The daily
 * loop then watches them like any other open question, and months later the founder hears:
 * "You chose the enterprise motion in March, assuming mid-market churn stayed under 4%.
 * That just moved."
 *
 * That sentence is the whole product thesis in one line, and it is only true if three
 * things were recorded at the time: WHAT was chosen, WHAT it assumed, and WHEN. Not what
 * Bahirjee leaned toward — what the founder actually did. A lean is not a decision, and
 * treating one as the other would make every follow-up a small lie told at exactly the
 * moment someone is relying on it.
 *
 * ── Evidence assembly ────────────────────────────────────────────────────────
 * `assembleInternalEvidence` looks at what is already known before anything is fetched.
 * Most of it is sitting in the last report. Re-searching the web for what is already on
 * file is the same waste the Agenda was built to end, one layer up.
 *
 * See scripts/migrations/v36_decision_sessions.sql and scripts/decision-session.test.mjs.
 */

import { supabase } from '../lib/supabase.js';
import { openQuestion } from './agendaService.js';
import { harvestDecisionAssumptions } from './decisionBrief.js';
import { FRAMEWORK_IDS } from './decisionFrameworks.js';

/** Every column the row mapper reads. Keep in step with `mapSession`. */
export const SESSION_COLUMNS = [
    'id', 'client_id', 'created_by', 'raw_input', 'decision_frame', 'latest_report_id',
    'answers', 'framework', 'judgment', 'chosen_option_id', 'decided_at', 'target_domain',
    'created_at', 'updated_at',
].join(', ');

function mapSession(row) {
    if (!row) return null;
    return {
        id: row.id,
        clientId: row.client_id,
        createdBy: row.created_by,
        rawInput: row.raw_input,
        frame: row.decision_frame || {},
        latestReportId: row.latest_report_id,
        answers: row.answers || {},
        framework: row.framework,
        judgment: row.judgment && Object.keys(row.judgment).length ? row.judgment : null,
        chosenOptionId: row.chosen_option_id,
        decidedAt: row.decided_at,
        targetDomain: row.target_domain,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** The label a founder would recognise, for an option id. */
export function optionLabel(frame, optionId) {
    if (!optionId) return null;
    const hit = (frame?.options || []).find(o => o?.id === optionId);
    return hit?.label || null;
}

// ─── Reading ────────────────────────────────────────────────────────────────

/** Decisions for one company, most recently touched first. */
export async function listDecisions(clientId, targetDomain, { limit = 20 } = {}) {
    if (!supabase || !clientId) return [];
    try {
        let q = supabase
            .from('decision_briefs')
            .select(SESSION_COLUMNS)
            .eq('client_id', clientId)
            .order('updated_at', { ascending: false })
            .limit(limit);
        // Older rows predate target_domain and carry NULL. Excluding them would hide every
        // decision made before v30 from the screen built to revisit decisions.
        if (targetDomain) q = q.or(`target_domain.eq.${targetDomain},target_domain.is.null`);

        const { data, error } = await q;
        if (error) throw error;
        return (data || []).map(mapSession);
    } catch (err) {
        console.error('[decisions] list failed:', err.message);
        return [];
    }
}

export async function getDecision(id) {
    if (!supabase || !id) return null;
    try {
        const { data, error } = await supabase
            .from('decision_briefs').select(SESSION_COLUMNS).eq('id', id).maybeSingle();
        if (error) throw error;
        return mapSession(data);
    } catch (err) {
        console.error('[decisions] get failed:', err.message);
        return null;
    }
}

// ─── Writing ────────────────────────────────────────────────────────────────

/**
 * Start (or re-frame) a decision.
 *
 * Returns the session, or null. Never throws into a screen a founder is sitting in front of.
 */
export async function startDecision({ clientId, createdBy, rawInput, frame, targetDomain }) {
    if (!supabase || !clientId || !createdBy) return null;
    try {
        const { data, error } = await supabase
            .from('decision_briefs')
            .insert({
                client_id: clientId,
                created_by: createdBy,
                raw_input: String(rawInput || '').slice(0, 6000),
                decision_frame: frame || {},
                target_domain: targetDomain || null,
            })
            .select(SESSION_COLUMNS)
            .single();
        if (error) throw error;
        return mapSession(data);
    } catch (err) {
        console.error('[decisions] start failed:', err.message);
        return null;
    }
}

/**
 * Record the answers and the lens they selected.
 *
 * The framework is STORED rather than re-derived on read. Re-running the router months
 * later, against a frame that may since have been edited, would silently reinterpret a
 * decision that was already made — and the founder would have no way to see it happen.
 */
export async function saveRouting(id, { answers, framework }) {
    if (!FRAMEWORK_IDS.includes(framework)) {
        console.warn(`[decisions] refusing unknown framework "${framework}" — add it to the v30 CHECK first`);
        return null;
    }
    return patch(id, { answers: answers || {}, framework });
}

/**
 * Save the judgment and put its assumptions on the Agenda.
 *
 * The Agenda write is deliberately NOT transactional with the judgment save, and the order
 * matters: the judgment is saved first and its success is what the caller is told about. A
 * founder who just sat through a session must not lose it because a watch item failed to
 * open — the judgment is the thing they came for, and the watching is the bonus that
 * compounds later.
 */
export async function saveJudgment(id, judgment, { clientId, targetDomain, createdBy } = {}) {
    const saved = await patch(id, { judgment: judgment || {}, framework: judgment?.framework?.id || null });
    if (!saved) return null;

    if (clientId && targetDomain) {
        const assumptions = harvestDecisionAssumptions(judgment);
        let opened = 0;
        for (const a of assumptions) {
            // openQuestion refuses to resurrect anything the founder retired, so a decision
            // cannot force back a question they have already dismissed.
            if (await openQuestion({ ...a, clientId, targetDomain, createdBy })) opened += 1;
        }
        if (assumptions.length) {
            console.log(`[decisions] ${opened}/${assumptions.length} assumption(s) now on the agenda for ${targetDomain}`);
        }
    }
    return saved;
}

/**
 * Record what the founder actually chose.
 *
 * `null` clears it — a decision can be un-made, and a founder who mis-clicked should not be
 * stuck with a commitment on their record. The v30 CHECK keeps the choice and its date in
 * step, so both move together or neither does.
 */
export async function recordChoice(id, chosenOptionId) {
    return patch(id, {
        chosen_option_id: chosenOptionId || null,
        decided_at: chosenOptionId ? new Date().toISOString() : null,
    });
}

async function patch(id, fields) {
    if (!supabase || !id) return null;
    try {
        const { data, error } = await supabase
            .from('decision_briefs')
            .update({ ...fields, updated_at: new Date().toISOString() })
            .eq('id', id)
            .select(SESSION_COLUMNS)
            .single();
        if (error) throw error;
        return mapSession(data);
    } catch (err) {
        // 42703 = column missing (v30 not applied). Say which migration, rather than
        // letting it read as a permissions problem.
        if (err?.code === '42703') {
            console.error('[decisions] v36_decision_sessions.sql has not been applied');
        } else {
            console.error('[decisions] save failed:', err.message);
        }
        return null;
    }
}

// ─── Evidence ───────────────────────────────────────────────────────────────

/**
 * What is already known, before anything is fetched.
 *
 * PURE — it is handed the rows rather than fetching them, so what counts as internal
 * evidence is testable without a database.
 *
 * Returns `{ internal, covered, gaps }`. `gaps` are the frame's own sub-questions and
 * unresolved questions that nothing on file speaks to; those are what a search should be
 * spent on, and nothing else. Re-searching the web for what is already in the last report
 * is the same waste the Agenda exists to end, one layer up — and it is worse here, because
 * the founder is waiting.
 *
 * Matching is deliberately crude (shared significant words). A false "covered" costs one
 * unasked question; a false "gap" costs a search. Neither is severe, and a cheap rule that
 * a reader can predict beats a clever one that surprises them.
 */
export function assembleInternalEvidence({ frame, signals = [], cards = [], agenda = [], docChunks = [] } = {}) {
    // A destructuring default fires on `undefined` but NOT on `null`, and a frame that
    // failed to build arrives as null rather than absent.
    const f = frame && typeof frame === 'object' ? frame : {};
    const internal = {
        signals: (signals || []).slice(0, 40),
        cards: (cards || []).filter(c => c?.status === 'active').slice(0, 8),
        // An open question about this decision is evidence of a kind: it says Bahirjee has
        // already been wondering the same thing.
        agenda: (agenda || []).filter(q => q?.status === 'open').slice(0, 6),
        docChunks: (docChunks || []).slice(0, 6),
    };

    const haystack = [
        ...internal.signals.map(s => `${s.signal_headline || ''} ${s.the_move || ''}`),
        ...internal.cards.map(c => c.title || ''),
        ...internal.docChunks.map(c => String(c.content || c).slice(0, 800)),
    ].join(' ').toLowerCase();

    const questions = [
        ...(f.sub_questions || []),
        ...(f.unresolved_questions || []),
    ].map(q => String(q || '').trim()).filter(Boolean);

    const STOP = new Set(['what', 'which', 'does', 'will', 'their', 'there', 'about', 'would', 'could', 'should', 'this', 'that', 'with', 'from', 'have', 'been', 'into']);
    const covered = [];
    const gaps = [];
    for (const q of questions) {
        // NAMED THINGS MUST ACTUALLY APPEAR.
        //
        // Word counting alone gets this wrong in the one case that matters. "Does hospital
        // procurement in Kerala favour incumbent maternal health vendors?" matched 5 of its
        // 8 significant words against a report that said "hospital procurement favours
        // incumbents" — while missing Kerala and maternal, the two words carrying the whole
        // question. Generic overlap outvoted the distinguishing terms.
        //
        // So: if the founder named something specific, nothing on file counts as answering
        // them unless it mentions that thing. Capitalisation is a crude proxy for a proper
        // noun, and the first word is skipped because every sentence starts capitalised.
        const named = (q.match(/(?!^)\b[A-Z][a-zA-Z]{2,}/g) || []).map(w => w.toLowerCase());
        if (named.length && named.some(w => !haystack.includes(w))) {
            gaps.push(q);
            continue;
        }

        const words = q.toLowerCase().match(/[a-z]{4,}/g) || [];
        const significant = words.filter(w => !STOP.has(w));
        const hits = significant.filter(w => haystack.includes(w)).length;
        // 60% of the significant words, and never fewer than two.
        //
        // Half was too loose: "what does a Kerala tender cycle require?" was read as covered
        // by a report mentioning "cycle" and "tenders" in an unrelated sentence, because two
        // of four generic words matched while the one that mattered — Kerala — did not. The
        // bar rises with the length of the question, which is right: a longer question is
        // more specific and needs more of itself present before it counts as answered.
        //
        // THE BIAS IS DELIBERATE. A false gap costs one search. A false "covered" means a
        // question the founder asked is never looked into, and nothing anywhere says so.
        // When in doubt, search.
        const needed = Math.max(2, Math.ceil(significant.length * 0.6));
        (significant.length >= 2 && hits >= needed ? covered : gaps).push(q);
    }

    return {
        internal,
        covered,
        gaps,
        hasInternal: internal.signals.length > 0 || internal.cards.length > 0 || internal.docChunks.length > 0,
    };
}

/**
 * What Bahirjee says out loud about the division of labour, before it goes to work.
 *
 * Third person: this is chrome describing what Bahirjee is doing, not Bahirjee's own read.
 * Every number traces to something counted — a claim that cannot be backed is dropped
 * rather than softened, the same rule the heartbeat follows.
 */
export function describeEvidencePlan({ internal, covered, gaps }) {
    const parts = [];
    const n = (internal?.signals?.length || 0) + (internal?.cards?.length || 0);
    if (n > 0) parts.push(`${n} thing${n === 1 ? '' : 's'} already on file`);
    if (covered?.length) parts.push(`${covered.length} of your questions answerable from it`);
    if (gaps?.length) parts.push(`${gaps.length} that need looking up`);
    return parts.length ? `${parts.join(', ')}.` : '';
}
