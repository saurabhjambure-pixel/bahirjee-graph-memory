// TEMPORARY integration harness: renders the REAL ReportWorkspace in live mode through the
// REAL section-building and grouping path. Round 1's harness only exercised the new leaf
// components, which is exactly why the blank-section bug reached production.
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import ReportWorkspace from './components/intelligence/ReportWorkspace';
import { SignalCard } from './components/IntelligenceDashboard';
import { buildReportSections } from './services/signalTaxonomy';

// The exact category mix from the production run that failed.
const CATEGORIES = [
  'DemandSignal', 'CompetitorFunding', 'CompetitorHiring', 'RegulatoryChange',
  'CompetitorLaunch', 'FundingOpportunity', 'TalentAvailable', 'TangentialTrend',
  'CompetitorAward', 'CompetitorProduct', 'SupplierShift', 'CustomerShift', 'CapitalClimate'
];

// Two door shapes: a full one (deadline, amount, fit) and a bare one, so both render.
const makeOpportunity = (category) => {
  if (category === 'FundingOpportunity') {
    return {
      counterparty: 'BIRAC',
      trigger: 'BIG scheme call 24 opened to seed-stage medtech',
      deadline: '2026-10-31',
      deadline_quote: 'Applications close 31 October 2026',
      amount: 'up to ₹50 lakh',
      fit: ['Seed stage', 'India-registered'],
      unknowns: ['Whether device companies qualify'],
      status: 'open'
    };
  }
  if (category === 'DemandSignal') {
    return {
      counterparty: 'A regional hospital group',
      trigger: 'Issued an enquiry for remote monitoring',
      deadline: null,
      deadline_quote: null,
      amount: null,
      fit: ['Sells to hospitals'],
      unknowns: ['Budget not stated'],
      status: 'unknown'
    };
  }
  return null;
};

const makeSignal = (i) => ({
  signal_headline: `Signal ${i}: competitor moved in the India market`,
  the_move: `A concrete factual move with numbers and a date, item ${i}.`,
  signal_details: `Details for signal ${i}.`,
  category: CATEGORIES[i % CATEGORIES.length],
  entity_involved: `Entity ${i % 5}`,
  source_url: `https://example${i % 7}.com/article-${i}`,
  confidence: 'Medium',
  evidence_quote: `Verbatim evidence for signal ${i}.`,
  ...(makeOpportunity(CATEGORIES[i % CATEGORIES.length]) ? { opportunity: makeOpportunity(CATEGORIES[i % CATEGORIES.length]) } : {})
});

