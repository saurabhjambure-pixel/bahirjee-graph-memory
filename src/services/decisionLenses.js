/**
 * The four lenses that are not a weighing.
 *
 * MCDA has an arithmetic core — weights, totals, a tipping point — and `decisionScoring.js`
 * owns it. The other four have no arithmetic. That does NOT make them a free-text field:
 * each one still has a shape, and each one still has a conclusion sentence that must be
 * assembled in code rather than written by the model.
 *
 * ── Why the conclusion is never model-written, even here ─────────────────────
 * It is the one line a founder repeats to someone else. A model writing it will eventually
 * write "you should widen your options" on a bad generation, and the advice guard would
 * catch it only after it shipped, because the guard detects and never rewrites. Assembling
 * it from a fixed frame means the sentence CANNOT become an instruction — there is nothing
 * to drift.
 *
 * Each sentence below passes the same test as the weighing's: it stays true if the founder
 * chooses the other way. "Two of these compound if started now" describes the options.
 * "Start with the one that compounds" describes what the founder must do, and is banned.
 *
 * ── What the model does contribute ───────────────────────────────────────────
 * The substance: which options were not named, what a cheap test would be, which parts of
 * a commitment cannot be walked back. Those are judgments about the world, evidence-backed,
 * and they are exactly what a model is good for. They are also all checked by
 * `auditDecisionVoice`, because they are founder-facing prose.
 *
 * See scripts/decision-lenses.test.mjs.
 */

const clean = (v, n = 400) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const list = (v) => (Array.isArray(v) ? v : []);
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Caps, per lens. A lens that returns fifteen of anything has stopped being a lens. */
const MAX_ITEMS = 5;

/**
 * Clean a lens block into the shape the UI and the persister expect.
 *
 * Every list drops entries missing their load-bearing field rather than rendering a blank —
 * an unnamed option with no label, a reality test with no test. Same rule as recognition.js:
 * a gap beats a guess, and a half-rendered row is a guess with extra steps.
 */
export function normaliseLens(frameworkId, raw = {}) {
    const r = raw && typeof raw === 'object' ? raw : {};

    switch (frameworkId) {
        case 'wrap':
            return {
                // The whole point of WRAP: the founder arrived with one option, so the
                // useful work is what else belongs on the table before anything is weighed.
                unnamed_options: list(r.unnamed_options)
                    .map(o => ({ label: clean(o?.label, 180), why: clean(o?.why, 300) }))
                    .filter(o => o.label).slice(0, MAX_ITEMS),
                // "Cheap" is the operative word. A reality test that costs as much as the
                // decision is not a test, it is the decision.
                reality_tests: list(r.reality_tests)
                    .map(t => ({ option: clean(t?.option, 180), test: clean(t?.test, 300), cost: clean(t?.cost, 120) }))
                    .filter(t => t.test).slice(0, MAX_ITEMS),
                // Attain distance: what usually happens to companies doing this, as opposed
                // to what it feels like from inside.
                outside_view: clean(r.outside_view, 600),
                // Prepare to be wrong: the condition set NOW, while it can still be judged
                // honestly, rather than after the sunk cost has accumulated.
                tripwire: r.tripwire ? {
                    condition: clean(r.tripwire.condition, 300),
                    then: clean(r.tripwire.then, 300),
                } : null,
            };

        case 'regret':
            return {
                asymmetry: clean(r.asymmetry, 600),
                // The distinction that IS the lens. Expected value averages these together
                // and hides the only thing that matters when one branch is a one-way door.
                unrecoverable: list(r.unrecoverable)
                    .map(x => ({ option: clean(x?.option, 180), what: clean(x?.what, 300) }))
                    .filter(x => x.what).slice(0, MAX_ITEMS),
                recoverable: list(r.recoverable)
                    .map(x => ({ option: clean(x?.option, 180), what: clean(x?.what, 300) }))
                    .filter(x => x.what).slice(0, MAX_ITEMS),
                // Usually the most valuable output of this lens: the version of the move
                // that buys the information without buying the commitment.
                smallest_reversible_step: clean(r.smallest_reversible_step, 400),
            };

        case 'eisenhower':
            return {
                // Not "important vs unimportant" — everything here is wanted. The split is
                // between what pays off later for starting now, and what only relieves
                // pressure today.
                compounds: list(r.compounds)
                    .map(x => ({ label: clean(x?.label, 180), why: clean(x?.why, 300) }))
                    .filter(x => x.label).slice(0, MAX_ITEMS),
                buys_time: list(r.buys_time)
                    .map(x => ({ label: clean(x?.label, 180), why: clean(x?.why, 300) }))
                    .filter(x => x.label).slice(0, MAX_ITEMS),
                defer: list(r.defer)
                    .map(x => ({ label: clean(x?.label, 180), why: clean(x?.why, 300) }))
                    .filter(x => x.label).slice(0, MAX_ITEMS),
            };

        case 'satisficing':
            return {
                // Derived from what the founder said success looks like, not invented — the
                // bar is theirs or it is not a bar.
                bar: clean(r.bar, 400),
                clears_bar: list(r.clears_bar)
                    .map(x => ({ option: clean(x?.option, 180), why: clean(x?.why, 300) }))
                    .filter(x => x.option).slice(0, MAX_ITEMS),
                cost_of_waiting: clean(r.cost_of_waiting, 400),
            };

        default:
            return null;
    }
}

