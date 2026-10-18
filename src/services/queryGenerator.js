/**
 * Context-Aware Query Generator — Bahirjee Context Building Layer
 * 
 * Generates targeted Tavily queries from entity watchlist + signal weights.
 * This is the PRIMARY query generator (deterministic, no LLM dependency).
 * Falls back to Gemini query generation if this produces too few queries.
 * 
 * Rules:
 *   - Each query targets a specific entity + signal category
 *   - High-weight categories get more queries
 *   - No generic queries (e.g., "AI industry trends")
 *   - Budget capped by MAX_QUERIES (mirrored as MAX_QUERY_COUNT in intelligenceService.js)
 */

import { buildTierQueries, TIER_BUCKETS } from './sourceTiers.js';
import { RUN_TIERS } from './runTiers.js';
import { runSubject } from './productService.js';

// Raised from 14 alongside the source-tier expansion (3 tiers → 7). The extra queries
// are spent entirely on the tier floor below; the entity/demand allocation is unchanged
// in absolute terms and slightly better off, because the tier floor no longer has to be
// carved out of a 14-query budget. Costs one more search wave (SEARCH_WAVE_SIZE 4, so 6
// waves not 4) — stepSearch is cursored, so that is one extra worker invocation.
//
// The budget is now per-run (see runTiers.js) — this export is the FULL-tier value, kept
// because callers and tests import it as the headline number.
export const MAX_QUERIES = RUN_TIERS.full.maxQueries;

// Fine-grade query templates per signal category.
//
// Theme is now carried explicitly alongside each query (see QUERY_BUCKET_THEMES in
// intelligenceService.js), so template wording no longer steers observation.theme.
// Keywords below are for *retrieval quality* only — change them freely.
const QUERY_TEMPLATES = {
    // Maps mainly to customer_shifts (pricing/terms changes -> buyer/customer behavior).
    pricing_changes: [
        '"{entity}" pricing change OR price increase {year} in {geo} for customers',
        '"{entity}" new pricing tier launch {year} {geo} customer adoption',
        '"{entity}" price increase announcement {year} {geo} buyer buying signals'
    ],
    // Maps to talent_signals.
    hiring_shifts: [
        '"{entity}" hiring OR layoffs {year} in {geo} engineering OR talent',
        '"{entity}" engineering team expansion {year} {geo} hiring',
        '"{entity}" executive hire departure {year} {geo} hiring engineer'
    ],
    // Maps to funding_intel.
    funding_shifts: [
        '"{entity}" Series {year} venture capital raised in {geo} capital',
        '"{entity}" venture capital capital raise {year} in {geo} raised',
        '"{entity}" equity financing round {year} in {geo} venture capital raised'
    ],
    // Maps to competitor_intel.
    product_removals: [
        '"{entity}" product shutdown OR deprecation {year} in {geo} competitor',
        '"{entity}" feature removal OR API change {year} {geo} competitor',
        '"{entity}" strategic pivot product deprecation {year} {geo} competitor'
    ],
    // Maps to regulatory_lens.
    regulatory_updates: [
        '"{regulatory_term}" regulation AND compliance update {year} in {geo} for {industry}',
        '"{regulatory_term}" new regulation AND compliance requirements {year} {geo}',
        '"{industry}" regulatory change {geo} {year} compliance'
    ],
    // Maps to customer_shifts.
    procurement_signals: [
        '"{entity}" enterprise contract win {year} in {geo} buyer',
        '"{entity}" government procurement {year} in {geo} customer demand',
        '{industry} IT budget allocation {geo} {year} buyer buying signals'
    ],
    // Maps to talent_signals.
    talent_migration: [
        '"{entity}" key talent departure {year} in {geo} engineer availability',
        '"{industry}" engineering talent movement {geo} {year} hiring',
        '"{entity}" senior leadership changes {year} {geo} talent'
    ],
    // Maps to regulatory_lens.
    policy_updates: [
        '"{industry}" policy regulatory change {geo} {year} compliance requirements',
        '"{industry}" regulatory compliance update {year} {geo}',
        '"{industry}" compliance requirements {geo} {year}'
    ],
    // Maps to market_expansion + industry_momentum (and theme-wise -> customer_shifts).
    market_expansion: [
        '"{entity}" entering {geo} market {year} customer adoption OR buying',
        '"{entity}" partnership OR integration in {geo} {year} buyer demand',
        '{industry} market growth adoption {geo} {year} customer buying signals'
    ],
    // Maps to competitor_intel (and theme-wise -> competitor_intel via the "competitor" keyword).
    competitive_moves: [
        '"{entity}" competitor strategic partnership announcement in {geo} {year}',
        '"{entity}" competing with "{competitor_name}" market share growth {industry} in {geo} {year} competitor',
        '{industry} competitor moves market positioning in {geo} {year} competitor'
    ],
    // ── Categories below only fire when an internal document named the entities. ──
    // A public site almost never names its customers or investors, so these queries are
    // unreachable without an upload — and they are the ones a founder cannot run for
    // themselves: what is happening TO the accounts their revenue depends on.
    customer_health: [
        '"{entity}" layoffs OR restructuring OR cost cutting {year} {geo} buyer budget',
        '"{entity}" acquisition OR merger {year} {geo} customer',
        '"{entity}" vendor consolidation OR procurement freeze {year} buyer buying signals'
    ],
    investor_signals: [
        '"{entity}" new fund OR portfolio strategy {year} venture capital raised',
        '"{entity}" portfolio company {industry} investment {year} capital',
        '"{entity}" investment thesis {industry} {year} venture capital'
    ],
    partner_risk: [
        '"{entity}" partnership change OR program termination {year} {geo} competitor',
        '"{entity}" channel strategy OR reseller program {year} {geo}',
        '"{entity}" acquires OR launches competing product {year} competitor'
    ]
};

