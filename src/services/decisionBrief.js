/**
 * The decision brief — one shape, whichever lens was used.
 *
 * `briefSchema.js` normalises the weekly brief on both the write and the read path, because
 * rows written under older shapes are already in the database. This does the same job for a
 * decision, and reuses that file's confidence calibration rather than inventing a second
 * scale — two answers to "how sure are we?" would drift, and the disagreement would be
 * invisible until a founder noticed the same evidence rated differently in two places.
 *
 * ── One addition a weekly brief does not need ────────────────────────────────
 * COVERAGE. A decision weighed on 40% of its option×criterion cells cannot be High
 * confidence however many sources were read, because the gaps are not randomly placed —
 * they sit wherever the evidence was hardest to find, which is usually the thing that
 * matters. Sources measure how much was read; coverage measures how much of the actual
 * question was answered.
 *
 * ── What is code and what is the model ───────────────────────────────────────
 * The conclusion sentence is ALWAYS assembled in code (decisionScoring.describeLeaning) and
 * never taken from the model, so the one line the product is judged on cannot drift into
 * advice on a bad generation. The model writes the per-cell bases, the unknowns and the
 * lens-specific prose — all of which `auditDecisionVoice` checks against the same 18-phrase
 * ban the weekly brief uses.
 *
 * See scripts/decision-brief.test.mjs.
 */

import { calibrateConfidence, detectAdviceLeakage } from './briefSchema.js';
import { FRAMEWORKS } from './decisionFrameworks.js';
import { scoreOptions, sensitivity, describeLeaning } from './decisionScoring.js';
import { normaliseLens, describeLens, lensProse, harvestLensAssumptions } from './decisionLenses.js';

export const DECISION_SCHEMA = 'decision.v1';

const clean = (v, n = 400) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const list = (v) => (Array.isArray(v) ? v : []);

const RANK = { Low: 0, Medium: 1, High: 2 };

/**
 * How much of the question was actually answered.
 *
 * `scored / possible` over the full option×criterion grid. Reported even when complete,
 * because "we answered all of it" is a claim worth being able to see.
 */
export function coverageOf({ options = [], criteria = [], scores = [] }) {
    const possible = options.length * criteria.length;
    if (possible === 0) return { scored: 0, possible: 0, ratio: 0 };
    const valid = new Set();
    for (const s of scores) {
        if (!s?.option_id || !s?.criterion_id) continue;
        if (!Number.isFinite(Number(s.score))) continue;
        valid.add(`${s.option_id}::${s.criterion_id}`);
    }
    return { scored: valid.size, possible, ratio: valid.size / possible };
}

/**
 * Cap confidence by how much of the grid was filled.
 *
 * Thresholds are deliberately blunt — below two thirds is Low, below nine tenths is at best
 * Medium. A decision is not a weekly scan: the founder is about to do something, and a
 * confident-sounding read over half a grid is the failure mode worth being unfair about.
 */
export function capForCoverage(confidence, coverage) {
    if (!confidence) return confidence;
    const ratio = coverage?.ratio ?? 1;
    let ceiling = 'High';
    if (ratio < 0.9) ceiling = 'Medium';
    if (ratio < 0.67) ceiling = 'Low';

    if (RANK[ceiling] >= RANK[confidence.level]) return { ...confidence, coverage };

    const missed = (coverage?.possible || 0) - (coverage?.scored || 0);
    return {
        ...confidence,
        level: ceiling,
        coverage,
        basis: `${confidence.basis} Held at ${ceiling} because ${missed} of ${coverage.possible} option-by-criterion cells could not be scored.`,
        capped_by: [...(confidence.capped_by || []), 'score_coverage'],
    };
}

/**
 * Assemble a decision brief from the model's output and the arithmetic.
 *
 * @param {Object} raw       what weighDecision returned
 * @param {Object} frame     the normalized decision frame
 * @param {Object} routing   what routeFramework returned
 * @param {Object[]} signals the evidence gathered
 * @param {string} depth     run tier
 * @param {Object[]} founderCriteria weights the founder set, which OVERRIDE the model's
 */
