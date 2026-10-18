import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, History, LogOut, Menu, MoreVertical, Plus, Search, Shield, Sparkles, X, Share2, Check } from 'lucide-react';
import StrategicAwarenessSurface from '../StrategicAwarenessSurface';
import NewsThatMatters from './NewsThatMatters';
import StrategicInteractionHub from './StrategicInteractionHub';
import EvidenceBase from './EvidenceBase';
import BriefJudgment from './BriefJudgment';
import LiveActivityRail, { LiveAnnouncer } from './LiveActivityRail';
import { SignalSkeleton, JudgmentForming } from './LiveSkeletons';
import LiveHunt, { HuntSummary } from './LiveHunt';
import DepthDisclosure from './DepthDisclosure';
import AssumptionTracker from './AssumptionTracker';
import PremiumUpgradeModal from '../Modals/PremiumUpgradeModal';
import ErrorBoundary from '../common/ErrorBoundary';
import { ConfirmDialog } from '../common/Modal';
import { trackConversionClick } from '../../services/interactionService';
import { getOrCreateShareToken } from '../../services/reportService';
import { groupSectionsForDisplay, splitSectionSignals } from '../../services/signalTaxonomy';

/**
 * Did anything actually get SKIPPED, or was the run complete but flagged?
 *
 * The banner used to say "the run hit its time budget" for every degradation, including a
 * brief-attestation note — which fires on a run that finished all its work and merely used
 * a word the voice policy bans. That told the founder their brief was thin when it was not,
 * and advised a re-run that would reproduce the same note. A disclosure surface that
 * misreports the reason is worse than none: it spends trust to deliver a falsehood.
 */
const RE_WORK_SKIPPED = /time budget|budget ran out|out of time|were skipped|could not be read|stopped/i;
const wasWorkSkipped = (degradations = []) =>
    degradations.some(d => RE_WORK_SKIPPED.test(`${d?.reason || ''} ${d?.impact || ''}`));


// Where "Upgrade to Premium" actually goes.
//
// Set VITE_UPGRADE_URL to a Stripe Payment Link (or any checkout URL) to send people
// straight there. Until one exists this falls back to a real contact route rather than a
// link to a page that does not exist — and a mailto is a perfectly good checkout at beta
// volume, because it buys a conversation with every early user.
const UPGRADE_CONTACT_EMAIL = import.meta.env.VITE_UPGRADE_CONTACT_EMAIL || 'hello@bahirjee.com';
const UPGRADE_URL = import.meta.env.VITE_UPGRADE_URL || '';

// TEMPORARY: a handful of reports are being sent to founders for review — hide the action
// that would let a reviewer kick off (or accidentally consume) a fresh run. Flip back to
// false to restore the button. Founders never see this component with isViewerMode=true
// (that's the shared-link path, which already hides this whole header), so this flag is
// the only thing gating it.
const HIDE_NEW_ANALYSIS_FOR_FOUNDERS = true;