// Reserved slice of the query budget for entities the founder named in their own
// document. Without this floor, weight-based allocation can spend every query on
// inferred entities and never search the competitors the founder actually named —
// which was the behaviour before document intel existed.
const DOC_QUERY_FLOOR = 5;

// Reserved slice for the source tiers (research papers, analyst reports, practitioner
// analysis, customer reviews, government/policy, regional press, technology releases).
// Every template above is event-shaped, so without a floor the entire budget goes to
// press coverage and the report has no structural evidence behind it. Carved out before
// weight-based distribution, exactly like DOC_QUERY_FLOOR.
//
// 9, not 7: buildTierQueries round-robins, so a floor equal to the tier count would give
// each tier exactly one query and leave the second template of every tier unreachable.
// 9 lets the first two tiers in rotation reach depth while still touching all seven.
const TIER_QUERY_FLOOR = 9;

// Reserved slice for DEMAND intelligence — what is happening to the founder's own
// customers and where new business is appearing.
//
// Every other template family searches for competitors, the industry, or entities the
// founder named. None of them ever searched for a *customer segment*, so the market
// lens could only ever return industry news. `customer_segments` (and its pain_points)
// were extracted at context time and used purely as prompt decoration.
//
// ABSORPTIVE, not additive: doc-named customers already consume DOC_QUERY_FLOOR slots
// and are themselves demand intelligence, so they count toward this floor first. Only
// the shortfall is topped up from inferred segments. With DOC(5) + TIER(9) already
// reserved out of 22, a naive +3 would leave 5 queries for everything else.
const DEMAND_QUERY_FLOOR = 3;

// Reserved slice for the founder's own High-sensitivity bets. Two, not more: bets are the
// founder's beliefs rather than evidence, and a run that spends a third of its budget
// confirming what they already think is not intelligence.
const ASSUMPTION_QUERY_FLOOR = 2;

/**
 * Turn a stated bet into a search for evidence that would BREAK it.
 *
 * Deliberately falsification-shaped. "Enterprise buyers will increase SaaS budgets" as a
 * literal query returns articles agreeing with it; what the founder needs is whatever
 * would tell them it is wrong, which is the same instinct as the brief's
 * "what could change our view".
 */
