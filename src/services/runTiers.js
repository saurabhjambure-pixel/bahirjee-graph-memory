/**
 * Run tiers — how much research a run is allowed to do.
 *
 * The commercial mechanic is that the free tier buys LESS RESEARCH, not less display.
 * A shallow run produces the complete brief structure — what changed, what we read from
 * it, how confident we are, what would change our view — on a thinner evidence base, and
 * says exactly what a full run would have resolved. That is honest, it is ~⅓ of the cost,
 * and it is faster, which matters most on a stranger's first visit.
 *
 * The alternative (run at full depth, then blur some sections) pays full price for output
 * nobody sees, and hides the parts of the report that make it worth paying for.
 *
 * ⚠️  The tier is decided SERVER-SIDE from the run reservation and is never read from a
 *     request body. See `reserveFounderRun` in lib/handlers/intelligence.js.
 */

/**
 * `expressQueries` is ADDITIVE, deliberately.
 *
 * The express step runs a handful of deterministic queries before the main plan so the
 * founder sees grounded signals in ~60s instead of ~2.5 minutes. They cannot come OUT of
 * `maxQueries`: the floors below are re-derived per tier and already claim 21 of 22 on
 * full and 7 of 8 on shallow, so deducting would over-subscribe both — which is the exact
 * failure the next comment exists to prevent. The real cost is 2-3 extra searches; LLM
 * spend is unchanged because `maxObservations` still binds what reaches the model.
 */

/**
 * Query floors are the subtle part.
 *
 * The full-tier floors were each sized against a 22-query budget and sum to 17
 * (DOC 5 + TIER 9 + DEMAND 3), leaving 5 to weight-based distribution. Reused verbatim
 * at 8 queries they would over-subscribe the entire budget more than twice over — the
 * source tiers alone would eat every slot and the run would say nothing about the
 * question the user actually asked.
 *
 * So the shallow floors are re-derived, not scaled: 3 for the inquiry (the founder's own
 * question is the single most valuable thing to spend a thin budget on), 2 for source
 * tiers, 1 each for documents and demand. That is 7 of 8, leaving 1 to weight.
 */
export const RUN_TIERS = {
    shallow: {
        name: 'shallow',
        maxQueries: 8,
        maxDeepReads: 3,
        searchResultsPerQuery: 4,
        maxObservations: 70,
        maxSummarySignals: 20,
        sourceWatch: false,
        connectors: false,
        inquiryQueryFloor: 3,
        // The product lens spends inquiryQueryFloor. False where that floor is already
        // claimed (decision) or the run is Agenda-driven rather than subject-driven (daily).
        productLens: true,
        tierQueryFloor: 2,
        docQueryFloor: 1,
        demandQueryFloor: 1,
        expressQueries: 2,
    },
    full: {
        name: 'full',
        maxQueries: 22,
        maxDeepReads: 8,
        searchResultsPerQuery: 6,
        maxObservations: 200,
        maxSummarySignals: 55,
        sourceWatch: true,
        connectors: true,
        inquiryQueryFloor: 4,
        // The product lens spends inquiryQueryFloor. False where that floor is already
        // claimed (decision) or the run is Agenda-driven rather than subject-driven (daily).
        productLens: true,
        tierQueryFloor: 9,
        docQueryFloor: 5,
        demandQueryFloor: 3,
        expressQueries: 3,
    },

    /**
     * The daily ladder's pursue rung. Roughly a tenth of a full run.
     *
     * ⚠️ REGISTERED HERE BECAUSE THIS OBJECT IS THE REGISTRY.
     * `configureIntelligenceRuntime({ budget })` resolves what it is given BY NAME through
     * `resolveRunTier`, and unknown names fall back to `full`. A budget object defined
     * anywhere else and passed in is therefore silently ignored — which is exactly what
     * happened: the daily pursue was written against a `daily` object living in
     * dailyPlan.js, and every firing ran at 22 queries and 200 observations instead of 4
     * and 30. Nothing threw. It was a seven-fold overspend on a timer.
     *
     * If you need a new budget, add it to this object. Do not define one elsewhere.
     *
     * Floors are small because the daily and decision paths supply their own query list and
     * skip `generate_queries` entirely — but they are set rather than omitted, so a future
     * caller that does run the generator cannot over-subscribe.
     */
    daily: {
        name: 'daily',
        maxQueries: 4,
        maxDeepReads: 2,
        searchResultsPerQuery: 4,
        maxObservations: 30,
        maxSummarySignals: 6,
        sourceWatch: true,
        connectors: false,
        inquiryQueryFloor: 2,
        // The product lens spends inquiryQueryFloor. False where that floor is already
        // claimed (decision) or the run is Agenda-driven rather than subject-driven (daily).
        productLens: false,
        tierQueryFloor: 1,
        docQueryFloor: 0,
        demandQueryFloor: 0,
        expressQueries: 0,
    },

    /**
     * A decision session. More than a daily pursuit because a founder is making a real
     * choice on it; far less than a full run because they are sitting there waiting.
     */
    decision: {
        name: 'decision',
        maxQueries: 8,
        maxDeepReads: 4,
        searchResultsPerQuery: 5,
        maxObservations: 60,
        maxSummarySignals: 20,
        sourceWatch: false,
        connectors: false,
        inquiryQueryFloor: 4,
        // The product lens spends inquiryQueryFloor. False where that floor is already
        // claimed (decision) or the run is Agenda-driven rather than subject-driven (daily).
        productLens: false,
        tierQueryFloor: 2,
        docQueryFloor: 1,
        demandQueryFloor: 0,
        expressQueries: 0,
    },
};

