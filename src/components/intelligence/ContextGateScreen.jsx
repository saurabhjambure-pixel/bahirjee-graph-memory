/**
 * Context gate — the one decision point before a repeat run.
 *
 * A founder re-running a company we already know used to be interrupted twice: once by
 * the "you have a recent brief" modal, and then again, 20–40 seconds later, by a context
 * review screen showing a context we had just rebuilt from scratch — discarding whatever
 * they had corrected the previous time. Both interruptions ask the same underlying
 * question ("what should this run actually do?"), so they are one screen now.
 *
 * It is deliberately read-only. Field editing lives on ContextReviewScreen, which comes
 * after onboarding; this screen only chooses a path. Everything it offers is reversible
 * except Rebuild, which is why Rebuild is the one behind a confirmation.
 */
import React from 'react';
import {
    Layers, FilePlus2, RefreshCw, ArrowRight, Clock, AlertTriangle, X, Building2, Check,
} from 'lucide-react';

const fmtAge = (days) => {
    if (days === null || days === undefined) return null;
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    const months = Math.round(days / 30);
    return months === 1 ? 'a month ago' : `${months} months ago`;
};

const competitorNames = (context) =>
    (context?.key_competitors || [])
        .map(c => (typeof c === 'object' ? c.name : c))
        .filter(Boolean);

