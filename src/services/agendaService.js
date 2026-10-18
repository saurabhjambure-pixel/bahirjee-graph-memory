/**
 * The Agenda — what Bahirjee is currently trying to find out.
 *
 * Every run already produces the object a standing agent needs and then throws it away:
 * `brief.what_could_change_our_view[].watch_for` is a concrete, founder-facing observable
 * that would overturn Bahirjee's read, at least two per brief, enforced by a BLOCKING
 * policy gate (briefPolicy B3). At the end of the run it is discarded. So is
 * `_startupContext.strategic_assumptions` (verdict recomputed from zero each run),
 * `brief.unknowns`, and the founder's own intake question.
 *
 * With nothing carried forward, a run can only start over — which is why every run
 * re-derives the same 22 templated queries that vary only by {year}.
 *
 * This module makes that uncertainty persistent, so a run becomes a PURSUIT of what is
 * still open rather than a regeneration of everything.
 *
 * TWO RULES CARRY THE WEIGHT:
 *
 *   1. THE AGENDA MUST BE ABLE TO SHRINK. tracked_entities is the cautionary tale — it is
 *      append-only, `is_active` is only ever written TRUE, no path retires a row, and its
 *      priority is a hardcoded constant that never learns. A competitor the founder
 *      deleted on the review screen is still being watched months later. Here: answered
 *      closes, the founder can retire, and sustained irrelevance retires automatically.
 *
 *   2. A RETIRED QUESTION STAYS RETIRED. A weekly run regenerates near-identical
 *      falsifiers. Without this, retiring one would last exactly seven days. Same
 *      discipline as `_userEdits.removed`, which stepMemory refuses to override.
 *
 * The writer, the reader and the columns are pinned together in scripts/agenda.test.mjs —
 * a field the mapper reads that the query never selected reads back as `undefined` and
 * throws nothing. That exact shape cost this codebase `source_class` for months.
 *
 * See scripts/migrations/v34_agenda.sql.
 */

import { supabase } from '../lib/supabase.js';
import { CONTRADICTION_WATCH_FOR } from './briefSchema.js';

/**
 * Mirrors the CHECK constraints in v34_agenda.sql. The test reads BOTH this file and the
 * migration and fails if they drift.
 *
 * v25 is why: `tracked_entities.category` was frozen at five values while the code emitted
 * eight, Postgres rejected every row, and storeEntityWatchlist counted the error and
 * returned normally — so an uploaded deck contributed nothing to the watchlist for months.
 * Nothing threw. The report was just quietly worse.
 */
export const AGENDA_ORIGINS = ['falsifier', 'assumption', 'unknown', 'founder', 'shift', 'decision'];
export const AGENDA_STATUSES = ['open', 'answered', 'retired', 'stale'];
export const AGENDA_SENSITIVITIES = ['high', 'medium', 'low'];

/** Every column the row mapper below is allowed to read. Keep in step with `mapRow`. */
export const AGENDA_COLUMNS = [
    'id', 'client_id', 'target_domain', 'question_key', 'question', 'watch_for',
    'origin', 'origin_ref', 'watch_urls', 'watch_queries', 'status', 'sensitivity',
    'useful_count', 'irrelevant_count', 'pinned', 'opened_at', 'last_checked_at',
    'last_moved_at', 'answered_at', 'retired_at', 'answer_summary',
    'answered_by_read_id', 'created_by', 'updated_at',
].join(', ');

/** Sustained irrelevance retires a question. Three strikes, and only if it never landed. */
export const IRRELEVANT_STRIKES_TO_RETIRE = 3;

/** The Desk shows a working set, not a backlog. */
export const AGENDA_DISPLAY_LIMIT = 6;

// ─── Identity ───────────────────────────────────────────────────────────────

/**
 * A stable key for "the same question", so a weekly run that regenerates a near-identical
 * falsifier updates one row instead of minting a new one every Monday.
 *
 * Deliberately a normalised slug rather than a hash: a hash is opaque, and when two
 * questions collide — or fail to — you want to be able to read the key and see why.
 * Pure; safe in the browser and the worker.
 */
export function questionKey(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[‘’“”]/g, "'")   // smart quotes fold to plain
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean)
        .join('-')
        .slice(0, 180);
}

// ─── Priority ───────────────────────────────────────────────────────────────

const ORIGIN_WEIGHT = {
    founder: 3.0,     // they asked for it by name
    decision: 2.5,    // an assumption a decision rests on
    falsifier: 2.0,   // what would overturn the current read
    assumption: 2.0,  // a stated bet
    shift: 1.5,
    unknown: 1.0,
};

