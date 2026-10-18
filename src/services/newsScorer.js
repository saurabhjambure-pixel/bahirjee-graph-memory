/**
 * News Scorer — Bahirjee Context Building Layer
 * 
 * Scores structured signals for "News That Matters" display.
 * 
 * Exposure_Relevance_Score = 
 *   Dependency_Proximity × Signal_Weight × Credibility_Score × 
 *   Exposure_Weight × Signal_Strength
 * 
 * Display rules:
 *   - Only show if score ≥ DISPLAY_THRESHOLD
 *   - Max 5 items
 *
 * With JEV_NEWS=on, rankNews() re-ranks the candidates above the threshold by how material
 * Jev judges each one to the company, before the cap — see its note.
 */

import { supabase } from '../lib/supabase.js';

// Calibrated to the score the formula can actually produce. The score multiplies proximity,
// credibility (0.7 for secondary sources, i.e. nearly all of them), exposure weight (~0.5)
// and the magnitude weight TWICE, so a typical anchor lands at 0.02–0.10. At the old 0.15
// the section was empty on every run since it was first saved (v29): the three most recent
// runs peaked at 0.094, 0.070 and 0.102. The cap of MAX_NEWS_ITEMS, not this floor, is what
// keeps the section short; this only drops signals whose exposure to the company is
// negligible.
export const DISPLAY_THRESHOLD = 0.04;
export const MAX_NEWS_ITEMS = 5;
// How many above-threshold candidates Jev may re-rank. More than the cap, or re-ranking
// could only ever reorder the five the formula already chose.
export const MAX_NEWS_CANDIDATES = 20;

/**
 * Score signals and generate news items.
 * 
 * @param {Object} params
 * @param {Array} params.signals - Structured signals
 * @param {Array} params.entities - Tracked entities
 * @param {Object} params.exposureWeights - { capital, demand, cost, distribution, regulation, talent }
 * @returns {Array} Scored news items (sorted, filtered by threshold)
 */
export function scoreAndFilterNews({ signals, entities, exposureWeights, limit = MAX_NEWS_ITEMS }) {
    const scoredItems = [];
    const ew = exposureWeights || {};

    for (const signal of signals) {
        // ── Only a current anchor may become news ───────────────────────────
        // This is the gate the old freshness downgrade never was. Before it, every
        // structured signal was scored — including ones already tagged as background —
        // so a 2024 article could take a "News That Matters" slot, stamped with today's
        // date because the transformer had given it a fresh timestamp.
        //
        // Note the shape of the test: an EXPLICIT anchor role is required. A legacy row
        // written before v27 has temporal_role null, and treating unknown as current
        // would reintroduce the bug across the entire existing corpus. Those rows are
        // still stored, still readable, still in the report — just not on this surface.
        //
        // This filters a SURFACE. Nothing here deletes anything.
        if (signal.temporal_role !== 'anchor') continue;

        const depProximity = computeDependencyProximity(signal, entities);
        const signalWeight = (signal.magnitude_score || 5) / 10;
        const credibility = signal.source_type === 'primary' ? 1.0 : 0.7;
        const exposureWeight = ew[signal.domain] || 0.5;
        const signalStrength = signalWeight;

        const score = Math.round(
            depProximity * signalWeight * credibility * exposureWeight * signalStrength * 10000
        ) / 10000;

        if (score >= DISPLAY_THRESHOLD) {
            scoredItems.push({
                signal,
                exposure_relevance_score: score,
                headline: signal.raw_headline || 'Signal detected',
                linked_entity: signal.entity_name,
                domain: signal.domain,
                signal_type: signal.event_type,
                source_url: signal.source_url,
                source: extractSourceName(signal.source_url),
                // The anchor's own date, distinct from `timestamp` (ingestion). A news
                // card renders this — never the crawl time.
                event_date: signal.event_date || null,
                temporal_role: signal.temporal_role,
                // Older sources shown behind the item as labelled context.
                supporting_evidence: Array.isArray(signal.supporting_evidence) ? signal.supporting_evidence : [],
                timestamp: signal.timestamp
            });
        }
    }

    // Sort by score descending, cap at `limit`
    scoredItems.sort((a, b) => b.exposure_relevance_score - a.exposure_relevance_score);
    return scoredItems.slice(0, limit);
}

/**
 * The items the report shows, from the formula's candidates.
 *
 * `relevance[i]` is Jev's materiality for candidates[i] (0 = unrelated … 1 = directly
 * material), or null where Jev gave no answer. Passed only when JEV_NEWS=on. Then a
 * candidate Jev calls unrelated is dropped, and the rest rank by formula × (0.5 + relevance)
 * — so an unanswered item (neutral, 0.5) keeps exactly its formula score, and Jev can move an
 * item at most 1.5× either way rather than overrule the exposure model outright. Without
 * relevance this is the formula's own top `limit`.
 */
