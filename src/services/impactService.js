/**
 * Impact Service — Bahirjee v6.0 Phase 7
 * 
 * Silently tracks user interactions with intelligence findings.
 * No visible scoring to users — this data refines future analysis.
 * 
 * Tracked events: react_shift, follow_up, regenerate, edit_context,
 *                 thumbs_up, thumbs_down, fire, insight, dismiss
 */

import { supabase } from '../lib/supabase.js';

/**
 * Record a user impact event.
 * 
 * @param {Object} params
 * @param {string} params.companyId - Client UUID
 * @param {string} params.userId - User UUID
 * @param {string} params.eventType - One of the allowed event types
 * @param {string} [params.shiftId] - Optional: linked shift UUID
 * @param {Object} [params.metadata] - Optional: extra context (theme, question text, etc.)
 * @returns {boolean} Success status
 */
export async function recordImpactEvent({ companyId, userId, eventType, shiftId = null, metadata = {} }) {
    if (!supabase) {
        console.warn('[ImpactService] Supabase not configured.');
        return false;
    }

    if (!companyId || !userId || !eventType) {
        console.warn('[ImpactService] Missing required params.');
        return false;
    }

    try {
        const { error } = await supabase
            .from('impact_events')
            .insert({
                company_id: companyId,
                user_id: userId,
                shift_id: shiftId,
                event_type: eventType,
                metadata
            });

        if (error) {
            console.error('[ImpactService] Insert error:', error.message);
            return false;
        }

        console.log(`[ImpactService] ✅ Event recorded: ${eventType}`);
        return true;
    } catch (err) {
        console.error('[ImpactService] Unexpected error:', err);
        return false;
    }
}

/**
 * Get impact summary for a company (for internal analytics, not user-facing).
 * 
 * @param {string} companyId - Client UUID
 * @param {number} days - Rolling window in days
 * @returns {Object} Summary of event counts by type
 */
export async function getImpactSummary(companyId, days = 30) {
    if (!supabase || !companyId) return { total: 0, byType: {} };

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const { data, error } = await supabase
        .from('impact_events')
        .select('event_type')
        .eq('company_id', companyId)
        .gte('created_at', cutoff.toISOString());

    if (error || !data) return { total: 0, byType: {} };

    const byType = {};
    for (const event of data) {
        byType[event.event_type] = (byType[event.event_type] || 0) + 1;
    }

    return { total: data.length, byType };
}

const BOOST_EVENTS = new Set(['thumbs_up', 'fire', 'insight']);
const SUPPRESS_EVENTS = new Set(['thumbs_down', 'dismiss']);

/**
 * Derive founder reaction preferences from impact_events so emoji reactions on
 * insights/signals become a real prioritization signal for the next run.
 * Returns short text lists of themes the founder boosted vs. de-prioritized.
 * @param {string} companyId - Client UUID
 * @param {number} days - Rolling window
 * @returns {{ boost: string[], suppress: string[] }}
 */
export async function getReactionPreferences(companyId, days = 90) {
    if (!supabase || !companyId) return { boost: [], suppress: [] };

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const { data, error } = await supabase
        .from('impact_events')
        .select('event_type, metadata, created_at')
        .eq('company_id', companyId)
        .gte('created_at', cutoff.toISOString())
        .order('created_at', { ascending: false })
        .limit(100);

    if (error || !data) return { boost: [], suppress: [] };

    const boost = [];
    const suppress = [];
    for (const ev of data) {
        const text = (ev.metadata?.text || ev.metadata?.theme || '').toString().trim();
        if (!text) continue;
        if (BOOST_EVENTS.has(ev.event_type) && boost.length < 8) boost.push(text.slice(0, 200));
        else if (SUPPRESS_EVENTS.has(ev.event_type) && suppress.length < 8) suppress.push(text.slice(0, 200));
    }
    return { boost: [...new Set(boost)], suppress: [...new Set(suppress)] };
}
