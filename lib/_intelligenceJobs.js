import { waitUntil } from '@vercel/functions';

// A single invocation can hold the job for at most 60s (Vercel's hard kill), and every
// progress write renews the lock. Two minutes is therefore ample for a live worker, and
// bounds how long a dead one blocks recovery. Longer than one step, shorter than a user's
// patience.
const JOB_LOCK_MINUTES = 2;

export function normalizeWebsiteUrl(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.length > 2048) return null;
    try {
        const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
        const parsed = new URL(withProtocol);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        if (!parsed.hostname || parsed.hostname.includes('..')) return null;
        return parsed.toString();
    } catch {
        return null;
    }
}

// How long a `processing` job may go without a heartbeat before we assume its worker died.
// Must exceed the longest gap between progress writes within one step — the analyze step's
// LLM batch is the worst case at ~25s.
const JOB_ABANDONED_MS = 90_000;

// A released job whose next invocation has not claimed it after this long lost its
// self-trigger. A healthy handoff is claimed within a couple of seconds (cold start included).
const HANDOFF_STALL_MS = 20_000;

/**
 * Was this job handed off to a next invocation that never arrived?
 *
 * releaseForNextStep() writes a fresh heartbeat AND an already-expired lock, and the worker
 * then fires a self-trigger. If that request is lost, nothing claims the job, and the only
 * thing that ever noticed was isJobAbandoned() — 90s after the heartbeat. A production run
 * lost five of those (~100s each, ~8 of its 17 minutes) between steps that had all finished
 * and checkpointed. A job that is released AND unclaimed is distinguishable from a running
 * worker (which holds an unexpired lock, renewed by every progress write), so it can be
 * re-triggered in seconds. Claiming is a compare-and-set, so a trigger that was merely slow
 * and arrives alongside this one just loses the race.
 */
export function isHandoffStalled(job) {
    if (!job || job.status !== 'processing') return false;
    const lockExpiresAt = job.lock_expires_at ? new Date(job.lock_expires_at).getTime() : 0;
    if (!lockExpiresAt || lockExpiresAt > Date.now()) return false;
    const beat = job.last_heartbeat_at ? new Date(job.last_heartbeat_at).getTime() : 0;
    return beat > 0 && Date.now() - beat > HANDOFF_STALL_MS;
}

/**
 * Has the worker holding this job died?
 *
 * Deliberately NOT "is the lock expired". releaseForNextStep() expires the lock on every
 * normal step handoff, precisely so the next invocation can claim it — treating that as a
 * dead worker would make every poll fire a duplicate trigger. A dead worker is one that
 * has stopped heartbeating.
 */
export function isJobAbandoned(job) {
    if (!job || job.status !== 'processing') return false;
    const beat = job.last_heartbeat_at ? new Date(job.last_heartbeat_at).getTime() : 0;
    if (!beat) return false;
    return Date.now() - beat > JOB_ABANDONED_MS;
}

// A healthy pending job gets claimed within seconds of its self-trigger. If it's still
// `pending` after this long, the trigger is broken (bad worker URL, auth mismatch, worker
// crash before claim) rather than merely slow — retriggering it forever would otherwise
// resurface the same dead job to the founder on every reconnect.
const PENDING_STALE_MS = 2 * 60_000;

export function isPendingJobStale(job) {
    if (!job || job.status !== 'pending') return false;
    return Date.now() - new Date(job.created_at).getTime() > PENDING_STALE_MS;
}

// The same protection PENDING_STALE_MS gives `pending`, for `processing`. An abandoned
// processing job is re-triggered on every reconnect; if its worker keeps dying on the same
// step those retries never converge, and the founder is trapped on the analyzing screen on
// every page load with no way out but signing out. Well past the 90s abandoned threshold
// (~7 failed retrigger cycles), give up and fail it so a fresh run can be started.
const PROCESSING_STALE_MS = 10 * 60_000;

