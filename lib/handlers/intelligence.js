import { applyApiSecurity } from '../_security.js';
import { requireAuthenticatedUser } from '../_auth.js';
import { isUuid } from '../../src/utils/uuid.js';
import { checkGraphCompatibility } from '../../src/services/agents/orchestration/checkpointStore.js';
import {
    createIntelligenceJob,
    failIntelligenceJob,
    findActiveJobForUser,
    getIntelligenceJobForViewer,
    isHandoffStalled,
    isJobAbandoned,
    isPendingJobStale,
    isProcessingJobStale,
    normalizeWebsiteUrl,
    resumeAfterContextReview,
    serializeJob,
    triggerIntelligenceJob
} from '../_intelligenceJobs.js';

/**
 * Reserve the run AND decide its research depth.
 *
 * The tier is derived from the reservation's own `reason`, which already collapses
 * admin ∨ is_premium ∨ client.exempt_from_freemium into 'unlimited' — a 1:1 match with
 * "full depth". Deliberately NOT a new column on reserve_report_run's return type:
 * Postgres rejects `create or replace` when a function's return type changes, so that
 * would need drop + recreate + re-applying both revokes, and every run request 500s in
 * the window between.
 *
 * ⚠️  Never read the tier from req.body. It decides how much money a run spends.
 */
async function reserveFounderRun(auth, websiteUrl) {
    if (auth.profile.role === 'admin') {
        return { reservedRun: false, runTier: 'full' };
    }

    const { data, error } = await auth.supabaseAdmin.rpc('reserve_report_run', {
        p_user_id: auth.user.id,
        p_website_url: websiteUrl
    });

    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.allowed) {
        const err = new Error(row?.reason || 'report_limit_reached');
        err.statusCode = row?.reason === 'report_limit_reached' ? 402 : 403;
        err.runCount = row?.run_count ?? auth.profile.run_count ?? 0;
        throw err;
    }

    return {
        reservedRun: row.reason === 'reserved',
        runCount: row.run_count,
        unlimited: row.reason === 'unlimited',
        runTier: row.reason === 'unlimited' ? 'full' : 'shallow'
    };
}

/**
 * Resolve the target a run is for.
 *
 * ⚠️ Never trust the body beyond the id. A targetId decides which canonical URL gets
 * scraped and whose context gets inherited, so the row is re-read server-side and checked
 * against the caller's own client — the same discipline reserveFounderRun applies to tier.
 *
 * Deliberately does NOT touch the run tier. Depth is decided by the reservation alone.
 *
 * Returns { target, sources, productContext } or throws with a statusCode.
 */
async function resolveRunTarget(auth, clientId, targetId) {
    if (!targetId) return null;

    // A target id that is not a uuid never existed on the server — typically a placeholder
    // the browser minted for a product it saved only locally. Without this the query below
    // reaches Postgres, which answers `invalid input syntax for type uuid` and that raw
    // message was shown to the founder.
    if (!isUuid(targetId)) {
        const err = new Error('That product was never saved to your workspace. Add it again to run it.');
        err.statusCode = 400;
        throw err;
    }

    const { data: target, error } = await auth.supabaseAdmin
        .from('intelligence_targets')
        .select('id, client_id, type, name, slug, status, target_domain')
        .eq('id', targetId)
        .maybeSingle();

    if (error) throw error;

    if (!target || target.client_id !== clientId) {
        const err = new Error('That target is not yours.');
        err.statusCode = 403;
        throw err;
    }
    if (target.status === 'archived') {
        const err = new Error(`${target.name} is archived. Restore it before running it.`);
        err.statusCode = 409;
        throw err;
    }
    if (target.status === 'draft') {
        const err = new Error(`${target.name} is not set up yet. Finish adding its sources first.`);
        err.statusCode = 409;
        throw err;
    }

    const { data: sources, error: sourcesError } = await auth.supabaseAdmin
        .from('intelligence_target_sources')
        .select('canonical_url, linkedin_url, supporting_urls, documents')
        .eq('target_id', target.id)
        .maybeSingle();

    if (sourcesError) throw sourcesError;

    if (target.type !== 'product') return { target, sources, productContext: null };

    if (!sources?.canonical_url) {
        const err = new Error(`${target.name} has no page I can read yet.`);
        err.statusCode = 409;
        throw err;
    }

    return {
        target,
        sources,
        // The authoritative _product lives on the product's stored context row (written
        // at confirm time by inheritCompanyContext). This is a FALLBACK only, for a target
        // created before that row existed — stepContext prefers the stored row.
        productContext: {
            target_id: target.id,
            name: target.name,
            canonical_url: sources.canonical_url,
        },
    };
}

