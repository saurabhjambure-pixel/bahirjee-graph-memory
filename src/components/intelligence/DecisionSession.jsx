import React, { useState } from 'react';
import { ArrowLeft, Plus, X } from 'lucide-react';
import DecisionJudgmentView from './DecisionJudgmentView';
import { questionsFor, routeFramework, missingAnswers } from '../../services/decisionFrameworks';

/**
 * "Help me decide."
 *
 * Four steps, and the shape of them is the argument:
 *
 *   FRAME     you say what you are deciding, in your own words
 *   CONFIRM   Bahirjee shows back the options it heard — and never invents one
 *   ASK       three or four questions, each one something it genuinely cannot look up
 *   JUDGE     it goes and finds the rest itself, then shows its working
 *
 * ── Why the questions are so few ─────────────────────────────────────────────
 * Every question here is one the router branches on: reversibility, worst case, cost of
 * delay, whether the options are either/or. Those four facts choose the lens. Anything
 * researchable — what a rival charges, what the regulator said — is Bahirjee's job, and
 * asking a founder for it would waste the one thing only they can give.
 *
 * The screen says so out loud, because "I can find out X; what I can't know is Y" is the
 * sentence that makes this feel like working with someone rather than filling in a form.
 *
 * ── Options are never invented ───────────────────────────────────────────────
 * `inferOptions` returns [] rather than guessing, and this screen keeps that promise: if
 * Bahirjee heard no options it says so and asks, instead of showing back a plausible list
 * the founder never said. A fabricated option would then be scored, weighed and ranked —
 * carrying a hallucination all the way into a board meeting.
 */