export function isProcessingJobStale(job) {
    if (!job || job.status !== 'processing') return false;
    // Fall back to updated_at/created_at so a job that never heartbeat at all still ages out.
    const last = job.last_heartbeat_at || job.updated_at || job.created_at;
    if (!last) return false;
    return Date.now() - new Date(last).getTime() > PROCESSING_STALE_MS;
}

/**
 * How many signals one poll may carry. The client advances its cursor by what it actually
 * received, so a backlog drains over consecutive polls instead of arriving as one large
 * response on a 3s interval.
 */
const MAX_LIVE_SIGNALS_PER_POLL = 40;

// Bounds for the hunt block. These are display surfaces, not data transfer — a founder
// reads a handful of queries and a scrolling strip of domains, not 132 of either.
const MAX_HUNT_WATCHLIST = 24;
const MAX_HUNT_QUERIES = 24;
const MAX_HUNT_HOSTS = 40;

/** Hostname only, or null. Never the URL — a path can carry a query string. */
function hostOf(url) {
    try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return null; }
}

/**
 * What the engine is doing, for the ~2 minutes before the first signal exists.
 *
 * Every field is work actually being performed, read out of the checkpoint. None of it is
 * invented progress: these are the real entities being tracked, the real queries being
 * issued, and the real domains being read. The alternative — a spinner over an empty
 * report — made the founder's own confirmed context vanish at the moment they confirmed it.
 *
 * ⚠️  Projects HOSTNAMES, never `search.candidates`. That array holds up to ~132 result
 *     objects with titles and content snippets; shipping it on a 3-second poll is the same
 *     mistake the 512KB checkpoint cap exists to prevent.
 */
function buildHunt(state) {
    const ctx = state.context || {};

    const entities = Array.isArray(ctx._trackedEntities) ? ctx._trackedEntities : [];
    const watchlist = (entities.length
        ? entities.map(e => ({ name: e?.name, category: e?.category || null }))
        : (Array.isArray(ctx.key_competitors) ? ctx.key_competitors : [])
            .map(c => ({ name: typeof c === 'object' ? c?.name : c, category: 'competitor' }))
    ).filter(e => e.name).slice(0, MAX_HUNT_WATCHLIST);

    const selected = Array.isArray(state.queries?.selected) ? state.queries.selected : [];

    const hosts = [];
    const seen = new Set();
    for (const c of Array.isArray(state.search?.candidates) ? state.search.candidates : []) {
        const h = hostOf(c?.url);
        if (!h || seen.has(h)) continue;
        seen.add(h);
        hosts.push(h);
        if (hosts.length >= MAX_HUNT_HOSTS) break;
    }

    return {
        watchlist,
        queries: selected.slice(0, MAX_HUNT_QUERIES).map(q => q?.query).filter(Boolean),
        queryProgress: state.search
            ? { cursor: state.search.cursor || 0, total: state.search.total || selected.length }
            : null,
        sourceHosts: hosts,
        sourceHostTotal: seen.size,
        watch: state.watch ? { checked: state.watch.checked || 0, changed: state.watch.changed || 0 } : null,
        collect: state.collect ? { calls: state.collect.calls || 0, collected: state.collect.collected || 0 } : null
    };
}

/**
 * The live slice — a bounded, explicitly whitelisted projection of the running pipeline's
 * checkpoint, so the founder can watch the report assemble instead of staring at a spinner.
 *
 * `step_outputs` is otherwise internal. Everything here is a field that already ships to the
 * client in the finished report, so nothing new is disclosed — only disclosed EARLIER. Two
 * things must never enter it:
 *   • raw observation text (0.5-1 MB per run, deliberately kept out of `state` entirely)
 *   • checkpoint internals — `__control`, `__graph`, `__provenance`, cursors, budgets
 *
 * The brief is deliberately absent. `buildReportData` runs `state.summary` through
 * `normalizeBriefForRun(...)` before it is fit for the UI, and that needs a pipeline `ctx`
 * which does not exist here. The judgment arrives with the persisted report at completion —
 * which is also where it belongs as the finale.
 */
