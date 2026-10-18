/**
 * Primary Source Mapper — Bahirjee Context Building Layer
 * 
 * For each tracked entity, generates primary tracking source URLs.
 * Primary sources are crawled directly and weighted higher than secondary sources.
 * 
 * Source types per entity category:
 *   - infra/competitor/platform: pricing, changelog, careers, press/blog
 *   - regulator: regulatory publications
 *   - industry_body: publications, reports
 */

import { supabase } from '../lib/supabase.js';

// `status` becomes a legal source_type only with v21_status_sources.sql. Detected once
// per session so a database that hasn't migrated still stores everything else.
let statusSourceTypeAvailable = true;

// Known domain mappings for common entities
const KNOWN_DOMAINS = {
    // Cloud / Infra
    'aws': 'aws.amazon.com', 'amazon web services': 'aws.amazon.com',
    'gcp': 'cloud.google.com', 'google cloud': 'cloud.google.com',
    'azure': 'azure.microsoft.com', 'microsoft azure': 'azure.microsoft.com',
    'openai': 'openai.com', 'anthropic': 'anthropic.com',
    'vercel': 'vercel.com', 'supabase': 'supabase.com',
    'firebase': 'firebase.google.com', 'mongodb': 'mongodb.com',
    'redis': 'redis.io', 'cloudflare': 'cloudflare.com',
    'digitalocean': 'digitalocean.com', 'heroku': 'heroku.com',
    'netlify': 'netlify.com', 'fly.io': 'fly.io',
    // Platforms
    'stripe': 'stripe.com', 'twilio': 'twilio.com',
    'salesforce': 'salesforce.com', 'hubspot': 'hubspot.com',
    'shopify': 'shopify.com', 'slack': 'slack.com',
    'github': 'github.com', 'atlassian': 'atlassian.com',
};

// Source page patterns
const SOURCE_PATTERNS = {
    pricing: ['/pricing', '/plans'],
    changelog: ['/changelog', '/releases', '/whats-new'],
    careers: ['/careers', '/jobs', '/join-us'],
    press: ['/blog', '/news', '/press', '/newsroom'],
    api_docs: ['/docs', '/api', '/developers'],
};

/**
 * Status pages for the providers a software company actually depends on.
 *
 * This is the software supply chain. A freight-rate feed is meaningless to a SaaS
 * business, but "the model provider you route every request through had four incidents
 * this month" is a dependency risk the founder can act on — and it appears nowhere in
 * news coverage until it is a national outage.
 *
 * Explicit URLs because the convention is not reliable: AWS uses health.aws.amazon.com,
 * Google Cloud uses a /products path. A wrong guess costs a fetch and is retired by
 * Source Watch after MAX_CONSECUTIVE_FAILURES, but a right answer costs nothing.
 */
const KNOWN_STATUS_URLS = {
    'aws.amazon.com': 'https://health.aws.amazon.com/health/status',
    'cloud.google.com': 'https://status.cloud.google.com',
    'azure.microsoft.com': 'https://azure.status.microsoft/en-us/status',
    'openai.com': 'https://status.openai.com',
    'anthropic.com': 'https://status.anthropic.com',
    'stripe.com': 'https://status.stripe.com',
    'twilio.com': 'https://status.twilio.com',
    'supabase.com': 'https://status.supabase.com',
    'vercel.com': 'https://www.vercel-status.com',
    'github.com': 'https://www.githubstatus.com',
    'cloudflare.com': 'https://www.cloudflarestatus.com',
    'slack.com': 'https://slack-status.com',
    'shopify.com': 'https://www.shopifystatus.com',
    'firebase.google.com': 'https://status.firebase.google.com',
    'mongodb.com': 'https://status.mongodb.com',
    'digitalocean.com': 'https://status.digitalocean.com',
    'heroku.com': 'https://status.heroku.com',
    'netlify.com': 'https://www.netlifystatus.com',
    'salesforce.com': 'https://status.salesforce.com',
    'atlassian.com': 'https://status.atlassian.com',
};

/**
 * Domains we have no external confirmation for. A URL the model wrote belongs here with
 * the outright guesses: both are unverified claims, and treating one as fact because it
 * arrived formatted as a URL is how dead rows accumulate.
 */
const UNVERIFIED_CONFIDENCE = new Set(['guessed', 'model_claimed']);