function buildAssumptionQueries({ assumptions = [], industry, geo, year, limit }) {
    if (!limit || limit <= 0) return [];
    return (Array.isArray(assumptions) ? assumptions : [])
        .filter(a => a?.statement && String(a.sensitivity).toLowerCase() === 'high')
        .slice(0, limit)
        .map(a => `${String(a.statement).slice(0, 120)} ${industry} ${geo} evidence against ${year}`.replace(/\s+/g, ' ').trim());
}

// Demand templates target BUYING BEHAVIOUR, not industry news. The distinction is the
// whole point: "{industry} market growth" returns a trend piece; "{segment} procurement
// budget" returns evidence that someone is about to spend money.
const DEMAND_TEMPLATES = {
    // Segment-level: works with no document upload, driven by inferred customer_segments.
    segment: [
        '"{segment}" procurement OR budget OR RFP {geo} {year} buyer buying signals',
        '"{segment}" vendor selection OR software spending {geo} {year} customer demand',
        '"{segment}" expansion OR new funding {geo} {year} buying signals',
    ],
    // Pain-point-led: surfaces buyers actively looking for the problem this company solves.
    pain: [
        '"{segment}" "{pain_point}" solution evaluating OR replacing {year} buyer',
        '{industry} buyers struggling with {pain_point} {geo} {year} customer pain',
    ],
    // Persona-led: budget-holder behaviour for the decision maker this company sells to.
    persona: [
        '{persona} budget priorities OR spending {industry} {geo} {year} buying signals',
    ],
};

/** Normalize customer_segments — entries may be `{segment, pain_points}` or bare strings. */
function normalizeSegments(customerSegments) {
    if (!Array.isArray(customerSegments)) return [];
    return customerSegments
        .map(s => (typeof s === 'object' && s !== null)
            ? { segment: String(s.segment || '').trim(), painPoints: Array.isArray(s.pain_points) ? s.pain_points.filter(Boolean).map(String) : [] }
            : { segment: String(s || '').trim(), painPoints: [] })
        .filter(s => s.segment.length > 1);
}

/**
 * Build the reserved demand queries.
 *
 * Round-robins segment → pain → persona so a single segment cannot consume the whole
 * floor, and so a founder with one segment still gets pain- and persona-led coverage.
 *
 * @returns {string[]} query strings (empty when there is nothing to search for)
 */
function buildDemandQueries({ segments, persona, industry, geo, year, limit }) {
    if (!limit || limit <= 0) return [];

    const fill = (template, vars) => template
        .replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '')
        .replace(/\s+/g, ' ')
        .trim();

    const base = { industry, geo, year: String(year) };
    const out = [];
    const seen = new Set();

    const push = (template, vars) => {
        if (out.length >= limit) return;
        const query = fill(template, { ...base, ...vars });
        // A template whose variable was missing collapses to a generic string — the exact
        // failure mode this whole change exists to remove. Drop it rather than emit it.
        if (!query || /\{|\}/.test(query)) return;
        const key = query.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(query);
    };

    // Per segment, build an ordered wishlist most-specific-first. A pain-point query
    // names the segment AND the problem, so it outranks the generic procurement query
    // for the same segment. Ordering matters more than it looks: the floor is small
    // (typically 3), so with several segments only each wishlist's first entry is ever
    // reached — running all segment templates before any pain template meant pain
    // points were never searched at all.
    const wishlists = segments.map(({ segment, painPoints }) => {
        const items = [];
        const pains = painPoints.slice(0, 2);
        const maxLen = Math.max(DEMAND_TEMPLATES.segment.length, pains.length);
        for (let i = 0; i < maxLen; i++) {
            if (pains[i] && DEMAND_TEMPLATES.pain[i % DEMAND_TEMPLATES.pain.length]) {
                items.push([DEMAND_TEMPLATES.pain[i % DEMAND_TEMPLATES.pain.length], { segment, pain_point: pains[i] }]);
            }
            if (DEMAND_TEMPLATES.segment[i]) {
                items.push([DEMAND_TEMPLATES.segment[i], { segment }]);
            }
        }
        return items;
    });

    // Round-robin across segments so one segment cannot consume the whole floor.
    const deepest = Math.max(0, ...wishlists.map(w => w.length));
    for (let round = 0; round < deepest && out.length < limit; round++) {
        for (const wishlist of wishlists) {
            if (out.length >= limit) break;
            const item = wishlist[round];
            if (item) push(item[0], item[1]);
        }
    }

    // Persona-led budget behaviour, only if the segment passes left room.
    if (persona) {
        for (const template of DEMAND_TEMPLATES.persona) {
            push(template, { persona });
        }
    }

    return out;
}

