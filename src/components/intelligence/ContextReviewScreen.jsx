import React from 'react';
import { ChevronDown, Info, LayoutTemplate, Layers, Loader2, Lock, Pencil, Plus, X, Zap, Target } from 'lucide-react';

// The frame editor is the moment the founder corrects Bahirjee's reading of their
// question, so it has to name that reading. Calling a situation a "Decision frame" and
// showing it an empty Options list invites them to invent the very alternatives
// inferOptions was stopped from inventing.
const FRAME_COPY = {
  decision: {
    title: 'Decision frame',
    statementLabel: 'Primary decision',
    hint: 'Options come from your words — add or edit them if Bahirjee read them wrong.',
  },
  situation: {
    title: 'Question frame',
    statementLabel: 'What you want to understand',
    hint: 'The questions below are what Bahirjee searches against.',
  },
  assessment: {
    title: 'Assessment frame',
    statementLabel: 'What you are judging',
    hint: 'Add the criteria you want it judged against.',
  },
};

function getValue(val) {
  if (val && typeof val === 'object' && 'value' in val) return val.value;
  if (typeof val === 'string') return val;
  return '';
}

export default function ContextReviewScreen({
  contextData,
  setContextData,
  onboardingData,
  finalReport,
  setPhase,
  handleConfirmContext,
  isConfirming = false,
  analysisMode = 'company',
  // Set only when this run started from a stored context. Null on a fresh build, which is
  // what keeps the banner and the "Run with this" wording honest.
  storedMeta = null,
  onEditOnboarding = null,
}) {
  const getConfidenceLevel = () => {
    const conf = contextData.overall_confidence?.toLowerCase() || 'medium';
    if (conf === 'high') return 3;
    if (conf === 'medium') return 2;
    return 1;
  };

  /**
   * Every edit on this screen, recorded as it happens.
   *
   * You cannot preserve a correction you never wrote down. When a later run merges new
   * sources into this context, the model will happily "update" a field the founder fixed
   * by hand and re-add a competitor they deleted — and there is no way to tell that from
   * a legitimate discovery unless the human's intent was recorded at the moment it was
   * expressed. `fields` is what applyContextPatch refuses to overwrite; `removed` is what
   * stepMemory's competitor-persistence merge refuses to re-add.
   */
  const patch = (changes, ...fields) => {
    const prior = contextData._userEdits || {};
    setContextData({
      ...contextData,
      ...changes,
      _userEdits: {
        ...prior,
        fields: [...new Set([...(prior.fields || []), ...fields])],
        removed: prior.removed || [],
        at: new Date().toISOString(),
      },
    });
  };

  /** An entity the founder explicitly deleted. Never silently resurrected. */
  const patchWithRemoval = (changes, removedName, ...fields) => {
    const prior = contextData._userEdits || {};
    const name = String(removedName || '').trim();
    setContextData({
      ...contextData,
      ...changes,
      _userEdits: {
        ...prior,
        fields: [...new Set([...(prior.fields || []), ...fields])],
        removed: name ? [...new Set([...(prior.removed || []), name])] : (prior.removed || []),
        at: new Date().toISOString(),
      },
    });
  };

  const setOverallConfidence = (level) => {
    const conf = level === 3 ? 'High' : level === 2 ? 'Medium' : 'Low';
    patch({ overall_confidence: conf }, 'overall_confidence');
  };

  const anchorFields = ['operational_reality', 'narrative_lens', 'leadership_tone', 'current_optimization'];
  const obData = onboardingData || contextData._onboardingData || {};
  const companyDna = contextData.company_dna || {};
  const depMap = contextData.dependency_map || {};
  const hasLockedData = obData.revenueModel || obData.customerType || contextData.company_name;
  const decision = contextData._decision || {};
  const updateDecision = (changes) => patch({ _decision: { ...decision, ...changes } }, ...Object.keys(changes).map(k => `_decision.${k}`));
  // Frames persisted before inquiry kinds existed carry no `kind`, and every one of them
  // was a decision.
  const frameKind = FRAME_COPY[decision.kind] ? decision.kind : 'decision';

  const buyerType = contextData.strategic_anchors?.buyer_type || {};
  const isBuyerCompound = typeof buyerType === 'object' && buyerType.primary;
  const buyerPrimary = isBuyerCompound ? buyerType.primary : (typeof buyerType === 'string' ? buyerType : '');
  const buyerEvidence = isBuyerCompound ? buyerType.evidence : '';
  const buyerSecondary = isBuyerCompound ? (buyerType.secondary_segments || []) : [];

  const positioning = contextData.strategic_anchors?.positioning || {};
  const isPosCompound = typeof positioning === 'object' && positioning.stance;
  const posStance = isPosCompound ? positioning.stance : (typeof positioning === 'string' ? positioning : '');
  const posEvidence = isPosCompound ? positioning.evidence : '';
  const posDifferentiator = isPosCompound ? positioning.differentiator : '';

  return (
    // Fits the viewport by construction: the card is a flex column bounded to the screen
    // height, and the editable region below flexes to absorb whatever is left over. The
    // old fixed `max-h-[60vh]` scroller stacked with a header, a footer and two layers of
    // p-8, so the page itself always scrolled a little no matter the screen.
    <div className="h-dvh bg-bah-bg text-bah font-sans p-3 tall:p-6 flex items-center justify-center">
      <div className="w-full max-w-5xl max-h-full bg-bah-panel-strong rounded-2xl border border-bah shadow-2xl p-4 tall:p-6 animate-in zoom-in-95 flex flex-col">
        <div className="flex items-center justify-between mb-4 tall:mb-6 shrink-0 gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-bah-accent-soft rounded-xl text-bah-accent"><LayoutTemplate className="w-8 h-8" /></div>
            <div>
              <h2 className="text-2xl font-light text-bah-strong">Review Strategic Context</h2>
              <p className="text-bah-muted text-sm">Edit anchors to guide the Deep Research agents.</p>
            </div>
          </div>
          {/* Was three bare clickable <div>s: no role, no tab stop, no key handler,
              so a keyboard user could not set the confidence that steers the run. */}
          <div className="flex items-center gap-3 bah-panel-strong px-4 py-3">
            <span id="confidence-label" className="text-[10px] font-bold uppercase tracking-widest text-bah-muted">Confidence</span>
            <div className="flex gap-1 w-24" role="radiogroup" aria-labelledby="confidence-label">
              {[1, 2, 3].map(i => (
                <button
                  key={i}
                  type="button"
                  role="radio"
                  aria-checked={getConfidenceLevel() === i}
                  aria-label={['Low', 'Medium', 'High'][i - 1]}
                  onClick={() => setOverallConfidence(i)}
                  className={`h-3 flex-1 rounded-full transition-all hover:opacity-80 ${i <= getConfidenceLevel() ? 'bg-[var(--bah-accent)]' : 'bg-bah-panel-soft'}`}
                />
              ))}
            </div>
            <span className={`text-xs font-medium px-2 py-0.5 rounded ${getConfidenceLevel() === 3 ? 'bg-emerald-500/20 text-bah-accent-strong' :
              getConfidenceLevel() === 2 ? 'bg-yellow-500/20 text-bah-warning' :
                'bg-red-500/20 text-bah-danger'
              }`}>{contextData.overall_confidence || 'Medium'}</span>
          </div>
        </div>

        {/* min-h-0 is load-bearing: without it a flex child refuses to shrink below its
            content height and the overflow escapes to the page instead of scrolling here. */}
        {storedMeta && (
          <div className="shrink-0 mb-4 rounded-lg border border-bah bg-bah-accent-soft/40 px-4 py-3 flex items-start gap-2.5">
            <Layers className="w-4 h-4 text-bah-accent shrink-0 mt-0.5" />
            <p className="text-xs text-bah leading-relaxed">
              {storedMeta.origin === 'report_fallback'
                ? 'Starting from the context recovered from your last brief. '
                : `Starting from your saved context${storedMeta.version ? ` (v${storedMeta.version})` : ''}. `}
              Anything you change here is kept for next time.
            </p>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar space-y-4 tall:space-y-6 pr-1">
          {analysisMode === 'decision' && (
            <div className="rounded-xl border border-bah-cyan/30 bg-bah-cyan-soft/30 p-5 space-y-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-bah-cyan-soft text-bah-cyan"><Target className="w-5 h-5" /></div>
                <div>
                  <h3 className="text-sm font-semibold text-bah-cyan">{FRAME_COPY[frameKind].title}</h3>
                  <p className="text-xs text-bah-muted mt-1">Correct this before Bahirjee searches — it decides what evidence matters. {FRAME_COPY[frameKind].hint}</p>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-bah-muted">{FRAME_COPY[frameKind].statementLabel}</label>
                <textarea value={decision.decision_statement || ''} onChange={(e) => updateDecision({ decision_statement: e.target.value })} className="bah-input min-h-20 rounded-lg p-3 text-sm resize-y" />
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-bah-muted">Desired outcome</label>
                  <textarea value={decision.objective || ''} onChange={(e) => updateDecision({ objective: e.target.value })} className="bah-input min-h-20 rounded-lg p-3 text-sm resize-y" />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-bah-muted">{frameKind === 'decision' ? 'Decision timeframe' : 'Timeframe'}</label>
                  <input value={decision.time_horizon || ''} onChange={(e) => updateDecision({ time_horizon: e.target.value })} placeholder="e.g. decide by Q4 2026" className="bah-input rounded-lg p-3 text-sm" />
                </div>
              </div>
              {frameKind === 'decision' && <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-bah-muted">Options</label>
                <div className="space-y-2">
                  {(decision.options || []).map((option, index) => (
                    <div key={option.id || index} className="flex items-center gap-2">
                      <span className="text-xs text-bah-muted-2 w-5">{index + 1}.</span>
                      <input value={option.label || ''} onChange={(e) => { const options = [...(decision.options || [])]; options[index] = { ...option, label: e.target.value }; updateDecision({ options }); }} className="bah-input flex-1 rounded-lg px-3 py-2 text-sm" />
                      <button type="button" onClick={() => updateDecision({ options: (decision.options || []).filter((_, i) => i !== index) })} className="text-bah-muted-2 hover:text-bah-danger"><X className="w-4 h-4" /></button>
                    </div>
                  ))}
                </div>
                <button type="button" onClick={() => updateDecision({ options: [...(decision.options || []), { id: `option_${Date.now()}`, label: '', description: '' }] })} className="text-xs text-bah-cyan hover:text-bah-strong flex items-center gap-1"><Plus className="w-3 h-3" /> Add option</button>
              </div>}
              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-bah-muted">Constraints</label>
                  <textarea value={(decision.constraints || []).join('\n')} onChange={(e) => updateDecision({ constraints: e.target.value.split('\n').map(v => v.trim()).filter(Boolean) })} placeholder="One constraint per line" className="bah-input min-h-20 rounded-lg p-3 text-sm resize-y" />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-bah-muted">{frameKind === 'decision' ? 'Linked questions' : 'Questions to answer'}</label>
                  <textarea value={(decision.sub_questions || []).join('\n')} onChange={(e) => updateDecision({ sub_questions: e.target.value.split('\n').map(v => v.trim()).filter(Boolean).slice(0, 5) })} placeholder="One related question per line" className="bah-input min-h-20 rounded-lg p-3 text-sm resize-y" />
                </div>
              </div>
            </div>
          )}

          {hasLockedData && (
            <details className="group">
              <summary className="flex items-center gap-2 cursor-pointer mb-3 select-none">
                <Lock className="w-4 h-4 text-bah-accent" />
                <span className="text-xs font-bold uppercase tracking-widest text-bah-accent">Locked Intelligence Profile</span>
                <ChevronDown className="w-3.5 h-3.5 text-bah-muted group-open:rotate-180 transition-transform ml-auto" />
              </summary>
              <div className="bg-bah-panel-soft border border-bah rounded-xl p-5 space-y-4 animate-in fade-in duration-300">
                {/* This line used to say "To change, re-run onboarding" and offer no way to
                    do it — the founder could read a wrong revenue model but not fix it. */}
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-[10px] text-bah-muted flex items-center gap-1.5">
                    <Info className="w-3 h-3" />
                    User-provided + auto-inferred.
                  </p>
                  {onEditOnboarding && (
                    <button
                      type="button"
                      onClick={onEditOnboarding}
                      className="text-[10px] text-bah-accent hover:text-bah-accent-strong flex items-center gap-1 font-medium"
                    >
                      <Pencil className="w-3 h-3" /> Edit business profile
                    </button>
                  )}
                </div>

                {(obData.revenueModel || obData.customerType) && (
                  <div>
                    <h4 className="text-[10px] font-bold uppercase tracking-widest text-bah-muted mb-2">Business Core</h4>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      {obData.revenueModel && <div className="bg-bah-panel-soft rounded-lg px-3 py-2"><span className="text-[9px] text-bah-muted-2 uppercase">Revenue Model</span><p className="text-xs text-bah">{obData.revenueModel}</p></div>}
                      {obData.customerType && <div className="bg-bah-panel-soft rounded-lg px-3 py-2"><span className="text-[9px] text-bah-muted-2 uppercase">Customer Type</span><p className="text-xs text-bah">{obData.customerType}</p></div>}
                      {obData.salesMotion && <div className="bg-bah-panel-soft rounded-lg px-3 py-2"><span className="text-[9px] text-bah-muted-2 uppercase">Sales Motion</span><p className="text-xs text-bah">{obData.salesMotion}</p></div>}
                      {obData.fundingStage && <div className="bg-bah-panel-soft rounded-lg px-3 py-2"><span className="text-[9px] text-bah-muted-2 uppercase">Funding Stage</span><p className="text-xs text-bah">{obData.fundingStage}</p></div>}
                      {obData.geography && <div className="bg-bah-panel-soft rounded-lg px-3 py-2"><span className="text-[9px] text-bah-muted-2 uppercase">Geography</span><p className="text-xs text-bah">{obData.geography}</p></div>}
                    </div>
                  </div>
                )}

                {(obData.infraCost || obData.competitivePressure) && (
                  <div>
                    <h4 className="text-[10px] font-bold uppercase tracking-widest text-bah-muted mb-2">Sensitivity Snapshot</h4>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { label: 'Infra Cost', value: obData.infraCost },
                        { label: 'Revenue Slowdown', value: obData.revenueSlowdown },
                        { label: 'Hiring Dep.', value: obData.hiringDependency },
                        { label: 'Competitive', value: obData.competitivePressure },
                        { label: 'Regulatory', value: obData.regulatoryExposure },
                        { label: 'Platform Dep.', value: obData.platformDependency },
                      ].filter(s => s.value).map(s => (
                        <span key={s.label} className={`px-2.5 py-1 rounded-lg text-[10px] font-medium border ${s.value === 'High' ? 'bg-red-500/10 text-bah-danger border-red-500/20' :
                          s.value === 'Low' ? 'bg-emerald-500/10 text-bah-accent-strong border-emerald-500/20' :
                            'bg-amber-500/10 text-bah-warning border-amber-500/20'
                          }`}>
                          {s.label}: {s.value}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                    <h4 className="text-[10px] font-bold uppercase tracking-widest text-bah-muted mb-2">Auto-Inferred by Bahirjee</h4>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {contextData.company_name && <div className="bg-bah-panel-soft rounded-lg px-3 py-2"><span className="text-[9px] text-bah-muted-2 uppercase">Company</span><p className="text-xs text-bah">{contextData.company_name}</p></div>}
                    {contextData.industry && <div className="bg-bah-panel-soft rounded-lg px-3 py-2"><span className="text-[9px] text-bah-muted-2 uppercase">Industry</span><p className="text-xs text-bah">{contextData.industry}</p></div>}
                    {contextData.vertical_specialization && <div className="bg-bah-panel-soft rounded-lg px-3 py-2"><span className="text-[9px] text-bah-muted-2 uppercase">Vertical</span><p className="text-xs text-bah">{contextData.vertical_specialization}</p></div>}
                    {companyDna.team_size && companyDna.team_size !== 'unknown' && <div className="bg-bah-panel-soft rounded-lg px-3 py-2"><span className="text-[9px] text-bah-muted-2 uppercase">Team Size</span><p className="text-xs text-bah">{companyDna.team_size}</p></div>}
                    {companyDna.growth_signals && companyDna.growth_signals !== 'unknown' && <div className="bg-bah-panel-soft rounded-lg px-3 py-2"><span className="text-[9px] text-bah-muted-2 uppercase">Growth Signal</span><p className="text-xs text-bah">{companyDna.growth_signals}</p></div>}
                  </div>
                </div>

                {(depMap.infra_dependencies?.length > 0 || depMap.platform_dependencies?.length > 0) && (
                  <div>
                    <h4 className="text-[10px] font-bold uppercase tracking-widest text-bah-muted mb-2">Dependency Map</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {(depMap.infra_dependencies || []).map((d, i) => <span key={`infra-${i}`} className="px-2 py-0.5 bg-bah-cyan-soft text-bah-cyan text-[10px] rounded border border-[var(--bah-cyan)]/20">{d}</span>)}
                      {(depMap.platform_dependencies || []).map((d, i) => <span key={`plat-${i}`} className="px-2 py-0.5 bg-bah-accent-soft text-bah-accent text-[10px] rounded border border-[var(--bah-accent)]/20">{d}</span>)}
                      {(depMap.regulatory_exposure || []).map((d, i) => <span key={`reg-${i}`} className="px-2 py-0.5 bg-amber-500/10 text-bah-warning text-[10px] rounded border border-amber-500/15">{d}</span>)}
                    </div>
                  </div>
                )}

                {obData.assumptions?.length > 0 && (
                  <div>
                    <h4 className="text-[10px] font-bold uppercase tracking-widest text-bah-muted mb-2">Your Market Bets</h4>
                    <div className="space-y-1.5">
                      {obData.assumptions.map((a, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs bg-bah-panel-soft rounded-lg px-3 py-2">
                          <span className="text-bah-muted font-mono">{i + 1}.</span>
                          <span className="text-bah flex-1">{a.statement}</span>
                          {a.domain && <span className="text-[9px] text-bah-accent bg-bah-accent-soft px-1.5 py-0.5 rounded">{a.domain}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </details>
          )}

          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-widest text-bah-muted">Operating Region</label>
              <input value={contextData.operating_geography || ''} onChange={(e) => patch({ operating_geography: e.target.value }, 'operating_geography')} className="bah-input-strong" />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-widest text-bah-muted">Operational Hubs</label>
              <input value={contextData.operational_hubs || ''} onChange={(e) => patch({ operational_hubs: e.target.value }, 'operational_hubs')} className="bah-input-strong text-bah" />
            </div>
          </div>

          <div className="space-y-3">
            <label className="text-xs font-bold uppercase tracking-widest text-bah-accent">Key Competitors</label>
            <div className="bg-bah-bg border border-bah rounded-lg p-4">
              {Array.isArray(contextData.key_competitors) && contextData.key_competitors.length > 0 ? (
                <div className="space-y-2">
                  {contextData.key_competitors.map((comp, idx) => (
                    <div key={idx} className="flex items-center gap-3 group">
                      <span className="text-xs text-bah-muted w-4">{idx + 1}.</span>
                      <input
                        value={typeof comp === 'object' ? comp.name : comp}
                        onChange={(e) => {
                          const updated = [...contextData.key_competitors];
                          updated[idx] = typeof comp === 'object' ? { ...comp, name: e.target.value } : e.target.value;
                          patch({ key_competitors: updated }, 'key_competitors');
                        }}
                        placeholder="Competitor name"
                        className="flex-1 bg-transparent border-b border-bah focus:border-[var(--bah-accent)] outline-none py-1 text-sm text-bah-strong"
                      />
                      <input
                        value={typeof comp === 'object' ? comp.url || '' : ''}
                        onChange={(e) => {
                          const updated = [...contextData.key_competitors];
                          updated[idx] = { name: typeof comp === 'object' ? comp.name : comp, url: e.target.value };
                          patch({ key_competitors: updated }, 'key_competitors');
                        }}
                        placeholder="https://..."
                        className="w-48 bg-transparent border-b border-bah focus:border-[var(--bah-accent)] outline-none py-1 text-xs text-bah-muted"
                      />
                      <button
                        onClick={() => {
                          const updated = contextData.key_competitors.filter((_, i) => i !== idx);
                          // Record the NAME, not just the new array: stepMemory merges the
                          // previous run's competitors back in and would otherwise re-add
                          // this one on the very next step.
                          patchWithRemoval(
                            { key_competitors: updated },
                            typeof comp === 'object' ? comp.name : comp,
                            'key_competitors'
                          );
                        }}
                        className="opacity-0 group-hover:opacity-100 text-bah-danger hover:text-bah-danger p-1"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-bah-muted">No competitors detected</p>
              )}
              <button
                onClick={() => patch(
                  { key_competitors: [...(contextData.key_competitors || []), { name: '', url: '' }] },
                  'key_competitors'
                )}
                className="mt-3 text-xs text-bah-accent hover:text-bah-accent-strong flex items-center gap-1"
              >
                <Plus className="w-3 h-3" /> Add Competitor
              </button>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            {anchorFields.map((key) => {
              const anchor = contextData?.strategic_anchors?.[key];
              const isNestedWithEvidence = anchor && typeof anchor === 'object' && ('style' in anchor || 'focus' in anchor);
              const displayValue = isNestedWithEvidence
                ? `${anchor.style || anchor.focus || ''}\n\n${anchor.evidence || ''}`
                : getValue(anchor);
              const itemConfidence = anchor?.confidence;

              return (
                <div key={key} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold uppercase tracking-widest text-bah-accent">
                      {key.replace(/_/g, ' ')}
                    </label>
                    {itemConfidence && (
                      <span className={`text-[9px] px-1.5 py-0.5 rounded ${itemConfidence.toLowerCase() === 'high' ? 'bg-emerald-500/10 text-bah-accent-strong' :
                        itemConfidence.toLowerCase() === 'medium' ? 'bg-yellow-500/10 text-bah-warning' :
                          'bg-red-500/10 text-bah-danger'
                        }`}>{itemConfidence}</span>
                    )}
                  </div>
                  <textarea
                    value={displayValue}
                    onChange={(e) => {
                      const newAnchors = { ...contextData.strategic_anchors };
                      if (isNestedWithEvidence) {
                        const lines = e.target.value.split('\n\n');
                        newAnchors[key] = {
                          ...(anchor.style ? { style: lines[0] } : { focus: lines[0] }),
                          evidence: lines.slice(1).join('\n\n')
                        };
                      } else if (typeof anchor === 'object' && 'value' in anchor) {
                        newAnchors[key] = { ...anchor, value: e.target.value };
                      } else {
                        newAnchors[key] = e.target.value;
                      }
                      patch({ strategic_anchors: newAnchors }, `strategic_anchors.${key}`);
                    }}
                    className={`w-full bg-bah-bg border border-bah rounded p-3 text-sm text-bah focus:border-[var(--bah-accent)] outline-none resize-none ${isNestedWithEvidence ? 'h-32' : 'h-20'}`}
                    placeholder={isNestedWithEvidence ? 'Style/Focus\n\nEvidence explaining why...' : ''}
                  />
                </div>
              );
            })}
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-widest text-bah-accent">Buyer Type</label>
              <div className="bg-bah-bg border border-bah rounded p-3 space-y-2">
                <input
                  value={buyerPrimary}
                  onChange={(e) => {
                    const newAnchors = { ...contextData.strategic_anchors };
                    if (isBuyerCompound) {
                      newAnchors.buyer_type = { ...buyerType, primary: e.target.value };
                    } else {
                      newAnchors.buyer_type = { primary: e.target.value, evidence: '', secondary_segments: [] };
                    }
                    patch({ strategic_anchors: newAnchors }, 'strategic_anchors.buyer_type');
                  }}
                  className="w-full bg-transparent text-sm text-bah-strong focus:outline-none font-medium"
                  placeholder="Enterprise | Mid-Market | SMB | Gov | Consumer"
                />
                {buyerEvidence && (
                  <p className="text-[11px] text-bah-muted leading-relaxed border-t border-bah pt-2">{buyerEvidence}</p>
                )}
                {buyerSecondary.length > 0 && (
                  <div className="flex gap-1.5 pt-1">
                    {buyerSecondary.map((seg, i) => (
                      <span key={i} className="text-[9px] px-1.5 py-0.5 bg-bah-accent-soft text-bah-accent rounded">{seg}</span>
                    ))}
                  </div>
                )}
                {!buyerEvidence && (
                  <textarea
                    value={buyerEvidence}
                    onChange={(e) => {
                      const newAnchors = { ...contextData.strategic_anchors };
                      newAnchors.buyer_type = { primary: buyerPrimary, evidence: e.target.value, secondary_segments: buyerSecondary };
                      patch({ strategic_anchors: newAnchors }, 'strategic_anchors.buyer_type');
                    }}
                    className="w-full bg-transparent text-[11px] text-bah-muted focus:outline-none resize-none h-10 border-t border-bah pt-2"
                    placeholder="Evidence: case studies, pricing tiers, compliance badges..."
                  />
                )}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-widest text-bah-accent">Positioning</label>
              <div className="bg-bah-bg border border-bah rounded p-3 space-y-2">
                <input
                  value={posStance}
                  onChange={(e) => {
                    const newAnchors = { ...contextData.strategic_anchors };
                    if (isPosCompound) {
                      newAnchors.positioning = { ...positioning, stance: e.target.value };
                    } else {
                      newAnchors.positioning = { stance: e.target.value, evidence: '', differentiator: '' };
                    }
                    patch({ strategic_anchors: newAnchors }, 'strategic_anchors.positioning');
                  }}
                  className="w-full bg-transparent text-sm text-bah-strong focus:outline-none font-medium"
                  placeholder="Innovation-led | Value-led | Compliance-led"
                />
                {posEvidence && (
                  <p className="text-[11px] text-bah-muted leading-relaxed border-t border-bah pt-2">{posEvidence}</p>
                )}
                {posDifferentiator && (
                  <p className="text-[11px] text-bah-accent italic border-t border-bah pt-2">"{posDifferentiator}"</p>
                )}
                {!posEvidence && (
                  <textarea
                    value={posEvidence}
                    onChange={(e) => {
                      const newAnchors = { ...contextData.strategic_anchors };
                      newAnchors.positioning = { stance: posStance, evidence: e.target.value, differentiator: posDifferentiator };
                      patch({ strategic_anchors: newAnchors }, 'strategic_anchors.positioning');
                    }}
                    className="w-full bg-transparent text-[11px] text-bah-muted focus:outline-none resize-none h-10 border-t border-bah pt-2"
                    placeholder="Evidence: patent mentions, pricing emphasis, certifications..."
                  />
                )}
              </div>
            </div>
          </div>

          {contextData.customer_segments && contextData.customer_segments.length > 0 && (
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-widest text-bah-muted">Customer Segments</label>
              <div className="flex flex-wrap gap-2">
                {contextData.customer_segments.map((seg, idx) => {
                  const segName = typeof seg === 'object' ? seg.segment : seg;
                  const painPointsRaw = typeof seg === 'object' ? seg.pain_points : null;
                  const painPoints = Array.isArray(painPointsRaw) ? painPointsRaw.join(', ') : (typeof painPointsRaw === 'string' ? painPointsRaw : '');

                  return (
                    <span key={idx} className="px-3 py-1 bg-bah-bg border border-bah rounded-full text-xs text-bah-muted group relative">
                      {segName}
                      {painPoints && (
                        <span className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 px-2 py-1 bg-bah-panel-strong text-bah text-[10px] rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 pointer-events-none border border-bah">
                          Pains: {painPoints}
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-4 pt-4 tall:pt-5 border-t border-bah mt-4 tall:mt-5 shrink-0">
          <button
            onClick={() => setPhase(finalReport ? 'complete' : 'idle')}
            disabled={isConfirming}
            className="px-6 py-2 text-bah-muted hover:text-bah-strong disabled:opacity-50 disabled:pointer-events-none"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirmContext}
            disabled={isConfirming}
            className="bah-button-primary px-8 py-3 rounded-lg flex items-center gap-2 disabled:opacity-60 disabled:pointer-events-none"
          >
            {isConfirming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {isConfirming ? 'Submitting…' : storedMeta ? 'Run with this context' : 'Confirm & Analyze'}
          </button>
        </div>
      </div>
    </div>
  );
}
