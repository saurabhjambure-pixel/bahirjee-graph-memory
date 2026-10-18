/**
 * Entity Watchlist Generator — Bahirjee Context Building Layer
 * 
 * Generates a structured entity watchlist from Startup_Context.
 * Entities are derived from:
 *   - dependency_map.infra_dependencies → category: "infra"
 *   - dependency_map.platform_dependencies → category: "platform"
 *   - dependency_map.regulatory_exposure → category: "regulator"
 *   - competitive_map.named_competitors → category: "competitor"
 *   - market_profile (industry bodies) → category: "industry_body"
 *
 * Limits: 10-40 entities max.
 */

import { supabase } from '../lib/supabase.js';
import { resolveDomain } from './primarySourceMapper.js';

const MAX_ENTITIES = 40;

/**
 * Generate entity watchlist from Startup_Context.
 * 
 * @param {Object} startupContext - The unified context object
 * @returns {Array} Array of { name, category, metadata }
 */
/**
 * Re-file adjacent solutions that arrived as competitors.
 *
 * generateEntityWatchlist files `adjacent_solutions` as 'adjacent' — approaches a buyer might
 * take instead ("Local Digital Agencies"), not companies. But the watchlist is built in the
 * founder's BROWSER and travels on the job, so a client running an older build ships the old
 * shape: three consecutive production runs (2026-10-02 → 10-06) carried them as `competitor`.
 * The server then spent query budget on "Zoho Inventory product shutdown" and "Local Digital
 * Agencies pricing change", and the verifier demanded evidence about things no evidence can
 * exist about. The server must not trust the shape of a list the client derived, so this is
 * applied where the run takes the context over. `source_field` is the discriminator because
 * it is what both the old and the new generator wrote.
 *
 * @returns {{ entities: Array, changed: number }}
 */
export function normalizeTrackedEntities(entities) {
    const list = Array.isArray(entities) ? entities : [];
    let changed = 0;
    const out = list.map((e) => {
        if (e?.category === 'competitor' && e?.metadata?.source_field === 'adjacent_solutions') {
            changed += 1;
            return { ...e, category: 'adjacent' };
        }
        return e;
    });
    return { entities: changed ? out : list, changed };
}