export function rankNews(candidates, { relevance = null, limit = MAX_NEWS_ITEMS } = {}) {
    const list = Array.isArray(candidates) ? candidates : [];
    if (!Array.isArray(relevance)) return list.slice(0, limit);
    const neutral = (f) => (typeof f === 'number' && Number.isFinite(f) ? f : 0.5);
    return list
        .map((item, i) => ({ item, i, f: relevance[i] }))
        .filter(x => x.f !== 0)
        .map(x => ({ ...x, rank: x.item.exposure_relevance_score * (0.5 + neutral(x.f)) }))
        .sort((a, b) => b.rank - a.rank || a.i - b.i)
        .slice(0, limit)
        .map(({ item, f }) => (typeof f === 'number' ? { ...item, jev_relevance: Math.round(f * 100) / 100 } : item));
}

/** The formula score as the band the report shows. */
export function relevanceBand(score) {
    const s = Number(score) || 0;
    return s >= 0.4 ? 'high' : s >= 0.25 ? 'medium' : 'low';
}

/**
 * The shape a news item is saved and rendered in. Drops the embedded structured signal
 * (it duplicates `signals` and would bloat every report row); keeps what the section shows.
 */
export function compactNewsItem(item) {
    return {
        headline: item?.headline || 'Signal detected',
        source: item?.source || null,
        source_url: item?.source_url || null,
        linked_entity: item?.linked_entity || null,
        domain: item?.domain || null,
        signal_type: item?.signal_type || null,
        exposure_relevance_score: item?.exposure_relevance_score ?? null,
        relevance: relevanceBand(item?.exposure_relevance_score),
        ...(typeof item?.jev_relevance === 'number' ? { jev_relevance: item.jev_relevance } : {}),
        timestamp: item?.timestamp || null,
    };
}

/**
 * Compute dependency proximity for a signal.
 * Direct dependencies score highest, competitors next, then generic.
 */
function computeDependencyProximity(signal, entities) {
    const entityName = signal.entity_name?.toLowerCase();
    if (!entityName) return 0.3;

    const matchedEntity = entities.find(e =>
        e.name.toLowerCase() === entityName ||
        entityName.includes(e.name.toLowerCase())
    );

    if (!matchedEntity) return 0.3; // No entity match

    // Proximity scores by category
    const scores = {
        'infra': 1.0,       // Direct dependency — highest impact
        'platform': 0.85,   // Platform dependency
        'competitor': 0.7,  // Competitive intelligence
        'regulator': 0.8,   // Regulatory bodies
        'industry_body': 0.5
    };

    return scores[matchedEntity.category] || 0.4;
}

// NOTE: the 3-line news-summary LLM prompt (buildNewsLinesPrompt/attachNewsLines) was
// removed — it fed only the orphaned NewsThatMatters component, costing LLM calls per run
// for text no surface rendered. Scoring and persistence below are still live consumers.

/**
 * Store news items to Supabase.
 */
export async function storeNewsItems(companyId, newsItems) {
    if (!supabase || !companyId || !newsItems?.length) return { stored: 0, errors: 0 };

    const rows = newsItems.map(item => ({
        company_id: companyId,
        signal_id: item.signal?.id || null,
        headline: item.headline,
        source: item.source,
        source_url: item.source_url,
        linked_entity: item.linked_entity,
        domain: item.domain,
        signal_type: item.signal_type,
        exposure_relevance_score: item.exposure_relevance_score,
        line_1_fact: item.line_1_fact || item.headline,
        line_2_economic: item.line_2_economic || '',
        line_3_startup: item.line_3_startup || '',
        decay_factor: 1.0,
        is_visible: true,
        // ── temporal provenance (v27) ───────────────────────────────────────
        // The anchor's own event date. Only anchors reach this table, so a row with a
        // null event_date here is a legacy row, never a current one we failed to date.
        event_date: item.event_date || null,
        temporal_role: item.temporal_role || null,
        // Older sources shown behind this item as labelled context, never as news.
        supporting_evidence: item.supporting_evidence || []
    }));

    const TEMPORAL_COLUMNS = ['event_date', 'temporal_role', 'supporting_evidence'];

    try {
        let { error } = await supabase
            .from('news_items')
            .insert(rows);

        // v27 tolerance: a database without the temporal columns still stores its news.
        // PostgREST rejects the whole batch on one unknown column, so without this the
        // entire news surface would disappear on a database one migration behind.
        if (error?.code === 'PGRST204' && new RegExp(TEMPORAL_COLUMNS.join('|'), 'i').test(error.message || '')) {
            console.warn('[NewsScorer] temporal columns unavailable (run v27_temporal_evidence.sql); storing without them.');
            const stripped = rows.map(({ event_date, temporal_role, supporting_evidence, ...rest }) => rest);
            ({ error } = await supabase.from('news_items').insert(stripped));
        }

        if (error) {
            console.error('[NewsScorer] Store error:', error.message);
            return { stored: 0, errors: rows.length };
        }

        console.log(`[NewsScorer] ✅ ${rows.length} news items stored`);
        return { stored: rows.length, errors: 0 };
    } catch (err) {
        console.error('[NewsScorer] Unexpected error:', err);
        return { stored: 0, errors: rows.length };
    }
}

/**
 * Extract source name from URL.
 */
function extractSourceName(url) {
    if (!url) return 'Unknown';
    try {
        const hostname = new URL(url).hostname;
        return hostname.replace(/^www\./, '').split('.').slice(0, -1).join('.');
    } catch {
        return 'Unknown';
    }
}
