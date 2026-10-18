/**
 * The arithmetic of a weighed decision.
 *
 * This module is the defensible core of a decision brief, and every line of it is
 * DETERMINISTIC. The division of labour is deliberate and it is the whole argument:
 *
 *   the model  — proposes criteria, and scores each option against each one, citing
 *                evidence for the score it gives
 *   this file  — does the weighing, the ranking, and the sensitivity
 *
 * Asking a model "which option wins, and what would change that?" produces a confident
 * sentence with nothing underneath it. The founder cannot check it, cannot reproduce it,
 * and cannot argue with it except by disagreeing. Weighted sums and tipping points are
 * arithmetic; done here, a founder can disagree with a SCORE or a WEIGHT — both of which
 * are visible, and one of which is theirs — and watch the conclusion move.
 *
 * ── Why the sensitivity matters more than the ranking ────────────────────────
 * "The evidence favours B" is worth very little on its own. "The evidence favours B, and
 * that holds unless you weight onboarding cost above 38%" is a decision someone can take
 * into a board meeting and defend, because it names the exact condition under which the
 * reasonable person who disagrees would be right.
 *
 * It is also how this stays judgment rather than advice: a sentence that names what would
 * make the other choice correct is still true if the founder chooses the other way.
 *
 * See scripts/decision-scoring.test.mjs.
 */

/** Scores are 0–5. Wider scales imply a precision the evidence does not have. */
export const SCORE_MIN = 0;
export const SCORE_MAX = 5;

/** Below this, the two leading options are not meaningfully apart. */
export const TOO_CLOSE_MARGIN = 0.15;

const clampScore = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(SCORE_MAX, Math.max(SCORE_MIN, n));
};

/**
 * Normalise weights to sum to 1.
 *
 * A founder moving sliders will not produce weights summing to 1, and demanding they do is
 * arithmetic homework for a person who came here to make a decision. Equal weights are the
 * fallback when nothing usable is supplied — stated rather than silent, because "we weighed
 * everything equally" is itself a choice the reader should be able to see and reject.
 */
export function normaliseWeights(criteria) {
    const list = (criteria || []).filter(c => c && c.id);
    if (list.length === 0) return [];

    const raw = list.map(c => {
        const n = Number(c.weight);
        return Number.isFinite(n) && n > 0 ? n : 0;
    });
    const total = raw.reduce((a, b) => a + b, 0);

    if (total <= 0) {
        const equal = 1 / list.length;
        return list.map(c => ({ ...c, weight: equal, weightWasSupplied: false }));
    }
    return list.map((c, i) => ({ ...c, weight: raw[i] / total, weightWasSupplied: raw[i] > 0 }));
}

/**
 * Weigh the options.
 *
 * @param {Object[]} criteria [{ id, name, weight }]
 * @param {Object[]} scores   [{ option_id, criterion_id, score, basis, evidence_refs }]
 * @param {Object[]} options  [{ id, label }]
 *
 * A missing score is NOT zero. Zero means "this option is bad at this", which is a claim;
 * missing means "we did not find out", which is a gap. Conflating them silently invents
 * evidence against whichever option was researched least — so an unscored cell is excluded
 * from both sides of the comparison and counted, and the count is reported.
 */
export function scoreOptions({ criteria = [], scores = [], options = [] }) {
    const weighted = normaliseWeights(criteria);
    const byOption = new Map(options.filter(o => o?.id).map(o => [o.id, o]));

    const cell = new Map();
    for (const s of scores) {
        if (!s?.option_id || !s?.criterion_id) continue;
        const v = clampScore(s.score);
        if (v === null) continue;
        cell.set(`${s.option_id}::${s.criterion_id}`, { ...s, score: v });
    }

    const totals = [...byOption.values()].map(option => {
        let weightUsed = 0;
        let sum = 0;
        const gaps = [];

        for (const c of weighted) {
            const hit = cell.get(`${option.id}::${c.id}`);
            if (!hit) { gaps.push(c.id); continue; }
            sum += c.weight * (hit.score / SCORE_MAX);
            weightUsed += c.weight;
        }

        // Re-base on the weight actually covered, so an option scored on 3 of 4 criteria is
        // not penalised for the criterion nobody researched. The coverage travels with the
        // number so the caller can cap confidence on it.
        const total = weightUsed > 0 ? sum / weightUsed : 0;
        return { optionId: option.id, label: option.label, total, coverage: weightUsed, gaps };
    });

    totals.sort((a, b) => b.total - a.total);

    const leader = totals[0] || null;
    const runnerUp = totals[1] || null;
    const margin = leader && runnerUp ? leader.total - runnerUp.total : 0;

    return {
        criteria: weighted,
        totals,
        leader,
        runnerUp,
        margin,
        // Two options within a rounding error of each other is a real finding — and the
        // honest one is "your criteria do not separate these", not a fabricated winner.
        tooClose: Boolean(leader && runnerUp && margin < TOO_CLOSE_MARGIN),
        unscored: totals.reduce((n, t) => n + t.gaps.length, 0),
    };
}

