import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, Navigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getReportByToken, getLatestReportForCompanySlug, requestBriefAccess, newsItemsFromRow } from '../services/reportService';
import { askBahirjee } from '../services/intelligenceService';
import { isPremiumOrExempt } from '../utils/premiumUtils';
import ReportWorkspace from './intelligence/ReportWorkspace';
import { InsightCard, SignalCard } from './IntelligenceDashboard';
import { Loader2, ShieldAlert, Lock, MailCheck, Send, Menu } from 'lucide-react';
import { formatCategoryName } from '../utils/formatters';

export default function ReportViewer() {
    // Two entry points share this viewer:
    //   /report/:shareToken   — unguessable token link, works cross-org (RPC)
    //   /company/:companySlug — friendly URL (e.g. /company/caremother), latest brief,
    //                           access enforced by RLS (own org / same email domain)
    const { shareToken, companySlug } = useParams();
    const { user, profile, authLoading, requestAuthLink, signOut } = useAuth();

    const [report, setReport] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [needsLogin, setNeedsLogin] = useState(false);

    // Inline sign-in / request-access state (the brief page is its own front door).
    const [email, setEmail] = useState('');
    const [gateBusy, setGateBusy] = useState(false);
    const [gateError, setGateError] = useState('');
    const [gateNotice, setGateNotice] = useState('');
    const [requestSent, setRequestSent] = useState(false);

    // Workspace UI state. The sidebar starts closed on small screens: viewer mode
    // suppresses ReportWorkspace's own header, which owns the only menu toggle, so an
    // open sidebar there covered the brief with no way to dismiss it.
    const [activeSection, setActiveSection] = useState('intro');
    const [sidebarOpen, setSidebarOpen] = useState(
        () => typeof window === 'undefined' || window.matchMedia('(min-width: 768px)').matches
    );
    const [reportFilter, setReportFilter] = useState('');

    // The RPC logs an access row on every successful call, and `user` is a fresh object
    // on token refresh — without this guard a refresh would double-log the same visit.
    const fetchedForRef = useRef(null);

    useEffect(() => {
        if (authLoading) return;

        if (!user) {
            setNeedsLogin(true);
            setLoading(false);
            return;
        }

        setNeedsLogin(false);

        const fetchKey = `${user.id}:${companySlug || shareToken}`;
        if (fetchedForRef.current === fetchKey) return;
        fetchedForRef.current = fetchKey;

        async function fetchReport() {
            setLoading(true);
            setError(null);
            const { data, error } = companySlug
                ? await getLatestReportForCompanySlug(companySlug)
                : await getReportByToken(shareToken);

            if (error || !data) {
                setError(companySlug
                    ? "No brief found for this company, or your account doesn't have access to it."
                    : 'You don\'t have access to this brief.');
            } else {
                setReport(data);
            }
            setLoading(false);
        }

        fetchReport();
    }, [shareToken, companySlug, authLoading, user]);

    // Sign in straight from the brief page. A domain that belongs to an active client
    // signs in instantly; a granted individual still gets a magic link; anyone else is
    // told plainly so they can request access instead of staring at a dead end.
    const handleGateSubmit = async (e) => {
        e.preventDefault();
        setGateError('');
        setGateNotice('');

        const trimmed = email.trim().toLowerCase();
        if (!trimmed) {
            setGateError('Please enter your work email.');
            return;
        }

        setGateBusy(true);
        try {
            const result = await requestAuthLink(trimmed);
            if (result?.signedIn) {
                // Auth state change re-renders this page with the brief loaded.
                return;
            }
            if (result?.emailSent) {
                setGateNotice('Check your email for a secure sign-in link.');
            } else {
                setGateError("This brief isn't shared with your email domain.");
            }
        } catch (err) {
            setGateError(err.message || 'Unable to sign you in.');
        } finally {
            setGateBusy(false);
        }
    };

    const handleRequestAccess = async () => {
        const trimmed = (user?.email || email).trim().toLowerCase();
        if (!trimmed || !shareToken) return;

        setGateBusy(true);
        setGateError('');
        const { error: reqError } = await requestBriefAccess(shareToken, trimmed);
        setGateBusy(false);

        if (reqError) {
            setGateError('Could not send your request. Please try again.');
            return;
        }
        setRequestSent(true);
    };

    // Format sections
    const sections = useMemo(() => {
        if (!report) return [];
        // `type: 'intro'` + `insights` are required, not decorative: ReportWorkspace keys
        // the whole overview body off `activeGrouped?.type === 'intro'`. Without them the
        // shared/company view fell through to the signal-list branch and rendered
        // "No material shifts detected in this ring." for every brief ever shared.
        const introInsights = Array.isArray(report.brief?.insights) ? report.brief.insights : [];
        const reportSections = [{
            id: 'intro',
            title: 'Strategic Overview',
            type: 'intro',
            insights: introInsights,
            meta: { count: introInsights.length },
            subsections: []
        }];
        if (!report.signals) return reportSections;

        let filtered = report.signals;
        if (reportFilter) {
            filtered = report.signals.filter(s => s.category === reportFilter);
        }

        const cats = [...new Set(filtered.map(s => s.category).filter(Boolean))];
        cats.forEach((cat, idx) => {
            const catSignals = filtered.filter(s => s.category === cat);
            reportSections.push({
                id: `sec-${idx}`,
                title: formatCategoryName(cat),
                // Raw category travels with the section so ReportWorkspace can group on it
                // directly instead of re-matching the formatted title string.
                category: cat,
                meta: { count: catSignals.length },
                subsections: catSignals
            });
        });
        return reportSections;
    }, [report, reportFilter]);

    const activeData = useMemo(() => {
        if (!sections.length) return null;
        return sections.find(section => section.id === activeSection) || sections[0] || null;
    }, [sections, activeSection]);

    const handleQnA = async (signal, question) => {
        if (!report) {
            return "This brief is still loading.";
        }
        // RAG: retrieve relevant document excerpts, plus (v29) signals/observations already
        // found — scoped to the report's owning client. An anonymous share-link viewer has
        // no auth.uid(), so document_chunks' RLS blocks both read and any Stage-3
        // write-back for them exactly as it already blocked ragChunks — no change for that
        // case, just no knowledge-base benefit either, until they sign in.
        let ragChunks = [];
        let knowledgeChunks = [];
        const clientId = report?.client_id || profile?.client_id;
        if (clientId && question) {
            try {
                const { retrieveRelevantChunks } = await import('../services/ragService');
                [ragChunks, knowledgeChunks] = await Promise.all([
                    retrieveRelevantChunks({ clientId, query: question, kinds: ['uploaded_doc'] }),
                    retrieveRelevantChunks({ clientId, query: question, kinds: ['signal', 'observation'] }),
                ]);
            } catch (e) {
                console.warn('RAG retrieval skipped:', e.message);
            }
        }
        return askBahirjee(viewerReportFormat, signal, question, ragChunks, { clientId: clientId || null, knowledgeChunks });
    };

    // Post-commit callback only. StrategicInteractionHub is the single writer for notes
    // (it owns the free-tier limit) now that reportId/userId reach it — calling trackNote
    // again here would write two `interactions` rows per shared signal.
    const handleShareSignal = async ({ content } = {}) => {
        if (!user || !report?.id || !content) {
            return { success: false, error: 'Unable to submit signal.' };
        }
        return { success: true };
    };

    if (authLoading || loading) {
        return (
            <div className="min-h-dvh bg-[var(--bah-bg)] flex flex-col items-center justify-center text-[var(--bah-text)]">
                <Loader2 className="w-10 h-10 text-[var(--bah-accent)] animate-spin mb-4" />
                <p>Verifying access to intelligence brief...</p>
            </div>
        );
    }

    // Confirmation shared by both denial paths (signed in or not).
    if (requestSent) {
        return (
            <div className="min-h-dvh flex items-center justify-center bg-[var(--bah-bg)] p-6">
                <div className="max-w-md w-full bah-panel p-8 rounded-2xl text-center">
                    <MailCheck className="w-12 h-12 text-bah-accent mx-auto mb-4" />
                    <h2 className="text-xl font-display font-semibold text-bah mb-2">Request sent</h2>
                    <p className="text-bah-muted text-sm">
                        We've let the brief's owner know you'd like access. You'll be able to open this
                        link once they approve it.
                    </p>
                </div>
            </div>
        );
    }

    // Not signed in: the brief page is its own front door — no redirect, no lost link.
    if (needsLogin) {
        return (
            <div className="min-h-dvh flex items-center justify-center bg-[var(--bah-bg)] p-6">
                <div className="max-w-sm w-full bah-panel p-8 rounded-2xl space-y-6">
                    <div className="w-14 h-14 rounded-2xl brand-gradient flex items-center justify-center mx-auto shadow-lg">
                        <Lock className="w-7 h-7 text-bah-strong" />
                    </div>
                    <div className="text-center">
                        <h2 className="text-xl font-display font-semibold text-bah tracking-tight">
                            You've been shared a brief
                        </h2>
                        <p className="text-bah-muted text-sm mt-2">
                            Enter your work email to open it.
                        </p>
                    </div>
                    <form onSubmit={handleGateSubmit} className="space-y-4">
                        <input
                            type="email"
                            value={email}
                            onChange={e => setEmail(e.target.value)}
                            placeholder="you@company.com"
                            required
                            autoFocus
                            autoComplete="email"
                            className="w-full bg-bah-panel-soft border border-bah rounded-xl px-4 py-3 text-bah placeholder-bah-muted-2 focus:border-[var(--bah-accent)] outline-none transition-all"
                        />
                        {gateError && <p className="text-bah-danger text-xs text-center">{gateError}</p>}
                        {gateNotice && <p className="text-bah-accent-strong text-xs text-center">{gateNotice}</p>}
                        <button
                            type="submit"
                            disabled={gateBusy}
                            className="w-full bah-button-primary py-3 rounded-xl shadow-lg disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                            {gateBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                            Open brief
                        </button>
                    </form>
                    {gateError && (
                        <button
                            onClick={handleRequestAccess}
                            disabled={gateBusy || !email.trim()}
                            className="w-full flex items-center justify-center gap-2 text-xs text-bah-muted hover:text-bah-accent transition-colors disabled:opacity-40"
                        >
                            <Send size={13} />
                            Request access to this brief
                        </button>
                    )}
                </div>
            </div>
        );
    }

    // Signed in but not entitled (wrong org, or blocked).
    if (error) {
        return (
            <div className="min-h-dvh flex items-center justify-center bg-[var(--bah-bg)] p-6">
                <div className="max-w-sm w-full bah-panel p-8 rounded-2xl text-center space-y-4">
                    <ShieldAlert className="w-12 h-12 text-bah-danger mx-auto" />
                    <div>
                        <h2 className="text-xl font-display font-semibold text-bah mb-2">No access to this brief</h2>
                        <p className="text-bah-muted text-sm">{error}</p>
                    </div>
                    <p className="text-xs text-bah-muted">
                        Signed in as <strong className="text-bah">{user?.email}</strong>
                    </p>
                    {gateError && <p className="text-bah-danger text-xs">{gateError}</p>}
                    {shareToken && (
                        <button
                            onClick={handleRequestAccess}
                            disabled={gateBusy}
                            className="w-full bah-button-primary py-2.5 rounded-xl disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                            {gateBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send size={14} />}
                            Request access
                        </button>
                    )}
                    <div className="flex items-center justify-center gap-4 text-xs pt-1">
                        <button onClick={signOut} className="text-bah-muted hover:text-bah transition-colors">
                            Use a different email
                        </button>
                        <Link to="/" className="text-bah-muted hover:text-bah-accent transition-colors">
                            Go to workspace
                        </Link>
                    </div>
                </div>
            </div>
        );
    }

    if (!report) {
        return (
            <div className="min-h-dvh bg-[var(--bah-bg)] flex items-center justify-center p-6">
                <div className="bah-panel p-10 text-center max-w-md">
                    <ShieldAlert className="w-10 h-10 text-bah-muted-2 mx-auto mb-4" />
                    <h2 className="text-lg font-medium text-bah-strong mb-2">Brief unavailable</h2>
                    <p className="text-bah-muted text-sm mb-6">
                        We couldn't load this brief. The link may have expired, or the brief may have been removed.
                    </p>
                    <Link to="/" className="bah-button-primary px-4 py-2 rounded-lg inline-block">Go to Dashboard</Link>
                </div>
            </div>
        );
    }

    // Simulate returning finalReport format expected by ReportWorkspace
    const viewerReportFormat = {
        id: report.id,
        inputs: { websiteUrl: report.website_url },
        context: report.context,
        signals: report.signals,
        brief: report.brief,
        reportKind: report.report_kind || 'company',
        decisionContext: report.decision_context || null,
        decisionBrief: report.decision_brief || null,
        memory: {
            ...report.memory_state,
            current_cards: Array.isArray(report.card_summary) ? report.card_summary : []
        },
        card_summary: report.card_summary || [],
        share_token: report.share_token,
        target_domain: report.target_domain,
        created_at: report.created_at,
        v6: report.v6 || { patterns: [], shifts: [], blindSpots: [], opportunities: [], runId: null },
        newsItems: newsItemsFromRow(report)
    };


    return (
        <div className="h-dvh w-full flex flex-col bg-[var(--bah-bg)] overflow-hidden">
            {/* Minimal Header explicitly showing Shared Mode */}
            <div className="h-16 border-b border-[var(--bah-border)] px-6 flex items-center justify-between bg-[var(--bah-panel-strong)] shrink-0 z-10 relative">
                <div className="flex items-center gap-3 min-w-0">
                    {/* Viewer mode suppresses ReportWorkspace's header, which owns the only
                        sidebar toggle — without this the mobile sidebar is undismissable. */}
                    <button
                        onClick={() => setSidebarOpen(v => !v)}
                        className="p-2 -ml-2 md:hidden text-[var(--bah-text-muted)] hover:text-[var(--bah-text-strong)] shrink-0"
                        aria-label={sidebarOpen ? 'Hide sections' : 'Show sections'}
                        aria-expanded={sidebarOpen}
                    >
                        <Menu className="w-5 h-5" />
                    </button>
                    <div className="w-8 h-8 rounded bg-[var(--bah-accent)] flex items-center justify-center shrink-0">
                        <span className="text-bah-strong font-serif font-bold italic tracking-tighter">B</span>
                    </div>
                    <div className="min-w-0">
                        <div className="text-[var(--bah-text-strong)] font-serif font-semibold leading-tight truncate">Shared Intelligence Brief</div>
                        <div className="text-[11px] font-sans tracking-wide text-[var(--bah-text-muted)] uppercase truncate">
                            Bahirjee Strategic Teammate
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-4 min-w-0">
                    <div className="text-sm font-medium text-[var(--bah-text)] hidden sm:block truncate">
                        Target Domain: <span className="text-[var(--bah-text-strong)]">{report.target_domain || report.website_url}</span>
                    </div>
                    <Link to="/" className="px-3 py-1.5 text-sm bg-[var(--bah-border)] hover:bg-[var(--bah-border-light)] text-[var(--bah-text-strong)] rounded-md transition-colors shrink-0 whitespace-nowrap">
                        Go to Dashboard
                    </Link>
                </div>
            </div>

            <div className="flex-1 overflow-hidden relative">
                {/* reportId/userId matter here: without them StrategicInteractionHub skips
                    tracking entirely, so the 3-question / 3-note free limit was unenforced
                    on every shared brief — each question is a real LLM call. */}
                <ReportWorkspace
                    historyOpen={false}
                    setHistoryOpen={() => {}}
                    filteredHistory={[]}
                    loadReport={() => {}}
                    searchTerm=""
                    setSearchTerm={() => {}}
                    selectedMonth="All"
                    setSelectedMonth={() => {}}
                    availableMonths={['All']}
                    sidebarOpen={sidebarOpen}
                    setSidebarOpen={setSidebarOpen}
                    sections={sections}
                    activeSection={activeSection}
                    setActiveSection={setActiveSection}
                    finalReport={viewerReportFormat}
                    reportFilter={reportFilter}
                    setReportFilter={setReportFilter}
                    setPhase={() => {}} // Disabled for viewers
                    signOut={() => {}} // Handled at wrapper
                    activeData={activeData}
                    handleV6React={() => {}}
                    renderInsightCard={(insight, i) => <InsightCard key={i} insight={insight} index={i} websiteUrl={report?.website_url} />}
                    renderSignalCard={(signal, idx, onAsk, filter, onUpgrade) => <SignalCard key={idx} signal={signal} onAsk={onAsk} filter={filter} profile={profile} onUpgrade={onUpgrade} />}
                    handleQnA={handleQnA}
                    handleShareSignal={handleShareSignal}
                    isPremium={isPremiumOrExempt(profile)}
                    reportId={report.id}
                    userId={user?.id}
                    runCount={profile?.run_count ?? 0}
                    isViewerMode={true} // New prop to tell Workspace it's read-only/shared mode
                />
            </div>
        </div>
    );
}