export function generateEntityWatchlist(startupContext) {
    const entities = [];
    const seenNames = new Set();

    const addEntity = (name, category, metadata = {}) => {
        if (!name || typeof name !== 'string') return;
        const normalizedName = name.trim();
        const key = normalizedName.toLowerCase();
        if (!key || key.length < 2 || seenNames.has(key)) return;
        seenNames.add(key);
        entities.push({ name: normalizedName, category, metadata });
    };

    // Entities the founder named in their own document are internally attested — carry
    // that through so downstream query allocation can prioritise them.
    const sourceOf = (entity) => (typeof entity === 'object' && entity?.source === 'internal_doc')
        ? 'internal_doc'
        : 'inferred';

    const depMap = startupContext.dependency_map || {};
    const compMap = startupContext.competitive_map || {};
    const rels = startupContext.internal_relationships || {};

    // 1. Infra dependencies → "infra"
    for (const dep of (depMap.infra_dependencies || [])) {
        const name = typeof dep === 'object' ? dep.name : dep;
        addEntity(name, 'infra', { source_field: 'infra_dependencies', source: sourceOf(dep) });
    }

    // 2. Platform dependencies → "platform"
    for (const dep of (depMap.platform_dependencies || [])) {
        const name = typeof dep === 'object' ? dep.name : dep;
        addEntity(name, 'platform', { source_field: 'platform_dependencies', source: sourceOf(dep) });
    }

    // 3. Named competitors → "competitor"
    //
    // `url` is whatever the model wrote; `resolved_url` is a homepage Exa's company index
    // actually returned during validation. Both are carried so primarySourceMapper can
    // tell them apart — they are different kinds of claim and must not collapse into one
    // field, or a guess inherits the standing of a lookup.
    for (const comp of (compMap.named_competitors || [])) {
        const name = typeof comp === 'object' ? comp.name : comp;
        const url = typeof comp === 'object' ? comp.url : null;
        const resolvedUrl = typeof comp === 'object' ? comp.resolved_url : null;
        addEntity(name, 'competitor', {
            url,
            resolved_url: resolvedUrl || null,
            why_tracked: typeof comp === 'object' ? comp.why_competitor : 'Named competitor',
            source_field: 'named_competitors',
            source: sourceOf(comp)
        });
    }

    // 4. Category peers → "competitor" (sub-category)
    for (const peer of (compMap.category_peers || [])) {
        const name = typeof peer === 'object' ? peer.name : peer;
        const url = typeof peer === 'object' ? peer.url : null;
        addEntity(name, 'competitor', {
            url,
            resolved_url: (typeof peer === 'object' ? peer.resolved_url : null) || null,
            why_tracked: typeof peer === 'object' ? peer.similarity : 'Category peer',
            source_field: 'category_peers',
            sub_category: 'peer'
        });
    }

    // 5. Adjacent solutions → "adjacent"
    //
    // NOT "competitor". These are approaches a buyer might take instead — "Traditional 3PL
    // Providers", "Logistics Consulting Firms" — not named companies. Filing them as
    // competitors made resolveDomain construct a homepage from the category name
    // (logisticsconsultingfirms.com/pricing) and made the verifier's competitor-validation
    // gate demand evidence for a thing no evidence can exist about. They earn a watchlist
    // slot for query context; they do not earn a domain.
    for (const adj of (compMap.adjacent_solutions || [])) {
        const name = typeof adj === 'object' ? adj.name : adj;
        addEntity(name, 'adjacent', {
            why_tracked: typeof adj === 'object' ? adj.approach : 'Adjacent solution',
            source_field: 'adjacent_solutions',
        });
    }

    // 6. Regulatory exposure → "regulator"
    for (const reg of (depMap.regulatory_exposure || [])) {
        const name = typeof reg === 'object' ? reg.name : reg;
        addEntity(name, 'regulator', { source_field: 'regulatory_exposure', source: sourceOf(reg) });
    }

    // 7. Major integrations → "platform"
    for (const integ of (depMap.major_integrations || [])) {
        const name = typeof integ === 'object' ? integ.name : integ;
        addEntity(name, 'platform', { source_field: 'major_integrations', sub_category: 'integration' });
    }

    // 8-10. Relationships that only an internal document reveals. A public site rarely
    // names its customers or investors, so these categories exist solely because the
    // founder uploaded a document — and they are the highest-signal entities we get.
    for (const customer of (rels.customers || [])) {
        addEntity(customer?.name, 'customer', {
            source_field: 'named_customers',
            source: 'internal_doc',
            why_tracked: `Customer (${customer?.segment || 'unknown segment'})`,
        });
    }
    for (const investor of (rels.investors || [])) {
        addEntity(investor?.name, 'investor', {
            source_field: 'investors',
            source: 'internal_doc',
            why_tracked: `Investor${investor?.round ? ` — ${investor.round}` : ''}`,
        });
    }
    for (const partner of (rels.partners || [])) {
        addEntity(partner?.name, 'partner', {
            source_field: 'partners_channels',
            source: 'internal_doc',
            why_tracked: partner?.relationship || 'Partner / channel',
        });
    }

    // Trim to MAX_ENTITIES. Internally-attested entities sort ahead of everything: the
    // founder naming a competitor in their own deck outranks any inference we made from
    // their marketing site, so those must never be the ones cut.
    if (entities.length > MAX_ENTITIES) {
        const priority = {
            competitor: 0, customer: 1, infra: 2, platform: 3,
            investor: 4, partner: 5, regulator: 6, industry_body: 7,
            // Last: an adjacent solution is a category of approach, so it is the cheapest
            // thing to lose when the watchlist has to be trimmed.
            adjacent: 8,
        };
        entities.sort((a, b) => {
            const aDoc = a.metadata?.source === 'internal_doc' ? 0 : 1;
            const bDoc = b.metadata?.source === 'internal_doc' ? 0 : 1;
            if (aDoc !== bDoc) return aDoc - bDoc;
            return (priority[a.category] ?? 8) - (priority[b.category] ?? 8);
        });
        entities.length = MAX_ENTITIES;
    }

    const fromDoc = entities.filter(e => e.metadata?.source === 'internal_doc').length;
    console.log(`[EntityWatchlist] Generated ${entities.length} entities from context (${fromDoc} from internal document)`);
    return entities;
}

/**
 * Store entity watchlist to Supabase.
 * Uses upsert to handle re-runs.
 *
 * The upsert conflict target stays (company_id, name) — a canonical_domain, when one
 * resolves, is stored ALONGSIDE the name key (v31_entity_spine.sql), not in place of it.
 * Moving the primary identity to domain-based is a larger, separate change (most entities
 * still have no resolvable domain at all — a regulator, an adjacent-solution category);
 * this only stops "Stripe" and "stripe.com" from silently opening two different rows for
 * the SAME company when a domain IS known, via canonical_domain's own unique index.
 *
 * @param {string} companyId - Client UUID
 * @param {string} contextVersionId - Context version for traceability
 * @param {Array} entities - Array of { name, category, metadata }
 * @returns {Object} { stored: number, errors: number, entityIdByName: Map<lowercased name, id> }
 */
