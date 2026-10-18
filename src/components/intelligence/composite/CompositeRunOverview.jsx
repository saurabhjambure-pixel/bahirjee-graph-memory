import React, { useState } from 'react';
import {
  ArrowLeft,
  Building2,
  Package,
  Scale,
  ShieldCheck,
  AlertTriangle,
  ExternalLink,
  CheckCircle,
  HelpCircle,
  Clock,
  Share2,
  Download
} from 'lucide-react';

export default function CompositeRunOverview({ run, onBackToDesk }) {
  const [activeTab, setActiveTab] = useState('overview');

  if (!run) return null;

  const isPartial = run.status_key === 'partial' || run.status === 'Partial';
  const synthesis = run.overview_synthesis || {};
  const companyView = run.company_view || {};
  const productViews = run.product_views || {};
  const decisionViews = run.decision_views || {};

  // Build tab list
  const tabs = [
    { id: 'overview', label: 'Overview Synthesis', icon: <Building2 className="w-3.5 h-3.5" /> },
    { id: 'company', label: companyView.name || 'Company', icon: <Building2 className="w-3.5 h-3.5" /> },
    ...Object.entries(productViews).map(([pid, pview]) => ({
      id: `prod_${pid}`,
      label: pview.name,
      icon: <Package className="w-3.5 h-3.5 text-bah-cyan" />
    })),
    ...Object.entries(decisionViews).map(([did, dview]) => ({
      id: `dec_${did}`,
      label: dview.question.length > 24 ? `${dview.question.slice(0, 24)}…` : dview.question,
      icon: <Scale className="w-3.5 h-3.5 text-bah-accent-text" />
    }))
  ];

  return (
    <div className="min-h-screen bg-transparent text-bah pb-16">
      {/* ── TOP HEADER ──────────────────────────────────────────────── */}
      <div className="border-b border-bah bg-bah-panel-strong/80 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={onBackToDesk}
              className="bah-button-secondary p-2 rounded-xl text-bah hover:text-bah-strong"
              title="Return to Intelligence Desk"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs uppercase tracking-widest text-bah-muted font-medium">
                  Composite Intelligence Brief
                </span>
                <span className="text-xs text-bah-muted">•</span>
                <span className="text-xs text-bah font-semibold">{run.date}</span>
                {isPartial ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-bah-warning-soft text-bah-warning border border-amber-500/30 inline-flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    Partial Run
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-bah-accent-soft text-bah-accent-strong border border-[var(--bah-accent)]/20 inline-flex items-center gap-1">
                    <CheckCircle className="w-3 h-3" />
                    Complete
                  </span>
                )}
              </div>
              <h1 className="text-lg md:text-xl font-bold text-bah-strong font-display mt-0.5 truncate max-w-2xl">
                {run.scope_label}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2 self-start sm:self-center">
            <button
              onClick={() => alert('Brief link copied to clipboard.')}
              className="bah-button-secondary px-3 py-1.5 text-xs inline-flex items-center gap-1.5"
            >
              <Share2 className="w-3.5 h-3.5 text-bah-muted" />
              <span>Share brief</span>
            </button>
          </div>
        </div>

        {/* Multi-Tab Navigation Strip */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center gap-1 overflow-x-auto no-scrollbar border-t border-bah/40 pt-1">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-xs font-medium border-b-2 whitespace-nowrap inline-flex items-center gap-2 transition-all ${
                activeTab === tab.id
                  ? 'border-[var(--bah-accent)] text-bah-accent-strong font-semibold bg-bah-accent-soft/20'
                  : 'border-transparent text-bah-muted hover:text-bah hover:border-bah'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── MAIN CONTENT ────────────────────────────────────────────── */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Partial Degradation Notice Banner */}
        {isPartial && run.degradations?.length > 0 && (
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-bah-warning flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold block mb-0.5">
                Partial Run Disclosure ({run.degradations[0].target}):
              </span>
              <span>{run.degradations[0].message}</span>
            </div>
          </div>
        )}

        {/* ── 1. TAB: OVERVIEW SYNTHESIS ──────────────────────────────── */}
        {activeTab === 'overview' && (
          <div className="space-y-6 animate-fadeIn">
            {/* Main Judgment Card */}
            <div className="bah-panel p-6 md:p-8 rounded-[20px]">
              <div className="text-xs uppercase tracking-widest text-bah-accent-text font-semibold mb-2 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-bah-accent" />
                Strategic Judgment
              </div>
              <h2 className="text-xl md:text-2xl font-semibold text-bah-strong font-display tracking-tight leading-snug">
                {run.main_judgment}
              </h2>
            </div>

            {/* Cross-Scope Synthesis Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Important Movement */}
              <div className="bah-panel p-6 rounded-[20px] space-y-3">
                <div className="text-xs uppercase tracking-wider text-bah-muted font-semibold flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-bah-cyan" />
                  Important Movement
                </div>
                <ul className="space-y-2.5">
                  {synthesis.important_movement?.map((item, i) => (
                    <li key={i} className="text-xs md:text-sm text-bah leading-relaxed flex items-start gap-2">
                      <span className="text-bah-accent-text font-bold">•</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Strategic Implications */}
              <div className="bah-panel p-6 rounded-[20px] space-y-3 bg-bah-accent-soft/30 border-[var(--bah-accent)]/30">
                <div className="text-xs uppercase tracking-wider text-bah-accent-text font-semibold flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-bah-accent" />
                  Strategic Implications for {companyView.name || 'Company'}
                </div>
                <ul className="space-y-2.5">
                  {synthesis.strategic_implications?.map((item, i) => (
                    <li key={i} className="text-xs md:text-sm text-bah leading-relaxed flex items-start gap-2">
                      <span className="text-bah-accent-text font-bold">→</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Tensions Between Signals */}
              {synthesis.tensions?.length > 0 && (
                <div className="bah-panel p-6 rounded-[20px] space-y-3">
                  <div className="text-xs uppercase tracking-wider text-bah-warning-text font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-bah-warning" />
                    Tensions Between Company & Product Signals
                  </div>
                  <ul className="space-y-2.5">
                    {synthesis.tensions.map((item, i) => (
                      <li key={i} className="text-xs md:text-sm text-bah leading-relaxed flex items-start gap-2">
                        <span className="text-bah-warning font-bold">!</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Decisions Affected */}
              {synthesis.decisions_affected?.length > 0 && (
                <div className="bah-panel p-6 rounded-[20px] space-y-3">
                  <div className="text-xs uppercase tracking-wider text-bah-muted font-semibold flex items-center gap-1.5">
                    <Scale className="w-3.5 h-3.5 text-bah-accent-text" />
                    Decisions Affected
                  </div>
                  <div className="space-y-3">
                    {synthesis.decisions_affected.map((item, i) => (
                      <div key={i} className="p-3 rounded-lg bg-bah-panel-strong border border-bah text-xs space-y-1">
                        <span className="font-semibold text-bah-strong block">{item.question}</span>
                        <span className="text-bah-accent-text font-medium block">Verdict: {item.verdict}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Unknowns & Blind Spots */}
              {synthesis.unknowns?.length > 0 && (
                <div className="bah-panel p-6 rounded-[20px] space-y-3 md:col-span-2">
                  <div className="text-xs uppercase tracking-wider text-bah-muted font-semibold flex items-center gap-1.5">
                    <HelpCircle className="w-3.5 h-3.5 text-bah-cyan" />
                    Critical Unknowns & Validation Steps
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {synthesis.unknowns.map((unknown, i) => (
                      <div key={i} className="p-3.5 rounded-xl bg-bah-panel-soft border border-bah text-xs text-bah italic">
                        "{unknown}"
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── 2. TAB: COMPANY VIEW ────────────────────────────────────── */}
        {activeTab === 'company' && (
          <div className="space-y-6 animate-fadeIn">
            <div className="bah-panel p-6 rounded-[20px] space-y-2">
              <span className="text-xs uppercase tracking-wider text-bah-muted font-semibold">
                Company Perimeter Intelligence
              </span>
              <h3 className="text-xl font-bold text-bah-strong font-display">
                {companyView.headline || 'Company Signals & Macro Drivers'}
              </h3>
            </div>

            <div className="space-y-4">
              {companyView.signals?.map((sig, i) => (
                <div key={i} className="bah-panel p-5 rounded-[20px] space-y-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <h4 className="text-base font-semibold text-bah-strong font-display">{sig.headline}</h4>
                    <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-bah-cyan-soft text-bah-cyan border border-[var(--bah-cyan)]/20">
                      {sig.category}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1 text-xs">
                    <div className="p-3 bg-bah-panel-strong rounded-lg border border-bah">
                      <span className="font-semibold text-bah-muted block mb-1">What happened</span>
                      <p className="text-bah leading-relaxed">{sig.the_move}</p>
                    </div>
                    <div className="p-3 bg-bah-accent-soft/30 rounded-lg border border-[var(--bah-accent)]/20">
                      <span className="font-semibold text-bah-accent-text block mb-1">Implication for Company</span>
                      <p className="text-bah leading-relaxed">{sig.implication}</p>
                    </div>
                  </div>
                  <div className="pt-2 flex items-center justify-between text-[11px] text-bah-muted">
                    <a href={sig.source} target="_blank" rel="noreferrer" className="text-bah-cyan hover:underline inline-flex items-center gap-1 font-mono">
                      <span>Source verification</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                    <span className="font-medium text-bah-accent-text">Confidence: {sig.confidence}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 3. TAB: PRODUCT VIEWS ───────────────────────────────────── */}
        {activeTab.startsWith('prod_') && (
          <div className="space-y-6 animate-fadeIn">
            {(() => {
              const pid = activeTab.replace('prod_', '');
              const pview = productViews[pid];
              if (!pview) return <div>Product view not found</div>;

              return (
                <>
                  <div className="bah-panel p-6 rounded-[20px] space-y-2">
                    <div className="flex items-center gap-2">
                      <Package className="w-4 h-4 text-bah-cyan" />
                      <span className="text-xs uppercase tracking-wider text-bah-muted font-semibold">
                        {pview.name} Target Read
                      </span>
                    </div>
                    <h3 className="text-xl font-bold text-bah-strong font-display">
                      {pview.headline}
                    </h3>
                  </div>

                  <div className="space-y-4">
                    {pview.signals?.map((sig, i) => (
                      <div key={i} className="bah-panel p-5 rounded-[20px] space-y-3">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <h4 className="text-base font-semibold text-bah-strong font-display">{sig.headline}</h4>
                          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-bah-accent-soft text-bah-accent-strong border border-[var(--bah-accent)]/20">
                            {sig.category}
                          </span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1 text-xs">
                          <div className="p-3 bg-bah-panel-strong rounded-lg border border-bah">
                            <span className="font-semibold text-bah-muted block mb-1">Market Move</span>
                            <p className="text-bah leading-relaxed">{sig.the_move}</p>
                          </div>
                          <div className="p-3 bg-bah-accent-soft/30 rounded-lg border border-[var(--bah-accent)]/20">
                            <span className="font-semibold text-bah-accent-text block mb-1">Product Implication</span>
                            <p className="text-bah leading-relaxed">{sig.implication}</p>
                          </div>
                        </div>
                        <div className="pt-2 flex items-center justify-between text-[11px] text-bah-muted">
                          <a href={sig.source} target="_blank" rel="noreferrer" className="text-bah-cyan hover:underline inline-flex items-center gap-1 font-mono">
                            <span>Evidence citation</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                          <span className="font-medium text-bah-accent-text">Confidence: {sig.confidence}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {/* ── 4. TAB: DECISION VIEWS ──────────────────────────────────── */}
        {activeTab.startsWith('dec_') && (
          <div className="space-y-6 animate-fadeIn">
            {(() => {
              const did = activeTab.replace('dec_', '');
              const dview = decisionViews[did];
              if (!dview) return <div>Decision view not found</div>;

              return (
                <>
                  <div className="bah-panel p-6 md:p-8 rounded-[20px] space-y-3">
                    <div className="flex items-center gap-2">
                      <Scale className="w-4 h-4 text-bah-accent-text" />
                      <span className="text-xs uppercase tracking-wider text-bah-muted font-semibold">
                        Decision Judgment
                      </span>
                    </div>
                    <h3 className="text-xl md:text-2xl font-semibold text-bah-strong font-display">
                      {dview.question}
                    </h3>
                    <div className="p-4 rounded-xl bg-bah-accent-soft/40 border border-[var(--bah-accent)]/30 text-xs md:text-sm text-bah leading-relaxed font-medium">
                      {dview.judgment}
                    </div>
                  </div>

                  <div className="bah-panel p-6 rounded-[20px] space-y-4">
                    <h4 className="text-xs uppercase tracking-wider text-bah-muted font-semibold">
                      Tradeoff Analysis
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {dview.tradeoffs?.map((tradeoff, idx) => (
                        <div key={idx} className="p-4 rounded-xl bg-bah-panel-strong border border-bah text-xs leading-relaxed text-bah">
                          {tradeoff}
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
