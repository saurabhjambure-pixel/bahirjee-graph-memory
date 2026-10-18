/**
 * Signal Weight Engine — Bahirjee Context Building Layer
 * 
 * Maps exposure_weights to signal category weights.
 * These weights determine how much importance is given to
 * different types of market signals (pricing changes, hiring, etc.)
 */

/**
 * Compute signal category weights from exposure weights.
 * 
 * @param {Object} exposureWeights - { capital, demand, cost, distribution, regulation, talent }
 * @param {Object} revenueProfile - { model, customer_type, sales_motion, geography, funding_stage }
 * @returns {Object} Signal category weights (0.0 - 1.0)
 */
export function computeSignalWeights(exposureWeights, revenueProfile = {}) {
    const ew = exposureWeights || {};
    const base = 0.15; // Minimum weight for all categories

    return {
        pricing_changes: clamp(
            (ew.cost || 0.5) * 0.7 +
            (ew.demand || 0.5) * 0.2 +
            base
        ),
        hiring_shifts: clamp(
            (ew.talent || 0.5) * 0.75 +
            base
        ),
        funding_shifts: clamp(
            (ew.capital || 0.5) * 0.7 +
            (revenueProfile.customer_type === 'Enterprise' ? 0.1 : 0) +
            base
        ),
        product_removals: clamp(
            (ew.distribution || 0.5) * 0.6 +
            (ew.cost || 0.5) * 0.2 +
            base
        ),
        regulatory_updates: clamp(
            (ew.regulation || 0.5) * 0.75 +
            base
        ),
        procurement_signals: clamp(
            revenueProfile.customer_type === 'Enterprise' ? 0.8 :
                revenueProfile.customer_type === 'Mid-market' ? 0.5 : 0.25
        ),
        talent_migration: clamp(
            (ew.talent || 0.5) * 0.6 +
            base
        ),
        policy_updates: clamp(
            (ew.regulation || 0.5) * 0.5 +
            (ew.cost || 0.5) * 0.2 +
            base
        ),
        market_expansion: clamp(
            (ew.demand || 0.5) * 0.6 +
            (ew.distribution || 0.5) * 0.2 +
            base
        ),
        competitive_moves: clamp(
            (ew.demand || 0.5) * 0.4 +
            (ew.distribution || 0.5) * 0.3 +
            0.2 // Always somewhat important
        )
    };
}

/**
 * Get the top N signal categories by weight.
 */
export function getTopCategories(signalWeights, count = 5) {
    return Object.entries(signalWeights)
        .sort(([, a], [, b]) => b - a)
        .slice(0, count)
        .map(([category, weight]) => ({ category, weight }));
}

function clamp(val) {
    return Math.round(Math.min(1, Math.max(0, val)) * 100) / 100;
}