/**
 * Create the `decision_briefs` row before anything references it.
 *
 * `intelligence_jobs.decision_id` is a FOREIGN KEY to decision_briefs(id), but the only
 * writer of that table was `saveReport` — at `persist`, the very last step. So the job
 * insert always pointed at a row that would not exist for another several minutes, and
 * failed with intelligence_jobs_decision_id_fkey.
 *
 * That has been true since v19 and never fired, because the decision-mode toggle was
 * unreachable in the UI (a decorative overlay swallowed its clicks). Making the question
 * the front door is what finally exercised the path.
 *
 * The frame is a real entity by this point — the founder confirmed it on the review
 * screen — so creating it here is right, not a workaround. `saveReport` still upserts on
 * the same id at persist, which now updates rather than inserts.
 *
 * Returns the id to attach, or null. A failure here nulls the link rather than failing the
 * run: `decision_id` groups reruns of the same question for analytics, while the frame
 * itself rides in `decision_context` jsonb. Losing the grouping is a paper cut; losing the
 * run is not.
 */
async function ensureDecisionBrief(auth, { clientId, decisionId, decisionContext }) {
    if (!decisionId || !decisionContext) return null;
    try {
        const { error } = await auth.supabaseAdmin
            .from('decision_briefs')
            .upsert({
                id: decisionId,
                client_id: clientId,
                created_by: auth.user.id,
                raw_input: decisionContext.raw_input || decisionContext.decision_statement || 'Inquiry',
                decision_frame: decisionContext,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'id' });

        if (error) {
            console.warn('[Decision] Could not pre-create decision brief; job will run unlinked:', error.message);
            return null;
        }
        return decisionId;
    } catch (error) {
        console.warn('[Decision] Unexpected error pre-creating decision brief:', error.message);
        return null;
    }
}

async function ensureTargetClient(auth, requestedClientId) {
    if (auth.profile.role !== 'admin') {
        // brief_viewer is read-only: they reached the product by having an email on a
        // client's domain, not by being invited, so they must not spend a run.
        if (auth.profile.role === 'brief_viewer') {
            const err = new Error('Your access is view-only. Ask an admin for full access to run analyses.');
            err.statusCode = 403;
            throw err;
        }
        if (!auth.profile.client_id) {
            const err = new Error('Your account is not linked to an organization yet. Ask an admin to set you up.');
            err.statusCode = 403;
            throw err;
        }
        // Verify the client actually exists — a stale/orphaned profile.client_id would
        // otherwise surface as a raw "intelligence_jobs_client_id_fkey" FK error mid-run.
        const { data, error } = await auth.supabaseAdmin
            .from('clients')
            .select('id')
            .eq('id', auth.profile.client_id)
            .maybeSingle();
        if (error) throw error;
        if (!data) {
            const err = new Error('Your organization could not be found. Ask an admin to re-link your account.');
            err.statusCode = 409;
            throw err;
        }
        return auth.profile.client_id;
    }

    const clientId = requestedClientId || auth.profile.client_id;
    if (!clientId) {
        const err = new Error('clientId required for admin jobs');
        err.statusCode = 400;
        throw err;
    }

    const { data, error } = await auth.supabaseAdmin
        .from('clients')
        .select('id')
        .eq('id', clientId)
        .maybeSingle();

    if (error) throw error;
    if (!data) {
        const err = new Error('Client not found');
        err.statusCode = 404;
        throw err;
    }

    return clientId;
}

