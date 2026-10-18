import React from 'react';
import { Box, Building2, ExternalLink, Play, Archive } from 'lucide-react';

/**
 * One target.
 *
 * Chrome, not Bahirjee's voice — so it speaks about the product in the third person and
 * never claims anything the data does not carry. A target with no run says "not read
 * yet" rather than inventing a date.
 */
export default function TargetCard({
    target,
    onRun,
    onOpenBrief,
    onArchive,
    isRunning = false,
}) {
    const isCompany = target.type === 'company';
    const Icon = isCompany ? Building2 : Box;
    const url = target.sources?.canonicalUrl || null;
    const isDraft = target.status === 'draft';
    const draftReasonId = `target-draft-reason-${target.id}`;

    return (
        <div className="bah-panel bah-card-hover p-4">
            <div className="flex items-start gap-3">
                <Icon className="w-4 h-4 mt-0.5 text-bah-muted shrink-0" aria-hidden="true" />

                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-sm font-medium text-bah truncate">{target.name}</h3>
                        <span className="bah-tag text-[10px] uppercase tracking-wide">
                            {isCompany ? 'Company' : 'Product'}
                        </span>
                        {isDraft && (
                            <span id={draftReasonId} className="bah-tag text-[10px] uppercase tracking-wide">
                                Setup unfinished
                            </span>
                        )}
                    </div>

                    {url && (
                        <a
                            href={url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="text-xs text-bah-muted hover:text-bah-accent inline-flex items-center gap-1 mt-0.5"
                        >
                            {url.replace(/^https?:\/\//, '').slice(0, 48)}
                            <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        </a>
                    )}

                    <div className="flex items-center gap-2 flex-wrap mt-3">
                        <button
                            type="button"
                            onClick={() => onRun?.(target)}
                            disabled={isRunning || isDraft}
                            aria-describedby={isDraft ? draftReasonId : undefined}
                            className="bah-button-secondary text-xs px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-50"
                        >
                            <Play className="w-3.5 h-3.5" aria-hidden="true" />
                            {isRunning ? 'Reading…' : 'Run intelligence'}
                        </button>

                        {onOpenBrief && (
                            <button
                                type="button"
                                onClick={() => onOpenBrief(target)}
                                className="bah-button-ghost text-xs px-3 py-1.5"
                            >
                                Latest brief
                            </button>
                        )}

                        {!isCompany && onArchive && (
                            <button
                                type="button"
                                onClick={() => onArchive(target)}
                                className="bah-button-ghost text-xs px-3 py-1.5 flex items-center gap-1.5"
                                aria-label={`Archive ${target.name}`}
                            >
                                <Archive className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
