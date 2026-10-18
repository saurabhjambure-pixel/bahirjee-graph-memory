/**
 * Shift Detection Engine — Bahirjee v6.0 Phase 3
 * 
 * DETERMINISTIC shift detection. NO LLM involvement.
 * Shifts are RARE — only created when thresholds are crossed.
 * 
 * Shift types:
 *   - emerging: rapid velocity increase (current > baseline * 2.5)
 *   - structural: source diversity jump (≥ 2 new domains in 7 days)
 *   - anomaly: pattern was established, now observation count dropped > 50%
 */

import { supabase } from '../lib/supabase.js';

// Thresholds — tuned for rarity
const EMERGING_VELOCITY_MULTIPLIER = 2.5;   // current must be > baseline * 2.5
const EMERGING_MIN_DELTA = 3;                // minimum absolute velocity delta
const STRUCTURAL_DIVERSITY_JUMP = 2;         // ≥ 2 new source domains
const ANOMALY_DROP_THRESHOLD = 0.5;          // >50% drop in observation count

/**
 * Which patterns crossed a shift threshold against the baseline. Pure — the thresholds are
 * the whole of the judgment, so they are testable without a database.
 *
 * `baseline` is the company's patterns as they stood BEFORE this run clustered (see
 * getPatternBaseline). An empty baseline means this is the company's first pattern run: it
 * establishes the baseline and reports nothing, the same rule Source Watch applies to a
 * page's first sighting. Without it every theme with three recent observations would be an
 * "emerging shift" on day one, measured against nothing.
 */
export function classifyShifts(patterns, baseline) {
    if (!Array.isArray(patterns) || !patterns.length) return [];
    if (!Array.isArray(baseline) || baseline.length === 0) return [];

    const previousMap = {};
    for (const p of baseline) previousMap[p.theme] = p;

    const out = [];
    for (const pattern of patterns) {
        const prior = previousMap[pattern.theme];
        const baselineVelocity = prior?.velocity_score || 0;
        const currentVelocity = pattern.velocity_score || 0;
        const velocityDelta = currentVelocity - baselineVelocity;

        let shiftType = null;
        let confidence = 'Medium';

        // --- EMERGING: rapid velocity increase ---
        if (
            currentVelocity > baselineVelocity * EMERGING_VELOCITY_MULTIPLIER &&
            velocityDelta >= EMERGING_MIN_DELTA
        ) {
            shiftType = 'emerging';
            confidence = velocityDelta >= 5 ? 'High' : 'Medium';
        }

        // --- STRUCTURAL: source diversity jump ---
        if (!shiftType && prior) {
            const diversityDelta = (pattern.source_diversity || 0) - (prior.source_diversity || 0);
            if (diversityDelta >= STRUCTURAL_DIVERSITY_JUMP) {
                shiftType = 'structural';
                confidence = diversityDelta >= 4 ? 'High' : 'Medium';
            }
        }

        // --- ANOMALY: established pattern dropped sharply ---
        if (!shiftType && prior) {
            if (
                prior.maturity === 'established' &&
                pattern.observation_count < prior.observation_count * ANOMALY_DROP_THRESHOLD
            ) {
                shiftType = 'anomaly';
                confidence = 'Low'; // Anomalies are inherently uncertain
            }
        }

        // If no threshold crossed, skip (this is the common case — shifts are rare)
        if (shiftType) out.push({ pattern, shiftType, confidence, baselineVelocity, currentVelocity, velocityDelta });
    }
    return out;
}

/**
 * Detect shifts from patterns and record them. Returns every shift THIS run detected: new
 * ones, and active ones whose threshold this run crossed again (updated in place). Returning
 * the updated ones is what makes a replayed step report the shift its crashed first attempt
 * already wrote, instead of skipping it as a duplicate and publishing without it.
 *
 * @param {string} companyId - Client UUID
 * @param {Array} patterns - Current pattern objects from patternEngine.clusterObservations()
 * @param {Array|null} baseline - Patterns before this run clustered (getPatternBaseline).
 *   Read by the caller BEFORE clustering: reading it here, after the upsert, compared every
 *   pattern with itself, so no threshold could ever be crossed.
 * @returns {Array} Detected shift objects (may be empty — shifts are rare)
 */
