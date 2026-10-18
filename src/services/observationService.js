/**
 * Observation Service — Bahirjee v6.0 Phase 1
 * 
 * Stores ALL Tavily + Firecrawl findings as Observations in Supabase.
 * Observations are internal — NOT shown to users, NOT implying importance.
 * They persist across runs and feed into the Pattern Engine (Phase 2).
 */

import { supabase } from '../lib/supabase.js';

// `observations.source_class` is added by v20_source_watch.sql. A database that has not
// run it must still be able to store observations — the stepped pipeline reads them back
// from Postgres, so a rejected write becomes an empty report rather than a visible error.
// Module-scope so the fallback is detected once per session, not once per batch.
let sourceClassColumnAvailable = true;

// `observations.retrieval_window` / `.retrieval_start_date` arrive with
// v27_temporal_evidence.sql. Same hazard as source_class above, and worth restating
// because it has already cost this codebase two whole evidence classes: PostgREST rejects
// the WHOLE batch on one unknown column, storeObservations counts the error and returns
// normally, and the stepped pipeline — which reads observations back FROM Postgres — then
// builds a report from nothing. There is no exception anywhere to notice.
//
// This is not hypothetical here: v24 is written and still unapplied on production, so a
// new column that cannot degrade would take observation storage down on deploy.
let temporalColumnsAvailable = true;

// `exa_extract` is only permitted once v28 has run. Postgres rejects the WHOLE batch on a
// CHECK violation, and a run's deep reads are written together — so one Exa-fallback read
// on an unmigrated database would take every Parallel AI read in the run down with it.
// Until then, write it under its pre-v28 label: the evidence survives and only loses the
// label that v28 exists to add.
let exaExtractTypeAvailable = true;
const PRE_V28_LABEL = { exa_extract: 'exa' };
const withPreV28Labels = (rows) => rows.map(r =>
    PRE_V28_LABEL[r.source_type] ? { ...r, source_type: PRE_V28_LABEL[r.source_type] } : r
);

/**
 * Every `source_type` an observation may carry — the mirror of the CHECK constraint in
 * scripts/migrations/v28_exa_extract_source_type.sql.
 *
 * This list exists because the code and the constraint silently drifted apart once already
 * on `main`: Source Watch ('source_watch') and the connectors ('connector') shipped against
 * a CHECK frozen at the three retrieval providers. Postgres rejected every one of those
 * rows, storeObservations() counted the error and returned normally, and the stepped
 * pipeline — which reads observations back from Postgres, not memory — produced a thinner
 * report with no error anywhere. Two whole evidence classes cost their full latency and API
 * spend and contributed nothing.
 *
 * 'source_watch' and 'connector' arrived with sourceWatch.js and the connectors in the main
 * merge; before it they were listed here unemitted, so that the constant matched what the
 * already-applied v22 migration permits. Both are now live emitters.
 *
 * ⚠️ Adding a value here is half the change. The migration is the other half, and
 * `npm run test:observations` fails if the two disagree or if code emits a further value.
 */
export const OBSERVATION_SOURCE_TYPES = Object.freeze([
    'tavily',
    // Retained for ~158 historical rows only. Nothing calls Firecrawl any more — deep
    // reads that carry this label were in fact produced by Exa. See v23's header.
    'firecrawl',
    'exa',
    'source_watch',
    'connector',
    'parallel_ai',
    'exa_extract'
]);

/**
 * Source types that can only mean a page read in full.
 *
 * `parallel_ai` and `exa_extract` are written by nothing but a deep read, and `firecrawl`
 * is the pre-v23 label for the same thing. `exa` is deliberately absent: it marks an Exa
 * SEARCH result, and before v27 it also marked Exa-fallback extracts — those historical
 * rows cannot be told apart from search rows by label, so they read back as search rows.
 */
const DEEP_READ_SOURCE_TYPES = new Set(['parallel_ai', 'exa_extract', 'firecrawl']);

