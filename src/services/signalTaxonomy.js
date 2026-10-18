/**
 * Signal Taxonomy — the single source of truth for signal categories and the
 * display sections they roll up into.
 *
 * This list used to live in four places that disagreed with each other: the prompt in
 * promptUtils.js, SECTION_CATEGORIES in reportVerifier.js, groupMap in ReportWorkspace.jsx,
 * and CATEGORY_TO_THEME in signalToShiftTransformer.js — the last of which had drifted so
 * far it mapped categories the prompt had not emitted in months, so every signal fell to
 * the 'general' theme and the client-side shift fallback clustered nothing.
 *
 * Two separate taxonomies meet here and must not be confused:
 *   • CATEGORY  — what the model assigns per signal, chosen by WHO ACTED (see promptUtils).
 *   • SECTION   — how the founder is shown those signals. Many categories, few sections.
 *
 * Adding a category: add it to SIGNAL_CATEGORIES, give it a SECTION_MAP home and a
 * CATEGORY_THEMES entry. Nothing else needs editing — the prompt block, the verifier's
 * coverage check and the report's grouping are all derived from here. Retiring one: remove it
 * from SIGNAL_CATEGORIES and SECTION_MAP, and add it to LEGACY_CATEGORY_SECTIONS so stored
 * reports still render it.
 */

import { formatCategoryName } from '../utils/formatters.js';

/**
 * Every category the signal prompt is allowed to emit, in prompt order.
 * The model is shown this list verbatim; `buildSignals` renders it from here.
 *
 * Ordered opportunity-first: the model reads this list top-down, and the categories that
 * point at the founder's next revenue, partner or funder should be the first it considers.
 */
export const SIGNAL_CATEGORIES = [
    'DemandSignal', 'PartnershipOpportunity', 'FundingOpportunity', 'CustomerShift',
    'SupplierShift', 'CompetitorFunding', 'CompetitorHiring', 'CompetitorLayoff',
    'CompetitorLaunch', 'MarketExpansion', 'CapitalClimate', 'TalentAvailable',
    'RegulatoryChange', 'ComplianceShift', 'IndustryMomentum', 'ProductEvolution',
    'TangentialTrend',
];

/**
 * The categories that describe a door the founder could walk through. Only these carry the
 * structured `opportunity` block (counterparty, trigger, deadline, amount, fit, unknowns) —
 * see opportunityFields.js, which strips it from everything else.
 */
export const OPPORTUNITY_CATEGORIES = ['DemandSignal', 'PartnershipOpportunity', 'FundingOpportunity'];

/** The intro section. Not a category bucket — it holds the brief's insights. */
export const INTRO_SECTION = 'Strategic Overview';

/**
 * Display section titles. Import these — never re-type a title string. "Market & Demand"
 * was hard-coded in four places outside this file, which is what made renaming it a hunt.
 */
export const SECTIONS = Object.freeze({
    OPPORTUNITIES: 'Opportunities',
    CUSTOMERS: 'Customers',
    COMPETITION: 'Competition',
    FUNDING: 'Funding Opportunities',
    SUPPLY: 'Vendors & Supply',
    REGULATORY: 'Regulatory',
    TALENT: 'Talent',
    ADJACENT: 'Adjacent & Macro',
});

/**
 * Display section → the categories that feed it.
 *
 * Sections are cut by the ACTOR'S RELATIONSHIP TO THE FOUNDER, not by topic:
 *   Opportunities  — a prospective buyer or an ecosystem partner opened a door
 *   Customers      — the customers and segments the founder already serves changed
 *   Competition    — a competitor acted, including its funding and its market entry
 *   Funding        — a funder opened a door; plus the capital climate the founder raises into
 *   Vendors & Supply — something the founder buys or depends on changed
 *
 * "Market & Demand" used to hold demand, customer change, competitor market entry and
 * industry growth together, which buried the one thing a founder reads it for — where the
 * next deal comes from. Industry growth with no buyer attached is context, not a door, so
 * it lives in Adjacent & Macro.
 */
