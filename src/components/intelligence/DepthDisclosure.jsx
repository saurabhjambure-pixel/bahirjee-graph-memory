import React, { useEffect } from 'react';
import { Layers, Sparkles } from 'lucide-react';
import { trackConversionClick } from '../../services/interactionService';

/**
 * How much research this brief rests on — and, on a shallow run, what a full one would
 * have resolved.
 *
 * This IS the paywall. The product argument is that Bahirjee is honest about the limits
 * of its own evidence, so the upgrade case is made by stating the gap plainly rather than
 * by blurring conclusions the user has already been shown. Two consequences for this
 * component:
 *
 *   1. It renders for BOTH tiers. A paid reader sees the same panel with no gaps and no
 *      CTA, which is what makes the free version read as disclosure rather than as a
 *      nag — both tiers are visibly the same product at different depths.
 *   2. It belongs next to the brief's own confidence, not in a sidebar. The gap explains
 *      the confidence; separating them turns an argument into an advertisement.
 *
 * ⚠️  This is deliberately NOT the degradation banner. A degradation means the run tried
 *     and failed and the brief is partial. A shallow run is the product working correctly.
 */
export default function DepthDisclosure({ runTier = 'full', depthGaps = [], reportId, userId, onUpgrade }) {
    const isShallow = runTier === 'shallow';
    const gaps = Array.isArray(depthGaps) ? depthGaps : [];

    // The only conversion telemetry in the product. The section-index paywall it replaces
    // had its tracking suppressed by a temporary unlock flag, so there is currently no
    // conversion data at all — firing here is what makes the paywall measurable.
    useEffect(() => {
        if (isShallow && reportId && userId) {
            trackConversionClick(reportId, userId, 'depth_disclosure')?.catch?.(() => {});
        }
    }, [isShallow, reportId, userId]);

    if (!isShallow) {
        return (
            <div className="rounded-xl border border-bah bg-bah-panel/40 p-4 flex items-center gap-2">
                <Layers className="w-3.5 h-3.5 text-bah-accent shrink-0" />
                <span className="text-[10px] uppercase tracking-widest text-bah-muted">Research depth</span>
                <span className="text-[11px] text-bah-muted-2">Full scan — every source tier, primary-source checks and structured sources.</span>
            </div>
        );
    }

    return (
        <div className="rounded-xl border border-[var(--bah-cyan)]/25 bg-bah-cyan-soft/20 p-4">
            <div className="flex items-center gap-2 mb-2">
                <Layers className="w-3.5 h-3.5 text-bah-cyan shrink-0" />
                <span className="text-[10px] uppercase tracking-widest text-bah-cyan">Research depth — shallow scan</span>
            </div>
            <p className="text-[11px] text-bah-muted leading-relaxed">
                This brief is complete, but it rests on a deliberately thin evidence base. That is
                why its confidence is capped. A full run would add:
            </p>
            {gaps.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                    {gaps.map((gap, i) => (
                        <li key={i} className="text-[11px] text-bah leading-relaxed flex gap-2">
                            <span className="text-bah-cyan shrink-0">•</span>
                            <span>{gap}</span>
                        </li>
                    ))}
                </ul>
            )}
            {onUpgrade && (
                <button
                    onClick={() => onUpgrade('depth_disclosure')}
                    className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-bah-cyan hover:text-bah-strong transition-colors"
                >
                    <Sparkles className="w-3 h-3" />
                    Run this at full depth
                </button>
            )}
        </div>
    );
}
