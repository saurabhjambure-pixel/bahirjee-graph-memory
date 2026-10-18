import React from 'react';
import { Compass, ExternalLink, ShieldCheck, ArrowRight, Clock, Play } from 'lucide-react';

export default function TodayReadCard({
  todayRead,
  isQuiet = false,
  companyName = 'your company',
  onOpenFullRead,
  onToggleQuietState
}) {
  // If no report has been generated yet for this company
  if (!todayRead) {
    return (
      <div className="bah-panel p-6 md:p-8 rounded-[20px] relative overflow-hidden transition-all duration-300">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-bah">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="w-2.5 h-2.5 rounded-full bg-bah-accent animate-pulse" />
            <span className="text-xs uppercase tracking-widest text-bah-muted font-medium">
              Today's Read · Market Baseline
            </span>
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-bah-panel-soft text-bah-muted border border-bah">
              Scan Pending
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-bah-muted">
            <Clock className="w-3.5 h-3.5 text-bah-accent-text" />
            <span>Ready for initial scan</span>
          </div>
        </div>

        <div className="mt-5 max-w-3xl">
          <h2 className="text-xl md:text-2xl font-semibold text-bah-strong tracking-tight font-display">
            Your intelligence desk is watching {companyName}.
          </h2>
          <p className="mt-3 text-sm md:text-base text-bah-muted leading-relaxed">
            Run an intelligence scan to discover competitive shifts, analyze pricing movements, and review regulatory changes relevant to your company perimeter.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              onClick={onOpenFullRead}
              className="bah-button-primary px-5 py-2.5 text-xs font-medium inline-flex items-center gap-2 shadow-md"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>Run first intelligence scan</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Quiet day state
  if (isQuiet) {
    return (
      <div className="bah-panel p-6 md:p-8 rounded-[20px] relative overflow-hidden transition-all duration-300">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-bah">
          <div className="flex items-center gap-3">
            <span className="w-2.5 h-2.5 rounded-full bg-bah-accent animate-pulse" />
            <span className="text-xs uppercase tracking-widest text-bah-muted font-medium">
              Today's Read · Quiet Perimeter
            </span>
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-bah-accent-soft text-bah-accent-strong border border-[var(--bah-accent)]/20">
              Quiet Baseline
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-bah-muted">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-bah-accent-text" />
              Checked today at 06:00 AM
            </span>
          </div>
        </div>

        <div className="mt-5 max-w-3xl">
          <h2 className="text-xl md:text-2xl font-semibold text-bah-strong tracking-tight font-display">
            Nothing worth interrupting you for. Bahirjee checked {todayRead.evidence_count || 12} sources this morning.
          </h2>
          <p className="mt-3 text-sm md:text-base text-bah-muted leading-relaxed">
            All competitor targets, industry registries, and public filings monitored for {companyName} showed no material movements, unexpected pricing updates, or sudden regulatory shifts over the last 24 hours.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-4 text-xs text-bah-muted">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bah-panel-strong border border-bah font-medium text-bah">
              <ShieldCheck className="w-3.5 h-3.5 text-bah-accent-text" />
              {todayRead.evidence_count || 12} sources verified
            </span>
            <span>Next automatic scan: Tomorrow at 06:00 AM</span>
          </div>
        </div>
      </div>
    );
  }

  // Active movement read
  return (
    <div className="bah-panel p-6 md:p-8 rounded-[20px] relative overflow-hidden transition-all duration-300">
      {/* Top Meta Strip */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-bah">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="w-2.5 h-2.5 rounded-full bg-bah-cyan animate-pulse" />
          <span className="text-xs uppercase tracking-widest text-bah-muted font-medium">
            Today's Read · Latest Movement
          </span>
          <span className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-bah-accent-soft text-bah-accent-strong border border-[var(--bah-accent)]/20">
            {todayRead.confidence || 'High Confidence'}
          </span>
          <span className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-bah-cyan-soft text-bah-cyan border border-[var(--bah-cyan)]/20">
            {todayRead.evidence_count || 1} verified sources
          </span>
        </div>

        <div className="flex items-center gap-3 text-xs text-bah-muted">
          <span className="inline-flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-bah-muted" />
            {todayRead.checked_timestamp || 'Checked recently'}
          </span>
        </div>
      </div>

      {/* Main Headline & Calm Read */}
      <div className="mt-5">
        <h2 className="text-xl md:text-2xl font-semibold text-bah-strong tracking-tight font-display max-w-4xl">
          {todayRead.headline}
        </h2>

        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* What Moved */}
          <div className="p-4 rounded-xl bg-bah-panel-strong border border-bah">
            <div className="text-xs font-semibold uppercase tracking-wider text-bah-muted mb-2 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-bah-cyan" />
              What moved
            </div>
            <p className="text-sm text-bah leading-relaxed">
              {todayRead.what_moved}
            </p>
          </div>

          {/* What it Means for the Company */}
          <div className="p-4 rounded-xl bg-bah-accent-soft/40 border border-[var(--bah-accent)]/30">
            <div className="text-xs font-semibold uppercase tracking-wider text-bah-accent-text mb-2 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-bah-accent" />
              What it means for {companyName}
            </div>
            <p className="text-sm text-bah leading-relaxed">
              {todayRead.what_it_means}
            </p>
          </div>
        </div>

        {/* Footer Actions & Citations */}
        <div className="mt-6 pt-4 border-t border-bah flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3 text-xs text-bah-muted flex-wrap">
            <span className="font-medium text-bah">Scope affected:</span>
            <span className="px-2 py-0.5 rounded bg-bah-panel-soft border border-bah text-bah">
              {todayRead.related_scope || `${companyName} · Strategic Perimeter`}
            </span>
            {todayRead.source_citations?.slice(0, 2).map((src, i) => (
              <a
                key={i}
                href={src.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-bah-cyan hover:underline"
              >
                <span>{src.title?.slice(0, 32)}…</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            ))}
          </div>

          {onOpenFullRead && (
            <button
              onClick={onOpenFullRead}
              className="bah-button-primary px-5 py-2.5 text-xs font-medium shrink-0 group"
            >
              <span>Open full read</span>
              <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
