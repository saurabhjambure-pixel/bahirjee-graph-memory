import { supabase } from '../lib/supabase';

const ASK_LIMIT = 3;
const NOTE_LIMIT = 3;

/**
 * Insert an interaction log row into the `interactions` table.
 * Returns { data, error }.
 */
async function _insertInteraction(reportId, userId, interactionType, content = '') {
    const { data, error } = await supabase
        .from('interactions')
        .insert({ report_id: reportId, user_id: userId, interaction_type: interactionType, content })
        .select()
        .single();
    return { data, error };
}

/**
 * Count how many of a given interaction type a user has already submitted for a report.
 * Used to enforce soft limits on the client (hard limits are also enforced via the policy check).
 */
export async function getInteractionCount(reportId, userId, interactionType) {
    if (!supabase || !reportId || !userId) return 0;

    const { count, error } = await supabase
        .from('interactions')
        .select('id', { count: 'exact', head: true })
        .eq('report_id', reportId)
        .eq('user_id', userId)
        .eq('interaction_type', interactionType);

    if (error) {
        console.error('[InteractionService] Count error:', error);
        return 0;
    }
    return count ?? 0;
}

/**
 * Attempt to log a "question" interaction. Enforces the ASK_LIMIT unless bypassed.
 * @param {Object} options
 * @param {boolean} options.bypassLimit - Used for premium users and admin flows.
 * @returns {{ allowed: boolean, remaining: number, error?: string }}
 */
export async function trackQuestion(reportId, userId, content, options = {}) {
    if (!supabase) return { allowed: false, remaining: 0, error: 'Supabase unavailable' };
    const { bypassLimit = false } = options;

    const current = await getInteractionCount(reportId, userId, 'question');
    if (!bypassLimit && current >= ASK_LIMIT) {
        return { allowed: false, remaining: 0, error: 'limit_reached' };
    }

    const { data, error } = await _insertInteraction(reportId, userId, 'question', content);
    if (error) return { allowed: false, remaining: ASK_LIMIT - current, error: error.message };

    return {
        allowed: true,
        remaining: bypassLimit ? Number.POSITIVE_INFINITY : ASK_LIMIT - current - 1,
        interactionId: data?.id || null
    };
}

/**
 * Attach the generated answer to a previously-logged question row, so the Q&A
 * history persists instead of living only in transient React state.
 * Non-blocking — a failure here must not break the answer already shown to the user.
 */
export async function saveQuestionAnswer(interactionId, answer) {
    if (!supabase || !interactionId || !answer) return { error: null };
    const { error } = await supabase
        .from('interactions')
        .update({ answer: String(answer) })
        .eq('id', interactionId);
    if (error) console.error('[InteractionService] saveQuestionAnswer error:', error);
    return { error };
}

/**
 * Attempt to log a "note" interaction. Enforces the NOTE_LIMIT unless bypassed.
 * @param {Object} options
 * @param {boolean} options.bypassLimit - Used for premium users and admin flows.
 * @returns {{ allowed: boolean, remaining: number, error?: string }}
 */
export async function trackNote(reportId, userId, content, options = {}) {
    if (!supabase) return { allowed: false, remaining: 0, error: 'Supabase unavailable' };
    const { bypassLimit = false } = options;

    const current = await getInteractionCount(reportId, userId, 'note');
    if (!bypassLimit && current >= NOTE_LIMIT) {
        return { allowed: false, remaining: 0, error: 'limit_reached' };
    }

    const { error } = await _insertInteraction(reportId, userId, 'note', content);
    if (error) return { allowed: false, remaining: NOTE_LIMIT - current, error: error.message };

    return { allowed: true, remaining: bypassLimit ? Number.POSITIVE_INFINITY : NOTE_LIMIT - current - 1 };
}

/**
 * Log a "conversion_click" event when a free user hits an upgrade gate.
 * Non-blocking — we don't enforce limits for this type.
 */
export async function trackConversionClick(reportId, userId, gateName) {
    if (!supabase || !reportId || !userId) return;
    await _insertInteraction(reportId, userId, 'conversion_click', gateName).catch(() => {});
}

/**
 * Fetch all interactions for a report (admin view).
 * Returns { data: [], error }
 */
export async function getInteractionsForReport(reportId) {
    const { data, error } = await supabase
        .from('interactions')
        .select('*')
        .eq('report_id', reportId)
        .order('created_at', { ascending: false });
    return { data: data ?? [], error };
}

/**
 * Fetch aggregated engagement summary for admin dashboard.
 * Returns per-report stats: viewer count, question count, note count, conversion clicks.
 */
export async function getEngagementSummary() {
    const { data, error } = await supabase
        .from('interactions')
        .select('report_id, interaction_type, user_id');

    if (error || !data) return { data: [], error };

    const byReport = {};
    for (const row of data) {
        if (!byReport[row.report_id]) {
            byReport[row.report_id] = { report_id: row.report_id, viewers: new Set(), questions: 0, notes: 0, conversionClicks: 0 };
        }
        byReport[row.report_id].viewers.add(row.user_id);
        if (row.interaction_type === 'question') byReport[row.report_id].questions++;
        if (row.interaction_type === 'note') byReport[row.report_id].notes++;
        if (row.interaction_type === 'conversion_click') byReport[row.report_id].conversionClicks++;
    }

    const summary = Object.values(byReport).map(r => ({
        ...r,
        viewers: r.viewers.size,
    }));

    return { data: summary, error: null };
}
