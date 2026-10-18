/**
 * Structured Signal Transformer — Bahirjee Context Building Layer
 * 
 * Transforms raw observations + Gemini-analyzed signals into structured signal objects.
 * 
 * Signal {
 *   entity, event_type, domain, magnitude_score,
 *   replication_flag, timestamp, source_type
 * }
 */

import { supabase } from '../lib/supabase.js';

// Domain classification keywords
const DOMAIN_KEYWORDS = {
    demand: ['revenue', 'sales', 'growth', 'market share', 'customer acquisition', 'churn', 'buyer', 'demand', 'pipeline', 'conversion', 'retention'],
    cost: ['pricing', 'cost', 'expense', 'infrastructure', 'cloud spend', 'unit economics', 'margin', 'burn rate', 'opex'],
    capital: ['funding', 'investment', 'valuation', 'ipo', 'acquisition', 'merger', 'capital', 'raise', 'series', 'venture'],
    distribution: ['partnership', 'channel', 'platform', 'marketplace', 'integration', 'distribution', 'launch', 'app store', 'market expansion'],
    regulation: ['regulation', 'compliance', 'policy', 'government', 'legal', 'gdpr', 'hipaa', 'audit', 'mandate', 'ban', 'ruling'],
    talent: ['hiring', 'layoff', 'talent', 'workforce', 'executive', 'cto', 'ceo', 'team', 'engineer', 'recruitment', 'resignation']
};

// Event type classifiers
const EVENT_TYPES = {
    'pricing_change': ['pricing', 'price increase', 'price cut', 'new tier', 'free tier'],
    'product_launch': ['launch', 'release', 'new product', 'new feature', 'beta'],
    'product_shutdown': ['shutdown', 'deprecate', 'sunset', 'discontinue', 'end of life'],
    'funding_event': ['funding', 'raised', 'series', 'investment', 'ipo', 'valuation'],
    'acquisition': ['acquired', 'acquisition', 'merger', 'acqui-hire', 'buyout'],
    'leadership_change': ['ceo', 'cto', 'appointed', 'resigned', 'departed', 'hired', 'joins'],
    'hiring_shift': ['hiring', 'layoff', 'workforce reduction', 'expanding team'],
    'regulatory_action': ['regulation', 'fine', 'compliance', 'ruling', 'mandate', 'ban'],
    'partnership': ['partnership', 'collaboration', 'alliance', 'integration', 'joint venture'],
    'market_move': ['expansion', 'entering', 'market share', 'competitive', 'pivoting']
};

/**
 * Transform Gemini signals + observations into structured signal objects.
 * 
 * @param {Object} params
 * @param {Array} params.geminiSignals - Signals from Gemini analysis
 * @param {Array} params.entities - Tracked entities
 * @param {Object} params.signalWeights - Signal category weights
 * @param {string} params.runId - Current pipeline run ID
 * @returns {Array} Structured Signal objects
 */
export function transformToStructuredSignals({
    geminiSignals = [],
    entities = [],
    signalWeights = {},
    runId = null
}) {
    const structuredSignals = [];
    const entityNameMap = buildEntityNameMap(entities);

    for (const signal of geminiSignals) {
        const headline = signal.signal_headline || signal.headline || '';
        const details = signal.the_move || signal.signal_details || '';
        const fullText = `${headline} ${details}`.toLowerCase();

        // 1. Match to tracked entity
        const matchedEntity = matchEntity(fullText, entityNameMap);

        // 2. Classify domain
        const domain = classifyDomain(fullText);

        // 3. Classify event type
        const eventType = classifyEventType(fullText);

        // 4. Compute magnitude score
        const relevanceScore = parseFloat(signal.relevance_score) || 5;
        const categoryWeight = getCategoryWeight(eventType, signalWeights);
        const magnitudeScore = Math.round(
            (relevanceScore / 10) * categoryWeight * 10 * 100
        ) / 100;

        // 5. Determine source type
        const sourceType = isFromPrimarySource(signal.source_url, entities) ? 'primary' : 'secondary';

        structuredSignals.push({
            entity_name: matchedEntity?.name || signal.entity_involved || extractEntityFromHeadline(headline),
            entity_id: matchedEntity?.id || null,
            event_type: eventType,
            domain,
            magnitude_score: Math.min(magnitudeScore, 10),
            replication_flag: false, // Set by checking previous runs
            source_type: sourceType,
            source_url: signal.source_url || null,
            // Deterministic corroboration from the dedup merge — other grounded outlets
            // that reported the same event (see deduplicateSignals in intelligenceService).
            corroborating_urls: Array.isArray(signal.corroborating_urls) ? signal.corroborating_urls : [],
            raw_headline: headline,
            raw_details: details,
            run_id: runId,
            // ── temporal provenance ─────────────────────────────────────────
            // Carried through from the classified signal rather than re-derived. This
            // block used to not exist: `timestamp` below was the only date a structured
            // signal had, and it was a fresh clock read — so every signal, whatever its
            // source's age, arrived at the news surface dated today.
            event_date: signal.event_date || null,
            published_date: signal.published_date || null,
            temporal_role: signal.temporal_role || null,
            date_confidence: signal.date_confidence || null,
            supporting_evidence: Array.isArray(signal.supporting_evidence) ? signal.supporting_evidence : [],
            // Ingestion time, named for what it is. `timestamp` keeps the old name and
            // the old meaning so existing readers are unaffected.
            retrieved_at: signal.retrieved_at || new Date().toISOString(),
            timestamp: new Date().toISOString()
        });
    }

    // Check replication flags across this batch
    markReplicationFlags(structuredSignals);

    console.log(`[SignalTransformer] Transformed ${structuredSignals.length} structured signals`);
    return structuredSignals;
}

