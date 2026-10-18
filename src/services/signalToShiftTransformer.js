/**
 * Signal-to-Shift Transformer — Bahirjee v6.0
 * 
 * CLIENT-SIDE fallback that generates shifts, patterns, and opportunities
 * from the Gemini signal analysis output. This ensures the Strategic Awareness
 * Surface shows meaningful content from the FIRST run, without requiring
 * multi-run Supabase observation history.
 * 
 * Used when the v6 DB-based pipeline returns empty results.
 */

// Theme mapping lives in signalTaxonomy.js. This file used to carry its own copy, which
// had drifted to categories the prompt no longer emits (CompetitorMove, FundingEvent,
// ReputationEvent, …) while missing every one it does — so every signal fell through to
// 'general' and this fallback clustered one undifferentiated blob.
import { themeForCategory } from './signalTaxonomy.js';

/**
 * Transform Gemini signals into v6-compatible shifts, patterns, and opportunities.
 * 
 * @param {Array} signals - Gemini signal analysis output (with category, relevance, etc.)
 * @param {Object} contextJson - The full context object for the company
 * @returns {Object} { shifts, patterns, blindSpots, opportunities, interpretation }
 */
export function transformSignalsToV6(signals, contextJson) {
    if (!signals || signals.length === 0) {
        return { shifts: [], patterns: [], blindSpots: [], opportunities: [], interpretation: null };
    }

    // ── Step 1: Group signals by theme ──
    const themeGroups = {};
    for (const signal of signals) {
        const category = signal.category || signal.type || 'IndustryMomentum';
        const theme = themeForCategory(category);
        if (!themeGroups[theme]) themeGroups[theme] = [];
        themeGroups[theme].push(signal);
    }

    // ── Step 2: Generate Patterns from theme groups ──
    const patterns = [];
    for (const [theme, themeSignals] of Object.entries(themeGroups)) {
        if (themeSignals.length < 1) continue;

        const uniqueSources = new Set(themeSignals.map(s => s.source_url || s.url || 'unknown').filter(Boolean));
        const avgRelevance = themeSignals.reduce((sum, s) => sum + (s.relevance || s.relevance_score || 5), 0) / themeSignals.length;

        let maturity = 'early';
        if (themeSignals.length >= 5 && uniqueSources.size >= 3) maturity = 'established';
        else if (themeSignals.length >= 2 && uniqueSources.size >= 2) maturity = 'forming';

        patterns.push({
            id: `synth-pattern-${theme}`,
            theme,
            entity_cluster: extractEntities(themeSignals),
            observation_count: themeSignals.length,
            source_diversity: uniqueSources.size,
            velocity_score: Math.round(avgRelevance * themeSignals.length * 10) / 10,
            maturity,
            first_seen: new Date().toISOString(),
            last_seen: new Date().toISOString(),
            _synthetic: true
        });
    }

    // Sort by velocity (relevance × count)
    patterns.sort((a, b) => b.velocity_score - a.velocity_score);

    // ── Step 3: Generate Shifts from high-relevance signal clusters ──
    const shifts = [];
    for (const pattern of patterns) {
        const themeSignals = themeGroups[pattern.theme] || [];
        const topSignal = themeSignals.sort((a, b) =>
            (b.relevance || b.relevance_score || 0) - (a.relevance || a.relevance_score || 0)
        )[0];

        if (!topSignal) continue;

        const relevance = topSignal.relevance || topSignal.relevance_score || 5;
        const impact = topSignal.impact || topSignal.impact_level || 'medium';

        // Only generate shifts for high-signal clusters
        let shiftType = null;
        let confidence = 'Medium';

        if (relevance >= 8 || impact === 'high' || impact === 'critical') {
            shiftType = 'structural';
            confidence = relevance >= 9 ? 'High' : 'Medium';
        } else if (themeSignals.length >= 3 && relevance >= 6) {
            shiftType = 'emerging';
            confidence = themeSignals.length >= 4 ? 'High' : 'Medium';
        } else if (relevance >= 7 && pattern.source_diversity >= 2) {
            shiftType = 'emerging';
            confidence = 'Medium';
        }

        if (!shiftType) continue;

        shifts.push({
            id: `synth-shift-${pattern.theme}`,
            pattern_id: pattern.id,
            shift_type: shiftType,
            theme: pattern.theme,
            velocity_delta: Math.round(relevance * 0.8 * 100) / 100,
            baseline_velocity: 0,
            current_velocity: pattern.velocity_score,
            confidence,
            status: 'active',
            detected_at: new Date().toISOString(),
            _headline: topSignal.headline || topSignal.title || '',
            _evidence: topSignal.detail || topSignal.description || topSignal.summary || '',
            _synthetic: true
        });
    }

    // Cap at top 3 shifts
    shifts.sort((a, b) => b.velocity_delta - a.velocity_delta);
    const topShifts = shifts.slice(0, 3);

    // ── Step 4: Generate Opportunities from positive signals ──
    const opportunities = [];
    const positiveCategories = ['DemandSignal', 'PartnershipOpportunity', 'FundingOpportunity', 'MarketExpansion', 'PartnershipSignal', 'ProductEvolution', 'IndustryMomentum'];

    for (const signal of signals) {
        const category = signal.category || signal.type || '';
        const sentiment = (signal.sentiment || '').toLowerCase();
        const relevance = signal.relevance || signal.relevance_score || 5;

        if ((positiveCategories.includes(category) || sentiment === 'positive' || sentiment === 'opportunity') && relevance >= 6) {
            const theme = themeForCategory(category);

            // Don't duplicate themes already captured as shifts
            if (topShifts.some(s => s.theme === theme)) continue;

            opportunities.push({
                id: `synth-opp-${theme}-${opportunities.length}`,
                theme,
                opportunity_type: relevance >= 8 ? 'emerging' : 'adjacency',
                evidence: signal.headline || signal.title || '',
                confidence: relevance >= 8 ? 'High' : 'Medium',
                detected_at: new Date().toISOString(),
                _synthetic: true
            });
        }
    }

    // Cap at 3
    const topOpportunities = opportunities.slice(0, 3);

    // ── Step 5: Generate Blind Spots ──
    const blindSpots = [];
    const companyCompetitors = (contextJson?.key_competitors || []).map(c =>
        typeof c === 'object' ? c.name : c
    ).filter(Boolean);

    // Find themes where competitors are mentioned but company isn't active
    const competitorSignals = signals.filter(s => {
        const text = (s.headline || '') + ' ' + (s.detail || s.description || '');
        return companyCompetitors.some(comp => text.toLowerCase().includes(comp.toLowerCase()));
    });

    const competitorThemes = {};
    for (const s of competitorSignals) {
        const category = s.category || s.type || '';
        const theme = themeForCategory(category);
        if (!competitorThemes[theme]) competitorThemes[theme] = { signals: [], competitors: new Set() };
        competitorThemes[theme].signals.push(s);
        for (const comp of companyCompetitors) {
            const text = (s.headline || '') + ' ' + (s.detail || s.description || '');
            if (text.toLowerCase().includes(comp.toLowerCase())) {
                competitorThemes[theme].competitors.add(comp);
            }
        }
    }

    for (const [theme, data] of Object.entries(competitorThemes)) {
        // Only flag as blind spot if company doesn't have its own signals in this theme
        const companyName = (contextJson?.company_name || '').toLowerCase();
        const companyHasPresence = (themeGroups[theme] || []).some(s => {
            const text = (s.headline || '') + ' ' + (s.detail || s.description || '');
            return text.toLowerCase().includes(companyName);
        });

        if (!companyHasPresence && data.competitors.size > 0) {
            blindSpots.push({
                id: `synth-blindspot-${theme}`,
                theme,
                competitor_entities: [...data.competitors],
                evidence_count: data.signals.length,
                detected_at: new Date().toISOString(),
                _synthetic: true
            });
        }
    }

    const topBlindSpots = blindSpots.slice(0, 3);

    // ── Step 6: Generate synthetic interpretation ──
    const interpretation = generateSyntheticInterpretation(topShifts, topBlindSpots, topOpportunities, contextJson);

    return {
        shifts: topShifts,
        patterns,
        blindSpots: topBlindSpots,
        opportunities: topOpportunities,
        interpretation,
        _synthetic: true
    };
}

