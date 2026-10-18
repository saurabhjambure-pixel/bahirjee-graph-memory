import React, { useState, useEffect } from 'react';
import { X, Eye, Calendar, AlertTriangle, CheckSquare, Square, Building2, Package, Scale } from 'lucide-react';

export default function MonitoringSetupModal({
  isOpen,
  onClose,
  initialScope = null,
  company,
  products = [],
  decisions = [],
  onSaveSetup
}) {
  const [name, setName] = useState('');
  const [includeCompany, setIncludeCompany] = useState(
    initialScope ? initialScope.company : true
  );
  const [selectedProductIds, setSelectedProductIds] = useState(
    initialScope?.product_ids || products.slice(0, 1).map(p => p.id)
  );
  const [selectedDecisionIds, setSelectedDecisionIds] = useState(
    initialScope?.decision_ids || decisions.slice(0, 1).map(d => d.id)
  );
  const [cadence, setCadence] = useState('Every Monday');
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    if (company?.name && !name) {
      setName(`${company.name} Strategic Watch`);
    }
  }, [company?.name]);

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

  const handleSave = (e) => {
    e.preventDefault();
    onSaveSetup({
      name: name.trim() || `${company?.name || 'Company'} Watch`,
      scope: {
        company: includeCompany,
        product_ids: selectedProductIds,
        decision_ids: selectedDecisionIds
      },
      scope_label: `${company?.name || 'Company'}${selectedProductIds.length > 0 ? ` + ${selectedProductIds.length} products` : ''}`,
      cadence,
      is_active: isActive
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fadeIn">
      <div className="bah-panel-strong w-full max-w-xl rounded-[20px] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-bah flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Eye className="w-5 h-5 text-bah-accent-text" />
            <h3 className="text-base font-semibold text-bah-strong font-display">
              Create Monitoring Setup
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-bah-muted hover:text-bah hover:bg-bah-panel-soft transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSave} className="p-6 overflow-y-auto space-y-5 flex-1">
          {/* Setup Name */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-bah-muted mb-1.5">
              Monitoring Watch Name *
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Core Market Pulse, Enterprise Pricing Watch"
              className="bah-input text-sm"
              autoFocus
            />
          </div>

          {/* Cadence Selection */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-bah-muted mb-1.5">
              Automated Check Cadence
            </label>
            <div className="grid grid-cols-3 gap-2 text-xs">
              {['Every Monday', 'Twice Weekly', 'Daily at 06:00 AM'].map(opt => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setCadence(opt)}
                  className={`p-2.5 rounded-xl border text-center transition-all ${
                    cadence === opt
                      ? 'bg-bah-accent-soft border-[var(--bah-accent)] text-bah-accent-strong font-semibold'
                      : 'bg-bah-panel-soft border-bah text-bah-muted'
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>

          {/* Scope Selection */}
          <div className="space-y-3 pt-2">
            <span className="block text-xs font-semibold uppercase tracking-wider text-bah-muted">
              Scope of Targets Included in this Watch
            </span>

            {/* Company */}
            <button
              type="button"
              onClick={() => setIncludeCompany(!includeCompany)}
              className={`w-full p-3 rounded-xl border text-left flex items-center justify-between text-xs transition-all ${
                includeCompany
                  ? 'bg-bah-accent-soft/30 border-[var(--bah-accent)] text-bah-strong'
                  : 'bg-bah-panel-soft border-bah text-bah-muted'
              }`}
            >
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4 text-bah-accent-text" />
                <span>{company?.name || 'Company Target'} (Company perimeter)</span>
              </div>
              {includeCompany ? (
                <CheckSquare className="w-4 h-4 text-bah-accent-text" />
              ) : (
                <Square className="w-4 h-4 text-bah-muted" />
              )}
            </button>

            {/* Products */}
            {products.map(p => {
              const isSelected = selectedProductIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => toggleProduct(p.id)}
                  className={`w-full p-3 rounded-xl border text-left flex items-center justify-between text-xs transition-all ${
                    isSelected
                      ? 'bg-bah-accent-soft/30 border-[var(--bah-accent)] text-bah-strong'
                      : 'bg-bah-panel-soft border-bah text-bah-muted'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Package className="w-4 h-4 text-bah-cyan" />
                    <span>{p.name} (Product target)</span>
                  </div>
                  {isSelected ? (
                    <CheckSquare className="w-4 h-4 text-bah-accent-text" />
                  ) : (
                    <Square className="w-4 h-4 text-bah-muted" />
                  )}
                </button>
              );
            })}

            {/* Decisions */}
            {decisions.map(d => {
              const isSelected = selectedDecisionIds.includes(d.id);
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => toggleDecision(d.id)}
                  className={`w-full p-3 rounded-xl border text-left flex items-center justify-between text-xs transition-all ${
                    isSelected
                      ? 'bg-bah-accent-soft/30 border-[var(--bah-accent)] text-bah-strong'
                      : 'bg-bah-panel-soft border-bah text-bah-muted'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate pr-2">
                    <Scale className="w-4 h-4 text-bah-accent-text shrink-0" />
                    <span className="truncate">{d.question}</span>
                  </div>
                  {isSelected ? (
                    <CheckSquare className="w-4 h-4 text-bah-accent-text shrink-0" />
                  ) : (
                    <Square className="w-4 h-4 text-bah-muted shrink-0" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Modal Footer */}
          <div className="pt-4 border-t border-bah flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="bah-button-ghost px-4 py-2 text-xs font-medium text-bah-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="bah-button-primary px-5 py-2 text-xs font-medium shadow-md"
            >
              Save monitoring setup
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