export default function ReportWorkspace({
  // Live mode: the run is still executing and `finalReport` is the assembled live slice
  // rather than a persisted report. Sections fill in as signals are analyzed.
  isLive = false,
  liveStatusMsg = '',
  liveStartedAt = null,
  liveSignalCount = 0,
  liveBriefReady = false,
  liveHunt = null,
  historyOpen,
  setHistoryOpen,
  filteredHistory,
  loadReport,
  searchTerm,
  setSearchTerm,
  selectedMonth,
  setSelectedMonth,
  availableMonths = [],
  sidebarOpen,
  setSidebarOpen,
  sections = [],
  activeSection,
  setActiveSection,
  finalReport,
  reportFilter,
  setReportFilter,
  setPhase,
  signOut,
  activeData,
  handleV6React,
  renderInsightCard,
  renderSignalCard,
  handleQnA,
  handleShareSignal,
  isPremium,
  isViewerMode = false,
  reportId,
  userId,
  runCount = 0,
  onTrackAssumptions
}) {
  const contextIndustry =
    finalReport?.context?.strategic_anchors?.industry ||
    finalReport?.context?.industry ||
    finalReport?.industry ||
    'Unknown sector';
  const websiteUrl = finalReport?.inputs?.websiteUrl || 'No domain provided';
  const isDecisionBrief = finalReport?.reportKind === 'decision' || finalReport?.report_kind === 'decision';
  const decisionFrame = finalReport?.decisionContext || finalReport?.decision_context || null;
  const decisionBrief = finalReport?.decisionBrief || finalReport?.decision_brief || (isDecisionBrief ? finalReport?.brief : null);

  // Research depth. `depth_gaps` comes straight off a just-finished run; `depthGaps` is
  // derived from run_tier when a persisted report is reloaded (it is a pure function of
  // the tier, so it is never stored). Reports written before v24 have neither and were
  // all full-depth runs.
  const reportRunTier = finalReport?.runTier || finalReport?.run_tier || 'full';
  const reportDepthGaps = finalReport?.depth_gaps || finalReport?.depthGaps || [];

  const [copied, setCopied] = useState(false);
  const [shareError, setShareError] = useState('');
  const [sharing, setSharing] = useState(false);
  const [showNewAnalysisConfirm, setShowNewAnalysisConfirm] = useState(false);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const isHistoryFiltered = Boolean(searchTerm) || (selectedMonth && selectedMonth !== 'All');

  // Per-section high-water mark of what the founder has actually looked at, so a section
  // that grew while they were reading elsewhere can say so. Cleared implicitly when the
  // run ends, because `isLive` gates every read of it.
  const [seenCounts, setSeenCounts] = useState({});

  // How many cards each section has already displayed. A poll every 3 seconds rebuilds
  // the signal arrays, and without this every card in view would re-run its entry
  // animation on every tick — the section would strobe rather than grow. A ref, not
  // state: it must not itself cause a render.
  const shownCountsRef = useRef({});

  // Below md the sidebar is an overlay with no scrim, so leaving it open after a
  // selection hides the very section the founder just picked.
  const selectSection = (sectionId) => {
    setActiveSection(sectionId);
    markSectionSeen(sectionId);
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 768px)').matches) {
      setSidebarOpen(false);
    }
  };

  const normalizedSections = groupSectionsForDisplay(sections);

  const markSectionSeen = (sectionId) => {
    const sec = normalizedSections.find(x => x.id === sectionId);
    setSeenCounts(prev => ({ ...prev, [sectionId]: sec?.meta?.count || 0 }));
  };

  // Read before paint, written after: `alreadyShown` is what this section displayed on the
  // previous render, so anything past it is genuinely new this tick.
  const alreadyShown = shownCountsRef.current[activeSection] ?? 0;

  // Write the watermark back after paint, so the next tick knows what was already shown.
  useEffect(() => {
    if (!isLive) {
      shownCountsRef.current = {};
      return;
    }
    const current = normalizedSections.find(sec => sec.id === activeSection);
    shownCountsRef.current[activeSection] = current?.subsections?.length ?? 0;
  });

  // The section currently on screen is by definition seen, so its badge must clear as it
  // grows rather than accumulating an "unseen" count the founder is actively reading.
  useEffect(() => {
    if (!isLive) return;
    const current = normalizedSections.find(sec => sec.id === activeSection);
    if (!current) return;
    const count = current.meta?.count || 0;
    setSeenCounts(prev => (prev[activeSection] === count ? prev : { ...prev, [activeSection]: count }));
  });


  // The sidebar is rendered from normalizedSections (grouped), so activeSection can be a
  // grouped id (e.g. "group-competition") that the parent's ungrouped `sections`/`activeData`
  // prop never had — which left every grouped section's body blank. Resolve the active view
  // from the grouped list, which carries the merged sub-signals; fall back to the raw prop.
  const activeGrouped = normalizedSections.find(s => s.id === activeSection) || activeData;
  const introInsights = activeGrouped?.insights || [];
  // Current events lead the section; context follows in its original order.
  //
  // A stable partition, not a sort: within each band the pipeline's ordering is
  // preserved, so this cannot silently re-rank a section that was already ordered by
  // relevance. Signals with no temporal_role (every card in a report written before v27)
  // all land in the same band and therefore keep their existing order exactly.
  //
  // A section with a trailing group (Funding → Capital climate) renders its main signals
  // first and the trailing group after a heading, each band-ordered on its own, so a
  // current capital-climate item can never jump above an opportunity.
  const { sectionSignals, trailingStart, trailingLabel, emptyPrimaryNote } = useMemo(() => {
    const bandOrder = (list) => {
      const anchors = list.filter(s => s?.temporal_role === 'anchor');
      if (anchors.length === 0 || anchors.length === list.length) return list;
      return [...anchors, ...list.filter(s => s?.temporal_role !== 'anchor')];
    };
    const split = splitSectionSignals(activeGrouped?.title, activeGrouped?.subsections || []);
    return {
      sectionSignals: [...bandOrder(split.primary), ...bandOrder(split.trailing)],
      trailingStart: split.trailing.length > 0 ? split.primary.length : -1,
      trailingLabel: split.trailingLabel,
      emptyPrimaryNote: split.emptyPrimaryNote,
    };
  }, [activeGrouped]);

  // Every upgrade CTA in the report surface routes here. Previously three of them had
  // no onClick at all and the fourth redirected to /pricing, which is not a route — so
  // it hit the catch-all and bounced the founder back to the dashboard.
  const openUpgrade = (gateName = 'upgrade_cta') => {
    trackConversionClick?.(reportId, userId, gateName)?.catch?.(() => {});
    setUpgradeModalOpen(true);
  };

  const handleNewAnalysisClick = () => {
    // Check the gate before asking for confirmation — otherwise the founder confirms
    // an action they are not allowed to take, and only then meets the paywall.
    if (!isPremium && !isViewerMode && Number(runCount) >= 1) {
      openUpgrade('new_analysis_upgrade');
      return;
    }
    setShowNewAnalysisConfirm(true);
  };

  const confirmNewAnalysis = () => {
    setShowNewAnalysisConfirm(false);
    setPhase('idle');
  };

  const cancelNewAnalysis = () => {
    setShowNewAnalysisConfirm(false);
  };
  const handleShareBrief = async () => {
      setShareError('');
      setSharing(true);
      try {
          // Resolve a real per-report token. Prefer the one already on the report;
          // otherwise fetch/backfill it from the DB. Never silently fall back to the
          // dashboard URL — that produced a link that opened no specific brief.
          let token = finalReport?.share_token;
          if (!token && reportId) {
              const { token: resolved, error } = await getOrCreateShareToken(reportId);
              if (error || !resolved) throw error || new Error('No share token');
              token = resolved;
          }
          if (!token) throw new Error('This brief has not been saved yet, so it cannot be shared.');

          const shareUrl = `${window.location.origin}/report/${token}`;
          await navigator.clipboard.writeText(shareUrl);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
      } catch (err) {
          console.error('Share Brief failed:', err);
          setShareError(err?.message || 'Could not create a shareable link. Please try again.');
          setTimeout(() => setShareError(''), 4000);
      } finally {
          setSharing(false);
      }
  };

  return (
    // h-dvh, not h-dvh: on iOS Safari h-dvh is the *large* viewport height,
    // so the browser chrome clipped the bottom of the scroll region.
    <div className="flex flex-col h-dvh text-bah font-sans overflow-hidden">
      {/* Scrim behind the history drawer — it had none, so on mobile the drawer
          floated over the brief with no way to read that it was modal. */}
      {!isViewerMode && historyOpen && (
        <div
          onClick={() => setHistoryOpen(false)}
          className="fixed inset-0 bg-black/40 z-40 animate-fade-in"
          aria-hidden="true"
        />
      )}
      {!isViewerMode && (
        <div className={`fixed inset-y-0 right-0 w-full max-w-sm bg-bah-panel-strong backdrop-blur-glass border-l border-bah z-50 transform transition-transform duration-300 shadow-clay-lg ${historyOpen ? 'translate-x-0' : 'translate-x-full'}`}>
          <div className="p-4 border-b border-bah flex flex-col gap-4 bg-bah-panel-strong">
            <div className="flex justify-between items-center">
            <h3 className="text-sm font-bold uppercase tracking-widest text-bah-muted flex items-center gap-2"><History className="w-4 h-4" /> Memory Ledger</h3>
            <button onClick={() => setHistoryOpen(false)}><X className="w-5 h-5 text-bah-muted hover:text-bah-strong" /></button>
          </div>
          <div className="space-y-3">
            <div className="relative">
              <input
                type="text"
                placeholder="Search memory snapshots..."
                value={searchTerm}
                className="bah-input text-xs pl-8 px-3"
                onChange={(e) => setSearchTerm(e.target.value)}
              />
              <Search className="w-3 h-3 text-bah-muted absolute left-3 top-2.5" />
            </div>

            <div className="relative">
              <select
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
                className="bah-input text-xs px-3 text-bah appearance-none cursor-pointer"
              >
                {availableMonths.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <div className="p-2 space-y-1 overflow-y-auto h-full pb-20">
          {/* "No results" and "you have never run one" are different states — showing the
              search-failed copy to a first-time founder reads as a broken feature. */}
          {filteredHistory.length === 0 && (
            isHistoryFiltered ? (
              <div className="text-center text-bah-muted-2 text-xs py-4">No matching snapshots found</div>
            ) : (
              <div className="text-center px-4 py-8">
                <History className="w-8 h-8 text-bah-muted-2 mx-auto mb-3" />
                <p className="text-bah-muted text-xs mb-1">No briefs yet</p>
                <p className="text-bah-muted-2 text-[11px] leading-relaxed">
                  Every analysis you run is saved here, so you can track how your market moves over time.
                </p>
              </div>
            )
          )}
          {filteredHistory.map(h => (
            <button key={h.id} onClick={() => loadReport(h)} className="w-full text-left p-4 rounded-lg hover:bg-bah-panel-soft group border border-transparent hover:border-bah transition-all">
              <div className="font-semibold text-bah text-sm mb-1">{h.reportKind === 'decision' ? (h.decisionContext?.decision_statement || 'Decision brief') : (h.inputs?.websiteUrl || h.target_domain || 'Intelligence Brief')}</div>
              <div className="flex justify-between items-center text-[10px] text-bah-muted">
                <span>{h.reportKind === 'decision' ? 'Decision brief · ' : ''}{new Date(h.timestamp).toLocaleDateString()} {new Date(h.timestamp).toLocaleTimeString()}</span>
                <span className="group-hover:text-bah-accent opacity-0 group-hover:opacity-100 transition-opacity">Load Brief →</span>
              </div>
            </button>
          ))}
        </div>
      </div>
      )}

      {/* Workspace Header - Hidden in Viewer Mode since ReportViewer provides its own header */}
      {!isViewerMode && (
        <header className="h-16 bg-bah-panel-strong-80 backdrop-blur-md border-b border-bah flex items-center justify-between px-6 z-20 shrink-0">
        <div className="flex items-center gap-4">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-2 md:hidden text-bah-muted"><Menu className="w-5 h-5" /></button>
          <div className="flex flex-col">
            <div className="flex items-center gap-2"><Shield className="w-4 h-4 text-bah-accent" /><span className="font-display font-semibold text-bah-strong">{isDecisionBrief ? 'Decision Brief' : 'Intelligence Brief'}</span></div>
            <div className="text-[10px] text-bah-muted font-medium uppercase tracking-wider pl-6">{contextIndustry} :: {websiteUrl}</div>
          </div>
        </div>

        <div className="hidden md:flex flex-1 max-w-md mx-8 relative group">
          <div className="absolute inset-0 bg-bah-accent-soft rounded-lg blur opacity-0 group-focus-within:opacity-100 transition-opacity"></div>
          <input
            value={reportFilter}
            onChange={(e) => setReportFilter(e.target.value)}
            placeholder="Search for keywords across this report..."
            className="w-full bg-bah-bg border border-bah rounded-lg px-4 py-2 text-xs text-bah-strong placeholder-bah-muted-2 focus:border-[var(--bah-accent)]/50 outline-none relative z-10 transition-all focus:bg-bah-panel"
          />
          <Search className="w-3 h-3 text-bah-muted-2 absolute right-3 top-2.5 z-10" />
        </div>

        <div className="flex items-center gap-2">
          <button onClick={handleShareBrief} disabled={sharing} title={shareError || undefined} className={`hidden sm:flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-clay transition-colors border ${shareError ? 'text-bah-danger bg-red-500/10 border-red-500/30' : 'text-bah bg-bah-panel-soft hover:bg-bah-panel-soft border-bah'} ${sharing ? 'opacity-60 cursor-wait' : ''}`}>
              {shareError ? <X className="w-3.5 h-3.5 text-bah-danger" /> : copied ? <Check className="w-3.5 h-3.5 text-bah-accent-strong" /> : <Share2 className="w-3.5 h-3.5" />}
              {shareError ? 'Share failed' : sharing ? 'Creating link…' : copied ? 'Link Copied' : 'Share Brief'}
          </button>
          <div className="w-px h-6 bg-bah-panel-soft mx-1 hidden sm:block"></div>
          <button onClick={() => setHistoryOpen(true)} aria-label="Open brief history" className="p-2 text-bah-muted hover:text-bah-strong hover:bg-bah-panel-soft rounded-clay transition-colors"><History className="w-5 h-5" /></button>
          {isPremium && (
            <button onClick={() => setPhase('review_context')} className="hidden sm:flex bah-button-secondary text-xs px-3 py-1.5 text-bah-accent border-[var(--bah-accent)]/30 hover:bg-bah-accent-soft">Modify Context</button>
          )}
          {!HIDE_NEW_ANALYSIS_FOR_FOUNDERS && (
            <button onClick={handleNewAnalysisClick} className="bah-button-primary text-xs px-3 py-1.5 flex items-center gap-1">
              <Plus className="w-3 h-3" />{' '}
              <span className="hidden xs:inline sm:inline">{isDecisionBrief ? 'Revisit Decision' : 'New Analysis'}</span>
              <span className="xs:hidden sm:hidden">{isDecisionBrief ? 'Revisit' : 'New'}</span>
            </button>
          )}

          {/* Below sm, Share / Modify Context / report search were simply `hidden` —
              the core actions did not exist on mobile at all. They live here instead. */}
          <div className="relative sm:hidden">
            <button
              onClick={() => setMobileMenuOpen(v => !v)}
              aria-label="More actions"
              aria-expanded={mobileMenuOpen}
              className="p-2 text-bah-muted hover:text-bah-strong hover:bg-bah-panel-soft rounded-clay transition-colors"
            >
              <MoreVertical className="w-5 h-5" />
            </button>
            {mobileMenuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMobileMenuOpen(false)} aria-hidden="true" />
                <div className="absolute right-0 top-full mt-2 w-56 bah-panel p-2 z-40 animate-scale-in origin-top-right">
                  <button onClick={() => { setMobileMenuOpen(false); handleShareBrief(); }} className="w-full text-left px-3 py-2 rounded-clay text-sm text-bah hover:bg-bah-panel-soft flex items-center gap-2">
                    <Share2 className="w-4 h-4 text-bah-muted" /> {copied ? 'Link copied' : 'Share brief'}
                  </button>
                  {isPremium && (
                    <button onClick={() => { setMobileMenuOpen(false); setPhase('review_context'); }} className="w-full text-left px-3 py-2 rounded-clay text-sm text-bah hover:bg-bah-panel-soft flex items-center gap-2">
                      <Shield className="w-4 h-4 text-bah-muted" /> Modify context
                    </button>
                  )}
                  <div className="px-3 py-2">
                    <label htmlFor="report-search-mobile" className="sr-only">Search this report</label>
                    <input
                      id="report-search-mobile"
                      value={reportFilter}
                      onChange={(e) => setReportFilter(e.target.value)}
                      placeholder="Search this report…"
                      className="bah-input text-xs"
                    />
                  </div>
                  <button onClick={() => { setMobileMenuOpen(false); signOut(); }} className="w-full text-left px-3 py-2 rounded-clay text-sm text-bah-danger hover:bg-bah-danger-soft flex items-center gap-2">
                    <LogOut className="w-4 h-4" /> Sign out
                  </button>
                </div>
              </>
            )}
          </div>

          <button onClick={signOut} aria-label="Sign out" className="hidden sm:block p-2 text-bah-muted hover:text-bah-danger hover:bg-bah-panel-soft rounded-clay transition-colors" title="Sign Out"><LogOut className="w-5 h-5" /></button>
        </div>
      </header>
      )}

      <div className="flex flex-1 overflow-hidden relative">
        {/* Mobile scrim for the section sidebar — it overlays content below md. */}
        {sidebarOpen && (
          <div
            onClick={() => setSidebarOpen(false)}
            className="md:hidden fixed inset-0 bg-black/30 z-[5] animate-fade-in"
            aria-hidden="true"
          />
        )}
        <aside className={`absolute md:relative z-10 h-full bg-bah-panel-strong backdrop-blur-glass border-r border-bah transition-all duration-300 ${sidebarOpen ? 'w-64 translate-x-0' : 'w-0 -translate-x-full md:w-64 md:translate-x-0'} flex flex-col`}>
          <div className="flex-1 overflow-y-auto p-3 space-y-1 custom-scrollbar pb-20">
            <nav aria-label="Report sections">
            <div className="text-[10px] font-bold text-bah-muted-2 uppercase tracking-widest mb-4 pl-3 mt-4">Sections</div>
            {/* No per-section locks. The paywall is research DEPTH, not which sections you
                may open — and gating by section index hid Talent/Partnerships/Adjacent,
                which are usually the thinnest sections in a brief, while giving away the
                two that matter most. See DepthDisclosure. */}
            {normalizedSections.map((section) => {
              // A section the founder has not opened since its count grew carries an unseen
              // badge. This is the whole "sections light up one by one" effect, and it is
              // also the ONLY thing that moves when a signal lands somewhere the founder is
              // not looking — no scrolling, no switching, no modal. Stealing focus is what
              // separates a report that feels alive from one that feels hostile.
              const count = section.meta?.count || 0;
              const unseen = isLive && count > (seenCounts[section.id] || 0) && section.id !== activeSection;
              return (
                <button
                  key={section.id}
                  onClick={() => selectSection(section.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all flex items-center justify-between ${activeSection === section.id ? 'bg-bah-accent-soft text-bah-accent border border-[var(--bah-accent)]/20' : 'text-bah-muted hover:text-bah'} ${unseen ? 'bah-sweep' : ''}`}
                >
                  <span className="font-medium truncate pl-1 flex items-center gap-2">
                    {section.title}
                    {unseen && <span className="text-[9px] uppercase tracking-wide text-bah-accent font-semibold">New</span>}
                  </span>
                  {section.meta && (
                    <span
                      key={count}
                      className={`font-num text-[10px] px-1.5 py-0.5 rounded-full ${unseen ? 'bah-count-pop ' : ''}${activeSection === section.id ? 'bg-bah-accent-soft text-bah-accent' : 'bg-bah-panel-soft text-bah-muted-2'}`}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
            </nav>
          </div>
        </aside>

        {/* Transparent so the aurora wash reads through — the content sits on
            glass cards rather than on an opaque slab. */}
        <main className="flex-1 overflow-y-auto relative w-full p-6 md:p-10 scroll-smooth">
          <div className="max-w-4xl mx-auto min-h-full pb-20">
            {/* The engine's own voice while the report assembles. Announced politely for
                screen readers too, so arrival is not a visual-only event. */}
            {isLive && (
              <div className="mb-6">
                <LiveActivityRail
                  statusMsg={liveStatusMsg}
                  startedAt={liveStartedAt}
                  signalCount={liveSignalCount}
                />
                <LiveAnnouncer signalCount={liveSignalCount} isComplete={false} />
              </div>
            )}
            {/* Asking and sharing are not part of any one section — they are how the
                founder talks back to the whole brief. This used to render only inside the
                intro branch, so it vanished the moment they opened any other ring: the one
                place they had just formed a question was the one place they could not ask
                it. It sits above the section content deliberately. */}
            <StrategicInteractionHub
              onAsk={handleQnA}
              onShareSignal={handleShareSignal}
              isPremium={isPremium}
              reportId={reportId}
              userId={userId}
              onUpgrade={openUpgrade}
            />

            <ErrorBoundary variant="inline" title="This section could not be displayed">
              <div className="animate-in fade-in duration-300">
              {activeGrouped?.type === 'intro' && (
                <div className="space-y-6">
                  {/* A run that could not finish everything says so here. Without this the
                      brief looks complete no matter how much evidence was skipped. */}
                  {Array.isArray(finalReport?.degradations) && finalReport.degradations.length > 0 && (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="w-4 h-4 text-bah-warning mt-0.5 shrink-0" />
                        <div className="flex-1">
                          <div className="text-bah-warning text-sm font-medium mb-1">
                            {wasWorkSkipped(finalReport.degradations) ? 'This brief is partial' : 'Notes on this brief'}
                          </div>
                          <p className="text-bah-warning text-xs mb-2">
                            {wasWorkSkipped(finalReport.degradations)
                              ? 'The run hit its time budget, so some work was skipped. Re-running usually produces a fuller brief.'
                              : 'The run completed. These notes describe how the brief was produced — re-running will not change them.'}
                          </p>
                          <ul className="space-y-1">
                            {finalReport.degradations.map((d, i) => (
                              <li key={i} className="text-bah-warning text-xs">
                                <span className="text-bah-warning">{d.step}:</span> {d.impact || d.reason}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* What kinds of source this brief rests on. Sits with the degradation
                      banner because the two answer the same question from opposite sides:
                      what the run missed, and what it actually read. */}
                  <EvidenceBase signals={finalReport?.signals} />

                  {/* How much research this rests on. Sits immediately after the evidence
                      base and before the brief itself, because it is the frame the reader
                      needs to weigh everything below it. */}
                  <div className="mt-4">
                    <DepthDisclosure
                      runTier={reportRunTier}
                      depthGaps={reportDepthGaps}
                      reportId={reportId}
                      userId={userId}
                      onUpgrade={isPremium ? null : openUpgrade}
                    />
                  </div>

                  {/* The judgment surface, identical for company and decision runs.
                      Replaces the decision-only block that used to live here and the bare
                      observation hero below — the unification made visible. */}
                  {/* The first ~2 minutes. Real work, shown honestly, in the space the
                      judgment will eventually occupy. Recedes to a one-line receipt the
                      moment there are signals worth reading instead. */}
                  {isLive && liveSignalCount === 0 && (
                    <div className="mb-6">
                      <LiveHunt context={finalReport?.context} hunt={liveHunt} />
                    </div>
                  )}

                  {isLive && !finalReport?.brief
                    ? (
                      <>
                        <JudgmentForming signalCount={liveSignalCount} briefReady={liveBriefReady} />
                        {liveSignalCount > 0 && (
                          <div className="mt-3 px-1"><HuntSummary hunt={liveHunt} /></div>
                        )}
                      </>
                    )
                    : <BriefJudgment brief={finalReport?.brief} decisionFrame={decisionFrame} />}

                  {introInsights.length > 0 && (
                    <div className="mb-10">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-bah-muted mb-4 flex items-center gap-2">
                        <Shield className="w-4 h-4" /> Startup Snapshot
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {introInsights.map((insight, i) => renderInsightCard(insight, i))}
                      </div>
                    </div>
                  )}



                  {finalReport?.v6 && (
                    <div className="mb-8">
                      <StrategicAwarenessSurface v6Data={finalReport.v6} onReact={handleV6React} />
                    </div>
                  )}

                  {/* Saved with the report (v28), so it renders on reload and on a shared
                      link. Hidden mid-run (news is ranked in the last step) and on a report
                      that never recorded news — either way an empty section would state a
                      conclusion the run did not reach. */}
                  {!isLive && Array.isArray(finalReport?.newsItems) && (
                    <NewsThatMatters items={finalReport.newsItems} />
                  )}

                  {/* Intro insights moved to Snapshot section above */}
                </div>
              )}

              {activeGrouped && activeGrouped.type !== 'intro' && (
                <div className="space-y-8">
                  <div className="border-b border-bah pb-6 mb-8 flex justify-between items-end">
                    <h2 className="text-display-sm sm:text-display font-display font-semibold text-bah-strong">{activeGrouped.title}</h2>
                  </div>
                  {sectionSignals.length === 0 ? (
                    isLive ? (
                      // Mid-run, an empty ring means "not analyzed yet" — saying "nothing
                      // detected" here would state a conclusion the run has not reached.
                      <div className="space-y-6">
                        <SignalSkeleton />
                        <SignalSkeleton />
                      </div>
                    ) : (
                      <div className="bg-bah-panel rounded-xl border border-bah p-12 text-center text-bah-muted italic">
                        No material shifts detected in this ring.
                      </div>
                    )
                  ) : (
                    <div className="space-y-6">
                      {/* openUpgrade is passed down so the per-signal paywall CTA has a
                          real destination — ReportWorkspace owns the upgrade modal. */}
                      {sectionSignals.map((signal, idx) => {
                        // The arrival cascade, applied ONLY to cards this section has not
                        // shown before. A finished report never animates, and a card the
                        // founder is already reading does not re-animate under it.
                        const isNew = isLive && idx >= alreadyShown;
                        const card = renderSignalCard(signal, idx, handleQnA, reportFilter, openUpgrade);
                        const cardKey = signal.source_url ? `${signal.source_url}-${idx}` : idx;
                        const heading = idx === trailingStart ? (
                          <div className="pt-2 space-y-1">
                            {trailingStart === 0 && emptyPrimaryNote && (
                              <p className="text-sm text-bah-muted italic">{emptyPrimaryNote}</p>
                            )}
                            <h4 className="text-bah-muted text-[10px] uppercase tracking-wider font-bold">{trailingLabel}</h4>
                          </div>
                        ) : null;
                        const body = !isNew ? card : (
                          <div
                            className="bah-signal-enter bah-bloom rounded-[var(--bah-radius-lg)]"
                            // Capped so a large batch does not leave its last card waiting
                            // seconds to appear.
                            style={{ '--bah-stagger': `${Math.min(idx - alreadyShown, 8) * 60}ms` }}
                          >
                            {card}
                          </div>
                        );
                        return <React.Fragment key={cardKey}>{heading}{body}</React.Fragment>;
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
            </ErrorBoundary>
          </div>

          <div className="mt-20 pt-8 border-t border-bah text-center">
            <div className="flex items-center justify-center gap-2 opacity-50 mb-2">
              <Sparkles className="w-4 h-4 text-bah-accent" />
              <span className="text-xs font-medium text-bah-muted">Prepared by Bahirjee Intelligence Agent</span>
            </div>
            <p className="text-[10px] text-bah-muted-2 max-w-md mx-auto mb-4">
              AI-generated strategic intelligence can contain inaccuracies. Verify critical signals before taking market action.
            </p>
            <a href="/" className="inline-block text-xs font-semibold text-bah-accent border border-bah-accent/30 rounded-full px-4 py-1.5 hover:bg-bah-accent-soft transition-colors cursor-pointer">
              Generate intelligence for your startup
            </a>
          </div>
        </main>
      </div>

      <ConfirmDialog
        open={showNewAnalysisConfirm}
        onClose={cancelNewAnalysis}
        onConfirm={confirmNewAnalysis}
        title="Start a new analysis?"
        description="This resets the current report view. Your saved briefs stay in the history drawer."
        confirmLabel="Start new analysis"
        cancelLabel="Keep this brief"
      />

      <PremiumUpgradeModal
        open={upgradeModalOpen}
        onClose={() => setUpgradeModalOpen(false)}
        onUpgrade={() => {
          setUpgradeModalOpen(false);
          window.location.href = UPGRADE_URL
            || `mailto:${UPGRADE_CONTACT_EMAIL}?subject=${encodeURIComponent('Bahirjee Premium upgrade')}`;
        }}
      />
    </div>
  );
}
