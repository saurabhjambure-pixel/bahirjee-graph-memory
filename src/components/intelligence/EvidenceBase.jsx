import React from 'react';
import { Layers } from 'lucide-react';
import { SOURCE_CLASSES, SOURCE_CLASS_LABELS_PLURAL } from '../../services/sourceClass';

/**
 * Evidence Base — what KINDS of source this brief is built on.
 *
 * The point of the source expansion was never volume; it was that a brief drawn only
 * from press coverage is a weaker brief than one that also read a regulatory filing, a
 * live tender and a competitor's own pricing page. That difference was invisible: every
 * signal rendered identically no matter where it came from, so a founder had no way to
 * tell a strong run from a thin one.
 *
 * Counts are computed from the signals themselves rather than a stored metric, so this
 * also works on briefs saved before provenance existed — they simply show nothing.
 *
 * Unclassified signals are deliberately NOT shown as a category. Untiered general search
 * carries no class by design, and inventing a "General" bucket would imply we know
 * something about those sources that we do not.
 */

// Ordered strongest-provenance first. A filing is a legally binding disclosure; a blog
// post is someone's opinion. Showing them in this order is itself information — which is
// why the order lives with the taxonomy in `sourceClass.js` rather than being re-stated
// here, where it could drift out of step with the chips on each signal card.
const CLASS_LABELS = SOURCE_CLASSES.map(key => [key, SOURCE_CLASS_LABELS_PLURAL[key]]);

export default function EvidenceBase({ signals }) {
    if (!Array.isArray(signals) || signals.length === 0) return null;

    const counts = signals.reduce((acc, s) => {
        if (!s?.source_class) return acc;
        acc[s.source_class] = (acc[s.source_class] || 0) + 1;
        return acc;
    }, {});

    const present = CLASS_LABELS.filter(([key]) => counts[key] > 0);
    // Nothing classified — a pre-provenance brief, or a run that was all general search.
    // Showing an empty strip would read as a defect rather than an absence of data.
    if (present.length === 0) return null;

    const classified = present.reduce((n, [key]) => n + counts[key], 0);

    return (
        <div className="rounded-xl border border-bah bg-bah-panel/40 p-4">
            <div className="flex items-center gap-2 mb-3">
                <Layers className="w-3.5 h-3.5 text-bah-accent" />
                <span className="text-[10px] uppercase tracking-widest text-bah-muted">
                    Evidence base
                </span>
                <span className="text-[10px] text-bah-muted-2">
                    {classified} of {signals.length} signal{signals.length === 1 ? '' : 's'} traced to a source type
                </span>
            </div>
            <div className="flex flex-wrap gap-2">
                {present.map(([key, label]) => (
                    <span
                        key={key}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-bah bg-bah-panel px-2.5 py-1"
                    >
                        <span className="text-xs text-bah">{label}</span>
                        <span className="text-xs font-medium text-bah-accent tabular-nums">{counts[key]}</span>
                    </span>
                ))}
            </div>
            {present.length === 1 && (
                <p className="mt-3 text-[11px] text-bah-muted">
                    All classified evidence is one source type. A brief drawn from a single kind of
                    source sees the market from one angle.
                </p>
            )}
        </div>
    );
}
