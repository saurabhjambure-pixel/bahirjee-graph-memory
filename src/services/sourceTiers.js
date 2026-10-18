/**
 * Source Tiers — steer retrieval beyond press coverage.
 *
 * The entity/event query templates in queryGenerator.js are all news-shaped
 * ("hiring OR layoffs", "Series {year}"), so a run's evidence base skewed almost
 * entirely to journalism. These tiers reserve a slice of the query budget for the
 * source types a founder actually cannot get from a news feed: peer-reviewed and
 * working-paper research, analyst/industry reports, and named-practitioner analysis.
 *
 * Each tier carries its own domain allowlist, which travels with the query down to
 * the Tavily gateway as `include_domains`. That is the mechanism doing the real work —
 * the wording only helps ranking *within* the allowlisted corpus.
 *
 * A tier's `domains` is either:
 *   • an array — the same allowlist everywhere; or
 *   • an object keyed by geo (`global`/`us`/`uk`/`in`) — resolved per run from
 *     `context.operating_geography`. Government and press are the two families where
 *     the right source genuinely depends on where the founder operates: GOV.UK is
 *     noise to an Indian founder, and PIB is noise to a British one.
 *
 * Adding a tier: define it here. The bucket name (`tier_<key>`), its theme mapping and
 * its routing through flattenQueriesForTavily() are all derived from this object —
 * nothing else needs editing.
 *
 * WHAT DOES NOT BELONG HERE: sources that are databases rather than search indexes.
 * Tenders (SAM.gov, Contracts Finder, GeM) and filings (EDGAR, Companies House) are
 * query-shaped APIs; a keyword search reaches them late or not at all. Those get
 * connectors, not tiers.
 */

/**
 * Cap on the resolved allowlist. Tavily accepts 300, but it ranks *within* the
 * allowlist — a long list dilutes ranking rather than broadening reach, which is the
 * same reason each individual tier below is kept deliberately short.
 */
const MAX_RESOLVED_DOMAINS = 14;

