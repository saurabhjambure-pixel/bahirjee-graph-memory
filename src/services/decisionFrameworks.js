/**
 * Choosing the lens — which decision framework fits THIS decision.
 *
 * A decision tool that always applies the same method is a template. What makes a judgment
 * defensible is not the framework; it is that the framework was CHOSEN, for a stated
 * reason, from a set the founder can see — and that the reason survives someone disagreeing
 * with the conclusion.
 *
 * ── The questions are the router's inputs, not a form ────────────────────────
 * Bahirjee asks exactly four things, and it asks them because it cannot find them anywhere:
 * how reversible this is, how bad the worst case is, what a quarter of delay costs, and
 * whether the options are genuinely either/or. Those four facts select the lens. Everything
 * else about the decision — who else is in the market, what a competitor charges, what the
 * regulator said — Bahirjee goes and finds for itself, and says so.
 *
 * That is the honest division of labour: it asks for what only the founder knows, and never
 * for what it could have looked up.
 *
 * ── PURE ─────────────────────────────────────────────────────────────────────
 * No network, no model, no clock. Routing a decision to a lens is a judgment the product
 * must be able to defend line by line, so it is deterministic code and not a prompt. A
 * model asked "which framework applies?" would answer differently on Tuesday.
 *
 * See scripts/decision-frameworks.test.mjs.
 */

/**
 * The five lenses, each with the condition that selects it.
 *
 * `when` is written to be shown to the founder — it is the justification, in their terms,
 * and it has to read as true to someone who disagrees with where the analysis lands.
 */
export const FRAMEWORKS = {
    eisenhower: {
        id: 'eisenhower',
        name: 'Urgent vs important',
        formal: 'Eisenhower matrix',
        when: 'These are not alternatives — they are all things you want, competing for the same weeks.',
        asks: 'Which of these buys time, and which compounds if you start now?',
    },
    wrap: {
        id: 'wrap',
        name: 'Widen the options',
        formal: 'WRAP',
        when: 'There is one option on the table, so the real question is what else belongs there.',
        asks: 'What are you not considering, and what cheap test would tell you before you commit?',
    },
    regret: {
        id: 'regret',
        name: 'Minimise regret',
        formal: 'Regret minimisation',
        when: 'This is hard to undo and the downside is much larger than the upside.',
        asks: 'Which choice leaves you somewhere you can still move from?',
    },
    satisficing: {
        id: 'satisficing',
        name: 'Good enough, soon',
        formal: 'Satisficing',
        when: 'This is reversible and low-stakes, and waiting costs more than choosing imperfectly.',
        asks: 'What would "good enough" have to look like, and what is another month of analysis worth?',
    },
    mcda: {
        id: 'mcda',
        name: 'Weigh the trade-offs',
        formal: 'Multi-criteria decision analysis',
        when: 'There are real alternatives and they trade against each other on things you care about.',
        asks: 'On your own criteria and weights, which way does the evidence lean — and what would flip it?',
    },
};

export const FRAMEWORK_IDS = Object.keys(FRAMEWORKS);

/**
 * The four questions, in the order they are asked.
 *
 * Each one exists BECAUSE the router branches on it — `routeFramework` reads exactly these
 * four fields and nothing else. If you add a question here without the router consuming it,
 * you are asking a founder for something you will not use, which is the fastest way to make
 * an interrogation feel like a form. The test asserts the pairing in both directions.
 */
export const DECISION_QUESTIONS = [
    {
        id: 'exclusive',
        question: 'Are these genuinely either/or, or could you do more than one?',
        why: "It changes what kind of problem this is — choosing between paths, or sequencing things you want anyway.",
        options: [
            { value: true, label: 'One of them, not the others' },
            { value: false, label: 'I want several — the constraint is time' },
        ],
    },
    {
        id: 'reversibility',
        question: 'If this turns out wrong in six months, what would it take to undo?',
        why: 'A door you can walk back through deserves less deliberation than one that locks.',
        options: [
            { value: 'easy', label: 'We could reverse it without much cost' },
            { value: 'costly', label: 'Reversible, but expensive or slow' },
            { value: 'irreversible', label: "We couldn't realistically undo it" },
        ],
    },
    {
        id: 'worst_case',
        question: 'What is the worst realistic outcome if this goes badly?',
        why: 'When the downside is much bigger than the upside, the method should change — not just the answer.',
        options: [
            { value: 'survivable', label: 'A setback we absorb' },
            { value: 'serious', label: 'A bad year' },
            { value: 'existential', label: 'It could end the company' },
        ],
    },
    {
        id: 'delay_cost',
        question: 'What does it cost you to still be deciding this in three months?',
        why: 'Sometimes the expensive mistake is the deliberation, not the choice.',
        options: [
            { value: 'none', label: 'Nothing much — the window stays open' },
            { value: 'some', label: 'We lose some ground' },
            { value: 'high', label: 'The opportunity is gone' },
        ],
    },
];

/** How many options make a decision a comparison rather than a commitment. */
const MIN_OPTIONS_FOR_COMPARISON = 2;

