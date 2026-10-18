/**
 * Blind Spot Engine — Bahirjee v6.0 Phase 4
 * 
 * DETERMINISTIC blind spot detection. NO LLM involvement.
 * 
 * A BlindSpot is generated when:
 *   - Pattern maturity >= "forming"
 *   - Competitor presence confirmed (competitor entities found in observations)
 *   - Company entity is ABSENT from those observations
 * 
 * Blind spots feel uncomfortable but credible.
 */

import { supabase } from '../lib/supabase.js';
import { getObservationsForCompany } from './observationService.js';

/**
 * Detect blind spots by comparing competitor presence vs company absence in patterns.
 * 
 * @param {string} companyId - Client UUID
 * @param {Array} patterns - Current pattern objects
 * @param {Object} contextJson - Company context including key_competitors and company_name
 * @param {string} [opts.since] - When this run began (ISO). An active blind spot detected at
 *   or after it was written by this run — by an attempt that crashed before checkpointing —
 *   so it is reported again rather than skipped as a duplicate.
 * @returns {Array} Detected blind spot objects
 */
export async function detectBlindSpots(companyId, patterns, contextJson, { since = null } = {}) {
    if (!supabase || !companyId || !patterns?.length || !contextJson) return [];

    const companyName = (contextJson.company_name || '').toLowerCase();

    // Primary source: key_competitors from context
    let competitors = (contextJson.key_competitors || [])
        .map(c => (typeof c === 'object' ? c.name : c)?.toLowerCase())
        .filter(Boolean);

    // Fallback: derive competitor names from the entity watchlist (_trackedEntities)
    if (competitors.length === 0 && Array.isArray(contextJson._trackedEntities)) {
        competitors = contextJson._trackedEntities
            .filter(e => e?.category === 'competitor')
            .map(e => e.name?.toLowerCase())
            .filter(Boolean);
        if (competitors.length > 0) {
            console.log(`[BlindSpotEngine] key_competitors absent — using ${competitors.length} entities from trackedEntities as competitors.`);
        }
    }

    if (!companyName || competitors.length === 0) {
        console.log('[BlindSpotEngine] Insufficient context (no company name or competitors). Skipping.');
        return [];
    }

    // Load observations for text scanning
    const observations = await getObservationsForCompany(companyId, 30);

    // Pre-build observation text index by theme
    const obsByTheme = {};
    for (const obs of observations) {
        const theme = obs.theme || 'general';
        if (!obsByTheme[theme]) obsByTheme[theme] = [];
        obsByTheme[theme].push((obs.raw_text || '').toLowerCase());
    }

    // Load existing active blind spots for deduplication
    const existingBlindSpots = await getActiveBlindSpots(companyId);
    const existingByTheme = new Map(existingBlindSpots.map(bs => [bs.theme, bs]));

    const detectedBlindSpots = [];

    for (const pattern of patterns) {
        // Only patterns with maturity >= "forming"
        if (pattern.maturity === 'early') continue;

        const themeTexts = obsByTheme[pattern.theme] || [];
        if (themeTexts.length === 0) continue;

        const combinedText = themeTexts.join(' ');

        // Check if competitor entities are present
        const presentCompetitors = competitors.filter(comp => combinedText.includes(comp));

        // Check if company entity is ABSENT
        const companyPresent = combinedText.includes(companyName);

        // Blind Spot: competitors present, company absent
        if (presentCompetitors.length > 0 && !companyPresent) {
            // Skip if we already have an active blind spot for this theme — unless this run
            // wrote it, in which case it is this run's finding and belongs in its report.
            const existing = existingByTheme.get(pattern.theme);
            if (existing) {
                if (isOwnFinding(existing, since)) detectedBlindSpots.push(existing);
                else console.log(`[BlindSpotEngine] Existing blind spot for "${pattern.theme}". Skipping.`);
                continue;
            }

            const blindSpot = await createBlindSpot({
                companyId,
                patternId: pattern.id,
                theme: pattern.theme,
                competitorEntities: presentCompetitors
            });

            if (blindSpot) {
                detectedBlindSpots.push(blindSpot);
                console.log(`[BlindSpotEngine] 🔴 BLIND SPOT: "${pattern.theme}" — competitors ${presentCompetitors.join(', ')} active, ${companyName} absent`);
            }
        }
    }

    // An untested bet is a blind spot in the most literal sense the word has: the founder
    // told us what they are betting on, and this run found nothing that bears on it.
    // This is the claim the onboarding form has always made — "improves blind spot
    // detection" — and until now it was simply untrue: strategic_assumptions had four
    // write sites and no readers anywhere in the pipeline.
    detectedBlindSpots.push(...detectUntestedBets(contextJson, patterns));

    if (detectedBlindSpots.length === 0) {
        console.log('[BlindSpotEngine] ✅ No blind spots detected.');
    }

    return detectedBlindSpots;
}