/**
 * Resume a job parked in `awaiting_context_review` with the founder's reviewed context.
 *
 * This is where the free-tier run is consumed for the server-context path: the job now
 * exists from the moment the founder submits a URL, so reserving at creation would burn
 * their single report if they abandoned the review screen.
 */
async function handleResumeJob(req, res, auth) {
    const jobId = req.body?.jobId;
    const reviewedContext = req.body?.reviewedContext;

    if (!reviewedContext || typeof reviewedContext !== 'object') {
        return res.status(400).json({ error: 'reviewedContext required' });
    }

    try {
        const job = await getIntelligenceJobForViewer(auth.supabaseAdmin, auth.profile, jobId);
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }
        if (job.status !== 'awaiting_context_review') {
            return res.status(409).json({ error: `Job is ${job.status}, not awaiting context review` });
        }

        // A job parked here waits on a human, so a deploy can easily land between the
        // context build and the founder pressing Confirm. Its checkpoint then belongs to
        // the previous graph and the worker will refuse it on the first invocation — but
        // `reserveFounderRun` below has already spent the founder's one free run by then.
        // Check BEFORE reserving: a stale analysis should cost them nothing.
        const stepOutputs = job.step_outputs || {};
        const compat = checkGraphCompatibility(stepOutputs.__graph, {
            allowMismatch: process.env.ALLOW_GRAPH_VERSION_MISMATCH === '1',
        });
        if (!compat.ok) {
            console.warn(`[intelligence:resume] stale checkpoint for job ${jobId}: ${compat.reason}`);
            await failIntelligenceJob(
                auth.supabaseAdmin, job.id,
                'This analysis was prepared by an earlier version and cannot be resumed. Please start a new one.'
            );
            return res.status(409).json({
                error: 'This analysis is out of date and could not be resumed. Start a new one — your run has not been used.',
                staleCheckpoint: true
            });
        }

        const reservation = await reserveFounderRun(auth, job.website_url);

        const resumed = await resumeAfterContextReview(auth.supabaseAdmin, jobId, {
            ...stepOutputs,
            state: { ...(stepOutputs.state || {}), context: reviewedContext },
            __control: { ...(stepOutputs.__control || {}), step: 'memory' }
        });

        if (!resumed) {
            // Lost a race with a concurrent resume; the other one wins.
            return res.status(409).json({ error: 'Job is no longer awaiting context review' });
        }

        // run_tier is written unconditionally, reserved_run only when a run was actually
        // consumed. Folding the tier into the `if` would leave it at the column default
        // for premium and admin users — right by luck today, silently wrong the moment
        // the default changes.
        const postResumeFields = { run_tier: reservation.runTier || 'full' };
        if (reservation.reservedRun) postResumeFields.reserved_run = true;

        await auth.supabaseAdmin
            .from('intelligence_jobs')
            .update(postResumeFields)
            .eq('id', jobId);

        triggerIntelligenceJob(req, jobId);

        return res.json({
            success: true,
            job: serializeJob(resumed),
            runCount: reservation.runCount,
            unlimited: reservation.unlimited || false
        });
    } catch (error) {
        console.error('[intelligence:resume]', error);
        return res.status(error.statusCode || 500).json({
            error: error.message || 'Unable to resume intelligence job',
            runCount: error.runCount
        });
    }
}