export const SOURCE_TIERS = {
    // Peer-reviewed papers, working papers, preprints. Slow-moving but high-authority;
    // this is where a structural claim about a market gets evidence rather than opinion.
    // Peer-reviewed literature — CONDITIONAL.
    //
    // Whole fields are driven by it (biotech, materials, frontier AI) and for those it is
    // the earliest signal available. For everyone else a paper about the industry is not
    // news about the market, and this tier returned doi.org and researchgate.net hits to a
    // logistics founder — accurate, unactionable, and paid for out of a fixed budget.
    research: {
        label: 'Research',
        sourceClass: 'research',
        requiresProfile: 'research_driven',
        // Kept deliberately short: a long allowlist dilutes ranking, and Tavily
        // scores within the allowlist rather than across the open web.
        domains: [
            'arxiv.org',
            'ssrn.com',
            'nber.org',
            'semanticscholar.org',
            'researchgate.net',
            'nature.com',
            'sciencedirect.com',
            'pubmed.ncbi.nlm.nih.gov',
        ],
        templates: [
            '{industry} {vertical} empirical study OR working paper',
            '{industry} market structure OR adoption research {geo}',
        ],
    },

    // Consultancies, research houses, multilaterals. Where "industry report" content
    // lives — and where a paywalled report still ships a free executive summary.
    analyst: {
        label: 'Analyst / Industry Reports',
        sourceClass: 'analyst',
        domains: [
            'mckinsey.com',
            'bain.com',
            'bcg.com',
            'deloitte.com',
            'pwc.com',
            'kpmg.com',
            'gartner.com',
            'forrester.com',
            'idc.com',
            'cbinsights.com',
            'statista.com',
            'weforum.org',
            'oecd.org',
            'worldbank.org',
        ],
        templates: [
            '{industry} {vertical} industry report executive summary {year}',
            '{industry} market outlook OR forecast {geo} {year}',
        ],
    },

    // Practitioner analysis and opinion: essays that explain *why* a market is moving,
    // which news coverage of the same event almost never contains.
    discourse: {
        label: 'Analysis / Opinion',
        // Practitioner essays are expert analysis; they file with the analyst houses
        // rather than earning a class of their own.
        sourceClass: 'analyst',
        domains: [
            'stratechery.com',
            'ben-evans.com',
            'a16z.com',
            'sequoiacap.com',
            'nfx.com',
            'firstround.com',
            'hbr.org',
            'sloanreview.mit.edu',
            'substack.com',
        ],
        templates: [
            '{industry} strategy analysis OR essay {year}',
            'why {industry} {vertical} business model is changing',
        ],
    },

    // Buyers describing the product in their own words — the only source family that
    // reports what is wrong with a competitor rather than what they announced. G2 and
    // Capterra have no free API, so this stays a search tier rather than a connector.
    reviews: {
        label: 'Customer Reviews',
        sourceClass: 'review',
        domains: [
            'g2.com',
            'capterra.com',
            'trustpilot.com',
            'getapp.com',
            'softwareadvice.com',
            'trustradius.com',
            'apps.apple.com',
            'play.google.com',
        ],
        templates: [
            '"{entity}" review complaints OR switching away {year}',
            '{industry} software buyers churn OR switching reasons {geo} {year}',
        ],
    },

    // Policy and regulation, from the body that issued it rather than a report about it.
    // Tenders deliberately excluded — those are database-backed and get a connector.
    government: {
        label: 'Government & Policy',
        sourceClass: 'government',
        domains: {
            us: ['federalregister.gov', 'govinfo.gov', 'regulations.gov', 'ftc.gov'],
            uk: ['gov.uk', 'legislation.gov.uk', 'parliament.uk'],
            in: ['pib.gov.in', 'dpiit.gov.in', 'meity.gov.in', 'egazette.gov.in', 'india.gov.in'],
            global: ['who.int', 'europa.eu'],
        },
        templates: [
            '{industry} policy OR regulation {geo} {year}',
            '{industry} compliance requirement OR notification {geo} {year}',
        ],
    },

    // Funding, M&A and launch coverage from the outlets that actually cover the
    // founder's market. Generic search skews US — an Indian seed round is on Entrackr
    // and Inc42 long before it is anywhere Tavily's general index ranks highly.
    regional_news: {
        label: 'Startup & Business Press',
        sourceClass: 'news',
        domains: {
            us: ['techcrunch.com', 'news.crunchbase.com', 'axios.com'],
            uk: ['sifted.eu', 'uktech.news', 'ft.com'],
            in: ['yourstory.com', 'inc42.com', 'entrackr.com', 'economictimes.indiatimes.com'],
            global: ['bloomberg.com', 'fortune.com', 'reuters.com'],
        },
        templates: [
            '{industry} funding OR acquisition {geo} {year}',
            '{industry} {vertical} launch OR expansion {geo} {year}',
        ],
    },

    // Where a technical shift shows up before anyone writes about it: a release, a
    // model card, a paper with code. Patents ride along here — Google Patents is
    // well-indexed, so it needs no separate machinery.
    // Open-source and model releases — CONDITIONAL.
    //
    // Only worth a reserved slot when the company's competitive set actually publishes
    // technology. For an operations business that merely runs on software, these templates
    // search github.com for its industry name and return repositories that mention it —
    // real results, no signal, at the cost of a tier slot the run cannot get back.
    technology: {
        label: 'Technology & Open Source',
        sourceClass: 'code',
        requiresProfile: 'technical_product',
        domains: [
            'github.com',
            'huggingface.co',
            'paperswithcode.com',
            'openai.com',
            'anthropic.com',
            'ai.googleblog.com',
            'producthunt.com',
            'patents.google.com',
        ],
        templates: [
            '{industry} open source release OR model launch {year}',
            '"{entity}" patent OR technical release {year}',
        ],
    },

    // Logistics, freight and component supply — CONDITIONAL.
    //
    // Off unless the company actually moves physical things. For the SaaS and health-tech
    // companies that make up most of this product's users, freight rates and port delays
    // are unactionable, and spending reserved budget on them would displace the tiers that
    // do matter. The software analogue of a supply chain is the dependency map, and that
    // is monitored by Source Watch reading its providers' own status pages — not here.
    supply: {
        label: 'Supply Chain & Logistics',
        sourceClass: 'news',
        requiresProfile: 'physical_supply_chain',
        domains: [
            'freightos.com',
            'marinetraffic.com',
            'importyeti.com',
            'joc.com',
            'supplychaindive.com',
            'lloydslist.com',
        ],
        templates: [
            '{industry} supply chain disruption OR shortage {geo} {year}',
            '{industry} freight OR shipping cost {geo} {year}',
        ],
    },
};

/**
 * Whether a tier applies to this company at all.
 *
 * Most tiers are unconditional. A conditional tier declares `requiresProfile` and only
 * runs when the run's context says so — the point is that an inapplicable tier must not
 * merely return poor results, it must not consume the reserved budget in the first place.
 */
