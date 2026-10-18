import { supabase } from '../lib/supabase.js';
import { depthGapsFor, DEFAULT_RUN_TIER } from './runTiers.js';
import { normalizeBrief } from './briefSchema.js';
import { PRODUCT_MODE } from './productService.js';

const MULTI_PART_SUFFIXES = new Set([
    'co.uk',
    'org.uk',
    'gov.uk',
    'ac.uk',
    'com.au',
    'net.au',
    'org.au',
    'co.nz',
    'com.br',
    'com.sg',
    'com.hk',
    'co.jp',
    'co.in',
    'com.mx',
    'com.tr'
]);

export function extractTargetDomain(websiteUrl) {
    try {
        const urlObj = new URL(websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`);
        const hostname = urlObj.hostname.toLowerCase().replace(/^www\./, '');
        if (/^localhost$|^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
            return hostname;
        }

        const parts = hostname.split('.').filter(Boolean);
        if (parts.length <= 2) return hostname;

        const lastTwo = parts.slice(-2).join('.');
        const lastThree = parts.slice(-3).join('.');

        if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
            return parts.slice(-3).join('.');
        }

        if (MULTI_PART_SUFFIXES.has(lastThree) && parts.length >= 4) {
            return parts.slice(-4).join('.');
        }

        return lastTwo;
    } catch {
        return null;
    }
}

/**
 * A saved report's news section, or null when the report never recorded one. Shared by
 * mapReportRowToAppReport and the shared-link viewer (which builds its own shape from the
 * raw row) so the two readers cannot drift.
 *
 * null and [] are different answers. A row saved before v28 (or while the column was
 * missing) has no news on record, and the section is hidden; [] is a run that found
 * nothing worth listing, and the section says so. Reading null as [] would tell a founder
 * "nothing moved" about a run that never checked.
 */
export function newsItemsFromRow(row) {
    return Array.isArray(row?.news_items) ? row.news_items.filter(item => item && item.headline) : null;
}

export function mapReportRowToAppReport(dbReport) {
    if (!dbReport) return null;
    const runTier = dbReport.run_tier || DEFAULT_RUN_TIER;
    return {
        ...dbReport,
        timestamp: dbReport.created_at,
        inputs: { websiteUrl: dbReport.website_url },
        memory: dbReport.memory_state || null,
        card_summary: dbReport.card_summary || [],
        newsItems: newsItemsFromRow(dbReport),
        based_on_report_id: dbReport.based_on_report_id || null,
        reportKind: dbReport.report_kind || 'company',
        decisionId: dbReport.decision_id || null,
        targetId: dbReport.target_id || null,
        decisionContext: dbReport.decision_context || null,
        decisionBrief: dbReport.decision_brief || null,
        // Normalizing on READ as well as write is not optional. Every report written
        // before brief.v2 has the old shape, and an empty run persisted `brief` as a
        // plain STRING — rows in both shapes are already in the database. normalizeBrief
        // is idempotent, so a v2 brief passes through unchanged.
        brief: normalizeBrief(dbReport.brief, {
            kind: dbReport.report_kind === 'decision' ? 'decision' : 'company',
            signals: Array.isArray(dbReport.signals) ? dbReport.signals : [],
            context: dbReport.context || {},
            tier: runTier,
            decisionFrame: dbReport.decision_context || null,
            // The gates this run was published against. Without them the read path would
            // recompute an UNCAPPED confidence and quietly show a higher level than the
            // one the report was published with — normalizeBrief is only idempotent if
            // both paths judge on the same inputs. Rows written before this shipped have
            // no `verification`, and correctly fall back to no caps.
            gates: Array.isArray(dbReport.verification?.gates) ? dbReport.verification.gates : [],
        }),
        // Rows written before v24 have no run_tier and were all full-depth runs, so the
        // fallback is correct rather than merely safe. depthGaps is derived, not stored —
        // see the note in saveReport.
        runTier,
        depthGaps: depthGapsFor(runTier, {
            skippedWatch: true,
            skippedConnectors: true
        })
    };
}

/**
 * Report Service - Manages intelligence reports in Supabase
 * Handles CRUD operations for the public.reports table
 */

/**
 * Save a new intelligence report to the database
 * @param {Object} params - Report parameters
 * @param {string} params.websiteUrl - Analyzed website URL
 * @param {Object} params.context - Strategic anchors and context
 * @param {Array} params.signals - Extracted intelligence signals
 * @param {Object} params.brief - Summary insights
 * @param {string} params.userId - ID of user who created the report
 * @param {string} params.clientId - ID of the client organization
 * @returns {Object} { data, error }
 */
/**
 * Optional-column availability, cached to avoid a failed insert + retry on every save.
 *
 * These used to be one-way latches: set false on the first PGRST204 and never re-checked.
 * That is wrong across a migration. A warm serverless instance that saved a report BEFORE
 * the migration keeps skipping the column afterwards — silently, for the life of the
 * instance — so the operator applies v15, sees no error, and quietly gets no verdicts. The
 * same silent-degradation shape this module's own fallbacks exist to avoid.
 *
 * A latch with an expiry fixes it without reintroducing the retry cost: at most one probing
 * insert per column per TTL, and the system heals itself within minutes of a migration
 * instead of waiting for the instance to recycle.
 */
const COLUMN_RECHECK_MS = 5 * 60 * 1000;
const columnState = {
    target_domain: { available: true, disabledAt: 0 },
    verification: { available: true, disabledAt: 0 },
    run_id: { available: true, disabledAt: 0 },
    // Added by the main merge. These were latched off permanently on main; they get the
    // same expiring treatment as the rest for exactly the reason above.
    degradations: { available: true, disabledAt: 0 },
    report_kind: { available: true, disabledAt: 0 },
    decision_id: { available: true, disabledAt: 0 },
    decision_context: { available: true, disabledAt: 0 },
    decision_brief: { available: true, disabledAt: 0 },
    // v24. Same expiring treatment: a deploy that lands before the migration writes
    // without them and re-probes, rather than losing the report.
    run_tier: { available: true, disabledAt: 0 },
    // v29. Same again: before the migration a report saves without its news section.
    news_items: { available: true, disabledAt: 0 },
    // v37. Same expiring treatment as decision_id above: a product's report links to its
    // target row, so it can be found by (client_id, target_id) — not only by the parent
    // company's shared target_domain.
    target_id: { available: true, disabledAt: 0 },
};

/** True when the column should be included in the next write. */
function columnAvailable(name) {
    const s = columnState[name];
    if (!s) return false;
    if (s.available) return true;
    if (Date.now() - s.disabledAt >= COLUMN_RECHECK_MS) {
        // Optimistically re-enable. If the migration still is not applied the next write
        // fails the same way and re-disables it — one wasted retry per five minutes.
        s.available = true;
        s.disabledAt = 0;
        return true;
    }
    return false;
}

function markColumnMissing(name, note) {
    const s = columnState[name];
    if (!s) return;
    if (s.available) console.warn(note);
    s.available = false;
    s.disabledAt = Date.now();
}

// Test seams. Exported so the expiry can be exercised for real rather than asserted by
// grepping for the constant — a source-shape check here passed with the expiry stubbed out.
export const __columnCache = {
    reset() { for (const s of Object.values(columnState)) { s.available = true; s.disabledAt = 0; } },
    isAvailable: columnAvailable,
    markMissing: markColumnMissing,
    /** Backdate a disabled column so the TTL can be crossed without waiting. */
    backdate(name, ms) { const s = columnState[name]; if (s) s.disabledAt -= ms; },
    RECHECK_MS: COLUMN_RECHECK_MS,
};

export async function saveReport({ websiteUrl, context, signals, brief, userId, clientId, verification = null, runId = null, degradations = [], analysisMode = 'company', decisionId = null, decisionContext = null, decisionBrief = null, runTier = 'full', newsItems = [], targetId = null }) {
    try {
        if (!supabase) {
            console.warn('Supabase not initialized. Report not saved.');
            return { data: null, error: new Error('Supabase not available') };
        }

        const basePayload = {
            website_url: websiteUrl,
            context: context,
            signals: signals,
            brief: brief,
            created_by: userId,
            client_id: clientId
        };
        const optionalValues = {
            target_domain: extractTargetDomain(websiteUrl),
            degradations: Array.isArray(degradations) ? degradations : [],
            report_kind: analysisMode === 'decision' ? 'decision' : analysisMode === PRODUCT_MODE ? 'product' : 'company',
            decision_id: decisionId || null,
            decision_context: decisionContext || {},
            decision_brief: decisionBrief || {},
            // depth_gaps is NOT persisted: for a shallow run the skipped steps are always
            // the same, so the list is a pure function of run_tier (see depthGapsFor).
            // Deriving it at read time cannot drift out of step with the pipeline.
            run_tier: runTier || 'full',
            // The "News that matters" section (v29). Written with the report because it
            // otherwise existed only in a news_items table nothing reads — so the section
            // was empty on every reload and every shared link.
            news_items: Array.isArray(newsItems) ? newsItems : [],
            // Same shape as decision_id above: a product run's own target, so its report
            // is findable by (client_id, target_id) — not only by the parent company's
            // shared target_domain, which a product carries verbatim (see v37).
            target_id: targetId || null
        };

        if (analysisMode === 'decision' && decisionId) {
            const { error: decisionError } = await supabase
                .from('decision_briefs')
                .upsert({
                    id: decisionId,
                    client_id: clientId,
                    created_by: userId,
                    raw_input: decisionContext?.raw_input || decisionContext?.decision_statement || 'Decision brief',
                    decision_frame: decisionContext || {},
                    updated_at: new Date().toISOString()
                }, { onConflict: 'id' });
            if (decisionError && decisionError.code !== 'PGRST205') {
                console.warn('[Decision] Decision record could not be persisted; report save will continue:', decisionError.message);
            }
        }

        // Upsert on run_id rather than insert, so a replayed `persist` step updates the
        // report it already wrote instead of creating a second one. Without this a crash
        // between saveReport() and completeIntelligenceJob() leaves the founder with a
        // duplicate in their history and an orphan the job never references (v18).
        //
        // Falls back to a plain insert when run_id is absent — the browser/monolith path may
        // not supply one, and a database without v18 must still be able to save a report.
        const insertReport = async () => {
            const payload = { ...basePayload };
            for (const [col, value] of Object.entries(optionalValues)) {
                if (columnAvailable(col)) payload[col] = value;
            }
            // Only written when the verifier gate actually produced a verdict, so an
            // absent verdict never overwrites a stored one with null.
            if (columnAvailable('verification') && verification) payload.verification = verification;

            const includeRunId = columnAvailable('run_id') && !!runId;
            if (includeRunId) payload.run_id = runId;

            const table = supabase.from('reports');
            return includeRunId
                ? table.upsert(payload, { onConflict: 'run_id' }).select().single()
                : table.insert(payload).select().single();
        };

        let { data, error } = await insertReport();

        // Any optional column may be absent because its migration has not been applied. The
        // report itself is never worth losing over one — drop the column and retry. Each is
        // re-probed after COLUMN_RECHECK_MS, so applying the migration heals a warm instance
        // instead of waiting for it to recycle.
        const COLUMN_NOTES = {
            run_id: 'run_id column unavailable (run v18_reports_run_id.sql); saving without replay idempotency.',
            verification: 'verification column unavailable (run v15); saving without the verifier verdict.',
            news_items: 'news_items column unavailable (run v29_report_news_items.sql); saving without the news section.'
        };
        const retryable = ['run_id', 'verification', ...Object.keys(optionalValues)];

        while (error?.code === 'PGRST204') {
            const missing = retryable.find(
                col => columnAvailable(col) && new RegExp(col, 'i').test(error.message || '')
            );
            if (!missing) break;
            markColumnMissing(missing, COLUMN_NOTES[missing]
                || `${missing} column unavailable in schema cache; retrying without it.`);
            // markColumnMissing only knows the columns declared in columnState. If a new
            // optionalValues key is ever added without one, bail rather than spin forever.
            if (columnAvailable(missing)) {
                console.error(`${missing} is not tracked in columnState; cannot drop it. Aborting retry.`);
                break;
            }
            ({ data, error } = await insertReport());
        }

        if (error) {
            console.error('Error saving report:', error);
            return { data: null, error };
        }

        if (analysisMode === 'decision' && decisionId && data?.id) {
            await supabase
                .from('decision_briefs')
                .update({ latest_report_id: data.id, updated_at: new Date().toISOString() })
                .eq('id', decisionId);
        }

        console.log('Report saved successfully:', data.id);
        return { data, error: null };
    } catch (err) {
        console.error('Unexpected error saving report:', err);
        return { data: null, error: err };
    }
}

/**
 * Update memory-related fields on an existing report after the snapshot is prepared.
 * @param {string} reportId
 * @param {Object} fields
 * @returns {Object} { data, error }
 */
export async function updateReportMemory(reportId, fields = {}) {
    try {
        if (!supabase || !reportId) {
            return { data: null, error: new Error('Supabase not available') };
        }

        const { data, error } = await supabase
            .from('reports')
            .update(fields)
            .eq('id', reportId)
            .select()
            .maybeSingle();

        if (error) {
            console.error('Error updating report memory:', error);
            return { data: null, error };
        }

        if (!data) {
            console.warn('[CompanyMemory] updateReportMemory: no row matched for reportId', reportId);
            return { data: null, error: null };
        }

        return { data, error: null };
    } catch (err) {
        console.error('Unexpected error updating report memory:', err);
        return { data: null, error: err };
    }
}

/**
 * Increment the user's run_count in the profiles table
 * @param {string} userId - User ID
 * @returns {Object} { data, error }
 */
export async function incrementRunCount(userId) {
    try {
        if (!supabase) {
            return { data: null, error: new Error('Supabase not available') };
        }

        // Uses atomic SQL UPDATE via RPC to avoid fetch-then-update race conditions.
        // Requires migration: scripts/migrations/v9_atomic_run_count.sql
        const { data, error } = await supabase
            .rpc('increment_run_count', { p_user_id: userId });

        if (error) throw error;

        const row = Array.isArray(data) ? data[0] : data;
        console.log(`Successfully incremented run_count for userId: ${userId} → ${row?.run_count}`);
        return { data: row, error: null };
    } catch (error) {
        console.error('Error incrementing run count:', error);
        return { data: null, error };
    }
}

/**
 * Get all reports for a specific client
 * @param {string} clientId - Client organization ID
 * @param {Object} options - Query options
 * @param {number} options.limit - Max number of reports (default: 50)
 * @param {string} options.orderBy - Sort field (default: 'created_at')
 * @param {boolean} options.ascending - Sort order (default: false)
 * @returns {Object} { data, error }
 */
export async function getReportsForClient(clientId, options = {}) {
    const { limit = 50, orderBy = 'created_at', ascending = false } = options;

    try {
        if (!supabase) {
            return { data: [], error: new Error('Supabase not available') };
        }

        const { data, error } = await supabase
            .from('reports')
            .select('*')
            .eq('client_id', clientId)
            .order(orderBy, { ascending })
            .limit(limit);

        if (error) {
            console.error('Error fetching reports:', error);
            return { data: [], error };
        }

        return { data, error: null };
    } catch (err) {
        console.error('Unexpected error fetching reports:', err);
        return { data: [], error: err };
    }
}

/**
 * Get a single report by ID
 * @param {string} reportId - Report UUID
 * @returns {Object} { data, error }
 */
/**
 * Fetch one report by id, via GET /api/report.
 *
 * This used to select from `reports` directly and let RLS decide. That is correct in
 * production but returns 0 rows under DEV_AUTH_BYPASS, where the browser holds no
 * Supabase JWT — so auth.uid() is NULL, every SELECT policy fails, and a locally-run
 * analysis could never display the report the worker had just saved.
 *
 * The endpoint reads with the service role and re-implements the `reports` SELECT
 * policies (including the report_access_blocks check) — see lib/handlers/report.js.
 * Browser-only; the worker never calls this.
 */
export async function getReportById(reportId) {
    try {
        if (!reportId) return { data: null, error: new Error('A report id is required.') };

        const { authenticatedFetch } = await import('./apiClient.js');
        const res = await authenticatedFetch(`/api/report?id=${encodeURIComponent(reportId)}`);

        if (!res.ok) {
            // 404 is also what a non-entitled caller gets — the endpoint mirrors RLS's
            // "0 rows" so report ids can't be probed.
            const message = res.status === 404
                ? 'Report not found, or you are not signed in with an account that can view it.'
                : `Could not load the report (${res.status}).`;
            return { data: null, error: new Error(message) };
        }

        const { report } = await res.json();
        if (!report) {
            return { data: null, error: new Error('Report not found, or you are not signed in with an account that can view it.') };
        }
        return { data: report, error: null };
    } catch (err) {
        console.error('Unexpected error fetching report:', err);
        return { data: null, error: err };
    }
}

/**
 * Resolve a report's share_token, generating and persisting one if the row lacks it.
 * The reports table has a `gen_random_uuid()` default so tokens normally exist, but
 * legacy/in-memory report objects may not carry one — this guarantees a real token
 * so "Share Brief" never silently degrades to the dashboard URL.
 * @param {string} reportId - Report UUID
 * @returns {Object} { token, error }
 */
export async function getOrCreateShareToken(reportId) {
    try {
        if (!supabase || !reportId) {
            return { token: null, error: new Error('Supabase or reportId not available') };
        }

        const { data, error } = await supabase
            .from('reports')
            .select('share_token')
            .eq('id', reportId)
            .single();

        if (error) {
            console.error('Error fetching share_token:', error);
            return { token: null, error };
        }

        if (data?.share_token) {
            return { token: data.share_token, error: null };
        }

        // Defensive backfill for rows created before the column default existed.
        const newToken = (globalThis.crypto?.randomUUID?.() || null);
        if (!newToken) {
            return { token: null, error: new Error('Unable to generate share token') };
        }

        const { data: updated, error: updateError } = await supabase
            .from('reports')
            .update({ share_token: newToken })
            .eq('id', reportId)
            .select('share_token')
            .single();

        if (updateError) {
            console.error('Error persisting share_token:', updateError);
            return { token: null, error: updateError };
        }

        return { token: updated?.share_token || newToken, error: null };
    } catch (err) {
        console.error('Unexpected error resolving share_token:', err);
        return { token: null, error: err };
    }
}

/**
 * Get all reports created by a specific user
 * @param {string} userId - User ID
 * @param {number} limit - Max number of reports (default: 50)
 * @returns {Object} { data, error }
 */
export async function getReportsByUser(userId, limit = 50, columns = '*') {
    try {
        if (!supabase) {
            return { data: [], error: new Error('Supabase not available') };
        }

        const { data, error } = await supabase
            .from('reports')
            .select(columns)
            .eq('created_by', userId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error('Error fetching user reports:', error);
            return { data: [], error };
        }

        return { data, error: null };
    } catch (err) {
        console.error('Unexpected error fetching user reports:', err);
        return { data: [], error: err };
    }
}

/**
 * Get all reports for a client organization (every member sees the org's reports,
 * not just the ones they personally ran). RLS ("clients view reports") already
 * restricts this to reports the caller's client_id is allowed to see.
 * @param {string} clientId - Client organization ID
 * @param {number} limit
 * @returns {Object} { data, error }
 */
export async function getReportsByClient(clientId, limit = 50, columns = '*') {
    try {
        if (!supabase) {
            return { data: [], error: new Error('Supabase not available') };
        }

        const { data, error } = await supabase
            .from('reports')
            .select(columns)
            .eq('client_id', clientId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error('Error fetching client reports:', error);
            return { data: [], error };
        }

        return { data, error: null };
    } catch (err) {
        console.error('Unexpected error fetching client reports:', err);
        return { data: [], error: err };
    }
}

/**
 * Get all reports for a specific website URL (within a client)
 * @param {string} clientId - Client organization ID
 * @param {string} websiteUrl - Website URL to filter by
 * @returns {Object} { data, error }
 */
export async function getReportsByUrl(clientId, websiteUrl) {
    try {
        if (!supabase) {
            return { data: [], error: new Error('Supabase not available') };
        }

        const targetDomain = extractTargetDomain(websiteUrl);
        const baseQuery = supabase
            .from('reports')
            .select('*')
            .eq('client_id', clientId)
            .order('created_at', { ascending: false });

        const byDomain = targetDomain
            ? await baseQuery.eq('target_domain', targetDomain)
            : null;

        if (byDomain?.data?.length) {
            return { data: byDomain.data, error: null };
        }

        const { data, error } = await supabase
            .from('reports')
            .select('*')
            .eq('client_id', clientId)
            .eq('website_url', websiteUrl)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching reports by URL:', error);
            return { data: [], error };
        }

        return { data, error: null };
    } catch (err) {
        console.error('Unexpected error fetching reports by URL:', err);
        return { data: [], error: err };
    }
}

/**
 * Delete a report (admin only - enforced by RLS)
 * @param {string} reportId - Report UUID
 * @returns {Object} { success, error }
 */
export async function deleteReport(reportId) {
    try {
        if (!supabase) {
            return { success: false, error: new Error('Supabase not available') };
        }

        const { error } = await supabase
            .from('reports')
            .delete()
            .eq('id', reportId);

        if (error) {
            console.error('Error deleting report:', error);
            return { success: false, error };
        }

        console.log('Report deleted:', reportId);
        return { success: true, error: null };
    } catch (err) {
        console.error('Unexpected error deleting report:', err);
        return { success: false, error: err };
    }
}

/**
 * Get report statistics for a client
 * @param {string} clientId - Client organization ID
 * @returns {Object} { totalReports, lastReportDate, uniqueUrls }
 */
export async function getClientReportStats(clientId) {
    try {
        if (!supabase) {
            return { totalReports: 0, lastReportDate: null, uniqueUrls: 0 };
        }

        const { data, error } = await supabase
            .from('reports')
            .select('id, created_at, website_url')
            .eq('client_id', clientId);

        if (error) {
            console.error('Error fetching report stats:', error);
            return { totalReports: 0, lastReportDate: null, uniqueUrls: 0 };
        }

        const totalReports = data.length;
        const lastReportDate = data.length > 0
            ? new Date(Math.max(...data.map(r => new Date(r.created_at))))
            : null;
        const uniqueUrls = new Set(data.map(r => r.website_url)).size;

        return { totalReports, lastReportDate, uniqueUrls };
    } catch (err) {
        console.error('Unexpected error calculating stats:', err);
        return { totalReports: 0, lastReportDate: null, uniqueUrls: 0 };
    }
}

/**
 * Get the most recent report for a specific URL (for delta comparison)
 * @param {string} clientId - Client organization ID
 * @param {string} websiteUrl - Website URL
 * @returns {Object} { data, error }
 */
export async function getLastReportForUrl(clientId, websiteUrl) {
    try {
        if (!supabase) {
            return { data: null, error: new Error('Supabase not available') };
        }

        const targetDomain = extractTargetDomain(websiteUrl);
        let query = supabase
            .from('reports')
            .select('*')
            .eq('client_id', clientId)
            // Company-only, same as the list endpoint's guard (lib/handlers/report.js) and
            // for the same reason: a product target shares its parent's target_domain
            // verbatim (v31), so without this a product's brief can surface here under the
            // company's own name (ContextGateScreen's "View it", the recent-report prompt
            // modal). `.neq('report_kind', 'product')` alone would ALSO drop every report
            // written before the column existed — NULL <> 'product' is NULL, not true — so
            // this uses the same NULL-safe OR the list endpoint already relies on. Treat a
            // NULL report_kind as the company report it has always meant.
            .or('report_kind.is.null,report_kind.neq.product')
            .order('created_at', { ascending: false })
            .limit(1);

        if (targetDomain) {
            const byDomain = await query.eq('target_domain', targetDomain).maybeSingle();
            if (byDomain?.data) {
                return { data: byDomain.data, error: null };
            }
        }

        const { data, error } = await supabase
            .from('reports')
            .select('*')
            .eq('client_id', clientId)
            .eq('website_url', websiteUrl)
            // Same product exclusion as the domain query above — this is the fallback path,
            // not a different rule.
            .or('report_kind.is.null,report_kind.neq.product')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) {
            console.error('Error fetching last report:', error);
            return { data: null, error };
        }

        return { data, error: null };
    } catch (err) {
        console.error('Unexpected error fetching last report:', err);
        return { data: null, error: err };
    }
}

/**
 * The most recent report FOR ONE TARGET — a product's own brief, never its parent
 * company's. `getLastReportForUrl` above is domain-scoped, and a product shares its
 * parent's target_domain verbatim (v31), so that lookup cannot tell the two apart. This
 * is what TargetCard's "Latest brief" must use for a product: without it, a click there
 * silently opens the company's newest report under the product's name.
 *
 * Fails soft on an un-migrated deployment (reports.target_id absent) — { data: null,
 * error: null } — the same "honest empty" convention as listTargets, so a caller can
 * tell "not migrated yet" apart from "never run" without them looking identical anyway;
 * both correctly show "hasn't been read yet" rather than falling back to the company brief.
 */
export async function getLastReportForTarget(clientId, targetId) {
    if (!supabase || !clientId || !targetId) {
        return { data: null, error: null };
    }
    try {
        const { data, error } = await supabase
            .from('reports')
            .select('*')
            .eq('client_id', clientId)
            .eq('target_id', targetId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) {
            if (error.code === '42703' || error.code === 'PGRST204') {
                console.warn('[reports] target_id column unavailable (run v37_intelligence_targets.sql); cannot open a target-scoped brief yet.');
                return { data: null, error: null };
            }
            console.error('Error fetching last report for target:', error);
            return { data: null, error };
        }

        return { data, error: null };
    } catch (err) {
        console.error('Unexpected error fetching last report for target:', err);
        return { data: null, error: err };
    }
}

/**
 * Friendly company slug for URLs: first label of the target domain
 * ("caremother.in" → "caremother"). Used by the /company/:slug route.
 */
export function companySlugFromDomain(domain) {
    if (!domain) return null;
    const first = String(domain).toLowerCase().split('.')[0].replace(/[^a-z0-9-]/g, '');
    return first || null;
}

/**
 * Latest report for a company slug — resolves /company/caremother to the newest
 * report whose target_domain is "caremother" or starts with "caremother.".
 * Access is enforced by RLS (own-org or same-domain viewers), so this is for
 * easy internal sharing; cross-org recipients still use the /report/:token link.
 * @returns {Object} { data, error }
 */
/**
 * Latest brief for /company/:slug, via GET /api/report?slug=.
 *
 * The workspace rewrites the address bar to /company/<slug> once a brief is open, so a
 * refresh after any run lands here. Like getReportById, the old direct select relied on
 * RLS and returned nothing under DEV_AUTH_BYPASS. The endpoint applies the same
 * entitlement check to the resolved report — the slug picks a candidate, it never
 * grants access.
 */
export async function getLatestReportForCompanySlug(slug) {
    try {
        const clean = companySlugFromDomain(slug);
        if (!clean) return { data: null, error: new Error('Invalid company slug') };

        const { authenticatedFetch } = await import('./apiClient.js');
        const res = await authenticatedFetch(`/api/report?slug=${encodeURIComponent(clean)}`);

        if (!res.ok) {
            return {
                data: null,
                error: new Error(
                    res.status === 404
                        ? 'No brief found for this company, or you do not have access to it.'
                        : `Could not load the brief (${res.status}).`
                )
            };
        }
        const { report } = await res.json();
        if (!report) {
            return { data: null, error: new Error('No brief found for this company, or you do not have access to it.') };
        }
        return { data: report, error: null };
    } catch (err) {
        console.error('Unexpected error fetching report by company slug:', err);
        return { data: null, error: err };
    }
}

/**
 * Get a single report by its share token (for viewing shared reports).
 *
 * Sharing is IDENTITY-based: the token says WHICH brief, the viewer's email says whether
 * they may see it. get_shared_report() is the enforcement + access-logging chokepoint —
 * it returns zero rows when the viewer isn't entitled, which is what drives the
 * "Request access" UI. Falls back to a direct select (RLS-gated, and RLS also honours
 * the block list) only when the RPC isn't deployed yet.
 * @param {string} shareToken - Report share token UUID
 * @returns {Object} { data, error }
 */
/**
 * Fetch a shared brief by share token, via GET /api/report?token=.
 *
 * This called the get_shared_report() RPC directly. That RPC opens with
 * `if auth.uid() is null then return;`, so under DEV_AUTH_BYPASS — where the browser
 * holds no Supabase JWT — every share link resolved to "Report not found" locally.
 *
 * The endpoint keeps both things the RPC does beyond a plain read: can_access_report()'s
 * authorization (including the email_allowlist grant that the plain SELECT policies do
 * not have) and the report_access_log audit row. See lib/handlers/report.js.
 */
export async function getReportByToken(shareToken) {
    try {
        if (!shareToken) return { data: null, error: new Error('Report not found') };

        const { authenticatedFetch } = await import('./apiClient.js');
        const res = await authenticatedFetch(`/api/report?token=${encodeURIComponent(shareToken)}`);

        if (!res.ok) {
            return {
                data: null,
                error: new Error(res.status === 404 ? 'Report not found' : `Could not load the brief (${res.status}).`)
            };
        }
        const { report } = await res.json();
        return { data: report || null, error: report ? null : new Error('Report not found') };
    } catch (err) {
        console.error('Unexpected error fetching shared report:', err);
        return { data: null, error: err };
    }
}

/**
 * Ask the brief's owner for access. Deliberately unauthenticated-friendly: a visitor
 * whose domain matches no client never gets a session, so this posts to an API route
 * (service role) rather than an RPC. Responses are uniform so nothing is revealed.
 * @param {string} shareToken
 * @param {string} email
 * @returns {Object} { status, error }
 */
export async function requestBriefAccess(shareToken, email) {
    try {
        const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
        const response = await fetch(`${API_BASE}/brief-access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shareToken, email })
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
            return { status: null, error: new Error(json.error || 'Unable to record request') };
        }
        return { status: json.status || 'pending', error: null };
    } catch (err) {
        console.error('requestBriefAccess failed:', err);
        return { status: null, error: err };
    }
}
