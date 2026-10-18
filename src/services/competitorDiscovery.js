/**
 * Competitors the EVIDENCE found, promoted onto the watchlist.
 *
 * The watchlist is derived from the founder's own context — what the website and an LLM said
 * about who the competitors are. For Dhanda that list was Appmaker, Salla, Zoho Inventory…
 * while the run's evidence named Grexa AI, LocalTuneUp, Localith, GMB Rank Checker,
 * GBPPromote and Jio Haptik: six real competitors, all absent from the list, so the
 * competitor-validation gate read "7 of 7 unvalidated" and the next run searched for the
 * wrong companies again.
 *
 * Promotion is deliberately narrow. A name is promoted only when a VERIFIED signal in a
 * competitor category (launch, funding, hiring, layoff) is about it — the signal set has
 * already passed grounding, so a hallucinated company has no source URL to stand on. Nothing
 * here edits the founder's own list; promoted entities are tagged `source: 'evidence'` so
 * they can be told apart, capped, and never outrank what the founder or a document named.
 *
 * Pure: no network, no clock.
 */

// Only signals that are ABOUT a competitor's own behaviour. MarketExpansion and the
// tangential categories name plenty of non-competitors (Adobe, Bain, Google, ministries).
const COMPETITOR_CATEGORIES = new Set([
    'CompetitorLaunch', 'CompetitorFunding', 'CompetitorHiring', 'CompetitorLayoff',
]);

export const MAX_DISCOVERED_PER_RUN = 5;
export const MAX_EVIDENCE_ENTITIES = 8;

// An entity that is a body, a group or a category of approach is not a company to watch.
const NOT_A_COMPANY = /\b(ministry|department|government|authority|commission|association|council|bureau|agencies|providers|consultants|startups|platforms|companies|retailers)\b/i;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** "GBPPromote (TOTOSLocal One Private Limited)" → "GBPPromote". */
export function cleanEntityName(raw) {
    const name = String(raw || '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
    if (!name || name.length < 3 || name.length > 60) return null;
    if (/[\/;]/.test(name)) return null; // "A / B" is two entities or a joint programme, not one
    if (NOT_A_COMPANY.test(name)) return null;
    return name;
}

const sameEntity = (a, b) => {
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    return x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)));
};

/**
 * @param {Array}  signals          verified signals (state.analyze.signals after verify)
 * @param {Array}  trackedEntities  the watchlist as it stands
 * @param {Object} [opts]           { companyName } — never promote the founder's own company
 * @returns {Array} entities `{ name, category: 'competitor', metadata }`, strongest evidence first
 */
export function discoverCompetitors(signals, trackedEntities, { companyName = '', now = new Date().toISOString() } = {}) {
    const known = (Array.isArray(trackedEntities) ? trackedEntities : []).map(e => e?.name).filter(Boolean);
    const byName = new Map();

    for (const s of Array.isArray(signals) ? signals : []) {
        if (!COMPETITOR_CATEGORIES.has(s?.category) || !s?.source_url) continue;
        const name = cleanEntityName(s.entity_involved);
        if (!name) continue;
        if (companyName && sameEntity(name, companyName)) continue;
        if (known.some(k => sameEntity(k, name))) continue;

        const key = norm(name);
        const hit = byName.get(key) || { name, urls: new Set(), headline: s.signal_headline || '', count: 0 };
        hit.count += 1;
        hit.urls.add(s.source_url);
        byName.set(key, hit);
    }

    return [...byName.values()]
        .sort((a, b) => b.urls.size - a.urls.size || b.count - a.count)
        .slice(0, MAX_DISCOVERED_PER_RUN)
        .map(h => ({
            name: h.name,
            category: 'competitor',
            metadata: {
                source: 'evidence',
                source_field: 'evidence_discovery',
                why_tracked: h.headline || 'Named in this run\'s competitor evidence',
                evidence_urls: [...h.urls].slice(0, 3),
                signal_count: h.count,
                last_seen_at: now,
            },
        }));
}

// A promoted competitor that no run has named for this long is retired. tracked_entities is
// append-only and nothing else ever deactivates a row, so without an age-out a company that
// went quiet — or was a one-off name in a single article — would be searched for forever.
export const EVIDENCE_MAX_AGE_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When was this evidence-promoted entity last named in a run's verified evidence? */
const lastSeenOf = (e) => e?.metadata?.last_seen_at || e?.updated_at || e?.created_at || null;

export function isStaleEvidenceEntity(e, now = Date.now(), maxAgeDays = EVIDENCE_MAX_AGE_DAYS) {
    if (e?.metadata?.source !== 'evidence') return false;
    const seen = Date.parse(lastSeenOf(e));
    // No usable date means we cannot say it is old; keeping it is the cheaper mistake.
    if (!Number.isFinite(seen)) return false;
    return now - seen > maxAgeDays * DAY_MS;
}

/**
 * Stamp `last_seen_at` on every evidence-promoted entity this run's signals name again, so a
 * competitor that keeps appearing never ages out. Any category of signal counts — a rival
 * showing up in a funding story is as much "still relevant" as one launching a product.
 */
export function refreshSeenEvidence(entities, signals, now = new Date().toISOString()) {
    const names = (Array.isArray(signals) ? signals : [])
        .map(s => cleanEntityName(s?.entity_involved)).filter(Boolean);
    return (Array.isArray(entities) ? entities : []).map((e) => {
        if (e?.metadata?.source !== 'evidence') return e;
        return names.some(n => sameEntity(n, e.name))
            ? { ...e, metadata: { ...e.metadata, last_seen_at: now } }
            : e;
    });
}

/**
 * Fold previously promoted entities (rows from tracked_entities) into a watchlist, after
 * the founder's own entities and never displacing one of them. Capped, so a long history of
 * promotions cannot crowd the query budget.
 */
export function mergeEvidenceEntities(entities, stored, { now = Date.now() } = {}) {
    const base = Array.isArray(entities) ? entities : [];
    const extra = (Array.isArray(stored) ? stored : [])
        .filter(e => e?.metadata?.source === 'evidence' && e?.name && e.category === 'competitor')
        .filter(e => !isStaleEvidenceEntity(e, now))
        .filter(e => !base.some(b => sameEntity(b?.name, e.name)))
        .slice(0, MAX_EVIDENCE_ENTITIES)
        .map(e => ({ name: e.name, category: 'competitor', metadata: e.metadata }));
    return extra.length ? [...base, ...extra] : base;
}

/** Stored evidence rows old enough to retire — the caller deactivates them. */
export function staleEvidenceRows(stored, { now = Date.now() } = {}) {
    return (Array.isArray(stored) ? stored : []).filter(e => e?.is_active !== false && isStaleEvidenceEntity(e, now));
}