export const SECTION_MAP = {
    [SECTIONS.OPPORTUNITIES]: ['DemandSignal', 'PartnershipOpportunity'],
    [SECTIONS.CUSTOMERS]: ['CustomerShift'],
    [SECTIONS.COMPETITION]: ['CompetitorFunding', 'CompetitorHiring', 'CompetitorLayoff', 'CompetitorLaunch', 'MarketExpansion'],
    [SECTIONS.FUNDING]: ['FundingOpportunity', 'CapitalClimate'],
    [SECTIONS.SUPPLY]: ['SupplierShift'],
    [SECTIONS.REGULATORY]: ['RegulatoryChange', 'ComplianceShift'],
    [SECTIONS.TALENT]: ['TalentAvailable'],
    [SECTIONS.ADJACENT]: ['TangentialTrend', 'IndustryMomentum', 'ProductEvolution'],
};

/**
 * Categories the prompt no longer emits but stored reports still contain (signals are saved
 * as JSONB, so every past report keeps its original labels). Kept OUT of SECTION_MAP so the
 * verifier's coverage check and the prompt never see them, and resolved by
 * sectionForCategory so a report written last month still renders every signal it had.
 */
export const LEGACY_CATEGORY_SECTIONS = Object.freeze({
    // Other companies' rounds — what the founder called "funding news of others". It is
    // exactly what CapitalClimate now carries, so it renders in that line.
    FundingActivity: SECTIONS.FUNDING,
    PartnershipSignal: SECTIONS.OPPORTUNITIES,
});

/** Render order. Opportunities first: it is the section that points at revenue. */
export const SECTION_PRIORITY = {
    [INTRO_SECTION]: 0,
    [SECTIONS.OPPORTUNITIES]: 1,
    [SECTIONS.CUSTOMERS]: 2,
    [SECTIONS.COMPETITION]: 3,
    [SECTIONS.FUNDING]: 4,
    [SECTIONS.SUPPLY]: 5,
    [SECTIONS.REGULATORY]: 6,
    [SECTIONS.TALENT]: 7,
    [SECTIONS.ADJACENT]: 8,
};

/**
 * Sections whose absence is worth telling the founder about — and worth one retrieval
 * retry. Funding/Customers/Supply are genuinely quiet for most companies in most weeks,
 * so flagging them would train the founder to ignore the disclosure.
 */
export const CRITICAL_SECTIONS = [SECTIONS.OPPORTUNITIES, SECTIONS.COMPETITION];

/**
 * A secondary group rendered AFTER a section's main signals, under its own small heading.
 * The Funding section is opportunities first; the capital climate is context for when to
 * raise, never a door, so it must not be read as one.
 */
export const SECTION_TRAILING_GROUPS = Object.freeze({
    [SECTIONS.FUNDING]: {
        label: 'Capital climate',
        categories: ['CapitalClimate', 'FundingActivity'],
        emptyPrimaryNote: "No open funding call surfaced in this run's evidence.",
    },
});

/**
 * Category → clustering theme, used by the client-side shift fallback
 * (signalToShiftTransformer) when the DB-backed v6 engines have no history yet.
 *
 * Deliberately diverges from SECTION_MAP in one place: CompetitorFunding and CapitalClimate
 * both theme as `funding_momentum`. Display groups by actor, but velocity detection wants
 * every round in one bucket — "capital is accelerating in this space" is the pattern worth
 * surfacing, and splitting it by actor hides it. A FundingOpportunity is a door, not
 * momentum, so it gets its own theme.
 *
 * Legacy categories keep their themes so stored reports still cluster.
 */
