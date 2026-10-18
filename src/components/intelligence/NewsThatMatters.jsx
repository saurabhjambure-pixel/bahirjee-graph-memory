import React from 'react';
import { ExternalLink, Newspaper } from 'lucide-react';

// How exposed the company is to the development, from the exposure formula (relevanceBand
// in newsScorer.js). Badge colour is a fill, never the only carrier: the label says it too.
const BANDS = {
    high: { label: 'High exposure', className: 'bah-badge-accent' },
    medium: { label: 'Medium exposure', className: 'bah-badge-cyan' },
    low: { label: 'Low exposure', className: 'bah-tag' },
};

// Source URLs come from the open web. Only http(s) may become a link — a `javascript:` URL
// in a saved report must render as text, never as something a founder can click.
const safeHref = (url) => (typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null);

/**
 * "News that matters" — the ranked news items saved with the report (reports.news_items,
 * v28). Headlines are the sources' own words; nothing in this section is generated.
 */
export default function NewsThatMatters({ items = [] }) {
    const list = Array.isArray(items) ? items : [];

    return (
        <section className="mb-10" aria-labelledby="news-that-matters">
            <h3
                id="news-that-matters"
                className="text-sm font-bold uppercase tracking-widest text-bah-muted mb-4 flex items-center gap-2"
            >
                <Newspaper className="w-4 h-4" aria-hidden="true" /> News that matters
            </h3>

            {list.length === 0 ? (
                <div className="bah-panel rounded-[var(--bah-radius-lg)] border border-bah p-6 text-sm text-bah-muted">
                    Nothing this run moved a tracked competitor, dependency or regulator enough to list here.
                </div>
            ) : (
                <ul className="space-y-3">
                    {list.map((item, i) => {
                        const href = safeHref(item.source_url);
                        const band = BANDS[item.relevance] || BANDS.low;
                        const meta = [item.source, item.linked_entity, item.domain].filter(Boolean);
                        return (
                            <li
                                key={`${item.source_url || item.headline}-${i}`}
                                className="bah-panel rounded-[var(--bah-radius-lg)] border border-bah p-4"
                            >
                                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                                    <p className="text-sm font-medium text-bah-strong leading-snug min-w-0 break-words">
                                        {href ? (
                                            <a
                                                href={href}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="hover:underline inline-flex items-start gap-1"
                                            >
                                                <span>{item.headline}</span>
                                                <ExternalLink className="w-3.5 h-3.5 mt-0.5 shrink-0 text-bah-muted" aria-hidden="true" />
                                                <span className="sr-only">(opens in a new tab)</span>
                                            </a>
                                        ) : item.headline}
                                    </p>
                                    <span className={`${band.className} shrink-0 self-start`}>{band.label}</span>
                                </div>
                                {meta.length > 0 && (
                                    <p className="mt-2 text-xs text-bah-muted break-words">{meta.join(' · ')}</p>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