async function handleCreateJob(req, res, auth) {
    try {
        const clientId = await ensureTargetClient(auth, req.body?.clientId);

        // Resolve the target BEFORE requiring a websiteUrl: a product run supplies its own
        // canonical_url from the target row, so a {targetId}-only request — exactly how the
        // frontend calls this — must not be rejected before the target is even looked at.
        // This does run ahead of reserveFounderRun, but resolveRunTarget makes no network or
        // LLM call (a couple of indexed reads scoped to the caller's own clientId) and it
        // already collapses "target does not exist" and "target belongs to another client"
        // into the identical 403 above, so an unreserved caller learns nothing about another
        // client's targets by probing it.
        const runTarget = await resolveRunTarget(auth, clientId, req.body?.targetId);
        const isProductRun = runTarget?.target?.type === 'product';

        const websiteUrl = normalizeWebsiteUrl(req.body?.websiteUrl);
        if (!isProductRun && !websiteUrl) {
            return res.status(400).json({ error: 'Valid websiteUrl required' });
        }
        // Identity is decoupled from source, on purpose. A run's website URL is always the
        // RESOLVED TARGET's own target_domain — for a product this is its PARENT COMPANY's
        // domain, carried verbatim (v31: "a product carries its parent's target_domain
        // verbatim"), never the product's own canonical_url. A product may legitimately
        // live on its own host (a company at acme.com with a product at widget.io); filing
        // the report's target_domain under that host instead would make it invisible to
        // everything keyed on target_domain — the Desk, the Agenda, Reads, daily_checks and
        // both crons — and a later run of v31's backfill would mint a whole new company
        // target for it. canonical_url still reaches the pipeline, as a SOURCE TO READ
        // inside the product context (productContext below), never as the run's identity.
        // Do NOT "fix" this back to canonical_url.
        const effectiveWebsiteUrl = runTarget
            ? normalizeWebsiteUrl(runTarget.target.target_domain)
            : websiteUrl;

        const buildContextOnServer = req.body?.buildContextOnServer ?? !req.body?.contextData;

        // A server-side context build costs a scrape plus an LLM call before any run is
        // reserved. One in-flight job per user stops that from being free to spam.
        if (buildContextOnServer && auth.profile.role !== 'admin') {
            const active = await findActiveJobForUser(auth.supabaseAdmin, auth.user.id);
            if (active) {
                return res.status(409).json({
                    error: 'You already have an analysis in progress.',
                    jobId: active.id
                });
            }
        }

        // On the server-context path the run is reserved at resume, not here — see
        // handleResumeJob. Reserving now would charge a founder who abandons the review.
        //
        // That also means the tier is unknown at this point, so the row falls back to the
        // column default ('full') and handleResumeJob overwrites it with the real value.
        // Safe because only the `context` step runs before the review pause, and context
        // building spends no query budget and takes no deep reads — every metered step is
        // downstream of the reservation.
        const reservation = buildContextOnServer
            ? { reservedRun: false, runTier: null }
            : await reserveFounderRun(auth, effectiveWebsiteUrl);

        const analysisMode = req.body?.analysisMode === 'decision' ? 'decision' : 'company';
        const decisionContext = req.body?.decisionContext || req.body?.contextData?._decision || {};
        // Must run BEFORE the job insert — intelligence_jobs.decision_id is a FK to this row.
        const decisionId = analysisMode === 'decision'
            ? await ensureDecisionBrief(auth, {
                clientId,
                decisionId: req.body?.decisionId || decisionContext?.id || null,
                decisionContext,
            })
            : null;

        const job = await createIntelligenceJob(auth.supabaseAdmin, {
            clientId,
            createdBy: auth.user.id,
            websiteUrl: effectiveWebsiteUrl,
            linkedinUrl: req.body?.linkedinUrl || null,
            jobOrigin: auth.profile.role === 'admin' ? 'admin' : 'founder',
            requestedByRole: auth.profile.role,
            contextPayload: req.body?.contextData || null,
            uploadedDocText: req.body?.uploadedDocText || null,
            buildContextOnServer,
            reservedRun: reservation.reservedRun,
            runTier: reservation.runTier,
            analysisMode: isProductRun ? 'product' : analysisMode,
            decisionId,
            decisionContext,
            targetId: runTarget?.target?.id || null,
            productContext: runTarget?.productContext || null
        });

        triggerIntelligenceJob(req, job.id);

        return res.json({
            success: true,
            job: serializeJob(job),
            runCount: reservation.runCount,
            unlimited: reservation.unlimited || false
        });
    } catch (error) {
        console.error('[intelligence:create]', error);
        return res.status(error.statusCode || 500).json({
            error: error.message || 'Unable to create intelligence job',
            runCount: error.runCount
        });
    }
}