export function buildDecisionBrief({ raw = {}, frame = {}, routing = null, signals = [], depth = 'full', founderCriteria = null } = {}) {
    const options = list(frame.options);

    // The founder's weights win outright where they exist. A model re-weighting the
    // criteria a person just set would silently answer a different question from the one
    // they asked, and they would have no way to see it happen.
    const modelCriteria = list(raw.criteria).filter(c => c?.id && c?.name);
    const criteria = list(founderCriteria).length
        ? list(founderCriteria).filter(c => c?.id)
        : modelCriteria;

    const scores = list(raw.scores)
        .filter(s => s?.option_id && s?.criterion_id && Number.isFinite(Number(s.score)))
        // A score with no basis is an unexplained number the founder is being asked to
        // argue with. Drop it rather than render it bare — a gap is honest, a naked 4 is not.
        .filter(s => clean(s.basis, 1).length > 0)
        .map(s => ({
            option_id: s.option_id,
            criterion_id: s.criterion_id,
            score: Number(s.score),
            basis: clean(s.basis, 400),
            evidence_refs: list(s.evidence_refs).filter(n => Number.isFinite(Number(n))).map(Number),
        }));

    const framework = routing?.framework || FRAMEWORKS.mcda;
    // A weighing needs a weighing's inputs. A route to MCDA that arrives without criteria
    // or without two options is NOT quietly downgraded to an empty scorecard — it falls
    // through to the lens branch, which reports that it reached no conclusion.
    const isWeighed = framework.id === 'mcda' && criteria.length > 0 && options.length >= 2;

    let result = null;
    let sens = [];
    let leaning = null;
    let lens = null;

    if (isWeighed) {
        result = scoreOptions({ criteria, scores, options });
        sens = sensitivity({ criteria: result.criteria, totals: result.totals, scores, leader: result.leader, runnerUp: result.runnerUp });
        leaning = describeLeaning(result, sens);
    } else {
        // One of the four lenses that is not a weighing. Its conclusion is assembled in
        // code for the same reason the weighing's is: it is the line a founder repeats to
        // someone else, and a model writing it would eventually write an instruction.
        lens = normaliseLens(framework.id, raw.lens || raw);
        leaning = describeLens(framework.id, lens, frame);
    }

    const coverage = coverageOf({ options, criteria, scores });
    const confidence = capForCoverage(
        calibrateConfidence({ signals, depth, claimed: null }),
        coverage,
    );

    return {
        schema: DECISION_SCHEMA,
        decision_id: frame.id || null,
        decision_statement: clean(frame.decision_statement, 600),

        framework: {
            id: framework.id,
            name: framework.name,
            formal: framework.formal,
            // Why THIS lens, and what would have chosen another. The second half is what
            // lets a founder argue with the method rather than only the conclusion.
            why: clean(routing?.why, 600),
            what_would_change_it: clean(routing?.whatWouldChangeIt, 400),
        },
        answers_given: routing?.answered || [],

        criteria: isWeighed ? result.criteria : criteria,
        scores,
        totals: isWeighed ? result.totals : [],
        sensitivity: sens,
        // Never model-written, whichever lens produced it.
        leaning: leaning || null,
        // Populated only for the four non-weighing lenses; null for MCDA, whose substance
        // lives in criteria/scores/totals/sensitivity above.
        lens,
        too_close: Boolean(result?.tooClose),

        unknowns: list(raw.unknowns)
            .map(u => ({ text: clean(typeof u === 'string' ? u : u?.text, 400), would_settle_it: clean(u?.would_settle_it, 300) }))
            .filter(u => u.text)
            .slice(0, 6),

        confidence,
        options,
    };
}

/**
 * The advice guard, over the fields the model actually wrote.
 *
 * Detection only, never rewriting — the same decision briefPolicy B4 made, for the same
 * reason: editing the words to hide the leak removes the only evidence that the prompt
 * started giving advice.
 *
 * `leaning.text` is checked too, even though it is code-assembled. That is not redundant:
 * it is how a future edit to `describeLeaning` that introduces an imperative gets caught by
 * the same net as a bad generation.
 */
export function auditDecisionVoice(brief) {
    const hits = [];
    const look = (where, text) => {
        for (const phrase of detectAdviceLeakage(text || '')) hits.push({ where, phrase });
    };

    look('leaning', brief?.leaning?.text);
    look('framework.why', brief?.framework?.why);
    for (const [path, text] of lensProse(brief?.framework?.id, brief?.lens)) look(`lens.${path}`, text);
    for (const [i, s] of (brief?.scores || []).entries()) look(`scores[${i}].basis`, s.basis);
    for (const [i, u] of (brief?.unknowns || []).entries()) look(`unknowns[${i}]`, u.text);

    return hits;
}

/**
 * The loop-closer: what this decision commits you to watching.
 *
 * PURE. Turns a finished decision into standing Agenda questions, which is the whole reason
 * `decision_briefs` describes itself as holding "durable identities that can be revisited
 * with fresh evidence" and has never had a read path.
 *
 * It harvests the LOAD-BEARING assumptions only — the ones that, if wrong, change the
 * answer:
 *
 *   • the basis behind each score on a DECISIVE criterion for the leading option. If that
 *     fact turns out to be wrong, the ranking moves. A score on a criterion the sensitivity
 *     already proved cannot flip the result is not worth a founder's attention for months.
 *   • every unknown that named what would settle it — an unknown with no route to an answer
 *     is not something to stand watch over.
 *
 * Harvesting every assumption would bury the Agenda, which displays six items. The point is
 * to watch the few things that would change the decision, not to log everything said.
 */
export function harvestDecisionAssumptions(brief) {
    if (!brief) return [];

    const out = [];
    const seen = new Set();
    const push = (question, watchFor) => {
        const key = question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push({ question, watchFor: watchFor || null, origin: 'decision', originRef: brief.decision_id || null });
    };

    const leaderId = brief?.totals?.[0]?.optionId;
    const decisive = new Set(list(brief.sensitivity).filter(s => s.decisive).map(s => s.criterionId));

    if (leaderId && decisive.size) {
        for (const s of list(brief.scores)) {
            if (s.option_id !== leaderId || !decisive.has(s.criterion_id)) continue;
            const name = list(brief.criteria).find(c => c.id === s.criterion_id)?.name || s.criterion_id;
            push(`Is this still true: ${s.basis}`, `${name} — this is what the decision turned on`);
        }
    }

    // A non-weighing lens has its own load-bearing claims — WRAP's tripwire, regret's
    // irreversible parts — and they are not scores.
    for (const item of harvestLensAssumptions(brief?.framework?.id, brief?.lens, { id: brief.decision_id })) {
        push(item.question, item.watchFor);
    }

    for (const u of list(brief.unknowns)) {
        if (!u.would_settle_it) continue;
        push(u.text, u.would_settle_it);
    }

    return out.slice(0, 5);
}