export async function storeEntityWatchlist(companyId, contextVersionId, entities) {
    if (!supabase || !companyId || !entities?.length) {
        console.warn('[EntityWatchlist] Missing params — not stored.');
        return { stored: 0, errors: 0, entityIdByName: new Map() };
    }

    let stored = 0;
    let errors = 0;
    const entityIdByName = new Map();

    // Migration tolerance: canonical_domain is only a column from v28 onward. Without this,
    // an unmigrated database would reject EVERY upsert on this call — not just fail to gain
    // the new dedup benefit, but stop storing entities at all, which is a strictly worse
    // regression than the feature this file is adding. Same pattern
    // structuredSignalTransformer.js already uses for corroborating_urls (v17).
    let hasCanonicalDomain = true;

    for (const entity of entities) {
        try {
            // Only the two tiers primarySourceMapper already trusts enough to fetch from —
            // a 'model_claimed' or 'guessed' domain is not trustworthy enough to anchor an
            // entity's IDENTITY on. Getting this wrong merges two different companies under
            // one row; leaving it null merges nothing and just costs the dedup benefit.
            const resolved = resolveDomain(entity);
            const canonicalDomain = resolved && !UNVERIFIED_DOMAIN_CONFIDENCE.has(resolved.confidence)
                ? resolved.domain
                : null;

            const row = {
                company_id: companyId,
                context_version_id: contextVersionId,
                name: entity.name,
                category: entity.category,
                metadata: entity.metadata || {},
                canonical_domain: canonicalDomain,
                is_active: true,
                updated_at: new Date().toISOString()
            };

            let { data, error } = await supabase
                .from('tracked_entities')
                .upsert(hasCanonicalDomain ? row : (({ canonical_domain, ...rest }) => rest)(row), { onConflict: 'company_id,name' })
                .select('id, name');

            if (error?.code === 'PGRST204' && /canonical_domain/i.test(error.message || '')) {
                console.warn('[EntityWatchlist] canonical_domain unavailable (run scripts/migrations/v31_entity_spine.sql); retrying without it.');
                hasCanonicalDomain = false;
                const { canonical_domain, ...withoutDomain } = row;
                ({ data, error } = await supabase.from('tracked_entities').upsert(withoutDomain, { onConflict: 'company_id,name' }).select('id, name'));
            }

            if (error) {
                // A rejected category is the one failure worth naming precisely: the CHECK
                // and this generator drifted apart once already (customer/investor/partner
                // were emitted for a year against a constraint that never allowed them, so
                // every document-derived entity was dropped in silence).
                const hint = /category/i.test(error.message || '')
                    ? ' — run scripts/migrations/v25_entity_categories.sql'
                    : '';
                console.error(`[EntityWatchlist] Upsert error for "${entity.name}" (${entity.category}):`, error.message + hint);
                errors++;
            } else {
                stored++;
                const stored_row = Array.isArray(data) ? data[0] : data;
                if (stored_row?.id) entityIdByName.set(String(entity.name).toLowerCase().trim(), stored_row.id);
            }
        } catch (err) {
            console.error(`[EntityWatchlist] Unexpected error for "${entity.name}":`, err);
            errors++;
        }
    }

    console.log(`[EntityWatchlist] ✅ ${stored} entities stored, ${errors} errors`);
    return { stored, errors, entityIdByName };
}

// Mirrors primarySourceMapper.js's UNVERIFIED_CONFIDENCE — kept as its own constant rather
// than importing that one, because the bar for "trustworthy enough to anchor identity on" is
// deliberately the same as "trustworthy enough to fetch from" today, but the two concerns are
// allowed to diverge later without one file's rename silently changing the other's behaviour.
const UNVERIFIED_DOMAIN_CONFIDENCE = new Set(['guessed', 'model_claimed']);