/**
 * Build entity name lookup map for fast matching.
 */
function buildEntityNameMap(entities) {
    const map = new Map();
    for (const entity of entities) {
        const key = entity.name.toLowerCase().trim();
        map.set(key, entity);
        // Also add short versions (e.g., "Amazon Web Services" → "aws")
        const words = key.split(/\s+/);
        if (words.length > 1) {
            map.set(words[0], entity);
        }
    }
    return map;
}

/**
 * Match text against tracked entities.
 */
function matchEntity(text, entityNameMap) {
    for (const [key, entity] of entityNameMap.entries()) {
        if (key.length >= 3 && text.includes(key)) {
            return entity;
        }
    }
    return null;
}

/**
 * Classify signal domain based on text content.
 */
function classifyDomain(text) {
    let bestDomain = 'demand';
    let bestScore = 0;

    for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
        let score = 0;
        for (const kw of keywords) {
            if (text.includes(kw)) score++;
        }
        if (score > bestScore) {
            bestScore = score;
            bestDomain = domain;
        }
    }

    return bestDomain;
}

/**
 * Classify event type based on text content.
 */
function classifyEventType(text) {
    for (const [eventType, keywords] of Object.entries(EVENT_TYPES)) {
        for (const kw of keywords) {
            if (text.includes(kw)) return eventType;
        }
    }
    return 'market_move';
}

/**
 * Map event type to signal weight category.
 */
function getCategoryWeight(eventType, signalWeights) {
    const mapping = {
        'pricing_change': signalWeights.pricing_changes,
        'product_launch': signalWeights.market_expansion,
        'product_shutdown': signalWeights.product_removals,
        'funding_event': signalWeights.funding_shifts,
        'acquisition': signalWeights.funding_shifts,
        'leadership_change': signalWeights.talent_migration,
        'hiring_shift': signalWeights.hiring_shifts,
        'regulatory_action': signalWeights.regulatory_updates,
        'partnership': signalWeights.competitive_moves,
        'market_move': signalWeights.competitive_moves
    };
    return mapping[eventType] || 0.5;
}

/**
 * Check if a source URL is a primary source (i.e., matches a tracked entity's known URLs).
 */
function isFromPrimarySource(sourceUrl, entities) {
    if (!sourceUrl) return false;
    try {
        const hostname = new URL(sourceUrl).hostname.toLowerCase();
        return entities.some(e => {
            const entityUrl = e.metadata?.url;
            if (!entityUrl) return false;
            try {
                return new URL(entityUrl).hostname.toLowerCase() === hostname;
            } catch {
                return entityUrl.toLowerCase().includes(hostname);
            }
        });
    } catch {
        return false;
    }
}

/**
 * Extract entity name from headline as fallback.
 */
function extractEntityFromHeadline(headline) {
    if (!headline) return 'Unknown';
    // Take the first capitalized word(s) as likely entity
    const match = headline.match(/^([A-Z][a-zA-Z]*(?:\s[A-Z][a-zA-Z]*)*)/);
    return match ? match[1] : headline.split(' ').slice(0, 2).join(' ');
}

/**
 * Mark replication flags for signals with same entity + event_type in the batch.
 */
function markReplicationFlags(signals) {
    const seen = new Map();
    for (const signal of signals) {
        const key = `${signal.entity_name?.toLowerCase()}_${signal.event_type}`;
        if (seen.has(key)) {
            signal.replication_flag = true;
            seen.get(key).replication_flag = true;
        } else {
            seen.set(key, signal);
        }
    }
}

/**
 * Store structured signals to Supabase.
 */
