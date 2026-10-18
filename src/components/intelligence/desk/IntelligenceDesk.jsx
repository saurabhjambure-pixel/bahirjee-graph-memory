import React, { useState } from 'react';
import {
  Compass,
  Bell,
  HelpCircle,
  LogOut,
  Play,
  Plus,
  Search
} from 'lucide-react';
import TodayReadCard from './TodayReadCard';
import TargetSection from './TargetSection';
import MonitoringSection from './MonitoringSection';
import RecentRunsTimeline from './RecentRunsTimeline';
import DeskLoadingSkeleton from './DeskLoadingSkeleton';
import EmptyWorkspaceView from './EmptyWorkspaceView';

export default function IntelligenceDesk({
  workspaceData,
  loading = false,
  onAnchorCompany,
  onRunScope,
  onAddProduct,
  onAddDecision,
  onNewAnalysis,
  onCreateMonitoringSetup,
  onToggleMonitoringActive,
  onOpenOverview,
  onEditSources,
  onRunTarget,
  onArchiveProduct,
  onRestoreProduct,
  onSignOut,
  userEmail
}) {
  const [isQuietDay, setIsQuietDay] = useState(false);

  if (loading) {
    return <DeskLoadingSkeleton />;
  }

  const company = workspaceData?.company;
  const products = workspaceData?.products || [];
  const decisions = workspaceData?.decisions || [];
  const monitoringSetups = workspaceData?.monitoringSetups || [];
  const compositeRuns = workspaceData?.compositeRuns || [];
  const todayRead = workspaceData?.todayRead;

  const activeProducts = products.filter(p => p.status !== 'archived');

  // If no company domain has been anchored yet, show the setup view
  if (!company || !company.domain) {
    return (
      <div className="min-h-screen bg-transparent text-bah pb-16">
        <DeskHeader
          companyName={company?.name || 'Your Company'}
          onSignOut={onSignOut}
          userEmail={userEmail}
        />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
          <EmptyWorkspaceView
            company={company}
            onAnchorCompany={onAnchorCompany}
            onAddProduct={onAddProduct}
            onAddDecision={onAddDecision}
            onRunIntelligence={() => onRunScope()}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-transparent text-bah pb-16">
      {/* ── 1. HEADER ────────────────────────────────────────────────── */}
      <DeskHeader
        companyName={company.name || 'Your Company'}
        onSignOut={onSignOut}
        userEmail={userEmail}
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-8">
        {/* ── 2. MAIN WELCOME AREA ────────────────────────────────────── */}
        <div className="bah-panel p-6 md:p-8 rounded-[20px] flex flex-col md:flex-row md:items-center justify-between gap-6 shadow-sm">
          <div className="space-y-1.5 max-w-2xl">
            <h1 className="text-2xl md:text-3xl font-semibold text-bah-strong tracking-tight font-display">
              What is worth your attention today?
            </h1>
            <p className="text-sm md:text-base text-bah-muted leading-relaxed">
              Bahirjee is watching {company.name || 'your company'} and the market perimeter you have established.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => onRunScope()}
              className="bah-button-primary px-5 py-2.5 text-xs md:text-sm font-medium inline-flex items-center gap-2 shadow-lg"
            >
              <Play className="w-4 h-4 fill-current" />
              <span>Run intelligence</span>
            </button>

            {onNewAnalysis && (
              <button
                onClick={onNewAnalysis}
                className="bah-button-secondary px-4 py-2.5 text-xs md:text-sm font-medium inline-flex items-center gap-1.5"
              >
                <Search className="w-4 h-4 text-bah-accent-text" />
                <span>New analysis</span>
              </button>
            )}

            <button
              onClick={onAddProduct}
              className="bah-button-secondary px-4 py-2.5 text-xs md:text-sm font-medium inline-flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4 text-bah-accent-text" />
              <span>Add product</span>
            </button>

            <button
              onClick={onAddDecision}
              className="bah-button-ghost px-3 py-2 text-xs md:text-sm font-medium text-bah-accent-text hover:underline inline-flex items-center gap-1"
            >
              <span>Add decision</span>
            </button>
          </div>
        </div>

        {/* ── 3. TODAY / LATEST READ CARD ─────────────────────────────── */}
        <TodayReadCard
          todayRead={todayRead}
          isQuiet={isQuietDay}
          companyName={company.name}
          onOpenFullRead={() => onOpenOverview?.(compositeRuns[0])}
          onToggleQuietState={() => setIsQuietDay(!isQuietDay)}
        />

        {/* ── 4. INTELLIGENCE SETUP SUMMARY ───────────────────────────── */}
        <div className="bah-panel px-6 py-4 rounded-[20px]">
          <div className="text-[11px] uppercase tracking-wider text-bah-muted font-semibold mb-2">
            Perimeter Setup
          </div>
          <div className="flex flex-wrap items-center gap-4 sm:gap-8 text-xs sm:text-sm">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-bah-accent" />
              <span className="font-semibold text-bah-strong">1 company</span>
              <span className="text-bah-muted text-xs">({company.name})</span>
            </div>

            <div className="h-4 w-[1px] bg-bah hidden sm:block" />

            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-bah-cyan" />
              <span className="font-semibold text-bah-strong">{activeProducts.length} {activeProducts.length === 1 ? 'product' : 'products'}</span>
              {activeProducts.length > 0 && (
                <span className="text-bah-muted text-xs">({activeProducts.map(p => p.name).join(', ')})</span>
              )}
            </div>

            <div className="h-4 w-[1px] bg-bah hidden sm:block" />

            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-bah-accent" />
              <span className="font-semibold text-bah-strong">{decisions.length} {decisions.length === 1 ? 'decision' : 'decisions'}</span>
              <span className="text-bah-muted text-xs">({decisions.length > 0 ? 'active inquiries' : 'none yet'})</span>
            </div>

            <div className="h-4 w-[1px] bg-bah hidden sm:block" />

            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-bah-cyan" />
              <span className="font-semibold text-bah-strong">{monitoringSetups.length} {monitoringSetups.length === 1 ? 'monitoring setup' : 'monitoring setups'}</span>
            </div>
          </div>
        </div>

        {/* ── 5. TARGET SECTIONS ──────────────────────────────────────── */}
        <TargetSection
          company={company}
          products={products}
          decisions={decisions}
          onOpenTarget={(type, target) => {
            if (compositeRuns[0]) onOpenOverview(compositeRuns[0]);
          }}
          onEditSources={onEditSources}
          onRunTarget={onRunTarget}
          onAddProduct={onAddProduct}
          onAddDecision={onAddDecision}
          onArchiveProduct={onArchiveProduct}
          onRestoreProduct={onRestoreProduct}
        />

        {/* ── 6. MONITORING SETUPS ────────────────────────────────────── */}
        <MonitoringSection
          monitoringSetups={monitoringSetups}
          onToggleActive={onToggleMonitoringActive}
          onViewSetup={(setup) => {
            if (compositeRuns[0]) onOpenOverview(compositeRuns[0]);
          }}
          onCreateSetup={onCreateMonitoringSetup}
        />

        {/* ── 7. RECENT RUNS TIMELINE ─────────────────────────────────── */}
        <RecentRunsTimeline
          compositeRuns={compositeRuns}
          onOpenOverview={onOpenOverview}
        />
      </div>
    </div>
  );
}

// ── DESK HEADER HELPER ───────────────────────────────────────────────
function DeskHeader({ companyName, onSignOut, userEmail }) {
  return (
    <header className="border-b border-bah bg-bah-panel-strong/80 backdrop-blur-md sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between gap-4">
        {/* Logo & Workspace Title */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-bah-gradient-cta flex items-center justify-center shadow-sm">
            <Compass className="w-4 h-4 text-bah-strong" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-bah-strong font-display tracking-tight">
                Bahirjee
              </span>
              <span className="text-xs px-2 py-0.5 rounded bg-bah-panel-soft text-bah-accent-text font-medium border border-[var(--bah-accent)]/20">
                Intelligence
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-bah-muted">
              <span className="font-semibold text-bah-strong">{companyName}</span>
              <span>•</span>
              <span>Your intelligence desk</span>
            </div>
          </div>
        </div>

        {/* Top Controls */}
        <div className="flex items-center gap-3">
          {userEmail && (
            <span className="text-xs text-bah-muted hidden md:inline-block">
              {userEmail}
            </span>
          )}

          {onSignOut && (
            <button
              onClick={onSignOut}
              className="p-2 rounded-lg text-bah-muted hover:text-bah-danger hover:bg-red-500/10 transition-colors"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
