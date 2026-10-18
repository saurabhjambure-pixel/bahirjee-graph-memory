import { internalPostJson } from './_internalRouteClient.js';
import {
    appendJobProgress,
    claimIntelligenceJob,
    completeIntelligenceJob,
    failIntelligenceJob,
    getIntelligenceJob,
    pauseForContextReview,
    CheckpointConflictError,
    releaseForNextStep,
    touchIntelligenceJobLock,
    triggerIntelligenceJob,
} from './_intelligenceJobs.js';
import {
    PIPELINE_STEPS,
    PipelineTimer,
    addRunWallClock,
    buildInitialContext,
    configureIntelligenceRuntime,
    createPipelineState,
    getCircuitState,
    getRunProvenance,
    getRunSpend,
    nextPipelineStep,
    resetIntelligenceRuntime,
    runPipelineStep,
    runSignalGeneration,
    setCircuitState,
    recordDegradation,
    setRunProvenance,
    setRunSpend,
} from '../src/services/intelligenceService.js';
import { currentVersions } from '../src/services/pipelineVersions.js';
import { buildGraphState, checkGraphCompatibility, measureEnvelope } from '../src/services/agents/orchestration/checkpointStore.js';
import { resolveNext } from '../src/services/agents/orchestration/nextRunnableAgent.js';
import { evaluateBudget, resolveBudget, resolveBudgetMode } from '../src/services/agents/orchestration/budgetController.js';
import { beginAgentRun, completeAgentRun, recordArtifact, recordHandoff } from '../src/services/agents/orchestration/agentRunStore.js';
import { buildArtifactsFor } from '../src/services/agents/orchestration/artifactBuilders.js';
import { guardPostJson, resolveToolEnforcement } from '../src/services/agents/orchestration/toolGuard.js';
import { agentForStep, isAgentBoundary, isAgentEntry } from '../src/services/agents/registry.js';
import { validateShape } from '../src/services/agents/schemas.js';
import { deliverLetterForReport } from './_letterDelivery.js';
import { graphWriteAnalysisRun } from './_graphRunWriter.js';

// Per-invocation work budget for one step. Each invocation runs a step until this budget is
// spent, then checkpoints its cursor and self-triggers the next invocation. It MUST exceed
// the largest single cursored unit — search wave 12s, analyze batch 25s, news batch 15s (see
// intelligenceService.js) — or that step can never afford its first unit at elapsed≈0 and
// defers on an unchanged cursor forever, which the forward-progress guard then aborts.
// Default 45000 leaves ~15s headroom under the worker's 60s maxDuration (vercel.json, Pro).
// On Hobby (10s functions) the stepped pipeline can't run; drop maxDuration accordingly and
// use the monolith (STEPPED_PIPELINE=0) instead.
const STEP_MAX_MS = Number(process.env.STEP_MAX_MS || 45000);

// A full run is ~12 steps; cursored steps add one invocation per wave/batch. 120 is far
// above any legitimate run and well below anything that could bill real money.
const MAX_RETRIGGERS = 120;

// Stepped is the default: the founder flow now parks the job in awaiting_context_review
// for the review screen, and only the stepped driver produces that pause. Set
// STEPPED_PIPELINE=0 for the single-invocation monolith — admin-only, since the founder UI
// depends on the pause. REQUIRES the v14 migration (step_outputs column); without it the
// first checkpoint write fails.
const STEPPED_PIPELINE = process.env.STEPPED_PIPELINE !== '0';

// Agent runtime overlay.
//   off     — no agent metadata written
//   observe — record __graph and budget checks; step order still comes from the pipeline
//   resolve — step order comes from the agent registry (DEFAULT)
//
// `resolve` is the default because it is provably a no-op: `npm run test:agents` asserts
// resolveNext() returns exactly what nextPipelineStep() returns for every step in the
// registry, so the two orders cannot differ without failing the suite. That equivalence is
// the point of the seam — it stays inert until retrieval fan-out gives it something to
// branch on, and until then a divergence is a defect rather than a feature.
//
// Set AGENT_RUNTIME_MODE=observe to source step order from the pipeline again, or `off` to
// stop writing agent metadata entirely. Both are env-only, so a revert needs no deploy.
const AGENT_RUNTIME_MODE = (() => {
    const raw = String(process.env.AGENT_RUNTIME_MODE || 'resolve').toLowerCase().trim();
    return ['off', 'observe', 'resolve'].includes(raw) ? raw : 'resolve';
})();