function buildLiveSlice(job, opts = {}) {
    // Only while the run is executing. `completed` has an authoritative persisted report and
    // `awaiting_context_review` is already served by `context_for_review` below.
    if (job.status !== 'processing' && job.status !== 'pending') return null;

    const state = job.step_outputs?.state;
    if (!state) return null;

    // Once `state.analyze` exists it has been seeded with express's signals, so it is the
    // union. Before that, express is the only place early signals live.
    const signals = state.analyze
        ? (Array.isArray(state.analyze.signals) ? state.analyze.signals : [])
        : (Array.isArray(state.express?.signals) ? state.express.signals : []);

    const asked = Number(opts.sinceSignal);
    const since = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 0;

    // `deduplicateSignals` REWRITES this array at the end of stepAnalyze and can shrink it.
    // Index slicing is only valid while the array grows, so a shrink below the client's
    // cursor means "replace what you have" rather than "append to it".
    const reset = since > signals.length;
    const from = reset ? 0 : since;

    return {
        // Lets a mid-run reload rebuild the context card without waiting for completion.
        context: state.context || null,
        signalCount: signals.length,
        reset,
        sliceFrom: from,
        signals: signals.slice(from, from + MAX_LIVE_SIGNALS_PER_POLL),
        // Deterministic JS output (patterns/shifts/blind spots/opportunities), available from
        // the v6_pipeline step. Sent once — the client echoes `haveV6` back afterwards.
        v6: opts.haveV6 ? null : (state.v6 || null),
        degradations: Array.isArray(state.degradations) ? state.degradations : [],
        depthGaps: Array.isArray(state.depthGaps) ? state.depthGaps : [],
        // Drives the "forming judgment" placeholder's final beat, without shipping the
        // un-normalized brief itself.
        briefReady: Boolean(state.summary),
        // What the engine is doing. Carries the first ~2 minutes, before a signal exists.
        hunt: buildHunt(state)
    };
}

export function serializeJob(job, liveOpts = null) {
    if (!job) return null;
    return {
        id: job.id,
        client_id: job.client_id,
        created_by: job.created_by,
        website_url: job.website_url,
        linkedin_url: job.linkedin_url,
        job_origin: job.job_origin,
        requested_by_role: job.requested_by_role,
        analysis_mode: job.analysis_mode || 'company',
        // Read-only to the client. The UI uses it to disclose research depth; it is
        // decided from the server's run reservation and never accepted from a request.
        run_tier: job.run_tier || 'full',
        decision_id: job.decision_id || null,
        decision_context: job.decision_context || null,
        status: job.status,
        current_step: job.current_step,
        progress_log: Array.isArray(job.progress_log) ? job.progress_log : [],
        report_id: job.report_id,
        error_message: job.error_message,
        build_context_on_server: Boolean(job.build_context_on_server),
        // The context the server built, surfaced only while the job waits for the founder
        // to review it. `step_outputs` is otherwise internal and never leaves the server.
        context_for_review: job.status === 'awaiting_context_review'
            ? (job.step_outputs?.state?.context || null)
            : null,
        // The pipeline's run identifier — the second value allowed out of `step_outputs`,
        // and only because it is an opaque UUID carrying no report content.
        //
        // It is NOT the job id. `createPipelineState()` mints it with generateRunId() and the
        // worker carries it forward in `__control.run_id`, so the two are unrelated values.
        // The live-signal poll used to query structured_signals by job id, which never
        // matched a single row — the panel was silently always empty. Null until the first
        // step checkpoints, which getLiveSignals() already treats as "no signals yet".
        run_id: job.step_outputs?.__control?.run_id || null,
        target_id: job.target_id || null,
        // The third and last value allowed out of `step_outputs`. Null unless the caller
        // asked for it, so every existing caller keeps the exact payload it had.
        live: liveOpts ? buildLiveSlice(job, liveOpts) : null,
        created_at: job.created_at,
        started_at: job.started_at,
        completed_at: job.completed_at,
        last_heartbeat_at: job.last_heartbeat_at,
        updated_at: job.updated_at
    };
}