export function isDeepReadSourceType(sourceType) {
    return DEEP_READ_SOURCE_TYPES.has(sourceType);
}

/**
 * Sanitize raw text before storing to Supabase.
 * Removes invalid Unicode escape sequences and null bytes that cause Postgres errors.
 */
function sanitizeText(text) {
    if (!text) return '';
    return String(text)
        // Remove null bytes
        .replace(/\x00/g, '')
        // Replace invalid \u escape sequences (non-hex chars after \u)
        .replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u')
        // Remove lone surrogate pairs (unpaired high/low surrogates)
        .replace(/[\uD800-\uDFFF]/g, '?');
}

/**
 * Generate a unique run ID (UUID v4 via crypto).
 * Groups all observations from a single intelligence generation run.
 */
export function generateRunId() {
    return crypto.randomUUID();
}

/**
 * Store an array of raw observations from Tavily/Firecrawl into Supabase.
 * 
 * @param {Object} params
 * @param {string} params.companyId - The client/company UUID
 * @param {string} params.runId - UUID grouping this run's observations
 * @param {Array} params.rawResults - Array of { job, source, data, url, isDeepRead }
 * @returns {Object} { stored: number, errors: number }
 */
export async function storeObservations({ companyId, runId, rawResults }) {
    if (!supabase) {
        console.warn('[ObservationService] Supabase not configured. Observations not stored.');
        return { stored: 0, errors: 0 };
    }

    if (!companyId || !runId || !rawResults?.length) {
        console.warn('[ObservationService] Missing required params. Skipping.');
        return { stored: 0, errors: 0 };
    }

    // Map raw results into observation rows
    const rows = rawResults.map(result => ({
        company_id: companyId,
        run_id: runId,
        // Prefer the theme the query was generated under. categorizeTheme() is a
        // legacy fallback for callers that still pass only a query string.
        theme: result.theme || categorizeTheme(result.job),
        entity: extractEntity(result.job),
        source_url: result.url || null,
        // Prefer an explicit source_type. The isDeepRead flag is a legacy fallback that
        // cannot tell an Exa pre-seed from a Tavily result — both would land on 'tavily'.
        source_type: result.source_type || (result.isDeepRead ? 'firecrawl' : 'tavily'),
        // What KIND of evidence this is (primary_company / filing / tender / news / …),
        // as opposed to source_type's "which provider fetched it". Null when the caller
        // didn't classify it — never guessed, per v20_source_watch.sql.
        ...(sourceClassColumnAvailable ? { source_class: result.source_class || null } : {}),
        raw_text: sanitizeText((result.data || '').substring(0, 50000)), // Cap at 50k chars
        // When the event happened, per the source. Null when the provider didn't
        // report one (Tavily only returns it on topic:'news').
        published_date: normalizePublishedDate(result.published_date),
        relevance_score: typeof result.score === 'number' ? result.score : null,
        title: result.title ? sanitizeText(String(result.title).substring(0, 500)) : null,
        // Which temporal window the QUERY was planned under — metadata about the ask, not
        // a claim about the content. A provider that ignores a requested date window still
        // returns rows; recording the ask is what lets us tell that afterwards rather than
        // assuming the window held.
        ...(temporalColumnsAvailable ? {
            retrieval_window: result.retrieval_window || null,
            retrieval_start_date: result.retrieval_start_date || null,
        } : {}),
        // NOTE: ingestion time, not event time. Use published_date for velocity.
        timestamp: new Date().toISOString()
    }));

    // Two queries can surface the same URL. Collapse them before the write so the batch
    // matches what the uq_observations_run_url_type index will accept.
    const seen = new Set();
    const uniqueRows = rows.filter(row => {
        if (!row.source_url) return true; // NULLs are exempt from the unique index
        // The separator is U+0000: no URL and no source_type can contain it, so the
        // composite key cannot collide the way a comma or a space could. Written as an
        // ESCAPE, never as a literal NUL byte -- a raw NUL makes git classify this whole
        // file as binary, and then every diff of it is unreviewable.
        const key = `${row.source_url}\u0000${row.source_type}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // Catch an unpermitted source_type here rather than as an opaque SQLSTATE 23514 from
    // Postgres. The DB rejects the WHOLE batch on one bad row, so a single new source_type
    // silently costs every observation beside it — which is exactly how Source Watch and the
    // connectors lost their evidence on main between v20 and v22.
    const permitted = new Set(OBSERVATION_SOURCE_TYPES);
    const unpermitted = [...new Set(
        uniqueRows.map(r => r.source_type).filter(t => !permitted.has(t))
    )];
    if (unpermitted.length > 0) {
        console.error(
            `[ObservationService] Unpermitted source_type(s): ${unpermitted.join(', ')}. `
            + `Add them to OBSERVATION_SOURCE_TYPES *and* to the CHECK constraint `
            + `(scripts/migrations/v22_observation_source_types.sql). This batch will be rejected.`
        );
    }

    let stored = 0;
    let errors = 0;
    let firstError = unpermitted.length > 0
        ? `unpermitted source_type: ${unpermitted.join(', ')}`
        : null;

    // Insert in batches of 25 to avoid payload size limits
    const BATCH_SIZE = 25;
    for (let i = 0; i < uniqueRows.length; i += BATCH_SIZE) {
        let batch = uniqueRows.slice(i, i + BATCH_SIZE);
        if (!exaExtractTypeAvailable) batch = withPreV28Labels(batch);
        try {
            // A search wave can crash after writing and be replayed by the next worker
            // invocation, so the write must be idempotent rather than additive.
            const upsert = (rows) => supabase
                .from('observations')
                .upsert(rows, {
                    onConflict: 'run_id,source_url,source_type',
                    ignoreDuplicates: true
                });

            let { error } = await upsert(batch);

            // `source_class` arrives with v20. On a database that has not run it yet,
            // PostgREST rejects the whole batch — and because the stepped pipeline reads
            // observations back FROM Postgres, that failure would not surface as an error
            // but as an empty report. Drop the column and retry, exactly as saveReport
            // does for its own later-migration columns.
            if (error?.code === 'PGRST204' && /source_class/i.test(error.message || '')) {
                if (sourceClassColumnAvailable) {
                    console.warn('[ObservationService] source_class column unavailable (run v20_source_watch.sql); storing without provenance.');
                    sourceClassColumnAvailable = false;
                }
                ({ error } = await upsert(batch.map(({ source_class, ...rest }) => rest)));
            }

            // Same fallback for the v27 temporal columns. Checked after source_class so a
            // database missing both degrades through each in turn rather than giving up.
            if (error?.code === 'PGRST204' && /retrieval_window|retrieval_start_date/i.test(error.message || '')) {
                if (temporalColumnsAvailable) {
                    console.warn('[ObservationService] retrieval window columns unavailable (run v27_temporal_evidence.sql); storing without temporal provenance.');
                    temporalColumnsAvailable = false;
                }
                const strip = (rows) => rows.map(({ retrieval_window, retrieval_start_date, ...rest }) =>
                    sourceClassColumnAvailable ? rest : (({ source_class, ...r }) => r)(rest)
                );
                ({ error } = await upsert(strip(batch)));
            }

            if (error?.code === '23514' && batch.some(r => PRE_V28_LABEL[r.source_type])) {
                const relabelled = withPreV28Labels(batch);
                const strip = (rows) => rows.map((r) => {
                    const out = { ...r };
                    if (!sourceClassColumnAvailable) delete out.source_class;
                    if (!temporalColumnsAvailable) {
                        delete out.retrieval_window;
                        delete out.retrieval_start_date;
                    }
                    return out;
                });
                const retry = await upsert(strip(relabelled));
                // Only conclude v28 is missing if the relabel is what fixed it. A 23514 from
                // some other constraint would fail the retry too, and must not switch the
                // label off for every later write in this process.
                if (!retry.error) {
                    console.warn('[ObservationService] exa_extract source_type rejected (run v28_exa_extract_source_type.sql); storing Exa-fallback deep reads as \'exa\'.');
                    exaExtractTypeAvailable = false;
                }
                ({ error } = retry);
            }

            if (error) {
                console.error(`[ObservationService] Batch upsert error:`, error.message);
                errors += batch.length;
                firstError = firstError || error.message || 'unknown database error';
            } else {
                stored += batch.length;
            }
        } catch (err) {
            console.error('[ObservationService] Unexpected error:', err);
            errors += batch.length;
            firstError = firstError || err?.message || 'unexpected error';
        }
    }

    console.log(`[ObservationService] ✅ Stored ${stored} observations, ${errors} errors (run: ${runId.substring(0, 8)})`);
    // `firstError` is what lets the caller disclose the loss instead of logging it. A
    // storage failure is non-blocking by design, but non-blocking must mean *disclosed*,
    // not invisible — see appendObservations().
    return { stored, errors, firstError };
}

/**
 * Read a run's observations back in the in-memory shape the pipeline uses.
 *
 * The stepped worker does not carry raw observations through `step_outputs` — a run's raw
 * text is ~0.5-1 MB and would be rewritten on every invocation. The search step writes
 * here and the analyze step reads back. `raw_text` already holds the full
 * `TITLE:/URL:/CONTENT:` blob that `obs.data` held in the monolith, so nothing is lost.
 *
 * @param {string} runId
 * @param {string[]} [ids] - restrict to specific observation ids (one analyze batch)
 * @returns {Array} observations shaped like the pipeline's in-memory records
 */
export async function getObservationsForRun(runId, ids = null) {
    if (!supabase || !runId) return [];

    const BASE_COLUMNS = 'id, theme, source_url, source_type, raw_text, published_date, relevance_score, title';

    const run = (columns) => {
        let query = supabase.from('observations').select(columns).eq('run_id', runId);
        if (ids?.length) query = query.in('id', ids);
        return query.order('id', { ascending: true });
    };

    let { data, error } = sourceClassColumnAvailable
        ? await run(`${BASE_COLUMNS}, source_class`)
        : await run(BASE_COLUMNS);

    // Mirror of the write path's fallback. Postgres answers an unknown column with 42703,
    // and without this the whole analyze step would read back zero observations on a
    // database that has not run v20 — an empty report rather than a report without
    // provenance. Losing the label is survivable; losing the evidence is not.
    if (error?.code === '42703' && /source_class/i.test(error.message || '')) {
        if (sourceClassColumnAvailable) {
            console.warn('[ObservationService] source_class column unavailable (run v20_source_watch.sql); reading without provenance.');
            sourceClassColumnAvailable = false;
        }
        ({ data, error } = await run(BASE_COLUMNS));
    }

    if (error) {
        console.error('[ObservationService] Run fetch error:', error.message);
        return [];
    }

    return (data || []).map(row => ({
        id: row.id,
        theme: row.theme,
        source: row.source_type,
        data: row.raw_text,
        url: row.source_url,
        title: row.title,
        // What KIND of evidence this is, as distinct from which provider fetched it.
        // Omitting it here is what silently disabled provenance on the stepped pipeline:
        // the analyze step reads observations back through this function, so a field the
        // select drops never reaches attachSourceClass, which then finds an empty class
        // map and returns every signal unstamped. Any field the pipeline reads off an
        // observation MUST survive this round trip — see observation-roundtrip.test.mjs.
        source_class: row.source_class ?? null,
        published_date: row.published_date,
        // relevance_score is NULL for deep reads. It must stay nullish so the downstream
        // `(obs.score ?? 1) >= MIN_TAVILY_SCORE` filter keeps them; coercing to 0 would
        // silently drop every deep read.
        score: row.relevance_score ?? null,
        // This compared against 'firecrawl' alone for months after deep reads started being
        // written as 'parallel_ai', so on the stepped pipeline no deep read was ever
        // recognised as one: it was labelled [Search] and compressed to a snippet.
        isDeepRead: isDeepReadSourceType(row.source_type)
    }));
}

/**
 * Retrieve observations for a company within a rolling time window.
 * 
 * @param {string} companyId - Client UUID
 * @param {number} days - Rolling window in days (default: 30)
 * @returns {Array} Observation rows
 */
export async function getObservationsForCompany(companyId, days = 30) {
    if (!supabase || !companyId) return [];

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const { data, error } = await supabase
        .from('observations')
        .select('*')
        .eq('company_id', companyId)
        .gte('created_at', cutoff.toISOString())
        .order('created_at', { ascending: false });

    if (error) {
        console.error('[ObservationService] Fetch error:', error.message);
        return [];
    }

    return data || [];
}

/**
 * Get observation count by theme for a company (for pattern engine stats).
 */
export async function getObservationStats(companyId, days = 30) {
    const observations = await getObservationsForCompany(companyId, days);
    const byTheme = {};
    for (const obs of observations) {
        byTheme[obs.theme] = (byTheme[obs.theme] || 0) + 1;
    }
    return {
        total: observations.length,
        byTheme,
        uniqueRuns: new Set(observations.map(o => o.run_id)).size
    };
}

// --- Internal Helpers ---

/**
 * Coerce a provider-supplied publish date into an ISO string, or null.
 * Providers return a mix of ISO timestamps, bare dates, and junk; a bad value
 * must not fail the whole insert batch.
 */
function normalizePublishedDate(value) {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    // Guard against obviously wrong dates (provider parse errors yield 1970 / far future).
    const year = parsed.getUTCFullYear();
    if (year < 1990 || year > new Date().getUTCFullYear() + 1) return null;
    return parsed.toISOString();
}

/**
 * Categorize query job name into a theme.
 *
 * LEGACY FALLBACK. Prefer the explicit `theme` set by the query generator.
 * This keyword match is order-dependent — "funding" is caught by the first
 * branch and routed to competitor_intel — so query wording silently steers
 * the result. Retained only for callers that don't pass a theme.
 */
function categorizeTheme(jobName) {
    if (!jobName) return 'general';
    const lower = jobName.toLowerCase();

    if (lower.includes('competitor') || lower.includes('funding') || lower.includes('acquisition'))
        return 'competitor_intel';
    if (lower.includes('talent') || lower.includes('hiring') || lower.includes('layoff') || lower.includes('engineer'))
        return 'talent_signals';
    if (lower.includes('series') || lower.includes('venture') || lower.includes('capital') || lower.includes('raised'))
        return 'funding_intel';
    if (lower.includes('customer') || lower.includes('buyer') || lower.includes('buying') || lower.includes('pain'))
        return 'customer_shifts';
    if (lower.includes('regulation') || lower.includes('compliance') || lower.includes('regulatory'))
        return 'regulatory_lens';

    return 'general';
}

/**
 * Extract the primary entity from the query job name.
 * Tries to find a company/person name in the query.
 */
function extractEntity(jobName) {
    if (!jobName) return null;

    // Try to extract quoted entity names from the query
    const quotedMatch = jobName.match(/"([^"]+)"/);
    if (quotedMatch) return quotedMatch[1];

    // Return the first meaningful segment (before "funding" / "hiring" / "OR" etc.)
    const segments = jobName.split(/\s+(?:funding|hiring|layoff|OR|AND|acquisition|regulation|compliance|series|venture)\b/i);
    const entity = segments[0]?.trim();
    return entity && entity.length > 2 ? entity : null;
}