/**
 * The conclusion, per lens. Assembled, never written.
 *
 * Returns `{ text, decisive }` — the same shape `describeLeaning` returns for a weighing, so
 * the UI renders one thing and does not branch on which lens produced it.
 *
 * `decisive: false` means the lens ran but did not reach a conclusion, which is a real
 * outcome and is said out loud rather than padded.
 */
export function describeLens(frameworkId, block, frame = {}) {
    if (!block) return null;
    const named = list(frame.options).length;

    switch (frameworkId) {
        case 'wrap': {
            const others = block.unnamed_options.length;
            const test = block.reality_tests[0];
            if (others === 0) {
                return {
                    text: 'Nothing else surfaced that belongs on this list, which is itself worth knowing — the option you brought may be the only real one.',
                    decisive: false,
                };
            }
            return {
                text: `You brought ${named === 1 ? 'one option' : `${named} options`}. ${count(others, 'other', 'others')} surfaced that would change the shape of this${test ? `, and ${test.test.replace(/\.$/, '')} would separate them for ${test.cost || 'little'}` : ''}.`,
                decisive: true,
            };
        }

        case 'regret': {
            const un = block.unrecoverable;
            if (un.length === 0) {
                return {
                    text: 'Nothing here turned out to be unrecoverable, so the asymmetry that made this feel heavy may not be in the decision itself.',
                    decisive: false,
                };
            }
            // Which options carry NO unrecoverable consequence. Naming them is descriptive;
            // telling the founder to pick one would not be.
            const burdened = new Set(un.map(x => x.option).filter(Boolean));
            const clear = list(frame.options).map(o => o.label).filter(l => !burdened.has(l));
            return {
                text: `${count(un.length, 'part of this', 'parts of this')} cannot be walked back${un[0].option ? `, and ${burdened.size === 1 ? 'it sits' : 'they sit'} with ${[...burdened].join(' and ')}` : ''}. ${clear.length ? `${clear.join(' and ')} leaves you somewhere you can still move from.` : 'Every option carries something irreversible, so the question is which one you would rather be unable to undo.'}`,
                decisive: true,
            };
        }

        case 'eisenhower': {
            const c = block.compounds.length;
            const b = block.buys_time.length;
            if (c === 0 && b === 0) {
                return { text: 'These did not separate into things that compound and things that relieve pressure.', decisive: false };
            }
            return {
                text: `These are not alternatives. ${count(c, 'compounds', 'compound')} if started now; ${count(b, 'relieves', 'relieve')} pressure without compounding${block.defer.length ? `; ${block.defer.length} can wait without cost` : ''}.`,
                decisive: true,
            };
        }

        case 'satisficing': {
            const clears = block.clears_bar;
            if (!block.bar) {
                return { text: 'No bar emerged from what you described, so there is nothing yet to be good enough against.', decisive: false };
            }
            if (clears.length === 0) {
                return {
                    text: `Against the bar you described — ${block.bar.replace(/\.$/, '')} — none of these clears it yet.${block.cost_of_waiting ? ` ${block.cost_of_waiting}` : ''}`,
                    decisive: true,
                };
            }
            return {
                text: `${count(clears.length, 'option', 'options')} already clear${clears.length === 1 ? 's' : ''} the bar you described: ${clears.map(x => x.option).join(', ')}.${block.cost_of_waiting ? ` ${block.cost_of_waiting}` : ''}`,
                decisive: true,
            };
        }

        default:
            return null;
    }
}