// `target_id` is a v37 column (scripts/migrations/v37_intelligence_targets.sql), which has
// never been applied to any database. Naming it unconditionally in the insert made
// PostgREST reject EVERY job — company, decision and product — with PGRST204 and write
// nothing, so no founder could start any analysis on an unmigrated deployment. Same
// column-availability shape as reportService.js's `columnState`, with one difference:
// losing this column silently is only safe for a company/decision run. For a run bound to
// a specific target (a product), dropping it would create a job that still runs — just as
// a plain company run, under the product's name, presenting one subject's evidence as
// another's. Losing the run is recoverable; that is not — so a target-scoped run must
// throw a clear "apply the migration" error instead of ever dropping the column.
const JOB_COLUMN_RECHECK_MS = 5 * 60 * 1000;
const jobColumnState = {
    target_id: { available: true, disabledAt: 0 },
};

function jobColumnAvailable(name) {
    const s = jobColumnState[name];
    if (!s) return false;
    if (s.available) return true;
    if (Date.now() - s.disabledAt >= JOB_COLUMN_RECHECK_MS) {
        // Optimistically re-enable. If the migration still is not applied the next probe
        // fails the same way and re-disables it — one wasted retry per five minutes.
        s.available = true;
        s.disabledAt = 0;
        return true;
    }
    return false;
}

function markJobColumnMissing(name, note) {
    const s = jobColumnState[name];
    if (!s) return;
    if (s.available) console.warn(note);
    s.available = false;
    s.disabledAt = Date.now();
}

// Test seam, same convention as reportService.js's __columnCache.
export const __jobColumnCache = {
    reset() { for (const s of Object.values(jobColumnState)) { s.available = true; s.disabledAt = 0; } },
    isAvailable: jobColumnAvailable,
    markMissing: markJobColumnMissing,
    backdate(name, ms) { const s = jobColumnState[name]; if (s) s.disabledAt -= ms; },
    RECHECK_MS: JOB_COLUMN_RECHECK_MS,
};

/** Raised when a target-scoped run cannot be started because v37 has not been applied. */
export class TargetMigrationRequiredError extends Error {
    constructor() {
        super(
            'This run is for a specific target, but intelligence_jobs.target_id does not exist '
            + 'yet. Apply scripts/migrations/v37_intelligence_targets.sql, then try again.'
        );
        this.name = 'TargetMigrationRequiredError';
        this.code = 'MIGRATION_REQUIRED';
        this.statusCode = 409;
    }
}

export async function createIntelligenceJob(supabaseAdmin, payload) {
    const basePayload = {
        client_id: payload.clientId,
        created_by: payload.createdBy,
        website_url: payload.websiteUrl,
        linkedin_url: payload.linkedinUrl || null,
        job_origin: payload.jobOrigin,
        requested_by_role: payload.requestedByRole,
        context_payload: payload.contextPayload || null,
        uploaded_doc_text: payload.uploadedDocText || null,
        build_context_on_server: Boolean(payload.buildContextOnServer),
        analysis_mode: payload.analysisMode || 'company',
        decision_id: payload.decisionId || null,
        decision_context: payload.decisionContext || {},
        progress_log: [{
            message: 'Job queued.',
            timestamp: new Date().toISOString()
        }],
        current_step: 'Queued for analysis',
        reserved_run: Boolean(payload.reservedRun),
        // Seeds the product profile into the checkpoint so stepContext can read it at the
        // very first step, before any worker invocation has run. Falls back to whatever
        // stepOutputs the caller already carries (none, today) rather than clobbering it.
        step_outputs: payload.productContext
            ? { ...(payload.stepOutputs || {}), job: { ...(payload.stepOutputs?.job || {}), productContext: payload.productContext } }
            : payload.stepOutputs
    };

    // Omitted rather than defaulted in JS when unknown, so the column default ('full')
    // stays the single source of truth for "no tier decided yet" — which is the case on
    // the server-context path, where the reservation happens at resume.
    if (payload.runTier) basePayload.run_tier = payload.runTier;

    const targetIdRequested = Boolean(payload.targetId);

    const buildPayload = (includeTargetId) => {
        const p = { ...basePayload };
        if (includeTargetId) p.target_id = payload.targetId || null;
        return p;
    };

    const attemptInsert = (withTargetId) => supabaseAdmin
        .from('intelligence_jobs')
        .insert(buildPayload(withTargetId))
        .select('*')
        .single();

    // A target-scoped run always probes for real, ignoring the cache — cached
    // unavailability is exactly the state that must never be papered over here (see the
    // comment above jobColumnState). A company/decision run trusts the cache, so a warm
    // instance is not paying for a doomed retry on every single job it creates.
    const attemptWithTargetId = targetIdRequested || jobColumnAvailable('target_id');

    let { data, error } = await attemptInsert(attemptWithTargetId);

    if (
        error?.code === 'PGRST204'
        && attemptWithTargetId
        && /target_id/i.test(error.message || '')
    ) {
        markJobColumnMissing(
            'target_id',
            '[intelligence-jobs] target_id column unavailable (run '
            + 'v37_intelligence_targets.sql); '
            + (targetIdRequested ? 'refusing to start a target-scoped run without it.' : 'queuing without it.')
        );

        if (targetIdRequested) {
            throw new TargetMigrationRequiredError();
        }

        ({ data, error } = await attemptInsert(false));
    }

    if (error) throw error;
    return data;
}