export function tierApplies(tier, profile = {}) {
    const requirement = SOURCE_TIERS[tier]?.requiresProfile;
    if (!requirement) return true;
    return Boolean(profile[requirement]);
}

/**
 * Derive the tier-gating profile from a pipeline context.
 *
 * Defaults to false: a company we could not classify does not get freight news. Being
 * wrong in that direction costs nothing; being wrong the other way spends reserved
 * budget on evidence the founder cannot act on.
 */
export function profileFromContext(context) {
    const dna = context?.company_dna || {};
    const model = String(dna.business_model || '').toLowerCase();
    return {
        physical_supply_chain: dna.has_physical_supply_chain === true
            || ['physical_goods', 'hardware', 'biotech'].includes(model),

        // Asked of the context prompt directly rather than inferred from `business_model`,
        // which is too coarse to carry the distinction. A 3PL whose product is an AI
        // fulfilment platform reports business_model 'software' and is indistinguishable
        // there from a developer-tools company — but its competitors publish no code, and
        // spending a reserved tier slot searching github.com for them returns exactly what
        // it did in practice: repositories that mention logistics and nothing actionable.
        //
        // Falls back to the coarse read for contexts built before these fields existed.
        // Both fall back conservatively: an unclassified company gets neither tier.
        technical_product: dna.competes_on_public_technology === true
            || (dna.competes_on_public_technology === undefined
                && model === 'software'
                && dna.has_physical_supply_chain !== true),

        research_driven: dna.research_driven === true
            || (dna.research_driven === undefined && ['biotech'].includes(model)),
    };
}

/**
 * Round-robin order for spending the tier budget — ordered by how badly each tier is
 * needed, NOT by declaration order.
 *
 * This matters because the floor (9) does not divide evenly by the tier count (7): the
 * first two tiers in rotation get their second template and the rest get one query each.
 * Left to object key order, that depth went to research and analyst — the tiers serving
 * the one domain that was already well covered — while reviews and government, the two
 * thinnest areas of the whole evidence base, got a single query apiece.
 *
 * Reviews and government lead because nothing else in the pipeline reaches a buyer's own
 * words or a regulator's own notice. Research/analyst/discourse trail because the market
 * lens they serve was already the strongest part of the report.
 */
const TIER_ROTATION = [
    'reviews',
    'government',
    'technology',
    'regional_news',
    'research',
    'analyst',
    'discourse',
];

/** Bucket key a tier's queries travel in, e.g. 'research' → 'tier_research'. */
export const bucketForTier = (tier) => `tier_${tier}`;

/** Every tier bucket name, derived — so nothing has to hand-maintain a parallel list. */
export const TIER_BUCKETS = Object.keys(SOURCE_TIERS).map(bucketForTier);

/** Tier a bucket belongs to, or null when the bucket is not a tier bucket. */
export function tierForBucket(bucket) {
    const tier = String(bucket || '').replace(/^tier_/, '');
    return bucket !== tier && SOURCE_TIERS[tier] ? tier : null;
}

/**
 * Evidence class a tier's results carry, for observations.source_class.
 * Discourse is expert analysis, so it files with the analyst houses.
 */
export function sourceClassForTier(tier) {
    return SOURCE_TIERS[tier]?.sourceClass ?? null;
}

/**
 * Parse `context.operating_geography` into the geo keys used by the tiers above.
 *
 * Free text written by an LLM, so this matches generously and never returns empty:
 * an unrecognised geography falls back to global + us, which is what the general
 * index would have given us anyway.
 */
export function parseGeoKeys(geography) {
    const text = String(geography || '').toLowerCase();
    const keys = new Set(['global']);

    if (/\b(india|indian|bharat|bengaluru|bangalore|mumbai|delhi|apac|south asia)\b/.test(text)) keys.add('in');
    if (/\b(uk|u\.k\.|britain|british|england|scotland|wales|london|united kingdom|emea|europe)\b/.test(text)) keys.add('uk');
    if (/\b(us|u\.s\.|usa|america|american|united states|north america|canada|nyc|san francisco)\b/.test(text)) keys.add('us');

    // Nothing recognised — default to the widest useful pair rather than global alone,
    // which on its own is only 2-3 domains and would starve the tier.
    if (keys.size === 1) keys.add('us');
    return keys;
}

/**
 * Domain allowlist for a tier, or null when the tier is unknown (⇒ no steering).
 *
 * Geo-keyed tiers resolve to `global` plus every geo the founder operates in, in a
 * fixed key order so two runs with the same geography always send the same allowlist.
 * Capped at MAX_RESOLVED_DOMAINS — past that the list dilutes ranking instead of
 * broadening reach.
 */
