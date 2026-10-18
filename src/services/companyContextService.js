/**
 * Company Context Service — the reusable, versioned company context.
 *
 * Before this existed, every run rebuilt the context from scratch (two advanced Tavily
 * searches, a LinkedIn fetch, a page extract, a ~40k-token buildContext call) and threw
 * away whatever the founder had corrected on the review screen last time. For a company
 * already on file that is pure waste, and it is spent BEFORE any job exists — so it is
 * the one cost a founder can incur repeatedly for free.
 *
 * Reads fall back to the last report's context, so a company with history but no
 * company_contexts row (every company, on the day v26 ships) still gets a reused context
 * on its next run. The table self-backfills the first time anyone confirms.
 *
 * See scripts/migrations/v26_company_contexts.sql and scripts/context-reuse.test.mjs —
 * the round trip between the writer, the reader and the columns is pinned there.
 */

import { supabase } from '../lib/supabase.js';
import { extractTargetDomain, getLastReportForUrl } from './reportService.js';

/**
 * Every column the row mapper below is allowed to read.
 *
 * A field the mapper consumes that the query never asked for reads back as undefined and
 * throws nothing — that exact shape cost this codebase `source_class` for months (see
 * scripts/observation-roundtrip.test.mjs). Keep this list and readContextRow in step.
 */
export const CONTEXT_COLUMNS = 'id, client_id, target_domain, target_id, version, is_current, context, context_hash, source, built_from, created_by, created_at, last_used_at';

/**
 * Run-scoped keys that must never survive into the next run.
 *
 * Everything here is either rewritten by stepMemory or actively harmful if replayed.
 * `_decision` is the dangerous one: handleCreateJob reads contextData._decision, so a
 * stored decision frame reused for a plain company run would fabricate a decision brief
 * nobody asked for.
 */
const RUN_SCOPED_KEYS = [
    '_decision',
    '_companyMemory',
    '_memorySeed',
    '_founderNotes',
    '_reactionPreferences',
    '_reactionSignal',
    // Re-derived by enrichContextWithOnboarding at confirm time. Carrying a stale
    // context_version_id would file this run's entities under the previous generation.
    '_startupContext',
    '_trackedEntities',
    '_primarySources',
    '_signalWeights',
];

/** Keys that are the whole point of reuse and must survive. Asserted in the tests. */
export const REUSABLE_KEYS = [
    '_onboardingData',
    '_docIntel',
    '_documentQuality',
    '_sourceDocuments',
    '_userEdits',
    // Per-fact provenance ledger (below). It is the whole point of reuse in the same sense
    // _userEdits is: the record of when each material fact was last actually confirmed, and
    // from where. Stripping it on reuse would reset every fact's staleness clock to "just
    // built" on every single run — the exact quiet-degradation failure describeContextStaleness
    // exists to surface honestly.
    '_factProvenance',
    // Durable product identity, unlike _decision which is one run's frame. It therefore
    // participates in hashContext: editing positioning mints a new version rather than
    // silently reusing the old one.
    '_product',
];

/**
 * Material fact paths tracked for provenance, matched against a freshly built context.
 *
 * Scalar paths are read directly; array paths are keyed per item (by name for an
 * object like a competitor, by the string itself for a dependency). This list is
 * deliberately the same handful of fields describeContextStaleness already singles out as
 * "worth telling a founder about" — provenance for a field nobody is shown is provenance
 * nobody benefits from.
 */
const TRACKED_FACT_PATHS = {
    scalar: ['company_dna.funding_stage', 'company_dna.team_size'],
    array: [
        'key_competitors',
        'dependency_map.infra_dependencies',
        'dependency_map.platform_dependencies',
        'dependency_map.regulatory_exposure',
    ],
};

function factItemKey(item) {
    return String((item && typeof item === 'object' ? item.name : item) || '').toLowerCase().trim();
}

