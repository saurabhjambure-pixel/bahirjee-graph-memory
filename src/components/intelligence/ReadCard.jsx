import React, { useState } from 'react';
import { ChevronDown, ExternalLink, ThumbsDown, ThumbsUp } from 'lucide-react';

/**
 * One Read — the new unit of value.
 *
 * A Read is ONE dated thing Bahirjee noticed: what moved, what it means for you, and what
 * it does not settle. It replaces "a fifteen-minute run produces one large report" as the
 * thing a founder receives day to day.
 *
 * ── Voice ────────────────────────────────────────────────────────────────────
 * A Read is Bahirjee talking, so the body is FIRST person, like the letter. Only the
 * chrome around it (dates, source counts, the buttons) speaks about Bahirjee in the third.
 *
 * ── Uncertainty is presence, not a disclaimer ────────────────────────────────
 * "What this doesn't settle" is rendered at the same weight as the read itself, not shrunk
 * into a footnote. The same discipline as letterService.confidenceNextStep: every
 * confidence level resolves to a sentence about what Bahirjee is DOING about it.
 *
 * ── A gap beats a guess ──────────────────────────────────────────────────────
 * Every optional line is omitted when it does not resolve, never filled with a placeholder
 * or an em dash. A Read that gets the founder's own business wrong is worse than a shorter
 * Read (recognition.js).
 */

const CONFIDENCE_NOTE = {
    // Not a hedge — a statement of what happens next. Mirrors the letter's framing.
    Low: 'Only one source so far. I am looking for a second.',
    Medium: 'More than one source agrees. I am watching for anything that weakens it.',
    High: 'Several independent sources agree.',
};

export default function ReadCard({ read, onFeedback, feedbackGiven = null, index = 0 }) {
    const [expanded, setExpanded] = useState(false);
    if (!read) return null;

    const evidence = Array.isArray(read.evidence) ? read.evidence : [];
    const when = read.createdAt
        ? new Date(read.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : null;

    return (
        <article
            className="bah-panel bah-card-hover p-4 bah-signal-enter"
            style={{ '--bah-stagger': `${Math.min(index, 8) * 60}ms` }}
        >
            <header className="flex items-start justify-between gap-3 mb-2">
                <h3 className="font-display text-sm font-semibold text-bah-strong leading-snug">
                    {read.headline}
                </h3>
                {when && (
                    <time
                        className="text-[10px] uppercase tracking-widest text-bah-muted-2 font-num shrink-0 pt-0.5"
                        dateTime={read.createdAt}
                    >
                        {when}
                    </time>
                )}
            </header>

            {/* The fact, always. A Read without one is an opinion — createRead refuses it. */}
            <p className="text-sm text-bah leading-relaxed">{read.whatMoved}</p>

            {read.whatItMeans && (
                <p className="text-sm text-bah-muted leading-relaxed mt-2">{read.whatItMeans}</p>
            )}

            {read.whatItDoesNotSettle && (
                <div className="mt-3 pl-3 border-l-2 border-[var(--bah-accent)]/30">
                    <p className="text-[10px] uppercase tracking-widest text-bah-muted-2 mb-1">
                        What this doesn't settle
                    </p>
                    <p className="text-sm text-bah-muted leading-relaxed">
                        {read.whatItDoesNotSettle}
                    </p>
                </div>
            )}

            <footer className="flex items-center justify-between gap-3 flex-wrap mt-3 pt-3 border-t border-bah">
                <div className="flex items-center gap-3 text-xs text-bah-muted-2 min-w-0">
                    {read.confidence && (
                        <span title={CONFIDENCE_NOTE[read.confidence] || ''}>
                            {read.confidence} confidence
                        </span>
                    )}
                    {evidence.length > 0 && (
                        <button
                            type="button"
                            onClick={() => setExpanded(v => !v)}
                            aria-expanded={expanded}
                            className="flex items-center gap-1 hover:text-bah-strong transition-colors"
                        >
                            <span className="font-num">{evidence.length}</span>
                            {evidence.length === 1 ? 'source' : 'sources'}
                            <ChevronDown
                                className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
                                aria-hidden="true"
                            />
                        </button>
                    )}
                </div>

                {/* Feedback is the loop. This does not merely tune wording in a prompt — it
                    moves the priority of the Agenda question this Read served, and three
                    "not relevant" with nothing ever useful retires it. */}
                {onFeedback && (
                    <div className="flex items-center gap-1 shrink-0">
                        {feedbackGiven ? (
                            <span className="text-xs text-bah-muted-2">
                                {feedbackGiven === 'useful' ? 'Noted — more like this.' : 'Noted — less like this.'}
                            </span>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    onClick={() => onFeedback(read, 'useful')}
                                    aria-label="Useful"
                                    className="p-1.5 rounded-lg text-bah-muted-2 hover:text-bah-accent hover:bg-bah-accent-soft transition-colors"
                                >
                                    <ThumbsUp className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onFeedback(read, 'irrelevant')}
                                    aria-label="Not relevant"
                                    className="p-1.5 rounded-lg text-bah-muted-2 hover:text-bah-strong transition-colors"
                                >
                                    <ThumbsDown className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                            </>
                        )}
                    </div>
                )}
            </footer>

            {expanded && evidence.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                    {evidence.map((e, i) => (
                        <li key={`${e.url}-${i}`}>
                            <a
                                href={e.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1.5 text-xs text-bah-muted hover:text-bah-accent transition-colors break-all"
                            >
                                <ExternalLink className="w-3 h-3 shrink-0" aria-hidden="true" />
                                {e.host || e.url}
                            </a>
                        </li>
                    ))}
                </ul>
            )}
        </article>
    );
}
