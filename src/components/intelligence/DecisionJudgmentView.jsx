import React, { useMemo, useState } from 'react';
import { Check, RotateCcw, Scale } from 'lucide-react';
import { scoreOptions, sensitivity, describeLeaning, SCORE_MAX } from '../../services/decisionScoring';

/**
 * A decision, shown so it can be argued with.
 *
 * ── The weights are live ─────────────────────────────────────────────────────
 * The sliders re-run the whole weighing on every change — client-side, instantly, because
 * `decisionScoring` is pure arithmetic with no model in it. That is not a flourish. The
 * product claim is that this judgment is defensible because you can disagree with a weight
 * and watch the conclusion move; a static table would only let you disagree with the
 * conclusion, which is the useless kind of disagreement.
 *
 * It is also the honest expression of the sensitivity line. "This stops holding if you
 * weight defensibility above 33%" is a sentence a founder has to take on trust. A slider
 * that visibly flips the answer at 33% is the same fact, checkable in two seconds.
 *
 * ── What is not editable ─────────────────────────────────────────────────────
 * Scores. They are claims about the world with evidence attached, and a founder overriding
 * one would be editing the evidence rather than their own priorities. Disagreeing with a
 * score is a conversation to have with the analysis — the interrogation box below — not a
 * number to overwrite. Weights are theirs; scores are Bahirjee's, and the line between them
 * is what makes the artifact mean anything.
 *
 * ── Voice ────────────────────────────────────────────────────────────────────
 * The judgment is Bahirjee talking, so its prose is first person where it appears. The
 * chrome around it — headings, the scorecard, the labels — speaks in the third.
 */