/**
 * Generate context-aware queries from entity watchlist and signal weights.
 *
 * @param {Object} params
 * @param {Array} params.entities - Tracked entities [{ name, category, metadata }]
 * @param {Object} params.signalWeights - Signal category weights
 * @param {Object} params.marketProfile - { industry, category, vertical, target_persona }
 * @param {string} params.geography - Primary geography focus
 * @param {string} params.companyName - Target company name
 * @param {Array} params.customerSegments - context.customer_segments [{ segment, pain_points }]
 * @returns {Object} Categorized queries: { category: [query strings] }
 */
export function generateContextAwareQueries({
    entities = [],
    signalWeights = {},
    marketProfile = {},
    geography = 'Global',
    companyName = '',
    customerSegments = [],
    // Gates conditional tiers. Empty means "unknown", which reads as false everywhere —
    // an unclassified company does not get freight news. See profileFromContext().
    tierProfile = {},
    // Research depth for this run. Named `runBudget` because a local `budget` already
    // exists in the distribution loop below. Defaults to the full tier so every existing
    // caller — the browser path, the monolith, cron — is unchanged.
    runBudget = RUN_TIERS.full,
    // The founder's own stated bets. Only High-sensitivity ones reach retrieval — see
    // buildAssumptionQueries.
    strategicAssumptions = []
}) {
    const year = new Date().getFullYear();
    const industry = marketProfile.industry || 'technology';
    const geo = geography || 'global';

    // Sort signal categories by weight (highest first)
    const sortedCategories = Object.entries(signalWeights)
        .sort(([, a], [, b]) => b - a);

    const isFromDoc = (e) => e.metadata?.source === 'internal_doc';
    const docEntities = entities.filter(isFromDoc);

    // Carve the internal-document floor out of the budget BEFORE weight-based
    // distribution, so those queries cannot be competed away by a high-weight category.
    const docBudget = docEntities.length > 0 ? Math.min(runBudget.docQueryFloor, docEntities.length, runBudget.maxQueries) : 0;

    // ── Stated bets ─────────────────────────────────────────────────────────────
    // Carved out before weight distribution, like the other floors. A bet is the founder
    // telling us exactly what they need watched; leaving it to compete with generic
    // competitor news means it never gets searched, which is how `strategic_assumptions`
    // stayed a write-only field for its entire existence.
    const assumptionQueries = buildAssumptionQueries({
        assumptions: strategicAssumptions,
        industry,
        geo,
        year,
        limit: Math.min(ASSUMPTION_QUERY_FLOOR, Math.max(0, runBudget.maxQueries - docBudget)),
    });

    // Same treatment for the non-news source tiers.
    const tierBudget = Math.min(runBudget.tierQueryFloor, Math.max(0, runBudget.maxQueries - docBudget - assumptionQueries.length));
    const tierQueries = buildTierQueries({
        industry,
        vertical: marketProfile.vertical,
        geo,
        year,
        limit: tierBudget,
        profile: tierProfile,
        // Competitors first: the entity-shaped tier templates (reviews, patents) are
        // asking "what do buyers say about them", which only means something for a
        // rival. Falls back to the whole watchlist when no competitor is known.
        entities: entities.filter(e => e.category === 'competitor').length
            ? entities.filter(e => e.category === 'competitor')
            : entities,
    });

    // Separate entities by type
    const competitors = entities.filter(e => e.category === 'competitor');
    const infraEntities = entities.filter(e => e.category === 'infra');
    const platformEntities = entities.filter(e => e.category === 'platform');
    const regulators = entities.filter(e => e.category === 'regulator');
    const customers = entities.filter(e => e.category === 'customer');

    // ── Demand floor (absorptive) ────────────────────────────────────────────────
    // Doc-named customers already get queries through customer_health inside the doc
    // floor, and those ARE demand intelligence — so they satisfy this floor first and
    // only the shortfall is spent on inferred-segment queries.
    const docCustomerCount = customers.filter(isFromDoc).length;
    const demandShortfall = Math.max(0, runBudget.demandQueryFloor - docCustomerCount);
    const demandBudget = Math.min(demandShortfall, Math.max(0, runBudget.maxQueries - docBudget - assumptionQueries.length - tierQueries.length));
    const demandQueries = buildDemandQueries({
        segments: normalizeSegments(customerSegments),
        persona: marketProfile.target_persona,
        industry,
        geo,
        year,
        limit: demandBudget,
    });

    const queryBudget = distributeQueryBudget(
        sortedCategories,
        runBudget.maxQueries - docBudget - assumptionQueries.length - tierQueries.length - demandQueries.length
    );
    const investors = entities.filter(e => e.category === 'investor');
    const partners = entities.filter(e => e.category === 'partner');

    const generatedQueries = {};
    const usedQueryKeys = new Set();

    // How many queries each entity has already anchored, SHARED across categories.
    //
    // Without this, every category began its entity list at index 0 and stopped at its own
    // budget — which is ~1 once the tier, doc and demand floors are taken. Ten categories
    // therefore spent ten queries naming the same first competitor, and competitors 2..N
    // were never named in any query at all. The verifier then reported "10 of 12 tracked
    // competitors have no supporting evidence", which was true and unavoidable: no query
    // had ever asked about them.
    //
    // Ordering by usage makes the budget rotate. Doc-named entities still win the first
    // round (they break ties at equal usage), but nothing gets a second query until
    // everything has had a first.
    const entityUsage = new Map();
    const timesUsed = (e) => entityUsage.get(e?.name) || 0;

    for (const [category, budget] of Object.entries(queryBudget)) {
        if (budget <= 0) continue;

        const templates = QUERY_TEMPLATES[category] || [];
        if (templates.length === 0) continue;

        const queries = [];

        // Select entities most relevant to this category
        let relevantEntities;
        switch (category) {
            case 'pricing_changes':
            case 'product_removals':
                relevantEntities = [...competitors, ...infraEntities, ...platformEntities];
                break;
            case 'hiring_shifts':
            case 'talent_migration':
                relevantEntities = [...competitors];
                break;
            case 'funding_shifts':
            case 'competitive_moves':
            case 'market_expansion':
                relevantEntities = [...competitors];
                break;
            case 'regulatory_updates':
            case 'policy_updates':
                relevantEntities = regulators.length > 0 ? regulators : competitors;
                break;
            case 'procurement_signals':
                relevantEntities = competitors;
                break;
            case 'customer_health':
                relevantEntities = customers;
                break;
            case 'investor_signals':
                relevantEntities = investors;
                break;
            case 'partner_risk':
                relevantEntities = partners;
                break;
            default:
                relevantEntities = [...competitors, ...infraEntities];
        }

        // Least-covered entity first, with the founder's own named entities winning ties.
        // Usage leads and doc-provenance breaks the tie, not the other way round: sorting
        // by provenance first would let a single doc-named entity take every category's
        // slot, which is the same starvation this cursor exists to end.
        relevantEntities = [...relevantEntities].sort(
            (a, b) => timesUsed(a) - timesUsed(b) || Number(isFromDoc(b)) - Number(isFromDoc(a))
        );

        // Generate queries up to budget
        let queryCount = 0;
        for (const entity of relevantEntities) {
            if (queryCount >= budget) break;

            // Indexed by how often this entity has been asked about, so a second query on
            // the same entity asks a different question rather than repeating the first.
            const template = templates[timesUsed(entity) % templates.length];
            const query = fillTemplate(template, {
                entity: entity.name,
                year: String(year),
                industry,
                geo,
                regulatory_term: entity.category === 'regulator' ? entity.name : industry,
                competitor_name: competitors[0]?.name || 'competitors'
            });

            // Deduplicate
            const queryKey = query.toLowerCase().trim();
            if (!usedQueryKeys.has(queryKey)) {
                usedQueryKeys.add(queryKey);
                queries.push(query);
                queryCount++;
                entityUsage.set(entity.name, timesUsed(entity) + 1);
            }
        }

        // If no entities matched, create industry-level query
        if (queries.length === 0 && budget > 0) {
            const fallbackTemplate = templates[0];
            const query = fillTemplate(fallbackTemplate, {
                entity: companyName || industry,
                year: String(year),
                industry,
                geo,
                regulatory_term: industry,
                competitor_name: 'competitors'
            });
            queries.push(query);
        }

        if (queries.length > 0) {
            generatedQueries[category] = queries;
        }
    }

    // ── Spend the reserved internal-document budget ──────────────────────────────
    // One query per named entity, round-robin across categories so a deck listing six
    // competitors and two customers does not spend the whole floor on competitors.
    if (docBudget > 0) {
        const categoryFor = {
            competitor: 'competitive_moves',
            customer: 'customer_health',
            investor: 'investor_signals',
            partner: 'partner_risk',
            infra: 'pricing_changes',
            platform: 'product_removals',
            regulator: 'regulatory_updates',
        };

        // Interleave by category so the floor is spread across relationship types.
        const byCategory = new Map();
        for (const entity of docEntities) {
            if (!byCategory.has(entity.category)) byCategory.set(entity.category, []);
            byCategory.get(entity.category).push(entity);
        }
        const ordered = [];
        for (let round = 0; ordered.length < docEntities.length; round++) {
            for (const list of byCategory.values()) {
                if (list[round]) ordered.push(list[round]);
            }
        }

        let spent = 0;
        for (const entity of ordered) {
            if (spent >= docBudget) break;

            const category = categoryFor[entity.category] || 'competitive_moves';
            const templates = QUERY_TEMPLATES[category];
            if (!templates) continue;

            const query = fillTemplate(templates[spent % templates.length], {
                entity: entity.name,
                year: String(year),
                industry,
                geo,
                regulatory_term: entity.category === 'regulator' ? entity.name : industry,
                competitor_name: competitors[0]?.name || 'competitors',
            });

            const queryKey = query.toLowerCase().trim();
            if (usedQueryKeys.has(queryKey)) continue;
            usedQueryKeys.add(queryKey);

            if (!generatedQueries[category]) generatedQueries[category] = [];
            generatedQueries[category].push(query);
            spent++;
        }

        console.log(`[QueryGenerator] Reserved ${spent}/${docBudget} queries for internal-document entities`);
    }

    // ── Spend the reserved source-tier budget ────────────────────────────────────
    // Each tier gets its own category so the tier (and therefore its domain allowlist)
    // survives flattening and reaches the search layer.
    for (const { query, tier } of tierQueries) {
        const key = query.toLowerCase().trim();
        if (usedQueryKeys.has(key)) continue;
        usedQueryKeys.add(key);

        const category = `tier_${tier}`;
        if (!generatedQueries[category]) generatedQueries[category] = [];
        generatedQueries[category].push(query);
    }
    if (tierQueries.length > 0) {
        console.log(`[QueryGenerator] Reserved ${tierQueries.length} queries for non-news source tiers`);
    }

    // ── Spend the reserved demand budget ─────────────────────────────────────────
    for (const query of demandQueries) {
        const key = query.toLowerCase().trim();
        if (usedQueryKeys.has(key)) continue;
        usedQueryKeys.add(key);
        if (!generatedQueries.demand_signals) generatedQueries.demand_signals = [];
        generatedQueries.demand_signals.push(query);
    }
    if (demandQueries.length > 0) {
        console.log(`[QueryGenerator] Reserved ${demandQueries.length} queries for demand intelligence (${docCustomerCount} doc-named customers absorbed)`);
    }

    // ── Spend the reserved bet budget ────────────────────────────────────────────
    // Themed as `assumption_lens`, which needs a matching entry in QUERY_BUCKET_THEMES
    // (intelligenceService.js) or the bucket is silently dropped before search — the
    // documented fate of competitor_discovery and adjacent_trends.
    for (const query of assumptionQueries) {
        const key = query.toLowerCase().trim();
        if (usedQueryKeys.has(key)) continue;
        usedQueryKeys.add(key);
        if (!generatedQueries.assumption_lens) generatedQueries.assumption_lens = [];
        generatedQueries.assumption_lens.push(query);
    }
    if (assumptionQueries.length > 0) {
        console.log(`[QueryGenerator] Reserved ${assumptionQueries.length} queries for the founder's stated bets`);
    }

    const totalQueries = Object.values(generatedQueries).flat().length;
    console.log(`[QueryGenerator] Generated ${totalQueries} queries across ${Object.keys(generatedQueries).length} categories`);
    // Entity coverage, logged BEFORE the run spends anything. This is the cheapest place
    // to see the starvation that used to be invisible until the verifier reported it at
    // the end: "1 of 12 entities covered" is the same defect, five minutes earlier and
    // several dollars cheaper.
    const trackedCount = entities.length;
    if (trackedCount > 0) {
        const covered = entityUsage.size;
        console.log(
            `[QueryGenerator] Entity coverage: ${covered}/${trackedCount} tracked entities named in a query` +
            (covered < trackedCount ? ` — uncovered: ${entities.filter(e => !entityUsage.has(e.name)).map(e => e.name).join(', ')}` : '')
        );
    }

    return generatedQueries;
}

