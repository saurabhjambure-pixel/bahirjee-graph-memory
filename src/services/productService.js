/**
 * Products as a research subject.
 *
 * A product run is the SAME 17-step pipeline as a company run. The only differences are
 * a `_product` overlay on the context and this query lens, which mirrors
 * `decisionService.buildDecisionQueries` and slots into the same seam in
 * `stepGenerateQueries`.
 *
 * ── Why this spends the inquiry floor ────────────────────────────────────────
 * `runTiers.js` documents at length what happens when a floor is added rather than
 * reused: the full-tier floors already claim 21 of 22 and the shallow floors 7 of 8, so
 * a new floor over-subscribes both and the run says nothing about the actual subject.
 * A product run carries no founder question, so `inquiryQueryFloor` is already free.
 * That is why `productLens` is FALSE on the decision tier — there the floor is taken.
 *
 * Pure: no network, no clock of its own, so the routing is testable without credentials.
 */

export const PRODUCT_MODE = 'product';

const MAX_LEN = 300;
const MAX_COMPETITOR_PRODUCTS = 6;

function clean(value, limit = MAX_LEN) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * The `_product` shape, clamped. Returns null when there is no name — a product without
 * one cannot produce a query that means anything, and a templated query built from an
 * empty string is worse than no query at all.
 */
export function normalizeProductProfile(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = clean(raw.name, 120);
    if (!name) return null;

    return {
        target_id: raw.target_id || null,
        name,
        category: clean(raw.category, 120),
        canonical_url: clean(raw.canonical_url, MAX_LEN),
        positioning: clean(raw.positioning, 600),
        pricing_url: clean(raw.pricing_url, MAX_LEN),
        changelog_url: clean(raw.changelog_url, MAX_LEN),
        competitor_products: [...new Set(
            (Array.isArray(raw.competitor_products) ? raw.competitor_products : [])
                .map((v) => clean(v, 120))
                .filter(Boolean)
        )].slice(0, MAX_COMPETITOR_PRODUCTS),
    };
}

/**
 * Build the product lens.
 *
 * Ordered strongest-first and truncated to `limit`, so a shallow run (floor 3) keeps the
 * three that matter rather than a random slice. Never returns more than `limit`.
 */
export function buildProductQueries({ product, context = {}, entities = [], limit = 4 }) {
    const p = normalizeProductProfile(product);
    if (!p || limit < 1) return [];

    const year = new Date().getFullYear();
    const geo = clean(context.operating_geography, 60) || 'global';
    const category = p.category || clean(context.industry, 120) || 'software';
    const name = productSearchName(p.name);

    // A named rival product beats the generic watchlist: a product run is asking "how
    // does mine compare", which only means something against another product.
    const rival = p.competitor_products[0]
        || clean(entities.find((e) => e?.category === 'competitor')?.name, 120)
        || '';

    const candidates = [
        `"${name}" review OR pricing OR alternative ${year}`,
        rival
            ? `"${rival}" vs "${name}" comparison OR feature ${year}`
            : `${category} product comparison OR alternatives ${geo} ${year}`,
        `${category} pricing change OR packaging update ${geo} ${year}`,
        `"${name}" integration OR changelog OR release ${year}`,
        `${category} buyer complaints OR switching ${geo} ${year}`,
    ];

    return candidates.filter(Boolean).slice(0, limit);
}

/**
 * The name a search engine should see. "FetoMax by CareMother" is how a founder labels a
 * product; as a quoted phrase it matches almost nothing, because no third party writes
 * it that way. "FetoMax" is the product.
 */
export function productSearchName(name) {
    const full = clean(name, 120);
    const stripped = full.replace(/\s+(?:by|from)\s+.+$/i, '').trim();
    return stripped.length >= 3 ? stripped : full;
}

const isHttpUrl = (url) => /^https?:\/\//i.test(String(url || ''));