const SENSITIVITY_WEIGHT = { high: 3.0, medium: 2.0, low: 1.0 };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How much attention this question deserves today.
 *
 * A PURE FUNCTION of the row plus the clock, deliberately — priority is not a stored
 * column, so it cannot go stale relative to its own inputs, and it can be tested without
 * a database. Higher is more urgent.
 *
 * Staleness is measured from `last_moved_at` (falling back to `opened_at`), NEVER from
 * `last_checked_at`. A question the daily loop looks at every morning and never resolves
 * would otherwise read as permanently fresh — which is exactly backwards, because being
 * looked at daily without moving is what makes it interesting.
 */
export function computePriority(item, now = Date.now()) {
    if (!item || item.status !== 'open') return 0;

    // The founder's "push this up" outranks every computed input. If they have to argue
    // with a scoring function to get attention on something, the steering is fake.
    if (item.pinned) return 1000;

    const origin = ORIGIN_WEIGHT[item.origin] ?? 1.0;
    const sensitivity = SENSITIVITY_WEIGHT[item.sensitivity] ?? 1.5;

    // Feedback moves attention, not just wording. An irrelevant strike costs twice what a
    // useful one earns: the cost of boring a founder is higher than the cost of a miss
    // they can ask for directly.
    const feedback = (item.useful_count || 0) * 0.5 - (item.irrelevant_count || 0) * 1.0;

    const movedAt = Date.parse(item.last_moved_at || item.opened_at || '') || now;
    const daysSinceMoved = Math.max(0, (now - movedAt) / DAY_MS);
    // Capped: an ancient unanswered question should rise, but never outrank a high
    // sensitivity bet just by having sat there.
    const staleness = Math.min(daysSinceMoved / 14, 1.5);

    // Rotation damper — a question already looked at today steps aside so the loop walks
    // the whole Agenda over a few days instead of re-checking its favourite.
    const checkedAt = Date.parse(item.last_checked_at || '');
    const checkedToday = Number.isFinite(checkedAt) && (now - checkedAt) < DAY_MS;

    return origin + sensitivity + feedback + staleness - (checkedToday ? 1.0 : 0);
}

/** Open items, most urgent first. Pure — sorting is not the database's job here. */
export function rankAgenda(items, now = Date.now()) {
    return (items || [])
        .filter(i => i && i.status === 'open')
        .map(i => ({ ...i, priority: computePriority(i, now) }))
        .sort((a, b) => b.priority - a.priority);
}

// ─── Reading ────────────────────────────────────────────────────────────────

/**
 * One place that turns a row into the shape the rest of the code uses.
 *
 * Every field read here appears in AGENDA_COLUMNS. That pairing is the whole point: a
 * field consumed but never selected is `undefined`, and nothing throws.
 */
function mapRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        clientId: row.client_id,
        targetDomain: row.target_domain,
        questionKey: row.question_key,
        question: row.question,
        watchFor: row.watch_for,
        origin: row.origin,
        originRef: row.origin_ref,
        watchUrls: Array.isArray(row.watch_urls) ? row.watch_urls : [],
        watchQueries: Array.isArray(row.watch_queries) ? row.watch_queries : [],
        status: row.status,
        sensitivity: row.sensitivity,
        useful_count: row.useful_count ?? 0,
        irrelevant_count: row.irrelevant_count ?? 0,
        pinned: !!row.pinned,
        opened_at: row.opened_at,
        last_checked_at: row.last_checked_at,
        last_moved_at: row.last_moved_at,
        answered_at: row.answered_at,
        retired_at: row.retired_at,
        answerSummary: row.answer_summary,
        answeredByReadId: row.answered_by_read_id,
        createdBy: row.created_by,
        updatedAt: row.updated_at,
    };
}

/** The Agenda for one company. Returns [] rather than throwing — the Desk still renders. */
export async function listAgenda(clientId, targetDomain, { status = 'open', limit = 50 } = {}) {
    if (!supabase || !clientId || !targetDomain) return [];
    try {
        let q = supabase
            .from('open_questions')
            .select(AGENDA_COLUMNS)
            .eq('client_id', clientId)
            .eq('target_domain', targetDomain)
            .order('last_checked_at', { ascending: true, nullsFirst: true })
            .limit(limit);
        if (status) q = q.eq('status', status);

        const { data, error } = await q;
        if (error) throw error;
        return (data || []).map(mapRow);
    } catch (err) {
        console.error('[agenda] list failed:', err.message);
        return [];
    }
}

// ─── Writing ────────────────────────────────────────────────────────────────