/** Status page URL for a domain, or null when we have no reasonable candidate. */
function statusUrlForDomain(domain, confidence) {
    if (KNOWN_STATUS_URLS[domain]) return KNOWN_STATUS_URLS[domain];
    // Only guess from a domain we actually observed. Guessing a status subdomain on top
    // of an unverified domain compounds two unknowns into a near-certain 404.
    if (UNVERIFIED_CONFIDENCE.has(confidence)) return null;
    return `https://status.${domain.replace(/^www\./, '')}`;
}

/**
 * Generate primary source URLs for a list of tracked entities.
 * 
 * @param {Array} entities - Tracked entity objects with { id, name, category, metadata }
 * @returns {Array} Array of { entity_id, source_type, url }
 */
export function mapPrimarySources(entities) {
    const sources = [];

    for (const entity of entities) {
        const entitySources = generateSourcesForEntity(entity);
        sources.push(...entitySources);
    }

    console.log(`[PrimarySourceMapper] Generated ${sources.length} source URLs for ${entities.length} entities`);
    return sources;
}

/**
 * Generate source URLs for a single entity.
 */
function generateSourcesForEntity(entity) {
    const sources = [];
    const resolved = resolveDomain(entity);

    if (!resolved) return sources;

    const { domain, confidence } = resolved;
    const baseUrl = `https://${domain}`;
    const entityId = entity.id;

    switch (entity.category) {
        case 'competitor':
        case 'infra':
        case 'platform':
            // Track pricing, changelog, careers, press for these categories.
            // An unverified domain gets only the two pages worth the fetch if it happens
            // to land — generating five dead URLs per wrong domain is how entity_sources
            // filled up with rows nothing could ever read.
            for (const [sourceType, paths] of Object.entries(SOURCE_PATTERNS)) {
                if (sourceType === 'api_docs' && entity.category !== 'infra') continue;
                if (UNVERIFIED_CONFIDENCE.has(confidence) && !['pricing', 'changelog'].includes(sourceType)) continue;

                const path = paths[0]; // Use primary path
                sources.push({
                    entity_id: entityId,
                    entity_name: entity.name,
                    source_type: sourceType === 'press' ? 'press' : sourceType,
                    url: `${baseUrl}${path}`,
                    domain_confidence: confidence
                });
            }

            // Status pages only for the things the company *runs on*. A competitor's
            // outage is their problem; an infra or platform provider's outage is the
            // founder's. This is the software equivalent of a supply-chain disruption.
            if (entity.category === 'infra' || entity.category === 'platform') {
                const statusUrl = statusUrlForDomain(domain, confidence);
                if (statusUrl) {
                    sources.push({
                        entity_id: entityId,
                        entity_name: entity.name,
                        source_type: 'status',
                        url: statusUrl,
                        domain_confidence: KNOWN_STATUS_URLS[domain] ? 'known' : 'guessed'
                    });
                }
            }
            break;

        case 'regulator':
            sources.push({
                entity_id: entityId,
                entity_name: entity.name,
                source_type: 'regulatory',
                url: baseUrl
            });
            break;

        case 'industry_body':
            sources.push({
                entity_id: entityId,
                entity_name: entity.name,
                source_type: 'press',
                url: `${baseUrl}/publications`
            });
            break;
    }

    return sources;
}

/**
 * Resolve a domain for an entity.
 *
 * Returns { domain, confidence } in descending order of how much the domain is actually
 * known to exist:
 *
 *   'known'         — the curated KNOWN_DOMAINS table.
 *   'observed'      — a homepage an index returned for this entity (metadata.resolved_url,
 *                     written by validateCompetitorViaExa).
 *   'model_claimed' — a URL the LLM emitted alongside the entity. Plausible, unverified.
 *   'guessed'       — a `${name}.com` construction.
 *
 * The middle two used to be one tier. Collapsing them let a model-invented URL earn the
 * word "observed" and, with it, the full four-page treatment — which is how
 * delhivery.com/changelog and ecomexpress.in/pricing came to sit in entity_sources. Only
 * a domain something actually returned may be called observed; anything the model wrote
 * gets the same conservative treatment as a guess.
 *
 * Exported for entityWatchlistGenerator.js's canonical_domain resolution (v28): the same
 * confidence tiers apply there — only 'known'/'observed' are trustworthy enough to anchor
 * an entity's identity on, the same bar this file already holds for a fetch.
 */