/**
 * Convert categorized queries to flat array format for Tavily.
 * Groups into the expected categories: competitor_intel, market_trends, technology_shifts, regulatory
 */
export function flattenQueriesForTavily(categorizedQueries) {
    // Return the exact schema expected by runSignalGeneration():
    // competitor_intel, talent_signals, funding_intel, customer_shifts,
    // regulatory_lens, market_expansion, industry_momentum
    const flat = {
        competitor_intel: [],
        talent_signals: [],
        funding_intel: [],
        customer_shifts: [],
        regulatory_lens: [],
        market_expansion: [],
        industry_momentum: [],
        // Source tiers — kept as their own buckets so the tier survives to the search
        // layer and can be turned into an include_domains allowlist. Derived from
        // SOURCE_TIERS so a new tier needs no edit here.
        ...Object.fromEntries(TIER_BUCKETS.map(b => [b, []])),
        // Demand intelligence — segment/account buying behaviour. Its own bucket so it
        // reaches the Opportunities section instead of being folded into a theme.
        demand_signals: []
    };

    for (const [category, queries] of Object.entries(categorizedQueries)) {
        switch (category) {
            case 'competitive_moves':
            case 'product_removals':
                flat.competitor_intel.push(...queries);
                break;
            case 'hiring_shifts':
            case 'talent_migration':
                flat.talent_signals.push(...queries);
                break;
            case 'funding_shifts':
                flat.funding_intel.push(...queries);
                break;
            case 'pricing_changes':
            case 'procurement_signals':
            // Named-customer health is a demand signal — it belongs with customer shifts.
            case 'customer_health':
                flat.customer_shifts.push(...queries);
                break;
            case 'investor_signals':
                flat.funding_intel.push(...queries);
                break;
            case 'partner_risk':
                flat.competitor_intel.push(...queries);
                break;
            case 'regulatory_updates':
            case 'policy_updates':
                flat.regulatory_lens.push(...queries);
                break;
            case 'demand_signals':
                flat.demand_signals.push(...queries);
                break;
            case 'market_expansion': {
                // Split across the two buckets so both exist, and let theme-mapping
                // (customer/buyer/adoption keywords) drive observation.theme.
                const mid = Math.ceil(queries.length / 2);
                flat.market_expansion.push(...queries.slice(0, mid));
                flat.industry_momentum.push(...queries.slice(mid));

                // Also populate customer_shifts so the pipeline doesn’t need to fall back.
                flat.customer_shifts.push(...queries);
                break;
            }
            default:
                // Pass tier buckets through untouched — routing them into a theme bucket
                // would strip the tier and with it the domain steering.
                if (Object.prototype.hasOwnProperty.call(flat, category) && category.startsWith('tier_')) {
                    flat[category].push(...queries);
                    break;
                }
                // If a new signal category is added but not mapped, prefer keeping it in
                // customer_shifts so it can still drive useful themes.
                flat.customer_shifts.push(...queries);
        }
    }

    return flat;
}

