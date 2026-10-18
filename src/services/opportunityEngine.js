/**
 * Opportunity Engine — Bahirjee v6.0 Phase 4
 * 
 * DETERMINISTIC opportunity detection. NO LLM involvement.
 * 
 * Two opportunity types:
 *   - emerging: pattern velocity > 2.0 AND buyer-intent keywords detected
 *   - missed: competitor density high (≥ 3 competitors), company absent
 */

import { supabase } from '../lib/supabase.js';
import { getObservationsForCompany } from './observationService.js';
import { isOwnFinding } from './blindSpotEngine.js';

// Buyer-intent keywords that suggest market opportunity
const BUYER_INTENT_KEYWORDS = [
    'budget', 'procurement', 'evaluating', 'rfp', 'pilot',
    'looking for', 'seeking', 'request for proposal', 'tender',
    'switching from', 'replacing', 'migration', 'adoption',
    'trial', 'poc', 'proof of concept', 'vendor selection',
    'buying', 'purchasing', 'investment'
];

const EMERGING_VELOCITY_THRESHOLD = 2.0;
const MISSED_COMPETITOR_DENSITY = 3;

/**
 * Detect opportunities from patterns and observations.
 * 
 * @param {string} companyId - Client UUID
 * @param {Array} patterns - Current pattern objects
 * @param {Object} contextJson - Company context
 * @returns {Array} Detected opportunity objects
 */
export async function detectOpportunities(companyId, patterns, contextJson, { since = null } = {}) {
    if (!supabase || !companyId || !patterns?.length || !contextJson) return [];

    const companyName = (contextJson.company_name || '').toLowerCase();
    const competitors = (contextJson.key_competitors || [])
        .map(c => (typeof c === 'object' ? c.name : c)?.toLowerCase())
        .filter(Boolean);

    // Load observations for text scanning
    const observations = await getObservationsForCompany(companyId, 30);

    const obsByTheme = {};
    for (const obs of observations) {
        const theme = obs.theme || 'general';
        if (!obsByTheme[theme]) obsByTheme[theme] = [];
        obsByTheme[theme].push((obs.raw_text || '').toLowerCase());
    }

    // Load existing active opportunities for dedup
    const existingOpps = await getActiveOpportunities(companyId);
    const existingByKey = new Map(existingOpps.map(o => [`${o.opportunity_type}:${o.theme}`, o]));

    const detectedOpportunities = [];
    // An active row this run wrote (a crashed attempt, replayed) is this run's finding:
    // report it rather than skip it as a duplicate. See isOwnFinding.
    const alreadyRecorded = (key) => {
        const existing = existingByKey.get(key);
        if (!existing) return false;
        if (isOwnFinding(existing, since)) detectedOpportunities.push(existing);
        return true;
    };

    for (const pattern of patterns) {
        const themeTexts = obsByTheme[pattern.theme] || [];
        const combinedText = themeTexts.join(' ');

        // --- EMERGING: pattern acceleration + buyer activity ---
        if (pattern.velocity_score > EMERGING_VELOCITY_THRESHOLD) {
            const buyerSignals = BUYER_INTENT_KEYWORDS.filter(kw => combinedText.includes(kw));

            if (buyerSignals.length > 0) {
                const key = `emerging:${pattern.theme}`;
                if (!alreadyRecorded(key)) {
                    const evidence = `Velocity ${pattern.velocity_score.toFixed(1)}x with buyer signals: ${buyerSignals.slice(0, 3).join(', ')}`;
                    const opp = await createOpportunity({
                        companyId,
                        patternId: pattern.id,
                        type: 'emerging',
                        theme: pattern.theme,
                        evidence
                    });
                    if (opp) {
                        detectedOpportunities.push(opp);
                        console.log(`[OpportunityEngine] 🟢 EMERGING: "${pattern.theme}" — ${evidence}`);
                    }
                }
            }
        }

        // --- MISSED: competitor density high, company absent ---
        if (competitors.length >= MISSED_COMPETITOR_DENSITY) {
            const presentCompetitors = competitors.filter(comp => combinedText.includes(comp));
            const companyPresent = combinedText.includes(companyName);

            if (presentCompetitors.length >= MISSED_COMPETITOR_DENSITY && !companyPresent) {
                const key = `missed:${pattern.theme}`;
                if (!alreadyRecorded(key)) {
                    const evidence = `${presentCompetitors.length} competitors active (${presentCompetitors.slice(0, 3).join(', ')}), ${companyName} absent`;
                    const opp = await createOpportunity({
                        companyId,
                        patternId: pattern.id,
                        type: 'missed',
                        theme: pattern.theme,
                        evidence
                    });
                    if (opp) {
                        detectedOpportunities.push(opp);
                        console.log(`[OpportunityEngine] 🟡 MISSED: "${pattern.theme}" — ${evidence}`);
                    }
                }
            }
        }
    }

    if (detectedOpportunities.length === 0) {
        console.log('[OpportunityEngine] ✅ No new opportunities detected.');
    }

    return detectedOpportunities;
}

async function createOpportunity({ companyId, patternId, type, theme, evidence }) {
    try {
        const { data, error } = await supabase
            .from('opportunities')
            .insert({
                company_id: companyId,
                pattern_id: patternId,
                opportunity_type: type,
                theme,
                evidence,
                status: 'active',
                detected_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) {
            console.error('[OpportunityEngine] Insert error:', error.message);
            return null;
        }
        return data;
    } catch (err) {
        console.error('[OpportunityEngine] Unexpected error:', err);
        return null;
    }
}

async function getActiveOpportunities(companyId) {
    const { data, error } = await supabase
        .from('opportunities')
        .select('*')
        .eq('company_id', companyId)
        .eq('status', 'active');

    if (error) return [];
    return data || [];
}

/**
 * Get all active opportunities for a company (for dashboard).
 */
export async function getOpportunitiesForCompany(companyId) {
    if (!supabase || !companyId) return [];

    const { data, error } = await supabase
        .from('opportunities')
        .select('*')
        .eq('company_id', companyId)
        .eq('status', 'active')
        .order('detected_at', { ascending: false });

    if (error) return [];
    return data || [];
}