async function handleGetJob(req, res, auth) {
    const jobId = req.query?.id;

    try {
        // No id: the caller wants their own in-flight job, not a specific one. The
        // pause/resume flow parks a job in `awaiting_context_review` for as long as the
        // founder takes to fill out onboarding, and `activeJobId` lives only in React
        // state — a reload during that window otherwise strands the job with no way back
        // to it, while `findActiveJobForUser`'s create-time guard still blocks starting a
        // new one. Reconnecting on load closes that gap.
        const job = jobId
            ? await getIntelligenceJobForViewer(auth.supabaseAdmin, auth.profile, jobId)
            : await findActiveJobForUser(auth.supabaseAdmin, auth.user.id);

        if (!job) {
            if (!jobId) return res.json({ job: null });
            return res.status(404).json({ error: 'Job not found' });
        }

        // A `pending` job that's been stuck this long was never claimed despite repeated
        // retriggers (broken worker URL, auth misconfig, worker crash before claim) — give
        // up instead of resurfacing the same dead job to the founder on every reconnect.
        if (isPendingJobStale(job)) {
            const failed = await failIntelligenceJob(auth.supabaseAdmin, job.id, 'Analysis could not start. Please try again.');
            return res.json({ job: serializeJob(failed) });
        }

        // Same for a `processing` job whose worker has been dead for a long time: it would
        // otherwise be re-triggered by the branch below on every reconnect, trapping the
        // founder on the analyzing screen on every page load. Fail it so a new run can start.
        if (isProcessingJobStale(job)) {
            const failed = await failIntelligenceJob(auth.supabaseAdmin, job.id, 'Analysis stalled and could not be resumed. Please run it again.');
            return res.json({ job: serializeJob(failed) });
        }

        // Backup trigger for a dropped self-trigger. `pending` means the worker was never
        // reached; a `processing` job that stopped heartbeating means its worker died
        // mid-run. A job awaiting context review waits on a human and is never triggered.
        if (job.status === 'pending' || isJobAbandoned(job) || isHandoffStalled(job)) {
            triggerIntelligenceJob(req, job.id);
        }

        // The live slice is opt-in per request: the client sends the cursor it has already
        // consumed, so a poll on an unchanged run costs a status row and nothing more.
        return res.json({
            job: serializeJob(job, {
                sinceSignal: req.query?.sinceSignal,
                haveV6: req.query?.haveV6 === '1'
            })
        });
    } catch (error) {
        console.error('[intelligence:get]', error);
        return res.status(error.statusCode || 500).json({
            error: error.message || 'Unable to load intelligence job'
        });
    }
}

export async function handler(req, res) {
    if (await applyApiSecurity(req, res, {
        routeKey: 'intelligence',
        allowedMethods: ['GET', 'POST'],
        maxRequests: 60
    })) return;

    const auth = await requireAuthenticatedUser(req, res);
    if (!auth) return;

    if (req.method === 'GET') {
        return await handleGetJob(req, res, auth);
    }

    // A `jobId` in the body is what distinguishes resuming a paused job from creating one.
    if (req.body?.jobId) {
        return await handleResumeJob(req, res, auth);
    }

    return await handleCreateJob(req, res, auth);
}