/**
 * Distribute query budget across categories based on weights.
 */
function distributeQueryBudget(sortedCategories, totalBudget) {
    const budget = {};
    const totalWeight = sortedCategories.reduce((sum, [, w]) => sum + w, 0);

    if (totalWeight === 0) {
        // Even distribution
        const each = Math.floor(totalBudget / sortedCategories.length);
        sortedCategories.forEach(([cat]) => budget[cat] = each);
        return budget;
    }

    let remaining = totalBudget;
    for (const [category, weight] of sortedCategories) {
        const allocation = Math.max(1, Math.round((weight / totalWeight) * totalBudget));
        budget[category] = Math.min(allocation, remaining);
        remaining -= budget[category];
        if (remaining <= 0) break;
    }

    return budget;
}

/**
 * Fill a query template with variables.
 */
function fillTemplate(template, vars) {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
        result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return result;
}

/**
 * The express query set — what a run can search before it knows anything it did not
 * already have.
 *
 * The founder confirms `company_name`, `industry` and `key_competitors` on the review
 * screen, and `stepDiscoverCompetitors` early-returns when competitors are already set.
 * So at the moment of confirmation a run already holds everything these queries need: no
 * LLM call, no competitor discovery, no entity resolution. That is what lets the first
 * grounded signals exist ~60s in rather than ~2.5 minutes.
 *
 * This is the same shape as `stepGenerateQueries`' long-standing fallback branch, lifted
 * here so the two cannot drift.
 *
 * A product run's context also carries `_product` (stepContext guarantees it is there
 * only in product mode). Then the pass is about the PRODUCT: its reception, its rivals,
 * its category. It used to search `"<company>" competitors` regardless — a FetoMax run
 * asked who competes with CareMother.
 *
 * @param {Object} context - the confirmed company context
 * @param {number} limit - how many to return (RUN_TIERS[tier].expressQueries)
 * @returns {string[]} deterministic, deduped, non-empty queries
 */
