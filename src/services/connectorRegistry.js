/**
 * Connector Registry — decides WHICH structured sources a given run should call.
 *
 * The split with lib/handlers/connectors.js is deliberate and security-relevant: this
 * file plans (which connectors, what terms, how many), the handler executes (URLs, API
 * keys, HTTP). No URL is ever constructed here, so no caller-supplied string can become
 * a host on the server. See the handler's header for the rest of that reasoning.
 *
 * Everything below is pure — no network, no Supabase — so the planning rules can be
 * tested without credentials, which matters because three of the seven connectors need
 * a key nobody has in CI.
 */

import { parseGeoKeys } from './sourceTiers.js';

/**
 * Total connector calls per run. Each is one HTTP round trip with its own timeout;
 * this bounds the step, not the cost — the connectors are free or near-free. The real
 * spend is downstream, where every observation they return may add an analyze batch.
 */
export const MAX_CONNECTOR_CALLS_PER_RUN = 14;

/**
 * Per-connector observation cap.
 *
 * Load-bearing: HN and Reddit will happily return 25 threads about a busy topic, and
 * without this a single chatty source would dominate the analyze batches and crowd out
 * the tender and filing evidence this whole phase exists to collect.
 */
export const MAX_OBSERVATIONS_PER_CONNECTOR = 8;

/**
 * Ships dark. Per the internal design log ("Credibility tightening ships dark first, gets watched
 * on a real run, then becomes the default"), the same discipline applies in reverse for
 * breadth: enable one connector at a time and watch a real run before defaulting it on.
 *
 * `CONNECTORS_ENABLED=hn,sec_edgar` turns on a subset; `=all` turns on everything.
 */
const enabledFromEnv = () => {
    const raw = (typeof process !== 'undefined' && process.env?.VITE_CONNECTORS_ENABLED)
        || (typeof import.meta !== 'undefined' && import.meta.env?.VITE_CONNECTORS_ENABLED)
        || '';
    return String(raw).trim();
};

export function isConnectorEnabled(id, override = null) {
    const setting = override ?? enabledFromEnv();
    if (!setting) return false;
    if (setting === 'all') return true;
    return setting.split(',').map(s => s.trim()).filter(Boolean).includes(id);
}

/**
 * The registry.
 *
 * `geos: null` means the connector applies everywhere. Otherwise it only runs when the
 * founder's operating geography includes one of the listed keys — calling SAM.gov for a
 * founder selling only in Bengaluru spends a request to retrieve nothing.
 *
 * `needs` documents the credential requirement so the planner can explain a skip rather
 * than silently omitting a source.
 */
export const CONNECTORS = {
    // ── Tenders: live procurement, the highest-intent demand signal that exists ──
    // The signal prompt already names "an RFP/tender issued" as top-tier DemandSignal;
    // until these existed there was no source in the system that could produce one.
    sam_gov: {
        id: 'sam_gov',
        label: 'SAM.gov (US federal contracts)',
        domain: 'government',
        sourceClass: 'tender',
        geos: ['us'],
        needs: 'SAM_GOV_API_KEY',
        reliability: 'unverified',
        days: 30,
        buildParams: ({ industry, vertical }) => ({ query: vertical || industry }),
    },
    contracts_finder: {
        id: 'contracts_finder',
        label: 'UK Contracts Finder',
        domain: 'government',
        sourceClass: 'tender',
        geos: ['uk'],
        needs: null,
        reliability: 'stable',
        days: 30,
        // Terms, not a query: this API ignores its own keyword parameter, so the handler
        // pulls a date window and filters. Send several terms to widen the net.
        buildParams: ({ industry, vertical, segments }) => ({
            terms: [industry, vertical, ...segments].filter(Boolean),
        }),
    },
    gem: {
        id: 'gem',
        label: 'GeM (India public procurement)',
        domain: 'government',
        sourceClass: 'tender',
        geos: ['in'],
        needs: null,
        // No public API — scraped markup we do not control. Expected to break; failures
        // must be disclosed, never silently swallowed.
        reliability: 'best-effort',
        days: 30,
        buildParams: ({ industry, vertical, segments }) => ({
            terms: [industry, vertical, ...segments].filter(Boolean),
        }),
    },

    // ── Filings: what a competitor told a regulator, not what they told a journalist ──
    sec_edgar: {
        id: 'sec_edgar',
        label: 'SEC EDGAR (US filings)',
        domain: 'financial',
        sourceClass: 'filing',
        geos: ['us'],
        needs: null,
        reliability: 'stable',
        days: 180,
        // Filings name companies, not markets: a form search for "fintech" is noise,
        // so this only runs when there is a competitor to look up.
        requiresEntity: true,
        buildParams: ({ entity }) => ({ query: entity }),
    },
    companies_house: {
        id: 'companies_house',
        label: 'Companies House (UK filings)',
        domain: 'financial',
        sourceClass: 'filing',
        geos: ['uk'],
        needs: 'COMPANIES_HOUSE_API_KEY',
        reliability: 'stable',
        days: 365,
        requiresEntity: true,
        buildParams: ({ entity }) => ({ query: entity }),
    },

    // ── Social: engagement volume, which the search index strips ──
    hn: {
        id: 'hn',
        label: 'Hacker News',
        domain: 'social',
        sourceClass: 'social',
        geos: null,
        needs: null,
        reliability: 'stable',
        days: 180,
        buildParams: ({ industry, vertical }) => ({ query: [vertical, industry].filter(Boolean).join(' ') }),
    },
    reddit: {
        id: 'reddit',
        label: 'Reddit',
        domain: 'social',
        sourceClass: 'social',
        geos: null,
        // Reddit blocked unauthenticated JSON access; this now needs a free OAuth app.
        needs: 'REDDIT_CLIENT_ID',
        reliability: 'stable',
        days: 365,
        buildParams: ({ industry, vertical, segments }) => ({
            query: [vertical || industry, segments[0]].filter(Boolean).join(' '),
        }),
    },
};

