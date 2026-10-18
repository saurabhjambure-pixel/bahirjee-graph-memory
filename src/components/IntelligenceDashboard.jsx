
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { buildReportSections } from '../services/signalTaxonomy';
import toast from 'react-hot-toast';
import { askBahirjee, enrichContextWithOnboarding, validateContextReadiness, buildInitialContext, buildDecisionFrame, enrichStoredContext } from '../services/intelligenceService';
import { historyService } from '../services/historyService';
import { memoryService } from '../services/memoryService';
import { authenticatedFetch } from '../services/apiClient';
import { uploadAndParseDocuments } from '../services/documentUploadService';
import { submitIntelligenceJob, getIntelligenceJob, resumeIntelligenceJob, getActiveIntelligenceJob } from '../services/intelligenceJobService';
import Desk from './intelligence/Desk';
import DecisionSession from './intelligence/DecisionSession';
import { runDecisionSession } from '../services/decisionRun';
import { startDecision, saveRouting, saveJudgment, recordChoice } from '../services/decisionSessionService';
import { listTargets, createTarget, archiveTarget, restoreTarget } from '../services/targetService';
import { isUuid } from '../utils/uuid';
import { listAgenda, openQuestion } from '../services/agendaService';
import { getReportById, mapReportRowToAppReport, getLastReportForUrl, getLastReportForTarget, extractTargetDomain, companySlugFromDomain } from '../services/reportService';
import { useAuth } from '../context/AuthContext';
import { isPremiumOrExempt } from '../utils/premiumUtils';
import StrategicAwarenessSurface from './StrategicAwarenessSurface';
import { recordImpactEvent } from '../services/impactService';
import { getFriendlyError } from '../utils/errorMessages';
import { addsBeyondHeadline } from '../services/signalPresentation';
import { sourceClassLabel } from '../services/sourceClass';
import { opportunityStatusOn } from '../services/opportunityFields';
import AuthScreen from './intelligence/AuthScreen';
import NameGateScreen from './intelligence/NameGateScreen';
import BriefListScreen from './intelligence/BriefListScreen';
import IntakeScreen from './intelligence/IntakeScreen';
import OnboardingScreen from './intelligence/OnboardingScreen';
import { saveOnboardingInputs, getLatestOnboardingInputs } from '../services/onboardingService';
import ErrorScreen from './intelligence/ErrorScreen';
import ContextReviewScreen from './intelligence/ContextReviewScreen';
import ContextConfirmScreen from './intelligence/ContextConfirmScreen';
import ContextGateScreen from './intelligence/ContextGateScreen';
import AddSourcesDialog from './intelligence/AddSourcesDialog';
import {
    getCurrentCompanyContext, saveCompanyContext, hydrateStoredContext, describeContextStaleness,
} from '../services/companyContextService';
import ReportWorkspace from './intelligence/ReportWorkspace';
import { ConfirmDialog } from './common/Modal';
import { COMPANY_MODE, DECISION_MODE, validateDecisionFrame } from '../services/decisionService';
import IntelligenceDesk from './intelligence/desk/IntelligenceDesk';
import AddProductModal from './intelligence/modals/AddProductModal';
import AddDecisionModal from './intelligence/modals/AddDecisionModal';
import RunScopeModal from './intelligence/modals/RunScopeModal';
import MonitoringSetupModal from './intelligence/modals/MonitoringSetupModal';
import CompositeRunOverview from './intelligence/composite/CompositeRunOverview';
import { workspaceService } from '../services/workspaceService';
import {
    Menu, X, ChevronDown, ChevronRight, ChevronLeft, Activity, Shield, Target,
    Lightbulb, BookOpen, AlertTriangle, Compass, CheckCircle,
    Search, Zap, AlertOctagon, Sparkles, Loader2, Send, ExternalLink, History, LayoutTemplate, Lock, LogOut,
    Eye, EyeOff, Plus, Calendar, Info
} from 'lucide-react';