export function buildExpressQueries(context, limit = RUN_TIERS.full.expressQueries) {
    const ctx = context || {};
    const company = String(ctx.company_name || '').trim();
    const industry = String(
        ctx.strategic_anchors?.operational_reality || ctx.industry || 'technology'
    ).trim();
    const region = String(ctx.operating_geography || '').trim();
    const year = new Date().getFullYear();
    const inRegion = region ? ` ${region}` : '';

    const competitors = (Array.isArray(ctx.key_competitors) ? ctx.key_competitors : [])
        .map(c => (typeof c === 'object' ? c?.name : c))
        .map(n => String(n || '').trim())
        .filter(Boolean);

    const subject = runSubject(ctx);

    // Ordered by what a founder would want first from a thin, fast pass: what the named
    // rivals just did, then money moving in the category, then the rule changes that
    // reprice everything.
    const candidates = subject.isProduct
        ? [
            `"${subject.searchName}" review OR pricing OR launch ${year}`,
            subject.competitors[0]
                ? `"${subject.competitors[0]}" vs "${subject.searchName}" ${year}`
                : `"${subject.searchName}" alternatives OR competitors ${year}`,
            subject.category && `${subject.category} product launch OR pricing ${year}${inRegion}`,
            subject.competitors[1] && `"${subject.competitors[1]}" news OR launch ${year}`,
            `"${subject.searchName}" customers OR adoption OR deployment ${year}`,
        ].filter(Boolean)
        : [
            competitors[0] && `"${competitors[0]}" news OR announcement OR launch ${year}`,
            company && `"${company}" competitors OR alternatives ${year}`,
            competitors[1] && `"${competitors[1]}" funding OR partnership ${year}`,
            industry && `${industry} funding OR acquisition ${year}${inRegion}`,
            industry && `${industry} regulation OR compliance change ${year}${inRegion}`,
            company && `"${company}" customers OR reviews ${year}`,
        ].filter(Boolean);

    const max = Math.max(0, Number(limit) || 0);
    const seen = new Set();
    const out = [];
    for (const q of candidates) {
        // Checked BEFORE the push: testing after it meant a limit of 0 still returned one.
        if (out.length >= max) break;
        const key = q.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(q);
    }
    return out;
}
