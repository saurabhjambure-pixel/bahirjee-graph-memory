import React from 'react';
import { Plus } from 'lucide-react';
import TargetCard from './TargetCard';

/**
 * The company anchor, then its products.
 *
 * ⚠️ Selecting a target does NOT scope the Desk in this slice. Reads, the Agenda and the
 * check ledger are keyed on the company's domain, so filtering them by product would show
 * company data under a product heading. The note below says so out loud rather than
 * letting the screen imply something untrue.
 */
export default function TargetList({
    targets = [],
    onRun,
    onOpenBrief,
    onArchive,
    onAddProduct,
    runningTargetId = null,
}) {
    const company = targets.find((t) => t.type === 'company') || null;
    const products = targets.filter((t) => t.type === 'product');

    return (
        <section aria-labelledby="targets-heading">
            <div className="flex items-center justify-between mb-2">
                <h2 id="targets-heading" className="text-[10px] uppercase tracking-widest text-bah-muted">
                    What I'm watching
                </h2>
                {onAddProduct && (
                    <button
                        type="button"
                        onClick={onAddProduct}
                        className="bah-button-ghost text-xs px-2 py-1 flex items-center gap-1"
                    >
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                        Add a product
                    </button>
                )}
            </div>

            <div className="space-y-3">
                {company && (
                    <TargetCard
                        target={company}
                        onRun={onRun}
                        onOpenBrief={onOpenBrief}
                        isRunning={runningTargetId === company.id}
                    />
                )}

                {products.map((p) => (
                    <TargetCard
                        key={p.id}
                        target={p}
                        onRun={onRun}
                        onOpenBrief={onOpenBrief}
                        onArchive={onArchive}
                        isRunning={runningTargetId === p.id}
                    />
                ))}

                {products.length === 0 && (
                    <p className="text-sm text-bah-muted leading-relaxed">
                        Only your company so far. Add a product and I'll watch its category,
                        pricing and rivals separately.
                    </p>
                )}

                {products.length > 0 && (
                    <p className="text-xs text-bah-muted leading-relaxed">
                        Today's read and the agenda below cover your company as a whole, not
                        one product at a time.
                    </p>
                )}
            </div>
        </section>
    );
}
