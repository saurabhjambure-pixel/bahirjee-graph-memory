import { supabase } from '../lib/supabase.js';
import { getLastReportForUrl, updateReportMemory } from './reportService.js';
import { getReactionPreferences } from './impactService.js';

function normalizeText(value, limit = 120) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, limit);
}

function sectionFromSignal(signal) {
    return normalizeText(signal?.category || signal?.domain || signal?.section || 'signal');
}

function titleFromSignal(signal) {
    return signal?.signal_headline || signal?.headline || signal?.the_move || signal?.signal_details || 'Untitled signal';
}

function buildSignalCardKey(signal) {
    const section = sectionFromSignal(signal);
    const entity = normalizeText(signal?.entity_name || signal?.entity_involved || signal?.entity || '');
    const event = normalizeText(signal?.event_type || signal?.signal_type || signal?.category || '');
    const headline = normalizeText(titleFromSignal(signal), 80);

    if (entity && event) return `signal:${section}:${entity}:${event}`;
    if (headline) return `signal:${section}:${headline}`;
    return `signal:${section}:unknown`;
}

/**
 * A signal's entity name, keyed the same way tracked_entities/entityWatchlistGenerator.js
 * keys a name (lowercase + trim, no character stripping) — deliberately NOT normalizeText()
 * above, which strips punctuation and collapses spaces for the card_key hash and would
 * therefore miss a tracked_entities row keyed on the raw name.
 */
function signalEntityKey(signal) {
    return String(signal?.entity_name || signal?.entity_involved || signal?.entity || '').toLowerCase().trim();
}

/**
 * Map a company's active tracked entities by name, for resolving a signal card's entity_id
 * (v28 entity spine) without a second walk of dependency_map/competitive_map here — this
 * reads whatever entityWatchlistGenerator.storeEntityWatchlist has already persisted.
 *
 * Necessarily one run behind for a brand-new entity: on the run that FIRST discovers it,
 * tracked_entities has no row for it yet (storeEntityWatchlist runs later in stepPersist),
 * so its card gets entity_id: null this time — mergeExistingCard takes a fresh entity_id
 * from the incoming card on every run rather than preserving the old one, so the card
 * self-heals to the right id the moment the entity exists.
 */
async function fetchEntityIdsByName(companyId) {
    if (!supabase || !companyId) return new Map();
    const { data, error } = await supabase
        .from('tracked_entities')
        .select('id, name')
        .eq('company_id', companyId)
        .eq('is_active', true);
    if (error) {
        console.error('[CompanyMemory] Failed to fetch tracked entities for card linking:', error.message);
        return new Map();
    }
    return new Map((data || []).map(e => [String(e.name || '').toLowerCase().trim(), e.id]));
}

function buildInsightCardKey(insight, index) {
    const type = normalizeText(insight?.type || 'context');
    const text = normalizeText(insight?.text || '', 80);
    return `insight:${type}:${text || index}`;
}

function buildV6CardKey(kind, item) {
    const theme = normalizeText(item?.theme || item?.title || item?.shift_type || item?.opportunity_type || 'general');
    const subtype = normalizeText(item?.shift_type || item?.opportunity_type || kind || 'card');
    return `v6:${kind}:${subtype}:${theme}`;
}

function cardTrend(existing) {
    const count = Number(existing?.occurrence_count || 0);
    if (count <= 1) return 'new';
    if (count <= 2) return 'recurring';
    if (count <= 4) return 'strengthening';
    return 'recurring';
}

function sectionKeyForCard(cardType, rawSection) {
    const normalized = normalizeText(rawSection || cardType || 'memory');
    if (cardType === 'signal') return normalized || 'signals';
    if (cardType === 'shift') return 'shifts';
    if (cardType === 'blindspot') return 'blindspots';
    if (cardType === 'opportunity') return 'opportunities';
    return normalized || 'overview';
}

