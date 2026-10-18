import React, { useState } from 'react';
import {
  Building2,
  Package,
  Scale,
  ExternalLink,
  ShieldCheck,
  AlertTriangle,
  Play,
  Settings2,
  FileText,
  Clock,
  Archive,
  RefreshCw,
  Plus
} from 'lucide-react';

export default function TargetSection({
  company,
  products = [],
  decisions = [],
  onOpenTarget,
  onEditSources,
  onRunTarget,
  onAddProduct,
  onAddDecision,
  onArchiveProduct,
  onRestoreProduct
}) {
  const [showArchivedProducts, setShowArchivedProducts] = useState(false);

  const activeProducts = products.filter(p => p.status !== 'archived');
  const archivedProducts = products.filter(p => p.status === 'archived');
  const displayedProducts = showArchivedProducts ? products : activeProducts;

  return (
    <div className="space-y-8">
      {/* ── 1. COMPANY ANCHOR ────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-bah-accent-text" />
            <h3 className="text-sm font-semibold uppercase tracking-wider text-bah-muted font-display">
              Company Anchor
            </h3>
            <span className="text-xs text-bah-muted font-normal">(Core enterprise perimeter)</span>
          </div>
        </div>

        <div className="bah-panel p-6 rounded-[20px] transition-all hover:border-[var(--bah-accent)]/30">
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                <h4 className="text-lg font-semibold text-bah-strong font-display">
                  {company?.name || 'Company Anchor'}
                </h4>
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-medium bg-bah-panel-soft text-bah-muted border border-bah">
                  Company Intelligence
                </span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-bah-accent-soft text-bah-accent-strong border border-[var(--bah-accent)]/20 inline-flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3" />
                  {company?.domain ? `Watching ${company.domain}` : 'Perimeter active'}
                </span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-bah-cyan-soft text-bah-cyan border border-[var(--bah-cyan)]/20">
                  {company?.monitored_status || 'Monitored'}
                </span>
              </div>

              <p className="text-xs text-bah-muted max-w-2xl leading-relaxed">
                {company?.tagline || (company?.domain ? `Strategic intelligence perimeter for ${company.domain}` : 'Primary company perimeter')}
                {company?.canonical_url && (
                  <> · Canonical URL: <a href={company.canonical_url} target="_blank" rel="noreferrer" className="text-bah-cyan hover:underline font-mono text-[11px]">{company.canonical_url}</a></>
                )}
              </p>

              <div className="flex flex-wrap items-center gap-3 text-xs text-bah-muted pt-1">
                <span><strong>Industry:</strong> {company?.industry || 'Technology & Innovation'}</span>
                <span>•</span>
                <span><strong>Operating Geography:</strong> {company?.operating_geography || 'Global'}</span>
                <span>•</span>
                <span><strong>Regulatory Profile:</strong> {company?.regulatory_profile || 'Standard compliance'}</span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 self-start md:self-center shrink-0">
              <button
                onClick={() => onEditSources?.('company', company)}
                className="bah-button-secondary px-3 py-1.5 text-xs inline-flex items-center gap-1.5"
                title="Manage company sources and website"
              >
                <Settings2 className="w-3.5 h-3.5 text-bah-muted" />
                <span>Edit sources</span>
              </button>
              <button
                onClick={() => onRunTarget?.('company', company)}
                className="bah-button-primary px-3.5 py-1.5 text-xs inline-flex items-center gap-1.5 font-medium shadow-sm"
                title="Run intelligence specifically for company anchor"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Run</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── 2. PRODUCT TARGETS ────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-bah-accent-text" />
            <h3 className="text-sm font-semibold uppercase tracking-wider text-bah-muted font-display">
              Product Targets ({activeProducts.length})
            </h3>
            <span className="text-xs text-bah-muted font-normal">
              (First-class intelligence targets inheriting company anchors)
            </span>
          </div>

          <div className="flex items-center gap-3">
            {archivedProducts.length > 0 && (
              <button
                onClick={() => setShowArchivedProducts(!showArchivedProducts)}
                className="text-xs text-bah-muted hover:text-bah transition-colors inline-flex items-center gap-1"
              >
                <Archive className="w-3 h-3" />
                <span>{showArchivedProducts ? 'Hide archived' : `Show archived (${archivedProducts.length})`}</span>
              </button>
            )}
            <button
              onClick={onAddProduct}
              className="bah-button-secondary px-3 py-1 text-xs inline-flex items-center gap-1 font-medium text-bah"
            >
              <Plus className="w-3 h-3 text-bah-accent-text" />
              <span>Add product</span>
            </button>
          </div>
        </div>

        {activeProducts.length === 0 ? (
          <div className="bah-panel p-8 rounded-[20px] text-center border-dashed border-2 border-bah">
            <Package className="w-8 h-8 text-bah-muted mx-auto mb-2 opacity-60" />
            <h4 className="text-sm font-semibold text-bah-strong mb-1">No products added yet</h4>
            <p className="text-xs text-bah-muted max-w-md mx-auto mb-4">
              Add individual products or service lines to watch their distinct competitors, market signals, and customer feedback.
            </p>
            <button
              onClick={onAddProduct}
              className="bah-button-secondary px-4 py-2 text-xs font-medium inline-flex items-center gap-1.5 shadow-sm"
            >
              <Plus className="w-3.5 h-3.5 text-bah-accent-text" />
              <span>Add your first product</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {displayedProducts.map(product => {
              const isStale = product.source_freshness === 'stale';
              const isArchived = product.status === 'archived';

              return (
                <div
                  key={product.id}
                  className={`bah-panel p-5 rounded-[20px] transition-all flex flex-col justify-between ${
                    isArchived ? 'opacity-65 bg-bah-panel-soft' : 'hover:border-[var(--bah-accent)]/30'
                  }`}
                >
                  <div>
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="text-base font-semibold text-bah-strong font-display">
                            {product.name}
                          </h4>
                          {isArchived ? (
                            <span className="px-2 py-0.5 rounded text-[9px] font-medium bg-bah-panel-soft text-bah-muted border border-bah">
                              Archived
                            </span>
                          ) : product.is_monitored ? (
                            <span className="px-2 py-0.5 rounded text-[9px] font-medium bg-bah-cyan-soft text-bah-cyan border border-[var(--bah-cyan)]/20">
                              Monitored
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded text-[9px] font-medium bg-bah-panel-soft text-bah-muted border border-bah">
                              Manual only
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-bah-muted mt-1 leading-relaxed">
                          {product.tagline || product.description || 'Configured product target'}
                        </p>
                      </div>
                    </div>

                    {/* Freshness & Warning Strip */}
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                      {isStale ? (
                        <span className="px-2 py-0.5 rounded bg-bah-warning-soft text-bah-warning border border-amber-500/30 inline-flex items-center gap-1 font-medium">
                          <AlertTriangle className="w-3 h-3" />
                          Sources stale (&gt;14 days)
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded bg-bah-accent-soft text-bah-accent-strong border border-[var(--bah-accent)]/20 inline-flex items-center gap-1 font-medium">
                          <ShieldCheck className="w-3 h-3" />
                          Verified · {product.sources_count || 1} sources
                        </span>
                      )}

                      {product.canonical_url && (
                        <a
                          href={product.canonical_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-bah-muted hover:text-bah-cyan font-mono text-[10px] inline-flex items-center gap-1 truncate max-w-[200px]"
                        >
                          <span>{product.canonical_url.replace(/^https?:\/\//, '')}</span>
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      )}
                    </div>

                    {/* Latest Intelligence Highlight */}
                    {product.latest_intelligence && (
                      <div className="mt-3 p-3 rounded-xl bg-bah-panel-soft border border-bah text-xs text-bah">
                        <span className="font-semibold text-bah-strong">Latest read: </span>
                        <span>{product.latest_intelligence}</span>
                      </div>
                    )}
                  </div>

                  {/* Actions Strip */}
                  <div className="mt-5 pt-3 border-t border-bah flex items-center justify-between gap-2">
                    {isArchived ? (
                      <button
                        onClick={() => onRestoreProduct?.(product.id)}
                        className="text-xs text-bah-accent-text hover:underline inline-flex items-center gap-1 font-medium"
                      >
                        <RefreshCw className="w-3 h-3" />
                        <span>Restore product</span>
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => onArchiveProduct?.(product.id)}
                          className="text-xs text-bah-muted hover:text-bah-danger transition-colors"
                        >
                          Archive
                        </button>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => onEditSources?.('product', product)}
                            className="bah-button-secondary px-2.5 py-1 text-xs"
                          >
                            Edit sources
                          </button>
                          <button
                            onClick={() => onRunTarget?.('product', product)}
                            className="bah-button-primary px-3 py-1 text-xs inline-flex items-center gap-1 font-medium"
                          >
                            <Play className="w-3 h-3 fill-current" />
                            <span>Run</span>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── 3. STRATEGIC DECISIONS ──────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Scale className="w-4 h-4 text-bah-accent-text" />
            <h3 className="text-sm font-semibold uppercase tracking-wider text-bah-muted font-display">
              Strategic Decisions ({decisions.length})
            </h3>
            <span className="text-xs text-bah-muted font-normal">
              (Live questions evaluated continuously against evidence)
            </span>
          </div>

          <button
            onClick={onAddDecision}
            className="bah-button-secondary px-3 py-1 text-xs inline-flex items-center gap-1 font-medium text-bah"
          >
            <Plus className="w-3 h-3 text-bah-accent-text" />
            <span>Add decision</span>
          </button>
        </div>

        {decisions.length === 0 ? (
          <div className="bah-panel p-8 rounded-[20px] text-center border-dashed border-2 border-bah">
            <Scale className="w-8 h-8 text-bah-muted mx-auto mb-2 opacity-60" />
            <h4 className="text-sm font-semibold text-bah-strong mb-1">No strategic decisions registered yet</h4>
            <p className="text-xs text-bah-muted max-w-md mx-auto mb-4">
              Pose open strategic questions (e.g. pricing changes, new market entry, build vs buy) to evaluate them against verified evidence.
            </p>
            <button
              onClick={onAddDecision}
              className="bah-button-secondary px-4 py-2 text-xs font-medium inline-flex items-center gap-1.5 shadow-sm"
            >
              <Plus className="w-3.5 h-3.5 text-bah-accent-text" />
              <span>Add a strategic decision</span>
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {decisions.map(decision => (
              <div
                key={decision.id}
                className="bah-panel p-5 rounded-[20px] transition-all hover:border-[var(--bah-accent)]/30"
              >
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-medium bg-bah-accent-soft text-bah-accent-strong border border-[var(--bah-accent)]/20">
                        Active Inquiry
                      </span>
                      {decision.confidence && (
                        <span className="text-xs text-bah-muted font-medium">
                          • {decision.confidence}
                        </span>
                      )}
                    </div>

                    <h4 className="text-base font-semibold text-bah-strong font-display">
                      {decision.question}
                    </h4>

                    {decision.latest_judgment && (
                      <p className="text-xs text-bah leading-relaxed pt-1">
                        <strong>Evidence Read:</strong> {decision.latest_judgment}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 self-start md:self-center shrink-0">
                    <button
                      onClick={() => onRunTarget?.('decision', decision)}
                      className="bah-button-primary px-3.5 py-1.5 text-xs inline-flex items-center gap-1.5 font-medium shadow-sm"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Evaluate</span>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