/**
 * Pick the lens.
 *
 * @param {Object} frame    a normalized decision frame (decisionService)
 * @param {Object} answers  { exclusive, reversibility, worst_case, delay_cost }
 * @returns {{ framework, why, runnerUp, whatWouldChangeIt, answered }}
 *
 * ORDER IS THE DESIGN. The checks run shape-first, then stakes:
 *
 *   1. Not either/or  → Eisenhower. If the founder wants several of these, this was never
 *      a choice between alternatives; treating it as one answers a question nobody asked.
 *   2. One option     → WRAP. You cannot weigh alternatives that have not been named, and
 *      "should we do X?" is the shape of being anchored, not of comparing.
 *   3. Irreversible + big downside → Regret. Expected value is the wrong instrument when
 *      one branch ends the company.
 *   4. Reversible + small downside + costly delay → Satisficing. Here the deliberation IS
 *      the expensive mistake.
 *   5. Otherwise      → MCDA. A real comparison with real trade-offs.
 *
 * `whatWouldChangeIt` is the routing's own sensitivity: which single answer, flipped, would
 * have sent this somewhere else. It is what lets a founder argue with the method instead of
 * only with the conclusion — and arguing with the method is the more useful conversation.
 */
export function routeFramework(frame, answers = {}) {
    const optionCount = Array.isArray(frame?.options) ? frame.options.length : 0;
    const { exclusive, reversibility, worst_case: worstCase, delay_cost: delayCost } = answers;

    const answered = DECISION_QUESTIONS.filter(q => answers[q.id] !== undefined && answers[q.id] !== null)
        .map(q => q.id);

    const pick = (id, why, runnerUp = null, whatWouldChangeIt = null) => ({
        framework: FRAMEWORKS[id],
        why,
        runnerUp: runnerUp ? FRAMEWORKS[runnerUp] : null,
        whatWouldChangeIt,
        answered,
    });

    const heavyDownside = worstCase === 'existential' || worstCase === 'serious';
    const hardToUndo = reversibility === 'irreversible' || reversibility === 'costly';

    // 1. Shape: these are not alternatives at all.
    if (exclusive === false) {
        return pick(
            'eisenhower',
            'You said you want more than one of these, so the constraint is your weeks, not the choice itself.',
            optionCount >= MIN_OPTIONS_FOR_COMPARISON ? 'mcda' : null,
            'If these turned out to be genuinely either/or, this becomes a trade-off problem instead.',
        );
    }

    // 2. Shape: there is nothing to compare yet.
    if (optionCount < MIN_OPTIONS_FOR_COMPARISON) {
        return pick(
            'wrap',
            optionCount === 1
                ? 'Only one option is on the table, and a yes/no on a single option is usually a narrower question than the one worth asking.'
                : 'No distinct options have been named yet, so the first useful move is to widen what is being considered.',
            'mcda',
            'Once there are two or more real options, this becomes a trade-off problem.',
        );
    }

    // 3. Stakes: one branch is unrecoverable.
    if (hardToUndo && heavyDownside) {
        return pick(
            'regret',
            `You said this would be ${reversibility === 'irreversible' ? 'impossible' : 'expensive'} to undo and the bad outcome is ${worstCase === 'existential' ? 'existential' : 'a bad year'}. When one branch is unrecoverable, weighing averages hides the thing that matters.`,
            'mcda',
            'If it were easier to reverse, the trade-off weighing would be the better lens.',
        );
    }

    // 4. Stakes: the deliberation is the expensive part.
    if (reversibility === 'easy' && worstCase === 'survivable' && delayCost === 'high') {
        return pick(
            'satisficing',
            'This is reversible, the downside is absorbable, and you said the window closes. More analysis costs more than a good-enough answer.',
            'mcda',
            'If the downside were larger, it would be worth the slower comparison.',
        );
    }

    // 5. A genuine comparison.
    return pick(
        'mcda',
        `There are ${optionCount} real options and they trade against each other, so the useful work is making those trade-offs explicit against your own criteria.`,
        hardToUndo ? 'regret' : null,
        hardToUndo
            ? 'If the worst case were serious as well as hard to undo, regret would be the better lens.'
            : 'If it became hard to undo with a severe downside, regret would be the better lens.',
    );
}

/**
 * Which questions still need answering before the routing is trustworthy.
 *
 * Routing works on partial answers — it degrades to MCDA, which is the safe default for a
 * real comparison — but it should SAY so rather than present a confident lens chosen from
 * nothing. Same rule as the confidence cap on a brief: the honest move is to name the gap.
 */
export function missingAnswers(answers = {}) {
    return DECISION_QUESTIONS
        .filter(q => answers[q.id] === undefined || answers[q.id] === null)
        .map(q => q.id);
}

/**
 * The questions worth asking for THIS frame, in order.
 *
 * `exclusive` is dropped when there is nothing to be exclusive about: asking "are these
 * either/or?" about a single option is a question with one possible answer, and asking it
 * anyway is how an interrogation starts feeling like a form.
 */
export function questionsFor(frame) {
    const optionCount = Array.isArray(frame?.options) ? frame.options.length : 0;
    return DECISION_QUESTIONS.filter(q => !(q.id === 'exclusive' && optionCount < MIN_OPTIONS_FOR_COMPARISON));
}