function buildMemoryCards(report, entityIdByName = null) {
    const cards = [];
    const insights = Array.isArray(report?.brief?.insights) ? report.brief.insights : [];
    const signals = Array.isArray(report?.signals) ? report.signals : [];
    const shifts = Array.isArray(report?.v6?.shifts) ? report.v6.shifts : [];
    const blindSpots = Array.isArray(report?.v6?.blindSpots) ? report.v6.blindSpots : [];
    const opportunities = Array.isArray(report?.v6?.opportunities) ? report.v6.opportunities : [];

    insights.forEach((insight, index) => {
        cards.push({
            card_key: buildInsightCardKey(insight, index),
            section_key: 'overview',
            card_type: 'intro',
            title: insight?.type ? `${String(insight.type).replace(/_/g, ' ')} insight` : `Insight ${index + 1}`,
            payload: insight,
            source_index: index
        });
    });

    signals.forEach((signal, index) => {
        cards.push({
            card_key: buildSignalCardKey(signal),
            section_key: sectionKeyForCard('signal', signal?.category || signal?.domain || 'signal'),
            card_type: 'signal',
            title: titleFromSignal(signal),
            payload: signal,
            source_index: index,
            source_url: signal?.source_url || null,
            entity_id: entityIdByName?.get(signalEntityKey(signal)) || null
        });
    });

    shifts.forEach((shift, index) => {
        cards.push({
            card_key: buildV6CardKey('shift', shift),
            section_key: 'shifts',
            card_type: 'shift',
            title: shift?.theme || `Shift ${index + 1}`,
            payload: shift,
            source_index: index
        });
    });

    blindSpots.forEach((blindSpot, index) => {
        cards.push({
            card_key: buildV6CardKey('blindspot', blindSpot),
            section_key: 'blindspots',
            card_type: 'blindspot',
            title: blindSpot?.theme || `Blind spot ${index + 1}`,
            payload: blindSpot,
            source_index: index
        });
    });

    opportunities.forEach((opportunity, index) => {
        cards.push({
            card_key: buildV6CardKey('opportunity', opportunity),
            section_key: 'opportunities',
            card_type: 'opportunity',
            title: opportunity?.theme || `Opportunity ${index + 1}`,
            payload: opportunity,
            source_index: index
        });
    });

    return cards;
}

function buildMemorySeedFromCards(cards) {
    const active = cards.filter(card => card.status === 'active');
    const recurring = active.filter(card => Number(card.occurrence_count || 0) > 1);
    const topSections = [...new Set(active.map(card => card.section_key))].slice(0, 8);

    return {
        active_card_count: active.length,
        recurring_card_count: recurring.length,
        top_sections: topSections,
        card_keys: active.slice(0, 20).map(card => card.card_key),
        recurring_cards: recurring.slice(0, 10).map(card => ({
            card_key: card.card_key,
            title: card.title,
            section_key: card.section_key,
            occurrence_count: card.occurrence_count,
            trend_state: card.trend_state
        }))
    };
}

function buildCardSummary(cards) {
    return cards.map(card => ({
        card_key: card.card_key,
        section_key: card.section_key,
        card_type: card.card_type,
        title: card.title,
        payload: card.payload,
        status: card.status,
        trend_state: card.trend_state,
        occurrence_count: card.occurrence_count,
        first_seen_report_id: card.first_seen_report_id || null,
        last_seen_report_id: card.last_seen_report_id || null,
        first_seen_at: card.first_seen_at || null,
        last_seen_at: card.last_seen_at || null,
        source_index: card.source_index ?? null,
        source_url: card.source_url || null,
        entity_id: card.entity_id ?? null
    }));
}