/**
 * Derive relationship edges from the SAME entities generateEntityWatchlist already produced
 * (already deterministic, already trimmed to MAX_ENTITIES) — not a second walk of
 * dependency_map/competitive_map, so a relationship can never name an entity the watchlist
 * itself decided to drop.
 *
 * Every edge is "this company <relation> this entity" (see v31_entity_spine.sql's header for
 * why there is no entity-to-entity edge yet). 'adjacent' and 'industry_body' are excluded on
 * purpose: no relation in the vocabulary below honestly describes an approach-not-a-company,
 * and industry_body is declared in the schema but never emitted by generateEntityWatchlist.
 *
 * @returns {Array<{ name, relation, evidenceUrl }>}
 */
const CATEGORY_TO_RELATION = {
    competitor: 'competes_with',
    infra: 'depends_on',
    platform: 'depends_on',
    regulator: 'regulated_by',
    customer: 'customer_of',
    investor: 'invests_in',
    partner: 'partners_with',
};

export function generateEntityRelationships(entities) {
    const relations = [];
    for (const entity of entities || []) {
        // A platform entity filed via major_integrations ("Salesforce", "Slack") reads more
        // honestly as "integrates_with" than the generic "depends_on" every other platform
        // dependency gets — see generateEntityWatchlist's own major_integrations comment.
        const relation = entity.metadata?.sub_category === 'integration'
            ? 'integrates_with'
            : CATEGORY_TO_RELATION[entity.category];
        if (!relation) continue;
        relations.push({
            name: entity.name,
            relation,
            evidenceUrl: entity.metadata?.resolved_url || entity.metadata?.url || null,
        });
    }
    return relations;
}

/**
 * Store relationship edges, resolving each by name against entityIdByName — the map
 * storeEntityWatchlist returns from the SAME run's upsert, so an edge can never reference an
 * entity id from a stale run.
 *
 * Idempotent by (company_id, to_entity_id, relation) via upsert (v28's
 * uq_entity_relationships_self_edge), not append-only: re-running the same context must not
 * duplicate the same edge on every run. from_entity_id is always null here — see
 * v31_entity_spine.sql's header on why, and what widening this needs before that changes.
 *
 * @returns {Object} { stored: number, errors: number, skipped: number }
 */
export async function storeEntityRelationships(companyId, relations, entityIdByName) {
    if (!supabase || !companyId || !relations?.length || !entityIdByName?.size) {
        return { stored: 0, errors: 0, skipped: relations?.length || 0 };
    }

    const rows = [];
    let skipped = 0;
    for (const rel of relations) {
        const entityId = entityIdByName.get(String(rel.name || '').toLowerCase().trim());
        if (!entityId) { skipped++; continue; } // the entity itself failed to store — nothing to link
        rows.push({
            company_id: companyId,
            from_entity_id: null,
            to_entity_id: entityId,
            relation: rel.relation,
            evidence_url: rel.evidenceUrl || null,
            as_of: new Date().toISOString(),
        });
    }
    if (rows.length === 0) return { stored: 0, errors: 0, skipped };

    const { error, count } = await supabase
        .from('entity_relationships')
        .upsert(rows, { onConflict: 'company_id,to_entity_id,relation', count: 'exact' });

    if (error) {
        const hint = /entity_relationships/i.test(error.message || '')
            ? ' — run scripts/migrations/v31_entity_spine.sql'
            : '';
        console.error('[EntityWatchlist] Relationship upsert error:', error.message + hint);
        return { stored: 0, errors: rows.length, skipped };
    }
    console.log(`[EntityWatchlist] ✅ ${count ?? rows.length} relationship(s) stored, ${skipped} skipped (entity not stored)`);
    return { stored: count ?? rows.length, errors: 0, skipped };
}

/**
 * Retire tracked entities by name. Rows are kept (an entity's history and any edges to it
 * stay readable); only `is_active` goes false, which is what every reader filters on.
 * Best-effort: a failure leaves the entity tracked one more run, never throws.
 */
export async function deactivateTrackedEntities(companyId, names) {
    if (!supabase || !companyId || !names?.length) return { retired: 0 };
    const { data, error } = await supabase
        .from('tracked_entities')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('company_id', companyId)
        .in('name', names)
        .select('id');
    if (error) {
        console.warn('[EntityWatchlist] Could not retire stale entities:', error.message);
        return { retired: 0 };
    }
    return { retired: data?.length || 0 };
}

/**
 * Get active tracked entities for a company.
 */
export async function getTrackedEntities(companyId) {
    if (!supabase || !companyId) return [];

    const { data, error } = await supabase
        .from('tracked_entities')
        .select('*')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .order('category', { ascending: true });

    if (error) {
        console.error('[EntityWatchlist] Fetch error:', error.message);
        return [];
    }
    return data || [];
}