export function domainsForTier(tier, geography = null) {
    const entry = SOURCE_TIERS[tier];
    if (!entry?.domains) return null;

    if (Array.isArray(entry.domains)) {
        return entry.domains.length ? entry.domains : null;
    }

    const keys = parseGeoKeys(geography);
    const resolved = [];
    // Fixed order, not Set iteration order: the allowlist must not depend on which
    // regex matched first.
    for (const key of ['global', 'us', 'uk', 'in']) {
        if (!keys.has(key)) continue;
        for (const domain of entry.domains[key] || []) {
            if (!resolved.includes(domain)) resolved.push(domain);
        }
    }

    return resolved.length ? resolved.slice(0, MAX_RESOLVED_DOMAINS) : null;
}

/**
 * Exa `category` for a tier.
 *
 * Complements the domain allowlist rather than duplicating it: the allowlist confines
 * Tavily to a curated handful of hosts, while Exa's category searches the whole
 * academic/PDF web semantically. A relevant paper on a university domain we never
 * listed is reachable through Exa and invisible to Tavily.
 *
 * `discourse` gets no category — opinion essays are not a category Exa models, and
 * neural search over the open web is the better instrument there.
 */
const TIER_EXA_CATEGORY = {
    research: 'research paper',
    analyst: 'pdf',
    discourse: null,
    // Exa models neither review sites nor government gazettes as categories, and its
    // `news` category is broader than the regional outlets we deliberately allowlisted —
    // using it would undo the steering. All three stay Tavily-only.
    reviews: null,
    government: null,
    regional_news: null,
    // GitHub repos and model cards are exactly what this category is for, and the
    // semantic index reaches projects no allowlist would have named.
    technology: 'github',
};

export function exaCategoryForTier(tier) {
    return TIER_EXA_CATEGORY[tier] ?? null;
}

/**
 * Build the reserved depth queries, round-robin across tiers so a small floor
 * (typically 3) still reaches more than one source type.
 *
 * Returns [{ query, tier }] — the caller places these into tier buckets so the tier
 * travels to the search layer the same way `theme` already does.
 */
export function buildTierQueries({ industry, vertical, geo, year, limit, entities = [], profile = {} }) {
    if (!limit || limit <= 0) return [];

    const vars = {
        industry: industry || 'technology',
        // An empty vertical must not leave a literal "{vertical}" or a double space.
        vertical: vertical || '',
        geo: geo || 'global',
        year: String(year || new Date().getFullYear()),
    };

    // Entity-shaped templates ("{entity}" review complaints) are the whole point of the
    // reviews tier — a review search that names no product returns listicles. Rotate
    // through the tracked entities so successive rounds cover different ones.
    const names = (entities || [])
        .map(e => String(typeof e === 'object' ? e?.name : e || '').trim())
        .filter(Boolean);

    const fill = (template, round) => {
        // Drop rather than emit a broken query. Filling {entity} with '' produced
        // '"" review complaints OR switching away 2026' — quoted emptiness, which
        // Tavily answers with whatever it likes.
        if (template.includes('{entity}')) {
            if (names.length === 0) return null;
            vars.entity = names[round % names.length];
        }
        return template
            .replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '')
            .replace(/\s+/g, ' ')
            .trim();
    };

    // Explicit rotation order, with any tier not listed there appended so a newly added
    // tier still gets queries even if someone forgets to rank it.
    const tiers = [
        ...TIER_ROTATION.filter(t => SOURCE_TIERS[t]),
        ...Object.keys(SOURCE_TIERS).filter(t => !TIER_ROTATION.includes(t)),
    ].filter(t => tierApplies(t, profile));
    const out = [];
    const seen = new Set();

    // Round 0 takes each tier's first template, round 1 its second, etc. — one query
    // per tier before any tier gets a second.
    for (let round = 0; out.length < limit; round++) {
        let addedThisRound = false;

        for (const tier of tiers) {
            if (out.length >= limit) break;

            const templates = SOURCE_TIERS[tier].templates;
            if (round >= templates.length) continue;

            const query = fill(templates[round], round);
            if (!query) continue;
            const key = query.toLowerCase();
            if (seen.has(key)) continue;

            seen.add(key);
            out.push({ query, tier });
            addedThisRound = true;
        }

        // Every tier is out of templates — stop rather than spin.
        if (!addedThisRound) break;
    }

    return out;
}