/**
 * Open a question, or refresh one that is already open.
 *
 * THE RESURRECTION GUARD IS THE POINT. A run regenerates near-identical falsifiers every
 * week; without this, a question the founder retired would be back within seven days and
 * they would learn that the retire button is decorative. So the upsert is done as an
 * explicit read-then-write rather than a blind `upsert`: a blind one cannot see that the
 * row it is about to overwrite was retired on purpose.
 *
 * Returns the mapped row, or null when the question was refused (retired) or the write
 * failed. Never throws into a pipeline step.
 */
export async function openQuestion({
    clientId, targetDomain, question, watchFor = null, origin = 'falsifier',
    originRef = null, watchUrls = [], watchQueries = [], sensitivity = null, createdBy = null,
}) {
    if (!supabase || !clientId || !targetDomain) return null;

    const text = String(question || '').trim();
    if (!text) return null;
    if (!AGENDA_ORIGINS.includes(origin)) {
        console.warn(`[agenda] refusing unknown origin "${origin}" — add it to the v28 CHECK first`);
        return null;
    }

    const key = questionKey(text);
    if (!key) return null;

    try {
        const { data: existing, error: readErr } = await supabase
            .from('open_questions')
            .select(AGENDA_COLUMNS)
            .eq('client_id', clientId)
            .eq('target_domain', targetDomain)
            .eq('question_key', key)
            .maybeSingle();
        if (readErr) throw readErr;

        if (existing) {
            // Retired or answered by a human decision. Leave it alone and say so.
            if (existing.status === 'retired') {
                console.log(`[agenda] not re-opening retired question: ${key}`);
                return null;
            }
            // Already open: refresh where to look, but never overwrite the founder's own
            // wording with a model's paraphrase of the same question.
            const patch = {
                watch_for: watchFor || existing.watch_for,
                watch_urls: watchUrls.length ? watchUrls : existing.watch_urls,
                watch_queries: watchQueries.length ? watchQueries : existing.watch_queries,
                sensitivity: sensitivity || existing.sensitivity,
                status: 'open',
                updated_at: new Date().toISOString(),
            };
            const { data, error } = await supabase
                .from('open_questions')
                .update(patch)
                .eq('id', existing.id)
                .select(AGENDA_COLUMNS)
                .single();
            if (error) throw error;
            return mapRow(data);
        }

        const { data, error } = await supabase
            .from('open_questions')
            .insert({
                client_id: clientId,
                target_domain: targetDomain,
                question_key: key,
                question: text,
                watch_for: watchFor,
                origin,
                origin_ref: originRef,
                watch_urls: watchUrls,
                watch_queries: watchQueries,
                sensitivity,
                created_by: createdBy,
            })
            .select(AGENDA_COLUMNS)
            .single();
        if (error) throw error;
        return mapRow(data);
    } catch (err) {
        console.error('[agenda] open failed:', err.message);
        return null;
    }
}

/** The loop looked at these, whatever it concluded. Cheap, and it drives the rotation. */
export async function markChecked(ids) {
    if (!supabase || !ids?.length) return 0;
    try {
        const { error } = await supabase
            .from('open_questions')
            .update({ last_checked_at: new Date().toISOString() })
            .in('id', ids);
        if (error) throw error;
        return ids.length;
    } catch (err) {
        console.error('[agenda] markChecked failed:', err.message);
        return 0;
    }
}

/** Evidence actually moved this question. Distinct from merely checking it. */
export async function markMoved(id) {
    return patchQuestion(id, {
        last_moved_at: new Date().toISOString(),
        last_checked_at: new Date().toISOString(),
    });
}

/** Closed by evidence. The Read that closed it is the receipt. */
export async function answerQuestion(id, { summary = null, readId = null } = {}) {
    return patchQuestion(id, {
        status: 'answered',
        answered_at: new Date().toISOString(),
        answer_summary: summary,
        answered_by_read_id: readId,
    });
}

/** Closed by the founder, or by sustained irrelevance. Never re-opened by a run. */
export async function retireQuestion(id) {
    return patchQuestion(id, { status: 'retired', retired_at: new Date().toISOString() });
}

/** The founder's "push this up". */
export async function pinQuestion(id, pinned = true) {
    return patchQuestion(id, { pinned: !!pinned });
}