function getAtPath(obj, path) {
    return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

/**
 * Stamp every currently-present tracked fact as freshly confirmed by an initial build.
 *
 * Call ONLY right after a fresh buildContext result — every field in it genuinely was just
 * read from live sources, so blanket-stamping all of them is honest here in a way it would
 * not be for a stored context nothing re-verified. A merge stamps individually instead (see
 * applyContextPatch) — only the specific fields the new sources actually supported.
 *
 * `as_of` is always this function's own clock, never anything read from the model's
 * response or the caller — the same rule promptUtils.js states for observations applies to
 * context: never let the model (or a client) supply a date.
 *
 * Pure: returns a new provenance map.
 */
export function stampBuildProvenance(context) {
    const asOf = new Date().toISOString();
    const next = {};
    for (const path of TRACKED_FACT_PATHS.scalar) {
        const value = getAtPath(context, path);
        if (value !== undefined && value !== null && value !== '' && String(value).toLowerCase() !== 'unknown') {
            next[path] = { as_of: asOf, source_url: null, confidence: null };
        }
    }
    for (const path of TRACKED_FACT_PATHS.array) {
        const list = getAtPath(context, path);
        if (Array.isArray(list)) {
            for (const item of list) {
                const key = factItemKey(item);
                if (key) next[`${path}:${key}`] = { as_of: asOf, source_url: null, confidence: null };
            }
        }
    }
    return next;
}

/**
 * Mirrors company_contexts_source_check in v37_intelligence_targets.sql. The test reads
 * BOTH this array and the migration and fails on drift — the v25 lesson, where a CHECK
 * frozen at five values while the code emitted eight rejected every row silently.
 */
export const CONTEXT_SOURCES = ['built', 'edited', 'merged', 'rebuilt', 'reused', 'inherited'];

/**
 * Strip the run-scoped layer off a stored context so it can seed a fresh run.
 * Pure — never mutates its argument.
 */
export function hydrateStoredContext(storedContext) {
    if (!storedContext || typeof storedContext !== 'object') return null;
    const clone = { ...storedContext };
    for (const key of RUN_SCOPED_KEYS) delete clone[key];
    return clone;
}

/**
 * Deterministic JSON with sorted keys, so two structurally identical contexts hash the
 * same regardless of the order Postgres or the LLM happened to emit their fields in.
 */
function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * SHA-256 of the sanitized context.
 *
 * Deliberately NOT sourceWatch's hashContent(): that one strips dates and long tokens and
 * lowercases, which is right for page furniture and wrong here — it would collapse two
 * genuinely different contexts whose only difference was a URL slug or a funding date.
 */
export async function hashContext(context) {
    const bytes = new TextEncoder().encode(stableStringify(hydrateStoredContext(context) || {}));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Map one company_contexts row. Reads nothing outside CONTEXT_COLUMNS. */
function readContextRow(row) {
    return {
        id: row.id,
        clientId: row.client_id,
        targetDomain: row.target_domain,
        targetId: row.target_id,
        version: row.version,
        isCurrent: row.is_current,
        context: row.context || {},
        contextHash: row.context_hash || null,
        source: row.source || 'built',
        builtFrom: row.built_from || {},
        createdBy: row.created_by || null,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at || null,
    };
}

/**
 * The current context for a company, by domain.
 *
 * @returns {Promise<null | {
 *   context: Object, origin: 'stored'|'report_fallback', targetDomain: string,
 *   version: number|null, source: string|null, builtFrom: Object,
 *   createdAt: string, reportId?: string
 * }>}
 */
export async function getCurrentCompanyContext(clientId, websiteUrl, { fallbackReport, targetId } = {}) {
    if (!supabase || !clientId || !websiteUrl) return null;
    const targetDomain = extractTargetDomain(websiteUrl);
    if (!targetDomain) return null;

    try {
        let resolvedTargetId = targetId || null;

        if (!resolvedTargetId) {
            // Without an explicit target id this call means "the company target for this
            // domain" — every pre-v31 caller. Since v31, a PRODUCT target carries its
            // parent's target_domain verbatim, so filtering company_contexts by
            // target_domain alone can match more than one is_current row once product
            // contexts exist. Resolve the company target's id first — the v31 unique
            // index is on (client_id, target_id), so filtering by THAT id is what
            // actually guarantees a single row.
            try {
                const { data: companyTarget, error: targetError } = await supabase
                    .from('intelligence_targets')
                    .select('id')
                    .eq('client_id', clientId)
                    .eq('target_domain', targetDomain)
                    .eq('type', 'company')
                    .neq('status', 'archived')
                    .maybeSingle();

                if (!targetError && companyTarget?.id) {
                    resolvedTargetId = companyTarget.id;
                } else if (targetError && targetError.code !== '42P01' && targetError.code !== 'PGRST205') {
                    // A genuinely unexpected error (not "table missing") — surface it, but
                    // still fall through to the domain-only query below rather than throw.
                    console.warn('[CompanyContext] Target lookup failed, falling back to domain-only match:', targetError.message);
                }
                // 42P01 (Postgres) / PGRST205 (PostgREST) = intelligence_targets missing:
                // v31 not applied yet. Falling through here must be genuinely silent — an
                // un-migrated deployment can have no product contexts, so the domain-only
                // query below is exactly as correct as it is today. Same silent fallback
                // when the table exists but no company target row does yet (pre-backfill).
            } catch (targetErr) {
                console.warn('[CompanyContext] Unexpected target lookup error, falling back to domain-only match:', targetErr.message);
            }
        }

        let query = supabase
            .from('company_contexts')
            .select(CONTEXT_COLUMNS)
            .eq('client_id', clientId)
            .eq('is_current', true);

        // A resolved target id is exact — the v31 unique index on (client_id, target_id)
        // guarantees at most one row. Without one (pre-v31, or intelligence_targets has no
        // company row yet) this falls back to the domain-only match, unchanged.
        query = resolvedTargetId ? query.eq('target_id', resolvedTargetId) : query.eq('target_domain', targetDomain);

        const { data, error } = await query.maybeSingle();

        if (error) {
            if (error.code === 'PGRST116') {
                // maybeSingle() does NOT throw on >1 row — it returns this error code
                // instead. Left unhandled, this looked identical to "no context found" and
                // fell through to the report fallback (or null) with nothing logged: the
                // founder-approved context silently replaced by a weaker one. This is
                // exactly the failure shape this codebase is most vulnerable to, so it logs
                // loudly rather than falling through quietly.
                console.error(
                    `[CompanyContext] ONE-CURRENT INVARIANT VIOLATED: multiple is_current ` +
                    `company_contexts rows for client=${clientId} domain=${targetDomain}` +
                    `${resolvedTargetId ? ` (resolved target=${resolvedTargetId})` : ' (domain-only match — no company target resolved)'}. ` +
                    `Falling back to the last report; the stored context could not be trusted.`
                );
            } else if (error.code !== '42P01') {
                // 42P01 = table missing: v26 not applied yet. Fall through to the report,
                // which is exactly the behaviour we want during the migration window.
                console.warn('[CompanyContext] Lookup failed, falling back to last report:', error.message);
            }
        } else if (data?.context && Object.keys(data.context).length > 0) {
            const row = readContextRow(data);
            // Phase 0 instrumentation (see the internal design log — "print the distribution").
            // Aggregate the stored / report_fallback / null split from logs before Move 1.
            console.log(`[ContextResolve] origin=stored domain=${targetDomain} version=${row.version} source=${row.source}`);
            return {
                context: row.context,
                origin: 'stored',
                targetDomain: row.targetDomain,
                targetId: row.targetId,
                version: row.version,
                source: row.source,
                builtFrom: row.builtFrom,
                createdAt: row.createdAt,
            };
        }
    } catch (err) {
        console.warn('[CompanyContext] Unexpected lookup error:', err.message);
    }

    // A caller that supplied an explicit targetId (a product run) got here because the
    // stored-context lookup above found nothing FOR THAT TARGET. getLastReportForUrl below
    // filters on client_id + target_domain only — no target scoping — and since v31 a
    // product deliberately carries its parent company's target_domain verbatim, so that
    // fallback could hand back a sibling product's report, or the parent company's report,
    // either way carrying a foreign _product (or none at all where one was expected). A
    // product with no stored context of its own must never inherit some other subject's
    // context, so skip the report fallback entirely rather than let domain-only matching
    // silently pick a plausible-looking wrong answer.
    if (targetId) {
        console.log(
            `[ContextResolve] origin=null domain=${targetDomain} target=${targetId} ` +
            `(no stored context for this product target — report fallback skipped, ` +
            `it is not target-scoped)`
        );
        return null;
    }

    // Fallback: the last brief's context. It is a run OUTPUT, so it carries whatever
    // stepDiscoverCompetitors and the competitor merge added — label it honestly in the
    // UI as "recovered from your last brief", never as the founder's approved context.
    // Only reached on the company path (targetId not supplied, handled above) — this fallback
    // is domain-only, and this is a company lookup, so any foreign _product it drags along
    // (e.g. from a report that was actually a product run sharing this same domain) is
    // stripped before it can reach a run that never asked for product research.
    try {
        // The caller may already hold this row — the intake screen fetches it for the
        // recency check moments earlier. Reusing it keeps a repeat run to one query.
        const report = fallbackReport !== undefined
            ? fallbackReport
            : (await getLastReportForUrl(clientId, websiteUrl)).data;
        if (report?.context && Object.keys(report.context).length > 0) {
            console.log(`[ContextResolve] origin=report_fallback domain=${targetDomain} reportId=${report.id}`);
            const { _product, ...companyContext } = report.context;
            if (_product) {
                console.log(
                    `[ContextResolve] report_fallback stripped a foreign _product from a ` +
                    `company context domain=${targetDomain} reportId=${report.id}`
                );
            }
            return {
                context: companyContext,
                origin: 'report_fallback',
                targetDomain,
                version: null,
                source: null,
                builtFrom: {},
                createdAt: report.created_at,
                reportId: report.id,
            };
        }
    } catch (err) {
        console.warn('[CompanyContext] Report fallback failed:', err.message);
    }

    console.log(`[ContextResolve] origin=null domain=${targetDomain} (no stored context, no prior report)`);
    return null;
}

/**
 * Write a context as the current version for (client, domain).
 *
 * Idempotent by content: an unchanged context stamps last_used_at instead of minting a
 * version nobody edited, so this is safe to call on every confirm — including a plain
 * "run it again with what you had".
 *
 * Never throws. A context that fails to persist costs the NEXT run a rebuild; failing the
 * run the founder is currently waiting on would be strictly worse.
 *
 * ⚠️ BROWSER ONLY. The RPC authorises the caller through auth.uid(), which is null in the
 * serverless worker (that runs on the service-role key with no session), so a server-side
 * call would be refused. Reads work in both places — getCurrentCompanyContext is used by
 * stepContext — but the write happens once, on the client, at confirm time. If a server
 * path ever needs to write, give it a service-role variant with an explicit client_id
 * check rather than relaxing this function's guard.
 */
export async function saveCompanyContext({
    clientId, websiteUrl, context, source = 'built', builtFrom = {}, targetId = null,
}) {
    if (!supabase || !clientId || !websiteUrl || !context) return null;
    const targetDomain = extractTargetDomain(websiteUrl);
    if (!targetDomain) return null;

    try {
        const sanitized = hydrateStoredContext(context);
        const contextHash = await hashContext(context);

        const { data, error } = await supabase.rpc('set_current_company_context', {
            p_client_id: clientId,
            p_target_domain: targetDomain,
            p_context: sanitized,
            p_context_hash: contextHash,
            p_source: source,
            p_built_from: builtFrom || {},
            p_target_id: targetId,
        });

        if (error) {
            console.warn('[CompanyContext] Save failed (run continues):', error.message);
            return null;
        }
        const row = Array.isArray(data) ? data[0] : data;
        return row ? readContextRow(row) : null;
    } catch (err) {
        console.warn('[CompanyContext] Unexpected save error:', err.message);
        return null;
    }
}

/**
 * Server-side write of a current context — the sibling saveCompanyContext lacks.
 *
 * saveCompanyContext's RPC gates on auth.uid(), which is null for every server-driven run
 * (the stepped worker, the weekly cron, an admin re-run with no browser session at confirm
 * time): those runs could READ company_contexts — getCurrentCompanyContext has no auth
 * dependency — but never WRITE it, so every improvement they made to the context (a
 * competitor confirmed, a funding-stage update folded in) was discarded the moment the
 * invocation ended. That was the single biggest gap in "the founder-approved context
 * compounds": it only ever compounded through a browser session.
 *
 * Calls set_current_company_context_service (v27) instead, which trusts `clientId` because
 * only the service role can reach it — access is enforced by REVOKE (see the migration),
 * not by auth.uid(), the same trust boundary reserve_report_run already relies on
 * (v11_security_hardening.sql). Never call this from browser code: the anon/authenticated
 * roles PostgREST serves the browser under have no execute grant on the RPC, so it would
 * just fail — harmlessly, but pointlessly.
 *
 * Same "never throws" contract as saveCompanyContext: a context that fails to persist costs
 * the NEXT run a rebuild, which is strictly better than failing the run in progress.
 *
 * ⚠️ `p_target_id` is ALWAYS sent, null included. Before v38 the RPC was domain-scoped: it
 * demoted every current row on the domain (a product's too — products share their parent's
 * domain) and inserted one with target_id NULL, which getCurrentCompanyContext cannot see.
 * Sending the argument unconditionally means an unmigrated database answers PGRST202 and
 * the write is SKIPPED rather than routed to that function. Do not "degrade" by retrying
 * without it — the old function is the bug. Null resolves to the company target.
 */
let warnedServiceWriteNeedsV38 = false;

export async function saveCompanyContextFromServer({ clientId, websiteUrl, context, source = 'built', builtFrom = {}, createdBy = null, targetId = null }) {
    if (!supabase || !clientId || !websiteUrl || !context) return null;
    const targetDomain = extractTargetDomain(websiteUrl);
    if (!targetDomain) return null;

    try {
        const sanitized = hydrateStoredContext(context);
        const contextHash = await hashContext(context);

        const { data, error } = await supabase.rpc('set_current_company_context_service', {
            p_client_id: clientId,
            p_target_domain: targetDomain,
            p_context: sanitized,
            p_context_hash: contextHash,
            p_source: source,
            p_built_from: builtFrom || {},
            p_created_by: createdBy || null,
            p_target_id: targetId || null,
        });

        if (error) {
            // Function missing: v27 not applied yet. PostgREST resolves an RPC name through
            // its own schema cache before ever reaching Postgres, so a missing function
            // surfaces as PGRST202 ("could not find the function in the schema cache"), not
            // Postgres's own 42883 (undefined_function) — but check both, the same way
            // agentRunStore.js's MISSING_TABLE_CODES covers a raw code and a PostgREST one for
            // the same underlying condition. Fall through quietly either way — this is exactly
            // the migration-window behaviour getCurrentCompanyContext already has for 42P01
            // (table missing), and the run must not fail over a context write it can afford to
            // lose.
            if (error.code !== 'PGRST202' && error.code !== '42883') {
                console.warn('[CompanyContext] Server save failed (run continues):', error.message);
            } else if (!warnedServiceWriteNeedsV38) {
                // Not silent: until v38 runs, no server-driven run persists its context.
                warnedServiceWriteNeedsV38 = true;
                console.warn('[CompanyContext] Server context writes are paused until ' +
                    'scripts/migrations/v38_service_context_write_targets.sql is applied.');
            }
            return null;
        }
        const row = Array.isArray(data) ? data[0] : data;
        return row ? readContextRow(row) : null;
    } catch (err) {
        console.warn('[CompanyContext] Unexpected server-save error:', err.message);
        return null;
    }
}

/** Version history for one company, newest first. */
export async function listContextVersions(clientId, websiteUrl, limit = 10) {
    if (!supabase || !clientId || !websiteUrl) return [];
    const targetDomain = extractTargetDomain(websiteUrl);
    if (!targetDomain) return [];

    try {
        const { data, error } = await supabase
            .from('company_contexts')
            .select(CONTEXT_COLUMNS)
            .eq('client_id', clientId)
            .eq('target_domain', targetDomain)
            .order('version', { ascending: false })
            .limit(limit);

        if (error) {
            console.warn('[CompanyContext] Version list failed:', error.message);
            return [];
        }
        return (data || []).map(readContextRow);
    } catch (err) {
        console.warn('[CompanyContext] Unexpected version-list error:', err.message);
        return [];
    }
}

/** Days between an ISO timestamp and now, floored at 0. */
function daysSince(iso) {
    if (!iso) return null;
    return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

/** Turn a raw provenance entry into `{ ageDays, sourceUrl }`, or null if there is none. */
function readFactEntry(entry) {
    if (!entry) return null;
    return { ageDays: daysSince(entry.as_of), sourceUrl: entry.source_url || null };
}

/**
 * Look up the fact-provenance entry for one item in a tracked array path, and describe it
 * for a founder: when it was last confirmed and, if known, from where.
 */
function describeFactEntry(provenance, path, item) {
    const key = factItemKey(item);
    const read = key ? readFactEntry(provenance?.[`${path}:${key}`]) : null;
    return read ? { key, ...read } : null;
}

/**
 * Which fields of a stored context go stale, and how visibly.
 *
 * The review screen needs to say "this competitor list was validated in June" out loud —
 * a reused context that silently presents four-month-old funding data as current is the
 * quiet-degradation failure this codebase keeps paying for.
 *
 * Per-fact ages come from context._factProvenance (stampBuildProvenance at build time,
 * applyContextPatch at merge time) when present. A context stored before that ledger
 * existed has no entries, so every field below falls back to the whole-context age — the
 * exact behaviour this function had before provenance existed. Nothing regresses; older
 * contexts just don't get the sharper answer until their next rebuild or merge.
 */
export function describeContextStaleness(context, createdAt) {
    if (!context) return { ageDays: null, staleFields: [] };
    const ageDays = createdAt
        ? Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000))
        : null;
    const provenance = context._factProvenance || {};

    // A field's own age when known — rendered only when the ledger actually has an entry;
    // a field with none falls back to no per-field line at all (the whole-context ageDays
    // above still applies).
    const fmtAsOf = (entry) => {
        if (!entry) return null;
        const when = entry.ageDays === 0 ? 'today' : entry.ageDays === 1 ? '1 day ago' : `${entry.ageDays} days ago`;
        return entry.sourceUrl ? `confirmed ${when} via ${entry.sourceUrl}` : `confirmed ${when}`;
    };

    const staleFields = [];
    const dna = context.company_dna || {};
    if (dna.team_size) {
        staleFields.push({
            field: 'Team size', value: String(dna.team_size),
            asOf: fmtAsOf(readFactEntry(provenance['company_dna.team_size'])),
        });
    }
    if (dna.funding_stage) {
        staleFields.push({
            field: 'Funding stage', value: String(dna.funding_stage),
            asOf: fmtAsOf(readFactEntry(provenance['company_dna.funding_stage'])),
        });
    }
    if (Array.isArray(dna.growth_signals) && dna.growth_signals.length) {
        staleFields.push({ field: 'Growth signals', value: `${dna.growth_signals.length} recorded` });
    }
    if (Array.isArray(context.key_competitors) && context.key_competitors.length) {
        // The honest number for a list is the OLDEST confirmation in it, not the newest —
        // a founder deciding whether to rebuild needs to know the weakest link.
        const described = context.key_competitors
            .map(c => describeFactEntry(provenance, 'key_competitors', c))
            .filter(Boolean);
        const oldest = described.length
            ? described.reduce((a, b) => (b.ageDays > a.ageDays ? b : a))
            : null;
        staleFields.push({
            field: 'Competitors',
            value: `${context.key_competitors.length} tracked`,
            asOf: oldest
                ? `oldest: ${oldest.key} — ${fmtAsOf(oldest)}${described.length < context.key_competitors.length ? ` (${context.key_competitors.length - described.length} never confirmed)` : ''}`
                : null,
        });
    }
    const docVintage = context._docIntel?._vintage?.asOf || null;
    if (docVintage) staleFields.push({ field: 'Documents', value: `as of ${docVintage}` });

    return {
        ageDays,
        staleFields,
        // A hard blocker in validateContextReadiness that a stored context would otherwise
        // carry forever, re-failing the gate on every reuse. Rebuild is the only way out.
        anchorsAreFallback: context.strategic_anchors?.confidence === 'inferred-fallback',
    };
}

/** Default staleness threshold for askBahirjee's Stage 2 escalation decision (v29). */
export const STALE_FACT_THRESHOLD_DAYS = 90;

/**
 * Every tracked fact whose provenance entry is older than `thresholdDays` — askBahirjee's
 * signal for "the model may be citing a fact that has not been reconfirmed in a while, force
 * a web check even if it claims high confidence." A fact with NO entry (a context stored
 * before _factProvenance existed) is neither flagged stale nor fresh here — there is nothing
 * to measure it against, so it is left entirely to the model's own sufficiency judgement.
 */
export function listStaleFacts(context, thresholdDays = STALE_FACT_THRESHOLD_DAYS) {
    const provenance = context?._factProvenance || {};
    const stale = [];
    for (const [field, entry] of Object.entries(provenance)) {
        const ageDays = daysSince(entry?.as_of);
        if (ageDays !== null && ageDays > thresholdDays) {
            stale.push({ field, ageDays, sourceUrl: entry.source_url || null });
        }
    }
    return stale;
}
