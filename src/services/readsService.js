/**
 * Reads and the daily check ledger.
 *
 * A Read is the new unit of value: ONE dated thing Bahirjee noticed, what it means, and
 * what it does not settle. It replaces "a fifteen-minute run produces one large report"
 * as the thing a founder actually receives day to day. The weekly brief still happens —
 * it becomes the periodic synthesis over the Reads, not the only thing that ever occurs.
 *
 * The check ledger is smaller and just as load-bearing. The Desk's heartbeat says
 * "I read 19 pages this morning. Nothing moved." A quiet app reads as a broken app unless
 * the founder can see it was awake — and that sentence must be TRUE. letterService already
 * refuses to claim pages-read because the telemetry to back it did not exist
 * (see its proof-of-work note: "not claimed here"). This table is that telemetry.
 *
 * See scripts/migrations/v34_agenda.sql.
 */

import { supabase } from '../lib/supabase.js';

/** Every column the Read mapper reads. Keep in step with `mapRead`. */
export const READ_COLUMNS = [
    'id', 'client_id', 'target_domain', 'question_id', 'run_id', 'headline',
    'what_moved', 'what_it_means', 'what_it_does_not_settle', 'source_class',
    'evidence', 'confidence', 'delivered_at', 'created_at',
].join(', ');

/** Every column the check mapper reads. Keep in step with `mapCheck`. */
export const CHECK_COLUMNS = [
    'id', 'client_id', 'target_domain', 'checked_on', 'pages_checked',
    'pages_changed', 'triaged', 'pursued', 'read_id', 'note', 'created_at',
].join(', ');

function mapRead(row) {
    if (!row) return null;
    return {
        id: row.id,
        clientId: row.client_id,
        targetDomain: row.target_domain,
        questionId: row.question_id,
        runId: row.run_id,
        headline: row.headline,
        whatMoved: row.what_moved,
        whatItMeans: row.what_it_means,
        whatItDoesNotSettle: row.what_it_does_not_settle,
        sourceClass: row.source_class,
        evidence: Array.isArray(row.evidence) ? row.evidence : [],
        confidence: row.confidence,
        deliveredAt: row.delivered_at,
        createdAt: row.created_at,
    };
}

function mapCheck(row) {
    if (!row) return null;
    return {
        id: row.id,
        clientId: row.client_id,
        targetDomain: row.target_domain,
        checkedOn: row.checked_on,
        pagesChecked: row.pages_checked ?? 0,
        pagesChanged: row.pages_changed ?? 0,
        triaged: !!row.triaged,
        pursued: !!row.pursued,
        readId: row.read_id,
        note: row.note,
        createdAt: row.created_at,
    };
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * Persist one Read.
 *
 * `confidence` is passed through rather than computed here, because the brief's confidence
 * is COMPUTED from evidence count and domain diversity (briefSchema) and a Read must use
 * the same basis rather than inventing a second scale. A Read built on one source is
 * `Low`, and saying so is the product.
 */
export async function createRead({
    clientId, targetDomain, questionId = null, runId = null, headline,
    whatMoved, whatItMeans = null, whatItDoesNotSettle = null,
    sourceClass = null, evidence = [], confidence = null,
}) {
    if (!supabase || !clientId || !targetDomain) return null;
    if (!headline || !whatMoved) {
        // A Read with no factual line is an opinion. Refuse it rather than publish it.
        console.warn('[reads] refusing a Read with no headline or no factual line');
        return null;
    }
    try {
        const { data, error } = await supabase
            .from('reads')
            .insert({
                client_id: clientId,
                target_domain: targetDomain,
                question_id: questionId,
                run_id: runId,
                headline,
                what_moved: whatMoved,
                what_it_means: whatItMeans,
                what_it_does_not_settle: whatItDoesNotSettle,
                source_class: sourceClass,
                evidence,
                confidence,
            })
            .select(READ_COLUMNS)
            .single();
        if (error) throw error;
        return mapRead(data);
    } catch (err) {
        console.error('[reads] create failed:', err.message);
        return null;
    }
}

/** The Stream. Newest first. Returns [] rather than throwing — the Desk still renders. */
export async function listReads(clientId, targetDomain, { limit = 30 } = {}) {
    if (!supabase || !clientId || !targetDomain) return [];
    try {
        const { data, error } = await supabase
            .from('reads')
            .select(READ_COLUMNS)
            .eq('client_id', clientId)
            .eq('target_domain', targetDomain)
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) throw error;
        return (data || []).map(mapRead);
    } catch (err) {
        console.error('[reads] list failed:', err.message);
        return [];
    }
}

