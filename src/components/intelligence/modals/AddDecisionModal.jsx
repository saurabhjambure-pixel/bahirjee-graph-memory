import React, { useState } from 'react';
import { X, Scale, Building2, Package, Upload, FileText, CheckCircle2 } from 'lucide-react';

export default function AddDecisionModal({
  isOpen,
  onClose,
  onSaveDecision,
  companyName = 'Your Company',
  products = []
}) {
  const [question, setQuestion] = useState('');
  const [includeCompany, setIncludeCompany] = useState(true);
  const [selectedProductIds, setSelectedProductIds] = useState(
    products.slice(0, 1).map(p => p.id)
  );
  const [sourceUrl, setSourceUrl] = useState('');
  const [uploadedFiles, setUploadedFiles] = useState([]);

  if (!isOpen) return null;

  const toggleProduct = (pid) => {
    if (selectedProductIds.includes(pid)) {
      setSelectedProductIds(selectedProductIds.filter(id => id !== pid));
    } else {
      setSelectedProductIds([...selectedProductIds, pid]);
    }
  };

  const handleFileUpload = (e) => {
    const files = Array.from(e.target.files || []);
    const mapped = files.map(f => ({ name: f.name, size: `${(f.size / (1024 * 1024)).toFixed(1)} MB` }));
    setUploadedFiles([...uploadedFiles, ...mapped]);
  };

  const buildLinkedTargets = () => {
    const targets = [];
    if (includeCompany) {
      targets.push({ type: 'company', id: 'company_primary', label: companyName });
    }
    selectedProductIds.forEach(pid => {
      const p = products.find(prod => prod.id === pid);
      if (p) targets.push({ type: 'product', id: p.id, label: p.name });
    });
    return targets;
  };

  const handleSaveOnly = () => {
    if (!question.trim()) return;
    onSaveDecision({
      question: question.trim(),
      linked_targets: buildLinkedTargets(),
      sources: {
        url: sourceUrl.trim() || null,
        documents: uploadedFiles
      },
      runImmediately: false
    });
    onClose();
  };

  const handleSaveAndRun = () => {
    if (!question.trim()) return;
    onSaveDecision({
      question: question.trim(),
      linked_targets: buildLinkedTargets(),
      sources: {
        url: sourceUrl.trim() || null,
        documents: uploadedFiles
      },
      runImmediately: true
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fadeIn">
      <div className="bah-panel-strong w-full max-w-2xl rounded-[20px] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-bah flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Scale className="w-5 h-5 text-bah-accent-text" />
            <h3 className="text-base font-semibold text-bah-strong font-display">
              Add Strategic Decision
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
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
          {/* Decision Question Input */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-bah-muted mb-1.5">
              Strategic Decision Question *
            </label>
            <textarea
              required
              value={question}
              onChange={e => setQuestion(e.target.value)}
              placeholder="e.g. Should we enter the European enterprise market in Q2 or maintain focus on core domestic channels?"
              rows={3}
              className="bah-input text-sm resize-none"
              autoFocus
            />
            <span className="text-[11px] text-bah-muted mt-1 block">
              Pose an active dilemma. Bahirjee evaluates this against live competitor movements, partner announcements, and public signals.
            </span>
          </div>

          {/* Linked Targets Multi-select */}
          <div>
            <span className="block text-xs font-semibold uppercase tracking-wider text-bah-muted mb-2">
              Link to Targets (Scope perimeter)
            </span>
            <div className="space-y-2">
              {/* Company Checkbox */}
              <button
                type="button"
                onClick={() => setIncludeCompany(!includeCompany)}
                className={`w-full p-3 rounded-xl border text-left flex items-center justify-between transition-all ${
                  includeCompany
                    ? 'bg-bah-accent-soft/40 border-[var(--bah-accent)] text-bah-strong'
                    : 'bg-bah-panel-soft border-bah text-bah-muted'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Building2 className="w-4 h-4 text-bah-accent-text" />
                  <span className="text-xs font-semibold">{companyName} (Company Anchor)</span>
                </div>
                <div className={`w-4 h-4 rounded border flex items-center justify-center ${includeCompany ? 'bg-bah-accent border-[var(--bah-accent)] text-white' : 'border-bah'}`}>
                  {includeCompany && <CheckCircle2 className="w-3.5 h-3.5" />}
                </div>
              </button>

              {/* Product Checkboxes */}
              {products.map(product => {
                const isSelected = selectedProductIds.includes(product.id);
                return (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => toggleProduct(product.id)}
                    className={`w-full p-3 rounded-xl border text-left flex items-center justify-between transition-all ${
                      isSelected
                        ? 'bg-bah-accent-soft/40 border-[var(--bah-accent)] text-bah-strong'
                        : 'bg-bah-panel-soft border-bah text-bah-muted'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Package className="w-4 h-4 text-bah-cyan" />
                      <span className="text-xs font-semibold">{product.name}</span>
                    </div>
                    <div className={`w-4 h-4 rounded border flex items-center justify-center ${isSelected ? 'bg-bah-accent border-[var(--bah-accent)] text-white' : 'border-bah'}`}>
                      {isSelected && <CheckCircle2 className="w-3.5 h-3.5" />}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Optional Supporting Sources */}
          <div className="space-y-3">
            <span className="block text-xs font-semibold uppercase tracking-wider text-bah-muted">
              Supporting Context (optional)
            </span>

            <div>
              <input
                type="url"
                value={sourceUrl}
                onChange={e => setSourceUrl(e.target.value)}
                placeholder="https://link-to-relevant-memo-or-market-analysis.com"
                className="bah-input text-xs"
              />
            </div>

            <div className="p-3.5 rounded-xl border border-dashed border-bah text-center hover:bg-bah-panel-soft transition-colors cursor-pointer relative">
              <input
                type="file"
                multiple
                onChange={handleFileUpload}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
              <Upload className="w-4 h-4 text-bah-muted mx-auto mb-1" />
              <span className="text-xs text-bah font-medium block">
                Attach internal decision memos, board slides, or financial models
              </span>
              <span className="text-[10px] text-bah-muted">PDF or DOCX</span>
            </div>

            {uploadedFiles.length > 0 && (
              <div className="space-y-1">
                {uploadedFiles.map((file, i) => (
                  <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-bah-panel-soft text-xs text-bah">
                    <span className="truncate">{file.name}</span>
                    <span className="text-[10px] text-bah-muted">{file.size}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 border-t border-bah bg-bah-panel-strong flex flex-col sm:flex-row items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="bah-button-ghost px-4 py-2 text-xs font-medium text-bah-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!question.trim()}
            onClick={handleSaveOnly}
            className="bah-button-secondary px-4 py-2 text-xs font-medium disabled:opacity-50"
          >
            Save decision (0 runs used)
          </button>
          <button
            type="button"
            disabled={!question.trim()}
            onClick={handleSaveAndRun}
            className="bah-button-primary px-5 py-2 text-xs font-medium shadow-md disabled:opacity-50"
          >
            Save and evaluate now
          </button>
        </div>
      </div>
    </div>
  );
}
