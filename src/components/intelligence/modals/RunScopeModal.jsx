import React, { useState } from 'react';
import { X, Play, Eye, Building2, Package, Scale, ShieldCheck, CheckSquare, Square, Plus } from 'lucide-react';

export default function RunScopeModal({
  isOpen,
  onClose,
  company,
  products = [],
  decisions = [],
  onRunIntelligence,
  onSaveAsMonitoring,
  onAddProduct,
  onAddDecision
}) {
  const [includeCompany, setIncludeCompany] = useState(true);
  const [selectedProductIds, setSelectedProductIds] = useState(
    products.filter(p => p.status !== 'archived').map(p => p.id)
  );
  const [selectedDecisionIds, setSelectedDecisionIds] = useState(
    decisions.slice(0, 1).map(d => d.id)
  );

  if (!isOpen) return null;

  const toggleProduct = (pid) => {
    if (selectedProductIds.includes(pid)) {
      setSelectedProductIds(selectedProductIds.filter(id => id !== pid));
    } else {
      setSelectedProductIds([...selectedProductIds, pid]);
    }
  };

  const toggleDecision = (did) => {
    if (selectedDecisionIds.includes(did)) {
      setSelectedDecisionIds(selectedDecisionIds.filter(id => id !== did));
    } else {
      setSelectedDecisionIds([...selectedDecisionIds, did]);
    }
  };

  // Build count summary string
  const counts = [];
  if (includeCompany) counts.push('1 company');
  if (selectedProductIds.length > 0) counts.push(`${selectedProductIds.length} ${selectedProductIds.length === 1 ? 'product' : 'products'}`);
  if (selectedDecisionIds.length > 0) counts.push(`${selectedDecisionIds.length} ${selectedDecisionIds.length === 1 ? 'decision' : 'decisions'}`);
  const scopeSummary = counts.join(' · ') || 'No targets selected';

  // Build relationship explanation
  const buildExplanation = () => {
    if (selectedDecisionIds.length === 0) {
      return `Bahirjee will evaluate market movements across ${includeCompany ? (company?.name || 'the company') : ''}${selectedProductIds.length ? (includeCompany ? ' and ' : '') + 'selected products' : ''}.`;
    }
    const dec = decisions.find(d => d.id === selectedDecisionIds[0]);
    const decTitle = dec ? (dec.question.length > 35 ? `"${dec.question.slice(0, 35)}…"` : `"${dec.question}"`) : 'the selected decision';
    const prodNames = selectedProductIds.map(pid => products.find(p => p.id === pid)?.name).filter(Boolean);
    
    if (prodNames.length > 0) {
      return `${decTitle} will be evaluated against ${company?.name || 'the company'} and ${prodNames.join(' & ')}.`;
    }
    return `${decTitle} will be evaluated against ${company?.name || 'the company'}.`;
  };

  const currentScope = {
    company: includeCompany,
    product_ids: selectedProductIds,
    decision_ids: selectedDecisionIds
  };

  const handleRun = () => {
    onRunIntelligence(currentScope);
    onClose();
  };

  const handleSaveMonitoring = () => {
    onSaveAsMonitoring(currentScope);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fadeIn">
      <div className="bah-panel-strong w-full max-w-2xl rounded-[20px] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-bah flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-bah-strong font-display">
              Choose what Bahirjee should look at
            </h3>
            <span className="text-xs text-bah-muted">
              Configure target scope for this intelligence run
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-bah-muted hover:text-bah hover:bg-bah-panel-soft transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
          {/* Target Selection Cards */}
          <div className="space-y-4">
            {/* 1. Company Anchor Selection */}
            <div>
              <span className="text-[10px] uppercase font-semibold text-bah-muted tracking-wider block mb-2">
                Company Target
              </span>
              <button
                type="button"
                onClick={() => setIncludeCompany(!includeCompany)}
                className={`w-full p-3.5 rounded-xl border text-left flex items-center justify-between transition-all ${
                  includeCompany
                    ? 'bg-bah-accent-soft/40 border-[var(--bah-accent)] text-bah-strong'
                    : 'bg-bah-panel-soft border-bah text-bah-muted'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${includeCompany ? 'bg-bah-accent text-white' : 'bg-bah-panel text-bah-muted'}`}>
                    <Building2 className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold text-bah-strong">{company?.name || 'Company Target'}</h4>
                    <span className="text-[11px] text-bah-muted">
                      {company?.domain ? `Core market positioning & shifts for ${company.domain}` : 'Core market positioning & regulatory dockets'}
                    </span>
                  </div>
                </div>

                {includeCompany ? (
                  <CheckSquare className="w-5 h-5 text-bah-accent-text shrink-0" />
                ) : (
                  <Square className="w-5 h-5 text-bah-muted shrink-0" />
                )}
              </button>
            </div>

            {/* 2. Product Targets Selection */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase font-semibold text-bah-muted tracking-wider block">
                  Product Targets ({products.length})
                </span>
                {onAddProduct && (
                  <button
                    type="button"
                    onClick={() => { onClose(); onAddProduct(); }}
                    className="text-[11px] text-bah-accent-text hover:underline inline-flex items-center gap-1 font-medium"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Add product</span>
                  </button>
                )}
              </div>

              {products.length === 0 ? (
                <div className="p-3.5 rounded-xl bg-bah-panel-soft border border-bah text-xs text-bah-muted flex items-center justify-between">
                  <span>No products configured yet.</span>
                  {onAddProduct && (
                    <button
                      type="button"
                      onClick={() => { onClose(); onAddProduct(); }}
                      className="text-bah-accent-text font-medium hover:underline text-xs"
                    >
                      + Add product target
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {products.filter(p => p.status !== 'archived').map(product => {
                    const isSelected = selectedProductIds.includes(product.id);
                    return (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => toggleProduct(product.id)}
                        className={`w-full p-3.5 rounded-xl border text-left flex items-center justify-between transition-all ${
                          isSelected
                            ? 'bg-bah-accent-soft/40 border-[var(--bah-accent)] text-bah-strong'
                            : 'bg-bah-panel-soft border-bah text-bah-muted'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-lg ${isSelected ? 'bg-bah-cyan text-white' : 'bg-bah-panel text-bah-muted'}`}>
                            <Package className="w-4 h-4" />
                          </div>
                          <div>
                            <h4 className="text-xs font-semibold text-bah-strong">{product.name}</h4>
                            <span className="text-[11px] text-bah-muted">{product.tagline || product.description || 'Configured product target'}</span>
                          </div>
                        </div>

                        {isSelected ? (
                          <CheckSquare className="w-5 h-5 text-bah-accent-text shrink-0" />
                        ) : (
                          <Square className="w-5 h-5 text-bah-muted shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 3. Decision Targets Selection */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase font-semibold text-bah-muted tracking-wider block">
                  Strategic Decisions ({decisions.length})
                </span>
                {onAddDecision && (
                  <button
                    type="button"
                    onClick={() => { onClose(); onAddDecision(); }}
                    className="text-[11px] text-bah-accent-text hover:underline inline-flex items-center gap-1 font-medium"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Add decision</span>
                  </button>
                )}
              </div>

              {decisions.length === 0 ? (
                <div className="p-3.5 rounded-xl bg-bah-panel-soft border border-bah text-xs text-bah-muted flex items-center justify-between">
                  <span>No strategic decisions registered yet.</span>
                  {onAddDecision && (
                    <button
                      type="button"
                      onClick={() => { onClose(); onAddDecision(); }}
                      className="text-bah-accent-text font-medium hover:underline text-xs"
                    >
                      + Add decision
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {decisions.map(decision => {
                    const isSelected = selectedDecisionIds.includes(decision.id);
                    return (
                      <button
                        key={decision.id}
                        type="button"
                        onClick={() => toggleDecision(decision.id)}
                        className={`w-full p-3.5 rounded-xl border text-left flex items-center justify-between transition-all ${
                          isSelected
                            ? 'bg-bah-accent-soft/40 border-[var(--bah-accent)] text-bah-strong'
                            : 'bg-bah-panel-soft border-bah text-bah-muted'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-lg ${isSelected ? 'bg-bah-accent text-white' : 'bg-bah-panel text-bah-muted'}`}>
                            <Scale className="w-4 h-4" />
                          </div>
                          <div>
                            <h4 className="text-xs font-semibold text-bah-strong">{decision.question}</h4>
                            <span className="text-[11px] text-bah-muted">
                              Evaluated against evidence
                            </span>
                          </div>
                        </div>

                        {isSelected ? (
                          <CheckSquare className="w-5 h-5 text-bah-accent-text shrink-0" />
                        ) : (
                          <Square className="w-5 h-5 text-bah-muted shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Relationship Explanation Card */}
          <div className="p-4 rounded-xl bg-bah-panel-soft border border-bah text-xs space-y-1.5">
            <span className="font-semibold text-bah-strong block">Execution scope:</span>
            <p className="text-bah-muted leading-relaxed">
              {buildExplanation()}
            </p>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 border-t border-bah bg-bah-panel-strong flex flex-col sm:flex-row items-center justify-between gap-3">
          <button
            type="button"
            onClick={handleSaveMonitoring}
            className="bah-button-secondary w-full sm:w-auto px-4 py-2 text-xs font-medium inline-flex items-center justify-center gap-1.5"
          >
            <Eye className="w-3.5 h-3.5 text-bah-accent-text" />
            <span>Save this as a monitoring setup</span>
          </button>

          <button
            type="button"
            onClick={handleRun}
            disabled={!includeCompany && selectedProductIds.length === 0 && selectedDecisionIds.length === 0}
            className="bah-button-primary w-full sm:w-auto px-5 py-2 text-xs font-medium inline-flex items-center justify-center gap-2 shadow-md disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Run intelligence</span>
          </button>
        </div>
      </div>
    </div>
  );
}