/**
 * Which fields of a lens block are founder-facing prose, so the advice guard knows what to
 * read.
 *
 * Returned as `[path, text]` pairs rather than a flat string: a hit has to name WHERE it
 * was, or a warning about "advice somewhere in the brief" is not actionable.
 */
export function lensProse(frameworkId, block) {
    if (!block) return [];
    const out = [];
    const add = (path, text) => { if (clean(text, 1)) out.push([path, text]); };

    add('outside_view', block.outside_view);
    add('asymmetry', block.asymmetry);
    add('smallest_reversible_step', block.smallest_reversible_step);
    add('bar', block.bar);
    add('cost_of_waiting', block.cost_of_waiting);
    if (block.tripwire) {
        add('tripwire.condition', block.tripwire.condition);
        add('tripwire.then', block.tripwire.then);
    }
    for (const key of ['unnamed_options', 'reality_tests', 'unrecoverable', 'recoverable', 'compounds', 'buys_time', 'defer', 'clears_bar']) {
        for (const [i, item] of list(block[key]).entries()) {
            add(`${key}[${i}].why`, item.why);
            add(`${key}[${i}].what`, item.what);
            add(`${key}[${i}].test`, item.test);
        }
    }
    return out;
}

/**
 * What a non-weighing lens commits the founder to watching.
 *
 * The weighing harvests the scores behind its decisive criteria. These lenses have their
 * own load-bearing claims, and they are not the same thing:
 *
 *   • WRAP's tripwire is the purest watch item in the product — a condition the founder set
 *     in advance, while they could still judge it honestly.
 *   • Regret's unrecoverable parts are worth watching precisely because they cannot be
 *     undone if the reasoning behind them turns out wrong.
 *
 * Eisenhower and satisficing produce no standing questions by design: a sequencing call and
 * a good-enough call are re-made when circumstances change, not monitored between times.
 * Opening watch items for them would fill the Agenda with things nobody will act on.
 */
export function harvestLensAssumptions(frameworkId, block, frame = {}) {
    if (!block) return [];
    const out = [];
    const ref = frame.id || null;

    if (frameworkId === 'wrap' && block.tripwire?.condition) {
        out.push({
            question: `Has this happened yet: ${block.tripwire.condition}`,
            watchFor: block.tripwire.then || 'the tripwire you set on this decision',
            origin: 'decision',
            originRef: ref,
        });
    }

    if (frameworkId === 'regret') {
        for (const u of list(block.unrecoverable).slice(0, 3)) {
            if (!u.what) continue;
            out.push({
                question: `Is this still true: ${u.what}`,
                watchFor: u.option ? `${u.option} — this is the part that cannot be undone` : 'the irreversible part of this decision',
                origin: 'decision',
                originRef: ref,
            });
        }
    }

    return out;
}
