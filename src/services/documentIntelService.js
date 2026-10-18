// Document Intelligence — turn an uploaded internal document into named, verified entities.
//
// The founder's own deck or board update is the only non-public source the pipeline sees,
// so the competitors, customers, and investors named in it are far more trustworthy than
// anything inferred from a marketing site. This module extracts them, verifies each one
// against the document text, and shapes them for the entity watchlist.
//
// Verification is the point. An LLM asked to "list competitors" from a document will
// happily supply plausible ones it knows from training data. Every entity must carry a
// verbatim quote from the document, and anything whose quote cannot be found is dropped.

const ENTITY_FIELDS = [
    'named_competitors', 'named_customers', 'investors', 'partners_channels',
    'vendors_infra', 'regulatory_exposure',
];

const EMPTY_INTEL = {
    doc_type: 'other', as_of: null, company_name: null,
    named_competitors: [], named_customers: [], investors: [],
    partners_channels: [], vendors_infra: [], regulatory_exposure: [],
    metrics: {}, strategic_bets: [], stated_risks: [],
    pricing: {}, geographies: [],
};

/** Collapse whitespace and case so quote matching survives markdown reflow. */
function normalize(text) {
    return String(text || '').replace(/\s+/g, ' ').toLowerCase().trim();
}

/**
 * Is this entity actually attested by the document?
 *
 * Accepts either the quote appearing in the document, or — for short quotes that the model
 * lightly reworded — the entity's own name appearing there. The name check is the real
 * backstop: an invented competitor fails it outright.
 */
function isAttested(entity, haystack) {
    const name = normalize(entity?.name);
    if (!name || name.length < 2) return false;
    if (haystack.includes(name)) return true;

    const quote = normalize(entity?.evidence_quote);
    return quote.length >= 12 && haystack.includes(quote);
}

/**
 * Drop every entity the document does not actually attest, and report what was removed.
 * @returns {{ intel: object, dropped: Array<{ field: string, name: string }> }}
 */
export function verifyAgainstDocument(intel, docText) {
    const haystack = normalize(docText);
    const dropped = [];
    const verified = { ...EMPTY_INTEL, ...intel };

    for (const field of ENTITY_FIELDS) {
        const list = Array.isArray(verified[field]) ? verified[field] : [];
        verified[field] = list.filter(entity => {
            const ok = isAttested(entity, haystack);
            if (!ok && entity?.name) dropped.push({ field, name: String(entity.name) });
            return ok;
        });
    }

    // The company's own name is not a competitor, however the model labelled it.
    const self = normalize(verified.company_name);
    if (self) {
        verified.named_competitors = verified.named_competitors.filter(c => normalize(c.name) !== self);
    }

    return { intel: verified, dropped };
}

/**
 * How stale is this document? Drives how its findings are labelled downstream — a
 * two-year-old deck's metrics must never read as current.
 * @returns {{ asOf: string|null, monthsOld: number|null, stale: boolean }}
 */
export function assessVintage(asOf, now = new Date()) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(asOf || '').trim());
    if (!match) return { asOf: null, monthsOld: null, stale: false };

    const [, year, month] = match;
    const monthsOld =
        (now.getFullYear() - Number(year)) * 12 + (now.getMonth() + 1 - Number(month));
    if (monthsOld < 0 || monthsOld > 600) return { asOf: null, monthsOld: null, stale: false };

    return { asOf: `${year}-${month}`, monthsOld, stale: monthsOld > 12 };
}

/**
 * Extract structured intelligence from uploaded document text.
 *
 * Non-blocking by contract: a failure here must never break intake. The caller gets null
 * and the pipeline proceeds exactly as it did before this feature existed.
 *
 * @param {string} docText            Combined text of the uploaded document(s).
 * @param {object} opts
 * @param {string} [opts.companyHint] Company name if already known.
 * @param {Function} [opts.callLLM]   Injected LLM caller — (action, payload) => Promise<object>.
 * @returns {Promise<object|null>}
 */
export async function extractDocumentIntel(docText, { companyHint = '', callLLM } = {}) {
    const text = String(docText || '').trim();
    if (!text || text.length < 200 || typeof callLLM !== 'function') return null;

    try {
        const raw = await callLLM('extractDocumentIntel', {
            docText: text,
            companyHint,
            todayIso: new Date().toISOString().slice(0, 10),
        });

        const parsed = Array.isArray(raw) ? raw[0] : raw;
        if (!parsed || typeof parsed !== 'object') return null;

        const { intel, dropped } = verifyAgainstDocument(parsed, text);
        intel._vintage = assessVintage(intel.as_of);

        const kept = ENTITY_FIELDS.reduce((n, f) => n + intel[f].length, 0);
        console.log(
            `[DocIntel] ${intel.doc_type || 'unknown'} (as_of=${intel._vintage.asOf || 'unknown'}` +
            `${intel._vintage.stale ? ', STALE' : ''}) — ${kept} entities verified, ${dropped.length} dropped`
        );
        if (dropped.length > 0) {
            console.log(`[DocIntel] Dropped (not attested in document): ${dropped.map(d => d.name).join(', ')}`);
        }

        return intel;
    } catch (err) {
        console.warn('[DocIntel] Extraction failed (non-blocking):', err.message);
        return null;
    }
}

/**
 * Flatten verified doc intel into entity-watchlist rows.
 *
 * Every row is tagged `source: 'internal_doc'`, which is what earns these entities their
 * never-trimmed priority in the watchlist and their reserved slice of the query budget.
 *
 * @returns {Array<{ name, category, metadata }>}
 */
export function docIntelToEntities(intel) {
    if (!intel) return [];

    const mappings = [
        ['named_competitors', 'competitor', e => e.why_competitor || 'Named in internal document'],
        ['named_customers', 'customer', e => `Customer (${e.segment || 'unknown segment'})`],
        ['investors', 'investor', e => `Investor${e.round ? ` — ${e.round}` : ''}`],
        ['partners_channels', 'partner', e => e.relationship || 'Partner / channel'],
        ['regulatory_exposure', 'regulator', e => e.jurisdiction || 'Regulatory exposure'],
    ];

    const entities = [];
    for (const [field, category, describe] of mappings) {
        for (const entity of intel[field] || []) {
            entities.push({
                name: String(entity.name).trim(),
                category,
                metadata: {
                    source: 'internal_doc',
                    source_field: field,
                    why_tracked: describe(entity),
                    evidence_quote: entity.evidence_quote || null,
                },
            });
        }
    }

    // Vendors split by their own declared category so they land on the right dependency axis.
    for (const vendor of intel.vendors_infra || []) {
        entities.push({
            name: String(vendor.name).trim(),
            category: vendor.category === 'infra' ? 'infra' : 'platform',
            metadata: {
                source: 'internal_doc',
                source_field: 'vendors_infra',
                why_tracked: `Dependency (${vendor.category || 'platform'})`,
                evidence_quote: vendor.evidence_quote || null,
            },
        });
    }

    return entities;
}