function mergeExistingCard(existing, incoming, reportId) {
    const occurrenceCount = Number(existing?.occurrence_count || 0) + 1;
    const firstSeenAt = existing?.first_seen_at || incoming?.seenAt || new Date().toISOString();
    return {
        company_id: incoming.company_id,
        card_key: incoming.card_key,
        section_key: incoming.section_key,
        card_type: incoming.card_type,
        title: incoming.title,
        payload: incoming.payload,
        source_index: incoming.source_index,
        source_url: incoming.source_url || existing?.source_url || null,
        // Fresh from `incoming` every run, never preserved from `existing` — a card that
        // started life before the entity had a tracked_entities row (entity_id: null)
        // self-heals to the right id the moment fetchEntityIdsByName can resolve it, instead
        // of staying null forever because the first-seen row's null was carried forward.
        entity_id: incoming.entity_id ?? null,
        status: 'active',
        trend_state: cardTrend(existing),
        occurrence_count: occurrenceCount,
        first_seen_report_id: existing?.first_seen_report_id || reportId,
        last_seen_report_id: reportId,
        first_seen_at: firstSeenAt,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
}

async function fetchExistingCards(companyId) {
    if (!supabase || !companyId) return [];

    const { data, error } = await supabase
        .from('brief_cards')
        .select('*')
        .eq('company_id', companyId);

    if (error) {
        console.error('[CompanyMemory] Failed to fetch brief cards:', error.message);
        return [];
    }

    return data || [];
}

// Founder-submitted notes ("Share a signal with Bahirjee") from the previous report.
// Loading these here is what makes the "considered on the next server-run" promise real:
// stepMemory injects them into context and the signal prompt references them.
async function fetchFounderNotes(reportId) {
    if (!supabase || !reportId) return [];
    const { data, error } = await supabase
        .from('interactions')
        .select('content, created_at')
        .eq('report_id', reportId)
        .eq('interaction_type', 'note')
        .order('created_at', { ascending: false })
        .limit(20);
    if (error) {
        console.error('[CompanyMemory] Failed to fetch founder notes:', error.message);
        return [];
    }
    return (data || []).map(r => r.content).filter(Boolean);
}

export async function loadCompanyMemory(companyId, websiteUrl) {
    if (!companyId) return null;

    // No separate startup_contexts read here any more. That table was a second writer for
    // the structured layer with an incompatible row shape (see v26's header) and, worse, a
    // STALE one — a snapshot from whichever run last confirmed, not necessarily this run's.
    // Every field it held is a pure function of the run's own context object
    // (company_dna / dependency_map / key_competitors / _onboardingData), which is already
    // in memory by the time stepMemory runs. intelligenceService.stepMemory now derives
    // _startupContext on demand via enrichContextWithOnboarding when a reused context
    // arrives without it — no query, and it can never drift from what this run is using.
    //
    // getLastReportForUrl returns { data, error } — unwrap to the row. Without this,
    // lastReport.signals/.card_summary/.context/.id are all undefined, which silently
    // disables incremental learning (always treated as a first run) and competitor
    // persistence across runs.
    const lastReport = websiteUrl
        // Distinguish a real query failure from "no prior report". Both still
        // resolve to null (the run proceeds as a first run), but a failure is
        // logged loudly so a transient DB/RLS error doesn't silently wipe
        // incremental learning without a trace.
        ? await getLastReportForUrl(companyId, websiteUrl)
            .then(r => {
                if (r?.error) {
                    console.error('[CompanyMemory] getLastReportForUrl returned an error — proceeding as first run (incremental learning disabled this run):', r.error.message || r.error);
                }
                return r?.data ?? null;
            })
            .catch(err => {
                console.error('[CompanyMemory] getLastReportForUrl threw — proceeding as first run (incremental learning disabled this run):', err?.message || err);
                return null;
            })
        : null;

    const founderNotes = lastReport?.id ? await fetchFounderNotes(lastReport.id).catch(() => []) : [];
    const reactionPreferences = await getReactionPreferences(companyId).catch(() => ({ boost: [], suppress: [] }));

    const state = await fetchCompanyMemoryState(companyId);
    const cards = await fetchExistingCards(companyId);
    const activeCards = cards.filter(card => card.status === 'active');
    const stateCards = Array.isArray(state?.current_cards) && state.current_cards.length
        ? state.current_cards
        : (Array.isArray(lastReport?.card_summary) ? lastReport.card_summary : []);
    const memorySeed = state?.memory_state || buildMemorySeedFromCards(activeCards);

    return {
        lastReport: lastReport || null,
        companyState: state || null,
        cards: activeCards,
        founderNotes,
        reactionPreferences,
        memorySeed,
        previousSignals: [
            ...(lastReport?.signals || []),
            ...((stateCards || [])
                .filter(item => item?.card_type === 'signal')
                .map(item => item.payload)
                .filter(Boolean))
        ],
        previousCards: (stateCards.length ? stateCards : activeCards).map(card => card.payload).filter(Boolean)
    };
}

async function fetchCompanyMemoryState(companyId) {
    if (!supabase || !companyId) return null;

    const { data, error } = await supabase
        .from('company_memory_state')
        .select('*')
        .eq('company_id', companyId)
        .maybeSingle();

    if (error) {
        console.error('[CompanyMemory] Failed to fetch company memory state:', error.message);
        return null;
    }

    return data || null;
}

export async function buildReportMemory({ companyId, reportId, report, basedOnReportId = null, contextVersionId = null }) {
    const [existingCards, entityIdByName] = await Promise.all([
        fetchExistingCards(companyId),
        fetchEntityIdsByName(companyId),
    ]);
    const existingByKey = new Map(existingCards.map(card => [card.card_key, card]));

    // Deduplicate by card_key — two signals can hash to the same key (identical entity+event+section).
    // Keep the last occurrence so the most-complete signal wins.
    const rawCardsInput = buildMemoryCards(report, entityIdByName).map(card => ({ ...card, company_id: companyId }));
    const dedupMap = new Map();
    for (const card of rawCardsInput) dedupMap.set(card.card_key, card);
    const currentCardsInput = [...dedupMap.values()];

    const currentKeys = new Set(currentCardsInput.map(card => card.card_key));

    // Phase 0 instrumentation — how well does the string-hash card_key recognise
    // recurrence across runs? A "near-miss" is a signal card whose full key missed but
    // whose entity segment (3rd `:`-delimited part) matches some existing card — i.e. the
    // same competitor tracked under a slightly different event/section string. High
    // near-miss counts are the quantified case for the entity-spine move.
    if (existingCards.length > 0) {
        const entitySeg = (k) => String(k || '').split(':')[2] || '';
        const existingEntitySegs = new Set(existingCards.map(c => entitySeg(c.card_key)).filter(Boolean));
        let hit = 0, miss = 0, nearMiss = 0;
        for (const card of currentCardsInput) {
            if (existingByKey.has(card.card_key)) { hit++; continue; }
            miss++;
            if (card.card_type === 'signal' && existingEntitySegs.has(entitySeg(card.card_key))) nearMiss++;
        }
        console.log(`[CardKey] company=${companyId} existing=${existingCards.length} current=${currentCardsInput.length} hit=${hit} miss=${miss} nearMiss=${nearMiss}`);
    }

    const currentCards = currentCardsInput.map(card => {
        const existing = existingByKey.get(card.card_key);
        return existing
            ? mergeExistingCard(existing, card, reportId)
            : {
                company_id: companyId,
                card_key: card.card_key,
                section_key: card.section_key,
                card_type: card.card_type,
                title: card.title,
                payload: card.payload,
                source_index: card.source_index,
                source_url: card.source_url || null,
                entity_id: card.entity_id ?? null,
                status: 'active',
                trend_state: 'new',
                occurrence_count: 1,
                first_seen_report_id: reportId,
                last_seen_report_id: reportId,
                first_seen_at: new Date().toISOString(),
                last_seen_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
    });

    const dormantCards = existingCards
        .filter(card => card.status === 'active' && !currentKeys.has(card.card_key))
        .map(card => ({
            ...card,
            status: 'dormant',
            trend_state: 'weakened',
            updated_at: new Date().toISOString(),
            last_seen_report_id: card.last_seen_report_id || null
        }));

    const allCards = [...currentCards, ...dormantCards];
    const activeCards = currentCards;
    const memorySeed = buildMemorySeedFromCards(activeCards);
    const memoryState = {
        active_card_count: activeCards.length,
        recurring_card_count: activeCards.filter(card => Number(card.occurrence_count || 0) > 1).length,
        dormant_card_count: dormantCards.length,
        top_sections: memorySeed.top_sections,
        based_on_report_id: basedOnReportId,
        context_version_id: contextVersionId,
        as_of: new Date().toISOString()
    };

    const currentBrief = {
        summary: report?.brief?.bahirjee_observation || report?.brief?.summary || null,
        insight_count: Array.isArray(report?.brief?.insights) ? report.brief.insights.length : 0,
        signal_count: Array.isArray(report?.signals) ? report.signals.length : 0,
        shift_count: Array.isArray(report?.v6?.shifts) ? report.v6.shifts.length : 0,
        blindspot_count: Array.isArray(report?.v6?.blindSpots) ? report.v6.blindSpots.length : 0,
        opportunity_count: Array.isArray(report?.v6?.opportunities) ? report.v6.opportunities.length : 0
    };

    const cardSummary = buildCardSummary(activeCards);
    const evidenceRows = buildCardEvidenceRows({ companyId, reportId, activeCards, report });

    return {
        currentCards,
        dormantCards,
        allCards,
        cardSummary,
        evidenceRows,
        memoryState,
        currentBrief,
        memorySeed
    };
}

function buildCardEvidenceRows({ companyId, reportId, activeCards, report }) {
    const evidenceRows = [];
    const signals = Array.isArray(report?.signals) ? report.signals : [];

    activeCards.forEach(card => {
        const signalIndex = signals.findIndex(signal => {
            if (card.card_type !== 'signal') return false;
            return buildSignalCardKey(signal) === card.card_key;
        });
        const sourceSignal = signalIndex >= 0 ? signals[signalIndex] : null;

        evidenceRows.push({
            company_id: companyId,
            card_key: card.card_key,
            report_id: reportId,
            signal_index: signalIndex >= 0 ? signalIndex : null,
            source_url: sourceSignal?.source_url || null,
            evidence_type: card.card_type,
            evidence_excerpt: sourceSignal?.signal_headline || sourceSignal?.the_move || card.title
        });
    });

    return evidenceRows;
}

export async function persistReportMemory({ companyId, reportId, latestContextVersionId = null, report, memoryBundle }) {
    if (!supabase || !companyId || !reportId || !memoryBundle) {
        return { success: false };
    }

    const existingState = await fetchCompanyMemoryState(companyId);

    const upsertCards = memoryBundle.allCards.map(card => ({
        company_id: companyId,
        card_key: card.card_key,
        section_key: card.section_key,
        card_type: card.card_type,
        title: card.title,
        payload: card.payload,
        status: card.status,
        trend_state: card.trend_state,
        occurrence_count: card.occurrence_count,
        first_seen_report_id: card.first_seen_report_id,
        last_seen_report_id: card.last_seen_report_id,
        first_seen_at: card.first_seen_at,
        last_seen_at: card.last_seen_at,
        source_index: card.source_index,
        source_url: card.source_url || null,
        entity_id: card.entity_id ?? null,
        updated_at: card.updated_at
    }));

    // Final dedup guard — ensures no two rows share (company_id, card_key) in the same batch,
    // which Postgres rejects even with ON CONFLICT. Last occurrence wins.
    const upsertDedup = new Map();
    for (const card of upsertCards) upsertDedup.set(`${card.company_id}:${card.card_key}`, card);
    const dedupedUpsertCards = [...upsertDedup.values()];

    // Migration tolerance: if the DB predates v28 (brief_cards.entity_id), retry the batch
    // without that column instead of failing every card upsert — the same pattern
    // structuredSignalTransformer.js already uses for corroborating_urls (v17).
    let hasEntityId = true;

    for (let i = 0; i < dedupedUpsertCards.length; i += 25) {
        let batch = dedupedUpsertCards.slice(i, i + 25);
        if (!hasEntityId) batch = batch.map(({ entity_id, ...rest }) => rest);
        let { error } = await supabase
            .from('brief_cards')
            .upsert(batch, { onConflict: 'company_id,card_key' });

        if (error?.code === 'PGRST204' && /entity_id/i.test(error.message || '')) {
            console.warn('[CompanyMemory] brief_cards.entity_id unavailable (run scripts/migrations/v31_entity_spine.sql); retrying without it.');
            hasEntityId = false;
            batch = batch.map(({ entity_id, ...rest }) => rest);
            ({ error } = await supabase.from('brief_cards').upsert(batch, { onConflict: 'company_id,card_key' }));
        }

        if (error) {
            console.error('[CompanyMemory] Failed to upsert brief cards:', error.message);
            return { success: false, error };
        }
    }

    if (memoryBundle.evidenceRows.length > 0) {
        const { data: storedCards, error: cardError } = await supabase
            .from('brief_cards')
            .select('id, card_key')
            .eq('company_id', companyId);

        if (cardError) {
            console.error('[CompanyMemory] Failed to reload cards for evidence:', cardError.message);
            return { success: false, error: cardError };
        }

        const cardIdMap = new Map((storedCards || []).map(card => [card.card_key, card.id]));
        const evidencePayloads = memoryBundle.evidenceRows.map(row => ({
            company_id: row.company_id,
            card_id: cardIdMap.get(row.card_key) || null,
            report_id: reportId,
            signal_index: row.signal_index,
            source_url: row.source_url,
            evidence_type: row.evidence_type,
            evidence_excerpt: row.evidence_excerpt
        })).filter(row => row.card_id);

        for (let i = 0; i < evidencePayloads.length; i += 25) {
            const batch = evidencePayloads.slice(i, i + 25);
            const { error } = await supabase
                .from('brief_card_evidence')
                .insert(batch);
            if (error) {
                console.error('[CompanyMemory] Failed to insert brief card evidence:', error.message);
                return { success: false, error };
            }
        }
    }

    const companyStatePayload = {
        company_id: companyId,
        latest_report_id: reportId,
        latest_context_version_id: latestContextVersionId,
        memory_state: memoryBundle.memoryState,
        current_brief: memoryBundle.currentBrief,
        current_cards: memoryBundle.allCards,
        active_sections: memoryBundle.memoryState.top_sections || [],
        run_count: Number(existingState?.run_count || 0) + 1,
        updated_at: new Date().toISOString()
    };

    const { error: stateError } = await supabase
        .from('company_memory_state')
        .upsert(companyStatePayload, { onConflict: 'company_id' });

    if (stateError) {
        console.error('[CompanyMemory] Failed to persist company memory state:', stateError.message);
        return { success: false, error: stateError };
    }

    const { error: reportUpdateError } = await updateReportMemory(reportId, {
        memory_state: memoryBundle.memoryState,
        card_summary: memoryBundle.cardSummary,
        based_on_report_id: memoryBundle.memoryState.based_on_report_id || null,
        run_fingerprint: `run_${reportId}`,
        effective_at: new Date().toISOString(),
        is_current_snapshot: true
    });

    if (reportUpdateError) {
        console.error('[CompanyMemory] Failed to update report memory fields:', reportUpdateError.message);
    }

    if (memoryBundle.memoryState.based_on_report_id) {
        await updateReportMemory(memoryBundle.memoryState.based_on_report_id, {
            is_current_snapshot: false,
            superseded_by_report_id: reportId
        }).catch(() => {});
    }

    return {
        success: true,
        memoryState: memoryBundle.memoryState,
        cardSummary: memoryBundle.cardSummary,
        currentBrief: memoryBundle.currentBrief,
        memorySeed: memoryBundle.memorySeed
    };
}