export default function DecisionJudgmentView({
    judgment,
    frame,
    chosenOptionId = null,
    onRecordChoice,
    onAsk,
    askAnswer = null,
    isAsking = false,
}) {
    const [weights, setWeights] = useState(null);
    const [question, setQuestion] = useState('');

    const baseCriteria = judgment?.criteria || [];
    const isWeighed = (judgment?.totals?.length || 0) > 0;

    // Re-weigh live. Falls back to what was persisted until a slider is touched, so the
    // screen opens showing exactly what was saved.
    const live = useMemo(() => {
        if (!isWeighed || !weights) return null;
        const criteria = baseCriteria.map(c => ({ ...c, weight: weights[c.id] ?? c.weight }));
        const r = scoreOptions({ criteria, scores: judgment.scores, options: frame?.options || [] });
        const s = sensitivity({ criteria: r.criteria, totals: r.totals, scores: judgment.scores, leader: r.leader, runnerUp: r.runnerUp });
        return { ...r, sens: s, leaning: describeLeaning(r, s) };
    }, [weights, isWeighed, baseCriteria, judgment, frame]);

    const totals = live?.totals || judgment?.totals || [];
    const sens = live?.sens || judgment?.sensitivity || [];
    const leaning = live?.leaning || judgment?.leaning || null;
    const criteria = live?.criteria || baseCriteria;
    const touched = Boolean(weights);

    if (!judgment) return null;

    const pct = (n) => `${Math.round(n * 100)}%`;
    const scoreFor = (optionId, criterionId) =>
        (judgment.scores || []).find(s => s.option_id === optionId && s.criterion_id === criterionId);

    return (
        <div className="space-y-5">
            {/* ── The lens, and why ─────────────────────────────────────────── */}
            <section className="bah-panel p-4">
                <div className="flex items-start gap-2.5">
                    <Scale className="w-4 h-4 text-bah-accent shrink-0 mt-0.5" aria-hidden="true" />
                    <div className="min-w-0">
                        <h2 className="font-display text-sm font-semibold text-bah-strong">
                            {judgment.framework?.name}
                            {judgment.framework?.formal && judgment.framework.formal !== judgment.framework.name && (
                                <span className="font-normal text-bah-muted-2"> · {judgment.framework.formal}</span>
                            )}
                        </h2>
                        {judgment.framework?.why && (
                            <p className="text-sm text-bah-muted leading-relaxed mt-1">{judgment.framework.why}</p>
                        )}
                        {/* The routing's own sensitivity. Without it a founder can argue only
                            with the conclusion; with it they can argue with the method. */}
                        {judgment.framework?.what_would_change_it && (
                            <p className="text-xs text-bah-muted-2 leading-relaxed mt-1.5">
                                {judgment.framework.what_would_change_it}
                            </p>
                        )}
                    </div>
                </div>
            </section>

            {/* ── The read ──────────────────────────────────────────────────── */}
            {leaning && (
                <section className="bah-panel-strong p-4">
                    <p className="text-[10px] uppercase tracking-widest text-bah-muted mb-1.5">What the evidence favours</p>
                    <p className="text-base text-bah-strong leading-relaxed font-display">{leaning.text}</p>
                    {touched && (
                        <p className="text-xs text-bah-accent-text mt-2">
                            Recalculated with your weights.
                        </p>
                    )}
                </section>
            )}

            {/* ── The scorecard, with the weights in the founder's hands ────── */}
            {isWeighed && (
                <section className="bah-panel p-4" aria-labelledby="scorecard-heading">
                    <div className="flex items-center justify-between gap-3 mb-3">
                        <h3 id="scorecard-heading" className="text-[10px] uppercase tracking-widest text-bah-muted">
                            How it weighs up
                        </h3>
                        {touched && (
                            <button
                                type="button"
                                onClick={() => setWeights(null)}
                                className="flex items-center gap-1 text-xs text-bah-muted hover:text-bah-strong transition-colors"
                            >
                                <RotateCcw className="w-3 h-3" aria-hidden="true" />
                                Back to the original weights
                            </button>
                        )}
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full text-sm border-collapse">
                            <thead>
                                <tr className="border-b border-bah">
                                    <th className="text-left font-medium text-bah-muted py-2 pr-3 w-[38%]">Criterion</th>
                                    {(frame?.options || []).map(o => (
                                        <th key={o.id} className="text-left font-medium text-bah-muted py-2 px-2">{o.label}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {criteria.map(c => (
                                    <tr key={c.id} className="border-b border-bah align-top">
                                        <td className="py-3 pr-3">
                                            <div className="text-bah-strong">{c.name}</div>
                                            {c.why && <div className="text-xs text-bah-muted-2 mt-0.5">{c.why}</div>}
                                            <div className="flex items-center gap-2 mt-2">
                                                <input
                                                    type="range" min="0" max="100" step="1"
                                                    value={Math.round((weights?.[c.id] ?? c.weight) * 100)}
                                                    onChange={(e) => {
                                                        const next = { ...(weights || Object.fromEntries(baseCriteria.map(x => [x.id, x.weight]))) };
                                                        next[c.id] = Number(e.target.value) / 100;
                                                        setWeights(next);
                                                    }}
                                                    aria-label={`Weight for ${c.name}`}
                                                    className="flex-1 accent-[var(--bah-accent)]"
                                                />
                                                <span className="text-xs text-bah-muted font-num w-9 text-right">{pct(c.weight)}</span>
                                            </div>
                                        </td>
                                        {(frame?.options || []).map(o => {
                                            const s = scoreFor(o.id, c.id);
                                            return (
                                                <td key={o.id} className="py-3 px-2">
                                                    {s ? (
                                                        <>
                                                            <span className="font-num text-bah-strong">{s.score}</span>
                                                            <span className="text-bah-muted-2 font-num">/{SCORE_MAX}</span>
                                                            <p className="text-xs text-bah-muted leading-snug mt-1">{s.basis}</p>
                                                        </>
                                                    ) : (
                                                        // A gap, said as one. Rendering 0 here would read as
                                                        // "bad at this" rather than "we did not find out".
                                                        <span className="text-xs text-bah-muted-2">Not established</span>
                                                    )}
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))}
                                <tr>
                                    <td className="py-3 pr-3 text-[10px] uppercase tracking-widest text-bah-muted">Overall</td>
                                    {(frame?.options || []).map(o => {
                                        const t = totals.find(x => x.optionId === o.id);
                                        const isLeader = totals[0]?.optionId === o.id && !live?.tooClose && !judgment.too_close;
                                        return (
                                            <td key={o.id} className="py-3 px-2">
                                                <span className={`font-num text-base ${isLeader ? 'text-bah-accent-text font-semibold' : 'text-bah-strong'}`}>
                                                    {t ? pct(t.total) : '—'}
                                                </span>
                                            </td>
                                        );
                                    })}
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    {sens.length > 0 && (
                        <div className="mt-4 pt-3 border-t border-bah">
                            <p className="text-[10px] uppercase tracking-widest text-bah-muted mb-2">What would change the answer</p>
                            <ul className="space-y-1">
                                {sens.map(s => (
                                    <li key={s.criterionId} className="text-xs text-bah-muted">
                                        <span className="text-bah">{s.name}</span>
                                        {s.decisive
                                            ? <> — flips it {s.direction === 'up' ? 'above' : 'below'} <span className="font-num text-bah-strong">{pct(s.tippingWeight)}</span> (now {pct(s.weight)})</>
                                            // Often the most useful line here: the argument
                                            // about this one does not matter.
                                            : <> — cannot change the answer at any weight</>}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </section>
            )}

            {/* ── A lens that is not a weighing ─────────────────────────────── */}
            {judgment.lens && <LensBlock id={judgment.framework?.id} lens={judgment.lens} />}

            {/* ── What is not settled ───────────────────────────────────────── */}
            {judgment.unknowns?.length > 0 && (
                <section className="bah-panel p-4">
                    <p className="text-[10px] uppercase tracking-widest text-bah-muted mb-2">What this doesn't settle</p>
                    <ul className="space-y-2">
                        {judgment.unknowns.map((u, i) => (
                            <li key={i} className="text-sm text-bah leading-relaxed">
                                {u.text}
                                {u.would_settle_it && (
                                    <span className="block text-xs text-bah-muted-2 mt-0.5">Would settle it: {u.would_settle_it}</span>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {/* ── Confidence, with its basis ────────────────────────────────── */}
            {judgment.confidence && (
                <p className="text-xs text-bah-muted-2 leading-relaxed px-1">
                    <span className="text-bah-muted">{judgment.confidence.level} confidence.</span> {judgment.confidence.basis}
                </p>
            )}

            {/* ── The choice is the founder's ───────────────────────────────── */}
            {onRecordChoice && (frame?.options?.length || 0) > 0 && (
                <section className="bah-panel p-4">
                    <p className="text-sm text-bah-strong mb-1">What did you decide?</p>
                    <p className="text-xs text-bah-muted-2 mb-3">
                        {/* Recorded, never assumed. Everything the Agenda says later about
                            this decision is built on the answer to this question. */}
                        Bahirjee watches the assumptions behind whichever you pick — including if you go the other way.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {frame.options.map(o => (
                            <button
                                key={o.id}
                                type="button"
                                onClick={() => onRecordChoice(chosenOptionId === o.id ? null : o.id)}
                                className={chosenOptionId === o.id
                                    ? 'bah-button-primary text-xs px-3 py-1.5 flex items-center gap-1.5'
                                    : 'bah-button-secondary text-xs px-3 py-1.5'}
                            >
                                {chosenOptionId === o.id && <Check className="w-3.5 h-3.5" aria-hidden="true" />}
                                {o.label}
                            </button>
                        ))}
                    </div>
                    {chosenOptionId && (
                        <p className="text-xs text-bah-muted mt-2">Recorded. Tap again to undo.</p>
                    )}
                </section>
            )}

            {/* ── Interrogate ───────────────────────────────────────────────── */}
            {onAsk && (
                <section className="bah-panel p-4">
                    <p className="text-sm text-bah-strong mb-2">Push back on this</p>
                    <form
                        onSubmit={(e) => { e.preventDefault(); if (question.trim()) onAsk(question.trim()); }}
                        className="flex gap-2"
                    >
                        <input
                            value={question}
                            onChange={(e) => setQuestion(e.target.value)}
                            placeholder="Why did you score defensibility so low?"
                            className="bah-input flex-1 text-sm"
                            aria-label="Question about this judgment"
                        />
                        <button type="submit" disabled={!question.trim() || isAsking} className="bah-button-secondary text-xs px-3 py-1.5 disabled:opacity-50">
                            {isAsking ? 'Reading…' : 'Ask'}
                        </button>
                    </form>
                    {askAnswer && (
                        <p className="text-sm text-bah leading-relaxed mt-3 pt-3 border-t border-bah">{askAnswer}</p>
                    )}
                </section>
            )}
        </div>
    );
}

/** The four lenses that are not a weighing, each rendered in its own shape. */
function LensBlock({ id, lens }) {
    const Group = ({ label, items, render }) => (
        items?.length ? (
            <div className="mb-3 last:mb-0">
                <p className="text-[10px] uppercase tracking-widest text-bah-muted mb-1.5">{label}</p>
                <ul className="space-y-1.5">
                    {items.map((x, i) => <li key={i} className="text-sm text-bah leading-relaxed">{render(x)}</li>)}
                </ul>
            </div>
        ) : null
    );
    const Line = ({ label, text }) => (
        text ? (
            <div className="mb-3 last:mb-0">
                <p className="text-[10px] uppercase tracking-widest text-bah-muted mb-1">{label}</p>
                <p className="text-sm text-bah leading-relaxed">{text}</p>
            </div>
        ) : null
    );

    return (
        <section className="bah-panel p-4">
            {id === 'wrap' && (
                <>
                    <Group label="Options you didn't name" items={lens.unnamed_options}
                        render={(x) => <><span className="text-bah-strong">{x.label}</span>{x.why ? ` — ${x.why}` : ''}</>} />
                    <Group label="What would tell you cheaply" items={lens.reality_tests}
                        render={(x) => <>{x.option ? <span className="text-bah-strong">{x.option}: </span> : null}{x.test}{x.cost ? <span className="text-bah-muted-2"> · {x.cost}</span> : ''}</>} />
                    <Line label="From outside" text={lens.outside_view} />
                    {lens.tripwire?.condition && (
                        <Line label="The tripwire you're setting" text={`If ${lens.tripwire.condition}${lens.tripwire.then ? `, ${lens.tripwire.then}` : ''}.`} />
                    )}
                </>
            )}
            {id === 'regret' && (
                <>
                    <Line label="The asymmetry" text={lens.asymmetry} />
                    <Group label="Cannot be walked back" items={lens.unrecoverable}
                        render={(x) => <>{x.option ? <span className="text-bah-strong">{x.option}: </span> : null}{x.what}</>} />
                    <Group label="Can be undone" items={lens.recoverable}
                        render={(x) => <>{x.option ? <span className="text-bah-strong">{x.option}: </span> : null}{x.what}</>} />
                    <Line label="The smallest reversible step" text={lens.smallest_reversible_step} />
                </>
            )}
            {id === 'eisenhower' && (
                <>
                    <Group label="Compounds if started now" items={lens.compounds}
                        render={(x) => <><span className="text-bah-strong">{x.label}</span>{x.why ? ` — ${x.why}` : ''}</>} />
                    <Group label="Buys time without compounding" items={lens.buys_time}
                        render={(x) => <><span className="text-bah-strong">{x.label}</span>{x.why ? ` — ${x.why}` : ''}</>} />
                    <Group label="Can wait" items={lens.defer}
                        render={(x) => <><span className="text-bah-strong">{x.label}</span>{x.why ? ` — ${x.why}` : ''}</>} />
                </>
            )}
            {id === 'satisficing' && (
                <>
                    <Line label="Good enough looks like" text={lens.bar} />
                    <Group label="Already clears it" items={lens.clears_bar}
                        render={(x) => <><span className="text-bah-strong">{x.option}</span>{x.why ? ` — ${x.why}` : ''}</>} />
                    <Line label="What waiting costs" text={lens.cost_of_waiting} />
                </>
            )}
        </section>
    );
}