// ─── The check ledger ───────────────────────────────────────────────────────

/** UTC date key for a firing. The cron runs at 06:00 UTC; the day is the UTC day. */
export function checkDateKey(now = new Date()) {
    return new Date(now).toISOString().slice(0, 10);
}

/**
 * Record this morning's reading, exactly once per company per day.
 *
 * The unique index on (client_id, target_domain, checked_on) is what makes a re-fired
 * cron a no-op rather than a double spend — the same discipline as
 * completeIntelligenceJob's compare-and-set. `claimDailyCheck` below is the read half:
 * call it BEFORE spending anything.
 */
export async function recordDailyCheck({
    clientId, targetDomain, checkedOn = checkDateKey(), pagesChecked = 0,
    pagesChanged = 0, triaged = false, pursued = false, readId = null, note = null,
}) {
    if (!supabase || !clientId || !targetDomain) return null;
    try {
        const { data, error } = await supabase
            .from('daily_checks')
            .upsert({
                client_id: clientId,
                target_domain: targetDomain,
                checked_on: checkedOn,
                pages_checked: pagesChecked,
                pages_changed: pagesChanged,
                triaged,
                pursued,
                read_id: readId,
                note,
            }, { onConflict: 'client_id,target_domain,checked_on' })
            .select(CHECK_COLUMNS)
            .single();
        if (error) throw error;
        return mapCheck(data);
    } catch (err) {
        console.error('[reads] recordDailyCheck failed:', err.message);
        return null;
    }
}

/**
 * Has this company already been read today?
 *
 * Called before any spend. A cron that fires twice — a retry, a manual trigger, a platform
 * hiccup — must cost nothing the second time. Returns the existing check, or null.
 */
export async function todaysCheck(clientId, targetDomain, checkedOn = checkDateKey()) {
    if (!supabase || !clientId || !targetDomain) return null;
    try {
        const { data, error } = await supabase
            .from('daily_checks')
            .select(CHECK_COLUMNS)
            .eq('client_id', clientId)
            .eq('target_domain', targetDomain)
            .eq('checked_on', checkedOn)
            .maybeSingle();
        if (error) throw error;
        return mapCheck(data);
    } catch (err) {
        console.error('[reads] todaysCheck failed:', err.message);
        return null;
    }
}

/** Recent mornings, newest first — what the heartbeat is built from. */
export async function listRecentChecks(clientId, targetDomain, { limit = 14 } = {}) {
    if (!supabase || !clientId || !targetDomain) return [];
    try {
        const { data, error } = await supabase
            .from('daily_checks')
            .select(CHECK_COLUMNS)
            .eq('client_id', clientId)
            .eq('target_domain', targetDomain)
            .order('checked_on', { ascending: false })
            .limit(limit);
        if (error) throw error;
        return (data || []).map(mapCheck);
    } catch (err) {
        console.error('[reads] listRecentChecks failed:', err.message);
        return [];
    }
}

/**
 * The heartbeat sentence, derived from the ledger and nothing else.
 *
 * PURE. Every claim here is backed by a recorded number; a claim that cannot be backed is
 * DROPPED, not softened. Same rule as recognition.js — a gap beats a guess — and the same
 * reason letterService refuses to claim pages-read it did not measure.
 *
 * Third person: this is interface chrome, and chrome speaks ABOUT Bahirjee. Bahirjee
 * speaks in the first person inside a Read and inside the letter.
 */
export function describeLastCheck(check) {
    if (!check) return '';
    const parts = [];
    if (check.pagesChecked > 0) {
        parts.push(`Bahirjee read ${check.pagesChecked} page${check.pagesChecked === 1 ? '' : 's'}`);
        parts.push(check.pagesChanged > 0
            ? `${check.pagesChanged} changed`
            : 'nothing moved');
    } else if (check.note) {
        // No pages read is still a morning that happened. The note says why.
        return check.note;
    } else {
        return '';
    }
    return `${parts.join(' · ')}.`;
}
