/**
 * Running a decision session.
 *
 * A fourth driver over the same `PIPELINE_STEPS`, on the same terms as `dailyRun.js`: it
 * owns invocation mechanics only, and `verify` runs exactly as it does in a full run. A
 * decision brief is the most consequential thing this product emits — a founder may take it
 * into a board meeting — so it does not get a relaxed grounding gate because it happens to
 * be quicker.
 *
 * ── It runs in the browser, and that is deliberate ───────────────────────────
 * The founder is sitting there. `intelligenceRuntime.postJson` defaults to the browser
 * client and its session, which is exactly right here — unlike the daily cron, which has no
 * session and must be pointed at the in-process dispatcher.
 *
 * ── Internal evidence first ──────────────────────────────────────────────────
 * `assembleInternalEvidence` decides what is already known before a single search is spent.
 * Only the gaps are searched. Re-researching what is already in the last report while the
 * founder waits is the waste the Agenda exists to end, one layer up.
 *
 * ── The order of the two model calls ─────────────────────────────────────────
 * Exactly one fires per session: `weighDecision` for a weighing, `deliberate` for the other
 * four lenses. The router has already chosen; calling both and picking afterwards would
 * double the cost and give the losing call's prose a chance to leak into the output.
 */

import {
    createPipelineState,
    runPipelineStep,
    configureIntelligenceRuntime,
    callLLMAction,
    PipelineTimer,
} from './intelligenceService.js';
import { RUN_TIERS } from './runTiers.js';
import { buildDecisionQueries } from './decisionService.js';
import { buildDecisionBrief } from './decisionBrief.js';
import { assembleInternalEvidence, describeEvidencePlan } from './decisionSessionService.js';

/** A founder is waiting. Long enough to be worth something, short enough to sit through. */
const DECISION_RUN_MAX_MS = 150000;

/** A cursored step defers to be re-entered; bounded so a stuck cursor cannot spin. */
const MAX_STEP_ITERATIONS = 20;

async function runToCompletion(stepName, state, ctx, onProgress) {
    for (let i = 0; i < MAX_STEP_ITERATIONS; i++) {
        const { defer } = await runPipelineStep(stepName, state, ctx);
        if (!defer) return true;
        if (!ctx.timer.canAfford(stepName, 5000)) {
            onProgress?.(`Ran out of time during ${stepName}. Working with what I have.`);
            return false;
        }
    }
    return false;
}

/**
 * Gather the evidence a decision needs.
 *
 * Returns `{ signals, plan, searched }`. Never throws: a session that found nothing is a
 * thin brief with an honest confidence level, not an error screen for someone who has
 * already answered four questions.
 */
export async function gatherDecisionEvidence({ frame, context, internal = {}, job = {}, onProgress }) {
    const plan = assembleInternalEvidence({ frame, ...internal });
    onProgress?.(describeEvidencePlan(plan) || 'Looking into this.');

    // Nothing left to find out. Spending searches anyway would be spending a founder's
    // money to re-learn what is already on file.
    if (plan.gaps.length === 0 && plan.hasInternal) {
        return { signals: plan.internal.signals, plan, searched: 0 };
    }

    configureIntelligenceRuntime({ budget: RUN_TIERS.decision });

    const queries = buildDecisionQueries({
        frame: { ...frame, sub_questions: plan.gaps.length ? plan.gaps : frame?.sub_questions },
        context,
        entities: context?._trackedEntities || [],
    }).slice(0, RUN_TIERS.decision.maxQueries);

    if (queries.length === 0) {
        return { signals: plan.internal.signals, plan, searched: 0 };
    }

    const timer = new PipelineTimer(DECISION_RUN_MAX_MS);
    const state = createPipelineState(context);
    state.queries = { selected: queries, buckets: {} };

    const ctx = {
        job: {
            clientId: job.clientId,
            userId: job.userId,
            websiteUrl: job.websiteUrl,
            analysisMode: 'decision',
            runTier: 'decision',
            requestedByRole: 'client_user',
        },
        timer,
        stepped: false,
        onProgress: (m) => onProgress?.(m),
    };

    try {
        onProgress?.(`Looking up ${queries.length} thing${queries.length === 1 ? '' : 's'} I could not answer from what I already had.`);
        await runToCompletion('search', state, ctx, onProgress);
        await runToCompletion('analyze', state, ctx, onProgress);
        // The same grounding and duplicate gate a full run applies. A driver may not wave a
        // gate through because its output happens to be quicker.
        await runToCompletion('verify', state, ctx, onProgress);
    } catch (err) {
        console.error('[decision] evidence gathering failed:', err.message);
        onProgress?.('I could not finish looking things up. Working with what I already had.');
        return { signals: plan.internal.signals, plan, searched: 0, error: err.message };
    }

    // Internal evidence first in the list, because it is the founder's own material and the
    // model cites by position.
    const found = state.analyze?.signals || [];
    return { signals: [...plan.internal.signals, ...found], plan, searched: queries.length };
}

/**
 * Turn a routed decision into a finished judgment.
 *
 * ONE model call, chosen by the lens the router already picked.
 */
export async function deliberateDecision({ frame, routing, context, signals = [], founderCriteria = null, onProgress }) {
    const isWeighing = routing?.framework?.id === 'mcda';
    onProgress?.(isWeighing ? 'Weighing the options against your criteria.' : `Working through this as ${routing?.framework?.name?.toLowerCase()}.`);

    let raw = {};
    try {
        raw = isWeighing
            ? await callLLMAction('weighDecision', {
                context, frame, signals,
                existingCriteria: founderCriteria || [],
            })
            : await callLLMAction('deliberate', {
                context, frame, signals,
                framework: routing?.framework,
                answers: routing?.answered ? Object.fromEntries((routing.answered || []).map(k => [k, true])) : {},
            });
    } catch (err) {
        // A failed call yields a brief with no scores and an honest confidence level rather
        // than an error screen. The founder still sees the lens, why it was chosen, and what
        // was already known — which is more than they had before.
        console.error('[decision] deliberation failed:', err.message);
        onProgress?.('I could not complete the analysis. Showing what I have.');
    }

    return buildDecisionBrief({ raw, frame, routing, signals, depth: 'decision', founderCriteria });
}

/**
 * The whole session, end to end.
 *
 * Deliberately NOT wrapped in a try/catch that swallows everything: each stage already
 * degrades on its own terms, and a blanket catch here would turn a recoverable thin brief
 * into an indistinguishable failure.
 */
export async function runDecisionSession({ frame, routing, context, internal, job, founderCriteria, onProgress }) {
    const { signals, plan, searched } = await gatherDecisionEvidence({ frame, context, internal, job, onProgress });
    const judgment = await deliberateDecision({ frame, routing, context, signals, founderCriteria, onProgress });
    return { judgment, signals, plan, searched };
}