/**
 * Founder feedback on a Read, applied to the question that Read served.
 *
 * This is the loop that does not exist today: the thumbs currently write `impact_events`,
 * which become a {boost, suppress} list injected into a PROMPT as prose, while
 * `_signalWeights` — the ten numbers that actually decide what gets searched — are a pure
 * function of the onboarding form and never move. Here, feedback changes what Bahirjee
 * looks at.
 *
 * Three irrelevant strikes with nothing useful ever landed retires the question outright.
 * A question that has landed at least once keeps its place, however noisy it has been
 * since — the founder already told us it can be worth hearing from.
 */
export async function recordFeedback(id, verdict) {
    if (!supabase || !id) return null;
    if (verdict !== 'useful' && verdict !== 'irrelevant') return null;
    try {
        const { data: row, error: readErr } = await supabase
            .from('open_questions')
            .select(AGENDA_COLUMNS)
            .eq('id', id)
            .maybeSingle();
        if (readErr) throw readErr;
        if (!row) return null;

        const useful = (row.useful_count || 0) + (verdict === 'useful' ? 1 : 0);
        const irrelevant = (row.irrelevant_count || 0) + (verdict === 'irrelevant' ? 1 : 0);
        const shouldRetire = useful === 0 && irrelevant >= IRRELEVANT_STRIKES_TO_RETIRE;

        return patchQuestion(id, {
            useful_count: useful,
            irrelevant_count: irrelevant,
            ...(shouldRetire ? { status: 'retired', retired_at: new Date().toISOString() } : {}),
        });
    } catch (err) {
        console.error('[agenda] recordFeedback failed:', err.message);
        return null;
    }
}

async function patchQuestion(id, patch) {
    if (!supabase || !id) return null;
    try {
        const { data, error } = await supabase
            .from('open_questions')
            .update({ ...patch, updated_at: new Date().toISOString() })
            .eq('id', id)
            .select(AGENDA_COLUMNS)
            .single();
        if (error) throw error;
        return mapRow(data);
    } catch (err) {
        console.error('[agenda] patch failed:', err.message);
        return null;
    }
}

// ─── Harvesting a finished run ──────────────────────────────────────────────

/**
 * Everything in a finished brief that is worth still being curious about.
 *
 * PURE — takes a brief and a context, returns the questions to open. No database, so the
 * extraction rules are testable on a fixture, and the caller decides when to write.
 *
 * The three sources are already generated on every run and already discarded:
 *   • what_could_change_our_view[] — the falsifiers. Gate B3 requires at least two, so
 *     there is always something here on a brief that passed.
 *   • strategic_assumptions[]      — the founder's stated bets, with their own sensitivity.
 *   • unknowns[]                   — what the run could not settle.
 */
export function harvestQuestions(brief, context = {}, { reportId = null } = {}) {
    const out = [];
    const seen = new Set();

    const push = (item) => {
        const key = questionKey(item.question);
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push(item);
    };

    for (const f of brief?.what_could_change_our_view || []) {
        const text = String(f?.text || '').trim();
        if (!text) continue;
        // A falsifier derived from `context.contradictions` is a disagreement between two
        // of OUR OWN sources — "Tracxn says 26 employees, LinkedIn says 51-200" — not
        // something that could change in the world. Standing watch over it is wasted: no
        // number of daily page-diffs resolves a citation conflict, the question can never
        // be answered so it never leaves the Agenda, and at six displayed items these
        // crowd out the strategic falsifiers that are the whole point. Measured on the
        // real backfill: 4 of caremother.in's 6 and 2 of hginsights.com's 3 were these.
        //
        // They still belong in the BRIEF, where a reader can weigh them once. Filtering on
        // the exported provenance marker rather than on wording, because "inconsistent"
        // appearing in a sentence is a guess and the stamp is a fact.
        if (f?.watch_for === CONTRADICTION_WATCH_FOR) continue;
        push({
            question: text,
            // `watch_for` is already exactly this shape — the concrete observable. It is
            // not paraphrased here, because the model wrote it for a founder to read.
            watchFor: f.watch_for || null,
            origin: 'falsifier',
            originRef: reportId,
            watchUrls: f.source_url ? [f.source_url] : [],
        });
    }

    for (const a of context?._startupContext?.strategic_assumptions || []) {
        const statement = String(a?.statement || '').trim();
        if (!statement) continue;
        push({
            question: `Is this still true: ${statement}`,
            watchFor: null,
            origin: 'assumption',
            originRef: statement,
            sensitivity: AGENDA_SENSITIVITIES.includes(a.sensitivity) ? a.sensitivity : null,
        });
    }

    for (const u of brief?.unknowns || []) {
        const text = typeof u === 'string' ? u : String(u?.text || '');
        if (!text.trim()) continue;
        push({ question: text.trim(), origin: 'unknown', originRef: reportId });
    }

    return out;
}