export async function getIntelligenceJob(supabaseAdmin, jobId) {
    const { data, error } = await supabaseAdmin
        .from('intelligence_jobs')
        .select('*')
        .eq('id', jobId)
        .maybeSingle();

    if (error) throw error;
    return data || null;
}

export async function getIntelligenceJobForViewer(supabaseAdmin, viewerProfile, jobId) {
    const job = await getIntelligenceJob(supabaseAdmin, jobId);
    if (!job) return null;
    if (viewerProfile.role !== 'admin' && job.client_id !== viewerProfile.client_id) {
        const error = new Error('Forbidden');
        error.statusCode = 403;
        throw error;
    }
    return job;
}

export async function appendJobProgress(supabaseAdmin, jobId, message, extraFields = {}) {
    const job = await getIntelligenceJob(supabaseAdmin, jobId);
    if (!job) return null;

    const progressLog = Array.isArray(job.progress_log) ? [...job.progress_log] : [];
    progressLog.push({
        message,
        timestamp: new Date().toISOString()
    });

    // `currentStep` is a JS-only alias mapped to the real `current_step` column — it must
    // NOT be spread into the update payload, or PostgREST rejects the whole write with
    // "Could not find the 'currentStep' column of 'intelligence_jobs' in the schema cache".
    const { currentStep, ...columnFields } = extraFields;

    const { data, error } = await supabaseAdmin
        .from('intelligence_jobs')
        .update({
            progress_log: progressLog,
            current_step: currentStep || message,
            last_heartbeat_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...columnFields
        })
        .eq('id', jobId)
        .select('*')
        .single();

    if (error) throw error;
    return data;
}

