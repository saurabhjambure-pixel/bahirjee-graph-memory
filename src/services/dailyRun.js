/**
 * The daily pursue — a third driver over the same pipeline steps.
 *
 * WHY A DRIVER AND NOT A PARTIAL WORKER RUN. The stepped worker exists to survive Vercel's
 * 60-second function limit across a fifteen-minute run: checkpoints, re-triggers, a
 * forward-progress guard, a graph version that fails in-flight jobs when it bumps. A daily
 * pursuit is ≤4 searches and one analyze batch — twenty to thirty seconds, one invocation.
 * Putting it through the checkpoint machinery would buy nothing and cost a GRAPH_VERSION
 * bump, a `resolveNext` branch and a new entry in the worker's cursor fingerprint.
 *
 * So this is a driver, in the sense the monolith driver is one, and it obeys the same rule
 * stated there: A DRIVER MAY OWN ONLY INVOCATION MECHANICS. Contracts, budgets and gates
 * belong to the steps. Anything a driver owns exclusively is behaviour the other drivers
 * silently skip — which is why `verify` runs here exactly as it does in a full run, rather
 * than being waved through because the output is small.
 *
 * WHAT MAKES THE SUBSET SAFE. `search`, `analyze` and `verify` each assumed a full run had
 * populated the state before them — `state.queries` destructured directly, a bare
 * `state.memory.lookbackMonths`, `state.analyze.empty` read without a guard. Those are now
 * guarded in intelligenceService.js, which is what lets a subset run at all.
 *
 * NO EXTRA LLM CALL PRODUCES THE READ. A signal already carries every field a Read needs —
 * the_move is the fact, so_what_for_you is the mechanism in second person, analyst_note
 * says what would overturn it. Composing them is string work. This follows stepNews, where
 * the three-line LLM generation was deleted on purpose because it rendered in a component
 * nothing imported: every run paid for text no founder saw. Don't reintroduce one here
 * without a consumer.
 */

import {
    createPipelineState,
    runPipelineStep,
    configureIntelligenceRuntime,
    PipelineTimer,
} from './intelligenceService.js';
import { DAILY_BUDGET } from './dailyPlan.js';

/** One invocation's worth of work, under Vercel's 60s ceiling with headroom to persist. */
const DAILY_RUN_MAX_MS = 40000;

/** A cursored step defers to be re-entered. Bounded so a stuck cursor cannot spin. */
const MAX_STEP_ITERATIONS = 12;

/**
 * Signals say "Med"; the reads CHECK constraint says 'Medium'.
 *
 * This is precisely the v25 failure in miniature — a literal the code emits that Postgres
 * rejects, where the insert fails, the error is logged, the caller returns normally, and
 * the founder simply never sees a Read. Normalise at the boundary, and pin it in a test.
 */
export function normalizeConfidence(value) {
    const v = String(value || '').trim().toLowerCase();
    if (v === 'high') return 'High';
    if (v === 'med' || v === 'medium') return 'Medium';
    if (v === 'low') return 'Low';
    return null;
}

/**
 * Run one cursored step to completion.
 *
 * `runPipelineStep` returns `{ defer: true }` when a step has more work than its time
 * budget allowed. In the worker that means "checkpoint and re-trigger"; here it just means
 * "go round again", because the whole pursuit fits in one invocation.
 */
async function runToCompletion(stepName, state, ctx) {
    for (let i = 0; i < MAX_STEP_ITERATIONS; i++) {
        const { defer } = await runPipelineStep(stepName, state, ctx);
        if (!defer) return true;
        if (!ctx.timer.canAfford(stepName, 5000)) {
            console.warn(`[daily] ${stepName} ran out of time budget after ${i + 1} pass(es)`);
            return false;
        }
    }
    console.warn(`[daily] ${stepName} still deferring after ${MAX_STEP_ITERATIONS} passes`);
    return false;
}

/**
 * Compose one Read from the strongest signal a pursuit produced.
 *
 * PURE, so the composition rules are testable on a fixture.
 *
 * Deliberately returns ONE Read, never a list. The complaint this design answers is that
 * the pipeline dumps everything at once; a daily loop that emits four items has recreated
 * that at a faster cadence. If two things genuinely moved, the second is still open on the
 * Agenda tomorrow.
 */