export const CATEGORY_THEMES = {
    DemandSignal: 'demand_movement',
    PartnershipOpportunity: 'partnership_activity',
    FundingOpportunity: 'funding_opportunity',
    CustomerShift: 'customer_behavior',
    SupplierShift: 'supplier_dynamics',
    CompetitorFunding: 'funding_momentum',
    CompetitorHiring: 'competitor_activity',
    CompetitorLayoff: 'competitor_activity',
    CompetitorLaunch: 'competitor_activity',
    MarketExpansion: 'market_expansion',
    CapitalClimate: 'funding_momentum',
    TalentAvailable: 'talent_dynamics',
    RegulatoryChange: 'regulatory_landscape',
    ComplianceShift: 'regulatory_landscape',
    IndustryMomentum: 'industry_trends',
    ProductEvolution: 'product_innovation',
    TangentialTrend: 'adjacent_trends',
    // Legacy — no longer emitted.
    FundingActivity: 'funding_momentum',
    PartnershipSignal: 'partnership_activity',
};

// Built once: category → section, so lookups are not an O(sections) scan per signal.
const CATEGORY_TO_SECTION = Object.freeze(
    Object.entries(SECTION_MAP).reduce((acc, [section, categories]) => {
        for (const category of categories) acc[category] = section;
        return acc;
    }, {})
);

/** Which display section a signal belongs to, or null when it maps to none. */
export function sectionForCategory(category) {
    const cat = String(category || '').trim();
    if (!cat) return null;
    return CATEGORY_TO_SECTION[cat] || LEGACY_CATEGORY_SECTIONS[cat] || null;
}

/** Clustering theme for a category. Unknown categories fall to 'general'. */
export function themeForCategory(category) {
    return CATEGORY_THEMES[String(category || '').trim()] || 'general';
}

/** True when the string is a category the prompt is allowed to emit. */
export function isSignalCategory(category) {
    return SIGNAL_CATEGORIES.includes(String(category || '').trim());
}

/** Render order for a section title; unranked sections sort to the end. */
export function sectionPriority(title) {
    return SECTION_PRIORITY[title] ?? 999;
}

/**
 * Build the report's flat per-category sections from a report's signals.
 *
 * Extracted from IntelligenceDashboard's `sections` memo so that it, and the grouping
 * below it, can be tested and driven by a harness. During a live run this runs against a
 * report assembled from the streaming slice rather than a persisted row; the two are the
 * same shape on purpose, so there is exactly one section-building path.
 *
 * @param {Object|null} report - persisted or live-assembled report
 * @param {string} filter - the founder's in-report search term
 */
export function buildReportSections(report, filter = '') {
    if (!report) return [];
    const search = String(filter || '').toLowerCase();

    // Fallback: if signals are empty/missing but card_summary exists, build from cards.
    const signals = (report.signals && report.signals.length > 0)
        ? report.signals
        : (Array.isArray(report.card_summary) && report.card_summary.length > 0
            ? report.card_summary.map(card => ({
                ...card.payload,
                category: card.section_key || card.card_type,
                signal_headline: card.title
            }))
            : []);

    const grouped = {};
    for (const s of signals) {
        const cat = s?.category || 'General';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(s);
    }

    const allInsights = report.brief?.insights || [];
    const filteredInsights = allInsights.filter(ins => !search || ins.text?.toLowerCase().includes(search));

    const sections = [{
        id: 'intro',
        title: INTRO_SECTION,
        type: 'intro',
        insights: filteredInsights,
        meta: { count: filteredInsights.length }
    }];

    for (const cat of Object.keys(grouped)) {
        const matches = grouped[cat].filter(s => !search || (
            s.signal_headline?.toLowerCase().includes(search) ||
            s.signal_details?.toLowerCase().includes(search) ||
            s.strategic_implication?.toLowerCase().includes(search) ||
            s.the_move?.toLowerCase().includes(search) ||
            s.so_what_for_you?.toLowerCase().includes(search) ||
            s.intelligence_assessment?.toLowerCase().includes(search) ||
            s.category?.toLowerCase().includes(search) ||
            s.title?.toLowerCase().includes(search)
        ));

        // Hide empty sections when a search is active.
        if (search && matches.length === 0) continue;

        sections.push({
            // Derived from the category, NOT a loop index. Index ids renumber every time a
            // new category appears — constant during a live run — and the founder's
            // selected tab would silently start showing different content.
            id: `sec-${String(cat).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'general'}`,
            title: formatCategoryName(cat),
            // The raw category travels with the section so grouping keys off it directly
            // instead of re-matching a formatted title string.
            category: cat,
            meta: { count: matches.length },
            subsections: matches
        });
    }

    return sections;
}