/** Every connector id, for tests and docs. */
export const CONNECTOR_IDS = Object.keys(CONNECTORS);

/**
 * Order calls are planned in. Tenders first, then filings, then social — so if the
 * call budget or the time budget runs out, what survives is the evidence a founder
 * cannot get anywhere else, not another Hacker News thread.
 */
const PLAN_PRIORITY = ['sam_gov', 'contracts_finder', 'gem', 'sec_edgar', 'companies_house', 'hn', 'reddit'];

/**
 * Build the call plan for a run.
 *
 * @param {Object} context - the pipeline's context object
 * @param {Object} [options] - { enabledOverride, maxCalls, entityLimit }
 * @returns {{ calls: Array, skipped: Array }}
 *   calls[]   = { source, params, sourceClass, reliability, label }
 *   skipped[] = { source, reason } — surfaced so a disabled source is visible, not silent
 */
export function planConnectorCalls(context, options = {}) {
    const {
        enabledOverride = null,
        maxCalls = MAX_CONNECTOR_CALLS_PER_RUN,
        entityLimit = 2,
    } = options;

    const geoKeys = parseGeoKeys(context?.operating_geography);
    const industry = context?.strategic_anchors?.operational_reality
        || context?.industry
        || 'technology';
    const vertical = context?.vertical_specialization || context?._startupContext?.market_profile?.vertical || '';

    const segments = (context?.customer_segments || [])
        .map(s => String(typeof s === 'object' ? (s.segment || s.name) : s || '').trim())
        .filter(Boolean)
        .slice(0, 3);

    // Entity-shaped connectors look up a specific company. Competitors only — a filing
    // search for an infra vendor tells the founder nothing they can act on.
    const competitors = (context?.key_competitors || [])
        .map(c => String(typeof c === 'object' ? c.name : c || '').trim())
        .filter(Boolean)
        .slice(0, entityLimit);

    const calls = [];
    const skipped = [];

    for (const id of PLAN_PRIORITY) {
        const connector = CONNECTORS[id];
        if (!connector) continue;

        if (!isConnectorEnabled(id, enabledOverride)) {
            skipped.push({ source: id, reason: 'not enabled' });
            continue;
        }

        if (connector.geos && !connector.geos.some(g => geoKeys.has(g))) {
            skipped.push({ source: id, reason: `not relevant to ${context?.operating_geography || 'this geography'}` });
            continue;
        }

        const base = {
            source: id,
            sourceClass: connector.sourceClass,
            reliability: connector.reliability,
            label: connector.label,
            needs: connector.needs,
        };

        if (connector.requiresEntity) {
            if (competitors.length === 0) {
                skipped.push({ source: id, reason: 'no named competitor to look up' });
                continue;
            }
            // One call per competitor: these APIs answer about a company, not a market.
            for (const entity of competitors) {
                if (calls.length >= maxCalls) break;
                calls.push({
                    ...base,
                    params: {
                        ...connector.buildParams({ industry, vertical, segments, entity }),
                        days: connector.days,
                        limit: MAX_OBSERVATIONS_PER_CONNECTOR,
                    },
                });
            }
            continue;
        }

        if (calls.length >= maxCalls) break;
        calls.push({
            ...base,
            params: {
                ...connector.buildParams({ industry, vertical, segments }),
                days: connector.days,
                limit: MAX_OBSERVATIONS_PER_CONNECTOR,
            },
        });
    }

    return { calls: calls.slice(0, maxCalls), skipped };
}