export function composeRead(signals, { questionId = null, runId = null } = {}) {
    const usable = (signals || []).filter(s => s?.signal_headline && s?.the_move);
    if (usable.length === 0) return null;

    // Rank by confidence, then by having corroboration. No model call: the analyze step
    // already made the judgment, and re-asking would be paying twice for one opinion.
    const rank = { High: 3, Medium: 2, Med: 2, Low: 1 };
    const best = [...usable].sort((a, b) => {
        const c = (rank[b.confidence] || 0) - (rank[a.confidence] || 0);
        if (c !== 0) return c;
        return (b.corroborating_urls?.length || 0) - (a.corroborating_urls?.length || 0);
    })[0];

    const evidence = [best.source_url, ...(best.corroborating_urls || [])]
        .filter(Boolean)
        .filter((u, i, all) => all.indexOf(u) === i)
        .slice(0, 5)
        .map(url => ({ url, host: hostOf(url) }));

    return {
        questionId,
        runId,
        headline: best.signal_headline,
        whatMoved: best.the_move,
        whatItMeans: best.so_what_for_you || null,
        // analyst_note is written to say why the read holds AND what would overturn it —
        // which is exactly the honesty line a Read needs. Uncertainty as presence, not as
        // a disclaimer bolted on at the end.
        whatItDoesNotSettle: best.analyst_note || null,
        sourceClass: best.source_class || null,
        evidence,
        // A Read built on one source is Low, and saying so IS the product. Confidence is
        // capped by what the evidence supports, never claimed.
        confidence: evidence.length <= 1 ? 'Low' : normalizeConfidence(best.confidence),
    };
}

function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

/**
 * Pursue one question: search, analyze, verify, compose.
 *
 * @param {Object} pursuit  from planPursuit — { questionId, queries, budget }
 * @param {Object} context  the stored company context
 * @param {Object} job      { clientId, userId, websiteUrl }
 * @returns {Promise<{ read: Object|null, signals: Array, runId: string, reason: string }>}
 */
export async function pursue(pursuit, context, job) {
    const timer = new PipelineTimer(DAILY_RUN_MAX_MS);

    // The budget is a module-global read by every spend site via `budget()`. It is set per
    // invocation and never checkpointed, so a daily tier needs no new plumbing — but it is
    // also shared, which is why it is set once here, at the top, before any step runs.
    configureIntelligenceRuntime({ budget: DAILY_BUDGET });

    const state = createPipelineState(context);
    // The planner already decided what to ask. `generate_queries` is skipped entirely —
    // re-deriving 22 templated strings to throw 18 of them away is the waste this whole
    // design exists to remove.
    state.queries = { selected: pursuit.queries, buckets: {} };

    const ctx = {
        job: {
            clientId: job.clientId,
            userId: job.userId,
            websiteUrl: job.websiteUrl,
            analysisMode: 'company',
            runTier: 'daily',
            requestedByRole: 'system',
        },
        timer,
        stepped: false,
        onProgress: () => {},
    };

    const done = { search: false, analyze: false };
    try {
        done.search = await runToCompletion('search', state, ctx);
        done.analyze = await runToCompletion('analyze', state, ctx);
        // Runs exactly as it does in a full run. A Read is published to a founder, so it
        // passes the same grounding and duplicate gate — a driver may not wave a gate
        // through because its output happens to be small.
        await runToCompletion('verify', state, ctx);
    } catch (err) {
        console.error('[daily] pursuit failed:', err.message);
        return { read: null, signals: [], runId: state.runId, reason: `The pursuit did not complete: ${err.message}` };
    }

    const signals = state.analyze?.signals || [];
    if (signals.length === 0) {
        return {
            read: null, signals: [], runId: state.runId,
            reason: done.search
                ? 'Searched, and found nothing solid enough to report.'
                : 'Ran out of time before the search finished.',
        };
    }

    const read = composeRead(signals, { questionId: pursuit.questionId, runId: state.runId });
    return {
        read,
        signals,
        runId: state.runId,
        reason: read ? pursuit.reason : 'Found signals, but none carried both a fact and a read.',
    };
}