/**
 * At what weight on each criterion would the answer change?
 *
 * For criterion k, hold the OTHER criteria in their existing proportions and vary k's
 * weight until the leader and the runner-up tie. With d_i as the leader's per-criterion
 * advantage and S the runner-up's total advantage across every other criterion:
 *
 *     new margin(x) = x·d_k + (1 − x)·S / (1 − w_k)
 *
 * Setting that to zero and solving gives the tipping weight. Re-proportioning the others
 * rather than holding them fixed is what keeps the weights summing to one at every point,
 * so the tipping value is a weight the founder could actually set — not an abstraction.
 *
 * Returns only criteria whose tipping point is reachable: a weight in (0, 1) that differs
 * from today's. A criterion that cannot flip the answer at ANY weight is reported as
 * `decisive: false` — which is often the most useful line in the whole brief, because it
 * says the argument about that criterion does not matter.
 */
export function sensitivity({ criteria, totals, scores, leader, runnerUp }) {
    if (!leader || !runnerUp) return [];

    const weighted = normaliseWeights(criteria);
    const at = (optionId, criterionId) => {
        const s = (scores || []).find(x => x?.option_id === optionId && x?.criterion_id === criterionId);
        const v = clampScore(s?.score);
        return v === null ? null : v / SCORE_MAX;
    };

    // Per-criterion advantage to the leader. A criterion where either option is unscored
    // contributes nothing — it is a gap, not a tie.
    const d = new Map();
    for (const c of weighted) {
        const l = at(leader.optionId, c.id);
        const r = at(runnerUp.optionId, c.id);
        d.set(c.id, l === null || r === null ? null : l - r);
    }

    const totalMargin = weighted.reduce((m, c) => m + (d.get(c.id) ?? 0) * c.weight, 0);

    const out = [];
    for (const c of weighted) {
        const dk = d.get(c.id);
        if (dk === null) continue;

        const wk = c.weight;
        if (wk >= 1) continue;

        const S = totalMargin - wk * dk;          // the others' contribution, at today's weights
        const cScaled = S / (1 - wk);             // re-proportioned to fill the remaining weight
        const denom = cScaled - dk;

        // Parallel lines: this criterion cannot tip the result at any weight.
        if (Math.abs(denom) < 1e-9) {
            out.push({ criterionId: c.id, name: c.name, weight: wk, decisive: false, tippingWeight: null });
            continue;
        }

        const x = cScaled / denom;
        const reachable = Number.isFinite(x) && x > 0 && x < 1 && Math.abs(x - wk) > 1e-6;

        out.push({
            criterionId: c.id,
            name: c.name,
            weight: wk,
            decisive: reachable,
            tippingWeight: reachable ? x : null,
            // Which way the founder would have to move to get there. Naming the direction
            // makes the line readable without doing the subtraction in your head.
            direction: reachable ? (x > wk ? 'up' : 'down') : null,
        });
    }

    // Nearest tipping point first: the criterion a founder is most likely to argue about is
    // the one where a small change of mind matters.
    out.sort((a, b) => {
        if (a.decisive !== b.decisive) return a.decisive ? -1 : 1;
        if (!a.decisive) return 0;
        return Math.abs(a.tippingWeight - a.weight) - Math.abs(b.tippingWeight - b.weight);
    });
    return out;
}

const pct = (n) => `${Math.round(n * 100)}%`;

/**
 * The conclusion, in a sentence that stays true whichever way the founder chooses.
 *
 * THE TEST, from the prompt rules: a sentence that is still true if the founder chooses the
 * other way is a judgment; one that is only true if they obey is advice. "The evidence
 * favours B on your criteria" passes — it describes the evidence, not the founder. "You
 * should choose B" fails.
 *
 * PURE and never model-written, so the one sentence the whole product is judged on cannot
 * drift into advice on a bad generation. There is no ADVICE_PHRASES check here because
 * there is nothing to check: the sentence is assembled from a fixed frame.
 */
export function describeLeaning(result, sens = []) {
    if (!result?.leader) return null;

    if (result.tooClose) {
        return {
            text: `On your criteria and weights, ${result.leader.label} and ${result.runnerUp.label} come out within ${pct(result.margin)} of each other. The evidence here does not separate them.`,
            decisive: false,
        };
    }

    const flip = sens.find(s => s.decisive);
    const base = `On your criteria and weights, the evidence favours ${result.leader.label} over ${result.runnerUp.label} by ${pct(result.margin)}.`;

    return {
        text: flip
            ? `${base} That stops holding if you weight ${flip.name} ${flip.direction === 'up' ? 'above' : 'below'} ${pct(flip.tippingWeight)} — it is at ${pct(flip.weight)} now.`
            : `${base} No single change of weight reverses that, so the disagreement worth having is about the scores rather than the priorities.`,
        decisive: true,
    };
}
