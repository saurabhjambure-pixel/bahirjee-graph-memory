import { applyApiSecurity } from '../_security.js';
import { getSupabaseAdmin } from '../_auth.js';
import { createIntelligenceJob, triggerIntelligenceJob } from '../_intelligenceJobs.js';
import { extractTargetDomain } from '../../src/services/reportService.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SCHEDULED INTELLIGENCE RUNS
//
// Queues a run for every client that opted into a cadence. It creates rows and stops —
// the existing worker drains the queue exactly as it does for founder-initiated runs.
// There is deliberately no new pipeline, queue, or orchestration here.
//
// Why this exists: the cross-run layer (patterns, shifts, Opportunity Radar) is
// time-windowed — velocity is "observations in the last 7 days vs the prior 23" — so it
// only produces anything when runs are spread over weeks. Without a schedule that half of
// the product never activates.
//
// This spends real money on a timer, so every guard below is load-bearing.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Ceiling per firing. Each run costs roughly $0.16 and occupies worker capacity; a large
// backlog is drained across successive ticks rather than all at once. Clients are ordered
// by least-recently-queued, so nobody is starved by the cap.
const MAX_RUNS_PER_FIRING = Number(process.env.CRON_MAX_RUNS_PER_FIRING || 5);

// CADENCE_DAYS and isDue moved to src/services/cadence.js: the founder-facing cadence bar
// needs the same arithmetic, and a UI that approximates the scheduler's rules would tell
// people a read is coming on a day it is not. Re-exported so existing importers and
// scripts/cron-runs.test.mjs keep working unchanged.
// ⚠️ Imported AND re-exported deliberately. `export { isDue } from '...'` alone creates no
// local binding, so the `isDue(c)` call below would be a ReferenceError at runtime — and
// the unit test would not catch it, because the test imports isDue directly without ever
// executing the handler.
import { isDue } from '../../src/services/cadence.js';
export { isDue };

/**
 * Authenticate the scheduler.
 *
 * Two accepted callers, both server-side:
 *   - Vercel Cron, which sends `Authorization: Bearer $CRON_SECRET`
 *   - an internal/manual invocation using the same `x-bahirjee-internal-key` header the
 *     worker self-trigger already uses
 *
 * Falls back to the service-role key so this matches hasValidInternalApiKey's precedence
 * in _auth.js — a mismatch there is what once left every job stuck in `pending`.
 */
export function isAuthorizedScheduler(req) {
    const internalKey = process.env.INTERNAL_API_KEY
        || process.env.SUPABASE_SERVICE_ROLE_KEY
        || process.env.VITE_SUPABASE_SERVICE_ROLE_KEY;
    const cronSecret = process.env.CRON_SECRET || internalKey;

    const provided = req.headers?.['x-bahirjee-internal-key'];
    if (internalKey && provided && provided === internalKey) return true;

    const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
    if (cronSecret && authHeader === `Bearer ${cronSecret}`) return true;

    return false;
}