export default function DecisionSession({
    initialText = '',
    frame: framedDecision = null,
    judgment = null,
    chosenOptionId = null,
    busy = false,
    statusText = '',
    error = null,
    onFrame,
    onConfirmFrame,
    onSubmitAnswers,
    onRecordChoice,
    onAsk,
    askAnswer = null,
    isAsking = false,
    onBack,
}) {
    const [text, setText] = useState(initialText);
    const [options, setOptions] = useState(null);
    const [draftOption, setDraftOption] = useState('');
    const [answers, setAnswers] = useState({});

    // The frame Bahirjee built, with any edits the founder has made to its options.
    const frame = framedDecision && options
        ? { ...framedDecision, options }
        : framedDecision;

    const step = judgment ? 'judge'
        : frame && Object.keys(answers).length > 0 ? 'ask'
            : frame ? 'confirm'
                : 'frame';

    const questions = frame ? questionsFor(frame) : [];
    const outstanding = missingAnswers(answers).filter(id => questions.some(q => q.id === id));
    // Shown live so the founder can see the lens settle as they answer, rather than having
    // a method announced at them once it is too late to query it.
    const preview = frame && Object.keys(answers).length ? routeFramework(frame, answers) : null;

    const addOption = () => {
        const label = draftOption.trim();
        if (!label) return;
        const base = options || framedDecision?.options || [];
        setOptions([...base, { id: `opt_${base.length}_${Date.now()}`, label }]);
        setDraftOption('');
    };

    return (
        <div className="min-h-dvh">
            <header className="flex items-center gap-3 px-4 py-3 border-b border-bah">
                {onBack && (
                    <button type="button" onClick={onBack} className="text-bah-muted hover:text-bah-strong transition-colors" aria-label="Back">
                        <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                    </button>
                )}
                <h1 className="font-display text-sm font-semibold text-bah-strong">Help me decide</h1>
                {statusText && <span className="text-xs text-bah-muted ml-auto">{statusText}</span>}
            </header>

            <main className="w-full max-w-3xl mx-auto px-4 py-6 space-y-5">
                {error && (
                    <p className="bah-panel p-3 text-sm text-bah-warning" role="status">{error}</p>
                )}

                {/* ── 1. FRAME ──────────────────────────────────────────────── */}
                {step === 'frame' && (
                    <section className="bah-panel p-4">
                        <label htmlFor="decision-text" className="block text-sm text-bah-strong mb-1">
                            What are you deciding?
                        </label>
                        <p className="text-xs text-bah-muted-2 mb-3">
                            In your own words. If you already know the options, name them — Bahirjee will not invent any you did not say.
                        </p>
                        <textarea
                            id="decision-text"
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            rows={4}
                            placeholder="Whether to put the next two quarters into an enterprise sales motion, or double down on self-serve."
                            className="bah-input w-full text-sm resize-none"
                        />
                        <button
                            type="button"
                            onClick={() => onFrame?.(text.trim())}
                            disabled={text.trim().length < 12 || busy}
                            className="bah-button-primary text-xs px-3 py-1.5 mt-3 disabled:opacity-50"
                        >
                            {busy ? 'Reading…' : 'Start'}
                        </button>
                    </section>
                )}

                {/* ── 2. CONFIRM ────────────────────────────────────────────── */}
                {step === 'confirm' && (
                    <section className="bah-panel p-4">
                        <p className="text-[10px] uppercase tracking-widest text-bah-muted mb-1.5">What I heard</p>
                        <p className="text-base text-bah-strong font-display leading-relaxed">
                            {frame.decision_statement || frame.raw_input}
                        </p>
                        {frame.objective && (
                            <p className="text-sm text-bah-muted mt-1.5">Objective: {frame.objective}</p>
                        )}

                        <div className="mt-4">
                            <p className="text-[10px] uppercase tracking-widest text-bah-muted mb-2">
                                The options {(frame.options?.length || 0) > 0 ? 'you named' : ''}
                            </p>
                            {(frame.options?.length || 0) === 0 ? (
                                // Never fabricated. A guessed option would be scored, weighed
                                // and ranked, carrying a hallucination into a board meeting.
                                <p className="text-sm text-bah-muted-2 mb-2">
                                    I did not hear any distinct options. Add them, or continue and I will work on widening what is on the table.
                                </p>
                            ) : (
                                <ul className="space-y-1.5 mb-2">
                                    {frame.options.map(o => (
                                        <li key={o.id} className="flex items-start gap-2 group">
                                            <span className="w-1.5 h-1.5 rounded-full bg-bah-accent shrink-0 mt-1.5" aria-hidden="true" />
                                            <span className="text-sm text-bah flex-1">{o.label}</span>
                                            <button
                                                type="button"
                                                onClick={() => setOptions((options || frame.options).filter(x => x.id !== o.id))}
                                                aria-label={`Remove ${o.label}`}
                                                className="p-1 rounded text-bah-muted-2 hover:text-bah-strong opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
                                            >
                                                <X className="w-3.5 h-3.5" aria-hidden="true" />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}

                            <div className="flex gap-2">
                                <input
                                    value={draftOption}
                                    onChange={(e) => setDraftOption(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOption(); } }}
                                    placeholder="Add an option"
                                    className="bah-input flex-1 text-sm"
                                    aria-label="Add an option"
                                />
                                <button type="button" onClick={addOption} disabled={!draftOption.trim()} className="bah-button-ghost text-xs px-3 disabled:opacity-50">
                                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                            </div>
                        </div>

                        <button
                            type="button"
                            onClick={() => { onConfirmFrame?.(frame); setAnswers({ __started: true }); }}
                            disabled={busy}
                            className="bah-button-primary text-xs px-3 py-1.5 mt-4"
                        >
                            That's it — ask me your questions
                        </button>
                    </section>
                )}

                {/* ── 3. ASK ────────────────────────────────────────────────── */}
                {step === 'ask' && (
                    <>
                        <section className="bah-panel p-4">
                            <p className="text-sm text-bah leading-relaxed">
                                {/* First person: this is Bahirjee talking, and it is the line
                                    that makes the division of labour honest. */}
                                I can look up what your competitors charge and what the market is doing. What I can't know is
                                how this sits with you — so there are {questions.length} things I need from you, and then I'll go to work.
                            </p>
                        </section>

                        {questions.map(q => (
                            <section key={q.id} className="bah-panel p-4">
                                <p className="text-sm text-bah-strong">{q.question}</p>
                                <p className="text-xs text-bah-muted-2 mt-0.5 mb-3">{q.why}</p>
                                <div className="flex flex-wrap gap-2">
                                    {q.options.map(o => {
                                        const selected = answers[q.id] === o.value;
                                        return (
                                            <button
                                                key={String(o.value)}
                                                type="button"
                                                onClick={() => setAnswers(a => ({ ...a, [q.id]: o.value }))}
                                                aria-pressed={selected}
                                                className={selected
                                                    ? 'bah-button-primary text-xs px-3 py-1.5'
                                                    : 'bah-button-secondary text-xs px-3 py-1.5'}
                                            >
                                                {o.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </section>
                        ))}

                        {preview && outstanding.length === 0 && (
                            <section className="bah-panel-strong p-4">
                                <p className="text-[10px] uppercase tracking-widest text-bah-muted mb-1.5">How I'll look at this</p>
                                <p className="text-sm text-bah-strong">{preview.framework.name}</p>
                                <p className="text-sm text-bah-muted leading-relaxed mt-1">{preview.why}</p>
                            </section>
                        )}

                        <button
                            type="button"
                            onClick={() => onSubmitAnswers?.(answers, routeFramework(frame, answers))}
                            disabled={outstanding.length > 0 || busy}
                            className="bah-button-primary text-xs px-3 py-1.5 disabled:opacity-50"
                        >
                            {busy ? (statusText || 'Working…') : 'Go and find the rest'}
                        </button>
                        {outstanding.length > 0 && (
                            <p className="text-xs text-bah-muted-2">
                                {outstanding.length} still to answer.
                            </p>
                        )}
                    </>
                )}

                {/* ── 4. JUDGE ──────────────────────────────────────────────── */}
                {step === 'judge' && (
                    <DecisionJudgmentView
                        judgment={judgment}
                        frame={frame}
                        chosenOptionId={chosenOptionId}
                        onRecordChoice={onRecordChoice}
                        onAsk={onAsk}
                        askAnswer={askAnswer}
                        isAsking={isAsking}
                    />
                )}
            </main>
        </div>
    );
}