// Tool-grant enforcement. `strict` (default) fails a step that calls a provider its agent
// does not declare; `warn` reports and continues; `off` disables the wrap entirely.
const TOOL_ENFORCEMENT = resolveToolEnforcement(process.env.AGENT_TOOL_ENFORCEMENT);

function deepClone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

/** The first step a job should execute, given whether context is already supplied. */
function initialStep(job) {
    return (!job.context_payload || job.build_context_on_server) ? 'context' : 'memory';
}

// Exported as a test seam only (scripts/pipeline-drivers.test.mjs) — same convention as
// reportService.js's __columnCache. The stepped driver itself only ever calls it internally.
export function jobToStepContext(job, onProgress, timer) {
    return {
        job: {
            websiteUrl: job.website_url,
            linkedinUrl: job.linkedin_url,
            uploadedDocText: job.uploaded_doc_text || null,
            userId: job.created_by,
            clientId: job.client_id,
            requestedByRole: job.requested_by_role || 'client_user',
            analysisMode: job.analysis_mode || 'company',
            runTier: job.run_tier || 'full',
            decisionId: job.decision_id || null,
            decisionContext: job.decision_context || job.step_outputs?.state?.context?._decision || null,
            targetId: job.target_id || null,
            productContext: job.step_outputs?.job?.productContext || null
        },
        onProgress,
        timer,
        stepped: true
    };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEPPED DRIVER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function runOneStep(supabaseAdmin, job, req, queueProgress, flushProgress) {
    const stepOutputs = deepClone(job.step_outputs) || {};
    const control = stepOutputs.__control || {};

    const stepName = control.step || initialStep(job);
    const retriggerCount = Number(control.retrigger_count || 0) + 1;

    if (retriggerCount > MAX_RETRIGGERS) {
        throw new Error(`Pipeline exceeded ${MAX_RETRIGGERS} invocations at step "${stepName}" — aborting to avoid a re-trigger loop.`);
    }

    const stepDef = PIPELINE_STEPS.find(s => s.name === stepName);
    if (!stepDef) throw new Error(`Unknown pipeline step "${stepName}"`);

    // A deploy can land between two invocations of the same job. Refuse to resume a
    // checkpoint written by a different graph rather than silently skipping or repeating
    // steps under a changed step list — see checkGraphCompatibility() for why "the step
    // still exists" is not a sufficient test.
    if (AGENT_RUNTIME_MODE !== 'off') {
        const compat = checkGraphCompatibility(stepOutputs.__graph, {
            allowMismatch: process.env.ALLOW_GRAPH_VERSION_MISMATCH === '1',
        });
        if (!compat.ok) throw new Error(compat.reason);
        if (compat.reason) console.warn(`[agents] ${compat.reason}`);
    }

    // Module-level state does not survive an invocation boundary. Rehydrate it, run the
    // step, then write it back into the checkpoint.
    setRunProvenance(stepOutputs.__provenance || []);
    setCircuitState(control.circuit);
    setRunSpend(control.budget);

    // A step that has never run has no persisted state; the `context` step builds it.
    const state = stepOutputs.state
        ? stepOutputs.state
        : createPipelineState(deepClone(job.context_payload) || {}, control.run_id);

    const timer = new PipelineTimer(STEP_MAX_MS);
    const ctx = jobToStepContext(job, (message) => { void queueProgress(message); }, timer);

    // ─── agent run bookkeeping ───
    // An agent spans one or more contiguous steps, so its run row opens at the agent's
    // entry step and is carried through the checkpoint until its last step completes.
    const agentSpec = agentForStep(stepName);
    let agentRunId = stepOutputs.__graph?.current_agent_run_id || null;
    let spendAtAgentStart = stepOutputs.__graph?.spend_at_agent_start ?? null;

    if (AGENT_RUNTIME_MODE !== 'off' && agentSpec) {
        if (isAgentEntry(stepName) || !agentRunId) {
            spendAtAgentStart = getRunSpend();
            agentRunId = await beginAgentRun(supabaseAdmin, {
                jobId: job.id,
                agentId: agentSpec.id,
                agentVersion: agentSpec.version,
                attempt: Number(job.attempt_count) || 1,
            });
        }
    }

    // Re-point the provider transport at a guard carrying THIS step's agent grant. The
    // runtime is configured once per invocation at the top of processIntelligenceJob(); the
    // stepped driver runs exactly one step per invocation, so narrowing it here is safe and
    // is the only place the owning agent is known. Every network provider call in the
    // pipeline goes through postJson, which is what makes one wrap sufficient.
    if (AGENT_RUNTIME_MODE !== 'off' && TOOL_ENFORCEMENT !== 'off') {
        configureIntelligenceRuntime({
            postJson: guardPostJson(internalPostJson, {
                stepName,
                mode: TOOL_ENFORCEMENT,
                // A breach is a contract defect, so it is disclosed to the founder rather
                // than only logged — the run is already degraded by whatever it did next.
                onViolation: ({ agentId, tool }) => recordDegradation(state, {
                    step: stepDef.label,
                    reason: `Agent "${agentId}" used the "${tool}" tool without declaring it.`,
                    impact: 'Recorded as a contract violation; the run continued.',
                }),
            }),
        });
    }

    await queueProgress(`${stepDef.label}...`, { currentStep: stepDef.label });

    let defer, pause;
    try {
        ({ defer, pause } = await runPipelineStep(stepName, state, ctx));
    } catch (stepError) {
        // Record the failure against the agent before rethrowing — the job-level failure
        // path below still owns the job's own status.
        if (agentRunId) {
            await completeAgentRun(supabaseAdmin, agentRunId, {
                status: 'failed',
                failureReason: `${stepName}: ${stepError.message}`.slice(0, 500),
            });
        }
        throw stepError;
    }

    // Every cursored step must contribute, or a step that defers on a cursor this does not
    // watch looks identical across invocations and trips the forward-progress guard below.
    // `verify` is cursored but moves none of search/analyze/news — it was missing here, so
    // a budget-starved gap fill aborted a run whose report was otherwise complete.
    const cursorOf = (s) => [
        s.express?.cursor ?? -1,
        s.search?.cursor ?? -1,
        s.analyze?.cursor ?? -1,
        s.news?.cursor ?? -1,
        s.search?.phase ?? '',
        s.verify?.deferCount ?? -1,
        s.watch?.cursor ?? -1,
        s.collect?.cursor ?? -1,
        s.triage?.cursor ?? -1,
    ].join(':');
    const cursorBefore = control.cursor_fingerprint ?? null;
    const cursorAfter = cursorOf(state);

    // Both paths yield the same step; `resolve` just sources it from the agent registry.
    // The legacy expression stays the default so this layer can be switched off entirely.
    const agentNext = AGENT_RUNTIME_MODE !== 'off' ? resolveNext(stepName, { deferred: defer }) : null;
    const nextStep = AGENT_RUNTIME_MODE === 'resolve'
        ? agentNext.step
        : (defer ? stepName : nextPipelineStep(stepName));

    // Forward-progress guard. A step that deferred without moving any cursor would be
    // re-triggered forever on an identical checkpoint.
    if (defer && cursorBefore === cursorAfter) {
        throw new Error(`Step "${stepName}" deferred without making progress (cursor ${cursorAfter}) — aborting to avoid a re-trigger loop.`);
    }

    if (agentNext?.handoff) {
        console.log(`[agents] handoff ${agentNext.handoff.from_agent} → ${agentNext.handoff.to_agent}`);
    }

    // Wall clock accumulates across invocations, so add this one's elapsed time before
    // reading the ledger back out.
    addRunWallClock(timer.elapsed());

    // Close the agent run once its last owned step finishes. A deferred cursored step is
    // still mid-agent, so it keeps the run open and carries the id forward.
    if (AGENT_RUNTIME_MODE !== 'off' && agentRunId && agentSpec && !defer && isAgentBoundary(stepName)) {
        const spendNow = getRunSpend();
        const delta = (path) => {
            const before = path.split('.').reduce((o, k) => o?.[k], spendAtAgentStart) ?? 0;
            const after = path.split('.').reduce((o, k) => o?.[k], spendNow) ?? 0;
            return Math.max(0, after - before);
        };

        // Check the agent produced the state slice its contract promises. `output_schema`
        // was declared on all six specs and validated by nothing, so a step that quietly
        // stopped populating its slice would surface far downstream as an empty report
        // rather than here, at the boundary, naming the agent responsible.
        //
        // Reported, not thrown: the slice is already written and the run can still produce
        // something useful, so failing here would discard real work over a bookkeeping
        // mismatch. A breach IS disclosed to the founder, because it predicts a thin report.
        if (agentSpec.output_schema) {
            const shape = validateShape(state, agentSpec.output_schema);
            if (!shape.ok) {
                console.error(`[agents] ${agentSpec.id} output contract: ${shape.errors.join('; ')}`);
                recordDegradation(state, {
                    step: stepDef.label,
                    reason: `Agent "${agentSpec.id}" finished without the output its contract declares (${shape.errors.join('; ')}).`,
                    impact: 'Downstream steps may have less to work with than expected.',
                });
            }
        }

        // Emit what the spec promised, BEFORE the run row is closed — an artifact belonging
        // to a run marked complete is harder to reason about, and the ordering makes
        // "declared but never emitted" visible as a missing row against a finished run.
        // Artifacts are summaries/references only (see artifactBuilders.js); bookkeeping
        // must never be what fails a run, so each write is independently non-blocking.
        for (const artifact of buildArtifactsFor(agentSpec.id, state)) {
            await recordArtifact(supabaseAdmin, {
                jobId: job.id,
                agentRunId,
                artifactType: artifact.artifactType,
                payload: artifact.payload || {},
                sourceCount: artifact.sourceCount || 0,
                evidenceRefs: artifact.evidenceRefs || [],
            });
        }

        await completeAgentRun(supabaseAdmin, agentRunId, {
            status: 'completed',
            stepsCompleted: agentSpec.steps,
            tokenUsage: delta('tokens.total'),
            providerCostUsd: Number(delta('cost_usd.total').toFixed(6)),
        });

        if (agentNext?.handoff) {
            await recordHandoff(supabaseAdmin, {
                jobId: job.id,
                fromAgentRunId: agentRunId,
                toAgentId: agentNext.handoff.to_agent,
                handoffReason: agentNext.handoff.reason,
                decisionPayload: { from_step: stepName, to_step: nextStep },
            });
        }

        // Next invocation opens a fresh run for the next agent.
        agentRunId = null;
        spendAtAgentStart = null;
    }

    const nextOutputs = {
        state,
        __provenance: getRunProvenance(),
        __control: {
            step: nextStep,
            run_id: state.runId,
            retrigger_count: retriggerCount,
            cursor_fingerprint: cursorAfter,
            circuit: getCircuitState(),
            budget: getRunSpend(),
            versions: currentVersions()
        },
        ...(AGENT_RUNTIME_MODE !== 'off'
            ? {
                __graph: buildGraphState(nextStep, {
                    runMode: job.job_origin || 'founder',
                    previous: stepOutputs.__graph,
                    currentAgentRunId: agentRunId,
                    spendAtAgentStart
                })
            }
            : {})
    };

    // Budget is recorded, not enforced — surface an overrun loudly so it is noticed before
    // anyone decides to switch enforcement on.
    if (AGENT_RUNTIME_MODE !== 'off') {
        const budgetCheck = evaluateBudget(nextOutputs.__control.budget, resolveBudget(process.env));
        if (budgetCheck.exceeded) {
            console.warn(`[budget] job ${job.id} exceeded: `
                + budgetCheck.breaches.map(b => `${b.limit} ${b.used} > ${b.cap}`).join(', ')
                + ` (mode=${resolveBudgetMode(process.env)})`);
        }

        // The envelope is rewritten every invocation, so unchecked growth here shows up as
        // row churn and polling latency long before anyone suspects the checkpoint.
        const size = measureEnvelope(nextOutputs);
        if (size.oversize) {
            console.warn(`[checkpoint] job ${job.id} envelope is ${(size.bytes / 1024).toFixed(0)}KB — `
                + 'large payloads belong in observations, not step_outputs.');
        }
    }

    // Progress writes call touchIntelligenceJobLock, which pushes lock_expires_at ten
    // minutes out. If one of them lands after the checkpoint below it would un-expire the
    // lock we deliberately staled, and no invocation could claim the job again. Drain the
    // chain first so the checkpoint is the last write.
    await flushProgress();

    if (pause === 'awaiting_context_review') {
        // The founder now owns this job. Do NOT self-trigger — nothing may claim it until
        // POST /api/intelligence resumes it with the reviewed context.
        await pauseForContextReview(supabaseAdmin, job.id, nextOutputs);
        await appendJobProgress(supabaseAdmin, job.id, 'Context ready for your review.', {
            currentStep: 'Awaiting context review'
        });
        return { done: false, paused: true };
    }

    if (!nextStep) {
        const reportId = state.report?.id;
        if (!reportId) {
            throw new Error('Analysis finished but no persisted report ID was returned.');
        }
        const { didComplete } = await completeIntelligenceJob(supabaseAdmin, job.id, reportId);
        await appendJobProgress(supabaseAdmin, job.id, 'Report saved and job completed.', {
            currentStep: 'Completed'
        });
        // Only the invocation that actually moved the row may write to the founder. See
        // completeIntelligenceJob: the status transition IS the once-only guard.
        if (didComplete) await sendWeeklyLetter(supabaseAdmin, job, reportId);
        await writeRunToGraph(job, { runId: state.runId, reportId, report: state.report });
        return { done: true };
    }

    // Compare-and-set on the checkpoint we started from. If another invocation advanced it
    // while this one was working, its write wins and ours is abandoned — overwriting would
    // silently undo whatever steps it completed. `control.retrigger_count` is the value read
    // at the top of this function, before it was incremented for this invocation.
    await releaseForNextStep(supabaseAdmin, job.id, {
        stepOutputs: nextOutputs,
        currentStep: defer ? stepDef.label : (PIPELINE_STEPS.find(s => s.name === nextStep)?.label || nextStep),
        expectedRetriggerCount: control.retrigger_count ?? null
    });
    triggerIntelligenceJob(req, job.id);
    return { done: false };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MONOLITH DRIVER — whole pipeline in one invocation.
// NOT the default: STEPPED_PIPELINE is `!== '0'` (see above), so stepped is on unless
// explicitly disabled. This header used to read "Default until STEPPED_PIPELINE=1", which
// contradicted the flag six lines above it. Reached only on a tier whose functions are too
// short for the stepped driver; admin-only, since it cannot produce the
// awaiting_context_review pause the founder flow depends on.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function runMonolith(supabaseAdmin, job, queueProgress) {
    let contextData = deepClone(job.context_payload);
    if (!contextData || job.build_context_on_server) {
        await queueProgress('Building company context on server...', { currentStep: 'Building company context' });
        contextData = await buildInitialContext(
            job.website_url,
            job.linkedin_url,
            (message) => { void queueProgress(message); },
            job.uploaded_doc_text || null
        );
    } else {
        await queueProgress('Using reviewed context submitted by the founder.', { currentStep: 'Using reviewed context' });
    }

    const report = await runSignalGeneration(
        { websiteUrl: job.website_url },
        contextData,
        (message) => { void queueProgress(message); },
        { id: job.created_by },
        {
            client_id: job.client_id,
            role: job.requested_by_role || 'client_user',
            analysis_mode: job.analysis_mode || 'company',
            decision_id: job.decision_id || null,
            decision_context: job.decision_context || null,
            target_id: job.target_id || null,
            product_context: job.step_outputs?.job?.productContext || null
        }
    );

    if (!report?.id) {
        throw new Error('Analysis finished but no persisted report ID was returned.');
    }

    const { didComplete } = await completeIntelligenceJob(supabaseAdmin, job.id, report.id);
    await appendJobProgress(supabaseAdmin, job.id, 'Report saved and job completed.', {
        currentStep: 'Completed'
    });
    if (didComplete) await sendWeeklyLetter(supabaseAdmin, job, report.id);
    await writeRunToGraph(job, { runId: report.v6?.runId || null, reportId: report.id, report });
}

/**
 * Put the brief in the founder's inbox.
 *
 * Wrapped rather than called inline so the contract is stated in one place: this can log a
 * failure but must never propagate one. The report is already persisted and readable in the
 * app by the time we get here — failing the job would discard a run that succeeded, which
 * is a far worse outcome than a letter that did not arrive.
 */
async function sendWeeklyLetter(supabaseAdmin, job, reportId) {
    const result = await deliverLetterForReport(supabaseAdmin, {
        clientId: job.client_id,
        reportId,
    });
    if (result.sent) {
        console.log(`[letter] Sent for report ${reportId} to ${result.delivered} recipient(s).`);
    } else {
        console.log(`[letter] Not sent for report ${reportId}: ${result.reason}.`);
    }
}

/**
 * Record the finished run in the tenant's memory graph (Track 2) — Company, tracked
 * Entities, an `analysis_run` Session and one Finding per published signal.
 *
 * Runs after the job is completed and the letter sent, so the founder's report never waits
 * on it. Same contract as sendWeeklyLetter: logs, never propagates. graphWriteAnalysisRun
 * is itself bounded (GRAPH_RUN_WRITE_BUDGET_MS) and a no-op unless MEMORY_GRAPH_ENABLED=1;
 * its ids derive from run_id, so a retried invocation re-merges rather than duplicates.
 */
async function writeRunToGraph(job, { runId, reportId, report }) {
    try {
        const result = await graphWriteAnalysisRun(job.client_id, {
            runId,
            reportId,
            report,
            websiteUrl: job.website_url,
            analysisMode: job.analysis_mode || 'company',
        });
        if (result) {
            console.log(`[graph-run] report ${reportId}: ${result.entities} entities, ${result.findings} findings`
                + ` (company ${result.company ? 'ok' : 'skipped'}, session ${result.session ? 'ok' : 'skipped'})`);
        }
    } catch (err) {
        console.warn(`[graph-run] report ${reportId}: ${err?.message || err}`);
    }
}

export async function processIntelligenceJob(supabaseAdmin, jobId, req = null) {
    const claimedJob = await claimIntelligenceJob(supabaseAdmin, jobId);
    if (!claimedJob) {
        // Someone else holds the lock, or the job is finished / awaiting a human.
        return await getIntelligenceJob(supabaseAdmin, jobId);
    }

    let progressChain = Promise.resolve();
    const queueProgress = (message, extraFields = {}) => {
        progressChain = progressChain.then(async () => {
            await appendJobProgress(supabaseAdmin, jobId, message, extraFields);
            await touchIntelligenceJobLock(supabaseAdmin, jobId);
        });
        return progressChain;
    };
    const flushProgress = () => progressChain.catch(() => null);

    // Research depth for this invocation. Set once here rather than per step: the stepped
    // driver re-points postJson per step, and configureIntelligenceRuntime sets each key
    // independently so that call leaves the budget alone.
    configureIntelligenceRuntime({
        postJson: internalPostJson,
        budget: claimedJob.run_tier || 'full',
        // The worker is the one place /api/jev will answer (it carries the internal key).
        // Each Jev use case still decides for itself via JEV_<USE_CASE>; shadow by default.
        jev: true,
    });

    try {
        if (STEPPED_PIPELINE && req) {
            await runOneStep(supabaseAdmin, claimedJob, req, queueProgress, flushProgress);
        } else {
            await queueProgress('Worker claimed job.', { currentStep: 'Worker claimed job' });
            await runMonolith(supabaseAdmin, claimedJob, queueProgress);
        }

        await progressChain;
        return await getIntelligenceJob(supabaseAdmin, jobId);
    } catch (error) {
        await progressChain.catch(() => null);

        // A checkpoint conflict means another invocation advanced this job while we worked.
        // That is not a failure of the JOB — the other worker is making progress and owns it.
        // Failing it here would abort a healthy run because two workers briefly overlapped,
        // turning a benign race into a dead job.
        if (error instanceof CheckpointConflictError) {
            console.warn(`[worker] ${error.message}`);
            return await getIntelligenceJob(supabaseAdmin, jobId);
        }

        await failIntelligenceJob(supabaseAdmin, jobId, error.message || 'Unknown error');
        await appendJobProgress(supabaseAdmin, jobId, `Error: ${error.message || 'Unknown error'}`, {
            currentStep: 'Failed'
        }).catch(() => null);
        throw error;
    } finally {
        resetIntelligenceRuntime();
    }
}
