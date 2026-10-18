/**
 * Pattern Engine — Bahirjee v6.0 Phase 2
 * 
 * DETERMINISTIC clustering of Observations. NO LLM involvement.
 * 
 * Algorithm:
 * 1. Load observations for company within rolling 30-day window
 * 2. Group by theme (exact match on query category)
 * 3. For each theme: compute source_diversity (unique domains)
 * 4. Skip if source_diversity < 2 (no pattern yet)
 * 5. Compute velocity_score = obs in last 7 days / obs in prior 23 days
 * 6. Assign maturity: early (<3), forming (3-7), established (>7)
 * 7. UPSERT pattern (match on company_id + theme), never recreate
 */

import { supabase } from '../lib/supabase.js';
import { getObservationsForCompany } from './observationService.js';

/**
 * Run pattern clustering for a company.
 * 
 * @param {string} companyId - Client UUID
 * @returns {Array} Upserted pattern objects
 */
export async function clusterObservations(companyId) {
    if (!supabase || !companyId) {
        console.warn('[PatternEngine] Missing supabase or companyId. Skipping.');
        return [];
    }

    // 1. Load observations from rolling 30-day window
    const observations = await getObservationsForCompany(companyId, 30);

    if (observations.length === 0) {
        console.log('[PatternEngine] No observations in 30-day window. No patterns to form.');
        return [];
    }

    console.log(`[PatternEngine] Processing ${observations.length} observations for company ${companyId.substring(0, 8)}...`);

    // 2. Group observations by theme
    const themeGroups = {};
    for (const obs of observations) {
        const theme = obs.theme || 'general';
        if (!themeGroups[theme]) themeGroups[theme] = [];
        themeGroups[theme].push(obs);
    }

    const patterns = [];

    // 3. Process each theme group
    for (const [theme, themeObs] of Object.entries(themeGroups)) {
        // Calculate source diversity (unique source domains)
        const uniqueDomains = new Set();
        for (const obs of themeObs) {
            if (obs.source_url) {
                try {
                    const domain = new URL(obs.source_url).hostname;
                    uniqueDomains.add(domain);
                } catch {
                    // Skip malformed URLs
                }
            }
        }
        const sourceDiversity = uniqueDomains.size;

        // 4. Require minimum source diversity >= 2
        if (sourceDiversity < 2) {
            console.log(`[PatternEngine] Theme "${theme}": diversity=${sourceDiversity} < 2. Skipping.`);
            continue;
        }

        // 5. Compute velocity score
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const recentObs = themeObs.filter(o => new Date(o.created_at) >= sevenDaysAgo);
        const olderObs = themeObs.filter(o => new Date(o.created_at) < sevenDaysAgo);

        // Velocity = recent count / older count (capped at 10, floor of 0.1 to avoid 0)
        const velocityScore = olderObs.length > 0
            ? Math.min(10, recentObs.length / olderObs.length)
            : (recentObs.length > 0 ? Math.min(10, recentObs.length) : 0);

        // 6. Assign maturity
        const obsCount = themeObs.length;
        let maturity = 'early';
        if (obsCount > 7) maturity = 'established';
        else if (obsCount >= 3) maturity = 'forming';

        // Collect entity names
        const entities = [...new Set(themeObs.map(o => o.entity).filter(Boolean))];

        // Collect observation IDs
        const obsIds = themeObs.map(o => o.id);

        // Date range
        const dates = themeObs.map(o => new Date(o.created_at));
        const firstSeen = new Date(Math.min(...dates));
        const lastSeen = new Date(Math.max(...dates));

        // 7. Upsert pattern
        const pattern = await upsertPattern({
            companyId,
            theme,
            entityCluster: entities,
            observationIds: obsIds,
            observationCount: obsCount,
            sourceDiversity,
            firstSeen,
            lastSeen,
            velocityScore: Math.round(velocityScore * 100) / 100,
            maturity
        });

        if (pattern) patterns.push(pattern);
    }

    console.log(`[PatternEngine] ✅ ${patterns.length} patterns upserted for company ${companyId.substring(0, 8)}`);
    return patterns;
}

/**
 * Upsert a pattern: update if exists for this company+theme, insert if not.
 */
async function upsertPattern({
    companyId, theme, entityCluster, observationIds,
    observationCount, sourceDiversity, firstSeen, lastSeen,
    velocityScore, maturity
}) {
    try {
        const { data, error } = await supabase
            .from('patterns')
            .upsert({
                company_id: companyId,
                theme,
                entity_cluster: entityCluster,
                observation_ids: observationIds,
                observation_count: observationCount,
                source_diversity: sourceDiversity,
                first_seen: firstSeen.toISOString(),
                last_seen: lastSeen.toISOString(),
                velocity_score: velocityScore,
                maturity,
                updated_at: new Date().toISOString()
            }, {
                onConflict: 'company_id,theme'
            })
            .select()
            .single();

        if (error) {
            console.error(`[PatternEngine] Upsert error for theme "${theme}":`, error.message);
            return null;
        }

        console.log(`[PatternEngine] Pattern "${theme}": count=${observationCount}, diversity=${sourceDiversity}, velocity=${velocityScore}, maturity=${maturity}`);
        return data;
    } catch (err) {
        console.error('[PatternEngine] Unexpected upsert error:', err);
        return null;
    }
}

/**
 * The company's patterns as they stand BEFORE this run clusters — the baseline shifts are
 * measured against. Must be read before clusterObservations() upserts this run's patterns;
 * the pipeline reads it in `memory`, which checkpoints before any pattern is written, so a
 * replayed `v6_pipeline` still compares against the pre-run state.
 *
 * Returns [] for a company with no patterns yet (a first run), and null when the read
 * failed — so a failed read is never mistaken for a first run.
 */
export async function getPatternBaseline(companyId) {
    if (!supabase || !companyId) return null;

    const { data, error } = await supabase
        .from('patterns')
        .select('id, theme, velocity_score, source_diversity, observation_count, maturity')
        .eq('company_id', companyId);

    if (error) {
        console.error('[PatternEngine] Baseline fetch error:', error.message);
        return null;
    }
    return data || [];
}

/**
 * Get all patterns for a company.
 * @param {string} companyId 
 * @returns {Array} Pattern rows
 */
export async function getPatternsForCompany(companyId) {
    if (!supabase || !companyId) return [];

    const { data, error } = await supabase
        .from('patterns')
        .select('*')
        .eq('company_id', companyId)
        .order('velocity_score', { ascending: false });

    if (error) {
        console.error('[PatternEngine] Fetch error:', error.message);
        return [];
    }

    return data || [];
}