// ── Helpers ──

function extractEntities(signals) {
    const entities = new Set();
    for (const s of signals) {
        if (s.entity) entities.add(s.entity);
        if (s.company) entities.add(s.company);
        // Extract quoted entities from headlines
        const matches = (s.headline || '').match(/"([^"]+)"/g);
        if (matches) matches.forEach(m => entities.add(m.replace(/"/g, '')));
    }
    return [...entities].slice(0, 5);
}

function generateSyntheticInterpretation(shifts, blindSpots, opportunities, contextJson) {
    const companyName = contextJson?.company_name || 'this company';
    const interpretations = [];

    for (const shift of shifts) {
        interpretations.push({
            theme: shift.theme,
            finding_type: 'shift',
            indication: shift._evidence || `Significant activity detected in ${shift.theme.replace(/_/g, ' ')} that may impact ${companyName}.`,
            company_relevance: `This ${shift.shift_type} shift affects ${companyName}'s operating environment.`,
            stability_assessment: shift.shift_type === 'structural' ? 'structural' : 'temporary',
            uncertainty_notes: 'Based on single-run signal analysis. Confidence will improve with subsequent runs.'
        });
    }

    for (const bs of blindSpots) {
        interpretations.push({
            theme: bs.theme,
            finding_type: 'blind_spot',
            indication: `Competitors (${bs.competitor_entities.join(', ')}) are active in ${bs.theme.replace(/_/g, ' ')} where ${companyName} has no detected presence.`,
            company_relevance: `Potential gap in ${companyName}'s market awareness.`,
            stability_assessment: 'unknown',
            uncertainty_notes: 'Blind spot detection is based on signal absence, which may reflect data gaps rather than actual strategic gaps.'
        });
    }

    for (const opp of opportunities) {
        interpretations.push({
            theme: opp.theme,
            finding_type: 'opportunity',
            indication: opp.evidence || `Emerging opportunity detected in ${opp.theme.replace(/_/g, ' ')}.`,
            company_relevance: `${companyName} may benefit from activity in this space.`,
            stability_assessment: opp.opportunity_type === 'emerging' ? 'forming' : 'early',
            uncertainty_notes: 'Opportunity assessment based on initial signal scan.'
        });
    }

    // Generate landscape summary
    const shiftCount = shifts.length;
    const bsCount = blindSpots.length;
    const oppCount = opportunities.length;

    let landscapeSummary = `Initial scan for ${companyName}: `;
    const parts = [];
    if (shiftCount > 0) parts.push(`${shiftCount} active shift${shiftCount > 1 ? 's' : ''} detected`);
    if (bsCount > 0) parts.push(`${bsCount} potential blind spot${bsCount > 1 ? 's' : ''}`);
    if (oppCount > 0) parts.push(`${oppCount} emerging opportunit${oppCount > 1 ? 'ies' : 'y'}`);
    landscapeSummary += parts.join(', ') + '. This is a first-run analysis — patterns will refine with subsequent scans.';

    return {
        interpretations,
        landscape_summary: landscapeSummary
    };
}