export async function handler(req, res) {
    // Vercel Cron issues a GET; internal/manual invocation uses POST.
    if (await applyApiSecurity(req, res, {
        routeKey: 'cron-runs',
        allowedMethods: ['GET', 'POST'],
        allowHeaders: ['Content-Type', 'Authorization', 'x-bahirjee-internal-key'],
        maxRequests: 20
    })) return;

    if (!isAuthorizedScheduler(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    let supabaseAdmin;
    try {
        supabaseAdmin = getSupabaseAdmin();
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }

    const summary = { considered: 0, queued: 0, skipped: [], errors: [] };

    try {
        const { data: clients, error } = await supabaseAdmin
            .from('clients')
            .select('id, name, auto_run_cadence, auto_run_last_queued_at')
            .eq('status', 'active')
            .not('auto_run_cadence', 'is', null)
            .neq('auto_run_cadence', 'off')
            // Least-recently-queued first, so the per-firing cap rotates fairly.
            .order('auto_run_last_queued_at', { ascending: true, nullsFirst: true })
            .limit(MAX_RUNS_PER_FIRING * 4);

        if (error) throw error;

        const due = (clients || []).filter(c => isDue(c));
        summary.considered = due.length;

        for (const client of due) {
            if (summary.queued >= MAX_RUNS_PER_FIRING) break;

            try {
                // ── Guard: never stack runs ──────────────────────────────────────
                // A client already mid-run must not be queued again; duplicate jobs both
                // bill twice and race each other's memory writes.
                const { data: activeJobs, error: activeErr } = await supabaseAdmin
                    .from('intelligence_jobs')
                    .select('id')
                    .eq('client_id', client.id)
                    .in('status', ['pending', 'processing'])
                    .limit(1);
                if (activeErr) throw activeErr;
                if (activeJobs?.length) {
                    summary.skipped.push({ clientId: client.id, reason: 'run_already_active' });
                    continue;
                }

                // ── Reuse the last report's context ──────────────────────────────
                // A scheduled run must not stop to ask a human to review context, and
                // reusing the previous context keeps the run on the same context version,
                // which is what makes cross-run memory line up.
                const { data: lastReport, error: reportErr } = await supabaseAdmin
                    .from('reports')
                    .select('website_url, context, created_by')
                    .eq('client_id', client.id)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();
                if (reportErr) throw reportErr;

                if (!lastReport?.website_url || !lastReport?.context) {
                    // Nothing to repeat yet — a client must complete one real run first.
                    // Still the outer guard even now that company_contexts exists: a client
                    // with a stored context but no report has no website_url to run against.
                    summary.skipped.push({ clientId: client.id, reason: 'no_prior_report' });
                    continue;
                }

                // ── Prefer the context the founder actually approved ─────────────
                // lastReport.context is a run OUTPUT: mutated by stepDiscoverCompetitors,
                // stepValidateExa and stepMemory's competitor merge, and carrying none of
                // the corrections made on the review screen. Replaying it week after week
                // compounds those mutations and quietly re-adds competitors a human
                // deleted. company_contexts holds what the founder signed off on.
                //
                // Queried inline with supabaseAdmin rather than through
                // companyContextService, which imports the anon-key browser client.
                let contextPayload = lastReport.context;
                let contextSource = 'last_report';
                const targetDomain = extractTargetDomain(lastReport.website_url);
                if (targetDomain) {
                    const { data: current, error: currentErr } = await supabaseAdmin
                        .from('company_contexts')
                        .select('context')
                        .eq('client_id', client.id)
                        .eq('target_domain', targetDomain)
                        .eq('is_current', true)
                        .maybeSingle();
                    // 42P01 = table missing (v26 not applied): fall through silently.
                    if (currentErr && currentErr.code !== '42P01') {
                        console.warn(`[Cron] company_contexts lookup failed for ${client.id}:`, currentErr.message);
                    } else if (current?.context && Object.keys(current.context).length > 0) {
                        contextPayload = current.context;
                        contextSource = 'company_context';
                    }
                }

                // A scheduled run is never a decision run. Inheriting a stored decision
                // frame would make the pipeline emit a decision brief nobody asked for,
                // against a question nobody is currently asking.
                if (contextPayload?._decision) {
                    contextPayload = { ...contextPayload };
                    delete contextPayload._decision;
                }

                // intelligence_jobs.created_by is NOT NULL and FKs to auth.users, so the
                // run has to be attributed to a real person. Prefer whoever owned the last
                // report; fall back to any active member of the client.
                let createdBy = lastReport.created_by;
                if (!createdBy) {
                    const { data: member } = await supabaseAdmin
                        .from('profiles')
                        .select('id')
                        .eq('client_id', client.id)
                        .eq('is_active', true)
                        .limit(1)
                        .maybeSingle();
                    createdBy = member?.id || null;
                }
                if (!createdBy) {
                    summary.skipped.push({ clientId: client.id, reason: 'no_active_user' });
                    continue;
                }

                const job = await createIntelligenceJob(supabaseAdmin, {
                    clientId: client.id,
                    createdBy,
                    websiteUrl: lastReport.website_url,
                    linkedinUrl: null,
                    jobOrigin: 'scheduled',
                    requestedByRole: 'client_user',
                    contextPayload,
                    buildContextOnServer: false,
                    // Scheduled runs are not charged against the founder's freemium quota —
                    // they didn't click anything, so they must not burn their single free run.
                    reservedRun: false
                });

                // Stamp before triggering: if the trigger fails, the job still exists and
                // the stale-job sweeper owns it. Stamping after would risk re-queueing the
                // same client every tick.
                await supabaseAdmin
                    .from('clients')
                    .update({ auto_run_last_queued_at: new Date().toISOString() })
                    .eq('id', client.id);

                const triggered = triggerIntelligenceJob(req, job.id);
                if (!triggered) {
                    console.warn(`[cron-runs] Job ${job.id} created but not triggered — INTERNAL_API_KEY / host missing`);
                }

                summary.queued += 1;
                // contextSource is worth logging: a fleet still running on last_report is a
                // fleet whose founders' corrections are being replayed away every week.
                console.log(`[cron-runs] Queued ${client.auto_run_cadence} run for client ${client.id} (job ${job.id}, context: ${contextSource})`);
            } catch (clientErr) {
                // One bad client must not abort the whole sweep.
                console.error(`[cron-runs] Failed for client ${client.id}:`, clientErr.message);
                summary.errors.push({ clientId: client.id, error: clientErr.message });
            }
        }

        return res.json({ success: true, ...summary });
    } catch (error) {
        console.error('[cron-runs] Sweep failed:', error);
        return res.status(500).json({ error: error.message });
    }
}
