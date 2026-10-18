import React, { useState } from 'react';
import { X, ArrowRight, ArrowLeft, Check, ShieldCheck, Upload, FileText, Sparkles, Building2, Package } from 'lucide-react';

export default function AddProductModal({ isOpen, onClose, onSaveProduct, companyName = 'Your Company' }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [canonicalUrl, setCanonicalUrl] = useState('');
  const [linkedinUrl, setLinkedinUrl] = useState('');
  const [uploadedFiles, setUploadedFiles] = useState([]);
  
  // Inferred Context state (Step 3)
  const [inferredCategory, setInferredCategory] = useState('');
  const [inferredTargetCustomer, setInferredTargetCustomer] = useState('');
  const [inferredPositioning, setInferredPositioning] = useState('');
  const [inferredCompetitors, setInferredCompetitors] = useState('');
  const [inferredAssumptions, setInferredAssumptions] = useState('');

  if (!isOpen) return null;

  const handleFileUpload = (e) => {
    const files = Array.from(e.target.files || []);
    const mapped = files.map(f => ({ name: f.name, size: `${(f.size / (1024 * 1024)).toFixed(1)} MB` }));
    setUploadedFiles([...uploadedFiles, ...mapped]);
  };

  const handleSaveOnly = () => {
    onSaveProduct({
      name: name.trim() || 'New Product',
      description: description.trim(),
      canonical_url: canonicalUrl.trim(),
      linkedin_url: linkedinUrl.trim() || null,
      uploaded_docs: uploadedFiles,
      inferred_context: {
        category: inferredCategory.trim(),
        target_customer: inferredTargetCustomer.trim(),
        positioning: inferredPositioning.trim(),
        competitors: inferredCompetitors ? inferredCompetitors.split(',').map(s => s.trim()).filter(Boolean) : [],
        key_assumptions: inferredAssumptions ? [inferredAssumptions.trim()] : []
      },
      runImmediately: false
    });
    onClose();
  };

  const handleSaveAndRun = () => {
    onSaveProduct({
      name: name.trim() || 'New Product',
      description: description.trim(),
      canonical_url: canonicalUrl.trim(),
      linkedin_url: linkedinUrl.trim() || null,
      uploaded_docs: uploadedFiles,
      inferred_context: {
        category: inferredCategory.trim(),
        target_customer: inferredTargetCustomer.trim(),
        positioning: inferredPositioning.trim(),
        competitors: inferredCompetitors ? inferredCompetitors.split(',').map(s => s.trim()).filter(Boolean) : [],
        key_assumptions: inferredAssumptions ? [inferredAssumptions.trim()] : []
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
            <Package className="w-5 h-5 text-bah-accent-text" />
            <h3 className="text-base font-semibold text-bah-strong font-display">
              Add Product Target
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-bah-muted hover:text-bah hover:bg-bah-panel-soft transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step Progression Bar */}
        <div className="px-6 pt-4 pb-2 border-b border-bah/50 bg-bah-panel-soft/30 flex items-center justify-between text-xs text-bah-muted">
          <div className={`flex items-center gap-1.5 ${step >= 1 ? 'text-bah-accent-text font-semibold' : ''}`}>
            <span className="w-5 h-5 rounded-full flex items-center justify-center bg-bah-panel border border-bah text-[11px]">1</span>
            <span>Identity</span>
          </div>
          <span className="w-8 h-[1px] bg-bah" />
          <div className={`flex items-center gap-1.5 ${step >= 2 ? 'text-bah-accent-text font-semibold' : ''}`}>
            <span className="w-5 h-5 rounded-full flex items-center justify-center bg-bah-panel border border-bah text-[11px]">2</span>
            <span>Sources</span>
          </div>
          <span className="w-8 h-[1px] bg-bah" />
          <div className={`flex items-center gap-1.5 ${step >= 3 ? 'text-bah-accent-text font-semibold' : ''}`}>
            <span className="w-5 h-5 rounded-full flex items-center justify-center bg-bah-panel border border-bah text-[11px]">3</span>
            <span>Context</span>
          </div>
          <span className="w-8 h-[1px] bg-bah" />
          <div className={`flex items-center gap-1.5 ${step >= 4 ? 'text-bah-accent-text font-semibold' : ''}`}>
            <span className="w-5 h-5 rounded-full flex items-center justify-center bg-bah-panel border border-bah text-[11px]">4</span>
            <span>Save</span>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-5 flex-1">
          {/* STEP 1: IDENTITY */}
          {step === 1 && (
            <div className="space-y-4 animate-fadeIn">
              <div className="p-3.5 rounded-xl bg-bah-accent-soft text-bah-accent-strong border border-[var(--bah-accent)]/20 text-xs flex items-center gap-2">
                <Building2 className="w-4 h-4 shrink-0" />
                <span>This product belongs to <strong>{companyName}</strong> and automatically inherits its baseline market position and compliance profile.</span>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-bah-muted mb-1.5">
                  Product Name *
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. Analytics Suite, Cloud API, Patient Portal"
                  className="bah-input text-sm"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-bah-muted mb-1.5">
                  Short Description
                </label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="What does this product do, and who are its primary users?"
                  rows={3}
                  className="bah-input text-sm resize-none"
                />
              </div>
            </div>
          )}

          {/* STEP 2: SOURCES & CANONICAL URL */}
          {step === 2 && (
            <div className="space-y-4 animate-fadeIn">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-bah-muted mb-1.5">
                  Canonical Product Webpage URL *
                </label>
                <input
                  type="url"
                  value={canonicalUrl}
                  onChange={e => setCanonicalUrl(e.target.value)}
                  placeholder="https://yourcompany.com/product"
                  className="bah-input text-sm"
                  autoFocus
                />
                <span className="text-[11px] text-bah-muted mt-1 block">
                  The primary page describing product features, pricing tiers, and capabilities.
                </span>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-bah-muted mb-1.5">
                  LinkedIn Product Showcase URL (optional)
                </label>
                <input
                  type="url"
                  value={linkedinUrl}
                  onChange={e => setLinkedinUrl(e.target.value)}
                  placeholder="https://linkedin.com/showcase/your-product"
                  className="bah-input text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-bah-muted mb-1.5">
                  Supporting Documents (optional)
                </label>
                <div className="p-4 rounded-xl border border-dashed border-bah text-center hover:bg-bah-panel-soft transition-colors cursor-pointer relative">
                  <input
                    type="file"
                    multiple
                    onChange={handleFileUpload}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                  />
                  <Upload className="w-5 h-5 text-bah-muted mx-auto mb-1.5" />
                  <span className="text-xs text-bah font-medium block">
                    Upload whitepapers, architecture docs, or pricing sheets
                  </span>
                  <span className="text-[10px] text-bah-muted">PDF or DOCX</span>
                </div>

                {uploadedFiles.length > 0 && (
                  <div className="mt-2 space-y-1">
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
          )}

          {/* STEP 3: CONTEXT SPECIFICATION */}
          {step === 3 && (
            <div className="space-y-4 animate-fadeIn">
              <div className="p-3 rounded-xl bg-bah-panel-soft border border-bah text-xs text-bah-muted flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-bah-accent-text shrink-0" />
                <span>Configure how Bahirjee categorizes this product relative to the broader market.</span>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-bah-muted mb-1.5">
                  Product Category
                </label>
                <input
                  type="text"
                  value={inferredCategory}
                  onChange={e => setInferredCategory(e.target.value)}
                  placeholder="e.g. Enterprise Workflow & Real-Time Monitoring"
                  className="bah-input text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-bah-muted mb-1.5">
                  Target Customer & Buyer Personas
                </label>
                <input
                  type="text"
                  value={inferredTargetCustomer}
                  onChange={e => setInferredTargetCustomer(e.target.value)}
                  placeholder="e.g. Chief Information Officers, Department Directors"
                  className="bah-input text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-bah-muted mb-1.5">
                  Primary Competitors (comma separated)
                </label>
                <input
                  type="text"
                  value={inferredCompetitors}
                  onChange={e => setInferredCompetitors(e.target.value)}
                  placeholder="e.g. Competitor Alpha, Competitor Beta"
                  className="bah-input text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-bah-muted mb-1.5">
                  Key Strategic Assumption to Watch
                </label>
                <input
                  type="text"
                  value={inferredAssumptions}
                  onChange={e => setInferredAssumptions(e.target.value)}
                  placeholder="e.g. Buyers demand on-premise deployment rather than multi-tenant public cloud"
                  className="bah-input text-sm"
                />
              </div>
            </div>
          )}

          {/* STEP 4: CONFIRMATION & EXECUTION */}
          {step === 4 && (
            <div className="space-y-4 animate-fadeIn text-center py-4">
              <div className="w-12 h-12 rounded-full bg-bah-accent-soft text-bah-accent-strong flex items-center justify-center mx-auto shadow-sm">
                <ShieldCheck className="w-6 h-6" />
              </div>
              <h4 className="text-lg font-semibold text-bah-strong font-display">
                Ready to register "{name || 'Product Target'}"
              </h4>
              <p className="text-xs text-bah-muted max-w-md mx-auto leading-relaxed">
                Save this product to your workspace targets now. You can choose to run an immediate intelligence scan or keep it configured for future composite runs.
              </p>

              <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={handleSaveOnly}
                  className="bah-button-secondary w-full sm:w-auto px-5 py-2.5 text-xs font-medium"
                >
                  Save target (0 runs used)
                </button>
                <button
                  type="button"
                  onClick={handleSaveAndRun}
                  className="bah-button-primary w-full sm:w-auto px-5 py-2.5 text-xs font-medium inline-flex items-center justify-center gap-2 shadow-lg"
                >
                  <span>Save and run intelligence</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Modal Navigation Footer */}
        {step < 4 && (
          <div className="px-6 py-4 border-t border-bah bg-bah-panel-strong flex items-center justify-between">
            <button
              type="button"
              disabled={step === 1}
              onClick={() => setStep(step - 1)}
              className="bah-button-ghost px-3 py-1.5 text-xs font-medium inline-flex items-center gap-1 disabled:opacity-30"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back</span>
            </button>

            <button
              type="button"
              disabled={step === 1 && !name.trim()}
              onClick={() => setStep(step + 1)}
              className="bah-button-primary px-4 py-2 text-xs font-medium inline-flex items-center gap-1.5 shadow-md disabled:opacity-50"
            >
              <span>Continue</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