export function resolveDomain(entity) {
    const nameLower = entity.name.toLowerCase().trim();

    // Extract a usable hostname, rejecting the placeholder domains the model emits when it
    // has nothing — they would otherwise outrank a perfectly good guess.
    const hostFrom = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return null;
        for (const candidate of [raw, `https://${raw}`]) {
            try {
                const hostname = new URL(candidate).hostname.replace(/^www\./, '');
                if (hostname && !/^(example|competitor\d*|peer\d*)\./i.test(hostname)) return hostname;
            } catch { /* try the next form */ }
        }
        return null;
    };

    // 1. Curated mapping — highest confidence.
    if (KNOWN_DOMAINS[nameLower]) return { domain: KNOWN_DOMAINS[nameLower], confidence: 'known' };

    // 2. A homepage an index actually returned for this entity.
    const resolved = hostFrom(entity.metadata?.resolved_url);
    if (resolved) return { domain: resolved, confidence: 'observed' };

    // 3. A URL the model supplied. Worth trying; not worth trusting.
    const claimed = hostFrom(entity.metadata?.url);
    if (claimed) return { domain: claimed, confidence: 'model_claimed' };

    // 4. Last resort: construct one. Only for categories where a company website is a
    //    reasonable assumption at all — and never for a competitor the EVIDENCE named. Those
    //    arrive with no URL by construction, and `${name}.com` for "Grexa AI" would start
    //    reading a stranger's website. Unresolved is honest; the next run can try again.
    if (entity.metadata?.source === 'evidence') return null;
    if (entity.category === 'competitor' || entity.category === 'infra' || entity.category === 'platform') {
        const cleaned = nameLower.replace(/[^a-z0-9]/g, '');
        if (cleaned.length >= 3) return { domain: `${cleaned}.com`, confidence: 'guessed' };
    }

    return null;
}

/**
 * Store entity sources to Supabase.
 * 
 * @param {Array} sources - Array of { entity_id, source_type, url }
 * @returns {Object} { stored: number, errors: number }
 */
export async function storeEntitySources(sources) {
    if (!supabase || !sources?.length) {
        console.warn('[PrimarySourceMapper] No supabase or sources — not stored.');
        return { stored: 0, errors: 0 };
    }

    // Filter out sources for entities without IDs (not yet persisted)
    const validSources = sources.filter(s => s.entity_id);

    if (validSources.length === 0) {
        console.warn('[PrimarySourceMapper] No valid entity_ids — skipping store.');
        return { stored: 0, errors: 0 };
    }

    let stored = 0;
    let errors = 0;

    // Insert in batches
    const BATCH_SIZE = 20;
    for (let i = 0; i < validSources.length; i += BATCH_SIZE) {
        const batch = validSources.slice(i, i + BATCH_SIZE).map(s => ({
            entity_id: s.entity_id,
            source_type: s.source_type,
            url: s.url,
            is_active: true
        }));

        try {
            let { error } = await supabase.from('entity_sources').insert(batch);

            // `status` is only an allowed source_type once v21 has run. Postgres rejects
            // the WHOLE batch on a CHECK violation, so a single status row on a database
            // that hasn't migrated would take every pricing and changelog URL with it —
            // silently disabling Source Watch rather than just its newest source type.
            if (error && /source_type/i.test(error.message || '') && batch.some(r => r.source_type === 'status')) {
                if (statusSourceTypeAvailable) {
                    console.warn('[PrimarySourceMapper] status source_type rejected (run v21_status_sources.sql); storing the other sources.');
                    statusSourceTypeAvailable = false;
                }
                const withoutStatus = batch.filter(r => r.source_type !== 'status');
                errors += batch.length - withoutStatus.length;
                if (withoutStatus.length === 0) continue;
                ({ error } = await supabase.from('entity_sources').insert(withoutStatus));
                if (!error) { stored += withoutStatus.length; continue; }
            }

            if (error) {
                console.error('[PrimarySourceMapper] Batch insert error:', error.message);
                errors += batch.length;
            } else {
                stored += batch.length;
            }
        } catch (err) {
            console.error('[PrimarySourceMapper] Unexpected error:', err);
            errors += batch.length;
        }
    }

    console.log(`[PrimarySourceMapper] ✅ ${stored} sources stored, ${errors} errors`);
    return { stored, errors };
}

/**
 * Get all active sources for a company's entities.
 */
export async function getEntitySources(companyId) {
    if (!supabase || !companyId) return [];

    const { data, error } = await supabase
        .from('entity_sources')
        .select(`
            id,
            source_type,
            url,
            last_checked,
            consecutive_failures,
            entity:tracked_entities!inner(id, name, category, company_id)
        `)
        .eq('tracked_entities.company_id', companyId)
        .eq('is_active', true);

    if (error) {
        console.error('[PrimarySourceMapper] Fetch error:', error.message);
        return [];
    }
    return data || [];
}
