import React, { useState } from 'react';
import { Building2, Plus, ArrowRight, ShieldCheck, Compass, Globe } from 'lucide-react';

export default function EmptyWorkspaceView({
  company,
  onAnchorCompany,
  onAddProduct,
  onAddDecision,
  onRunIntelligence
}) {
  const [urlInput, setUrlInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!urlInput.trim()) return;
    setIsSubmitting(true);
    onAnchorCompany?.({
      url: urlInput.trim(),
      name: nameInput.trim()
    });
  };

  return (
    <div className="space-y-8 max-w-3xl mx-auto">
      {/* Calm Welcome & Company Setup Banner */}
      <div className="bah-panel p-8 md:p-10 rounded-[20px] text-center space-y-5">
        <div className="w-12 h-12 rounded-2xl bg-bah-accent-soft text-bah-accent-strong flex items-center justify-center mx-auto shadow-sm">
          <Compass className="w-6 h-6" />
        </div>

        <div className="space-y-2">
          <h2 className="text-2xl md:text-3xl font-semibold text-bah-strong font-display">
            Welcome to your Intelligence Desk
          </h2>
          <p className="text-sm md:text-base text-bah-muted max-w-xl mx-auto leading-relaxed">
            Tell Bahirjee what company or domain to watch. All product targets, competitor movements, and market shifts anchor to this perimeter.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="max-w-xl mx-auto pt-4 space-y-4 text-left">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-bah-muted mb-1.5">
              Company Website URL *
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-bah-muted">
                <Globe className="w-4 h-4" />
              </div>
              <input
                type="text"
                required
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                placeholder="e.g. caremother.com or https://mycompany.com"
                className="bah-input pl-10 text-sm"
                autoFocus
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-bah-muted mb-1.5">
              Company Name (optional)
            </label>
            <input
              type="text"
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              placeholder="e.g. CareMother"
              className="bah-input text-sm"
            />
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={isSubmitting || !urlInput.trim()}
              className="bah-button-primary w-full py-3 text-sm font-medium inline-flex items-center justify-center gap-2 shadow-lg disabled:opacity-50"
            >
              <ShieldCheck className="w-4 h-4" />
              <span>{isSubmitting ? 'Anchoring Company...' : 'Anchor Company & Begin Intelligence'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </form>
      </div>

      {/* 3 Guided Pillars */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="bah-panel p-6 rounded-[20px] space-y-2.5">
          <div className="w-8 h-8 rounded-lg bg-bah-accent-soft text-bah-accent-strong flex items-center justify-center font-semibold text-sm">
            1
          </div>
          <h3 className="text-sm font-semibold text-bah-strong font-display">
            Company Anchor
          </h3>
          <p className="text-xs text-bah-muted leading-relaxed">
            Your primary domain establishes the strategic baseline. Bahirjee discovers your competitors, market positioning, and core category.
          </p>
        </div>

        <div className="bah-panel p-6 rounded-[20px] space-y-2.5">
          <div className="w-8 h-8 rounded-lg bg-bah-panel-soft text-bah-muted flex items-center justify-center font-semibold text-sm">
            2
          </div>
          <h3 className="text-sm font-semibold text-bah-strong font-display">
            Product Offerings
          </h3>
          <p className="text-xs text-bah-muted leading-relaxed">
            Attach individual product targets with their canonical pages to monitor specialized pricing and competitor moves.
          </p>
        </div>

        <div className="bah-panel p-6 rounded-[20px] space-y-2.5">
          <div className="w-8 h-8 rounded-lg bg-bah-panel-soft text-bah-muted flex items-center justify-center font-semibold text-sm">
            3
          </div>
          <h3 className="text-sm font-semibold text-bah-strong font-display">
            Strategic Inquiries
          </h3>
          <p className="text-xs text-bah-muted leading-relaxed">
            Pose open questions regarding partnerships, expansion, or competitive defense, continuously evaluated against live evidence.
          </p>
        </div>
      </div>
    </div>
  );
}
