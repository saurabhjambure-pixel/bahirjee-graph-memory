import React, { useState } from 'react';
import { Pin, Plus, X } from 'lucide-react';
import { AGENDA_DISPLAY_LIMIT, rankAgenda } from '../../services/agendaService';

/**
 * "What I'm trying to find out for you."
 *
 * THIS IS THE STEERING SURFACE. An autonomous agent that cannot be redirected is a
 * scheduled job with better copy; a chat box is redirection without a memory. The Agenda
 * is the middle: a short, standing list of open questions the founder can read, add to,
 * push up, or retire — and every one of those actions changes what tomorrow's loop
 * actually spends on, not merely how the output is worded.
 *
 * ── Why retiring has to work ─────────────────────────────────────────────────
 * tracked_entities is the cautionary tale: append-only, `is_active` never written false,
 * priority hardcoded. A competitor the founder deleted on the review screen is still being
 * watched months later. So retire here is real — agendaService refuses to re-open a
 * retired question even when the weekly run regenerates the same falsifier.
 *
 * ── Voice ────────────────────────────────────────────────────────────────────
 * The heading is Bahirjee speaking, so it is first person, matching a Read and the letter.
 * The controls around it are chrome.
 *
 * ── A short list on purpose ──────────────────────────────────────────────────
 * Capped at AGENDA_DISPLAY_LIMIT. A backlog of forty is not an agenda, it is a to-do list
 * nobody reads — and the ranking means the cut always falls at the bottom.
 */
export default function AgendaPanel({
    items = [],
    onAdd,
    onRetire,
    onPin,
    busy = false,
}) {
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState('');

    const ranked = rankAgenda(items);
    const shown = ranked.slice(0, AGENDA_DISPLAY_LIMIT);
    const hidden = ranked.length - shown.length;

    const submit = (e) => {
        e.preventDefault();
        const text = draft.trim();
        if (!text || !onAdd) return;
        onAdd(text);
        setDraft('');
        setAdding(false);
    };

    return (
        <section className="bah-panel p-4" aria-labelledby="agenda-heading">
            <div className="flex items-center justify-between gap-3 mb-3">
                <h2 id="agenda-heading" className="font-display text-sm font-semibold text-bah-strong">
                    What I'm trying to find out for you
                </h2>
                {onAdd && !adding && (
                    <button
                        type="button"
                        onClick={() => setAdding(true)}
                        className="flex items-center gap-1 text-xs text-bah-muted hover:text-bah-accent transition-colors shrink-0"
                    >
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                        Add
                    </button>
                )}
            </div>

            {adding && (
                <form onSubmit={submit} className="mb-3">
                    <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Escape') { setAdding(false); setDraft(''); } }}
                        placeholder="What do you want me watching?"
                        className="bah-input w-full text-sm"
                        aria-label="A question for Bahirjee to watch"
                    />
                    <div className="flex items-center gap-2 mt-2">
                        <button type="submit" disabled={!draft.trim() || busy} className="bah-button-primary text-xs px-3 py-1.5 disabled:opacity-50">
                            Watch this
                        </button>
                        <button
                            type="button"
                            onClick={() => { setAdding(false); setDraft(''); }}
                            className="bah-button-ghost text-xs px-3 py-1.5"
                        >
                            Cancel
                        </button>
                    </div>
                </form>
            )}

            {shown.length === 0 ? (
                // An empty agenda is a real state, not a failure — a company Bahirjee has
                // not read yet genuinely has nothing open. Say that, rather than inventing
                // a placeholder question.
                <p className="text-sm text-bah-muted-2">
                    Nothing open yet. After the next full read I'll have questions of my own.
                </p>
            ) : (
                <ul className="space-y-2.5">
                    {shown.map((item) => (
                        <li key={item.id} className="group flex items-start gap-2">
                            <span
                                className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${item.pinned ? 'bg-bah-accent' : 'bg-bah-muted-2'}`}
                                aria-hidden="true"
                            />
                            <div className="min-w-0 flex-1">
                                <p className="text-sm text-bah leading-snug">{item.question}</p>
                                {/* watch_for is the concrete observable the brief already
                                    wrote for a founder to read. Shown verbatim — paraphrasing
                                    it here would lose the wording that made it checkable. */}
                                {item.watchFor && (
                                    <p className="text-xs text-bah-muted-2 mt-0.5">
                                        Watching: {item.watchFor}
                                    </p>
                                )}
                            </div>

                            {/* Always visible on touch: there is no hover on a phone, so a hover-reveal
                                control is simply unreachable there. Revealed on hover only from
                                `md` up, where a pointer exists. */}
                            <div className="flex items-center gap-0.5 shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                                {onPin && (
                                    <button
                                        type="button"
                                        onClick={() => onPin(item, !item.pinned)}
                                        aria-label={item.pinned ? 'Unpin' : 'Push this up'}
                                        aria-pressed={item.pinned}
                                        className={`p-1.5 rounded-lg transition-colors ${item.pinned ? 'text-bah-accent' : 'text-bah-muted-2 hover:text-bah-strong'}`}
                                    >
                                        <Pin className="w-3.5 h-3.5" aria-hidden="true" />
                                    </button>
                                )}
                                {onRetire && (
                                    <button
                                        type="button"
                                        onClick={() => onRetire(item)}
                                        aria-label="Stop watching this"
                                        className="p-1.5 rounded-lg text-bah-muted-2 hover:text-bah-strong transition-colors"
                                    >
                                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                                    </button>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            {hidden > 0 && (
                <p className="text-xs text-bah-muted-2 mt-3">
                    {hidden} more, lower down the list.
                </p>
            )}
        </section>
    );
}