/**
 * WHAT this run is about. One answer, read by every step that has to name the subject.
 *
 * A product run used to be a company run with a four-query lens bolted on: the express
 * pass, the competitor watchlist, the deep reads and the prompts all kept reading
 * `company_name`, so a run on "FetoMax by CareMother" searched for CareMother and never
 * read the FetoMax page. Every step that names the subject asks this instead.
 *
 * `analysisMode`, when given, must be PRODUCT_MODE for `_product` to count — the same
 * mode-and-profile rule as the product-lens gate in stepGenerateQueries, because
 * `_product` is a REUSABLE key and can reach a company run's context. Omitted, the
 * context alone decides (stepContext deletes `_product` from non-product runs).
 *
 * Pure.
 */
export function runSubject(context, { analysisMode } = {}) {
    const ctx = context || {};
    const company = clean(ctx.company_name, 120);
    const industry = clean(ctx.strategic_anchors?.operational_reality || ctx.industry, 120);
    const product = (analysisMode === undefined || analysisMode === PRODUCT_MODE)
        ? normalizeProductProfile(ctx._product)
        : null;

    if (product) {
        return {
            isProduct: true,
            name: product.name,
            searchName: productSearchName(product.name),
            maker: company,
            category: product.category || industry,
            positioning: product.positioning,
            competitors: product.competitor_products,
            canonicalUrl: product.canonical_url,
            // The product's OWN pages, most important first. Read in full on every run:
            // they are the only first-hand statement of what the product is.
            sourceUrls: [...new Set(
                [product.canonical_url, product.pricing_url, product.changelog_url].filter(isHttpUrl)
            )],
        };
    }

    return {
        isProduct: false,
        name: company,
        searchName: company,
        maker: company,
        category: industry,
        positioning: '',
        competitors: (Array.isArray(ctx.key_competitors) ? ctx.key_competitors : [])
            .map((c) => clean(typeof c === 'object' ? c?.name : c, 120))
            .filter(Boolean),
        canonicalUrl: clean(ctx.website_url, MAX_LEN),
        sourceUrls: [],
    };
}

/**
 * The product's own pages as deep-read candidates, pinned ahead of anything search found.
 *
 * Nothing in the pipeline used to read `_product.canonical_url` — the page the founder
 * gave as "this is the product" was never fetched. Capped at a third of the read budget
 * (at least one), so a shallow run's three reads are not all spent on the founder's own
 * site.
 */
export function subjectDeepReadCandidates(subject, limit) {
    if (!subject?.isProduct || !(limit >= 1)) return [];
    const n = Math.min(subject.sourceUrls.length, Math.max(1, Math.floor(limit / 3)));
    return subject.sourceUrls.slice(0, n).map((url, i) => ({
        url,
        title: i === 0 ? `${subject.name} — product page` : null,
        // Same theme as the product lens (QUERY_BUCKET_THEMES.product_lens).
        theme: 'customer_shifts',
        query: `${subject.name} — the product's own page`,
        // The maker describing its own product: self-attesting, exactly like a company's
        // own pricing page under Source Watch.
        sourceClass: 'primary_company',
        queryIdx: -1,
    }));
}

/**
 * The watchlist a product run's deterministic queries rotate over: the product's rivals
 * first, then everything the company already tracks.
 *
 * generateContextAwareQueries spends most of a run's budget naming competitor entities,
 * least-used first with ties kept in list order — so whoever leads this list is who the
 * run asks about. For a product run that must be the products it competes with, not the
 * company's corporate rivals. Pure; never mutates `entities`.
 */
export function withProductRivals(entities = [], rivals = []) {
    const list = Array.isArray(entities) ? entities : [];
    const known = new Set(list.map((e) => clean(e?.name, 120).toLowerCase()).filter(Boolean));
    const added = [];
    for (const raw of Array.isArray(rivals) ? rivals : []) {
        const name = clean(raw, 120);
        const key = name.toLowerCase();
        if (!name || known.has(key)) continue;
        known.add(key);
        added.push({ name, category: 'competitor', metadata: { source: 'product_rival' } });
    }
    return [...added, ...list];
}