export async function claimIntelligenceJob(supabaseAdmin, jobId) {
    const job = await getIntelligenceJob(supabaseAdmin, jobId);
    if (!job) return null;

    const now = Date.now();
    const lockExpiresAt = job.lock_expires_at ? new Date(job.lock_expires_at).getTime() : 0;
    const isStaleProcessing = job.status === 'processing' && lockExpiresAt > 0 && lockExpiresAt < now;

    // A stale lock alone does not mean the previous worker died: releaseForNextStep()
    // expires the lock on every normal step handoff, precisely so the next invocation can
    // pick the job up. Only a job that also stopped heartbeating was truly abandoned.
    const isTakeover = isStaleProcessing && isJobAbandoned(job);

    if (!['pending', 'processing'].includes(job.status)) return null;
    if (job.status === 'processing' && !isStaleProcessing) return null;

    const nextLockExpiry = new Date(now + JOB_LOCK_MINUTES * 60_000).toISOString();
    const { data, error } = await supabaseAdmin
        .from('intelligence_jobs')
        .update({
            status: 'processing',
            // Re-claiming mid-run must not clobber the label the last step left behind.
            current_step: job.status === 'pending' ? 'Starting analysis' : (job.current_step || 'Starting analysis'),
            started_at: job.started_at || new Date().toISOString(),
            last_heartbeat_at: new Date().toISOString(),
            lock_expires_at: nextLockExpiry,
            // A stepped run claims the job once per step. Counting those as attempts would
            // make ~20 normal invocations look like 20 retries, so only a fresh pickup of a
            // `pending` job — or a genuine takeover from a dead worker — counts.
            attempt_count: job.status === 'pending' || isTakeover
                ? Number(job.attempt_count || 0) + 1
                : Number(job.attempt_count || 0),
            error_message: null,
            updated_at: new Date().toISOString()
        })
        .eq('id', jobId)
        .eq('updated_at', job.updated_at)
        .select('*')
        .maybeSingle();

    if (error) throw error;
    return data || null;
}

/**
 * Checkpoint a step and hand the job to the next invocation.
 *
 * The lock is deliberately expired rather than released: the job stays `processing` (so no
 * other caller treats it as new work) while `claimIntelligenceJob` sees a stale lock and
 * re-claims it. The CAS on `updated_at` means exactly one of {self-trigger, GET-poll
 * backup} wins the race; the loser gets `null` back and exits.
 */
/** Raised when another invocation advanced the checkpoint while this one was working. */
export class CheckpointConflictError extends Error {
    constructor(jobId, expected) {
        super(
            `Checkpoint for job ${jobId} moved while this invocation was running `
            + `(expected retrigger_count=${expected}). Another worker owns it; abandoning this `
            + 'write rather than overwriting theirs.'
        );
        this.name = 'CheckpointConflictError';
        this.jobId = jobId;
        this.expectedRetriggerCount = expected;
    }
}

/**
 * Persist the checkpoint and hand the job to the next invocation.
 *
 * ── Why this is a compare-and-set ────────────────────────────────────────────
 *
 * `step_outputs` is one JSONB column updated read-modify-write: the worker deep-clones it,
 * mutates, and writes the whole object back. With a plain `.eq('id', jobId)` that is a blind
 * overwrite — whichever invocation finishes LAST wins, and the other's work vanishes with no
 * error.
 *
 * The job lock makes that unlikely, not impossible. A worker that stops heartbeating while
 * still running — blocked on a long provider call between progress writes — can be taken over
 * by `claimIntelligenceJob`'s stale-lock path while it is alive. Both then hold the same job,
 * and the loser's steps are silently undone.
 *
 * `__control.retrigger_count` is the natural token: it increments once per invocation and
 * `appendJobProgress` does not touch `step_outputs`, so it is stable for the whole step.
 * Guarding on the value we READ means a write only lands if the checkpoint is still the one
 * we based our work on.
 *
 * This is also §7.1's stated prerequisite for retrieval fan-out. Shards writing concurrently
 * need exactly this property; without it the plan's own analysis says fan-out loses writes.
 *
 * @param {number|null} expectedRetriggerCount - value read at the start of this invocation.
 *   Null skips the guard (first write of a fresh job, which has no prior checkpoint).
 */