/**
 * Regroup the report's flat per-category sections into the display sections a founder
 * actually navigates.
 *
 * This lived inline in ReportWorkspace, where it could not be tested. It is pure, it is
 * derived entirely from SECTION_MAP, and it enforces one invariant that a live run makes
 * load-bearing:
 *
 *   for every returned section, meta.count === subsections.length
 *
 * A count and its content come out of the same merge, so if they can ever disagree the
 * merge is wrong. The nav renders the count and the page renders the content; when those
 * two drift the founder gets a section promising 11 signals and showing none — which reads
 * as broken rather than as loading. Counting the merged array rather than summing the
 * inputs makes the two physically the same number.
 *
 * A category with no SECTION_MAP home (the model does emit some, e.g. CompetitorAward)
 * passes through as its own section rather than being dropped.
 *
 * @param {Array} sections - the flat sections built from signals, each { id, title,
 *   category, meta: { count }, subsections: [] }
 * @returns {Array} display sections, sorted by SECTION_PRIORITY
 */
export function groupSectionsForDisplay(sections) {
    const grouped = {};
    const passthrough = [];

    for (const section of Array.isArray(sections) ? sections : []) {
        if (!section) continue;

        // Group on the raw category the parent attaches. Falls back to matching the
        // formatted title so a section built by older code still lands in its group.
        const group = sectionForCategory(section.category)
            ?? Object.keys(SECTION_MAP).find(key =>
                SECTION_MAP[key].some(cat => formatCategoryName(cat) === section.title));

        if (!group) {
            passthrough.push(section);
            continue;
        }

        if (!grouped[group]) {
            grouped[group] = {
                id: `group-${group.toLowerCase()}`,
                title: group,
                meta: { count: 0 },
                subsections: [],
                grouped: true
            };
        }
        if (Array.isArray(section.subsections)) {
            grouped[group].subsections.push(...section.subsections);
        }
    }

    // The count IS the content length. Never a separate tally that can drift from it.
    for (const g of Object.values(grouped)) g.meta.count = g.subsections.length;

    return [...Object.values(grouped), ...passthrough]
        .sort((a, b) => sectionPriority(a.title) - sectionPriority(b.title));
}

/**
 * Split a display section's signals into its main list and its trailing group (see
 * SECTION_TRAILING_GROUPS). A stable partition: order within each half is preserved.
 *
 * @returns {{ primary: Array, trailing: Array, trailingLabel: string|null, emptyPrimaryNote: string|null }}
 */
export function splitSectionSignals(sectionTitle, signals) {
    const list = Array.isArray(signals) ? signals : [];
    const group = SECTION_TRAILING_GROUPS[sectionTitle];
    if (!group) return { primary: list, trailing: [], trailingLabel: null, emptyPrimaryNote: null };
    const isTrailing = s => group.categories.includes(String(s?.category || '').trim());
    const trailing = list.filter(isTrailing);
    // The note says "no call surfaced", which claims the run looked for calls. Only a run that
    // emits CapitalClimate looked (that category arrived with the opportunity prompt); a legacy
    // report whose trailing group is only FundingActivity could not have, so it says nothing.
    const runLooked = trailing.some(s => String(s?.category || '').trim() === 'CapitalClimate');
    return {
        primary: list.filter(s => !isTrailing(s)),
        trailing,
        trailingLabel: group.label,
        emptyPrimaryNote: runLooked ? group.emptyPrimaryNote : null,
    };
}

/**
 * The category block shown to the model, four per line as the prompt has always
 * formatted it. Derived so the prompt can never drift from SIGNAL_CATEGORIES.
 */
export function renderCategoryBlock(perLine = 4) {
    const lines = [];
    for (let i = 0; i < SIGNAL_CATEGORIES.length; i += perLine) {
        lines.push(SIGNAL_CATEGORIES.slice(i, i + perLine).join(' | '));
    }
    return lines.join('\n');
}