// --- HELPER: Clean Markdown ---
const cleanText = (text) => {
    if (!text) return "";
    return text
        .replace(/\*\*/g, "")
        .replace(/#{1,6}\s?/g, "")
        .replace(/\n\n/g, "\n")
        .trim();
};

const HighlightText = ({ text, highlight }) => {
    if (!highlight || highlight.length < 3) return <span>{text}</span>;
    const parts = text.split(new RegExp(`(${highlight})`, 'gi'));
    return (
        <span>
            {parts.map((part, i) =>
                part.toLowerCase() === highlight.toLowerCase() ? (
                    <span key={i} className="bg-yellow-500/20 text-bah-warning rounded px-0.5 font-medium">{part}</span>
                ) : (part)
            )}
        </span>
    );
};
const ConfidenceBadge = ({ value }) => {
    const valStr = String(value || 'Medium').toLowerCase();
    let bgClass = "bg-bah-panel-strong text-bah-muted border-bah";
    if (valStr.includes("high")) bgClass = "bg-bah-accent-soft text-bah-accent-strong border-emerald-500/30";
    else if (valStr.includes("medium")) bgClass = "bg-bah-warning-soft text-bah-warning border-amber-500/30";
    else if (valStr.includes("low")) bgClass = "bg-bah-danger-soft text-bah-danger border-red-500/30";

    return (
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${bgClass} inline-flex items-center gap-1 uppercase tracking-wide`}>
            {value}
        </span>
    );
};

// How long a movement has been running, said the way a person would say it.
//
// The underlying states are `new | evolving | stabilising | resolved` — accurate, and
// jargon. "Stabilising" is not a word a founder uses about their own market, and a badge
// they have to decode is a badge they skip. The state values are unchanged; only the
// words are.
const LIFECYCLE_WORDS = {
    new: 'New this week',
    evolving: 'Still building',
    stabilising: 'Settling',
    resolved: 'Played out',
};

const LifecycleBadge = ({ state }) => {
    const s = (state || 'new').toLowerCase();
    const colors = {
        new: "text-bah-accent border-[var(--bah-accent)]/30",
        evolving: "text-bah-warning border-amber-500/30",
        stabilising: "text-bah-accent-strong border-emerald-500/30",
        resolved: "text-bah-muted border-bah"
    };
    return (
        <span className={`text-[9px] px-1.5 py-0.5 rounded border ${colors[s] || colors.new} tracking-wide`}>
            {LIFECYCLE_WORDS[s] || LIFECYCLE_WORDS.new}
        </span>
    );
};

// Human-readable name for a signal's evidence class now lives in
// `src/services/sourceClass.js` — the Monday Letter renders the same taxonomy server-side
// and cannot import a component file, so the definition moved out of here rather than
// being copied. Unclassified signals still show nothing rather than a "General" badge that
// would imply we know something about the source that we do not: `sourceClassLabel()`
// returns null for an unknown class.

// --- INSIGHT TYPE ICONS ---
const insightIcons = {
    context: <Compass className="w-4 h-4" />,
    shift: <Activity className="w-4 h-4" />,
    risk: <AlertTriangle className="w-4 h-4" />,
    opportunity: <Lightbulb className="w-4 h-4" />,
    implication: <Target className="w-4 h-4" />,
    competitor: <Zap className="w-4 h-4" />,
    customer: <BookOpen className="w-4 h-4" />,
    regulatory: <Shield className="w-4 h-4" />
};

const insightColors = {
    context: "text-bah-cyan bg-bah-cyan-soft border-[var(--bah-cyan)]/20",
    shift: "text-bah-warning bg-amber-500/10 border-amber-500/20",
    risk: "text-bah-danger bg-red-500/10 border-red-500/20",
    opportunity: "text-bah-accent-strong bg-emerald-500/10 border-emerald-500/20",
    implication: "text-bah-accent bg-bah-accent-soft border-[var(--bah-accent)]/20",
    competitor: "text-bah-cyan bg-bah-cyan-soft border-[var(--bah-cyan)]/20",
    customer: "text-bah-cyan bg-cyan-500/10 border-cyan-500/20",
    regulatory: "text-bah-warning bg-orange-500/10 border-orange-500/20"
};

// --- COMPONENT: Insight Card ---
// Steering the next run.
//
// These WERE four bare emoji (👍 🔥 💡 ⚠️) that persisted to impact_events and genuinely
// shaped the following run — but said nothing about having done so, so they read as
// decoration and were used like decoration.
//
// getReactionPreferences collapses every event into exactly two buckets, BOOST_EVENTS and
// SUPPRESS_EVENTS, so the four emoji were already two choices wearing four faces. Naming
// the two is not a reduction in capability; it is the first time the control says what it
// does. An unrewarded interaction teaches people the product does not listen.
const INSIGHT_STEERS = [
    { key: 'up', eventType: 'thumbs_up', label: 'More like this', done: 'I will look for more of this.' },
    { key: 'down', eventType: 'thumbs_down', label: 'Not relevant', done: 'I will stop bringing you this.' },
];

export const InsightCard = ({ insight, index, websiteUrl, onReact }) => {
    const [reaction, setReaction] = useState(null);
    const type = insight.type || 'context';
    const icon = insightIcons[type] || insightIcons.context;
    const colors = insightColors[type] || insightColors.context;

    const handleSteer = async (steer) => {
        setReaction(steer.key);
        // Persist server-side so it can shape the next run. A no-op in contexts without an
        // onReact wiring (the read-only viewer), which is why the confirmation below is
        // gated on `onReact` — promising to act on feedback nobody recorded would be worse
        // than offering no control at all.
        if (onReact) {
            await onReact({ eventType: steer.eventType, text: insight.text, theme: type });
        }
    };

    return (
        <div className={`p-5 rounded-xl border ${colors} hover:scale-[1.02] transition-all duration-200`}>
            <div className="flex items-start gap-3">
                <div className={`p-2 rounded-lg ${colors}`}>
                    {icon}
                </div>
                    <div className="flex-1">
                    {type !== 'context' && (
                        <div className="text-[10px] uppercase tracking-wider text-bah-muted mb-1">{type}</div>
                    )}
                    <p className="text-bah text-sm leading-relaxed">{insight.text}</p>
                </div>
            </div>
            {insight.memory_state && (
                <div className="mt-3 text-[10px] uppercase tracking-widest text-bah-muted flex flex-wrap gap-2 items-center">
                    <LifecycleBadge state={insight.memory_state.trend_state} />
                    <span>Seen {insight.memory_state.occurrence_count || 1}x</span>
                </div>
            )}
            {onReact && (
                <div className="mt-4 pt-3 border-t border-bah">
                    {reaction ? (
                        // The whole point: the control reports what it changed.
                        <p className="text-xs text-bah-accent">
                            {INSIGHT_STEERS.find(x => x.key === reaction)?.done}
                        </p>
                    ) : (
                        <div className="flex items-center gap-2">
                            {INSIGHT_STEERS.map(steer => (
                                <button
                                    key={steer.key}
                                    onClick={() => handleSteer(steer)}
                                    className="text-xs px-2.5 py-1 rounded-lg border border-bah text-bah-muted hover:text-bah-strong hover:border-[var(--bah-accent)]/40 transition-colors"
                                >
                                    {steer.label}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

// --- COMPONENT: Signal Card ---
// Publisher label for a source link: hostname without "www." ("timesofindia.indiatimes.com"
// → "timesofindia.indiatimes.com" stays readable; raw URLs do not).
const publisherName = (url) => {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
};

/**
 * SignalCard — one signal, read as a single object.
 *
 * The card is one argument in four beats: what happened → what it means for you → what it
 * rests on → what you want to do about it. It was six boxes with four different background
 * treatments, so it read as a stack of unrelated panels rather than one card; the
 * reasoning that justifies the judgment was folded away behind an accordion that looked
 * like a foreign component; and the headline and the factual line said the same thing.
 *
 * Now: one surface, one tinted region (the read — so the tint means something), and
 * hairlines instead of nested borders. The basis is permanently visible, because a
 * judgment whose grounds are hidden is just an assertion.
 */
export const SignalCard = ({ signal, onAsk, filter, profile, onUpgrade }) => {
    const [question, setQuestion] = useState('');
    const [answer, setAnswer] = useState(null);
    const [asking, setAsking] = useState(false);
    const [showReasoning, setShowReasoning] = useState(false);
    const [showContext, setShowContext] = useState(false);
    // The ask box is opt-in. Rendered open on every card it cost ~90px each — 1,800px of
    // input chrome across a twenty-signal ring, for a control most cards never receive.
    const [askOpen, setAskOpen] = useState(false);

    // Primary source + any corroborating outlets merged in by dedup (max 3 total shown).
    const sourceLinks = [signal.source_url, ...(signal.corroborating_urls || [])].filter(Boolean);

    const handleAsk = async () => {
        if (!question) return;
        setAsking(true);
        try {
            const ans = await onAsk(signal, question);
            setAnswer(cleanText(ans)); // Clean output
        } catch (e) {
            // Without this the spinner never cleared and the button stayed disabled.
            console.error('[SignalCard] Ask failed:', e);
            toast.error(getFriendlyError(e?.message).friendly);
        } finally {
            setAsking(false);
        }
    };

    // Exempt-client users pass isPremiumOrExempt but fail the raw is_premium flag — using
    // the flag here paywalled every signal card for founders who had full access elsewhere.
    const isPremium = isPremiumOrExempt(profile);

    const headline = signal.signal_headline || '';
    const moveText = cleanText(signal.the_move || signal.signal_details);
    const showMove = Boolean(moveText) && addsBeyondHeadline(moveText, headline);

    const readText = cleanText(signal.so_what_for_you || signal.strategic_implication || signal.intelligence_assessment);
    const hasRead = String(readText || '').trim().length > 0;
    const reasoning = cleanText(signal.analyst_note);

    // The door, when this signal is one. Arrays defaulted so a report written before the
    // block existed — or a hand-edited one — cannot crash the card.
    const opportunity = signal.opportunity && typeof signal.opportunity === 'object'
        ? {
            ...signal.opportunity,
            fit: Array.isArray(signal.opportunity.fit) ? signal.opportunity.fit : [],
            unknowns: Array.isArray(signal.opportunity.unknowns) ? signal.opportunity.unknowns : [],
        }
        : null;
    // Open/closed is recomputed from the deadline at render time. The stored `status` records
    // the day of analysis; a shared or stored report opened after the deadline must not say "Closes".
    const opportunityClosed = opportunityStatusOn(opportunity) === 'closed';

    // What time band this signal is in, and the date it rests on.
    //
    // "Current" is gated on an EXPLICIT anchor role. Every signal in every report written
    // before v27 has temporal_role undefined, and treating unknown as current would put a
    // confident freshness label on the entire existing corpus. Unknown renders no band
    // chip at all — which is the honest answer for a row that never recorded a date.
    const temporalRole = signal.temporal_role || null;
    const eventDate = signal.event_date || signal.date || null;
    const temporalChip = temporalRole === 'anchor'
        ? { label: 'Current', tone: 'bg-bah-accent-soft text-bah-accent' }
        : temporalRole === 'historical_context'
            ? { label: 'Historical context', tone: 'bg-bah-panel-soft text-bah-muted' }
            : temporalRole === 'supporting_context'
                ? { label: 'Supporting context', tone: 'bg-bah-panel-soft text-bah-muted' }
                : null;

    // Older sources attached to this anchor. Folded away by default: they explain the
    // event, they are not additional events, and listing them inline would read as more
    // things having happened than actually did.
    const supportingEvidence = Array.isArray(signal.supporting_evidence) ? signal.supporting_evidence : [];

    const timingChip = signal.freshness === 'background'
        ? { label: 'Background', tone: 'bg-bah-panel-soft text-bah-muted' }
        : signal.timing_window === 'immediate'
            ? { label: 'Immediate', tone: 'bg-bah-danger-soft text-bah-danger' }
            : signal.timing_window === 'this_quarter'
                ? { label: 'This quarter', tone: 'bg-bah-warning-soft text-bah-warning' }
                : signal.timing_window
                    ? { label: 'This year', tone: 'bg-bah-panel-soft text-bah-muted' }
                    : null;


    return (
        <article className="bg-bah-panel-strong rounded-xl border border-bah hover:border-[var(--bah-accent)]/30 transition-colors duration-300">
            <div className="p-5 md:p-6 space-y-4">

                {/* ── What happened ─────────────────────────────────────────────────
                    Title and meta share one row with the confidence badge. The old
                    tinted header band with its own bottom border made the head look
                    like a separate component sitting on top of the card. */}
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                        <div className="p-2 rounded-lg bg-bah-accent-soft text-bah-accent border border-[var(--bah-accent)]/20 shrink-0">
                            {signal.category === 'Regulation'
                                ? <AlertOctagon className="w-4 h-4 text-bah-danger" />
                                : <Compass className="w-4 h-4" />}
                        </div>
                        <div className="min-w-0">
                            <h3 className="font-semibold text-bah-strong text-[17px] leading-snug">
                                <HighlightText text={headline} highlight={filter} />
                            </h3>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5">
                                <LifecycleBadge state={signal.lifecycle_state} />
                                {signal.maturity && (
                                    <span className="text-[10px] text-bah-muted uppercase tracking-wide">{signal.maturity}</span>
                                )}
                                {/* The company's own name, never labelled "entity". There is
                                    no reason to write "entity" to a customer. */}
                                {signal.entity_involved && (
                                    <span className="text-[10px] text-bah-muted border-l border-bah pl-2 truncate max-w-[220px]">
                                        {signal.entity_involved}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                    <div className="shrink-0"><ConfidenceBadge value={signal.confidence} /></div>
                </div>

                {/* The factual line, unlabelled and only when it is not the headline
                    reworded. A "THE MOVE" label announced a new section for what the
                    reader had just read one line above. */}
                {showMove && (
                    <p className="text-bah text-[15px] leading-relaxed">
                        <HighlightText text={moveText} highlight={filter} />
                    </p>
                )}

                {/* ── The door ──────────────────────────────────────────────────────
                    Facts and fit only. "Not settled" sits at the same weight as "Fits
                    you on": a fit the founder cannot see the limits of is a pitch. */}
                {opportunity?.counterparty && (
                    <dl className="rounded-lg border border-bah px-4 py-3 grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
                        <dt className="text-bah-muted text-[10px] uppercase tracking-wider pt-0.5">Held by</dt>
                        <dd className="text-bah min-w-0 break-words">{opportunity.counterparty}</dd>
                        {opportunity.trigger && (
                            <>
                                <dt className="text-bah-muted text-[10px] uppercase tracking-wider pt-0.5">Opened by</dt>
                                <dd className="text-bah min-w-0 break-words">{opportunity.trigger}</dd>
                            </>
                        )}
                        {opportunity.deadline && (
                            <>
                                <dt className="text-bah-muted text-[10px] uppercase tracking-wider pt-0.5">
                                    {opportunityClosed ? 'Closed' : 'Closes'}
                                </dt>
                                <dd className={`font-num min-w-0 ${opportunityClosed ? 'text-bah-muted' : 'text-bah-strong'}`}>
                                    {opportunity.deadline}
                                </dd>
                            </>
                        )}
                        {opportunity.amount && (
                            <>
                                <dt className="text-bah-muted text-[10px] uppercase tracking-wider pt-0.5">Amount</dt>
                                <dd className="text-bah font-num min-w-0 break-words">{opportunity.amount}</dd>
                            </>
                        )}
                        {opportunity.fit.length > 0 && (
                            <>
                                <dt className="text-bah-muted text-[10px] uppercase tracking-wider pt-0.5">Fits you on</dt>
                                <dd className="text-bah min-w-0 break-words"><ul className="list-disc pl-4 space-y-0.5">{opportunity.fit.map((f, i) => <li key={i}>{f}</li>)}</ul></dd>
                            </>
                        )}
                        {opportunity.unknowns.length > 0 && (
                            <>
                                <dt className="text-bah-muted text-[10px] uppercase tracking-wider pt-0.5">Not settled</dt>
                                <dd className="text-bah min-w-0 break-words"><ul className="list-disc pl-4 space-y-0.5">{opportunity.unknowns.map((u, i) => <li key={i}>{u}</li>)}</ul></dd>
                            </>
                        )}
                    </dl>
                )}

                {/* ── What it means for you ─────────────────────────────────────────
                    The ONLY tinted region on the card, so the tint carries meaning
                    instead of being one of four competing surfaces. */}
                {hasRead && (
                    <div className="rounded-lg bg-bah-accent-soft border-l-2 border-[var(--bah-accent)]/50 px-4 py-3.5">
                        <h4 className="text-bah-accent font-bold text-[10px] uppercase mb-1.5 flex items-center gap-2 tracking-wider">
                            <Target className="w-3 h-3" /> Where it touches you
                        </h4>
                        <p className="text-bah leading-relaxed text-sm">
                            <HighlightText text={readText} highlight={filter} />
                        </p>
                    </div>
                )}

                {/* ── What it rests on ──────────────────────────────────────────────
                    Permanently visible, and a hairline rather than a bordered box.
                    This was an accordion labelled "Why This Read" that hid the event
                    date, the source class and the sources — the whole basis for the
                    judgment above — behind a click, inside what looked like a
                    different component. A read you cannot check is an assertion. */}
                <div className="pt-3.5 border-t border-bah space-y-2.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[10px] uppercase tracking-wide">
                        {/* The time band comes first: whether this is happening now is
                            the reader's first question about any signal, and it decides
                            how to read everything after it. */}
                        {temporalChip && (
                            <span className={`px-2 py-0.5 rounded ${temporalChip.tone}`}>{temporalChip.label}</span>
                        )}
                        {/* The Background chip only renders when no band chip did, so a
                            card never carries two overlapping recency labels. */}
                        {!temporalChip && timingChip && (
                            <span className={`px-2 py-0.5 rounded ${timingChip.tone}`}>{timingChip.label}</span>
                        )}
                        {temporalChip && timingChip && timingChip.label !== 'Background' && (
                            <span className={`px-2 py-0.5 rounded ${timingChip.tone}`}>{timingChip.label}</span>
                        )}
                        {signal.relevance_score && (
                            <span className="text-bah-accent font-num">Relevance {signal.relevance_score}/10</span>
                        )}
                        {/* What KIND of source this rests on. A regulatory filing and a blog
                            post render identically without this, which is exactly the
                            distinction a founder needs when deciding whether to act. */}
                        {sourceClassLabel(signal.source_class) && (
                            <span className="inline-flex items-center gap-1 rounded border border-bah px-1.5 py-0.5 text-bah-accent">
                                {sourceClassLabel(signal.source_class)}
                            </span>
                        )}
                        {/* The EVENT date, never the crawl time. A card with no date
                            shows none rather than today's. */}
                        {eventDate && <span className="text-bah-muted normal-case font-num">{eventDate}</span>}
                        {signal.memory_state && (
                            <span className="text-bah-muted">
                                Seen {signal.memory_state.occurrence_count || 1}×
                                {signal.memory_state.last_seen_at &&
                                    ` · last ${new Date(signal.memory_state.last_seen_at).toLocaleDateString()}`}
                            </span>
                        )}
                        {/* flex-wrap is load-bearing: three long hostnames on one
                            inline-flex line overflow a 375px viewport. */}
                        {sourceLinks.length > 0 && (
                            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 normal-case tracking-normal min-w-0">
                                <ExternalLink className="w-3 h-3 text-bah-muted-2" />
                                {sourceLinks.slice(0, 3).map((url, i) => (
                                    <a
                                        key={i}
                                        href={url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-xs text-bah-accent hover:text-bah-accent-strong hover:underline transition-colors"
                                    >
                                        {publisherName(url)}
                                    </a>
                                ))}
                            </span>
                        )}
                    </div>

                    {/* ── Supporting context ────────────────────────────────────
                        Older evidence attached to this event. It earns its place here
                        rather than as its own card: a 2024 price rise is what makes a
                        2026 price cut worth reading, but it is not itself news. Each
                        entry carries the label the classifier gave it, so nothing here
                        can read as current. */}
                    {supportingEvidence.length > 0 && (
                        <div>
                            <button
                                onClick={() => setShowContext(v => !v)}
                                aria-expanded={showContext}
                                className="inline-flex items-center gap-1 text-[11px] text-bah-accent hover:text-bah-accent-strong transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--bah-accent)] rounded"
                            >
                                {showContext ? 'Hide' : 'Show'} supporting context ({supportingEvidence.length})
                            </button>
                            {showContext && (
                                <ul className="mt-2 space-y-1.5">
                                    {supportingEvidence.map((ev, i) => (
                                        <li key={i} className="text-[12px] text-bah-muted leading-relaxed">
                                            <span className="uppercase tracking-wide text-[10px] text-bah-muted-2 mr-1.5">
                                                {ev.label || 'Context'}
                                            </span>
                                            {ev.event_date && <span className="font-num mr-1.5">{ev.event_date}</span>}
                                            {ev.source_url ? (
                                                <a
                                                    href={ev.source_url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-bah-accent hover:underline"
                                                >
                                                    {ev.headline || publisherName(ev.source_url)}
                                                </a>
                                            ) : (ev.headline || '')}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    {/* The reasoning is the one thing worth folding: it is prose, it is
                        long, and it is the answer to a question the reader may not be
                        asking yet. A plain text toggle, not a panel. */}
                    {(reasoning || signal.confidence_reasoning) && (
                        <div>
                            <button
                                onClick={() => setShowReasoning(v => !v)}
                                aria-expanded={showReasoning}
                                className="inline-flex items-center gap-1 text-[11px] text-bah-accent hover:text-bah-accent-strong transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--bah-accent)] rounded"
                            >
                                {showReasoning ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                                Why we read it this way
                            </button>
                            {showReasoning && (
                                <div className="mt-2 space-y-1.5 animate-in fade-in duration-200">
                                    {reasoning && (
                                        <p className="text-bah text-sm leading-relaxed">
                                            <HighlightText text={reasoning} highlight={filter} />
                                        </p>
                                    )}
                                    {signal.confidence_reasoning && (
                                        <p className="text-[11px] text-bah-muted">{signal.confidence_reasoning}</p>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* ── What you do about it ──────────────────────────────────────────
                    Reactions and asking were two separate blocks, the second a tinted
                    panel with its own heading chip. One row. */}
                <div className="flex items-center justify-between gap-3 pt-3 border-t border-bah">
                    {/* Four reaction buttons lived here and wrote to nothing but local
                        state — eighty tap targets across a twenty-card report, none of
                        which the founder could see the effect of. Steering a run happens
                        on the insight cards, where it is persisted AND confirmed. */}
                    <div />

                    {!askOpen && !answer && (
                        <button
                            onClick={() => setAskOpen(true)}
                            className="inline-flex items-center gap-1.5 text-[11px] text-bah-muted hover:text-bah-accent transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--bah-accent)] rounded px-1"
                        >
                            <Search className="w-3.5 h-3.5" /> Ask about this
                        </button>
                    )}
                </div>

                {(askOpen || answer) && (
                    <div className="animate-in fade-in duration-200">
                        {!isPremium ? (
                            <div className="flex items-center gap-3 rounded-lg bg-bah-accent-soft border border-[var(--bah-accent)]/20 px-4 py-3">
                                <Lock className="w-4 h-4 text-bah-accent shrink-0" />
                                <p className="text-xs text-bah flex-1">Asking about a single movement is a paid feature.</p>
                                <button
                                    onClick={() => onUpgrade?.('signal_card_upgrade')}
                                    className="bah-button-primary text-xs px-3 py-1.5 rounded-full shrink-0"
                                >
                                    Upgrade
                                </button>
                            </div>
                        ) : answer ? (
                            <div className="rounded-lg bg-bah-panel-soft border border-bah p-4 text-sm text-bah">
                                <div className="font-bold text-bah-accent text-[10px] mb-1.5 uppercase tracking-wider">Bahirjee answered</div>
                                {answer}
                                <button
                                    onClick={() => { setAnswer(null); setQuestion(''); setAskOpen(true); }}
                                    className="block mt-2.5 text-xs text-bah-muted hover:text-bah-strong transition-colors"
                                >
                                    Ask another question
                                </button>
                            </div>
                        ) : (
                            <div className="flex gap-2">
                                <input
                                    autoFocus
                                    value={question}
                                    onChange={e => setQuestion(e.target.value)}
                                    placeholder="Ask for clarification or context..."
                                    aria-label="Ask about this signal"
                                    className="bah-input rounded-lg px-3 py-2 text-sm"
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') handleAsk();
                                        if (e.key === 'Escape') { setAskOpen(false); setQuestion(''); }
                                    }}
                                />
                                <button
                                    onClick={handleAsk}
                                    disabled={asking || !question}
                                    aria-label="Send question"
                                    className="p-2 bg-bah-accent-soft hover:brightness-105 text-bah-accent rounded-lg transition-all disabled:opacity-50 shrink-0"
                                >
                                    {asking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </article>
    );
};



import { useNavigate } from 'react-router-dom';

export default function IntelligenceDashboard() {
    const { user, profile, profileError, isAdmin, loading: authLoading, requestAuthLink, updateFullName, signOut } = useAuth();
    const navigate = useNavigate();

    // Dev-only. This previously logged the whole `profile` object on every auth state
    // change in production — email, client_id, role and premium flags, readable in any
    // visitor's DevTools. import.meta.env.DEV is statically false in the production
    // build, so this whole block is dead-code-eliminated there.
    useEffect(() => {
        if (!import.meta.env.DEV) return;
        console.log('[Auth]', { email: user?.email, role: profile?.role, isAdmin });
    }, [user, profile, isAdmin]);

    // Admin Redirect
    useEffect(() => {
        if (!authLoading && user && isAdmin) {
            console.log("Redirecting to Admin...");
            navigate('/admin');
        }
    }, [user, isAdmin, authLoading, navigate]);

    const [email, setEmail] = useState('');
    const [authError, setAuthError] = useState(null);
    const [authNotice, setAuthNotice] = useState('');

    const [urlInput, setUrlInput] = useState('');
    const [analysisMode, setAnalysisMode] = useState(COMPANY_MODE);
    const [decisionText, setDecisionText] = useState('');
    const [recentReportPrompt, setRecentReportPrompt] = useState(null); // { report, ageMinutes }
    // The stored context offered at the gate, plus how it should be labelled when it is
    // eventually written back. `origin` distinguishes a context the founder approved from
    // one recovered out of a past report — they are not the same claim.
    const [contextGate, setContextGate] = useState(null);
    const [storedContextMeta, setStoredContextMeta] = useState(null);
    const [contextOrigin, setContextOrigin] = useState('built');
    const [rebuildGate, setRebuildGate] = useState(false);
    const [addSourcesOpen, setAddSourcesOpen] = useState(false);
    const [isMerging, setIsMerging] = useState(false);
    const [mergeReceipt, setMergeReceipt] = useState(null);
    const [linkedinInput, setLinkedinInput] = useState('');
    const [uploadedFiles, setUploadedFiles] = useState([]);
    const [onboardingData, setOnboardingData] = useState(null);
    const [phase, setPhase] = useState('desk');
    const [statusMsg, setStatusMsg] = useState('');

    // Real workspace state for Bahirjee Intelligence Desk
    const [realTargets, setRealTargets] = useState([]);
    const [realAgenda, setRealAgenda] = useState([]);
    const [customCompany, setCustomCompany] = useState(null);
    const [currentCompositeRun, setCurrentCompositeRun] = useState(null);
    const [isAddProductOpen, setIsAddProductOpen] = useState(false);
    const [isAddDecisionOpen, setIsAddDecisionOpen] = useState(false);
    const [isRunScopeOpen, setIsRunScopeOpen] = useState(false);
    const [isMonitoringSetupOpen, setIsMonitoringSetupOpen] = useState(false);
    const [monitoringScopePreset, setMonitoringScopePreset] = useState(null);

    // Data
    const [contextData, setContextData] = useState(null);
    const [finalReport, setFinalReport] = useState(null);
    const [activeJobId, setActiveJobId] = useState(null);

    // UI
    const [activeSection, setActiveSection] = useState('intro');

    // Live signals for progressive rendering. The pipeline checkpoints its whole state
    // after every invocation; `serializeJob`'s `live` slice hands us the signals as they
    // are analyzed, so the report fills in instead of the founder watching a spinner for
    // fifteen minutes. Replaced wholesale by the persisted report once the run completes.
    const [liveSignals, setLiveSignals] = useState([]);
    const [liveV6, setLiveV6] = useState(null);
    const [liveMeta, setLiveMeta] = useState(null); // { signalCount, briefReady, degradations, depthGaps, startedAt }
    // The Desk is home once Bahirjee knows a company. This is the escape hatch back to the
    // intake form — "analyse a new company" is now an action taken FROM the desk, not the
    // first thing a returning founder is asked for.
    const [showIntake, setShowIntake] = useState(false);

    // "Help me decide" is now a real session rather than a length heuristic on a textarea.
    // Held here rather than inside DecisionSession because the judgment has to survive the
    // component unmounting — a founder who navigates away mid-session and comes back should
    // not have to answer four questions again.
    const [decision, setDecision] = useState(null);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [history, setHistory] = useState([]);
    const [searchTerm, setSearchTerm] = useState(''); // Search state
    const [reportFilter, setReportFilter] = useState('');

    // Guards the "Confirm & Analyze" submit against a double-click / double-tap firing
    // handleConfirmContext twice. A ref is used (not just state) because the guard must be
    // synchronous: two click events can both run to their `await` before React re-renders
    // and disables the button, and the second call would otherwise resume the same job
    // twice — the first resume flips it out of awaiting_context_review, so the second gets
    // a 409 "Job is processing, not awaiting context review".
    const confirmingContextRef = useRef(false);
    const [isConfirmingContext, setIsConfirmingContext] = useState(false);
    // Set when the founder asks for every field from the confirmation screen. Sticky for
    // the session so they are not bounced back to five sentences on the next render.
    const [showFullContextEditor, setShowFullContextEditor] = useState(false);
    // { blocking: boolean, bullets: string[] } when the readiness gate needs a decision.
    const [readinessGate, setReadinessGate] = useState(null);
    // Same class of guard for the intake screen's initial submit — see handleUrlSubmit.
    const submittingUrlRef = useRef(false);

    // Load history on mount or when user changes
    // Reload history when auth settles, and once more when a run completes (to pick up the
    // just-saved report). Keying on `phase` directly refetched the entire list on every
    // transition — 4-5× per analysis — for no benefit, since history is only shown on the
    // intake/home and complete screens.
    const historyReloadKey = phase === 'complete' ? 'complete' : 'other';
    useEffect(() => {
        // Wait for auth (and therefore `profile`) to settle. Running while auth is still
        // loading fired the whole history query twice per landing: once user-scoped with
        // profile still null, then again client-scoped once it resolved.
        if (authLoading) return;

        const loadHistory = async () => {
            if (user?.id) {
                // Client-scoped when the user belongs to an org, so every member sees
                // the whole company's reports — not only the ones they personally ran.
                const fetchedHistory = await historyService.getHistory(user.id, profile?.client_id || null);
                setHistory(fetchedHistory || []);
            } else {
                setHistory([]);
            }
        };
        loadHistory();
    }, [historyReloadKey, user?.id, profile?.client_id, authLoading]);

    const deskDomain = customCompany?.domain
        || history[0]?.target_domain
        || extractTargetDomain(history[0]?.inputs?.websiteUrl || '')
        || profile?.clients?.target_domain
        || null;

    // Load real workspace targets and agenda for this client and domain
    useEffect(() => {
        if (!profile?.client_id && !deskDomain) return;
        let cancelled = false;
        (async () => {
            try {
                const [t, a] = await Promise.all([
                    profile?.client_id ? listTargets(profile.client_id) : Promise.resolve([]),
                    (profile?.client_id && deskDomain) ? listAgenda(profile.client_id, deskDomain) : Promise.resolve([]),
                ]);
                if (!cancelled) {
                    if (t) setRealTargets(t);
                    if (a) setRealAgenda(a);
                }
            } catch (err) {
                console.warn('[IntelligenceDashboard] Failed loading live targets/agenda:', err);
            }
        })();
        return () => { cancelled = true; };
    }, [profile?.client_id, deskDomain, historyReloadKey]);

    // Reactively compute the real workspace data
    const workspaceData = useMemo(() => {
        return workspaceService.buildWorkspaceData({
            clientId: profile?.client_id || null,
            companyDomain: deskDomain,
            companyName: customCompany?.name || history[0]?.context?.company_name || profile?.clients?.name,
            history,
            dbTargets: realTargets,
            dbAgenda: realAgenda,
            customCompany
        });
    }, [profile?.client_id, deskDomain, history, realTargets, realAgenda, customCompany]);

    // Friendly URL: while a brief is on screen, show /company/<slug> in the address bar
    // (e.g. /company/caremother) so the visible URL is copy-shareable. replaceState only —
    // no router navigation, so dashboard state is untouched; the /company/:slug route
    // makes the URL refresh- and deep-link-safe via ReportViewer.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const domain = finalReport?.target_domain
            || extractTargetDomain(finalReport?.inputs?.websiteUrl || '');
        const slug = companySlugFromDomain(domain);
        if (phase === 'complete' && slug) {
            window.history.replaceState(null, '', `/company/${slug}`);
        } else if (window.location.pathname.startsWith('/company/')) {
            window.history.replaceState(null, '', '/');
        }
    }, [phase, finalReport]);

    useEffect(() => {
        // `generating_context` polls the same job: the server is building context and will
        // park it in `awaiting_context_review`. `analyzing` polls it through to completion.
        if ((phase !== 'live' && phase !== 'generating_context') || !activeJobId) return;

        let cancelled = false;
        let timerId = null;
        // On Hobby the stepped pipeline runs one step per 60s invocation, so a full run spans
        // several minutes of polling. Two consequences we must handle:
        //  1) A transient network blip / cold-start 5xx is near-certain across 100+ requests.
        //     It must NOT kill the run — the job keeps executing server-side.
        //  2) Fixed 3s polling generates needless request volume (and blip exposure) on a run
        //     that takes minutes, so the interval widens as the run goes on.
        let consecutiveErrors = 0;
        let pollCount = 0;
        const MAX_POLL_ERRORS = 5;
        const nextDelay = () => (pollCount < 10 ? 3000 : pollCount < 30 ? 5000 : 8000);

        // The live cursor lives in the closure, not in state: the poll must read the value
        // it just advanced, and a state write would not be visible until the next render.
        let sinceSignal = 0;
        let haveV6 = false;

        const pollJob = async () => {
            pollCount += 1;
            try {
                const job = await getIntelligenceJob(
                    activeJobId,
                    phase === 'live' ? { sinceSignal, haveV6 } : null
                );
                if (cancelled) return;
                consecutiveErrors = 0;

                const live = job.live;
                if (live) {
                    // `reset` means stepAnalyze's cross-batch dedupe shrank the array below
                    // our cursor, so index slicing is no longer valid — replace, don't append.
                    if (live.reset) {
                        sinceSignal = live.signals.length;
                        setLiveSignals(live.signals);
                    } else if (live.signals.length > 0) {
                        sinceSignal = live.sliceFrom + live.signals.length;
                        setLiveSignals(prev => [...prev, ...live.signals]);
                    }
                    if (live.v6) { haveV6 = true; setLiveV6(live.v6); }
                    // The server only serializes context while a job awaits review, so this
                    // is what lets a mid-run reload rebuild the context card.
                    if (live.context) setContextData(prev => prev || live.context);
                    setLiveMeta({
                        signalCount: live.signalCount,
                        briefReady: live.briefReady,
                        hunt: live.hunt || null,
                        degradations: live.degradations,
                        depthGaps: live.depthGaps,
                        startedAt: job.started_at || null,
                        runTier: job.run_tier || 'full'
                    });
                }

                const latestMessage = job.progress_log?.[job.progress_log.length - 1]?.message;
                setStatusMsg(job.current_step || latestMessage || 'Analysis in progress...');

                // The server built the company context and parked the job. Route to the
                // onboarding → review flow — but ONLY from 'generating_context' (the build /
                // reconnect phase). From 'live' the founder has already confirmed and is
                // being polled through to completion; a read that still says
                // awaiting_context_review there is transient staleness right after resume, and
                // bouncing back to onboarding is exactly the regression we're guarding against.
                if (job.status === 'awaiting_context_review') {
                    if (phase !== 'generating_context') {
                        // Not ready yet from this phase's perspective — keep polling.
                        timerId = window.setTimeout(pollJob, 3000);
                        return;
                    }
                    const ctx = job.context_for_review;
                    if (!ctx) throw new Error('Context review requested but no context was returned.');
                    setContextData(ctx);
                    setOnboardingData(await buildOnboardingPrefill(ctx));
                    setPhase('onboarding');
                    return;
                }

                // Live signals are read from the job's own checkpoint above (`job.live`),
                // not from a separate getLiveSignals(run_id) query against
                // structured_signals — that table is only written in stepPersist, the LAST
                // step, so it is empty for the entire run this stream exists to cover.

                if (job.status === 'completed' && job.report_id) {
                    const { data, error } = await getReportById(job.report_id);
                    if (cancelled) return;
                    if (error || !data) {
                        // Terminal, NOT a transient blip. The analysis succeeded and the brief
                        // is saved — only the read-back failed, which means RLS hid the row
                        // from this session (the browser has no Supabase JWT under
                        // DEV_AUTH_BYPASS, so auth.uid() is null and the select returns 0 rows).
                        // Throwing here sent it to the network-retry path below, which burned
                        // 5 retries on something that can never succeed and then told the
                        // founder "Lost connection… reload to reconnect" — wrong on both counts.
                        console.error(
                            `[Poll] Job ${activeJobId} completed with report ${job.report_id}, but the report could not be read back:`,
                            error?.message
                        );
                        setActiveJobId(null);
                        setPhase('error');
                        setStatusMsg(
                            'Your analysis finished and the brief was saved, but it could not be opened with this account. ' +
                            'Sign in again to view it — the brief is safe in your history.'
                        );
                        return;
                    }

                    const mappedReport = mapReportRowToAppReport(data);
                    setFinalReport(mappedReport);
                    setContextData(mappedReport.context);
                    setAnalysisMode(mappedReport.reportKind === DECISION_MODE ? DECISION_MODE : COMPANY_MODE);
                    setDecisionText(mappedReport.decisionContext?.raw_input || mappedReport.decisionContext?.decision_statement || '');
                    memoryService.recordAnalysis(urlInput, mappedReport.context);
                    // The persisted report is authoritative — it carries the cross-batch
                    // dedupe, the freshness downgrade and the verifier's drops that the
                    // streamed signals predate. Drop the live set rather than merging.
                    setLiveSignals([]);
                    setLiveV6(null);
                    setLiveMeta(null);
                    setActiveJobId(null);
                    setPhase('complete');
                    setActiveSection('intro');
                    return;
                }

                if (job.status === 'failed') {
                    setActiveJobId(null);
                    setPhase('error');
                    setStatusMsg(job.error_message || latestMessage || 'Analysis failed.');
                    return;
                }
            } catch (error) {
                if (cancelled) return;
                consecutiveErrors += 1;

                if (consecutiveErrors < MAX_POLL_ERRORS) {
                    // Keep activeJobId/phase intact and back off — the analysis is still
                    // running server-side; we just lost this one status read.
                    console.warn(`[Poll] Status check failed (${consecutiveErrors}/${MAX_POLL_ERRORS}): ${error.message}. Retrying...`);
                    setStatusMsg('Reconnecting to the analysis service...');
                    timerId = window.setTimeout(pollJob, Math.min(3000 * 2 ** (consecutiveErrors - 1), 15000));
                    return;
                }

                setActiveJobId(null);
                setPhase('error');
                setStatusMsg(
                    /failed to fetch|networkerror|load failed/i.test(error.message || '')
                        ? 'Lost connection to the analysis service. Your report may still be processing — reload the page to reconnect.'
                        : (error.message || 'Unable to track analysis job.')
                );
                return;
            }

            timerId = window.setTimeout(pollJob, nextDelay());
        };

        // Background tabs get their timers throttled, which both stalls the poll and makes
        // in-flight fetches more likely to fail. Re-check immediately on refocus.
        const onVisible = () => {
            if (cancelled || document.visibilityState !== 'visible') return;
            if (timerId) window.clearTimeout(timerId);
            void pollJob();
        };
        document.addEventListener('visibilitychange', onVisible);

        void pollJob();

        return () => {
            cancelled = true;
            document.removeEventListener('visibilitychange', onVisible);
            if (timerId) window.clearTimeout(timerId);
        };
    }, [activeJobId, phase, urlInput]);

    // `activeJobId` lives only in React state — a reload during a context build (which can
    // run 20-40s) otherwise strands that job: nothing can resume it, and the server-side
    // spam guard blocks starting a new one, dead-ending the founder on "already in
    // progress". Reconnect once on load so the poll effect above can pick it back up.
    const recoveredActiveJobRef = useRef(false);
    useEffect(() => {
        if (authLoading || !user || isAdmin || recoveredActiveJobRef.current) return;
        // View-only users never own a job — don't poll on their behalf.
        if (profile?.role === 'brief_viewer') return;
        if (phase !== 'idle' || activeJobId) return;
        recoveredActiveJobRef.current = true;

        (async () => {
            try {
                const job = await getActiveIntelligenceJob();
                if (!job) return;
                setActiveJobId(job.id);
                // Restore the URL so the intake form isn't blank if we land back there.
                if (job.website_url) setUrlInput(job.website_url);

                // Branch on the real status. Unconditionally using 'generating_context'
                // routed a mid-analysis reload to IntakeScreen — the founder saw the URL
                // form with a disabled submit button, which reads as "nothing happened"
                // four minutes into a six-minute run.
                //
                // 'awaiting_context_review' must stay on 'generating_context': the poll
                // effect only routes that status to onboarding from this phase.
                if (job.status === 'pending' || job.status === 'processing') {
                    setPhase('live');
                } else {
                    setPhase('generating_context');
                }
                setStatusMsg(job.current_step || 'Reconnecting to your analysis...');
            } catch (error) {
                console.warn('[IntelligenceDashboard] Active job reconnect failed:', error.message);
            }
        })();
    }, [authLoading, user, isAdmin, profile?.role, phase, activeJobId]);

    // Filter history based on search term
    const [selectedMonth, setSelectedMonth] = useState('All'); // History Month Filter

    // Filter history based on search term AND selected month
    const filteredHistory = useMemo(() => {
        let filtered = history;

        // Filter by Month
        if (selectedMonth !== 'All') {
            filtered = filtered.filter(h => {
                const date = new Date(h.timestamp);
                const monthYear = date.toLocaleString('default', { month: 'long', year: 'numeric' });
                return monthYear === selectedMonth;
            });
        }

        // Filter by Search Term. `inputs` is derived from a nullable column, so guard it —
        // an unguarded read here threw inside the history drawer and, with no boundary
        // above it, took the whole app down.
        if (searchTerm) {
            const needle = searchTerm.toLowerCase();
            filtered = filtered.filter(h =>
                (h.inputs?.websiteUrl || h.target_domain || '').toLowerCase().includes(needle) ||
                new Date(h.timestamp).toLocaleDateString().includes(searchTerm)
            );
        }

        return filtered;
    }, [history, searchTerm, selectedMonth]);

    // Get unique months from history for dropdown
    const availableMonths = useMemo(() => {
        const months = new Set();
        history.forEach(h => {
            const date = new Date(h.timestamp);
            months.add(date.toLocaleString('default', { month: 'long', year: 'numeric' }));
        });
        return ['All', ...Array.from(months)];
    }, [history]);

    // The server returns a stable machine code, never user copy. A refused personal
    // address is not the same failure as an unapproved company, and telling someone on
    // gmail to "ask an admin" sends them nowhere.
    const noAccessMessage = (reason) => {
        switch (reason) {
            case 'personal_email':
            case 'disposable_email':
                return 'Bahirjee needs a work email — your workspace is scoped to your company domain.';
            case 'shared_institution':
                return 'That domain is shared by many unrelated people, so it cannot become a single workspace. Use a company address, or ask us to set you up.';
            case 'blocked_domain':
            case 'invalid_domain':
                return "That email address can't be used to sign in. Check it, or ask us to set you up.";
            default:
                return "That email isn't on an approved domain yet. Ask an admin to add you, or use /admin/login if you're an admin.";
        }
    };

    /**
     * Persist the assumptions the founder chose to track after reading the brief.
     *
     * Written through the same `startup_contexts.onboarding_inputs` row onboarding uses, so
     * the next run's `buildStartupContext` picks them up with no new storage and no
     * migration — `getLatestOnboardingInputs` already seeds the form from there.
     *
     * Merged with the existing answers rather than replacing them: this row also carries
     * the business core and sensitivity snapshot, and writing only the bets would erase
     * both.
     */
    const handleTrackAssumptions = async (assumptions) => {
        const clientId = profile?.client_id;
        if (!clientId || !Array.isArray(assumptions) || assumptions.length === 0) return;
        try {
            const existing = (await getLatestOnboardingInputs(clientId)) || {};
            // Dedupe on the statement so re-tracking the same bet does not accumulate.
            const seen = new Set();
            const merged = [...assumptions, ...(existing.assumptions || [])]
                .filter(a => a?.statement)
                .filter(a => {
                    const key = a.statement.trim().toLowerCase();
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                })
                .slice(0, 8);
            await saveOnboardingInputs(clientId, { ...existing, assumptions: merged });
            toast.success(`Tracking ${merged.length} assumption${merged.length === 1 ? '' : 's'} from the next run.`);
        } catch (error) {
            console.warn('[assumptions] track failed:', error.message);
            toast.error('Could not save those assumptions. They are still in this brief.');
        }
    };

    // Founder auth is a single passwordless magic-link path (no signin/signup split).
    const handleLogin = async (e) => {
        e.preventDefault();
        setAuthError('');
        setAuthNotice('');

        const trimmedEmail = email.trim().toLowerCase();
        if (!trimmedEmail) {
            setAuthError('Please enter your approved work email.');
            return;
        }

        try {
            const result = await requestAuthLink(trimmedEmail);
            // Three outcomes from the server, and only one of them means an email is on
            // the way. The other two used to fall through to the same "check your email"
            // notice as a real send — which is wrong, because nothing was sent.
            if (result?.signedIn) {
                // Auto-access domain: the auth state change re-renders into the app.
            } else if (result?.adminRedirect) {
                setAuthError('Admin accounts sign in at /admin/login, not here.');
            } else if (result?.noAccess) {
                setAuthError(noAccessMessage(result.reason));
            } else if (result?.selfServe) {
                // Say plainly that the workspace is shared with their domain. Anyone else
                // at the same company who signs up lands in it and can read these briefs —
                // that must never be something they discover afterwards.
                setAuthNotice(`Check your email for a secure sign-in link. Your workspace is shared with everyone at ${trimmedEmail.split('@')[1]}.`);
            } else {
                setAuthNotice('Check your email for a secure sign-in link.');
            }
        } catch (error) {
            setAuthError(getFriendlyError(error.message).friendly || 'Authentication failed');
        }
    };

    // ── Mapping: Gemini auto-inferred → onboarding form defaults ──
    const extractOnboardingDefaults = (ctx) => {
        if (!ctx) return {};
        const dna = ctx.company_dna || {};
        const anchors = ctx.strategic_anchors || {};

        // Revenue model: keyword-match from operational_reality
        const opReality = (anchors.operational_reality || '').toLowerCase();
        let revenueModel = '';
        if (opReality.includes('subscription') || opReality.includes('saas')) revenueModel = 'Subscription';
        else if (opReality.includes('usage') || opReality.includes('metered')) revenueModel = 'Usage-based';
        else if (opReality.includes('enterprise contract')) revenueModel = 'Enterprise contracts';
        else if (opReality.includes('marketplace')) revenueModel = 'Marketplace';
        else if (opReality.includes('hybrid')) revenueModel = 'Hybrid';

        // Customer type from buyer_type (handle both string and compound object)
        const buyerMap = { 'Enterprise': 'Enterprise', 'Mid-Market': 'Mid-market', 'SMB': 'SMB' };
        const rawBuyer = typeof anchors.buyer_type === 'object' ? anchors.buyer_type.primary : anchors.buyer_type;
        const customerType = buyerMap[rawBuyer] || '';

        // Sales motion from optimization focus + positioning (handle both string and compound object)
        let salesMotion = '';
        const focus = (anchors.current_optimization?.focus || '').toLowerCase();
        const rawPos = typeof anchors.positioning === 'object' ? anchors.positioning.stance : anchors.positioning;
        const posLower = (rawPos || '').toLowerCase();
        if (posLower.includes('plg') || opReality.includes('product-led')) salesMotion = 'PLG';
        else if (rawBuyer === 'Enterprise' || posLower.includes('sales')) salesMotion = 'Sales-led';
        else if (posLower.includes('hybrid')) salesMotion = 'Hybrid';

        // Funding stage mapping
        const stageMap = {
            'pre-seed': 'Pre-Seed', 'seed': 'Seed', 'series-a': 'Series A',
            'series-b': 'Series B', 'series-c+': 'Series C+',
            'bootstrapped': 'Bootstrapped', 'public': 'Public'
        };
        const fundingStage = stageMap[(dna.funding_stage || '').toLowerCase()] || '';

        // Sensitivity Snapshot: map Gemini's inferred sensitivity_map (same six dimensions as
        // the form) into form defaults. Undefined levels fall back to the form's 'Medium'.
        const sens = ctx.sensitivity_map || {};
        const level = (v) => {
            const raw = (v && typeof v === 'object' ? v.level : v) || '';
            const s = String(raw).toLowerCase();
            if (s.startsWith('high')) return 'High';
            if (s.startsWith('low')) return 'Low';
            if (s.startsWith('med')) return 'Medium';
            return undefined;
        };

        // Market Bets: the founder's own document states these far more precisely than
        // they will retype into a form, so prefill from it when a document was uploaded.
        const docIntel = ctx._docIntel;
        const assumptions = (docIntel?.strategic_bets || []).slice(0, 3).map(bet => ({
            statement: bet.statement || '',
            domain: bet.domain || 'Demand',
            sensitivity: 'High',
        }));

        return {
            revenueModel,
            customerType,
            salesMotion,
            fundingStage,
            geography: ctx.operating_geography || (docIntel?.geographies || [])[0] || '',
            infraCost: level(sens.infra_cost),
            revenueSlowdown: level(sens.revenue_slowdown),
            hiringDependency: level(sens.hiring_dependency),
            competitivePressure: level(sens.competitive_pressure),
            regulatoryExposure: level(sens.regulatory_exposure),
            platformDependency: level(sens.platform_dependency),
            ...(assumptions.length > 0 ? { assumptions } : {}),
            // Pass raw context for the "Bahirjee understood" card
            _autoInferred: {
                companyName: ctx.company_name || docIntel?.company_name || '',
                industry: ctx.industry || '',
                vertical: ctx.vertical_specialization || '',
                teamSize: dna.team_size || '',
                growthSignals: dna.growth_signals || '',
                ...(docIntel ? {
                    documentType: docIntel.doc_type,
                    documentAsOf: docIntel._vintage?.asOf || null,
                    documentStale: Boolean(docIntel._vintage?.stale),
                    namedCompetitors: (docIntel.named_competitors || []).map(c => c.name),
                    namedCustomers: (docIntel.named_customers || []).map(c => c.name),
                    metrics: docIntel.metrics || {},
                } : {}),
            }
        };
    };

    // Hours within which we offer the existing report instead of burning a fresh run.
    const RECENT_RUN_HOURS = 12;

    // Step 1: URL submission → offer the stored context, or build one
    //
    // `forceRebuild` is the gate's "Rebuild from scratch" button: it skips the lookup so a
    // founder whose stored context is simply wrong can always get a fresh read. That is not
    // a nicety — for a profile with a locked website URL it is the only escape.
    //
    // `override` exists for callers that set the inputs and submit in the same handler (the
    // Desk's decision, composite and anchor flows). setState does not change THIS render's
    // closure, so those callers used to submit the previous values: a decision saved from
    // the Desk ran as a company run, and anchoring a new company with an empty URL field
    // toasted "Starting scan…" and returned. Callers still set state too — the steps after
    // this one (gate, onboarding, confirm) run in later renders and read it from there.
    const handleUrlSubmit = async (forceFresh = false, forceRebuild = false, override = null) => {
        const url = override?.url ?? urlInput;
        const mode = override?.mode ?? analysisMode;
        const question = override?.decisionText ?? decisionText;
        // IntakeScreen's submit button disables on `phase !== 'idle'`, but that's a
        // React-controlled attribute — it only takes effect after a re-render, which a
        // fast double-click/double-tap can beat. Guard synchronously too, same reasoning
        // as handleConfirmContext below.
        if (!url || submittingUrlRef.current) return;
        if (mode === DECISION_MODE && question.trim().length < 12) {
            toast.error('Describe the decision you want Bahirjee to help you think through.');
            return;
        }

        // ── The gate: what should this run start from? ──────────────────────────────
        //
        // Two questions used to be asked in two separate interruptions — "do you need a new
        // run at all?" (the 12-hour recent-brief modal) and, 20–40 seconds of rebuilding
        // later, "is this context right?". They are one decision, so they are one screen.
        //
        // Everything here happens BEFORE a job exists, so nothing below reserves a run or
        // spends a credit. A founder who cancels at the gate has cost nothing at all.
        let recentBrief = null;
        let lastReport;  // undefined = not fetched; null = fetched, nothing there
        if (profile?.client_id) {
            try {
                const { data: existing } = await getLastReportForUrl(profile.client_id, url);
                lastReport = existing || null;
                if (existing?.created_at && mode === COMPANY_MODE) {
                    const ageMinutes = Math.round((Date.now() - new Date(existing.created_at).getTime()) / 60000);
                    if (ageMinutes >= 0 && ageMinutes < RECENT_RUN_HOURS * 60) {
                        recentBrief = { report: existing, ageMinutes };
                    }
                }
            } catch (e) {
                console.warn('Recent-report lookup failed (continuing):', e.message);
            }
        }

        if (!forceRebuild && profile?.client_id) {
            try {
                // `lastReport` is handed over so the fallback branch costs no second query.
                const stored = await getCurrentCompanyContext(profile.client_id, url, {
                    fallbackReport: lastReport,
                });
                if (stored?.context) {
                    const hydrated = hydrateStoredContext(stored.context);
                    setContextData(hydrated);
                    setContextOrigin(stored.origin === 'stored' ? 'reused' : 'built');
                    const meta = {
                        origin: stored.origin,
                        version: stored.version,
                        source: stored.source,
                        builtFrom: stored.builtFrom,
                        createdAt: stored.createdAt,
                    };
                    setStoredContextMeta(meta);
                    setContextGate({
                        meta,
                        staleness: describeContextStaleness(hydrated, stored.createdAt),
                        recentBrief,
                    });
                    setPhase('context_gate');
                    return;
                }
            } catch (e) {
                // A lookup failure must never block a run — it costs a rebuild, nothing more.
                console.warn('Stored-context lookup failed (rebuilding):', e.message);
            }
        }

        // No context to offer. If a very recent brief exists anyway (a report whose context
        // column is empty — pre-v6 rows, or a run that degraded), still spare the founder a
        // duplicate run with the original prompt.
        if (!forceFresh && recentBrief) {
            setRecentReportPrompt(recentBrief);
            return;
        }

        submittingUrlRef.current = true;

        setPhase('generating_context');
        setStatusMsg('Preparing context for review...');

        // Extract text from every attached document. One request per file — Vercel caps a
        // request body at ~4.5 MB, so five 4 MB files cannot be batched.
        const { docs: parsedDocs, text: uploadedDocText } = await uploadAndParseDocuments(uploadedFiles, {
            onStatus: setStatusMsg,
            clientId: profile?.client_id,
            websiteUrl: url,
        });

        // Pull named competitors, customers, investors and stated bets out of the
        // founder's own documents. These are the only internally-attested entities the
        // pipeline ever sees, and they go on to claim a reserved slice of the search
        // budget. Non-blocking: a failure leaves the pipeline exactly as it was.
        let docIntel = null;
        if (uploadedDocText) {
            setStatusMsg('Extracting entities from your documents...');
            try {
                const [{ extractDocumentIntel }, { callLLMAction }] = await Promise.all([
                    import('../services/documentIntelService'),
                    import('../services/intelligenceService'),
                ]);
                docIntel = await extractDocumentIntel(uploadedDocText, {
                    companyHint: profile?.company_name || '',
                    callLLM: callLLMAction,
                });
            } catch (e) {
                console.warn('Document intel extraction skipped:', e.message);
            }
        }

        try {
            setStatusMsg('Deploying Deep Web Reader...');
            const ctxData = await buildInitialContext(url, linkedinInput || null, setStatusMsg, uploadedDocText);

            if (mode === DECISION_MODE) {
                setStatusMsg('Structuring the decision for your review...');
                const frame = await buildDecisionFrame(question, ctxData);
                ctxData._decision = frame;
            }

            // Carried on the context so enrichContextWithOnboarding() can fold these
            // entities into the watchlist once the founder completes onboarding.
            if (docIntel) {
                ctxData._docIntel = docIntel;
                ctxData._documentQuality = parsedDocs.map(d => ({ fileName: d.fileName, ...d.quality }));
            }

            // Route the client-built context through Onboarding → Context Review BEFORE any job
            // exists. handleConfirmContext creates the job only once the founder confirms, so an
            // abandoned review costs nothing and never reserves their free run. (The doc text is
            // already baked into ctxData by buildInitialContext, so the job doesn't need it.)
            setContextData(ctxData);
            setOnboardingData(await buildOnboardingPrefill(ctxData));
            setPhase('onboarding');
            submittingUrlRef.current = false;
        } catch (e) {
            // ErrorScreen's "Home" button routes back to 'idle', which remounts IntakeScreen —
            // the ref must release here or a retry would be silently swallowed forever.
            submittingUrlRef.current = false;
            setPhase('error');
            setStatusMsg(e.message);
        }
    };

    // Onboarding form prefill: auto-inferred defaults, overlaid with the founder's
    // previously-saved answers so a returning founder doesn't re-enter Business /
    // Sensitivity / Bets. Their prior explicit answers win; the "Bahirjee understood"
    // card keeps the fresh inference.
    const buildOnboardingPrefill = async (ctx) => {
        const defaults = extractOnboardingDefaults(ctx);
        if (!profile?.client_id) return defaults;
        // The answers carried ON this context win over the client-wide saved ones: a client
        // tracking two companies has one row in startup_contexts but two different
        // businesses, and the wrong revenue model quietly steers the whole run.
        const saved = ctx?._onboardingData || await getLatestOnboardingInputs(profile.client_id);
        return saved ? { ...defaults, ...saved, _autoInferred: defaults._autoInferred } : defaults;
    };

    // ── Context gate actions ────────────────────────────────────────────────────

    const handleGateContinue = async () => {
        setIsMerging(true);
        try {
            let ctx = contextData;

            // Reuse strips the stored _decision — replaying a frame built for a different
            // question would be worse than having none. So the frame for THIS question has
            // to be built here; the build path does it inline, and without this the
            // readiness gate hard-stops a decision run on a reused context with
            // "Describe the decision…" and no way forward.
            if (analysisMode === DECISION_MODE && decisionText.trim().length >= 12) {
                setStatusMsg('Structuring the decision for your review...');
                const frame = await buildDecisionFrame(decisionText, ctx);
                ctx = { ...ctx, _decision: frame };
                setContextData(ctx);
            }

            // Onboarding is always re-walked, prefilled from the answers this context was
            // built with. It is a confirmation pass rather than re-entry — and it stops the
            // business profile ageing silently alongside a context reused for months.
            setOnboardingData(await buildOnboardingPrefill(ctx));
            setContextGate(null);
            setPhase('onboarding');
        } catch (e) {
            console.warn('Could not frame the decision:', e.message);
            toast.error(getFriendlyError(e?.message).friendly);
        } finally {
            setIsMerging(false);
            setStatusMsg('');
        }
    };

    /**
     * Read the newly-supplied pages/documents and fold them into the stored context.
     *
     * Stays on the gate throughout: the merge is an amendment to the context on screen, not
     * a new flow, and returning to the same screen with a receipt is what makes "1 update
     * skipped because you had corrected that field" legible rather than mysterious.
     */
    const handleAddSources = async ({ urls, files }) => {
        setIsMerging(true);
        setMergeReceipt(null);
        try {
            const { text: newDocText } = await uploadAndParseDocuments(files, {
                onStatus: setStatusMsg,
                clientId: profile?.client_id,
                websiteUrl: urlInput,
            });

            const { context: merged, receipt, pages } = await enrichStoredContext({
                storedContext: contextData,
                newUrls: urls,
                newDocText,
                onProgress: setStatusMsg,
            });

            setContextData(merged);
            setContextOrigin('merged');
            setMergeReceipt({ ...receipt, pagesRead: pages.length, docsRead: files.length });
            setContextGate(gate => gate && {
                ...gate,
                staleness: describeContextStaleness(merged, new Date().toISOString()),
            });
            setAddSourcesOpen(false);
        } catch (e) {
            // A failed merge must leave the founder exactly where they were, with the
            // context they already had — never on an error screen having lost the gate.
            console.warn('Merge failed:', e.message);
            toast.error(getFriendlyError(e?.message).friendly);
        } finally {
            setIsMerging(false);
            setStatusMsg('');
        }
    };

    const confirmRebuild = () => {
        setRebuildGate(false);
        setContextGate(null);
        setStoredContextMeta(null);
        setContextData(null);
        setContextOrigin('rebuilt');
        // forceFresh AND forceRebuild: skip both the recency prompt and the lookup that
        // would just hand back the context we are deliberately discarding.
        void handleUrlSubmit(true, true);
    };

    const handleGateCancel = () => {
        setContextGate(null);
        setStoredContextMeta(null);
        setContextData(null);
        setPhase('idle');
    };

    // Step 2: Onboarding complete → attach data, build structured context, go to review
    const handleOnboardingComplete = async (formData) => {
        setOnboardingData(formData);
        // Persist the founder's answers for reuse on future runs (best-effort).
        if (profile?.client_id) {
            void saveOnboardingInputs(profile.client_id, formData);
        }
        // Attach onboarding data to context AND derive the structured signal layer now that
        // the founder's Sensitivity Snapshot + Market Bets exist — so exposure weights,
        // entity watchlist, and signal weights actually drive the pipeline on the first run.
        if (contextData && formData) {
            const merged = {
                ...contextData,
                _onboardingData: formData,
                ...(formData.industryOverride ? { industry: formData.industryOverride } : {})
            };
            const enriched = enrichContextWithOnboarding(merged, formData);
            setContextData(enriched);
        }
        setPhase('review_context');
    };

    // Pre-submit readiness gate. This is the highest-stakes decision in the funnel —
    // it spends the founder's run — and it used to be two native window.confirm()
    // dialogs whose OK/Cancel semantics were inverted ("OK = run anyway"). Now a real
    // dialog with buttons that say what they do.
    const handleConfirmContext = async () => {
        if (confirmingContextRef.current) return;

        // Decision-frame errors are a hard stop shown via toast, not the readiness gate
        // below — the gate gets a "proceed anyway" escape hatch and this must not. This
        // check has to run here rather than in runConfirmContext: the gate's own "proceed
        // anyway" button calls runConfirmContext directly, so by the time that happens
        // decision validity must already be settled.
        const decisionReadiness = analysisMode === DECISION_MODE
            ? validateDecisionFrame(contextData?._decision || {})
            : { ok: true, warnings: [], errors: [] };
        if (!decisionReadiness.ok) {
            toast.error(decisionReadiness.errors.join(' '));
            return;
        }

        const readiness = validateContextReadiness(contextData);
        if (!readiness.ok || readiness.warnings.length) {
            setReadinessGate({
                blocking: !readiness.ok,
                bullets: [...(readiness.blockers || []), ...(readiness.warnings || [])]
            });
            return;
        }
        await runConfirmContext();
    };

    const runConfirmContext = async () => {
        // Synchronous re-entrancy guard: a double-click/double-tap can fire this handler
        // twice before React re-renders to disable the button. The second call would
        // otherwise resume the same job twice — the first resume moves it out of
        // awaiting_context_review, so the second gets a 409.
        if (confirmingContextRef.current) return;

        setReadinessGate(null);

        confirmingContextRef.current = true;
        setIsConfirmingContext(true);
        setStatusMsg('Submitting analysis job...');

        // Re-derive the structured layer from the REVIEWED context, not the pre-review one.
        //
        // enrichContextWithOnboarding also runs in handleOnboardingComplete — before this
        // screen is shown. It snapshots context.key_competitors into
        // _startupContext.competitive_map.named_competitors (contextBuilder.extractCompetitiveMap),
        // and generateEntityWatchlist reads THAT, never context.key_competitors. So without
        // this second pass, a founder who deletes a wrong competitor on the review screen
        // still gets it tracked: in the watchlist, in _primarySources, and in Source Watch.
        // Nothing threw; the run was just quietly wrong about who the competitors were.
        //
        // Safe to run twice: it is deterministic and LLM-free, and
        // mergeDocIntelIntoStartupContext re-tags duplicates rather than appending. It mints
        // a fresh context_version_id, which is what we want — this run's entities must be
        // filed under the context that actually produced them.
        const finalContext = contextData?._onboardingData
            ? enrichContextWithOnboarding({ ...contextData }, contextData._onboardingData)
            : contextData;
        if (finalContext !== contextData) setContextData(finalContext);

        try {
            // The job already exists — the server built its context and has been waiting on
            // this confirmation. Resuming is also where the free-tier run is consumed, so a
            // founder who abandons this screen is never charged for it.
            const job = activeJobId
                ? await resumeIntelligenceJob(activeJobId, finalContext)
                : await submitIntelligenceJob({
                    websiteUrl: urlInput,
                    linkedinUrl: linkedinInput || null,
                    contextData: finalContext,
                    buildContextOnServer: false,
                    analysisMode,
                    decisionId: finalContext?._decision?.id || null,
                    decisionContext: finalContext?._decision || null
                });
            setActiveJobId(job.id);
            setStatusMsg(job.current_step || 'Job queued.');

            // Persist AFTER the job exists, so a submit that 409s never records a version
            // for a run that did not happen. Fire-and-forget and failure-tolerant: a
            // context that fails to store costs the NEXT run a rebuild, which is strictly
            // better than failing the run the founder is watching right now.
            //
            // N1: the target this write lands against comes from the RUN itself — the job
            // we just resumed or submitted — never from urlInput. For a product run
            // urlInput is (by design) the PARENT company's domain: on a server-context
            // build it is seeded from job.website_url, which v31 deliberately carries as
            // the parent's domain, so it can never be trusted to name the right target.
            // job.target_id is serializeJob's own field (lib/_intelligenceJobs.js) and is
            // set once at job creation, so the resume response reflects it exactly whether
            // it belongs to a product target or (unchanged) is absent for a plain company
            // run. Passing it through explicitly is what stops set_current_company_context
            // (v31) from falling back to resolving the type='company' row for this domain
            // and silently demoting the founder-approved company context.
            //
            // N4: the GUARD used to key off urlInput too, which handleRunTarget never sets
            // (fresh load → Desk → Run on a product card never touches the URL input) — so
            // every review edit made on that path was silently discarded; the row written at
            // creation by inheritCompanyContext was the only one that ever existed. The job
            // itself already knows its own website_url (serializeJob, lib/_intelligenceJobs.js) —
            // for a product run that's the parent's domain (by design, same as job.target_id
            // above), for a company run it is exactly what urlInput holds today. Prefer it,
            // falling back to urlInput only for the browser-built-context path, which has no
            // job websiteUrl of its own to read (job.website_url is set from the request either
            // way, so this fallback is realistically dead — kept only as a defensive floor).
            const contextWebsiteUrl = job.website_url || urlInput;
            if (profile?.client_id && contextWebsiteUrl) {
                const edited = Boolean(finalContext?._userEdits?.fields?.length
                    || finalContext?._userEdits?.removed?.length);
                void saveCompanyContext({
                    clientId: profile.client_id,
                    websiteUrl: contextWebsiteUrl,
                    context: finalContext,
                    source: edited && contextOrigin === 'reused' ? 'edited' : contextOrigin,
                    targetId: job.target_id || null,
                    builtFrom: {
                        urls: [contextWebsiteUrl],
                        linkedin: linkedinInput || null,
                        documents: (finalContext?._documentQuality || []).map(d => d.fileName).filter(Boolean),
                        captured_at: new Date().toISOString(),
                    },
                });
            }
            // Switch to 'live' (which starts the poll) ONLY after resume has committed
            // server-side. Flipping the phase before the await let the poll fire a GET that
            // raced the resume write, read the still-'awaiting_context_review' row, and
            // bounced the founder back to onboarding. The isConfirmingContext spinner covers
            // the interim so the review screen doesn't look frozen.
            setPhase('live');
        } catch (e) {
            setActiveJobId(null);
            setPhase('error');
            setStatusMsg(e.message);
        } finally {
            confirmingContextRef.current = false;
            setIsConfirmingContext(false);
        }
    };

    const handleQnA = async (signal, q) => {
        // Track 2: the tenant's memory graph gets the question first. A hit
        // answers from stored evidence with its path shown; the three
        // non-answer outcomes fall through — unknown_entity just means it is
        // not a memory question, not_in_graph/graph_unavailable degrade to the
        // existing ladder (labelled, never passed off as memory).
        if (profile?.client_id && q) {
            try {
                const { graphAsk, graphAnswered, graphProvenanceLine } = await import('../services/graphMemory.js');
                const g = await graphAsk(q);
                if (graphAnswered(g)) {
                    return `${g.answer}\n\n${graphProvenanceLine(g)}`;
                }
            } catch (e) {
                console.warn('[graph] ask skipped:', e.message);
            }
        }

        // RAG: pull the most relevant uploaded-document excerpts, plus (v29) the most
        // relevant signals/observations this platform has already found — askBahirjee's
        // Stage 1 answers from these before ever considering a live web search.
        let ragChunks = [];
        let knowledgeChunks = [];
        if (profile?.client_id && q) {
            try {
                const { retrieveRelevantChunks } = await import('../services/ragService');
                [ragChunks, knowledgeChunks] = await Promise.all([
                    retrieveRelevantChunks({ clientId: profile.client_id, query: q, kinds: ['uploaded_doc'] }),
                    retrieveRelevantChunks({ clientId: profile.client_id, query: q, kinds: ['signal', 'observation'] }),
                ]);
            } catch (e) {
                console.warn('RAG retrieval skipped:', e.message);
            }
        }
        return askBahirjee({
            ...(contextData || {}),
            brief: finalReport?.brief,
            signals: finalReport?.signals,
            memory: finalReport?.memory
        }, signal, q, ragChunks, { clientId: profile?.client_id || null, knowledgeChunks });
    };

    // v6.0: Handle reactions for impact tracking
    const handleV6React = async (shiftId, reactionType) => {
        if (user && profile?.client_id) {
            await recordImpactEvent({
                companyId: profile.client_id,
                userId: user.id,
                eventType: reactionType,
                shiftId,
                metadata: { source: 'strategic_awareness_surface' }
            });
        }
    };

    // Insight/signal emoji reactions → impact_events, so they feed the next run's
    // prioritization (getReactionPreferences → _reactionSignal) instead of being decorative.
    const handleInsightReact = async ({ eventType, text, theme }) => {
        if (user && profile?.client_id) {
            await recordImpactEvent({
                companyId: profile.client_id,
                userId: user.id,
                eventType,
                metadata: { source: 'insight_card', text, theme }
            });
        }
    };

    const loadReport = async (report) => {
        // History rows are summaries (id/created_at/website_url only) so the sidebar doesn't
        // drag ~500KB of JSONB into the landing page. Fetch the full report on open.
        let full = report;
        if (!report?.context && report?.id) {
            const { data, error } = await getReportById(report.id);
            if (error || !data) {
                setPhase('error');
                setStatusMsg(error?.message || 'Could not load that brief.');
                setHistoryOpen(false);
                return;
            }
            full = mapReportRowToAppReport(data);
        }

        setContextData(full.context);
        setFinalReport(full);
        setUrlInput(full.inputs?.websiteUrl || report.inputs?.websiteUrl || '');
        setActiveJobId(null);
        setPhase('complete');
        setHistoryOpen(false);
    };

    // ── Desk: "Run intelligence" on a target card ───────────────────────────────
    //
    // Same client helper, same job-polling and phase transitions as every other run — see
    // runConfirmContext below, which this deliberately does not duplicate. The server
    // resolves the target, refuses an archived or draft one, and derives everything else
    // (its website URL, analysis_mode, the product context) itself; the browser only ever
    // names which target it wants read. `websiteUrl` is included only to satisfy the
    // handler's "something to run against" gate for a COMPANY target run — once the server
    // resolves a targetId it derives the run's actual identity from the target's own
    // target_domain and ignores this value (see lib/handlers/intelligence.js).
    const handleRunTarget = async (target) => {
        // A card saved only in this browser (the old local-only product path) has an id no
        // server knows; sending it fails as a uuid error deep in the handler.
        try {
            // A product saved by an earlier build lives only in this browser (id `prod_<ts>`)
            // and has no row on the server, so the run would fail with a raw uuid error.
            // Register it for real once, retire the local copy, and run THAT.
            if (!isUuid(target?.id)) {
                if (target?.type !== 'product') {
                    toast.error(`${target?.name || 'That target'} was only saved in this browser. Add it again to run it.`);
                    return;
                }
                const migrated = await registerProduct({
                    name: target.name,
                    description: target.description,
                    canonical_url: target.canonical_url,
                });
                if (!migrated.ok) {
                    toast.error(migrated.message);
                    return;
                }
                const domain = deskDomain || 'company.com';
                workspaceService.saveLocalProducts(
                    domain,
                    workspaceService.getLocalProducts(domain).filter(p => p.id !== target.id)
                );
                target = migrated.target;
            }
            const job = await submitIntelligenceJob({ targetId: target.id, websiteUrl: target.targetDomain || deskDomain });
            setActiveJobId(job.id);
            setStatusMsg(job.current_step || 'Job queued.');
            // 'generating_context' is what the shared poll effect below watches for — it is
            // what routes a job parked at awaiting_context_review into the same review
            // screen a normal run uses, once the server has finished building context.
            setPhase('generating_context');
        } catch (e) {
            setPhase('error');
            setStatusMsg(e.message || 'Could not start that run.');
        }
    };

    // "Latest brief" on a target card must open THAT target's own report, never fall back
    // to the company's — presenting one subject's evidence under another subject's name is
    // exactly the failure this guards against. A company target keeps today's behaviour:
    // TargetList calls this with the COMPANY target itself when its own card is clicked,
    // and with no argument at all for the Today band's quiet-day invitation — both
    // correctly resolve to the company's own latest report.
    const handleOpenTargetBrief = async (target) => {
        if (!target || target.type !== 'product') {
            await loadReport(history[0]);
            return;
        }
        const { data, error } = await getLastReportForTarget(profile?.client_id, target.id);
        if (error) {
            toast.error('Could not open that brief.');
            return;
        }
        if (!data) {
            toast(`${target.name} hasn't been read yet — run it to get its first brief.`);
            return;
        }
        // Every other raw-row call site in this file maps through mapReportRowToAppReport
        // before loadReport — a raw row already HAS a `context` key, so loadReport's own
        // remap branch (`if (!report?.context && report?.id)`) never fires and this would
        // otherwise render unmapped: no timestamp, "No domain provided", and depthGaps
        // empty — silently hiding exactly what a shallow product run is supposed to
        // disclose (N3).
        await loadReport(mapReportRowToAppReport(data));
    };

    // Post-commit callback for user-shared signals. StrategicInteractionHub owns the
    // persistence (it owns the free-tier limit); this used to call trackNote a second
    // time, which would have written two `interactions` rows per shared signal.
    const handleShareSignal = async ({ type, content }) => {
        if (!user || !finalReport?.id) return { success: false, error: 'User not authenticated' };
        setStatusMsg('Noted. I will look harder at this next time I read.');
        return { success: true };
    };

    // ── BAHIRJEE INTELLIGENCE REDESIGN WORKSPACE HANDLERS ───────────────
    const handleAnchorCompany = async ({ url, name }) => {
        const domain = extractTargetDomain(url);
        const compName = name || (domain ? domain.split('.')[0] : 'Company');
        setCustomCompany({ domain, name: compName, canonical_url: url });
        setUrlInput(url);

        if (profile?.client_id) {
            try {
                await createTarget({
                    clientId: profile.client_id,
                    type: 'company',
                    name: compName,
                    targetDomain: domain,
                    sources: { canonicalUrl: url }
                });
            } catch (e) {
                console.warn('[handleAnchorCompany] Supabase target notice:', e.message);
            }
        }

        toast.success(`Anchored ${compName}. Starting market intelligence scan...`);
        void handleUrlSubmit(true, false, { url, mode: COMPANY_MODE });
    };

    // Create products against the matching server-side company target and return its UUID.
    const registerProduct = async (productInput) => {
        const { name, description, canonical_url } = productInput;
        const clientId = profile?.client_id;
        const domain = deskDomain;
        if (!clientId || !domain) {
            return { ok: false, message: 'Run your company first — a product has to belong to a company on file.' };
        }

        const findIn = (targets, predicate) => (targets || []).find(predicate) || null;
        let targets = realTargets;
        let company = findIn(targets, t => t.type === 'company' && t.targetDomain === domain);

        // Older workspaces can have a company brief without a target row yet.
        if (!company) {
            const created = await createTarget({
                clientId,
                type: 'company',
                name: workspaceData?.company?.name || domain.split('.')[0],
                targetDomain: domain,
                sources: { canonicalUrl: workspaceData?.company?.canonical_url || `https://${domain}` },
            });
            targets = await listTargets(clientId);
            company = findIn(targets, t => t.type === 'company' && t.targetDomain === domain)
                || (created.ok ? created.target : null);
            if (!company) return { ok: false, message: created.message || 'Could not set up your company target.' };
        }

        const inferred = productInput.inferred_context || {};
        const result = await createTarget({
            clientId,
            type: 'product',
            name,
            targetDomain: company.targetDomain || domain,
            parentTargetId: company.id,
            sources: { canonicalUrl: canonical_url },
            product: {
                category: inferred.category,
                positioning: inferred.positioning || description,
                competitor_products: inferred.competitors,
            },
        });

        targets = await listTargets(clientId);
        setRealTargets(targets);

        const wanted = String(name || '').trim().toLowerCase();
        const existing = findIn(targets, t => t.type === 'product'
            && t.parentTargetId === company.id
            && String(t.name || '').trim().toLowerCase() === wanted);
        if (!result.ok && existing && /already exists/i.test(result.message || '')) {
            return { ok: true, target: existing };
        }
        if (!result.ok) return { ok: false, message: result.message || 'Could not save that product.' };
        return { ok: true, target: findIn(targets, t => t.id === result.target.id) || result.target };
    };

    const handleSaveProduct = async (productInput) => {
        const saved = await registerProduct(productInput);
        if (!saved.ok) {
            toast.error(saved.message);
            return;
        }
        if (productInput.runImmediately) {
            toast.success(`"${saved.target.name}" registered. Starting scan...`);
            handleRunTarget(saved.target);
        } else {
            toast.success(`"${saved.target.name}" saved to targets (0 runs used).`);
        }
    };

    const handleSaveDecision = async (decisionInput) => {
        const domain = deskDomain || 'company.com';
        const newDec = {
            id: `dec_${Date.now()}`,
            question: decisionInput.question,
            status: 'active',
            latest_judgment: 'Decision registered. Evaluated against verified company context upon run.',
            confidence: 'Pending Run'
        };

        const existing = workspaceService.getLocalDecisions(domain);
        workspaceService.saveLocalDecisions(domain, [newDec, ...existing]);
        setRealAgenda(prev => [newDec, ...prev]);

        // deskDomain, not `domain` — see the placeholder note below.
        if (profile?.client_id && deskDomain) {
            try {
                await openQuestion({
                    clientId: profile.client_id,
                    targetDomain: deskDomain,
                    question: decisionInput.question,
                    origin: 'founder'
                });
            } catch (err) {
                console.warn('[handleSaveDecision] Supabase openQuestion:', err.message);
            }
        }

        if (decisionInput.runImmediately) {
            toast.success('Decision saved. Evaluating against live evidence...');
            // deskDomain, never `domain`: that falls back to a placeholder 'company.com'
            // for the local store's key, which must not become a URL a run reads.
            const decisionUrl = urlInput || (deskDomain ? `https://${deskDomain}` : '');
            setUrlInput(decisionUrl);
            setAnalysisMode(DECISION_MODE);
            setDecisionText(decisionInput.question);
            void handleUrlSubmit(true, false, {
                url: decisionUrl,
                mode: DECISION_MODE,
                decisionText: decisionInput.question,
            });
        } else {
            toast.success('Decision target registered (0 runs used).');
        }
    };

    const handleSaveMonitoringSetup = (setupInput) => {
        const domain = deskDomain || 'company.com';
        const existing = workspaceService.getLocalMonitoring(domain, workspaceData?.company?.name);
        const updated = [
            {
                id: `mon_${Date.now()}`,
                name: setupInput.name,
                scope_label: setupInput.scope_label,
                cadence: setupInput.cadence,
                is_active: setupInput.is_active,
                last_check_at: new Date().toISOString()
            },
            ...existing
        ];
        workspaceService.saveLocalMonitoring(domain, updated);
        toast.success(`Monitoring setup "${setupInput.name}" created.`);
    };

    const handleToggleMonitoringActive = (setupId) => {
        const domain = deskDomain || 'company.com';
        const existing = workspaceService.getLocalMonitoring(domain, workspaceData?.company?.name);
        const updated = existing.map(m => m.id === setupId ? { ...m, is_active: !m.is_active } : m);
        workspaceService.saveLocalMonitoring(domain, updated);
    };

    const handleRunComposite = async (scopeSelection) => {
        // Execute real scan for selected company, product, or decision!
        if (scopeSelection.company) {
            const targetUrl = workspaceData?.company?.canonical_url || (deskDomain ? `https://${deskDomain}` : null);
            if (targetUrl) {
                setUrlInput(targetUrl);
                setAnalysisMode(COMPANY_MODE);
                toast.success(`Starting intelligence scan for ${workspaceData?.company?.name || deskDomain}...`);
                await handleUrlSubmit(true, false, { url: targetUrl, mode: COMPANY_MODE });
                return;
            }
        }

        if (scopeSelection.product_ids?.length > 0) {
            const prodId = scopeSelection.product_ids[0];
            const prod = workspaceData?.products?.find(p => p.id === prodId);
            if (prod) {
                toast.success(`Starting intelligence scan for ${prod.name}...`);
                handleRunTarget(prod);
                return;
            }
        }

        if (scopeSelection.decision_ids?.length > 0) {
            const decId = scopeSelection.decision_ids[0];
            const dec = workspaceData?.decisions?.find(d => d.id === decId);
            if (dec) {
                toast.success(`Evaluating decision "${dec.question}"...`);
                const decisionUrl = urlInput || (deskDomain ? `https://${deskDomain}` : '');
                setUrlInput(decisionUrl);
                setAnalysisMode(DECISION_MODE);
                setDecisionText(dec.question);
                await handleUrlSubmit(true, false, { url: decisionUrl, mode: DECISION_MODE, decisionText: dec.question });
                return;
            }
        }

        // If no URL available, open Intake to ask for target
        setShowIntake(true);
        setPhase('idle');
    };

    // The intake form (company URL, LinkedIn, documents, "what are you trying to figure
    // out?") is the only place a run can be given sources or a free-text question. The
    // redesigned desk made it unreachable: `idle` + `showIntake` was the only way in, and
    // nothing on the desk set either. Opened FROM the desk, so it can go back to it.
    const openIntakeFromDesk = () => {
        if (!urlInput && deskDomain) setUrlInput(`https://${deskDomain}`);
        setShowIntake(true);
        setPhase('idle');
    };
    const closeIntakeToDesk = () => {
        setShowIntake(false);
        setPhase('desk');
    };

    const handleOpenOverview = (run) => {
        if (run?.rawReport) {
            loadReport(run.rawReport);
            return;
        }
        if (history.length > 0) {
            loadReport(history[0]);
            return;
        }
        setCurrentCompositeRun(run || workspaceData.compositeRuns[0]);
        setPhase('composite_overview');
    };

    // Archive/restore change the SERVER target. They used to touch localStorage only, so an
    // archived product came back on reload and stayed runnable. Optimistic, rolled back on
    // failure. (listTargets hides archived targets, so after a reload there is nothing to
    // restore from here — same as every other archived target.)
    const setProductStatus = async (productId, status) => {
        const previous = realTargets.find(p => p.id === productId)?.status;
        setRealTargets(prev => prev.map(p => p.id === productId ? { ...p, status } : p));
        const res = await (status === 'archived' ? archiveTarget(productId) : restoreTarget(productId));
        if (!res?.ok) {
            setRealTargets(prev => prev.map(p => p.id === productId ? { ...p, status: previous } : p));
            toast.error(res?.message || 'Could not update that product.');
            return;
        }
        toast.success(status === 'archived' ? 'Product archived.' : 'Product restored.');
    };
    const handleArchiveProduct = (productId) => setProductStatus(productId, 'archived');
    const handleRestoreProduct = (productId) => setProductStatus(productId, 'active');

    // Logic to build sections with COUNTS
    // While a run is in flight there is no persisted report yet, so assemble one from the
    // live slice. It is deliberately the SAME SHAPE the finished report has, which is what
    // lets every downstream memo, section and card below work unchanged — and what makes
    // the swap at completion a reconcile rather than a remount.
    const liveReport = useMemo(() => {
        if (!liveMeta && liveSignals.length === 0) return null;
        return {
            context: contextData,
            signals: liveSignals,
            // The brief is the finale and arrives with the persisted report: `state.summary`
            // is not UI-shaped until buildReportData runs it through normalizeBriefForRun.
            brief: null,
            v6: liveV6,
            degradations: liveMeta?.degradations || [],
            depth_gaps: liveMeta?.depthGaps || [],
            run_tier: liveMeta?.runTier || 'full',
            inputs: { websiteUrl: urlInput }
        };
    }, [liveMeta, liveSignals, liveV6, contextData, urlInput]);

    // A finished report always wins; the live one only stands in until it exists.
    const activeReport = finalReport || liveReport;

    const sections = useMemo(
        () => buildReportSections(activeReport, reportFilter),
        [activeReport, reportFilter]
    );


    // A run takes minutes and founders background the tab. The title is the one channel
    // that reaches them there without asking for notification permission they never
    // requested. Restored on unmount so it never leaks into the rest of the app.
    useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const original = document.title;
        if (phase === 'live') {
            const n = liveMeta?.signalCount ?? liveSignals.length;
            document.title = n > 0 ? `(${n}) Analyzing… | Bahirjee` : 'Analyzing… | Bahirjee';
        } else if (phase === 'complete' && finalReport) {
            document.title = '✓ Brief ready | Bahirjee';
        }
        return () => { document.title = original; };
    }, [phase, liveMeta?.signalCount, liveSignals.length, finalReport]);

    const activeData = sections.find(s => s.id === activeSection);

    // --- 0. AUTH SCREEN ---
    if (authLoading) {
        return (
            <div className="min-h-dvh bg-bah-bg flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-bah-accent animate-spin" />
            </div>
        );
    }

    if (!user) {
        return (
            <AuthScreen
                email={email}
                authError={authError}
                authNotice={authNotice}
                setEmail={setEmail}
                handleLogin={handleLogin}
            />
        );
    }

    // A failed profile fetch leaves `profile` null, which slips past every `profile &&`
    // gate below and drops the founder into an unlocked intake form with no client_id —
    // silently, because nothing used to read profileError.
    if (profileError && !profile) {
        return (
            <ErrorScreen
                statusMsg={profileError}
                setPhase={() => window.location.reload()}
                handleStart={() => window.location.reload()}
            />
        );
    }

    // Name gate: capture display name once for magic-link signups (and backfill
    // legacy null-name accounts) before the founder proceeds. Admins are redirected
    // to /admin above and never reach this.
    if (profile && !isAdmin && !profile.full_name) {
        return (
            <NameGateScreen
                onSubmit={updateFullName}
                signOut={signOut}
            />
        );
    }

    // View-only users never see the intake/analysis flow — just the briefs shared
    // with their organization. `history` is already client-scoped.
    if (profile?.role === 'brief_viewer') {
        return (
            <BriefListScreen
                briefs={history}
                profile={profile}
                signOut={signOut}
            />
        );
    }

    // --- 1. LANDING VIEW ---
    // --- ONBOARDING STEP (shown AFTER context building, pre-filled) ---
    if (phase === 'onboarding') {
        return (
            <OnboardingScreen
                signOut={signOut}
                resetToIdle={() => { setPhase('idle'); setContextData(null); setOnboardingData(null); setStoredContextMeta(null); setContextGate(null); }}
                onComplete={handleOnboardingComplete}
                onboardingData={onboardingData}
            />
        );
    }

    // ── Decision sessions ────────────────────────────────────────────────────
    //
    // Each stage degrades on its own terms and none of them throws into the screen. A
    // founder four questions deep must never be handed an error page: a framing that fails
    // says so and lets them retype; an analysis that fails still shows the lens, why it was
    // chosen, and what was already known.
    const decisionDomain = history[0]?.target_domain
        || extractTargetDomain(history[0]?.inputs?.websiteUrl || '');

    const openDecision = () => setDecision({ step: 'frame' });

    const handleDecisionFrame = async (rawText) => {
        setDecision(d => ({ ...d, busy: true, error: null, statusText: 'Reading what you wrote…' }));
        try {
            const frame = await buildDecisionFrame(rawText, contextData || history[0]?.context || {});
            const session = await startDecision({
                clientId: profile?.client_id, createdBy: user?.id,
                rawInput: rawText, frame, targetDomain: decisionDomain,
            });
            // A failed persist is NOT fatal: the session continues in memory and only the
            // revisit is lost. Losing the analysis to protect the record would be backwards.
            setDecision(d => ({ ...d, frame, sessionId: session?.id || null, busy: false, statusText: '' }));
        } catch (err) {
            setDecision(d => ({ ...d, busy: false, error: 'I could not make sense of that. Try saying it another way.' }));
        }
    };

    const handleDecisionAnswers = async (answers, routing) => {
        setDecision(d => ({ ...d, busy: true, error: null, statusText: 'Looking at what I already know…' }));
        if (decision?.sessionId) {
            await saveRouting(decision.sessionId, { answers, framework: routing.framework.id });
        }
        const ctx = contextData || history[0]?.context || {};
        const { judgment } = await runDecisionSession({
            frame: decision.frame,
            routing,
            context: ctx,
            internal: {
                signals: history[0]?.signals || [],
                cards: history[0]?.card_summary || [],
                agenda: [],
            },
            job: { clientId: profile?.client_id, userId: user?.id, websiteUrl: history[0]?.inputs?.websiteUrl },
            onProgress: (statusText) => setDecision(d => (d ? { ...d, statusText } : d)),
        });
        if (decision?.sessionId) {
            await saveJudgment(decision.sessionId, judgment, {
                clientId: profile?.client_id, targetDomain: decisionDomain, createdBy: user?.id,
            });
        }
        setDecision(d => ({ ...d, judgment, busy: false, statusText: '' }));
    };

    const handleRecordChoice = async (optionId) => {
        setDecision(d => ({ ...d, chosenOptionId: optionId }));
        if (decision?.sessionId) await recordChoice(decision.sessionId, optionId);
    };

    if (decision) {
        return (
            <DecisionSession
                frame={decision.frame}
                judgment={decision.judgment}
                chosenOptionId={decision.chosenOptionId}
                busy={decision.busy}
                statusText={decision.statusText}
                error={decision.error}
                onFrame={handleDecisionFrame}
                onConfirmFrame={(frame) => setDecision(d => ({ ...d, frame }))}
                onSubmitAnswers={handleDecisionAnswers}
                onRecordChoice={handleRecordChoice}
                onBack={() => setDecision(null)}
            />
        );
    }

    // --- 1a. COMPOSITE RUN OVERVIEW (Bahirjee Intelligence) ---
    if (phase === 'composite_overview') {
        const runToShow = currentCompositeRun || workspaceData.compositeRuns[0];
        return (
            <CompositeRunOverview
                run={runToShow}
                onBackToDesk={() => setPhase('desk')}
            />
        );
    }

    // --- 1b. PRIMARY SCREEN: INTELLIGENCE DESK ---
    if (phase === 'desk') {
        return (
            <>
                <IntelligenceDesk
                    workspaceData={workspaceData}
                    onAnchorCompany={handleAnchorCompany}
                    onRunScope={() => setIsRunScopeOpen(true)}
                    onAddProduct={() => setIsAddProductOpen(true)}
                    onAddDecision={() => setIsAddDecisionOpen(true)}
                    onNewAnalysis={openIntakeFromDesk}
                    onCreateMonitoringSetup={() => {
                        setMonitoringScopePreset(null);
                        setIsMonitoringSetupOpen(true);
                    }}
                    onToggleMonitoringActive={handleToggleMonitoringActive}
                    onOpenOverview={handleOpenOverview}
                    onEditSources={(type, target) => {
                        toast.success(`Manage sources for ${target?.name || 'target'}`);
                    }}
                    onRunTarget={(type, target) => {
                        const scope = {
                            company: type === 'company',
                            product_ids: type === 'product' ? [target.id] : [],
                            decision_ids: type === 'decision' ? [target.id] : []
                        };
                        handleRunComposite(scope);
                    }}
                    onArchiveProduct={handleArchiveProduct}
                    onRestoreProduct={handleRestoreProduct}
                    onSignOut={signOut}
                    userEmail={user?.email}
                />

                {/* Modals */}
                <AddProductModal
                    isOpen={isAddProductOpen}
                    onClose={() => setIsAddProductOpen(false)}
                    onSaveProduct={handleSaveProduct}
                    companyName={workspaceData?.company?.name || 'Your Company'}
                />

                <AddDecisionModal
                    isOpen={isAddDecisionOpen}
                    onClose={() => setIsAddDecisionOpen(false)}
                    onSaveDecision={handleSaveDecision}
                    companyName={workspaceData?.company?.name || 'Your Company'}
                    products={workspaceData?.products || []}
                />

                <RunScopeModal
                    isOpen={isRunScopeOpen}
                    onClose={() => setIsRunScopeOpen(false)}
                    company={workspaceData?.company}
                    products={workspaceData?.products || []}
                    decisions={workspaceData?.decisions || []}
                    onRunIntelligence={handleRunComposite}
                    onSaveAsMonitoring={(scope) => {
                        setMonitoringScopePreset(scope);
                        setIsMonitoringSetupOpen(true);
                    }}
                    onAddProduct={() => {
                        setIsRunScopeOpen(false);
                        setIsAddProductOpen(true);
                    }}
                    onAddDecision={() => {
                        setIsRunScopeOpen(false);
                        setIsAddDecisionOpen(true);
                    }}
                />

                <MonitoringSetupModal
                    isOpen={isMonitoringSetupOpen}
                    onClose={() => setIsMonitoringSetupOpen(false)}
                    initialScope={monitoringScopePreset}
                    company={workspaceData?.company}
                    products={workspaceData?.products || []}
                    decisions={workspaceData?.decisions || []}
                    onSaveSetup={handleSaveMonitoringSetup}
                />
            </>
        );
    }

    // --- 1a. THE DESK (home, once there is a company on file) ---
    // Before this, `/` opened on a form asking what to analyse — even for a founder whose
    // colleague's desk is: you arrive and find out what they have been doing since you
    // last looked. The intake is still one click away for a genuinely new company.
    //
    // Gated on having BOTH a client and a prior report, because the Desk has nothing
    // honest to show without them — no watched pages, no agenda, no ledger. A first-time
    if (phase === 'idle' && !showIntake && profile?.client_id && deskDomain && !recentReportPrompt) {
        return (
            <Desk
                clientId={profile.client_id}
                targetDomain={deskDomain}
                lastReadAt={history[0]?.timestamp || null}
                onOpenBrief={handleOpenTargetBrief}
                onAskDecision={openDecision}
                onCheckNow={() => setShowIntake(true)}
                onRunTarget={handleRunTarget}
            />
        );
    }

    if (phase === 'idle' || phase === 'generating_context') {
        const rp = recentReportPrompt;
        const ageLabel = rp
            ? (rp.ageMinutes < 60 ? `${rp.ageMinutes} min ago` : `${Math.round(rp.ageMinutes / 60)}h ago`)
            : '';
        return (
            <>
                <IntakeScreen
                    signOut={signOut}
                    urlInput={urlInput}
                    setUrlInput={setUrlInput}
                    linkedinInput={linkedinInput}
                    setLinkedinInput={setLinkedinInput}
                    uploadedFiles={uploadedFiles}
                    setUploadedFiles={setUploadedFiles}
                    handleUrlSubmit={handleUrlSubmit}
                    analysisMode={analysisMode}
                    setAnalysisMode={setAnalysisMode}
                    decisionText={decisionText}
                    setDecisionText={setDecisionText}
                    phase={phase}
                    statusMsg={statusMsg}
                    profile={profile}
                    recentBriefs={history}
                    loadReport={loadReport}
                    onBackToDesk={showIntake ? closeIntakeToDesk : null}
                />
                {rp && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                        <div className="bg-bah-panel border border-bah rounded-2xl max-w-md w-full p-6 shadow-2xl">
                            <h3 className="text-lg font-semibold text-bah-strong mb-2">You already have a recent brief</h3>
                            <p className="text-sm text-bah-muted mb-5">
                                A report for this company was generated <span className="text-bah-accent">{ageLabel}</span>.
                                Running again starts a fresh scan (and uses a run). View the existing brief instead?
                            </p>
                            <div className="flex flex-col gap-2">
                                <button
                                    onClick={() => { loadReport(mapReportRowToAppReport(rp.report)); setRecentReportPrompt(null); }}
                                    className="bah-button-primary w-full py-2.5 text-sm"
                                >
                                    View latest brief ({ageLabel})
                                </button>
                                <button
                                    onClick={() => { setRecentReportPrompt(null); handleUrlSubmit(true); }}
                                    className="bah-button-secondary w-full py-2.5 text-sm"
                                >
                                    Run a fresh scan anyway
                                </button>
                                <button
                                    onClick={() => setRecentReportPrompt(null)}
                                    className="w-full py-2 text-xs text-bah-muted hover:text-bah transition-colors"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </>
        );
    }

    // --- 1b. CONTEXT GATE (a company we already know) ---
    if (phase === 'context_gate' && contextData && contextGate) {
        return (
            <>
                <ContextGateScreen
                    context={contextData}
                    meta={contextGate.meta}
                    staleness={contextGate.staleness}
                    recentBrief={contextGate.recentBrief && {
                        report: contextGate.recentBrief.report,
                        ageLabel: contextGate.recentBrief.ageMinutes < 60
                            ? `${contextGate.recentBrief.ageMinutes} min ago`
                            : `${Math.round(contextGate.recentBrief.ageMinutes / 60)}h ago`,
                    }}
                    onContinue={handleGateContinue}
                    onAddSources={() => setAddSourcesOpen(true)}
                    onRebuild={() => setRebuildGate(true)}
                    mergeReceipt={mergeReceipt}
                    busy={isMerging}
                    onViewRecentBrief={() => {
                        loadReport(mapReportRowToAppReport(contextGate.recentBrief.report));
                        setContextGate(null);
                    }}
                    onCancel={handleGateCancel}
                />
                <AddSourcesDialog
                    open={addSourcesOpen}
                    onClose={() => setAddSourcesOpen(false)}
                    onSubmit={handleAddSources}
                    busy={isMerging}
                />
                <ConfirmDialog
                    open={rebuildGate}
                    onClose={() => setRebuildGate(false)}
                    onConfirm={confirmRebuild}
                    title="Rebuild this context from scratch?"
                    description="Bahirjee will re-read the website and LinkedIn and infer everything again."
                    bullets={[
                        'Any corrections you made to this context are discarded.',
                        'It takes 20–40 seconds before you can review the result.',
                        'Your saved versions are kept — this adds a new one, it does not erase history.',
                    ]}
                    cancelLabel="Keep the saved context"
                    confirmLabel="Rebuild"
                    variant="danger"
                />
            </>
        );
    }

    // --- 2. ERROR STATE ---
    if (phase === 'error') {
        return (
            <ErrorScreen
                statusMsg={statusMsg}
                setPhase={setPhase}
                contextData={contextData}
                handleConfirmContext={handleConfirmContext}
                handleStart={handleUrlSubmit}
            />
        );
    }

    // --- 3. CONTEXT REVIEW ---
    if (phase === 'review_context' && contextData) {
        // "Is this you?" ships behind a flag with the full editor as its fallback, so it
        // can be turned on for beta clients and turned off again in one deploy. The two
        // screens write `_userEdits` through the same helpers, so switching between them
        // cannot change what a founder's correction means.
        //
        // A decision run is deliberately excluded: its frame editor (the statement, the
        // options, the constraints) has no five-sentence equivalent, and there is nothing
        // to recognise before the founder has stated the decision.
        const useConfirmScreen =
            import.meta.env.VITE_CONTEXT_CONFIRM_V2 === '1' &&
            analysisMode !== 'decision' &&
            !contextData._decision &&
            !showFullContextEditor;

        return (
            <>
                {useConfirmScreen ? (
                    <ContextConfirmScreen
                        contextData={contextData}
                        setContextData={setContextData}
                        handleConfirmContext={handleConfirmContext}
                        isConfirming={isConfirmingContext}
                        storedMeta={storedContextMeta}
                        onShowFullEditor={() => setShowFullContextEditor(true)}
                    />
                ) : (
                <ContextReviewScreen
                    contextData={contextData}
                    setContextData={setContextData}
                    onboardingData={onboardingData}
                    finalReport={finalReport}
                    setPhase={setPhase}
                    handleConfirmContext={handleConfirmContext}
                    isConfirming={isConfirmingContext}
                    analysisMode={analysisMode}
                    storedMeta={storedContextMeta}
                    onEditOnboarding={() => setPhase('onboarding')}
                />
                )}
                <ConfirmDialog
                    open={Boolean(readinessGate)}
                    onClose={() => setReadinessGate(null)}
                    onConfirm={runConfirmContext}
                    title={readinessGate?.blocking ? 'This context has gaps' : 'Before we analyze'}
                    description={
                        readinessGate?.blocking
                            ? 'These gaps will weaken the report. You can go back and fill them in, or run anyway — running spends one analysis.'
                            : 'Worth a look before we start. Running spends one analysis.'
                    }
                    bullets={readinessGate?.bullets || []}
                    cancelLabel="Go back and edit"
                    confirmLabel="Run anyway"
                    variant={readinessGate?.blocking ? 'danger' : 'primary'}
                />
            </>
        );
    }

    // --- 4. DASHBOARD (live and finished) ---
    // There is deliberately no separate "analyzing" screen. A run takes 15-20 minutes, and
    // parking the founder on a progress bar for that long put every piece of value at the
    // very end. `phase === 'live'` renders this same workspace against `liveReport`, so
    // signals land in their sections as they are analyzed and completion is a swap rather
    // than a navigation.
    return (
        <ReportWorkspace
            isLive={phase === 'live'}
            liveStatusMsg={statusMsg}
            liveStartedAt={liveMeta?.startedAt || null}
            liveSignalCount={liveMeta?.signalCount ?? liveSignals.length}
            liveBriefReady={Boolean(liveMeta?.briefReady)}
            liveHunt={liveMeta?.hunt || null}
            historyOpen={historyOpen}
            setHistoryOpen={setHistoryOpen}
            filteredHistory={filteredHistory}
            loadReport={loadReport}
            searchTerm={searchTerm}
            setSearchTerm={setSearchTerm}
            selectedMonth={selectedMonth}
            setSelectedMonth={setSelectedMonth}
            availableMonths={availableMonths}
            sidebarOpen={sidebarOpen}
            setSidebarOpen={setSidebarOpen}
            sections={sections}
            activeSection={activeSection}
            setActiveSection={setActiveSection}
            finalReport={activeReport}
            reportFilter={reportFilter}
            setReportFilter={setReportFilter}
            setPhase={(nextPhase) => {
                if (nextPhase === 'idle' || nextPhase === 'desk') {
                    const revisitDecision = finalReport?.reportKind === DECISION_MODE;
                    setFinalReport(null);
                    setLiveSignals([]);
                    setLiveV6(null);
                    setLiveMeta(null);
                    setContextData(null);
                    setOnboardingData(null);
                    setStoredContextMeta(null);
                    setContextGate(null);
                    setContextOrigin('built');
                    setAnalysisMode(revisitDecision ? DECISION_MODE : COMPANY_MODE);
                    setDecisionText(revisitDecision ? (finalReport?.decisionContext?.raw_input || finalReport?.decisionContext?.decision_statement || '') : '');
                    setPhase('desk');
                    return;
                }
                setPhase(nextPhase);
            }}
            signOut={signOut}
                activeData={activeData}
                handleV6React={handleV6React}
                renderInsightCard={(insight, i) => <InsightCard key={i} insight={insight} index={i} websiteUrl={finalReport?.inputs?.websiteUrl} onReact={handleInsightReact} />}
                renderSignalCard={(signal, idx, onAsk, filter, onUpgrade) => <SignalCard key={idx} signal={signal} onAsk={onAsk} filter={filter} profile={profile} onUpgrade={onUpgrade} />}
            handleQnA={handleQnA}
            handleShareSignal={handleShareSignal}
            isPremium={isPremiumOrExempt(profile)}
            onTrackAssumptions={handleTrackAssumptions}
            runCount={profile?.run_count}
            reportId={finalReport?.id}
            userId={user?.id}
        />
    );
}