export default function ContextGateScreen({
    context,
    meta,              // { origin, version, source, builtFrom, createdAt }
    staleness,         // describeContextStaleness() output
    recentBrief,       // { report, ageLabel } | null
    mergeReceipt,      // applyContextPatch receipt, after an "add sources" round
    onContinue,
    onAddSources,
    onRebuild,
    onViewRecentBrief,
    onCancel,
    busy = false,
}) {
    const ctx = context || {};
    const competitors = competitorNames(ctx);
    const age = fmtAge(staleness?.ageDays);
    const isFallback = meta?.origin === 'report_fallback';

    const builtFromLabel = () => {
        const from = meta?.builtFrom || {};
        const parts = [];
        if (from.linkedin) parts.push('LinkedIn');
        if (Array.isArray(from.urls) && from.urls.length) {
            parts.push(`${from.urls.length} page${from.urls.length > 1 ? 's' : ''}`);
        }
        if (Array.isArray(from.documents) && from.documents.length) {
            parts.push(`${from.documents.length} document${from.documents.length > 1 ? 's' : ''}`);
        }
        return parts.length ? parts.join(', ') : null;
    };

    const provenance = isFallback
        // Say where it came from. A run output is not the same thing as a context the
        // founder approved, and presenting one as the other is the quiet kind of wrong.
        ? `Recovered from your last brief${age ? `, ${age}` : ''}`
        : `Saved context${meta?.version ? ` · v${meta.version}` : ''}${age ? ` · updated ${age}` : ''}`;

    return (
        <div className="h-dvh bg-bah-bg text-bah font-sans p-3 tall:p-6 flex items-center justify-center">
            <div className="w-full max-w-3xl max-h-full bah-panel-strong p-5 tall:p-8 animate-in zoom-in-95 flex flex-col">

                <div className="flex items-start justify-between gap-4 shrink-0">
                    <div className="flex items-center gap-4">
                        <div className="p-3 bg-bah-accent-soft rounded-xl text-bah-accent">
                            <Layers className="w-7 h-7" />
                        </div>
                        <div>
                            <h2 className="text-2xl font-light text-bah-strong font-display">
                                We already know this company
                            </h2>
                            <p className="text-bah-muted text-sm">{provenance}</p>
                        </div>
                    </div>
                    <button
                        onClick={onCancel}
                        aria-label="Cancel and go back"
                        className="text-bah-muted hover:text-bah transition-colors p-1"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar mt-5 tall:mt-6 space-y-4 pr-1">

                    {recentBrief && (
                        <div className="rounded-lg border border-bah bg-bah-cyan-soft/30 p-4 flex items-center justify-between gap-4 flex-wrap">
                            <div className="flex items-center gap-2 text-sm">
                                <Clock className="w-4 h-4 text-bah-cyan shrink-0" />
                                <span className="text-bah">
                                    You already have a brief for this company from{' '}
                                    <span className="font-num text-bah-strong">{recentBrief.ageLabel}</span>.
                                </span>
                            </div>
                            <button onClick={onViewRecentBrief} className="bah-button-secondary text-xs px-3 py-1.5">
                                View it
                            </button>
                        </div>
                    )}

                    {staleness?.anchorsAreFallback && (
                        <div className="rounded-lg border border-[var(--bah-warning)]/30 bg-bah-panel-soft p-4 flex gap-3">
                            <AlertTriangle className="w-4 h-4 text-bah-warning shrink-0 mt-0.5" />
                            <p className="text-xs text-bah-muted leading-relaxed">
                                This context's strategic anchors were never confirmed against a real read of
                                the site — they came from a degraded build. The readiness gate will flag it on
                                every run until the context is rebuilt.
                            </p>
                        </div>
                    )}

                    {mergeReceipt && (
                        <div className="rounded-lg border border-[var(--bah-accent)]/30 bg-bah-accent-soft/40 p-4 space-y-2">
                            <div className="flex items-center gap-2 text-sm text-bah-strong">
                                <Check className="w-4 h-4 text-bah-accent shrink-0" />
                                <span>
                                    Read {mergeReceipt.pagesRead} page{mergeReceipt.pagesRead === 1 ? '' : 's'}
                                    {mergeReceipt.docsRead > 0 && ` and ${mergeReceipt.docsRead} document${mergeReceipt.docsRead === 1 ? '' : 's'}`}
                                    {' · '}
                                    <span className="font-num">{mergeReceipt.applied.additions}</span> addition
                                    {mergeReceipt.applied.additions === 1 ? '' : 's'},{' '}
                                    <span className="font-num">{mergeReceipt.applied.updates.length}</span> update
                                    {mergeReceipt.applied.updates.length === 1 ? '' : 's'}
                                </span>
                            </div>
                            {mergeReceipt.summary && (
                                <p className="text-xs text-bah-muted leading-relaxed">{mergeReceipt.summary}</p>
                            )}
                            {/* Say what was refused, and why. A merge that silently overrode a
                                correction would be worse than one that never ran. */}
                            {(mergeReceipt.rejected.updates.length > 0 || mergeReceipt.rejected.additions.length > 0) && (
                                <ul className="space-y-1 pt-1">
                                    {mergeReceipt.rejected.updates.map((r, i) => (
                                        <li key={`u${i}`} className="text-[11px] text-bah-muted">
                                            Skipped <span className="text-bah">{r.field}</span> — {r.reason}.
                                        </li>
                                    ))}
                                    {mergeReceipt.rejected.additions.map((r, i) => (
                                        <li key={`a${i}`} className="text-[11px] text-bah-muted">
                                            Did not re-add <span className="text-bah">{r.name}</span> — {r.reason}.
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {mergeReceipt.conflicts.length > 0 && (
                                <p className="text-[11px] text-bah-warning">
                                    {mergeReceipt.conflicts.length} conflict{mergeReceipt.conflicts.length === 1 ? '' : 's'} with
                                    what you had — review the fields below before running.
                                </p>
                            )}
                        </div>
                    )}

                    <div className="rounded-xl border border-bah bg-bah-bg p-4 space-y-3">
                        <div className="flex items-center gap-2">
                            <Building2 className="w-4 h-4 text-bah-accent" />
                            <span className="text-sm font-medium text-bah-strong">
                                {ctx.company_name || 'This company'}
                            </span>
                            {ctx.industry && <span className="bah-tag">{ctx.industry}</span>}
                            {ctx.operating_geography && <span className="bah-tag">{ctx.operating_geography}</span>}
                        </div>

                        {competitors.length > 0 && (
                            <div>
                                <div className="text-[10px] font-bold uppercase tracking-widest text-bah-muted mb-1.5">
                                    Competitors on file
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    {competitors.slice(0, 10).map((name, i) => (
                                        <span key={i} className="bah-badge-accent text-xs">{name}</span>
                                    ))}
                                    {competitors.length > 10 && (
                                        <span className="text-xs text-bah-muted self-center">
                                            +{competitors.length - 10} more
                                        </span>
                                    )}
                                </div>
                            </div>
                        )}

                        {builtFromLabel() && (
                            <p className="text-xs text-bah-muted">Built from {builtFromLabel()}.</p>
                        )}
                    </div>

                    {staleness?.staleFields?.length > 0 && (
                        <div className="rounded-lg border border-bah bg-bah-panel-soft p-4">
                            <div className="text-[10px] font-bold uppercase tracking-widest text-bah-muted mb-2">
                                Carried forward{age ? ` from ${age}` : ''} — not re-checked
                            </div>
                            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
                                {staleness.staleFields.map((f, i) => (
                                    <div key={i} className="text-xs">
                                        <div className="flex justify-between gap-3">
                                            <span className="text-bah-muted">{f.field}</span>
                                            <span className="text-bah font-num text-right">{f.value}</span>
                                        </div>
                                        {/* Per-fact provenance (v27 follow-up) — when it exists, say exactly when
                                            and from where this was last confirmed instead of only the whole
                                            context's age. Falls back to nothing for a fact with no ledger entry
                                            yet, e.g. a context stored before provenance existed. */}
                                        {f.asOf && (
                                            <div className="text-[10px] text-bah-muted text-right mt-0.5 truncate" title={f.asOf}>
                                                {f.asOf}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                            <p className="text-[11px] text-bah-muted mt-3 leading-relaxed">
                                Add sources or rebuild if any of these have moved. The run itself always
                                searches fresh — this is only what it starts from.
                            </p>
                        </div>
                    )}
                </div>

                <div className="shrink-0 pt-5 mt-1 border-t border-bah flex flex-wrap items-center gap-3">
                    <button
                        onClick={onContinue}
                        disabled={busy}
                        className="bah-button-primary px-6 py-3 rounded-lg flex items-center gap-2 text-sm"
                    >
                        Continue with this context <ArrowRight className="w-4 h-4" />
                    </button>
                    {onAddSources && (
                        <button
                            onClick={onAddSources}
                            disabled={busy}
                            className="bah-button-secondary px-4 py-3 rounded-lg flex items-center gap-2 text-sm"
                        >
                            <FilePlus2 className="w-4 h-4" /> Add sources
                        </button>
                    )}
                    {/* Always reachable, never hidden behind the fallback case: for a founder
                        whose URL is locked to their profile, this is the only way out of a
                        context that is simply wrong. */}
                    <button
                        onClick={onRebuild}
                        disabled={busy}
                        className="bah-button-ghost px-4 py-3 rounded-lg flex items-center gap-2 text-sm ml-auto"
                    >
                        <RefreshCw className="w-4 h-4" /> Rebuild from scratch
                    </button>
                </div>
            </div>
        </div>
    );
}