export async function storeStructuredSignals(companyId, runId, signals) {
    if (!supabase || !companyId || !signals?.length) {
        console.warn('[SignalTransformer] Missing params — not stored.');
        return { stored: 0, errors: 0 };
    }

    const rows = signals.map(s => ({
        company_id: companyId,
        run_id: runId,
        entity_id: s.entity_id,
        entity_name: s.entity_name,
        event_type: s.event_type,
        domain: s.domain,
        magnitude_score: s.magnitude_score,
        replication_flag: s.replication_flag,
        source_type: s.source_type,
        source_url: s.source_url,
        corroborating_urls: s.corroborating_urls || [],
        raw_headline: s.raw_headline,
        raw_details: s.raw_details,
        // ── temporal provenance (v27) ───────────────────────────────────────
        // `timestamp` below is ingestion time and always has been. These three say when
        // the thing actually HAPPENED, which nothing persisted before: a signal's only
        // date was the clock read at transform time, so a 2024 article stored today was
        // indistinguishable from an event that happened today.
        event_date: s.event_date || null,
        published_date: s.published_date || null,
        retrieved_at: s.retrieved_at || s.timestamp || null,
        temporal_role: s.temporal_role || null,
        date_confidence: s.date_confidence || null,
        supporting_evidence: s.supporting_evidence || [],
        timestamp: s.timestamp
    }));

    // Insert in batches
    const BATCH_SIZE = 25;
    let stored = 0;
    let errors = 0;

    // Migration tolerance: if the DB predates v17 (corroborating_urls column), retry the
    // batch without that column instead of failing every insert.
    let hasCorroboratingUrls = true;
    // Same for the v27 temporal columns. A database that has not run v27 must still be
    // able to store signals — losing the temporal fields degrades the surfaces, but
    // losing the whole batch loses the run.
    let hasTemporalColumns = true;

    const TEMPORAL_COLUMNS = [
        'event_date', 'published_date', 'retrieved_at',
        'temporal_role', 'date_confidence', 'supporting_evidence',
    ];
    const stripTemporal = (row) => {
        const out = { ...row };
        for (const col of TEMPORAL_COLUMNS) delete out[col];
        return out;
    };

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        let batch = rows.slice(i, i + BATCH_SIZE);
        if (!hasCorroboratingUrls) batch = batch.map(({ corroborating_urls, ...rest }) => rest);
        if (!hasTemporalColumns) batch = batch.map(stripTemporal);
        try {
            let { error } = await supabase
                .from('structured_signals')
                .insert(batch);

            if (error?.code === 'PGRST204' && /corroborating_urls/i.test(error.message || '')) {
                console.warn('[SignalTransformer] corroborating_urls column unavailable; retrying without it.');
                hasCorroboratingUrls = false;
                batch = batch.map(({ corroborating_urls, ...rest }) => rest);
                ({ error } = await supabase.from('structured_signals').insert(batch));
            }

            if (error?.code === 'PGRST204' && new RegExp(TEMPORAL_COLUMNS.join('|'), 'i').test(error.message || '')) {
                console.warn('[SignalTransformer] temporal columns unavailable (run v27_temporal_evidence.sql); retrying without them.');
                hasTemporalColumns = false;
                batch = batch.map(stripTemporal);
                ({ error } = await supabase.from('structured_signals').insert(batch));
            }

            if (error) {
                console.error('[SignalTransformer] Batch insert error:', error.message);
                errors += batch.length;
            } else {
                stored += batch.length;
            }
        } catch (err) {
            console.error('[SignalTransformer] Unexpected error:', err);
            errors += batch.length;
        }
    }

    console.log(`[SignalTransformer] ✅ ${stored} signals stored, ${errors} errors`);
    return { stored, errors };
}

/**
 * Fetch live signals for a running job to progressively render them.
 */
export async function getLiveSignals(runId) {
    if (!supabase || !runId) return [];
    try {
        const { data, error } = await supabase
            .from('structured_signals')
            .select('*')
            .eq('run_id', runId)
            .order('timestamp', { ascending: false });
        if (error) {
            console.error('[SignalTransformer] Fetch live signals error:', error.message);
            return [];
        }
        return data || [];
    } catch (e) {
        console.error('[SignalTransformer] Fetch live signals unexpected error:', e);
        return [];
    }
}

/**
 * Check for replication against previous runs.
 */
export async function checkPreviousReplication(companyId, signals) {
    if (!supabase || !companyId || !signals?.length) return signals;

    try {
        const { data: previousSignals } = await supabase
            .from('structured_signals')
            .select('entity_name, event_type')
            .eq('company_id', companyId)
            .order('created_at', { ascending: false })
            .limit(200);

        if (!previousSignals?.length) return signals;

        const prevKeys = new Set(
            previousSignals.map(s => `${s.entity_name?.toLowerCase()}_${s.event_type}`)
        );

        for (const signal of signals) {
            const key = `${signal.entity_name?.toLowerCase()}_${signal.event_type}`;
            if (prevKeys.has(key)) {
                signal.replication_flag = true;
            }
        }
    } catch (err) {
        console.warn('[SignalTransformer] Replication check failed:', err.message);
    }

    return signals;
}