function Harness() {
  const [count, setCount] = useState(0);
  const [signalsEnabled, setSignalsEnabled] = useState(false);
  const [activeSection, setActiveSection] = useState('intro');
  const [reportFilter, setReportFilter] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('All');
  const [paused, setPaused] = useState(false);

  // Signals arrive in batches, the way analyze appends them.
  useEffect(() => {
    if (paused || !signalsEnabled) return undefined;
    // Signals do not exist for the first stretch of a real run — that gap is the whole
    // reason the hunt panel exists, so the harness must reproduce it.
    const t = setInterval(() => setCount(c => (c >= 42 ? c : c + 3)), 1500);
    const start = setTimeout(() => {}, 0);
    return () => { clearInterval(t); clearTimeout(start); };
  }, [paused, signalsEnabled]);

  // The hunt fills in the way the pipeline does: queries first, then source hosts.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (paused) return undefined;
    const t = setInterval(() => setTick(v => v + 1), 900);
    return () => clearInterval(t);
  }, [paused]);

  const ALL_QUERIES = [
    'HG Insights competitor funding 2026', 'HG Insights hiring trends 2026',
    'B2B data intelligence regulation US 2026', 'ZoomInfo enterprise contract win',
    'technographics market growth 2026', 'Clearbit partnership integration',
    'HG Insights customer reviews', 'intent data buyer demand 2026'
  ];
  const ALL_HOSTS = [
    'techcrunch.com', 'g2.com', 'sec.gov', 'hginsights.com', 'zoominfo.com',
    'forrester.com', 'reddit.com', 'crunchbase.com', 'gartner.com', 'news.ycombinator.com'
  ];
  const hunt = {
    watchlist: [
      { name: 'ZoomInfo', category: 'competitor' }, { name: 'Clearbit', category: 'competitor' },
      { name: 'Bombora', category: 'competitor' }, { name: 'Demandbase', category: 'adjacent' },
      { name: 'FTC', category: 'regulator' }, { name: 'Gartner', category: 'analyst' }
    ],
    queries: ALL_QUERIES,
    queryProgress: { cursor: Math.min(tick, ALL_QUERIES.length), total: ALL_QUERIES.length },
    sourceHosts: ALL_HOSTS.slice(0, Math.min(tick, ALL_HOSTS.length)),
    sourceHostTotal: Math.min(tick, ALL_HOSTS.length),
    watch: tick > 6 ? { checked: 14, changed: 3 } : null,
    collect: null
  };

  const signals = Array.from({ length: count }, (_, i) => makeSignal(i));
  const liveReport = {
    context: {
      company_name: 'HG Insights',
      industry: 'B2B Data Intelligence',
      operating_geography: 'US',
      _decision: { raw_input: 'Should we deepen enterprise or open mid-market in EMEA?' }
    },
    signals,
    brief: null,
    v6: null,
    degradations: [],
    depth_gaps: [],
    run_tier: 'full',
    inputs: { websiteUrl: 'https://hginsights.com' }
  };
  const sections = buildReportSections(liveReport, reportFilter);

  return (
    <>
      <div style={{ position: 'fixed', zIndex: 9999, bottom: 8, left: 8, display: 'flex', gap: 8 }}>
        <button className="bah-button-secondary text-xs px-3 py-1.5" onClick={() => setPaused(p => !p)}>
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button className="bah-button-ghost text-xs px-3 py-1.5" onClick={() => setCount(0)}>Reset</button>
        <button className="bah-button-ghost text-xs px-3 py-1.5" onClick={() => { setCount(0); setSignalsEnabled(false); }}>Hunt only</button>
        <button className="bah-button-secondary text-xs px-3 py-1.5" onClick={() => setSignalsEnabled(true)}>Start signals</button>
        <span className="bah-tag text-xs" id="harness-count">signals: {count}</span>
      </div>
      <ReportWorkspace
        isLive
        liveStatusMsg="Analyzing intelligence (batch 6/11)..."
        liveStartedAt={new Date(Date.now() - 198000).toISOString()}
        liveSignalCount={count}
        liveBriefReady={false}
        liveHunt={hunt}
        historyOpen={historyOpen}
        setHistoryOpen={setHistoryOpen}
        filteredHistory={[]}
        loadReport={() => {}}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        selectedMonth={selectedMonth}
        setSelectedMonth={setSelectedMonth}
        availableMonths={['All']}
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        sections={sections}
        activeSection={activeSection}
        setActiveSection={setActiveSection}
        finalReport={liveReport}
        reportFilter={reportFilter}
        setReportFilter={setReportFilter}
        setPhase={() => {}}
        signOut={() => {}}
        activeData={sections.find(s => s.id === activeSection)}
        handleV6React={() => {}}
        renderInsightCard={(insight, i) => <div key={i}>{insight.text}</div>}
        renderSignalCard={(signal, idx, onAsk, filter, onUpgrade) => (
          <SignalCard key={idx} signal={signal} onAsk={onAsk} filter={filter} profile={{ is_premium: true }} onUpgrade={onUpgrade} />
        )}
        handleQnA={async () => 'answer'}
        handleShareSignal={() => {}}
        isPremium
        runCount={0}
        reportId={null}
        userId={null}
      />
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Harness />);