/** True when an existing active row was detected at or after `since` — i.e. by this run. */
export function isOwnFinding(row, since) {
    if (!since || !row?.detected_at) return false;
    const at = Date.parse(row.detected_at);
    const from = Date.parse(since);
    return Number.isFinite(at) && Number.isFinite(from) && at >= from;
}

/**
 * Bets whose DOMAIN drew no evidence this run.
 *
 * Deterministic and DB-free, unlike the competitor-absence detector above: it compares the
 * founder's stated domains against the themes this run actually produced. That means it
 * still works on a first run, before there is any pattern history — which matters, because
 * a free user only gets one.
 *
 * Only `High` sensitivity bets qualify. A founder who marked a bet "Low" has already said
 * they are not counting on it, and reporting it as a blind spot would train them to ignore
 * the section — the same reasoning that keeps Funding/Talent out of CRITICAL_SECTIONS.
 */
export function detectUntestedBets(contextJson, patterns = []) {
    const bets = (contextJson?._startupContext?.strategic_assumptions || [])
        .filter(b => b?.statement && String(b.sensitivity).toLowerCase() === 'high');
    if (bets.length === 0) return [];

    // What this run actually looked at, as one lowercase haystack.
    const covered = (Array.isArray(patterns) ? patterns : [])
        .map(p => `${p?.theme || ''} ${p?.title || ''} ${p?.headline || ''}`)
        .join(' ')
        .toLowerCase();

    // Onboarding's ASSUMPTION_DOMAINS, mapped to the vocabulary patterns are themed with.
    const DOMAIN_TERMS = {
        demand: ['demand', 'customer', 'buyer', 'adoption', 'market'],
        cost: ['cost', 'pricing', 'price', 'margin', 'infra', 'supplier', 'vendor'],
        capital: ['funding', 'capital', 'raise', 'investor'],
        distribution: ['partnership', 'channel', 'platform', 'distribution', 'integration'],
        regulation: ['regulat', 'compliance', 'policy', 'legal'],
        talent: ['talent', 'hiring', 'layoff', 'recruit'],
    };

    const untested = bets.filter(bet => {
        const terms = DOMAIN_TERMS[String(bet.domain || 'demand').toLowerCase()] || [];
        return !terms.some(term => covered.includes(term));
    });

    for (const bet of untested) {
        console.log(`[BlindSpotEngine] 🔴 UNTESTED BET (${bet.domain}): "${bet.statement.slice(0, 80)}"`);
    }

    return untested.map(bet => ({
        theme: `Untested bet — ${bet.domain || 'Demand'}`,
        blind_spot_type: 'untested_assumption',
        statement: bet.statement,
        detail: `You are betting on this, and nothing this run found bears on it either way.`,
        competitor_entities: [],
        status: 'active',
        detected_at: new Date().toISOString(),
    }));
}

async function createBlindSpot({ companyId, patternId, theme, competitorEntities }) {
    try {
        const { data, error } = await supabase
            .from('blind_spots')
            .insert({
                company_id: companyId,
                pattern_id: patternId,
                theme,
                competitor_entities: competitorEntities,
                status: 'active',
                detected_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) {
            console.error('[BlindSpotEngine] Insert error:', error.message);
            return null;
        }
        return data;
    } catch (err) {
        console.error('[BlindSpotEngine] Unexpected error:', err);
        return null;
    }
}

async function getActiveBlindSpots(companyId) {
    const { data, error } = await supabase
        .from('blind_spots')
        .select('*')
        .eq('company_id', companyId)
        .eq('status', 'active');

    if (error) return [];
    return data || [];
}

/**
 * Get all active blind spots for a company (for dashboard).
 */
export async function getBlindSpotsForCompany(companyId) {
    if (!supabase || !companyId) return [];

    const { data, error } = await supabase
        .from('blind_spots')
        .select('*')
        .eq('company_id', companyId)
        .eq('status', 'active')
        .order('detected_at', { ascending: false });

    if (error) return [];
    return data || [];
}