export async function detectShifts(companyId, patterns, baseline) {
    if (!supabase || !companyId || !patterns?.length) {
        return [];
    }
    if (!Array.isArray(baseline)) {
        console.warn('[ShiftEngine] No baseline — shifts cannot be measured this run.');
        return [];
    }
    if (baseline.length === 0) {
        console.log('[ShiftEngine] First pattern run for this company — establishing the baseline, no shifts reported.');
        return [];
    }

    console.log(`[ShiftEngine] Evaluating ${patterns.length} patterns against a baseline of ${baseline.length}...`);

    // Load existing active shifts to avoid duplicates
    const activeShifts = await getActiveShifts(companyId);
    const activeShiftPatternIds = new Set(activeShifts.map(s => s.pattern_id));

    const detectedShifts = [];

    for (const { pattern, shiftType, confidence, baselineVelocity, currentVelocity, velocityDelta } of classifyShifts(patterns, baseline)) {
        // Deduplicate: if an active shift for this pattern already exists, update instead
        if (activeShiftPatternIds.has(pattern.id)) {
            console.log(`[ShiftEngine] Existing shift for pattern "${pattern.theme}". Updating.`);
            const updated = await updateExistingShift(pattern.id, {
                currentVelocity,
                baselineVelocity,
                velocityDelta,
                confidence
            });
            if (updated) detectedShifts.push(updated);
            continue;
        }

        // Create new shift
        const shift = await createShift({
            companyId,
            patternId: pattern.id,
            shiftType,
            theme: pattern.theme,
            velocityDelta: Math.round(velocityDelta * 100) / 100,
            baselineVelocity: Math.round(baselineVelocity * 100) / 100,
            currentVelocity: Math.round(currentVelocity * 100) / 100,
            confidence
        });

        if (shift) {
            detectedShifts.push(shift);
            console.log(`[ShiftEngine] 🔺 SHIFT DETECTED: type=${shiftType}, theme="${pattern.theme}", delta=${velocityDelta.toFixed(2)}`);
        }
    }

    if (detectedShifts.length === 0) {
        console.log('[ShiftEngine] ✅ No shifts detected. (Normal — shifts should be rare.)');
    } else {
        console.log(`[ShiftEngine] ⚡ ${detectedShifts.length} shift(s) detected.`);
    }

    return detectedShifts;
}

// --- DB Operations ---

async function createShift({ companyId, patternId, shiftType, theme, velocityDelta, baselineVelocity, currentVelocity, confidence }) {
    try {
        const { data, error } = await supabase
            .from('shifts')
            .insert({
                company_id: companyId,
                pattern_id: patternId,
                shift_type: shiftType,
                theme,
                velocity_delta: velocityDelta,
                baseline_velocity: baselineVelocity,
                current_velocity: currentVelocity,
                confidence,
                status: 'active',
                detected_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) {
            console.error('[ShiftEngine] Insert error:', error.message);
            return null;
        }
        return data;
    } catch (err) {
        console.error('[ShiftEngine] Unexpected error:', err);
        return null;
    }
}

async function updateExistingShift(patternId, { currentVelocity, velocityDelta, confidence }) {
    try {
        // Deliberately do NOT rewrite baseline_velocity here. The baseline is the
        // reference point captured when the shift was first detected; overwriting it
        // every run with the latest baseline makes velocity_delta drift toward zero
        // and renders the baseline meaningless. Only the current/delta/confidence and
        // freshness timestamp are updated.
        const { data, error } = await supabase
            .from('shifts')
            .update({
                current_velocity: Math.round(currentVelocity * 100) / 100,
                velocity_delta: Math.round(velocityDelta * 100) / 100,
                confidence,
                detected_at: new Date().toISOString()
            })
            .eq('pattern_id', patternId)
            .eq('status', 'active')
            .select();

        if (error) {
            console.error('[ShiftEngine] Update error:', error.message);
            return null;
        }
        return Array.isArray(data) ? data[0] || null : data || null;
    } catch (err) {
        console.error('[ShiftEngine] Unexpected update error:', err);
        return null;
    }
}

async function getActiveShifts(companyId) {
    const { data, error } = await supabase
        .from('shifts')
        .select('*')
        .eq('company_id', companyId)
        .eq('status', 'active');

    if (error) {
        console.error('[ShiftEngine] Fetch active shifts error:', error.message);
        return [];
    }
    return data || [];
}

/**
 * Get all active shifts for a company (used by dashboard).
 */
export async function getShiftsForCompany(companyId) {
    if (!supabase || !companyId) return [];

    const { data, error } = await supabase
        .from('shifts')
        .select('*')
        .eq('company_id', companyId)
        .eq('status', 'active')
        .order('detected_at', { ascending: false });

    if (error) {
        console.error('[ShiftEngine] Fetch error:', error.message);
        return [];
    }
    return data || [];
}