// Frozen: a budget is a ceiling, and a step that can raise its own ceiling does not have
// one. Every tier, not just the ones added later — `budget()` hands the same object to every
// spend site in the pipeline, so a single mutation anywhere silently re-prices the run.
for (const tier of Object.values(RUN_TIERS)) Object.freeze(tier);
Object.freeze(RUN_TIERS);

export const DEFAULT_RUN_TIER = 'full';

/** Unknown or missing names resolve to `full` — cron and admin runs never carry a tier. */
export function resolveRunTier(name) {
    return RUN_TIERS[name] || RUN_TIERS[DEFAULT_RUN_TIER];
}

export function isShallowTier(name) {
    return resolveRunTier(name).name === 'shallow';
}

/**
 * What a full run would have added, in the founder's terms.
 *
 * This is the paywall copy, so it must be specific and true rather than a generic
 * upsell — the whole argument is that Bahirjee is honest about the limits of its own
 * evidence. Every line names something the shallow run demonstrably did not do.
 *
 * Returns [] for a full run, which is what lets the UI render the same component for
 * both tiers with no CTA on the paid side.
 */
export function depthGapsFor(tierName, { skippedWatch = false, skippedConnectors = false } = {}) {
    const tier = resolveRunTier(tierName);
    if (tier.name !== 'shallow') return [];

    const full = RUN_TIERS.full;
    // Express queries are additive, so the honest number is the total a run actually
    // spends. This is the one surface whose whole argument is that Bahirjee is straight
    // about the limits of its own evidence; an off-by-express count here is a lie in the
    // paywall.
    const fullSearches = full.maxQueries + (full.expressQueries || 0);
    const tierSearches = tier.maxQueries + (tier.expressQueries || 0);
    const gaps = [
        `${fullSearches} searches instead of ${tierSearches}, across every source tier — research, filings, analyst notes, reviews, regional press.`,
        `${full.maxDeepReads} full-text reads instead of ${tier.maxDeepReads}. A review or analyst note is close to worthless as a snippet.`,
    ];
    if (skippedWatch) {
        gaps.push("Direct checks of the companies' own pricing, changelog, careers and status pages — changes only visible on the primary source.");
    }
    if (skippedConnectors) {
        gaps.push('Live tenders, regulatory filings and social engagement, which search engines do not surface.');
    }
    return gaps;
}