export async function releaseForNextStep(supabaseAdmin, jobId, { stepOutputs, currentStep, expectedRetriggerCount = null }) {
    let query = supabaseAdmin
        .from('intelligence_jobs')
        .update({
            status: 'processing',
            step_outputs: stepOutputs,
            current_step: currentStep,
            last_heartbeat_at: new Date().toISOString(),
            lock_expires_at: new Date(Date.now() - 1000).toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('id', jobId);

    if (expectedRetriggerCount !== null && expectedRetriggerCount !== undefined) {
        // PostgREST renders this as a JSON path filter on the stored checkpoint.
        query = query.eq('step_outputs->__control->>retrigger_count', String(expectedRetriggerCount));
    }

    // maybeSingle, not single: zero rows is the conflict case, not an error to throw raw.
    const { data, error } = await query.select('*').maybeSingle();

    if (error) throw error;
    if (!data) throw new CheckpointConflictError(jobId, expectedRetriggerCount);
    return data;
}

/** Park a job until the founder reviews the server-built context. Nothing may auto-claim it. */
export async function pauseForContextReview(supabaseAdmin, jobId, stepOutputs) {
    const { data, error } = await supabaseAdmin
        .from('intelligence_jobs')
        .update({
            status: 'awaiting_context_review',
            step_outputs: stepOutputs,
            current_step: 'Awaiting context review',
            last_heartbeat_at: new Date().toISOString(),
            lock_expires_at: null,
            updated_at: new Date().toISOString()
        })
        .eq('id', jobId)
        .eq('status', 'processing')
        .select('*')
        .single();

    if (error) throw error;
    return data;
}

/** Resume a paused job with the founder's reviewed context. */
export async function resumeAfterContextReview(supabaseAdmin, jobId, stepOutputs) {
    const { data, error } = await supabaseAdmin
        .from('intelligence_jobs')
        .update({
            status: 'processing',
            step_outputs: stepOutputs,
            current_step: 'Resuming analysis',
            last_heartbeat_at: new Date().toISOString(),
            lock_expires_at: new Date(Date.now() - 1000).toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('id', jobId)
        .eq('status', 'awaiting_context_review')
        .select('*')
        .maybeSingle();

    if (error) throw error;
    return data || null;
}

/** Does this user already have a run in flight? Guards against free-tier context-build spam. */
export async function findActiveJobForUser(supabaseAdmin, userId) {
    // Full row, not just id/status: handleGetJob's no-id reconnect path feeds this straight
    // into serializeJob(), which needs every column (context_for_review is derived from
    // step_outputs). The create-time spam guard only reads .id off the result either way.
    const { data, error } = await supabaseAdmin
        .from('intelligence_jobs')
        .select('*')
        .eq('created_by', userId)
        .in('status', ['pending', 'processing', 'awaiting_context_review'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    return data || null;
}

export async function touchIntelligenceJobLock(supabaseAdmin, jobId) {
    const { data, error } = await supabaseAdmin
        .from('intelligence_jobs')
        .update({
            last_heartbeat_at: new Date().toISOString(),
            lock_expires_at: new Date(Date.now() + JOB_LOCK_MINUTES * 60_000).toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('id', jobId)
        .select('*')
        .single();

    if (error) throw error;
    return data;
}

/**
 * Mark a job completed, exactly once.
 *
 * The `.neq('status', 'completed')` is a compare-and-set, not a tidy-up. Completion can be
 * observed more than once: the stepped worker re-triggers itself, and a job whose lock
 * expired can be re-claimed while the original invocation is still finishing. Without the
 * guard, two callers both write the completed row and both believe they were the one who
 * finished the job.
 *
 * That was harmless while completion had no side effects. It stopped being harmless when
 * the Monday Letter started riding on this transition: the winner of the compare-and-set
 * is the single caller that may send, which is why `didComplete` is returned rather than
 * inferred. A separate "already delivered?" column would be a second source of truth
 * racing this one.
 *
 * `.select()` without `.single()` is deliberate — the loser matches no row, and `.single()`
 * turns "somebody else got there first" into a thrown error on a job that succeeded.
 *
 * @returns {{job: object|null, didComplete: boolean}} `didComplete` is true only for the
 *          caller whose update actually moved the row.
 */
export async function completeIntelligenceJob(supabaseAdmin, jobId, reportId) {
    const { data, error } = await supabaseAdmin
        .from('intelligence_jobs')
        .update({
            status: 'completed',
            current_step: 'Analysis complete',
            report_id: reportId,
            completed_at: new Date().toISOString(),
            last_heartbeat_at: new Date().toISOString(),
            lock_expires_at: null,
            updated_at: new Date().toISOString()
        })
        .eq('id', jobId)
        .neq('status', 'completed')
        .select('*');

    if (error) throw error;

    const job = Array.isArray(data) ? data[0] || null : data || null;
    if (job) return { job, didComplete: true };

    // Lost the race, or the row is gone. Read it back so callers still get the job they
    // asked about — this is a normal outcome, not a failure.
    const { data: existing } = await supabaseAdmin
        .from('intelligence_jobs')
        .select('*')
        .eq('id', jobId)
        .maybeSingle();

    return { job: existing || null, didComplete: false };
}

export async function failIntelligenceJob(supabaseAdmin, jobId, errorMessage) {
    const { data, error } = await supabaseAdmin
        .from('intelligence_jobs')
        .update({
            status: 'failed',
            current_step: 'Analysis failed',
            error_message: errorMessage,
            completed_at: new Date().toISOString(),
            last_heartbeat_at: new Date().toISOString(),
            lock_expires_at: null,
            updated_at: new Date().toISOString()
        })
        .eq('id', jobId)
        .select('*')
        .single();

    if (error) throw error;
    return data;
}

export function buildWorkerUrl(req) {
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (!host) return null;
    return `${protocol}://${host}/api/intelligence-worker`;
}

export function triggerIntelligenceJob(req, jobId) {
    const workerUrl = buildWorkerUrl(req);
    // Must match hasValidInternalApiKey's precedence in _auth.js, or every self-trigger
    // 401s against a configured INTERNAL_API_KEY and the job is stuck at `pending` forever.
    const internalKey = process.env.INTERNAL_API_KEY
        || process.env.SUPABASE_SERVICE_ROLE_KEY
        || process.env.VITE_SUPABASE_SERVICE_ROLE_KEY;
    if (!workerUrl || !internalKey) return false;

    // Deployment Protection (on by default for PREVIEW deployments) challenges every
    // request that lacks a Vercel SSO cookie. A browser has one; this server-to-server
    // fetch to our own deployment does not — so on a preview the trigger was answered
    // with an auth challenge, the worker was never reached, and the job sat `pending`
    // until the 2-minute reaper failed it with "Analysis could not start". Production
    // was unaffected, which is what made it look like an intermittent analysis bug.
    //
    // Requires "Protection Bypass for Automation" to be enabled on the project; Vercel
    // then injects VERCEL_AUTOMATION_BYPASS_SECRET. Absent (local, or not enabled) the
    // header is simply omitted.
    const headers = {
        'Content-Type': 'application/json',
        'x-bahirjee-internal-key': internalKey,
    };
    if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
        headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    }

    // Keep the outbound worker request alive after this handler responds, so Vercel
    // does not freeze the instance and cancel the fire-and-forget fetch. The GET-poll
    // retrigger (api/intelligence.js) remains the backup path.
    const triggerFetch = fetch(workerUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jobId })
    }).then((res) => {
        // A rejected trigger used to be entirely silent: fire-and-forget swallowed the
        // response, so a job that was never claimed looked identical to one the worker
        // had picked up. Name the failure instead — this is the log line that would have
        // identified the preview-protection outage in seconds rather than a day.
        if (!res.ok) {
            const protection = res.status === 401 || res.status === 403;
            console.error(
                `[intelligence-jobs] worker trigger rejected (HTTP ${res.status}) for job ${jobId}`
                + (protection
                    ? ' — looks like Vercel Deployment Protection. Enable "Protection Bypass for'
                      + ' Automation" so VERCEL_AUTOMATION_BYPASS_SECRET is injected, then redeploy.'
                    : '')
            );
        }
        return res;
    }).catch((error) => {
        console.error('[intelligence-jobs] worker trigger failed:', error.message);
    });

    try {
        waitUntil(triggerFetch);
    } catch {
        // waitUntil is only available in the Vercel serverless runtime; local/other
        // runtimes fall through to plain fire-and-forget (still awaited by the catch above).
        void triggerFetch;
    }

    return true;
}
