import { postJson as browserPostJson } from './apiClient.js';

function readRuntimeEnv(name, fallback = '') {
    const viteEnv = typeof import.meta !== 'undefined' ? import.meta.env || {} : {};
    if (viteEnv[name]) return viteEnv[name];
    if (typeof process !== 'undefined' && process?.env?.[name]) return process.env[name];
    return fallback;
}

const API_BASE = readRuntimeEnv('VITE_API_BASE_URL', '/api');

// v6.0: Observation Layer
import { storeObservations, generateRunId, getObservationsForRun } from './observationService.js';
// Static, not a lazy `await import()`: the stepped worker saves inside a serverless
// invocation, where a dynamic import mid-step just delays the handler's resolution.
import { saveReport, extractTargetDomain } from './reportService.js';
import { harvestQuestions, openQuestion } from './agendaService.js';
import { getCurrentCompanyContext, hydrateStoredContext, saveCompanyContextFromServer, stampBuildProvenance, listStaleFacts } from './companyContextService.js';
// v6.0: Pattern, Shift, Blind Spot, Opportunity Engines
import { clusterObservations, getPatternBaseline } from './patternEngine.js';
import { detectShifts } from './shiftEngine.js';
import {
    jevMode, createJevClient, compactContext, materialityRequest, deepReadRequest, findingRequest, pageChangeRequest,
    adviceRequest, falsifierRequest,
    scoreFraction, rankFraction, pYes, confidenceBand, recordJevUse,
} from './jevService.js';
import { detectBlindSpots } from './blindSpotEngine.js';
import { detectOpportunities } from './opportunityEngine.js';
// v7.0: Context Building & Signals Prep Layer
import { buildStartupContext } from './contextBuilder.js';
import { generateEntityWatchlist, normalizeTrackedEntities, storeEntityWatchlist, generateEntityRelationships, storeEntityRelationships, getTrackedEntities, deactivateTrackedEntities } from './entityWatchlistGenerator.js';
import { discoverCompetitors, mergeEvidenceEntities, refreshSeenEvidence, staleEvidenceRows, EVIDENCE_MAX_AGE_DAYS } from './competitorDiscovery.js';
import { ingestSignals, ingestObservation } from './ragService.js';
import { mapPrimarySources, storeEntitySources, getEntitySources } from './primarySourceMapper.js';
import { watchSources, MAX_WATCH_FETCHES_PER_RUN } from './sourceWatch.js';
import { planConnectorCalls, MAX_OBSERVATIONS_PER_CONNECTOR } from './connectorRegistry.js';
import { computeSignalWeights, getTopCategories } from './signalWeightEngine.js';
import { generateContextAwareQueries, flattenQueriesForTavily, buildExpressQueries } from './queryGenerator.js';
import { domainsForTier, exaCategoryForTier, TIER_BUCKETS, tierForBucket, sourceClassForTier, profileFromContext } from './sourceTiers.js';
import { verifyReport, retryTargetsFor } from './reportVerifier.js';
import { sectionForCategory, SECTIONS } from './signalTaxonomy.js';
import { groundOpportunityFields } from './opportunityFields.js';
import { transformToStructuredSignals, storeStructuredSignals, checkPreviousReplication, getLiveSignals } from './structuredSignalTransformer.js';
import { scoreAndFilterNews, rankNews, compactNewsItem, storeNewsItems, MAX_NEWS_CANDIDATES } from './newsScorer.js';
import { PIPELINE_STEP_LABELS } from './pipelineSteps.js';
import { resolveRunTier, DEFAULT_RUN_TIER, depthGapsFor } from './runTiers.js';
import { normalizeBrief } from './briefSchema.js';
import { attestBrief, resolveBriefPolicyMode } from './agents/policies/briefPolicy.js';
import { transformSignalsToV6 } from './signalToShiftTransformer.js';
import {
    buildTemporalPolicy,
    buildDateWindowParams,
    classifyEvidenceDate,
    isCurrentAnchor,
    normalizeIsoDate,
} from './temporalPolicy.js';
import { buildEvidencePackets, projectEvidenceForSurface } from './evidencePackets.js';
import { loadCompanyMemory, buildReportMemory, persistReportMemory } from './companyMemoryService.js';
import { PROMPT_VERSION, currentVersions } from './pipelineVersions.js';
// Two different verifiers now live in this file and both export `verifyReport`:
// reportVerifier.js scores COVERAGE (stepVerify, gaps + retry targets), while
// agents/policies/verifierPolicy.js is the pre-persist GATE that drops ungrounded and
// duplicate signals. Aliased rather than renamed so neither module's own API moves.
import { verifyReport as runVerifierGate, resolveVerifierMode } from './agents/policies/verifierPolicy.js';
import { buildFallbackDecisionFrame, buildDecisionBriefFallback, normalizeDecisionFrame, validateDecisionFrame, buildDecisionQueries, DECISION_MODE } from './decisionService.js';
import { PRODUCT_MODE, buildProductQueries, normalizeProductProfile, runSubject, subjectDeepReadCandidates, withProductRivals } from './productService.js';

const LOOKBACK_MONTHS_FIRST_RUN = 12; // First run for a company: look back 1 year
const LOOKBACK_MONTHS_SUBSEQUENT = 6;  // Subsequent runs: look back 6 months
// Mirrors MAX_QUERIES in queryGenerator.js — raised 14 → 22 with the source-tier
// expansion (3 tiers → 7). See the note there for how the extra budget is spent.
const MAX_QUERY_COUNT = 22;
// Full-text reads per run. Raised from 3: reports, papers and essays are exactly the
// sources whose value is invisible in a 500-char snippet, so steering retrieval at them
// (source tiers) only pays if more of them actually get read. Reads run concurrently, so
// this costs wall-clock roughly the slowest scrape rather than N × scrape. Each extra read
// adds an observation, which may add an analyze batch — the real cost is LLM calls, not
// the $0.001 extract.
// 8, not 5: the reviews tier is the first source family that is *worthless* unread —
// a G2 snippet is a star rating with no reason attached — so the tier expansion only
// pays if the read budget grows with it.
const MAX_DEEP_READS_PER_RUN = 8;
// How many results per query are eligible for a deep read. Was effectively 1 (only the
// top hit), which meant a better source at position 2 could never be read no matter how
// good it was — position, not quality, decided.
const DEEP_READ_CANDIDATES_PER_QUERY = 3;
// Max reads drawn from any one query, so the budget spreads across sources.
const DEEP_READ_PER_QUERY_CAP = 2;
// Extra Exa results requested per tier query (see searchQuery).
const TIER_EXA_RESULTS = 4;
const SEARCH_RESULTS_PER_QUERY = 6;
// Which themes are genuinely news-shaped. Funding rounds and regulatory changes are
// dated events reported by press, so `topic: 'news'` buys us recency + published_date.
// Competitor product moves live on changelogs, docs and pricing pages — the news index
// would filter exactly the sources we want, so those stay on 'general'.
const NEWS_TOPIC_THEMES = new Set(['funding_intel', 'regulatory_lens']);

const topicForTheme = (theme) => (NEWS_TOPIC_THEMES.has(theme) ? 'news' : 'general');

/**
 * Express a NAMED window in the form Tavily actually honours for the given topic.
 *
 * `days` works on 'news' and is silently dropped on 'general' — which is where most themes
 * run, so those searches were previously unbounded in time despite passing a lookback.
 * start_date/end_date ARE honoured on 'general', so express the window that way.
 *
 * The window is now a NAME ('current' | 'context' | 'profile') resolved against the run's
 * temporal policy, not a day count computed at the call site. Before, every caller
 * recomputed `months * 30 * 86400000` independently, so a long run could search two steps
 * against two different boundaries.
 *
 * Two things this deliberately does not try to fix:
 *   - `published_date` is only populated on the news index, so 'general' results stay
 *     undated however the window is expressed. No request parameter changes that.
 *   - A window on 'general' also filters OUT undated pages. That is correct for recon
 *     queries but wrong for context assembly, which wants the company's own homepage —
 *     those callers pass the 'profile' window, which is deliberately unbounded.
 */
const dateWindowParams = (topic, retrievalWindow, policy) =>
    buildDateWindowParams(retrievalWindow, policy, topic);
const MAX_SIGNAL_PAYLOAD_CHARS = 80000; // Hard cap on total chars sent for signal analysis
const BATCH_SIZE = 15; // Max observations per signal analysis batch (was 40; reduced for token budget)
const MIN_TAVILY_SCORE = 0.15; // Lowered to maximize signal yield
// Below this many results past the relevance bar, analyze the best available instead of
// nothing. See the fallback in planAnalyzeBatches for why this is a count, not a threshold.
const MIN_ANALYZE_YIELD = 15;
// Cap signals passed to generateSummary. Raised with the query budget so a wider
// evidence base is not silently truncated back to the old run's worth of signals.
const MAX_SUMMARY_SIGNALS = 55;
// Hard ceiling on observations reaching signal analysis. The run's cost scales with this
// number, not with the number of searches — every observation may add an analyze batch.
// 200 ≈ 14 batches, which is what holds the expanded evidence base near ~$0.40/run.
// Enforced by capObservations(), which thins every source class rather than truncating.
const MAX_OBSERVATIONS_TOTAL = 200;
const intelligenceRuntime = {
    postJson: browserPostJson,
    // Research depth for this invocation. Set by the worker from intelligence_jobs.run_tier;
    // `full` for every caller that never sets it.
    budget: resolveRunTier(DEFAULT_RUN_TIER),
    // Whether Jev is reachable. /api/jev admits only the pipeline's internal key, so it is
    // only ever reachable where the SERVER runs the pipeline; the worker turns this on.
    // Anywhere else every call would be a refused round trip, so the use cases stay off.
    jev: false,
};
const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
// At most this many new pages are read in one "add sources" round. The cap is the cost
// ceiling on a path the founder can invoke repeatedly before any job exists.
const MAX_ADDED_SOURCE_URLS = 5;
// The merge prompt is handed only the NEW material plus a small digest, so it needs a
// fraction of buildContext's window — and a tight budget is what keeps a merge a merge.
const MERGE_INPUT_CHAR_LIMIT = 60000;

// How much of the fused source text reaches the buildContext prompt.
//
// This was 50000, which discarded most of what we had already paid to scrape — a real run
// logged `49789/229837 chars`, i.e. 78% thrown away. Context gates everything downstream
// (competitors → queries → signals → brief), so starving it degrades the whole report.
// buildContext runs on gemini-3.8-flash (1M-token window); 150k chars is roughly 37k tokens,
// well under 5% of that window, and Flash input tokens are cheap. Keep
// PROMPT_CONTEXT_CHAR_LIMIT (promptUtils.js) at or above this value, or the prompt
// re-truncates whatever the packer just carefully allocated.
const CONTEXT_INPUT_CHAR_LIMIT = parsePositiveInt(readRuntimeEnv('VITE_CONTEXT_INPUT_CHAR_LIMIT'), 150000);

// Guaranteed share of the context window for each non-website source. The website scrape
// takes the remainder, so a verbose site can no longer crowd out the founder's own
// document — see the fusion block in buildInitialContext().
// Scaled with the limit above: at the old 6000, a 21690-char LinkedIn profile was cut to 28%.
const DOC_RESERVED_CHARS = parsePositiveInt(readRuntimeEnv('VITE_DOC_RESERVED_CHARS'), 40000);
const LINKEDIN_RESERVED_CHARS = parsePositiveInt(readRuntimeEnv('VITE_LINKEDIN_RESERVED_CHARS'), 20000);
// The company's own site. Reserved generously: it is the only first-party source in the
// context build, and everything else is someone else's account of the same company.
const OWN_SITE_RESERVED_CHARS = parsePositiveInt(readRuntimeEnv('VITE_OWN_SITE_RESERVED_CHARS'), 40000);

/**
 * Trim to `limit` chars on a paragraph or sentence boundary, so a source never ends
 * mid-word. Returns the input untouched when it already fits.
 */
function truncateOnBoundary(text, limit) {
    const value = String(text || '');
    if (value.length <= limit) return value;

    const cut = value.slice(0, limit);
    const paragraph = cut.lastIndexOf('\n\n');
    if (paragraph > limit * 0.6) return cut.slice(0, paragraph);
    const sentence = cut.lastIndexOf('. ');
    if (sentence > limit * 0.6) return cut.slice(0, sentence + 1);
    const newline = cut.lastIndexOf('\n');
    return newline > limit * 0.6 ? cut.slice(0, newline) : cut;
}

/**
 * Pack labelled sources into a single context string under `limit` chars.
 *
 * Each source declares a budget; sources that need less than they reserved hand the
 * surplus to the unbounded ones (the website scrape). Order is preserved, so callers
 * control precedence by ordering the array.
 *
 * @param {Array<{ label: string, text: string, budget: number }>} sources
 * @returns {{ text: string, totalChars: number }}
 */
export function packSources(sources, limit) {
    const totalChars = sources.reduce((sum, s) => sum + String(s.text || '').length, 0);

    const bounded = sources.filter(s => Number.isFinite(s.budget));
    const unbounded = sources.filter(s => !Number.isFinite(s.budget));

    // Reserved sources take only what they actually use, capped at their budget.
    const allocations = new Map();
    let consumed = 0;
    for (const source of bounded) {
        const take = Math.min(String(source.text || '').length, source.budget);
        allocations.set(source, take);
        consumed += take;
    }

    // Whatever is left is split evenly between the unbounded sources.
    const remaining = Math.max(0, limit - consumed);
    const perUnbounded = unbounded.length > 0 ? Math.floor(remaining / unbounded.length) : 0;
    for (const source of unbounded) allocations.set(source, perUnbounded);

    // Give genuinely unused headroom back to the bounded sources that wanted more.
    //
    // A reservation is a FLOOR — a guarantee that this source cannot be evicted by a long
    // one. It was also acting as a ceiling, so a source was truncated even when the global
    // limit was nowhere near binding: a measured run discarded 36k chars of LinkedIn while
    // 64k of the 150k budget went unused. Nothing was traded for that; it was simply lost.
    // Measured against what the unbounded sources actually USE, not what they were
    // allocated. An unbounded source is handed the entire remainder and then typically
    // uses a fraction of it, so subtracting the allocation would report zero headroom in
    // exactly the case this reclaim exists for: a limit that is not binding at all.
    const unboundedUsed = unbounded.reduce(
        (sum, s) => sum + Math.min(perUnbounded, String(s.text || '').length), 0
    );
    let headroom = Math.max(0, limit - consumed - unboundedUsed);
    if (headroom > 0) {
        for (const source of bounded) {
            if (headroom <= 0) break;
            const wanted = String(source.text || '').length;
            const shortfall = wanted - allocations.get(source);
            if (shortfall <= 0) continue;
            const extra = Math.min(shortfall, headroom);
            allocations.set(source, allocations.get(source) + extra);
            headroom -= extra;
        }
    }

    const parts = sources.map(source =>
        `${source.label}\n${truncateOnBoundary(source.text, allocations.get(source))}`
    );

    return { text: parts.join('\n\n'), totalChars };
}
// Full-pipeline time budget (ms). Default is Hobby-safe: the worker runs in a single
// serverless invocation capped at 60s on Vercel Hobby, so the pipeline must self-limit
// with headroom for the Vercel hard-kill (and any server-side context build that ran first).
// On Vercel Pro (worker maxDuration 300 in vercel.json) set PIPELINE_MAX_MS=270000.
const PIPELINE_MAX_MS = parsePositiveInt(readRuntimeEnv('PIPELINE_MAX_MS'), 45000);

export function configureIntelligenceRuntime(overrides = {}) {
    if (typeof overrides.postJson === 'function') {
        intelligenceRuntime.postJson = overrides.postJson;
    }
    // Each key is set independently so a later call that only re-points `postJson` — which
    // the stepped driver does once per step, to attach that step's agent grant — cannot
    // silently wipe the budget configured for the invocation.
    if (overrides.budget) {
        intelligenceRuntime.budget = resolveRunTier(overrides.budget.name || overrides.budget);
    }
    if (typeof overrides.jev === 'boolean') {
        intelligenceRuntime.jev = overrides.jev;
    }
}

export function resetIntelligenceRuntime() {
    intelligenceRuntime.postJson = browserPostJson;
    intelligenceRuntime.budget = resolveRunTier(DEFAULT_RUN_TIER);
    intelligenceRuntime.jev = false;
}

/**
 * The mode a Jev use case runs in for this invocation: `off` wherever Jev is unreachable,
 * otherwise JEV_<USE_CASE> / JEV_MODE (default `shadow`). See src/services/jevService.js.
 */
function jevModeFor(useCase) {
    return intelligenceRuntime.jev ? jevMode(useCase, (name) => readRuntimeEnv(name)) : 'off';
}

/**
 * A Jev client over the runtime's transport, so every call passes the step's tool guard and
 * lands in the spend ledger. One per call site: a client that learns "no key" stops calling
 * for its own lifetime, and a step's lifetime is the right scope for that.
 */
function jevClient() {
    return createJevClient({
        post: (url, body) => intelligenceRuntime.postJson(url, body),
        endpoint: `${API_BASE}/jev`,
        readEnv: (name) => readRuntimeEnv(name),
        onCall: ({ ok, tokens, model }) => recordSpend({ tool: 'jev', provider: 'jev', model, tokens, ok }),
    });
}

/**
 * The active research budget. Defaults to `full`, which is what the browser path and
 * every un-tiered caller (cron, admin, the monolith) get.
 */
function budget() {
    return intelligenceRuntime.budget || resolveRunTier(DEFAULT_RUN_TIER);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CROSS-INVOCATION STATE
// The stepped worker runs each pipeline step in a separate serverless invocation, so
// module-level state does not survive between steps. These accessors let the worker
// hydrate that state from `intelligence_jobs.step_outputs` before a step and dehydrate
// it afterwards. In the browser (and in the single-invocation monolith path) nothing
// calls them and the module globals behave exactly as before.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function getRunProvenance() {
    return [...(_runProvenance || [])];
}

export function setRunProvenance(records) {
    _runProvenance = Array.isArray(records) ? [...records] : [];
}

export function getCircuitState() {
    return {
        consecutive429s: circuitBreaker.consecutive429s,
        lastFailTime: circuitBreaker.lastFailTime
    };
}

export function setCircuitState(state) {
    if (!state) return;
    circuitBreaker.consecutive429s = Number(state.consecutive429s) || 0;
    circuitBreaker.lastFailTime = Number(state.lastFailTime) || 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPER: Normalize Gemini signal response (handles array, object, wrapped)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function normalizeSignalResponse(result) {
    if (!result) return [];
    if (Array.isArray(result)) return result;
    if (typeof result === 'object') {
        const possibleArrayKeys = ['signals', 'results', 'items', 'data'];
        for (const key of possibleArrayKeys) {
            if (Array.isArray(result[key])) return result[key];
        }
        if (Object.keys(result).length > 0) return [result];
    }
    return [];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPER: Deduplicate signals by headline similarity
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tokenize a headline into a set of meaningful words (drops punctuation + short stopword-ish tokens).
function signalTokenSet(text) {
    return new Set(
        String(text || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2)
    );
}

function jaccardSimilarity(a, b) {
    if (!a.size || !b.size) return 0;
    let intersection = 0;
    for (const t of a) if (b.has(t)) intersection++;
    return intersection / (a.size + b.size - intersection);
}

// Tokens that carry hard facts (₹290, 80%, 2026, "341") — used by the cross-category pass:
// two differently-worded signals about the same entity that share a concrete figure and a
// close date are almost certainly the same event reframed for another category.
function numericTokens(text) {
    return new Set(
        String(text || '').toLowerCase().match(/\d[\d,.]*%?|\bfy\d{2}\b/g) || []
    );
}

// Strict YYYY-MM-DD only. Date.parse is lenient enough to turn "early 2026" into
// 2025-12-31 and "sometime in 2024" into 2023-12-31 — guessed dates we must not act on
// (the internal design log: never trust a model-supplied date; missing beats wrong).
// The prompt contract already demands YYYY-MM-DD, so anything else is treated as absent.
function parseSignalDate(s) {
    const raw = typeof s === 'string' ? s : s?.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw || '').trim())) return null;
    const t = Date.parse(`${String(raw).trim()}T00:00:00Z`);
    return Number.isFinite(t) ? t : null;
}

const CORROBORATION_URL_CAP = 3;

// Fold a duplicate's source into the surviving signal instead of discarding it. Every URL
// here already passed filterGroundedSignals, so corroboration stays mechanical — we never
// ask the model for extra URLs (the internal design log: credibility is verification, not
// prompting). If the duplicate is the higher-relevance framing, its text wins the card.
function mergeDuplicateInto(keptArr, idx, dup) {
    const survivor = keptArr[idx];
    const urls = new Set(
        [survivor.source_url, ...(survivor.corroborating_urls || []), dup.source_url, ...(dup.corroborating_urls || [])]
            .filter(Boolean)
    );
    const winner = (dup.relevance_score || 0) > (survivor.relevance_score || 0) ? dup : survivor;
    urls.delete(winner.source_url);
    const loser = winner === dup ? survivor : dup;
    const merged = {
        ...winner,
        corroborating_urls: [...urls].slice(0, CORROBORATION_URL_CAP)
    };
    // The higher-relevance framing wins the card, but it must not cost the founder the door:
    // if the winner has no grounded deadline and the duplicate (same kind of signal) does,
    // the duplicate's opportunity block is the better record of the same event.
    if (!winner.opportunity?.deadline && loser.opportunity?.deadline
        && String(winner.category || '').trim() === String(loser.category || '').trim()) {
        merged.opportunity = loser.opportunity;
    }
    keptArr[idx] = merged;
}

// Paraphrase-aware dedup: two signals are duplicates when they describe the same event even if
// worded differently. Same entity + moderate headline overlap, OR very high overlap regardless of
// entity, collapses them — plus a cross-category backstop: same entity, event dates within 3
// days, and a shared concrete figure (or moderate overlap) catches the same event reframed
// under a different category, which pure text similarity misses.
// Duplicates are MERGED, not discarded: the survivor keeps the higher-relevance framing and
// accumulates the other sources' URLs as corroborating_urls (displayed as "via X, Y +1").
export function deduplicateSignals(signals) {
    const kept = [];
    const keptMeta = []; // { entity, tokens, numbers, date }
    let merged = 0;
    for (const s of signals) {
        const entity = (s.entity_involved || '').toLowerCase().trim();
        const tokens = signalTokenSet(s.signal_headline || s.the_move || '');
        const numbers = numericTokens(`${s.signal_headline || ''} ${s.the_move || ''}`);
        const date = parseSignalDate(s);

        let dupIdx = -1;
        for (let i = 0; i < keptMeta.length; i++) {
            const m = keptMeta[i];
            const sameEntity = entity && m.entity && entity === m.entity;
            // Containment covers "spice money" vs "spice money, bcg" for the cross-category rule.
            const entityOverlap = entity.length > 3 && m.entity.length > 3 &&
                (entity.includes(m.entity) || m.entity.includes(entity));
            const sim = jaccardSimilarity(tokens, m.tokens);
            const datesClose = date !== null && m.date !== null && Math.abs(date - m.date) <= 3 * 86400000;
            const sharedNumber = [...numbers].some(n => m.numbers.has(n));

            if ((sameEntity && sim >= 0.5) || sim >= 0.8 ||
                (entityOverlap && datesClose && (sharedNumber || sim >= 0.35))) {
                dupIdx = i;
                break;
            }
        }

        if (dupIdx >= 0) {
            mergeDuplicateInto(kept, dupIdx, s);
            // Refresh the survivor's meta so later duplicates match the winning framing.
            const w = kept[dupIdx];
            keptMeta[dupIdx] = {
                entity: (w.entity_involved || '').toLowerCase().trim(),
                tokens: signalTokenSet(w.signal_headline || w.the_move || ''),
                numbers: numericTokens(`${w.signal_headline || ''} ${w.the_move || ''}`),
                date: parseSignalDate(w)
            };
            merged++;
        } else {
            kept.push(s);
            keptMeta.push({ entity, tokens, numbers, date });
        }
    }
    if (merged > 0) {
        const corroborated = kept.filter(k => k.corroborating_urls?.length).length;
        console.log(`[dedup] Merged ${merged} duplicate signal(s) → ${kept.length} unique (${corroborated} now multi-source)`);
    }
    return kept;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPER: Anti-echo backstop for the brief — an "insight" that restates a signal
// headline adds nothing (the founder already has the card). The prompt forbids it;
// this enforces it mechanically. Dropped silently per the internal design log
// (:59 — no caveats), and the observation itself is never touched.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const INSIGHT_ECHO_THRESHOLD = 0.6;

function filterEchoInsights(summary, signals) {
    if (!summary || !Array.isArray(summary.insights) || !Array.isArray(signals) || signals.length === 0) {
        return summary;
    }
    const signalTokens = signals
        .map(s => signalTokenSet(`${s.signal_headline || ''} ${s.the_move || ''}`))
        .filter(t => t.size > 0);

    const kept = summary.insights.filter(insight => {
        const t = signalTokenSet(insight?.text || '');
        if (!t.size) return false;
        return !signalTokens.some(st => jaccardSimilarity(t, st) >= INSIGHT_ECHO_THRESHOLD);
    });

    if (kept.length < summary.insights.length) {
        console.log(`[brief] Dropped ${summary.insights.length - kept.length} insight(s) that echoed signal headlines`);
    }
    // Never return an empty overview — if everything echoed, keep the original set
    // rather than presenting a brief with no insights at all.
    return kept.length > 0 ? { ...summary, insights: kept } : summary;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPER: Grounding guard — drop signals citing a source_url the model was
// never shown in this batch (anti-hallucination), and flag signals whose date
// is missing/unparseable so downstream never trusts a guessed "today".
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/** Canonical form for comparing two URLs: scheme/host-case/trailing-slash/fragment insensitive. */
export function normalizeUrlForMatch(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    try {
        const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        const path = u.pathname.replace(/\/+$/, '').toLowerCase();
        // Query is kept — it often IS the article identity (?id=123) — but the fragment
        // never is, and neither is the scheme.
        return `${host}${path}${u.search.toLowerCase()}`;
    } catch {
        return null;
    }
}

/** Registrable-ish host for a URL, or null. */
export function hostOf(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    try {
        return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return null;
    }
}

/**
 * Drop signals citing sources the model was never shown, and refuse to present an
 * unverified URL as a citation.
 *
 * ── The hole this closes ─────────────────────────────────────────────────────
 *
 * The previous implementation matched the cited URL against the batch text, and when that
 * failed fell back to asking whether the DOMAIN appeared anywhere in the text. Any path on a
 * legitimate domain therefore passed. A live run produced a citation to
 * `…/certification-guidelines-in-indien` where the evidence held
 * `…/certification-guidelines-in-india` — the model mutated the slug, the domain still
 * matched, and the founder got a 404 on an otherwise credible finding. A fabricated citation
 * is worse than a missing one: it looks verifiable.
 *
 * The fallback exists for a real reason — a deep read can store a canonical URL that differs
 * from what the model saw — so it is not simply removed. Instead:
 *
 *   exact match       → keep as cited (`source_confidence: 'exact'`)
 *   domain-only match → the path was never shown, so DO NOT cite it. Point the link at a
 *                       real URL from that domain when there is exactly one (unambiguous),
 *                       otherwise at the domain root. Mark `source_confidence: 'domain_only'`
 *                       and keep the model's original string in `cited_url` for audit.
 *   no domain match   → dropped, as before
 *
 * Domain-only signals are deliberately NOT dropped here. Their true rate in production is
 * unknown — they were counted as fully grounded until now — and dropping an unmeasured
 * fraction of every report is exactly the kind of unmeasured flip the verifier-default work
 * avoided. `source_confidence` makes the rate observable first; the decision to drop them
 * belongs to that data, not to a guess.
 *
 * @param {Array}  signals
 * @param {string} batchText  what the model was shown (fallback when observations are absent)
 * @param {Array}  batchObs   the observations behind that text — authoritative when present
 */
export function filterGroundedSignals(signals, batchText, batchObs = null) {
    if (!Array.isArray(signals) || signals.length === 0) return [];

    // Prefer the real observation URLs over parsing the rendered text: string containment
    // over prose is what made the old check permissive in the first place.
    const realUrls = Array.isArray(batchObs) && batchObs.length
        ? batchObs.map(o => o?.url).filter(Boolean)
        : [...String(batchText || '').matchAll(/https?:\/\/[^\s)\]]+/gi)].map(m => m[0]);

    const exact = new Set();
    const byHost = new Map();
    for (const u of realUrls) {
        const n = normalizeUrlForMatch(u);
        const h = hostOf(u);
        if (n) exact.add(n);
        if (h) {
            if (!byHost.has(h)) byHost.set(h, new Set());
            byHost.get(h).add(u);
        }
    }

    const kept = [];
    let dropped = 0;
    let domainOnly = 0;

    for (const s of signals) {
        const cited = String(s?.source_url || '').trim();
        const norm = normalizeUrlForMatch(cited);
        const host = hostOf(cited);

        let confidence = null;
        let resolvedUrl = cited;

        if (norm && exact.has(norm)) {
            confidence = 'exact';
        } else if (host && byHost.has(host)) {
            confidence = 'domain_only';
            domainOnly++;
            const candidates = [...byHost.get(host)];
            // One source from that domain in this batch → that is unambiguously what the
            // model was looking at. More than one → we cannot tell which, so send the
            // founder to the domain rather than guess an article.
            resolvedUrl = candidates.length === 1 ? candidates[0] : `https://${host}`;
        }

        if (!confidence) {
            dropped++;
            continue;
        }

        const d = String(s?.date || '').trim();
        const validDate = /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));

        const next = { ...s, source_url: resolvedUrl, source_confidence: confidence };
        if (confidence === 'domain_only' && cited !== resolvedUrl) next.cited_url = cited;
        if (!validDate) next.date_confidence = 'low';
        kept.push(next);
    }

    if (dropped > 0) {
        console.warn(`[grounding] Dropped ${dropped}/${signals.length} signal(s) citing URLs not present in the analyzed batch`);
    }
    if (domainOnly > 0) {
        console.warn(`[grounding] ${domainOnly}/${signals.length} signal(s) cited an unseen path on a known domain — `
            + 'link repointed, marked source_confidence=domain_only');
    }
    return kept;
}

/**
 * Drop signals with no READ — no "so what for you".
 *
 * A signal without an interpretation is a headline, and the product's whole claim is that
 * it gives the founder the read rather than the news. These also rendered as an empty
 * "Where It Touches You" panel: a styled box with a heading and nothing inside.
 */
export function filterReadableSignals(signals) {
    if (!Array.isArray(signals) || signals.length === 0) return [];
    const kept = signals.filter(s => {
        const read = s?.so_what_for_you || s?.strategic_implication || s?.intelligence_assessment;
        return String(read || '').trim().length >= 15;
    });
    const dropped = signals.length - kept.length;
    if (dropped > 0) {
        console.warn(`[read-guard] Dropped ${dropped}/${signals.length} signal(s) with no "so what" — a signal without a read is a headline`);
    }
    return kept;
}

/**
 * Drop signals whose only subject is the founder's own company.
 *
 * "CareMother deployed 114 monitors" is not intelligence — the founder did it. These were
 * scoring 10/10 because the scoring guide rewards signals that "directly affect customers",
 * and a company's own press release does. A signal that names the company *alongside*
 * another entity (a competitor's comparison, a partner's announcement) is kept: there the
 * outside actor is the news.
 */
export function filterSelfSignals(signals, companyName) {
    if (!Array.isArray(signals) || signals.length === 0) return [];
    const selfToken = normalizeBrandToken(companyName);
    if (!selfToken || selfToken.length < 3) return signals;

    const kept = signals.filter(s => {
        const entities = String(s?.entity_involved || '')
            .split(/[,;/]| and /i)
            .map(e => normalizeBrandToken(e))
            .filter(Boolean);
        if (entities.length === 0) return true;
        // Self-only when every named entity resolves to the company itself.
        return !entities.every(e => e === selfToken || e.includes(selfToken) || selfToken.includes(e));
    });
    const dropped = signals.length - kept.length;
    if (dropped > 0) {
        console.warn(`[self-guard] Dropped ${dropped}/${signals.length} signal(s) reporting the founder's own company back to them`);
    }
    return kept;
}

/**
 * Stamp each signal with the KIND of evidence it came from.
 *
 * Resolved by matching the signal's cited URL back to the observation it was extracted
 * from — deterministic, and never asked of the model. The LLM is capable of writing
 * "source_class: filing" on a blog post, and a provenance label that can be hallucinated
 * is worse than none: it would make the evidence-base strip and the verifier's diversity
 * gate both confidently wrong.
 *
 * A signal whose URL matches no observation keeps `source_class: null` rather than being
 * guessed at. Untiered general search is genuinely unclassified — see searchQuery().
 *
 * Both sides of the join go through `normalizeUrlForMatch`, the same normalizer
 * filterGroundedSignals uses one step earlier in this chain. They must agree: a raw string
 * compare here meant a signal could ground as `exact` against an observation and then fail
 * to inherit that observation's class, purely because the model wrote `http://` or dropped
 * a `www.`. Two comparisons of the same pair of URLs cannot use two different rules.
 */
export function attachSourceClass(signals, observations = []) {
    if (!Array.isArray(signals) || signals.length === 0) return signals;

    const classByUrl = new Map();
    for (const obs of observations || []) {
        if (!obs?.url || !obs?.source_class) continue;
        const key = normalizeUrlForMatch(obs.url);
        if (key) classByUrl.set(key, obs.source_class);
    }
    if (classByUrl.size === 0) return signals;

    return signals.map(s => {
        const url = normalizeUrlForMatch(s?.source_url);
        const cls = url ? classByUrl.get(url) : null;
        return cls ? { ...s, source_class: cls } : s;
    });
}

/**
 * The complete signal filter chain, in one place.
 *
 * Every path that produces signals MUST go through this — the main analysis batches and
 * the verifier's gap-fill retry alike. Keeping it as one function is what makes
 * "a gap-fill never lowers the bar" a structural property rather than a promise: there is
 * no second, laxer chain for retried signals to slip through, and a filter added here is
 * automatically enforced on both paths.
 */
export function applySignalFilters(signals, batchText, companyName, observations = []) {
    // Grounding guard: drop any signal citing a URL the model wasn't shown in this batch,
    // and refuse to cite an unseen path on a known domain. `observations` is the
    // authoritative URL set — matching against the rendered text is what made the old
    // check permissive, so it is only the fallback when a caller has no observations.
    let out = filterGroundedSignals(signals, batchText, observations);
    // Quote-binding harness (opt-in): additionally require verbatim evidence in the batch.
    if (SIGNAL_QUOTE_BINDING) out = filterQuoteBoundSignals(out, batchText);
    // A signal must carry a read, and must be about someone other than the founder.
    out = filterReadableSignals(out);
    out = filterSelfSignals(out, companyName);
    // Opportunity deadlines and amounts are quote-or-drop, field by field. In this chain —
    // not at a call site — so the gap-fill and daily pursuit paths cannot skip it.
    out = groundOpportunityFields(out, batchText);
    // Provenance is attached here rather than at each call site for the same reason the
    // filters are: one chain means the gap-fill path cannot quietly diverge from the main one.
    out = attachSourceClass(out, observations);
    return out;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPER: Quote-binding harness (opt-in via VITE_SIGNAL_QUOTE_BINDING).
// Stronger sibling of the grounding guard above: require each signal to carry a verbatim
// evidence_quote copied from the analyzed batch — or, as a backstop for short/reworded
// quotes, its named entity to appear verbatim there. Drops LLM-embellished signals whose
// supporting text isn't actually in the source. This is the same quote-or-drop rule
// documentIntelService applies to uploaded documents (see verifyAgainstDocument), extended
// to web signals. Only invoked when the flag is on, so default behavior is unchanged.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function normalizeForQuoteMatch(text) {
    return String(text || '').replace(/\s+/g, ' ').toLowerCase().trim();
}

function signalAttested(signal, haystack) {
    const quote = normalizeForQuoteMatch(signal?.evidence_quote);
    if (quote.length >= 16 && haystack.includes(quote)) return true;
    // Backstop: the named entity itself must appear verbatim in the source.
    const entity = normalizeForQuoteMatch(signal?.entity_involved);
    return entity.length >= 3 && haystack.includes(entity);
}

function filterQuoteBoundSignals(signals, batchText) {
    if (!Array.isArray(signals) || signals.length === 0) return signals || [];
    const haystack = normalizeForQuoteMatch(batchText);
    const kept = [];
    let dropped = 0;
    for (const s of signals) {
        if (signalAttested(s, haystack)) kept.push(s);
        else dropped++;
    }
    if (dropped > 0) {
        console.warn(`[quote-binding] Dropped ${dropped}/${signals.length} signal(s) with no verbatim evidence in the analyzed batch`);
    }
    return kept;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPER: Build a rich client-side summary when Gemini is unavailable
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function buildClientSideSummary(context, signals) {
    const companyName = context.company_name || 'your company';
    const insights = [];

    // Group signals by display section, so this fallback tracks SECTION_MAP instead of
    // carrying its own (fourth) hand-maintained copy of the category list.
    const sectionGroups = {};
    for (const s of signals) {
        const section = sectionForCategory(s.category);
        if (!section) continue;
        if (!sectionGroups[section]) sectionGroups[section] = [];
        sectionGroups[section].push(s);
    }

    const textOf = (s) => s.the_move || s.signal_headline;

    // Opportunity insight — the section that points at revenue, partners and funders.
    const opportunitySignals = [
        ...(sectionGroups[SECTIONS.OPPORTUNITIES] || []),
        ...(sectionGroups[SECTIONS.FUNDING] || []).filter(s => s.category === 'FundingOpportunity'),
    ];
    if (opportunitySignals.length > 0) {
        insights.push({ type: 'opportunity', text: textOf(opportunitySignals[0]) });
    }

    // Competition insight
    const competitorSignals = sectionGroups[SECTIONS.COMPETITION] || [];
    if (competitorSignals.length > 0) {
        const count = competitorSignals.length;
        insights.push({
            type: 'competitor',
            text: `${count} competitor signal${count > 1 ? 's' : ''} detected. ${textOf(competitorSignals[0])}`
        });
    }

    // Customer insight — change in the accounts and segments already served.
    if (sectionGroups[SECTIONS.CUSTOMERS]?.length > 0) {
        insights.push({ type: 'customer', text: textOf(sectionGroups[SECTIONS.CUSTOMERS][0]) });
    }

    // Supply insight — a dependency moved.
    if (sectionGroups[SECTIONS.SUPPLY]?.length > 0) {
        insights.push({ type: 'shift', text: textOf(sectionGroups[SECTIONS.SUPPLY][0]) });
    }

    // Regulatory insight
    if (sectionGroups[SECTIONS.REGULATORY]?.length > 0) {
        insights.push({ type: 'regulatory', text: textOf(sectionGroups[SECTIONS.REGULATORY][0]) });
    }

    // Talent insight
    if (sectionGroups[SECTIONS.TALENT]?.length > 0) {
        insights.push({ type: 'shift', text: textOf(sectionGroups[SECTIONS.TALENT][0]) });
    }

    // Overall context
    const immediateCount = signals.filter(s => s.timing_window === 'immediate').length;
    const highConfCount = signals.filter(s => s.confidence === 'High').length;
    insights.push({
        type: 'context',
        text: `${signals.length} intelligence signals detected for ${companyName}. ${immediateCount > 0 ? `${immediateCount} require immediate attention. ` : ''}${highConfCount > 0 ? `${highConfCount} are high-confidence.` : ''}`
    });

    // Overall implication
    if (signals.length >= 3) {
        const topSignal = signals.reduce((best, s) => (s.relevance_score || 0) > (best.relevance_score || 0) ? s : best, signals[0]);
        insights.push({
            type: 'implication',
            text: topSignal.so_what_for_you || `Monitor the ${signals.length} detected signals closely — several have strategic implications for ${companyName}.`
        });
    }

    return { insights };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PIPELINE TIMER — Track time budget across the entire intelligence pipeline
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class PipelineTimer {
    constructor(maxDurationMs = 180000) { // 3 minutes max for the entire pipeline
        this.startTime = Date.now();
        this.maxDurationMs = maxDurationMs;
        this.stepTimings = [];
    }

    elapsed() {
        return Date.now() - this.startTime;
    }

    remaining() {
        return Math.max(0, this.maxDurationMs - this.elapsed());
    }

    /**
     * Check if enough time budget remains for a step.
     * @param {string} stepName - Name of the step (for logging)
     * @param {number} requiredMs - Minimum milliseconds needed
     * @returns {boolean}
     */
    canAfford(stepName, requiredMs = 30000) {
        const canDo = this.remaining() >= requiredMs;
        if (!canDo) {
            console.warn(`[Pipeline] ⏰ Skipping "${stepName}" — only ${(this.remaining() / 1000).toFixed(1)}s left (needs ${(requiredMs / 1000).toFixed(0)}s)`);
        }
        return canDo;
    }

    logStep(stepName) {
        this.stepTimings.push({ step: stepName, elapsed: this.elapsed() });
        console.log(`[Pipeline] ✅ "${stepName}" completed at ${(this.elapsed() / 1000).toFixed(1)}s`);
    }

    summary() {
        return this.stepTimings.map(s => `${s.step}: ${(s.elapsed / 1000).toFixed(1)}s`).join(' → ');
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CIRCUIT BREAKER — Prevents cascading 429 retries
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const circuitBreaker = {
    consecutive429s: 0,
    lastFailTime: 0,
    THRESHOLD: 3,          // After 3 consecutive 429s, stop retrying
    COOLDOWN_MS: 60000,    // Reset after 60s of no failures

    recordSuccess() {
        this.consecutive429s = 0;
    },

    record429() {
        this.consecutive429s++;
        this.lastFailTime = Date.now();
        console.warn(`[CircuitBreaker] 429 count: ${this.consecutive429s}/${this.THRESHOLD}`);
    },

    isOpen() {
        // Auto-reset after cooldown
        if (this.consecutive429s > 0 && (Date.now() - this.lastFailTime) > this.COOLDOWN_MS) {
            console.log('[CircuitBreaker] Cooldown expired, resetting');
            this.consecutive429s = 0;
            return false;
        }
        return this.consecutive429s >= this.THRESHOLD;
    }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROVIDER ROUTING
// Provider is chosen at the action level and is fully env-driven so models can be
// swapped without a code change.
//
// Every action runs on Gemini by default; the gemini gateway picks the concrete model by
// tier (MODEL_TIERS in lib/handlers/gemini.js):
//   - heavy     gemini-3.8-flash       buildContext, mergeContext, analyzeSignals,
//                                      extractDocumentIntel, answerQuestion
//   - light     gemini-3.5-flash-lite  generateQueries, frameDecision
//   - reasoning gemini-3.1-pro-preview generateSummary, generateDecisionBrief,
//                                      interpretShifts — 1–3 calls per run
//   - Sarvam   = the cheap cross-provider FALLBACK, only when Gemini itself is unavailable.
//   - Claude   = fully WIRED (endpoint + capabilities) but OFF by default. Enable later by
//                pointing an env var at 'claude', e.g. VITE_LLM_PRIMARY=claude /
//                VITE_LLM_REASONING=claude / VITE_LLM_FALLBACK=claude
// Typed decisions (scores, yes/no, choices) are not routed here — they go to Jev through
// src/services/jevService.js.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PRIMARY_PROVIDER   = readRuntimeEnv('VITE_LLM_PRIMARY', 'gemini');
// Reasoning/synthesis tier — defaults to the primary provider (Gemini). The concrete
// stronger model is chosen inside the gemini gateway per action.
const REASONING_PROVIDER = readRuntimeEnv('VITE_LLM_REASONING', PRIMARY_PROVIDER);
const FALLBACK_PROVIDER  = readRuntimeEnv('VITE_LLM_FALLBACK', 'sarvam');

// Quote-binding harness (opt-in, default OFF). When on, each web signal must carry a verbatim
// evidence_quote found in the analyzed source or it is dropped — the credibility rule
// documentIntelService applies to uploaded docs, extended to web signals. Off ⇒ pipeline
// behaves exactly as before (no prompt/schema change requested, no extra filtering).
const SIGNAL_QUOTE_BINDING = readRuntimeEnv('VITE_SIGNAL_QUOTE_BINDING', 'false') === 'true';

const PROVIDER_ROUTING = {
    // buildContext is the single highest-leverage LLM call — every downstream step inherits it.
    // Overridable independently via VITE_CONTEXT_LLM_PROVIDER; otherwise follows PRIMARY_PROVIDER.
    buildContext:      readRuntimeEnv('VITE_CONTEXT_LLM_PROVIDER', PRIMARY_PROVIDER),
    // Folding new sources into an existing context is a small, quote-bound extraction.
    // It follows buildContext's provider so a merge and a build never disagree about the
    // company for reasons that are only about which model happened to read the page.
    mergeContext:      readRuntimeEnv('VITE_CONTEXT_LLM_PROVIDER', PRIMARY_PROVIDER),
    frameDecision:     PRIMARY_PROVIDER,
    generateQueries:   PRIMARY_PROVIDER,   // reliable structured JSON
    analyzeSignals:    PRIMARY_PROVIDER,   // primary analytical step (bulk, per-source — stays on Flash)
    generateSummary:   REASONING_PROVIDER, // synthesis — the founder-facing brief (reasoning tier)
    generateDecisionBrief: REASONING_PROVIDER,
    interpretShifts:   REASONING_PROVIDER, // judgment — shift meaning (reasoning tier); was sarvam-m
    answerQuestion:    PRIMARY_PROVIDER,   // grounded answers
    // Extraction is quote-bound rather than analytical, and its output seeds the
    // entity watchlist — correctness matters more than prose quality.
    extractDocumentIntel: PRIMARY_PROVIDER,
};

const PROVIDER_ENDPOINTS = {
    gemini:   `${API_BASE}/gemini`,
    claude:   `${API_BASE}/claude`,
    groq:     `${API_BASE}/groq`,
    sarvam:   `${API_BASE}/sarvam`,
};

// Cross-provider fallback. Each provider falls back to FALLBACK_PROVIDER (default Sarvam),
// and everything falls back to Gemini as the last resort. Claude only participates when
// explicitly enabled via env (it is not referenced by any default chain).
const PROVIDER_FALLBACK_CHAIN = {
    gemini:   [FALLBACK_PROVIDER].filter(p => p && p !== 'gemini'),
    sarvam:   ['gemini'],
    claude:   ['gemini'],   // used only if Claude is manually enabled as a primary
    groq:     ['gemini'],
    deepseek: [],
};

// When the first buildContext read is thin/incomplete, escalate ONCE to a stronger model
// before degrading to a fallback shell. Disabled by default in the testing setup ('none')
// because there is no clearly-stronger model than Gemini Flash while Claude is off.
// Set VITE_CONTEXT_ESCALATION_PROVIDER=claude (or another provider) to enable.
const CONTEXT_ESCALATION_PROVIDER = readRuntimeEnv('VITE_CONTEXT_ESCALATION_PROVIDER', 'none');

// Actions each provider supports — avoids predictable 400s. Sarvam is a general chat model
// (OpenAI-compatible) so it can serve every action, both as the light-action provider and as
// the cross-provider fallback for Gemini's heavy actions.
const PROVIDER_CAPABILITIES = {
    gemini:   ['buildContext', 'mergeContext', 'frameDecision', 'generateQueries', 'analyzeSignals', 'generateSummary', 'generateDecisionBrief', 'interpretShifts', 'answerQuestion', 'extractDocumentIntel'],
    claude:   ['buildContext', 'mergeContext', 'frameDecision', 'generateQueries', 'analyzeSignals', 'generateSummary', 'generateDecisionBrief', 'interpretShifts', 'answerQuestion', 'extractDocumentIntel'],
    groq:     ['generateQueries', 'generateDecisionBrief', 'interpretShifts', 'answerQuestion', 'buildContext', 'mergeContext', 'analyzeSignals', 'generateSummary', 'extractDocumentIntel'],
    sarvam:   ['buildContext', 'mergeContext', 'frameDecision', 'generateQueries', 'analyzeSignals', 'generateSummary', 'generateDecisionBrief', 'interpretShifts', 'answerQuestion', 'extractDocumentIntel'],
    deepseek: [],
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RUN PROVENANCE — which provider/model served each LLM call, and at what token cost.
// Scoped to a single runSignalGeneration() run (reset at its start). Populated by
// callProviderAPI from the x-llm-* response headers each gateway sets. Attached to the
// report so a run is fully observable (per-step provider, model, tokens, salvage, latency).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let _runProvenance = null;

function recordProvenance(rec) {
    if (_runProvenance) _runProvenance.push({ at: new Date().toISOString(), ...rec });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RUN SPEND LEDGER — what this run has consumed so far, across every invocation.
//
// Provenance answers "which model served this call"; the spend ledger answers "what has
// this job cost in total". They are separate because provenance is per-call and grows
// unbounded, while spend is a fixed-size rollup safe to check on a hot path.
//
// This is RECORDING only. Nothing enforces a cap yet — enforcement arrives with the
// budget controller. Keep it that way: a recorder that silently starts blocking work is
// a bad surprise. Wall clock accumulates ACROSS serverless invocations, which is why it
// cannot come from PipelineTimer (that only measures the current invocation).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Blended $/1M tokens. The gateways report a single total token count rather than an
 * input/output split, so a blended rate is the most honest estimate available — treat
 * these as order-of-magnitude, not billing truth.
 */
const PROVIDER_COST_PER_MTOK = {
    gemini: 0.30,
    claude: 6.00,
    groq: 0.20,
    sarvam: 0.20,
    deepseek: 0.40,
    // Input only — Jev bills no output. A triage pass over ~200 observations is ~$0.005.
    jev: 0.042,
};

/**
 * Per-model blended $/1M tokens, preferred over the provider rate when the gateway names the
 * model. One flat Gemini rate made a Pro call cost the same as Flash-Lite in the ledger.
 * Blended as 75% input / 25% output (thinking is billed as output), list prices Sep 2026.
 * gemini-3.8-flash is at its introductory price, which doubles on 2027-01-01.
 */
export const MODEL_COST_PER_MTOK = {
    'gemini-3.8-flash': 1.50,       // $0.75 in / $3.75 out
    'gemini-3.6-flash': 3.00,       // $1.50 in / $7.50 out
    'gemini-3.5-flash-lite': 0.85,  // $0.30 in / $2.50 out
    'gemini-3.1-pro-preview': 4.50, // $2.00 in / $12.00 out (≤200K prompt)
    'gemini-2.5-flash': 0.85,
    'gemini-2.5-flash-lite': 0.85,
};

export function costRateFor(provider, model = null) {
    return (model && MODEL_COST_PER_MTOK[model]) ?? PROVIDER_COST_PER_MTOK[provider] ?? 0;
}

function emptySpend() {
    return {
        tokens: { total: 0, byProvider: {} },
        calls: { total: 0, byTool: {} },
        cost_usd: { total: 0, byProvider: {} },
        wall_clock_ms: 0,
        failures: 0,
    };
}

let _runSpend = null;

export function getRunSpend() {
    return _runSpend ? JSON.parse(JSON.stringify(_runSpend)) : emptySpend();
}

export function setRunSpend(spend) {
    _runSpend = spend && typeof spend === 'object'
        ? { ...emptySpend(), ...JSON.parse(JSON.stringify(spend)) }
        : emptySpend();
}

/** Add one invocation's elapsed time to the run total. Called by the stepped worker. */
export function addRunWallClock(ms) {
    if (!_runSpend) return;
    _runSpend.wall_clock_ms += Math.max(0, Number(ms) || 0);
}

/**
 * Record a single outbound call. `tool` is the gateway hit (gemini/claude/tavily/scrape/exa);
 * `provider` is the LLM vendor when the call was an LLM call, otherwise omitted.
 */
function recordSpend({ tool, provider = null, model = null, tokens = 0, ok = true }) {
    if (!_runSpend) return;
    const s = _runSpend;

    s.calls.total += 1;
    s.calls.byTool[tool] = (s.calls.byTool[tool] || 0) + 1;
    if (!ok) s.failures += 1;

    const tok = Number(tokens) || 0;
    if (provider && tok > 0) {
        s.tokens.total += tok;
        s.tokens.byProvider[provider] = (s.tokens.byProvider[provider] || 0) + tok;

        const rate = costRateFor(provider, model);
        const cost = (tok / 1_000_000) * rate;
        s.cost_usd.total = Number((s.cost_usd.total + cost).toFixed(6));
        s.cost_usd.byProvider[provider] = Number(((s.cost_usd.byProvider[provider] || 0) + cost).toFixed(6));
    }
}

function summarizeProvenance(records) {
    const byProvider = {};
    for (const r of records) {
        const p = r.provider || 'unknown';
        if (!byProvider[p]) byProvider[p] = { calls: 0, ok: 0, failed: 0, tokens: 0, salvaged: 0 };
        byProvider[p].calls++;
        if (r.ok) byProvider[p].ok++; else byProvider[p].failed++;
        byProvider[p].tokens += Number(r.tokens) || 0;
        if (r.salvaged) byProvider[p].salvaged++;
    }
    return {
        byProvider,
        totalCalls: records.length,
        totalTokens: records.reduce((s, r) => s + (Number(r.tokens) || 0), 0)
    };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SESSION CACHE — compressed context for answerQuestion (avoids re-encoding per question)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _cachedCompressedContext = null;
let _cachedCompressedContextId = null;

function buildCompressedContext(context) {
    const summary = context?.brief?.summary || context?.summary || '';
    const top10 = (context?.signals || [])
        .sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0))
        .slice(0, 10)
        .map((s, i) => `[${i + 1}] ${s.signal_headline || s.category}: ${s.the_move || ''}`)
        .join('\n');
    const memoryCards = Array.isArray(context?.memory?.current_cards)
        ? context.memory.current_cards
            .filter(card => card.status === 'active')
            .slice(0, 8)
            .map((card, i) => `[${i + 1}] ${card.section_key} :: ${card.title} (${card.trend_state || 'new'}, x${card.occurrence_count || 1})`)
            .join('\n')
        : '';
    const parts = [];
    if (context?.company_name) parts.push(`Company: ${context.company_name}`);
    if (context?.industry) parts.push(`Industry: ${context.industry}`);
    if (summary) parts.push(`Summary: ${summary}`);
    if (top10) parts.push(`Top signals:\n${top10}`);
    if (memoryCards) parts.push(`Memory cards:\n${memoryCards}`);
    return parts.join('\n\n');
}

/**
 * The subset of the context `PROMPTS.answerQuestion` actually reads, with the large parts
 * capped.
 *
 * Exported so the round trip between what the prompt consumes and what the caller sends is
 * assertable — the same discipline as AGENDA_COLUMNS against its row mapper. A field the
 * prompt reads that this does not carry renders as `undefined` in front of a founder, and
 * nothing throws.
 *
 * The source documents are capped here as well as in the prompt. The prompt's substring is
 * about prompt size; this one is about payload size, and they are different problems —
 * without it the full scraped site crosses the wire on every question.
 */
export function buildAnswerContext(context) {
    if (!context || typeof context !== 'object') return {};
    const src = context._sourceDocuments || {};
    const cap = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
    return {
        company_name: context.company_name,
        industry: context.industry,
        sensitivity_map: context.sensitivity_map || {},
        // Restores the decision block, which has never once rendered — not even on a
        // decision run, because a string has no `_decision`.
        _decision: context._decision || null,
        _sourceDocuments: {
            website: cap(src.website, 15000),
            linkedin: cap(src.linkedin, 5000),
            uploadedDoc: cap(src.uploadedDoc, 10000),
        },
    };
}

function getCompressedContext(context) {
    const id = context?.report_id || context?.id || context?.company_name;
    if (id && id === _cachedCompressedContextId) {
        console.log('[context-cache hit] Reusing compressed context for', id);
        return _cachedCompressedContext;
    }
    _cachedCompressedContext = buildCompressedContext(context);
    _cachedCompressedContextId = id;
    return _cachedCompressedContext;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SERVERLESS API CALLS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function callProviderAPI(action, payload, providerOverride = null) {
    const provider = providerOverride || PROVIDER_ROUTING[action] || 'gemini';
    const endpoint = PROVIDER_ENDPOINTS[provider] || PROVIDER_ENDPOINTS.gemini;
    const t0 = Date.now();

    const response = await intelligenceRuntime.postJson(endpoint, { action, payload });

    if (!response.ok) {
        const text = await response.text();
        console.error(`[${provider.toUpperCase()}] API Error Response:`, text);
        recordProvenance({ action, provider, ok: false, status: response.status, latency_ms: Date.now() - t0, prompt_version: PROMPT_VERSION });
        recordSpend({ tool: provider, provider, tokens: 0, ok: false });
        try {
            const errBody = JSON.parse(text);
            const err = new Error(errBody.error || `API Error: ${response.status}`);
            err.provider = errBody.provider || provider;
            err.statusCode = response.status;
            err.code = errBody.code;
            throw err;
        } catch (e) {
            if (e.provider) throw e; // re-throw our enriched error
            const snippet = text.slice(0, 100).replace(/\n/g, " ");
            const err2 = new Error(`Server Error (${response.status}): ${snippet}`);
            err2.provider = provider;
            err2.statusCode = response.status;
            throw err2;
        }
    }

    // Record provenance from the x-llm-* headers each gateway sets.
    const headerGet = (name) => (response.headers?.get ? response.headers.get(name) : null);
    const numberHeader = (name) => {
        const raw = headerGet(name);
        return raw != null ? Number(raw) : null;
    };
    const tokens = numberHeader('x-llm-tokens');
    const model = headerGet('x-llm-model') || null;
    recordProvenance({
        action,
        provider,
        ok: true,
        model,
        tokens,
        thoughts: numberHeader('x-llm-thoughts'),
        finish: headerGet('x-llm-finish') || null,
        // Models that failed before this one answered. Empty on a healthy call; anything
        // here means the action ran on a fallback, which is otherwise invisible.
        fallbacks: headerGet('x-llm-fallbacks') ? headerGet('x-llm-fallbacks').split(',') : [],
        salvaged: headerGet('x-llm-salvaged') === '1',
        latency_ms: Date.now() - t0,
        prompt_version: PROMPT_VERSION
    });
    recordSpend({ tool: provider, provider, model, tokens: tokens || 0, ok: true });

    return response.json();
}

/**
 * Client-side retry wrapper with CIRCUIT BREAKER.
 * Catches 429s that exhaust server-side retries and waits before retrying.
 * Will fail fast if circuit breaker is open (consecutive 429s detected).
 */
function isLowQualityAnswer(text) {
    if (!text || typeof text !== 'string') return true;
    const trimmed = text.trim();
    if (trimmed.length < 80) return true;
    const lower = trimmed.toLowerCase();
    return /not enough verified|insufficient information|cannot find|unknown|unable to answer/i.test(lower);
}

function enrichAskPayloadForRetry(payload, attempt) {
    return {
        ...payload,
        modelBoost: true,
        temperature: Math.min(1.0, (payload.temperature || 0.6) + 0.1 * attempt),
        maxTokens: (payload.maxTokens || 1024) + 256 * attempt,
        questionPrefix: attempt === 1 ? 'Use all available context and search result data. ' : 'Expand with additional external context and cite sources. ',
    };
}

/**
 * Public entrypoint to the LLM gateway for callers outside this module.
 *
 * Exposes the same retry, circuit-breaker and provider-fallback behaviour every pipeline
 * step gets, so features like document-intel extraction don't reimplement it — or worse,
 * call a provider endpoint directly and bypass the breaker.
 */
export function callLLMAction(action, payload, providerOverride = null) {
    return callLLMWithRetry(action, payload, 1, providerOverride);
}

async function callLLMWithRetry(action, payload, maxClientRetries = 2, providerOverride = null) {
    // Circuit breaker check
    if (circuitBreaker.isOpen()) {
        console.warn(`[CircuitBreaker] OPEN — skipping "${action}" call to prevent further rate limiting`);
        throw new Error(`Rate limit circuit breaker open for "${action}". Too many consecutive 429 errors. Wait 60s.`);
    }

    const primaryProvider = providerOverride || PROVIDER_ROUTING[action] || 'gemini';
    let lastErr;

    for (let attempt = 0; attempt <= maxClientRetries; attempt++) {
        try {
            const result = await callProviderAPI(action, payload, providerOverride);
            circuitBreaker.recordSuccess();

            if (action === 'answerQuestion' && isLowQualityAnswer(result.answer)) {
                if (attempt < maxClientRetries) {
                    payload = enrichAskPayloadForRetry(payload, attempt + 1);
                    const waitMs = (attempt + 1) * 3000 + Math.random() * 2000;
                    console.warn(`[Client Quality Retry] Low-quality answer detected. Re-trying ${action} in ${Math.round(waitMs/1000)}s.`);
                    await new Promise(r => setTimeout(r, waitMs));
                    continue;
                }
            }

            return result;
        } catch (err) {
            lastErr = err;

            // PROVIDER_UNAVAILABLE (key not set) — skip retry loop, go straight to Gemini fallback
            if (err.code === 'PROVIDER_UNAVAILABLE') break;

            const is429 = err.message?.includes('429') || err.message?.includes('Resource exhausted') || err.message?.includes('Rate limit') || err.message?.includes('account-level rate limit');

            if (is429) {
                circuitBreaker.record429();
                if (circuitBreaker.isOpen()) {
                    throw new Error(`Rate limit circuit breaker tripped for "${action}". Stopping retries.`);
                }
            }

            if (!is429 || attempt >= maxClientRetries) break;

            const retryInMatch = err.message?.match(/retry in ([\d.]+)s/i);
            const suggestedMs = retryInMatch ? Math.ceil(parseFloat(retryInMatch[1])) * 1000 : 0;
            const baseMs = (attempt + 1) * 15000; // 15s, 30s, 45s
            const waitMs = Math.max(suggestedMs, baseMs) + Math.random() * 5000;
            console.warn(`[Client Retry] 429 on '${action}' (${primaryProvider}). Waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 2}/${maxClientRetries + 1})...`);
            await new Promise(r => setTimeout(r, waitMs));
        }
    }

    // Provider-level fallback chain (declarative, per PROVIDER_FALLBACK_CHAIN)
    const fallbackChain = PROVIDER_FALLBACK_CHAIN[primaryProvider] || ['gemini'];
    for (const fallbackProvider of fallbackChain) {
        // Skip providers that don't support this action — avoids predictable 400s
        const capabilities = PROVIDER_CAPABILITIES[fallbackProvider];
        if (capabilities && !capabilities.includes(action)) {
            console.warn(`[LLM Fallback] Skipping ${fallbackProvider} for "${action}" — not in its capability set.`);
            continue;
        }
        console.warn(`[LLM Fallback] ${primaryProvider} failed for "${action}" (${lastErr?.message}). Trying ${fallbackProvider}.`);
        try {
            const result = await callProviderAPI(action, payload, fallbackProvider);
            circuitBreaker.recordSuccess();
            return result;
        } catch (fallbackErr) {
            const isUnavailable = fallbackErr.code === 'PROVIDER_UNAVAILABLE';
            console.warn(`[LLM Fallback] ${fallbackProvider} failed for "${action}" (${fallbackErr.message})${isUnavailable ? ' — no key' : ''}`);
            lastErr = fallbackErr;
            // PROVIDER_UNAVAILABLE means no key — no point retrying this provider
        }
    }

    throw lastErr;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXTERNAL SERVICE CALLS (Tavily search, Exa search, page extraction)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Extract one page via /api/scrape (Parallel AI Extract, falling back to Exa).
 *
 * Returns `{ text, title, publishDate, source } | null`. `source` is the provider that
 * actually served the page — callers persist it rather than assuming, because which one
 * answered is not predictable from here and the two are not equivalent in quality.
 */
export async function fetchPageExtract(url) {
    try {
        const response = await intelligenceRuntime.postJson(`${API_BASE}/scrape`, { url });

        if (!response.ok) {
            recordSpend({ tool: 'scrape', ok: false });
            console.warn(`Page extract failed with status ${response.status} for ${url}`);
            return null;
        }

        const json = await response.json();
        if (!json.text) {
            recordSpend({ tool: 'scrape', ok: false });
            return null;
        }

        // Attribute spend to whichever provider actually did the work — billing them to a
        // single 'scrape' bucket made the (never-succeeding) Parallel AI path invisible.
        recordSpend({ tool: json.source === 'exa' ? 'exa_contents' : 'parallel', ok: true });

        return {
            text: json.text,
            title: json.title || '',
            publishDate: json.publishDate || null,
            source: json.source === 'exa' ? 'exa' : 'parallel_ai',
            // Null when the provider did not say. Only callers that cannot tolerate a
            // substituted page (the change monitor) should act on a mismatch.
            resolvedUrl: json.resolvedUrl || null,
        };
    } catch (e) {
        recordSpend({ tool: 'scrape', ok: false });
        console.warn("Deep Web Reader unavailable:", e.message);
        return null;
    }
}

/**
 * Tavily search.
 *
 * Returns `{ results, error }`. `error` is null on success — including when the
 * search legitimately matched nothing. Callers must not treat an empty `results`
 * array as a provider failure: an outage and a genuinely empty result set are
 * different events, and only the former should trigger a fallback provider.
 */
async function fetchTavilySearch(query, options = {}) {
    try {
        const response = await intelligenceRuntime.postJson(`${API_BASE}/search`, { query, ...options });
        recordSpend({ tool: 'tavily', ok: response.ok });
        if (!response.ok) {
            const text = await response.text();
            const message = `Tavily gateway failed (${response.status}): ${text.slice(0, 160)}`;
            console.warn(message);
            return { results: [], error: message };
        }
        const json = await response.json();
        return { results: json.results || [], error: null };
    } catch (e) {
        recordSpend({ tool: 'tavily', ok: false });
        const message = `Global Signal Network unavailable: ${e.message}`;
        console.warn(message);
        return { results: [], error: message };
    }
}

/**
 * Exa search — the fallback path when Tavily is unavailable.
 * Normalized onto Tavily's result shape so callers stay provider-agnostic.
 */
export async function fetchExaSearch(query, {
    max_results = 6,
    includeDomains = null,
    category = null,
    retrievalWindow = 'current',
    temporalPolicy = null,
} = {}) {
    try {
        const body = {
            query,
            type: 'auto',
            numResults: max_results,
            includeContents: true,
            maxCharacters: 3000,
        };
        // 'research paper' / 'pdf' reach the academic and report web beyond any
        // hand-maintained domain allowlist.
        if (category) body.category = category;

        // BOTH bounds, not just the start. An open-ended upper bound lets a source with a
        // bad or future publication date sail through the filter that was meant to bound
        // it — and Exa is the fallback provider, so that leak is invisible until Tavily
        // has an outage. The 'profile' window resolves to {} here: entity pages are
        // undated, and bounding them by publication date filters out the page we went
        // there for.
        const bounds = buildDateWindowParams(retrievalWindow, temporalPolicy || buildTemporalPolicy(), 'general');
        if (bounds.start_date) body.startPublishedDate = bounds.start_date;
        if (bounds.end_date) body.endPublishedDate = bounds.end_date;
        // Keep tier steering intact when Exa covers for a Tavily outage.
        if (includeDomains?.length) body.includeDomains = includeDomains;

        const response = await intelligenceRuntime.postJson(`${API_BASE}/exa`, body);
        recordSpend({ tool: 'exa', ok: response.ok });
        if (!response.ok) {
            const text = await response.text();
            return { results: [], error: `Exa gateway failed (${response.status}): ${text.slice(0, 160)}` };
        }

        const json = await response.json();
        // Map Exa -> Tavily shape.
        //
        // `score` arrives null and stays null: on type 'auto' (what we send here) Exa
        // returns no score at all, and on type 'neural' it returns rank position dressed
        // as a score — measured as exactly (n-1-i)/(n-1), i.e. [1, 0.5, 0] for three
        // results regardless of how relevant they are. Neither is comparable to Tavily's
        // relevance score, so switching modes to "get a score" would be worse than having
        // none: the last result of every query would score 0 and be filtered out on
        // position alone. MIN_TAVILY_SCORE is therefore a Tavily-only gate, and unscored
        // Exa rows pass it via `?? 1` at the filter. See the note there.
        const results = (json.results || []).map(r => ({
            title: r.title || '',
            url: r.url,
            content: (r.highlights || []).join(' ') || (r.text || '').slice(0, 500),
            raw_content: r.text || '',
            published_date: r.publishedDate || null,
            score: r.score ?? null,
        }));
        return { results, error: null };
    } catch (e) {
        recordSpend({ tool: 'exa', ok: false });
        return { results: [], error: `Exa unavailable: ${e.message}` };
    }
}

/**
 * Thin wrapper over the /api/exa gateway. Swallows failures into an empty result
 * set — every caller below treats Exa as best-effort enrichment, never as a gate.
 */
async function postExa(body) {
    try {
        const r = await intelligenceRuntime.postJson(`${API_BASE}/exa`, body);
        recordSpend({ tool: 'exa', ok: r.ok });
        return r.ok ? await r.json() : { results: [] };
    } catch {
        recordSpend({ tool: 'exa', ok: false });
        return { results: [] };
    }
}

/** Reduce a name or URL to a comparable token: "Acme Corp." / "acme.io" -> "acme". */
function normalizeBrandToken(value) {
    if (!value) return '';
    let s = String(value).trim().toLowerCase();
    try {
        if (/^https?:\/\//.test(s)) s = new URL(s).hostname;
    } catch { /* not a URL — fall through */ }
    return s
        .replace(/^www\./, '')
        .replace(/\.(com|io|ai|co|net|org|dev|app)(\.[a-z]{2})?$/, '')
        .replace(/\b(inc|llc|ltd|corp|corporation|technologies|labs|software|company)\b/g, '')
        .replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve the real homepage of competitors the evidence named, from Exa's company index.
 *
 * They arrive with a name and no URL, and primarySourceMapper refuses to invent one for an
 * evidence entity — so without this they are tracked but never read. One company search
 * each, run together, bounded: persist must not wait on a slow index. A name Exa cannot
 * place is kept unresolved rather than dropped, because postExa answers an outage and an
 * unknown company identically (empty), and a transient failure must not delete a real rival.
 */
async function resolveEvidenceHomepages(entities, industry, { timeoutMs = 8000 } = {}) {
    if (!entities?.length) return entities;
    const lookups = entities.map(async (e) => {
        const token = normalizeBrandToken(e.name);
        if (!token || e.metadata?.resolved_url) return e;
        const res = await postExa({
            query: `${e.name} ${industry || ''}`.trim(),
            category: 'company', type: 'auto', numResults: 5, includeContents: false,
        });
        const own = (res.results || []).find(r =>
            normalizeBrandToken(r.url).includes(token) || normalizeBrandToken(r.title).startsWith(token)
        );
        try {
            if (own?.url) return { ...e, metadata: { ...e.metadata, resolved_url: new URL(own.url).origin } };
        } catch { /* unusable URL — leave unresolved */ }
        return e;
    });
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(entities), timeoutMs); });
    try {
        return await Promise.race([Promise.all(lookups), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Does Exa's company index actually know this entity, and has it done anything lately?
 *
 * This replaces a raw "did Exa return any rows" check, which was close to vacuous:
 * neural search almost always returns *something* for a plausible-sounding name, so
 * a hit count never disconfirmed a hallucinated competitor. We instead require the
 * company's own site to surface, and separately look for activity in the date window.
 */
async function validateCompetitorViaExa(name, { industry, startPublishedDate }) {
    const token = normalizeBrandToken(name);
    if (!token) return { hasOwnSite: false, recentActivity: 0, resolvedUrl: null };

    const [companyRes, activityRes] = await Promise.all([
        postExa({
            query: `${name} ${industry}`,
            category: 'company',
            type: 'auto',
            numResults: 5,
            includeContents: false,
        }),
        postExa({
            query: `${name} ${industry} product announcement news`,
            type: 'neural',
            numResults: 3,
            useAutoprompt: false,
            includeContents: false,
            startPublishedDate,
        }),
    ]);

    // "Own site" = a result whose domain (or title) resolves to the same brand token.
    // Keep the row, not just the boolean: this is the only place in the pipeline that
    // resolves a competitor's real homepage from an index rather than guessing it, and
    // discarding it meant primarySourceMapper fell back to the model's invented URL and
    // built /pricing and /changelog on top of it.
    const ownSite = (companyRes.results || []).find(r =>
        normalizeBrandToken(r.url).includes(token) || normalizeBrandToken(r.title).startsWith(token)
    );
    const hasOwnSite = Boolean(ownSite);

    // Only the origin. An Exa hit is often a deep page, and every consumer of this wants
    // the site the company lives at, not the one article that happened to rank.
    let resolvedUrl = null;
    try {
        if (ownSite?.url) resolvedUrl = new URL(ownSite.url).origin;
    } catch { /* unusable URL — stay null rather than pass a broken one downstream */ }

    // Count only dated results that actually name the entity. Neural search happily
    // returns topically-adjacent articles for a name that doesn't exist, so an
    // unfiltered count measures "is this an active industry", not "is this a real company".
    const recentActivity = (activityRes.results || []).filter(r =>
        r.publishedDate &&
        (normalizeBrandToken(r.url).includes(token) || normalizeBrandToken(r.title).includes(token))
    ).length;

    return { hasOwnSite, recentActivity, resolvedUrl };
}

/**
 * Score a competitor from Exa evidence. Returns the adjusted confidence.
 *
 * A discoverable homepage is *necessary*. An entity that Exa's company index cannot
 * produce a site for is the signature of an LLM hallucination, and no amount of
 * loosely-related press should rescue it — that press is what made it plausible.
 */
function scoreCompetitorConfidence(baseConf, { hasOwnSite, recentActivity }) {
    if (!hasOwnSite) return Math.max(10, baseConf - 40); // fails the necessary condition
    if (recentActivity > 0) return baseConf;
    return Math.max(40, baseConf - 10); // real company, just quiet in the window
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DEEP INTELLIGENCE LOGIC
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * PHASE 1: Deep Context Assembly
 * Primary: Tavily deep research (2 parallel queries, raw content).
 * Supplement: single Firecrawl scrape of main URL only if Tavily result is thin (<3000 chars).
 */
async function getDeepContextData(baseUrl, onProgress) {
    let normalizedUrl = baseUrl.trim();
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
        normalizedUrl = 'https://' + normalizedUrl;
    }
    let hostname;
    try { hostname = new URL(normalizedUrl).hostname; } catch (e) { hostname = baseUrl; }

    onProgress?.('Deep researching company across the web...');

    // PRIMARY: 2 parallel Tavily queries — company profile + competitor context
    //
    // Deliberately unbounded in time. These run on topic 'general', where a date window
    // filters out undated pages — and the company's own homepage is exactly that. Measured:
    // adding a 365-day window to this query drops https://vyaparapp.in from the results
    // entirely. Context assembly wants the canonical page far more than it wants recency.
    const [companySearch, competitorSearch] = await Promise.all([
        fetchTavilySearch(`"${hostname}" company product team technology investors`, {
            search_depth: 'advanced', max_results: 8
        }),
        fetchTavilySearch(`"${hostname}" competitors OR alternatives OR "similar to"`, {
            search_depth: 'advanced', max_results: 5
        })
    ]);

    const tavilyParts = [
        ...companySearch.results.map(r => r.raw_content || r.content),
        ...competitorSearch.results.map(r => `━━━ COMPETITOR CONTEXT ━━━\n${r.raw_content || r.content}`)
    ].filter(Boolean);

    const tavilyText = tavilyParts.join('\n\n');
    console.log(`✅ Tavily Deep Research: ${companySearch.results.length + competitorSearch.results.length} results, ${tavilyText.length} chars`);

    // ALWAYS read the founder's own URL directly.
    //
    // This used to run only when Tavily returned under 3000 chars. In practice Tavily
    // returns tens of thousands, so the company's own website — the one page whose
    // authorship is not in question, and the only first-party source in the whole context
    // build — was never actually read. The context was assembled entirely from third-party
    // pages ABOUT the company: directory listings, funding databases, press.
    //
    // It is returned SEPARATELY from the Tavily text so the caller can label each for what
    // it is. Merging them is what allowed 8 third-party search results to be presented to
    // the model under the header "COMPANY WEBSITE (8 pages)".
    onProgress?.('Reading the company site directly...');
    let extractText = '';
    try {
        const extract = await fetchPageExtract(normalizedUrl);
        extractText = extract?.text || '';
        if (extractText.length > 500) {
            console.log(`✅ Direct page read (${extract.source}): ${extractText.length} chars`);
        } else {
            extractText = '';
            console.warn('⚠️ Direct page read returned too little to use');
        }
    } catch (e) {
        console.warn(`⚠️ Direct page read failed (${e.message}); context is third-party only this run`);
    }

    return {
        text: tavilyText,
        ownSiteText: extractText,
        source: extractText ? 'Tavily Deep Research + Direct Page Read' : 'Tavily Deep Research',
        // Named for what it is. This is the number of SEARCH RESULTS, not a page count of
        // the company's site, and calling it pageCount is how it ended up rendered as
        // "COMPANY WEBSITE (8 pages)".
        resultCount: companySearch.results.length + competitorSearch.results.length,
    };
}

function shouldSkipDeepReadUrl(url) {
    return !url ||
        url.includes('linkedin.com') ||
        url.includes('twitter.com') ||
        url.includes('x.com') ||
        url.includes('youtube.com') ||
        url.includes('/tag/') ||
        url.includes('/search');
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order. */
async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}

/**
 * Execute one search query. Tavily first, Exa only when Tavily actually failed —
 * a successful search that matched nothing is a real answer, and retrying it on
 * Exa would just double the bill.
 *
 * Deliberately does NOT deep-read. Deep-read targets are chosen after every query
 * has run (see selectDeepReadTargets), so the choice cannot depend on the order in
 * which queries happened to finish. The old serial loop picked targets as it went,
 * mutating a shared budget and a seen-URL set, which made the target set a function
 * of execution order — unreproducible the moment searches run concurrently.
 */
export async function searchQuery(query, {
    theme = 'general',
    tier = null,
    queryIdx = 0,
    geography = null,
    // The window the QUERY was planned under, carried here rather than inferred from the
    // provider topic or the query wording. Defaults to 'current' so a job checkpointed
    // before this field existed resumes bounded rather than silently unbounded.
    retrievalWindow = 'current',
    temporalPolicy = null,
} = {}) {
    const policy = temporalPolicy || buildTemporalPolicy();
    // Tier queries are topic-agnostic by nature (a working paper is not "news"), so they
    // always search the general index, steered by their domain allowlist instead. The
    // exception is regional press, which IS news-shaped and gains a published_date and
    // recency ranking from the news index that the allowlist alone would not provide.
    const topic = tier
        ? (tier === 'regional_news' ? 'news' : 'general')
        : topicForTheme(theme);
    // Geography-keyed tiers (government, regional_news) resolve a different allowlist per
    // market — GOV.UK is noise to an Indian founder and PIB is noise to a British one.
    const includeDomains = tier ? domainsForTier(tier, geography) : null;
    const sourceClass = tier ? sourceClassForTier(tier) : null;

    let searchRes = await fetchTavilySearch(query, {
        max_results: budget().searchResultsPerQuery,
        search_depth: 'advanced',
        topic,
        ...dateWindowParams(topic, retrievalWindow, policy),
        ...(includeDomains ? { include_domains: includeDomains } : {})
    });

    let provider = 'Global Signal Network';
    let sourceType = 'tavily';

    if (searchRes.error) {
        console.warn(`[Search] Tavily failed for "${query.substring(0, 60)}" — falling back to Exa`);
        const exaRes = await fetchExaSearch(query, {
            max_results: budget().searchResultsPerQuery, includeDomains, retrievalWindow, temporalPolicy: policy,
        });
        if (exaRes.error) {
            console.warn(`[Search] Exa fallback also failed: ${exaRes.error}`);
            return { observations: [], candidates: [] };
        }
        searchRes = exaRes;
        provider = 'Exa Fallback';
        sourceType = 'exa';
    }

    let allResults = searchRes.results.slice(0, budget().searchResultsPerQuery);

    // ── Exa as a COMPLEMENT, not just a failover ─────────────────────────────────
    // Tier queries also run against Exa's semantic index. Tavily is keyword-ranked
    // inside a fixed domain allowlist; Exa retrieves by meaning across the whole
    // academic/PDF web. For research and analyst material the two disagree often
    // enough that running only one leaves real sources unfound.
    if (tier && sourceType === 'tavily') {
        const category = exaCategoryForTier(tier);
        const exaAug = await fetchExaSearch(query, {
            max_results: TIER_EXA_RESULTS,
            // The augmentation inherits the query's window. A tier query planned as
            // 12-month context must not be complemented by an unbounded neural sweep.
            retrievalWindow,
            temporalPolicy: policy,
            // The allowlist applies to Exa too. This used to pass null whenever the tier
            // had a category, on the theory that "category already scopes it" — but an Exa
            // category scopes the KIND of document, not the publisher, so a tier query ran
            // unbounded across the whole academic and code web. That is where doi.org came
            // from in a logistics brief: it is in no allowlist in this repo and could not
            // have arrived any other way. A tier IS its allowlist; a tier query that
            // ignores it is no longer that tier.
            includeDomains,
            category,
        });

        if (!exaAug.error && exaAug.results.length) {
            const seen = new Set(allResults.map(r => String(r.url || '').replace(/\/+$/, '')));
            const fresh = exaAug.results.filter(r => {
                const key = String(r.url || '').replace(/\/+$/, '');
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            if (fresh.length) {
                allResults = [...allResults, ...fresh.map(r => ({ ...r, _fromExaTier: true }))];
                console.log(`[Search] +${fresh.length} Exa ${category || 'neural'} results for tier:${tier}`);
            }
        }
    }

    console.log(`[Search] (${topic}/${retrievalWindow}${tier ? `/tier:${tier}` : ''}) "${query.substring(0, 60)}" → ${allResults.length} results via ${provider}`);

    if (allResults.length === 0) {
        console.warn(`⚠️ Query "${query}" returned 0 results`);
        return { observations: [], candidates: [] };
    }

    const observations = allResults.map((r) => ({
        job: query,
        theme,
        source: provider,
        source_type: sourceType,
        // What KIND of evidence this is. Only tier queries can say — an untiered general
        // search returns whatever the open web had, and guessing a class for it would be
        // exactly the confident-but-wrong label the date rule exists to prevent.
        source_class: sourceClass,
        data: `TITLE: ${r.title}\nURL: ${r.url}\nCONTENT: ${r.raw_content || r.content}`,
        url: r.url,
        title: r.title,
        published_date: r.published_date || null,
        // Which window we ASKED under. This is metadata about the request, never a claim
        // about when the thing happened — a provider that ignores a date window still
        // returns rows, and this is what lets us tell that afterwards instead of assuming
        // the window held.
        retrieval_window: retrievalWindow,
        retrieval_start_date: dateWindowParams('general', retrievalWindow, policy).start_date || null,
        score: r.score ?? null
    }));

    // The top DEEP_READ_CANDIDATES_PER_QUERY results are eligible, not just the first.
    // Final selection is still global and deterministic (see selectDeepReadTargets), so
    // widening the pool changes which pages win on merit, not how many get read.
    const candidates = allResults
        .slice(0, DEEP_READ_CANDIDATES_PER_QUERY)
        .filter(r => r?.url && !shouldSkipDeepReadUrl(r.url))
        .map((r, rank) => ({
            url: r.url,
            title: r.title || '',
            theme,
            tier,
            sourceClass,
            query,
            score: r.score ?? 0,
            rank,
            queryIdx,
            published_date: r.published_date || null,
            // Transient: what the Jev deep-read question is asked about. stepSearch strips it
            // before the candidate is checkpointed, so step state carries only the score.
            snippet: String(r.content || '').slice(0, MAX_SNIPPET_CHARS)
        }));

    // Reported so stepSearch can see how the run as a whole was served. A per-query
    // fallback is routine; every query falling back is an outage, and only the caller
    // holding all the queries can tell those apart.
    return { observations, candidates, sourceType };
}

/**
 * The observation a deep read produces, or null when the page yielded too little to use.
 * Pure, so the fields that cross into Postgres and back are testable without a network call.
 */
export function deepReadObservation({ url, title, theme, query, sourceClass = null, published_date = null }, extract) {
    if (!extract || String(extract.text || '').length <= 500) return null;
    return {
        job: query || title || url,
        theme,
        source: 'Deep Web Reader',
        // The extractor that actually served this page, not a hardcoded guess. fetchPageExtract
        // names the provider ('parallel_ai' | 'exa'); an Exa read is stored as 'exa_extract'
        // (v27) because plain 'exa' already means an Exa SEARCH result, and a deep read that
        // reads back as a search row is compressed and deduped like one. The static scan in
        // observation-source-types.test.mjs cannot check a computed value; both are permitted.
        source_type: extract.source === 'exa' ? 'exa_extract' : extract.source,
        // Reading a page in full does not change what kind of source it is.
        source_class: sourceClass,
        data: extract.text.substring(0, 15000),
        url,
        // Prefer the search result's title, but take the extractor's when the candidate
        // arrived without one — a deep read is often the only place a title exists.
        title: title || extract.title || null,
        // The deep read replaces its search result in analysis (planAnalyzeBatches), so it
        // must not arrive knowing less than that row did. Extractors often find no date on a
        // page the search index had dated.
        published_date: extract.publishDate || published_date || null,
        isDeepRead: true
    };
}

/** Extract one candidate into a deep-read observation, or null if it yielded nothing. */
async function deepReadUrl(candidate) {
    try {
        return deepReadObservation(candidate, await fetchPageExtract(candidate.url));
    } catch {
        console.warn('Deep read failed for', candidate.url);
        return null;
    }
}

/**
 * Choose which pages to deep-read, deterministically.
 *
 * Sort key is total: long-form priority desc, relevance desc, then originating query
 * index, then URL. Two runs over the same candidate set always select the same pages
 * regardless of how the concurrent searches interleaved.
 */

/** True for URLs whose payload is a document rather than a web page. */
const isDocumentUrl = (url) => /\.pdf($|[?#])/i.test(String(url || ''));

/**
 * Long-form sources rank ahead of equally-relevant news pages.
 *
 * A news article's snippet usually *is* the article — reading it in full adds little. A
 * report, paper or PDF hides its substance behind an abstract or landing page, so the
 * full read is where the value is. Search relevance alone doesn't capture that, and
 * without this the higher read budget would just buy more news pages.
 */
function deepReadPriority(candidate) {
    if (isDocumentUrl(candidate.url)) return 3;
    // A review page is the extreme case of the rule above: its snippet is the star
    // rating and the first sentence of one review, which carries no reason. Everything
    // worth having — why buyers switched, which feature broke, what they moved to — is
    // below the fold. Unread, this tier contributes almost nothing.
    if (candidate.tier === 'reviews') return 2;
    if (candidate.tier) return 1;
    return 0;
}

/**
 * `useJev` adds Jev's deep-read score as the second key, after long-form priority and before
 * search relevance: priority encodes what KIND of page hides its substance, Jev whether THIS
 * page's substance matters to this company. An unscored candidate ranks as neutral. Off by
 * default — the key is only applied when JEV_DEEP_READS=on.
 */
export function selectDeepReadTargets(candidates, limit = MAX_DEEP_READS_PER_RUN, { useJev = false } = {}) {
    const byUrl = new Map();
    for (const c of candidates) {
        const existing = byUrl.get(c.url);
        if (!existing || (c.score ?? 0) > (existing.score ?? 0)) byUrl.set(c.url, c);
    }

    const ordered = [...byUrl.values()].sort((a, b) =>
        deepReadPriority(b) - deepReadPriority(a) ||
        (useJev ? rankFraction(b.jevScore) - rankFraction(a.jevScore) : 0) ||
        (b.score ?? 0) - (a.score ?? 0) ||
        (a.queryIdx ?? 0) - (b.queryIdx ?? 0) ||
        a.url.localeCompare(b.url)
    );

    // Cap per originating query so one productive query can't consume the whole budget —
    // now that three results per query are eligible, the top query could otherwise take
    // every slot and collapse source diversity.
    const perQuery = new Map();
    const picked = [];
    for (const c of ordered) {
        if (picked.length >= limit) break;
        const used = perQuery.get(c.queryIdx) ?? 0;
        if (used >= DEEP_READ_PER_QUERY_CAP) continue;
        perQuery.set(c.queryIdx, used + 1);
        picked.push(c);
    }

    // If diversity capping left the budget unspent (few queries returned anything),
    // backfill in the same deterministic order rather than wasting the reads.
    if (picked.length < limit) {
        const chosen = new Set(picked.map(c => c.url));
        for (const c of ordered) {
            if (picked.length >= limit) break;
            if (!chosen.has(c.url)) picked.push(c);
        }
    }

    return picked;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXPORTED: LinkedIn Context
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Normalize a founder-supplied LinkedIn value (which may be a bare slug like "acme",
// a partial "linkedin.com/company/acme", or a full URL) into a scrapeable https URL.
function normalizeLinkedInUrl(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    if (!s) return null;
    if (!/linkedin\.com/i.test(s)) {
        s = `linkedin.com/company/${s.replace(/^\/+/, '')}`;
    }
    if (!/^https?:\/\//i.test(s)) {
        s = `https://${s.replace(/^\/+/, '')}`;
    }
    return s;
}

/**
 * Does this extract look like a login wall rather than the page we asked for?
 *
 * The only guard on a scrape used to be `length > 200`, which measures volume, not signal.
 * LinkedIn's auth interstitial is tens of thousands of characters of navigation, locale
 * switcher and directory links — it passes a length check comfortably, and then takes a
 * RESERVED seat in the context window ahead of the company's own site.
 */
function looksLikeAuthWall(text) {
    const head = String(text || '').slice(0, 4000).toLowerCase();
    if (!head) return true;
    const markers = [
        'sign in to see', 'join linkedin', 'sign up to see', 'log in to continue',
        'create your free account', 'please enable javascript', 'access denied',
        'you must log in to continue', 'verify you are a human', 'unusual traffic',
    ];
    return markers.some(m => head.includes(m));
}

async function fetchLinkedInContext(companyName, linkedinUrl = null) {
    // Prefer the founder-provided LinkedIn URL — scrape it directly before falling back to search.
    const providedUrl = normalizeLinkedInUrl(linkedinUrl);
    if (providedUrl) {
        try {
            console.log(`Scraping founder-provided LinkedIn: ${providedUrl}`);
            const direct = (await fetchPageExtract(providedUrl))?.text;
            if (direct && direct.length > 200 && !looksLikeAuthWall(direct)) {
                console.log(`✅ LinkedIn direct scrape: ${direct.length} chars`);
                return direct;
            }
            if (direct && looksLikeAuthWall(direct)) {
                console.warn(`⚠️ LinkedIn returned a login wall (${direct.length} chars of boilerplate); falling back to name search.`);
            }
            console.warn('Founder LinkedIn scrape returned thin content; falling back to name search.');
        } catch (scrapeErr) {
            console.warn(`Founder LinkedIn scrape failed (${scrapeErr.message}); falling back to name search.`);
        }
    }
    try {
        const searchQuery = `"${companyName}" site:linkedin.com/company`;
        // Unbounded for the same reason as getDeepContextData: a LinkedIn company page is
        // undated, and a date window on topic 'general' would filter it straight out.
        const searchRes = await fetchTavilySearch(searchQuery, { search_depth: 'advanced', max_results: 5 });

        const publicSnippets = (searchRes.results || [])
            .filter(r => r.content && r.content.length > 100)
            .map(r => r.content)
            .join('\n\n');

        const linkedinUrl = searchRes.results.find(r =>
            r.url.includes('linkedin.com/company')
        )?.url;

        if (!linkedinUrl) {
            console.log(`No LinkedIn page found for ${companyName}, using public search snippets`);
            return publicSnippets || null;
        }

        console.log(`Found LinkedIn: ${linkedinUrl}`);
        try {
            const linkedinContent = (await fetchPageExtract(linkedinUrl))?.text;
            if (linkedinContent && linkedinContent.length > 200 && !looksLikeAuthWall(linkedinContent)) {
                return linkedinContent;
            }
        } catch (scrapeErr) {
            console.warn(`Page extract failed on LinkedIn (${scrapeErr.message}), using public search snippets`);
        }

        return publicSnippets || null;
    } catch (e) {
        console.warn("LinkedIn enrichment failed:", e);
        return null;
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXPORTED: Validate context readiness
// Used both as a quality gate for LLM escalation (buildInitialContext) and as a
// pre-submit gate in the UI. Returns { ok, warnings[], blockers[] }.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function validateContextReadiness(context) {
    const warnings = [];
    const blockers = [];

    if (!context || typeof context !== 'object') {
        return { ok: false, warnings, blockers: ['Context could not be built from the provided sources.'] };
    }

    // Company name must resolve to something real (not the "Unknown" sentinel).
    const name = String(context.company_name || '').trim();
    if (!name || name.toLowerCase() === 'unknown') {
        blockers.push('Company name could not be resolved from the website.');
    }

    // Strategic anchors — missing or fallback shell means degraded context.
    if (!context.strategic_anchors || typeof context.strategic_anchors !== 'object') {
        blockers.push('Strategic context (anchors) is missing.');
    } else if (context.strategic_anchors.confidence === 'inferred-fallback') {
        blockers.push('Strategic context is incomplete (fallback data) — the analysis would be low quality.');
    }

    // Competitors drive the competitive-signal lens.
    const competitors = Array.isArray(context.key_competitors) ? context.key_competitors : [];
    if (competitors.length === 0) {
        blockers.push('No competitors were identified — the report would lack competitive signals.');
    } else if (competitors.length < 3) {
        warnings.push(`Only ${competitors.length} competitor(s) identified — consider adding more for richer analysis.`);
    }

    // Geography sharpens competitor/market targeting.
    if (!String(context.operating_geography || '').trim()) {
        warnings.push('Operating geography is missing — competitor and market targeting may be less precise.');
    }

    if (String(context.overall_confidence || '').toLowerCase() === 'low') {
        warnings.push('The model reported LOW confidence in the inferred context.');
    }

    // Structured signal layer only exists once onboarding inputs are attached.
    if (context._onboardingData && !context._startupContext) {
        warnings.push('Structured signal weighting could not be derived from your onboarding inputs.');
    }

    return { ok: blockers.length === 0, warnings, blockers };
}

/** Turn founder text into a reviewable decision frame. */
export async function buildDecisionFrame(rawText, context = {}) {
    const fallback = buildFallbackDecisionFrame(rawText, context);
    try {
        const result = await callLLMWithRetry('frameDecision', {
            rawText: String(rawText || '').slice(0, 6000),
            context: {
                company_name: context.company_name,
                industry: context.industry,
                operating_geography: context.operating_geography,
                customer_segments: context.customer_segments,
                strategic_anchors: context.strategic_anchors,
            }
        }, 1);
        return validateDecisionFrame(normalizeDecisionFrame({ ...result, id: context._decision?.id || fallback.id }, rawText)).frame;
    } catch (error) {
        console.warn('[Decision] Framing fell back to deterministic interpretation:', error.message);
        return fallback;
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXPORTED: Build Initial Context
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function buildInitialContext(websiteUrl, linkedinUrl, onProgress, uploadedDocText = null) {
    onProgress?.('Deploying Deep Web Reader (Multi-Page)...');

    const { text: rawText, ownSiteText, source, resultCount } = await getDeepContextData(websiteUrl, onProgress);

    // Extract company name — prefer the company's OWN site, which actually opens with its
    // name, over third-party search results, which open with the publisher's chrome.
    let companyName = 'Unknown';
    const firstLines = (ownSiteText || rawText).split('\n').filter(l => l.trim().length > 3).slice(0, 5);
    for (const line of firstLines) {
        const cleanLine = line.replace(/!\[.*?\]\(.*?\)/g, '').replace(/\[|\]/g, '').trim();
        if (cleanLine.length > 2 && !cleanLine.startsWith('http') && !cleanLine.startsWith('#')) {
            companyName = cleanLine.substring(0, 100);
            break;
        }
    }
    if (companyName === 'Unknown') {
        // Fallback: extract from URL
        try { companyName = new URL(websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl).hostname.replace('www.', '').split('.')[0]; } catch (e) { /* keep Unknown */ }
    }

    onProgress?.('Enriching from public LinkedIn data...');
    let linkedinText = null;
    try {
        linkedinText = await fetchLinkedInContext(companyName, linkedinUrl);
        if (linkedinText) {
            console.log(`✅ LinkedIn enrichment: ${linkedinText.length} chars`);
        } else {
            console.log('⚠️ No LinkedIn data available');
        }
    } catch (e) {
        console.warn('LinkedIn enrichment skipped:', e.message);
    }

    // Per-source budgets, not one truncate over a concatenated blob.
    //
    // Previously all three sources were joined website-first and the result cut at
    // CONTEXT_INPUT_CHAR_LIMIT — so a long site scrape could silently evict the founder's
    // uploaded document entirely, discarding the only internal data we have. Each source
    // now gets a guaranteed share, and the document goes first: internal truth outranks
    // marketing copy when the model builds context.
    const sourceParts = [];
    if (uploadedDocText) {
        sourceParts.push({
            label: `━━━ UPLOADED DOCUMENT (Internal — highest trust) ━━━`,
            text: uploadedDocText,
            budget: DOC_RESERVED_CHARS,
        });
    }
    // The company's own site, labelled as first-party — because it is.
    if (ownSiteText) {
        sourceParts.push({
            label: '━━━ COMPANY WEBSITE (First-party — the company\'s own words) ━━━',
            text: ownSiteText,
            budget: OWN_SITE_RESERVED_CHARS,
        });
    }
    // Third-party pages ABOUT the company. Labelled for what they are: these are search
    // results — directory listings, funding databases, press — and presenting them under a
    // "COMPANY WEBSITE" header told the model that a Tracxn row was the company speaking.
    // A provenance label that can be wrong is worse than none; the same principle that
    // keeps source_class resolved from observations rather than asked of the model.
    sourceParts.push({
        label: `━━━ WEB RESEARCH (${resultCount} third-party sources) ━━━`,
        text: rawText,
        budget: Infinity, // absorbs whatever the reserved sources leave behind
    });
    if (linkedinText) {
        sourceParts.push({
            label: '━━━ LINKEDIN (Public Profile) ━━━',
            text: linkedinText,
            budget: LINKEDIN_RESERVED_CHARS,
        });
    }

    const { text: enrichedText, totalChars } = packSources(sourceParts, CONTEXT_INPUT_CHAR_LIMIT);

    const sourceCount = sourceParts.length;
    console.log(`✅ Fused Context: ${sourceCount} sources, ${resultCount} web results, own-site ${ownSiteText ? `${ownSiteText.length} chars` : 'UNAVAILABLE'}, ${enrichedText.length}/${totalChars} chars`);
    if (uploadedDocText) {
        const kept = enrichedText.includes(uploadedDocText.slice(0, 200));
        console.log(`   └─ uploaded document: ${uploadedDocText.length} chars available, ${kept ? 'present' : 'TRUNCATED'} in context`);
    }

    await new Promise(r => setTimeout(r, 2000));

    onProgress?.(`Neural Engine analyzing ${sourceCount} data sources (${resultCount} web results)...`);
    let context = await callLLMWithRetry('buildContext', { url: websiteUrl, linkedin: linkedinUrl, rawText: enrichedText });

    // Handle array response
    if (Array.isArray(context) && context.length > 0) {
        console.log('📦 Unwrapping array response from Gemini');
        context = context[0];
    }

    // ═══ QUALITY-GATED ESCALATION ═══
    // Context is the highest-leverage LLM call. If the primary (cheap/fast) model returns a
    // thin/incomplete read, escalate ONCE to a stronger model BEFORE degrading to a shell.
    // We only swap in the escalated result if it is strictly better (fewer blockers).
    const primaryReadiness = validateContextReadiness(context);
    if (!primaryReadiness.ok && CONTEXT_ESCALATION_PROVIDER && CONTEXT_ESCALATION_PROVIDER !== 'none') {
        console.warn(`[Context] Primary read weak (${primaryReadiness.blockers.join('; ')}). Escalating to ${CONTEXT_ESCALATION_PROVIDER}.`);
        onProgress?.('Context looks thin — escalating to a stronger model...');
        try {
            let escalated = await callLLMWithRetry(
                'buildContext',
                { url: websiteUrl, linkedin: linkedinUrl, rawText: enrichedText },
                1,
                CONTEXT_ESCALATION_PROVIDER
            );
            if (Array.isArray(escalated) && escalated.length > 0) escalated = escalated[0];
            const escalatedReadiness = validateContextReadiness(escalated);
            if (escalated && typeof escalated === 'object' &&
                escalatedReadiness.blockers.length < primaryReadiness.blockers.length) {
                console.log(`[Context] Escalation improved context (${primaryReadiness.blockers.length} → ${escalatedReadiness.blockers.length} blockers).`);
                context = escalated;
            } else {
                console.log('[Context] Escalation did not improve context; keeping primary result.');
            }
        } catch (escErr) {
            console.warn(`[Context] Escalation failed (${escErr.message}); keeping primary result.`);
        }
    }

    // Ensure context is a valid object
    if (!context || typeof context !== 'object') {
        console.warn('⚠️ Gemini returned non-object context. Creating structural shell...');
        context = { _rawContext: String(context) };
    }

    // Reconstruct strategic_anchors if missing
    if (!context.strategic_anchors) {
        console.warn('⚠️ Reconstructing missing strategic_anchors from root properties...');
        context.strategic_anchors = {
            operational_reality: context.operational_reality || context.industry || 'Unknown reality',
            narrative_lens: context.narrative_lens || 'Unknown narrative',
            leadership_tone: context.leadership_tone || { style: 'neutral', evidence: 'Not provided' },
            current_optimization: context.current_optimization || { focus: 'growth', evidence: 'Not provided' },
            buyer_type: context.buyer_type || 'Unknown buyer',
            positioning: context.positioning || 'Unknown positioning',
            confidence: 'inferred-fallback'
        };
    } else {
        context.strategic_anchors.confidence = 'inferred';
    }

    // Preserve the company URL on the context so downstream steps can use it.
    // stepDiscoverCompetitors' Exa findSimilar peer-discovery path is gated on
    // context.website_url; without this it stays undefined and discovery silently
    // degrades to weak Tavily keyword search.
    if (websiteUrl && !context.website_url) {
        context.website_url = /^https?:\/\//i.test(websiteUrl) ? websiteUrl : `https://${websiteUrl}`;
    }

    console.log('✅ Context built:', Object.keys(context).join(', '));

    // Filter out low-confidence competitors (< 40) before they pollute queries
    if (Array.isArray(context.key_competitors)) {
        const before = context.key_competitors.length;
        context.key_competitors = context.key_competitors.filter(c => {
            const conf = typeof c === 'object' ? (c.competitor_confidence ?? 70) : 70;
            return conf >= 40;
        });
        if (context.key_competitors.length < before) {
            console.log(`[Context] Filtered ${before - context.key_competitors.length} low-confidence competitors. Remaining: ${context.key_competitors.length}`);
        }
    }

    // Attach source documents for downstream grounded Q&A
    context._sourceDocuments = {
        website: String(rawText || '').slice(0, 30000),
        linkedin: linkedinText ? String(linkedinText).slice(0, 10000) : null,
        uploadedDoc: uploadedDocText ? String(uploadedDocText).slice(0, 20000) : null,
    };

    // Baseline provenance for every tracked fact this build actually produced. Fair to
    // blanket-stamp here (unlike a merge, which stamps only what it individually confirms):
    // this whole object was just read from live sources a moment ago. No single source_url
    // — the model read website + web research + LinkedIn + any uploaded doc as one blob, so
    // attributing a fact to one of them would be a claim the build has no way to support.
    context._factProvenance = stampBuildProvenance(context);

    // NOTE: the structured signal layer (exposure weights → entity watchlist → signal weights)
    // is built AFTER onboarding via enrichContextWithOnboarding(), because it depends on the
    // founder's Sensitivity Snapshot + Market Bets, which are collected in the next phase.
    // (Previously this ran here with context._onboardingData, which is always null pre-onboarding.)
    return context;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXPORTED: Fold NEW sources into a context that already exists
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Compact digest of an existing context, for the merge prompt's "what we already believe". */
export function summarizeContextForMerge(context) {
    const c = context || {};
    const anchor = (a) => (a && typeof a === 'object' ? (a.style || a.focus || a.stance || a.primary || '') : (a || ''));
    const sa = c.strategic_anchors || {};
    const lines = [
        `Company: ${c.company_name || 'unknown'}`,
        `Industry: ${c.industry || 'unknown'}`,
        `Geography: ${c.operating_geography || 'unknown'}`,
        `Operational reality: ${anchor(sa.operational_reality)}`,
        `Positioning: ${anchor(sa.positioning)}`,
        `Buyer type: ${anchor(sa.buyer_type)}`,
        `Known competitors: ${(c.key_competitors || []).map(x => (typeof x === 'object' ? x.name : x)).filter(Boolean).join(', ') || 'none'}`,
        `Customer segments: ${(c.customer_segments || []).map(x => (typeof x === 'object' ? x.name : x)).filter(Boolean).join(', ') || 'none'}`,
        `Funding stage: ${c.company_dna?.funding_stage || 'unknown'}`,
        `Team size: ${c.company_dna?.team_size || 'unknown'}`,
    ];
    return lines.join('\n');
}

const nameOf = (x) => String((x && typeof x === 'object' ? x.name : x) || '').trim();
const keyOf = (x) => nameOf(x).toLowerCase();

/**
 * Apply a merge patch to a context, deterministically, honouring the founder's corrections.
 *
 * The model proposes; this function disposes. Two rules, and they are the whole reason
 * mergeContext returns a patch rather than a context:
 *
 *   - an `update` to a field the founder edited by hand is DROPPED. They already told us
 *     what it should say; a page found later does not outrank that.
 *   - an `addition` naming an entity the founder deleted is DROPPED. Re-adding it is how a
 *     correction silently fails to stick.
 *
 * Everything dropped is reported in `_rejected` so the UI can say so out loud, rather than
 * quietly disagreeing with the person who made the correction.
 *
 * Pure: returns a new context and a receipt, mutating neither argument.
 */
export function applyContextPatch(context, patch, userEdits = {}) {
    const next = { ...(context || {}) };
    const p = patch || {};
    const editedFields = new Set((userEdits.fields || []).map(f => String(f)));
    const removedNames = new Set((userEdits.removed || []).map(n => String(n).toLowerCase().trim()));

    const rejected = { updates: [], additions: [] };
    const applied = { updates: [], additions: 0 };

    // Every fact this patch actually confirms, for the provenance ledger below. Populated
    // only by ACCEPTED updates/additions — a rejected one (no quote, or the founder already
    // corrected it) must not touch the ledger, or a dropped update would still look
    // "just confirmed" to describeContextStaleness.
    const touches = []; // { key, sourceUrl, confidence }

    // ── updates ────────────────────────────────────────────────────────────
    for (const u of p.updates || []) {
        const field = String(u?.field || '');
        if (!field) continue;
        // Quote-or-drop, the same bar documentIntelService holds: a claim with no verbatim
        // support from the new sources is not evidence, it is the model's prior.
        if (!u.evidence_quote || !String(u.evidence_quote).trim()) {
            rejected.updates.push({ field, reason: 'no evidence quote' });
            continue;
        }
        if (editedFields.has(field)) {
            rejected.updates.push({ field, reason: 'you corrected this field', new_value: u.new_value });
            continue;
        }
        const path = field.split('.');
        let cursor = next;
        for (let i = 0; i < path.length - 1; i++) {
            cursor[path[i]] = { ...(cursor[path[i]] || {}) };
            cursor = cursor[path[i]];
        }
        cursor[path[path.length - 1]] = u.new_value;
        applied.updates.push(field);
        touches.push({
            key: field,
            sourceUrl: typeof u.source_url === 'string' ? u.source_url : null,
            confidence: typeof u.confidence === 'number' ? u.confidence : null,
        });
    }

    // ── additions ──────────────────────────────────────────────────────────
    const addList = (existing, incoming, pathForProvenance) => {
        const out = Array.isArray(existing) ? [...existing] : [];
        const seen = new Set(out.map(keyOf).filter(Boolean));
        for (const item of incoming || []) {
            const key = keyOf(item);
            if (!key) continue;
            if (removedNames.has(key)) {
                rejected.additions.push({ name: nameOf(item), reason: 'you removed this' });
                continue;
            }
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ ...(typeof item === 'object' ? item : { name: item }), source: 'added_source' });
            applied.additions++;
            touches.push({
                key: `${pathForProvenance}:${key}`,
                sourceUrl: typeof item?.source_url === 'string' ? item.source_url : null,
                confidence: typeof item?.confidence === 'number' ? item.confidence : null,
            });
        }
        return out;
    };

    const additions = p.additions || {};
    if (additions.key_competitors) next.key_competitors = addList(next.key_competitors, additions.key_competitors, 'key_competitors');
    if (additions.customer_segments) next.customer_segments = addList(next.customer_segments, additions.customer_segments, 'customer_segments');
    if (additions.dependency_map && typeof additions.dependency_map === 'object') {
        const dep = { ...(next.dependency_map || {}) };
        for (const [bucket, values] of Object.entries(additions.dependency_map)) {
            const before = new Set(dep[bucket] || []);
            const merged = new Set([...before, ...(values || [])].map(v => String(v).trim()).filter(Boolean));
            dep[bucket] = [...merged];
            // Only the genuinely new values were "just confirmed" — values already present
            // were not reconfirmed by this merge, so leave their existing stamp untouched.
            for (const v of merged) {
                if (!before.has(v)) touches.push({ key: `dependency_map.${bucket}:${v.toLowerCase()}`, sourceUrl: null, confidence: null });
            }
        }
        next.dependency_map = dep;
    }

    // ── provenance ledger ─────────────────────────────────────────────────
    // as_of is this function's own clock, always — never anything read from the patch. A
    // patch that claimed its own date would be exactly the thing promptUtils.js's "never let
    // the model supply a date" rule exists to forbid, applied to context instead of signals.
    if (touches.length > 0) {
        const asOf = new Date().toISOString();
        const provenance = { ...(context?._factProvenance || {}) };
        for (const t of touches) {
            provenance[t.key] = { as_of: asOf, source_url: t.sourceUrl, confidence: t.confidence };
        }
        next._factProvenance = provenance;
    }

    return {
        context: next,
        receipt: {
            applied,
            rejected,
            conflicts: p.conflicts || [],
            summary: p.summary || '',
        },
    };
}

/**
 * Read ONLY the newly-supplied sources and fold what they say into an existing context.
 *
 * Deliberately not buildInitialContext: no Tavily searches, no LinkedIn re-fetch, no
 * multi-page crawl of the company site. Scraping N named pages plus one small merge call is
 * roughly an order of magnitude cheaper than a rebuild, and it is the only path that can
 * add new evidence without discarding the founder's corrections.
 */
export async function enrichStoredContext({ storedContext, newUrls = [], newDocText = null, onProgress }) {
    const urls = [...new Set((newUrls || []).map(u => String(u || '').trim()).filter(Boolean))].slice(0, MAX_ADDED_SOURCE_URLS);

    onProgress?.(`Reading ${urls.length} new source${urls.length === 1 ? '' : 's'}...`);
    const extracts = await Promise.all(urls.map(async (url) => {
        const page = await fetchPageExtract(url).catch(() => null);
        return page?.text ? { url, text: page.text, capturedAt: new Date().toISOString() } : null;
    }));
    const pages = extracts.filter(Boolean);

    if (pages.length === 0 && !newDocText) {
        return { context: storedContext, receipt: { applied: { updates: [], additions: 0 }, rejected: { updates: [], additions: [] }, conflicts: [], summary: 'No new sources could be read.' }, pages: [] };
    }

    // The stored context's own digest is bounded and deliberately excludes
    // _sourceDocuments: at 30k chars of prior website text it would evict the very sources
    // this call exists to read, which is the failure context-assembly.test.mjs was written for.
    const sourceParts = [];
    if (newDocText) {
        sourceParts.push({
            label: '━━━ NEW UPLOADED DOCUMENT (Internal — highest trust) ━━━',
            text: newDocText,
            budget: DOC_RESERVED_CHARS,
        });
    }
    for (const page of pages) {
        sourceParts.push({
            label: `━━━ NEW SOURCE: ${page.url} ━━━`,
            text: page.text,
            budget: Infinity,
        });
    }

    const { text: newSourceText } = packSources(sourceParts, MERGE_INPUT_CHAR_LIMIT);

    onProgress?.('Folding the new sources into your context...');
    const patch = await callLLMWithRetry('mergeContext', {
        existingSummary: summarizeContextForMerge(storedContext),
        newSourceText,
        protectedFields: storedContext?._userEdits?.fields || [],
    });

    const { context: merged, receipt } = applyContextPatch(storedContext, patch, storedContext?._userEdits || {});

    // Append, never overwrite: grounded Q&A keeps the original website/LinkedIn text and
    // gains the new material alongside it.
    merged._sourceDocuments = {
        ...(storedContext?._sourceDocuments || {}),
        addedSources: [
            ...((storedContext?._sourceDocuments?.addedSources) || []),
            ...pages.map(p => ({ url: p.url, text: String(p.text).slice(0, 20000), capturedAt: p.capturedAt })),
        ],
    };
    if (newDocText) {
        merged._sourceDocuments.uploadedDoc = [
            storedContext?._sourceDocuments?.uploadedDoc || '',
            String(newDocText).slice(0, 20000),
        ].filter(Boolean).join('\n\n');
    }

    return { context: merged, receipt, pages };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXPORTED: Enrich context with founder onboarding inputs (structured signal layer)
// Runs AFTER onboarding so the founder's Sensitivity Snapshot + Market Bets actually drive
// exposure weights → entity watchlist → deterministic query allocation on the FIRST run.
// Deterministic / LLM-free — safe to call synchronously in the client flow. Non-blocking.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/**
 * Merge verified document intel into the startup context's competitive and dependency
 * maps, in place.
 *
 * Doc entities are prepended and tagged `source: 'internal_doc'` — the tag is what earns
 * them never-trimmed priority in generateEntityWatchlist() and a reserved slice of the
 * search budget in generateContextAwareQueries(). Duplicates already present from the
 * LLM-inferred context are re-tagged rather than added twice, so an entity the founder
 * named is treated as internally attested even when the model guessed it too.
 */
function mergeDocIntelIntoStartupContext(startupContext, docIntel) {
    if (!startupContext || !docIntel) return startupContext;

    const compMap = startupContext.competitive_map || (startupContext.competitive_map = {});
    const depMap = startupContext.dependency_map || (startupContext.dependency_map = {});

    const prepend = (list, incoming, decorate) => {
        const existing = Array.isArray(list) ? list : [];
        const seen = new Map(
            existing.map((e, i) => [String(typeof e === 'object' ? e.name : e || '').toLowerCase().trim(), i])
        );
        const added = [];

        for (const entity of incoming || []) {
            const name = String(entity?.name || '').trim();
            if (!name) continue;
            const key = name.toLowerCase();
            const at = seen.get(key);
            if (at !== undefined) {
                // Already known — promote it to internally-attested rather than duplicating.
                const current = existing[at];
                existing[at] = { ...(typeof current === 'object' ? current : { name }), source: 'internal_doc' };
                continue;
            }
            seen.set(key, existing.length + added.length);
            added.push(decorate(entity, name));
        }

        return [...added, ...existing];
    };

    compMap.named_competitors = prepend(compMap.named_competitors, docIntel.named_competitors, (e, name) => ({
        name,
        why_competitor: e.why_competitor || 'Named in the founder\'s own document',
        competitor_confidence: Math.max(80, Number(e.confidence) || 80), // internally attested
        source: 'internal_doc',
        evidence_quote: e.evidence_quote || null,
    }));

    const infra = (docIntel.vendors_infra || []).filter(v => v.category === 'infra');
    const platform = (docIntel.vendors_infra || []).filter(v => v.category !== 'infra');
    const asDependency = (e, name) => ({ name, source: 'internal_doc', evidence_quote: e.evidence_quote || null });

    depMap.infra_dependencies = prepend(depMap.infra_dependencies, infra, asDependency);
    depMap.platform_dependencies = prepend(depMap.platform_dependencies, platform, asDependency);
    depMap.regulatory_exposure = prepend(depMap.regulatory_exposure, docIntel.regulatory_exposure, asDependency);

    // Customers, investors and partners have no home in the pre-existing taxonomy; they
    // ride along on the startup context for generateEntityWatchlist to pick up.
    startupContext.internal_relationships = {
        customers: docIntel.named_customers || [],
        investors: docIntel.investors || [],
        partners: docIntel.partners_channels || [],
    };

    // The founder's own stated bets are stronger assumptions than anything re-typed into
    // the onboarding form, so they lead. Capped to keep the assumption set legible.
    const docBets = (docIntel.strategic_bets || []).map(b => ({
        statement: b.statement,
        domain: b.domain || 'Demand',
        sensitivity: 'High',
        source: 'internal_doc',
    }));
    if (docBets.length > 0) {
        startupContext.strategic_assumptions = [
            ...docBets,
            ...(startupContext.strategic_assumptions || []),
        ].slice(0, 8);
    }

    startupContext.document_vintage = docIntel._vintage || null;

    console.log(
        `[ContextBuilder] Merged internal-doc intel: ` +
        `${docIntel.named_competitors?.length || 0} competitors, ` +
        `${docIntel.named_customers?.length || 0} customers, ` +
        `${docIntel.investors?.length || 0} investors, ` +
        `${docIntel.vendors_infra?.length || 0} vendors, ` +
        `${docBets.length} bets`
    );

    return startupContext;
}

export function enrichContextWithOnboarding(context, onboardingData) {
    if (!context || typeof context !== 'object' || !onboardingData) return context;
    try {
        const startupContext = buildStartupContext({ onboardingData, autoInferred: context });

        // Fold verified document entities into the maps the watchlist is built from, so
        // the founder's own named competitors/customers/vendors reach query generation
        // instead of only the LLM's inferences. Prepended: entityWatchlistGenerator trims
        // at MAX_ENTITIES, and internal-doc entities must survive that cut.
        mergeDocIntelIntoStartupContext(startupContext, context._docIntel);
        context._startupContext = startupContext;

        const entities = generateEntityWatchlist(startupContext);
        context._trackedEntities = entities;
        context._primarySources = mapPrimarySources(entities);

        context._signalWeights = computeSignalWeights(
            startupContext.exposure_weights,
            startupContext.revenue_profile
        );

        console.log('✅ Structured context enriched from onboarding:', {
            version: startupContext.context_version_id,
            entities: entities.length,
            competitors: startupContext.competitive_map?.named_competitors?.length || 0,
            topCategories: getTopCategories(context._signalWeights, 3)
        });
    } catch (ctxErr) {
        console.warn('[ContextBuilder] enrichContextWithOnboarding failed (non-blocking):', ctxErr.message);
    }
    return context;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXPORTED: Run Signal Generation (MAIN PIPELINE)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PIPELINE STEPS
//
// The pipeline is a list of named steps over a serializable `state`. Two drivers:
//
//   • monolith  — runSignalGeneration() runs every step in one invocation (legacy path)
//   • stepped   — api/_intelligenceWorker.js runs ONE step per serverless invocation,
//                 checkpointing `state` into intelligence_jobs.step_outputs between them
//
// A step mutates `state` in place and returns nothing, or returns `{ defer: true }` to
// mean "I ran out of invocation budget mid-cursor; re-trigger me and I'll continue where
// my cursor left off". Only cursored steps (search, analyze, news) can defer.
//
// Raw observations deliberately never enter `state`: a run's raw text is ~0.5-1 MB and
// would be rewritten to Postgres on every invocation. They go to public.observations and
// are read back by the v6/analyze steps. See appendObservations/loadObservations.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SEARCH_WAVE_SIZE = 4;   // Tavily/Exa calls in flight per wave
const SEARCH_WAVE_BUDGET_MS = 12000;
// Jev scores a wave's deep-read candidates (≤12) after its searches return. A hard bound —
// decideEach resolves by it — so the wave budget can simply add it.
const JEV_WAVE_DEADLINE_MS = 3000;
// Reads all run concurrently, so this is bounded by the slowest scrape (Parallel's 20s
// extract timeout plus a possible Exa fallback), not by the number of reads. Raised
// alongside MAX_DEEP_READS_PER_RUN so the step doesn't defer forever on a slow source.
const DEEP_READ_BUDGET_MS = 22000;
const ANALYZE_BATCH_BUDGET_MS = 25000;
// Watched pages are fetched one at a time (each needs its predecessor's hash read back
// before the next decision), so this is the per-page cost times the run cap, not a
// concurrency bound. A single fetch inherits the scrape gateway's 20s Parallel timeout.
const SINGLE_WATCH_FETCH_MS = 8000;
const WATCH_BUDGET_MS = 20000;

// A 429 backoff sleep of 30s does not fit inside a 60s invocation alongside a 25s LLM
// batch, so the stepped driver would defer forever waiting for a budget that can never
// arrive. Cap it: crossing an invocation boundary already costs a re-trigger round trip,
// and the circuit breaker (3 consecutive 429s) is what actually stops the bleeding.
const STEPPED_MAX_BATCH_DELAY_MS = 5000;

// How many times stepVerify may defer waiting for a budget big enough to gap-fill. The
// defer moves no cursor, so it cannot be unbounded: one retry buys a fresh invocation
// with a full STEP_MAX_MS, and if that still isn't enough the budget is misconfigured.
const MAX_VERIFY_DEFERS = 1;
const MAX_WATCH_DEFERS = 1;
const MAX_COLLECT_DEFERS = 1;
// One connector round trip. The handler caps each upstream call at 15-25s; this is the
// slice the step must have left before starting another one.
const SINGLE_CONNECTOR_MS = 9000;

/** Fresh pipeline state. `context` is mutated in place by the early steps, as before. */
/**
 * The run's temporal policy — one clock reading, reused by every step.
 *
 * Read through this accessor rather than `state.temporalPolicy` directly. A stepped run
 * checkpoints between invocations and can resume hours later in a different process; a job
 * checkpointed before this field existed has no policy at all, and a step that recomputed
 * its own would classify the same evidence against a different boundary than the step
 * before it. That drift is exactly what a single per-run policy exists to prevent.
 */
function runPolicy(state) {
    if (!state) return buildTemporalPolicy();
    if (!state.temporalPolicy) state.temporalPolicy = buildTemporalPolicy();
    return state.temporalPolicy;
}

/**
 * Classify a run's signals and hang the surface projections off `state.analyze`.
 *
 * Called from every analyze path — the normal batches, the express lane and the
 * verification gap fill. A fast path that skipped this would publish signals no surface
 * had dated, which is precisely how the old behaviour leaked: whatever reached the
 * transformer got today's timestamp regardless of where it came from.
 *
 * `state.analyze.signals` is left exactly as it was found, because a dozen consumers read
 * it and the guarantee this whole feature rests on is that evidence is projected, never
 * removed. The projections are additive siblings.
 */
export function applyEvidencePackets(state, signals) {
    const packets = buildEvidencePackets({ signals, policy: runPolicy(state) });
    const a = state.analyze;

    // Normalised in place: same array contents, now carrying event_date/temporal_role and
    // the legacy `freshness` chip the cards already render.
    a.signals = packets.signals;
    a.currentSignals = packets.anchors;
    a.evidencePackets = packets;
    // Everything retained, including the context and historical material no anchor
    // claimed. This is what makes "nothing was deleted" checkable rather than asserted.
    a.internalEvidence = packets.signals;
    a.temporalCounts = packets.counts;

    const c = packets.counts;
    console.log(
        `[temporal] ${c.anchors} current anchor(s), ${c.supportingContext} supporting, `
        + `${c.historicalContext} historical, ${c.undated} undated `
        + `(${c.anchorsWithSupport} anchor(s) carry context) — all ${c.total} retained`
    );
    if (c.anchors === 0 && c.total > 0) {
        // Not a degradation: the run worked, and "nothing current was verified" is a real
        // finding. It has to reach the founder as a statement rather than as silence.
        console.log('[temporal] No current event verified this run; context is retained and will be labelled as such.');
    }
    return packets;
}

export function createPipelineState(contextJson, runId = generateRunId()) {
    return {
        runId,
        context: contextJson,
        // Built once, at run start, and checkpointed with the rest of the state. Plain
        // data, so it survives serialisation intact.
        temporalPolicy: buildTemporalPolicy(),
        memory: null,
        queries: null,
        search: null,
        watch: null,
        collect: null,
        v6: { patterns: [], shifts: [], blindSpots: [], opportunities: [], syntheticInterpretation: null },
        analyze: null,
        summary: null,
        decisionBrief: null,
        interpret: null,
        news: null,
        // Ledger of work the run could not complete. Nothing is allowed to be dropped
        // silently: every skip/truncation records here and travels into the report, so a
        // thinner brief is always visibly a partial one rather than a confident-looking
        // complete one. See recordDegradation().
        degradations: []
    };
}

/**
 * Record work the pipeline skipped or truncated.
 *
 * The stepped (cloud) driver defers cursored work and loses nothing, but work still goes
 * missing three ways: the monolith/browser driver breaks out of cursored loops when its
 * single shared budget runs low, non-cursored steps bail on canAfford(), and any step can
 * lose its output to a failed write or a failed provider call. All of it used to be a
 * console.warn — invisible to the founder reading the brief.
 *
 * Deliberately never throws: reporting a degradation must not itself break a run.
 */
export function recordDegradation(state, { step, reason, impact = null }) {
    try {
        if (!state) return;
        if (!Array.isArray(state.degradations)) state.degradations = [];
        state.degradations.push({
            step,
            reason,
            impact,
            at: new Date().toISOString()
        });
        console.warn(`[Pipeline] ⚠️ Degraded: ${step} — ${reason}${impact ? ` (${impact})` : ''}`);
    } catch {
        // never let bookkeeping break the pipeline
    }
}

/**
 * The founder-facing "what a full run would have resolved" list.
 *
 * Built from what this run ACTUALLY skipped rather than from a static blurb, so the
 * paywall copy cannot drift out of step with the pipeline. Empty for a full run, which is
 * what lets the UI render the same disclosure for both tiers with no CTA on the paid side.
 */
export function describeDepthGaps(state, ctx) {
    const tierName = ctx?.job?.runTier || DEFAULT_RUN_TIER;
    const skipped = new Set((state?.depthGaps || []).map(gap => gap.step));
    return depthGapsFor(tierName, {
        skippedWatch: skipped.has('watch'),
        skippedConnectors: skipped.has('collect'),
    });
}

/**
 * Record something a SHALLOW run deliberately did not do.
 *
 * ⚠️  Deliberately NOT recordDegradation. A degradation means the run tried and failed,
 * and the report surface banners it as "This brief is partial" — telling a free user
 * their report is broken when in fact they are looking at the product working exactly as
 * designed. A depth gap is a priced boundary, and it is the paywall copy: the honest
 * statement of what more evidence would buy.
 */
export function recordDepthGap(state, { step, skipped }) {
    try {
        if (!state) return;
        if (!Array.isArray(state.depthGaps)) state.depthGaps = [];
        state.depthGaps.push({ step, skipped, at: new Date().toISOString() });
        console.log(`[Pipeline] Depth: skipped ${step} — ${skipped}`);
    } catch {
        // never let bookkeeping break the pipeline
    }
}

/**
 * Write observations to public.observations (idempotent upsert on run_id+url+type).
 *
 * The monolith additionally keeps them in memory so a run without a client_id — and
 * therefore without a database to read back from — still works end to end.
 *
 * A storage failure never fails the run — the rest of the evidence still ships. But in the
 * stepped pipeline the analyze step reads observations back FROM Postgres, so anything not
 * written here is gone, and the run silently produces a thinner report. That is how the
 * Source Watch and connector evidence went missing between v20 and v22: the loss was real,
 * total, and visible only as a count in a log line nobody reads.
 *
 * So: non-blocking, but never invisible. A wholly failed write is recorded as a degradation,
 * which the founder sees disclosed on the report.
 *
 * @param {string} label - which step's evidence this is, for the disclosure
 */
async function appendObservations(state, ctx, observations, label = 'Evidence storage') {
    const rows = observations.filter(Boolean);
    if (rows.length === 0) return;

    if (ctx.job.clientId) {
        try {
            const result = await storeObservations({
                companyId: ctx.job.clientId,
                runId: state.runId,
                rawResults: rows
            });
            console.log(`[v6] Observations persisted: ${result.stored} stored, ${result.errors} errors`);

            // Partial loss matters too, but a total loss is the one that turns a step into
            // pure cost. Report the count either way; only the caller knows what it means.
            //
            // Stepped only: the monolith keeps these rows in memory (below) and analyzes
            // them regardless, so THIS report is unaffected by a failed write. Cross-run
            // pattern detection still loses them, but a degradation is a founder-facing
            // disclosure about the brief in front of them — not a general error channel.
            if (result.errors > 0 && ctx.stepped) {
                recordDegradation(state, {
                    step: label,
                    reason: result.stored === 0
                        ? `None of the ${rows.length} findings could be stored (${result.firstError || 'unknown error'}).`
                        : `${result.errors} of ${rows.length} findings could not be stored (${result.firstError || 'unknown error'}).`,
                    impact: result.stored === 0
                        ? 'This evidence is missing from the analysis below.'
                        : 'Part of this evidence is missing from the analysis below.'
                });
            }
        } catch (err) {
            console.warn('[v6] Observation storage failed (non-blocking):', err.message);
            if (ctx.stepped) {
                recordDegradation(state, {
                    step: label,
                    reason: `Findings could not be stored (${err.message}).`,
                    impact: 'This evidence is missing from the analysis below.'
                });
            }
        }
    }

    if (!ctx.stepped) {
        state._observations = [...(state._observations || []), ...rows];
    }
}

/** Read a run's observations back. In-memory in the monolith, from Postgres when stepped. */
async function loadObservations(state, ids = null) {
    if (state._observations) {
        if (!ids) return state._observations;
        const wanted = new Set(ids);
        return state._observations.filter(o => wanted.has(o.id));
    }
    return await getObservationsForRun(state.runId, ids);
}

// ─── context ──────────────────────────────────────────────────────────────
// Only runs when the job asked the server to build context. It parks the job for
// founder review rather than continuing: enrichContextWithOnboarding() needs the
// founder's onboarding answers, and without the fields it adds (_startupContext,
// _trackedEntities, _signalWeights) generate_queries falls off the deterministic path.

async function stepContext(state, ctx) {
    // Reuse a stored context here too. An admin re-running a company we already know was
    // paying for the full build — two advanced Tavily searches, a LinkedIn fetch and a
    // ~40k-token buildContext call — to re-derive what a founder had already reviewed and
    // corrected. The pause below means a human still sees it before anything runs, so this
    // is a saving, not a silent substitution.
    let stored = null;
    if (ctx.job.clientId && ctx.job.websiteUrl) {
        stored = await getCurrentCompanyContext(ctx.job.clientId, ctx.job.websiteUrl).catch(err => {
            console.warn('[Context] Stored-context lookup failed, building fresh:', err.message);
            return null;
        });
    }

    if (stored?.context) {
        // Phase 0 instrumentation: reuse vs full rebuild, and which store answered.
        console.log(`[ContextResolve] stepContext=reuse origin=${stored.origin} domain=${stored.targetDomain}`);
        ctx.onProgress?.(`Using the saved context for ${stored.targetDomain}.`);
        state.context = hydrateStoredContext(stored.context);
        // Provenance for stepPersist's server-side company_contexts write (v27): this run
        // reused what was on file rather than re-deriving it.
        state.contextOrigin = 'reused';
    } else {
        console.log(`[ContextResolve] stepContext=rebuild url=${ctx.job.websiteUrl} (~40k-token buildContext)`);
        state.context = await buildInitialContext(
            ctx.job.websiteUrl,
            ctx.job.linkedinUrl || null,
            ctx.onProgress,
            ctx.job.uploadedDocText || null
        );
        state.contextOrigin = 'built';

        // Carry forward the answers a previous run collected. An admin run has no
        // onboarding UI, so without this its context reaches stepMemory with no
        // _startupContext at all and generate_queries falls off the deterministic path —
        // the exact degradation the comment below describes, for a company whose answers
        // we already had on file.
        const priorOnboarding = stored?.context?._onboardingData || null;
        if (priorOnboarding) {
            state.context._onboardingData = priorOnboarding;
            state.context = enrichContextWithOnboarding(state.context, priorOnboarding);
        }
    }

    if (ctx.job.analysisMode === DECISION_MODE && ctx.job.decisionContext) {
        state.context._decision = normalizeDecisionFrame(ctx.job.decisionContext);
    }

    // The product's OWN stored context is authoritative — it was snapshotted from the
    // parent at confirm time and already carries _product. Re-reading it here rather
    // than trusting a blob on the job means there is one source of truth for what a
    // product is, not two that can drift. Normalized defensively: the row is trusted,
    // its shape is not.
    if (ctx.job.analysisMode === PRODUCT_MODE && ctx.job.targetId) {
        const productCtx = await getCurrentCompanyContext(
            ctx.job.clientId, ctx.job.websiteUrl, { targetId: ctx.job.targetId }
        ).catch(err => {
            console.warn('[Context] Product-context lookup failed, proceeding without it:', err.message);
            return null;
        });
        if (productCtx?.context) state.context = hydrateStoredContext(productCtx.context);
    }
    if (ctx.job.analysisMode === PRODUCT_MODE && ctx.job.targetId) {
        state.context._product = normalizeProductProfile(state.context._product || ctx.job.productContext);
    }

    // Defence in depth for the product-lens gate in stepGenerateQueries: `_product` is a
    // REUSABLE key (companyContextService.REUSABLE_KEYS), so it can reach state.context
    // through hydrateStoredContext(stored.context) above on a run that never asked for
    // product mode — reuse from a domain that also has a product target, a stale
    // ctx.job.productContext, etc. Enforce the invariant at this boundary rather than
    // trusting every upstream path to have already stripped it. This log firing in
    // production means a leak path still exists somewhere upstream and we want to know.
    if (ctx.job.analysisMode !== PRODUCT_MODE && state.context && state.context._product) {
        console.warn('[Context] Deleting unexpected _product from a non-product-mode run.');
        delete state.context._product;
    }

    // The review pause exists so a human can check the context — and, for a founder, supply
    // the onboarding answers enrichContextWithOnboarding() turns into deterministic-query
    // inputs. Admin runs pause too: ClientDetail renders the same review screen and resumes
    // the job, so an admin is no longer the one person who cannot see or correct what a run
    // is about to be built on.
    return { pause: 'awaiting_context_review' };
}

// ─── memory ───────────────────────────────────────────────────────────────

async function stepMemory(state, ctx) {
    const contextJson = state.context;
    // The watchlist is derived client-side and may predate the current generator; see
    // normalizeTrackedEntities. Primary sources are re-mapped because an adjacent solution
    // has no domain, and the old shape had given it an invented one.
    if (Array.isArray(contextJson?._trackedEntities)) {
        const { entities, changed } = normalizeTrackedEntities(contextJson._trackedEntities);
        if (changed) {
            console.warn(`[Memory] Re-filed ${changed} adjacent solution(s) that arrived as competitors.`);
            contextJson._trackedEntities = entities;
            contextJson._primarySources = mapPrimarySources(entities);
        }
    }
    // Competitors an earlier run's evidence promoted (competitorDiscovery.js). The founder's
    // list is derived from what the site and a model said; these are who actually showed up.
    // They join AFTER it and never displace it. Non-fatal: a failed read is the old behaviour.
    if (ctx.job.clientId && Array.isArray(contextJson?._trackedEntities)) {
        try {
            const stored = await getTrackedEntities(ctx.job.clientId);
            const stale = staleEvidenceRows(stored);
            if (stale.length) {
                const { retired } = await deactivateTrackedEntities(ctx.job.clientId, stale.map(r => r.name));
                console.log(`[Memory] Retired ${retired} evidence-discovered competitor(s) not named in ${EVIDENCE_MAX_AGE_DAYS} days.`);
            }
            const merged = mergeEvidenceEntities(contextJson._trackedEntities, stored);
            if (merged.length !== contextJson._trackedEntities.length) {
                console.log(`[Memory] Added ${merged.length - contextJson._trackedEntities.length} evidence-discovered competitor(s) to the watchlist.`);
                contextJson._trackedEntities = merged;
                contextJson._primarySources = mapPrimarySources(merged);
            }
        } catch (err) {
            console.warn('[Memory] Evidence-discovered competitors unavailable:', err.message);
        }
    }
    const companyMemory = ctx.job.clientId
        ? await loadCompanyMemory(ctx.job.clientId, ctx.job.websiteUrl)
        : null;

    const lastReport = companyMemory?.lastReport || null;
    const previousSignals = [
        ...(lastReport?.signals || []),
        ...(companyMemory?.previousSignals || [])
    ];
    const isFirstRun = !lastReport || previousSignals.length === 0;
    const lookbackMonths = isFirstRun ? LOOKBACK_MONTHS_FIRST_RUN : LOOKBACK_MONTHS_SUBSEQUENT;

    // Structured layer, derived on demand rather than read from a separate startup_contexts
    // row (that table was a second writer with an incompatible row shape — v26's header —
    // and a STALE one: a snapshot from whichever run last confirmed, not this run's). Every
    // field buildStartupContext needs is already sitting in contextJson, so this can never
    // drift from what this run is actually using. Only reached when contextJson didn't
    // already carry _startupContext — i.e. a server-driven run that REUSED a stored context:
    // stepContext's reuse branch calls hydrateStoredContext, not enrichContextWithOnboarding,
    // so _startupContext (a run-scoped key) arrives stripped even though _onboardingData
    // (reusable) survives. A founder's own confirm always re-derives it in the browser first
    // (IntelligenceDashboard.jsx), so this is a no-op there.
    if (!contextJson._startupContext && contextJson._onboardingData) {
        enrichContextWithOnboarding(contextJson, contextJson._onboardingData);
    }
    if (companyMemory?.companyState) contextJson._companyMemory = companyMemory.companyState;
    if (companyMemory?.memorySeed) contextJson._memorySeed = companyMemory.memorySeed;
    // Founder-flagged signals from the previous run — makes "Share a signal with Bahirjee"
    // actually influence this run instead of being an inert note.
    if (companyMemory?.founderNotes?.length) {
        contextJson._founderNotes = companyMemory.founderNotes;
        console.log(`[Memory] Injecting ${companyMemory.founderNotes.length} founder-flagged notes into this run.`);
    }
    // Founder emoji reactions (👍/🔥/💡 vs ⚠️/dismiss) from prior runs, as a
    // prioritization signal — turns the reaction buttons into real feedback.
    const rx = companyMemory?.reactionPreferences;
    if (rx && (rx.boost?.length || rx.suppress?.length)) {
        contextJson._reactionSignal = rx;
        console.log(`[Memory] Reaction prefs → boost:${rx.boost?.length || 0}, suppress:${rx.suppress?.length || 0}`);
    }

    if (isFirstRun) {
        console.log(`🌟 First run detected — using ${lookbackMonths}-month lookback for deeper context`);
        ctx.onProgress?.('First intelligence scan — casting a wide net (12 months)...');
    } else {
        console.log(`Incremental Learning: Found ${previousSignals.length} previous signals. Using ${lookbackMonths}-month lookback.`);

        // ═══ COMPETITOR PERSISTENCE ═══
        // Merge previous competitors as anchors — prevents competitor drift between runs
        const prevContext = lastReport.context || lastReport.contextJson || contextJson._companyMemory?.memory_state || {};

        // ...but never against the founder's explicit deletion.
        //
        // This merge reads the PREVIOUS RUN'S context, which still contains anything the
        // founder removed on the review screen a moment ago. Left unfiltered it re-adds
        // them one step after they were deleted, tagged `source: 'previous_run'`, and the
        // correction silently fails to stick across every future run. Drift protection is
        // for competitors the model forgot, not for ones a human said were wrong.
        const removedByUser = new Set(
            (contextJson._userEdits?.removed || [])
                .map(n => String(n || '').toLowerCase().trim())
                .filter(Boolean)
        );

        const prevCompetitors = (prevContext.key_competitors || [])
            .map(c => (typeof c === 'object' ? c : { name: c }))
            .filter(c => !removedByUser.has(String(c.name || '').toLowerCase().trim()));
        const currentCompetitors = (contextJson.key_competitors || []).map(c => (typeof c === 'object' ? c : { name: c }));

        if (removedByUser.size > 0) {
            console.log(`🚫 Competitor anchor: skipping ${removedByUser.size} name(s) the founder removed`);
        }

        if (prevCompetitors.length > 0) {
            const existingNames = new Set(currentCompetitors.map(c => (c.name || '').toLowerCase().trim()));
            const mergedCompetitors = [...currentCompetitors];

            for (const pc of prevCompetitors) {
                const name = (pc.name || '').toLowerCase().trim();
                if (name && !existingNames.has(name)) {
                    mergedCompetitors.push({ ...pc, source: 'previous_run' });
                    existingNames.add(name);
                }
            }

            if (mergedCompetitors.length > currentCompetitors.length) {
                console.log(`🔗 Competitor anchor: ${currentCompetitors.length} current + ${mergedCompetitors.length - currentCompetitors.length} from previous runs = ${mergedCompetitors.length} total`);
                contextJson.key_competitors = mergedCompetitors;
            }
        }
    }

    // The baseline shifts are measured against, read HERE because this step checkpoints
    // before anything in the run writes a pattern. Read inside v6_pipeline it would be one
    // crash-and-replay away from comparing the run's patterns with themselves — which is
    // exactly what detectShifts used to do on every run, so no shift ever fired. `since`
    // lets the engines recognise a finding a crashed attempt of this run already wrote.
    if (ctx.job.clientId) {
        state.v6.baseline = await getPatternBaseline(ctx.job.clientId);
        state.v6.since = new Date().toISOString();
    }

    state.memory = {
        lastReportId: lastReport?.id || null,
        // Only the tail is ever shown to the LLM (see stepAnalyze). Checkpointing the
        // whole signal history would rewrite it to Postgres on every invocation.
        previousSignalsTail: previousSignals.slice(-5),
        previousSignalCount: previousSignals.length,
        isFirstRun,
        lookbackMonths,
        companyState: companyMemory?.companyState || null
    };
}

// ─── discover_competitors ─────────────────────────────────────────────────
// Preferred path: Exa findSimilar on the company's own URL with category 'company'.
// Embedding similarity surfaces actual peer companies; keyword search surfaces
// listicles *about* peers, which is why the Tavily path needs an LLM to clean up.

// ─── express ──────────────────────────────────────────────────────────────
// One fast pass over the context the founder just confirmed, so grounded signals exist
// ~60s into a run instead of ~2.5 minutes.
//
// Everything this needs is already in `state.context` at confirmation time, so it runs
// before competitor discovery, before query generation, and with no LLM call for queries.
// It is an ACCELERATOR, never a dependency: any failure records a degradation and the run
// continues exactly as it would have. The founder simply waits a little longer.

const MAX_EXPRESS_DEFERS = 2;

async function stepExpress(state, ctx) {
    // "Early" signals are meaningless in the single-invocation monolith, where the whole
    // run completes before anything is shown — there it would only spend budget. Declared
    // via `steppedOnly` on the registry entry; this is the guard that honours it.
    if (!ctx.stepped) return;

    if (!state.express) {
        state.express = {
            cursor: 0, phase: 'search', deferCount: 0,
            queries: [], obsIds: [], urlKeys: [], signals: [], analyzedCount: 0
        };
    }
    const e = state.express;
    if (e.phase === 'done') return;

    // Every defer must move `cursor`, including a no-work one. The worker's
    // forward-progress guard fingerprints cursors, and a cursored step that defers without
    // moving one looks identical across invocations and aborts the whole job. stepWatch
    // gets this right; stepCollect only survives because its defer cap is 1.
    const giveUp = (reason, impact) => {
        recordDegradation(state, { step: 'Express scan', reason, impact });
        e.phase = 'done';
    };
    const deferOrSkip = (what) => {
        if (e.deferCount < MAX_EXPRESS_DEFERS) {
            e.deferCount += 1;
            e.cursor += 1;
            return { defer: true };
        }
        giveUp(
            `Ran out of invocation budget before the express ${what} could run.`,
            'First signals appear later in the run; the full analysis is unaffected.'
        );
        return undefined;
    };

    try {
        if (e.phase === 'search') {
            if (!ctx.timer.canAfford('Express wave', SEARCH_WAVE_BUDGET_MS)) return deferOrSkip('search');

            e.queries = buildExpressQueries(state.context, budget().expressQueries);
            if (e.queries.length === 0) { e.phase = 'done'; return; }

            ctx.onProgress?.('Running a first pass on your context...');
            const results = await mapWithConcurrency(e.queries, e.queries.length, (q, i) =>
                searchQuery(q, {
                    theme: 'competitor_intel',
                    // The express lane is a first pass at what is happening NOW, so it
                    // retrieves on the current window like any other event search. A fast
                    // path must not buy its speed by widening its dates.
                    retrievalWindow: 'current',
                    temporalPolicy: runPolicy(state),
                    // Offset so express never collides with the main plan's query indices.
                    queryIdx: 2000 + i,
                    geography: state.context?.operating_geography || null
                }).catch(err => {
                    console.warn(`[Express] Query failed: ${q}`, err.message);
                    return { observations: [], candidates: [] };
                })
            );

            await appendObservations(state, ctx, results.flatMap(r => r.observations), 'Express scan');

            // At this point the run has only express's rows, so this read is trivially
            // scoped. Both keys are kept: ids alone leak, because planAnalyzeBatches builds
            // its own url set from its own input and cannot know what express already read.
            const mine = await loadObservations(state);
            e.obsIds = mine.map(o => o.id).filter(id => id != null);
            e.urlKeys = [...new Set(mine.map(o => normalizeObservationUrl(o.url)).filter(Boolean))];

            e.phase = 'analyze';
            e.cursor += 1;
        }

        if (e.phase === 'analyze') {
            if (!ctx.timer.canAfford('Express batch', ANALYZE_BATCH_BUDGET_MS)) return deferOrSkip('analysis');

            const observations = (await loadObservations(state, e.obsIds))
                .filter(o => o.data && o.data.length > 50);
            if (observations.length === 0) { e.phase = 'done'; e.cursor += 1; return; }

            // `mem:` is stamped by stepAnalyze on id-less observations by array index;
            // reusing that prefix invites a silent collision.
            observations.forEach((o, i) => { if (o.id == null) o.id = `exp:${i}`; });

            ctx.onProgress?.('Reading the first results...');
            const batchText = observations.map((o, i) => compressObservation(o, i)).join('\n\n');

            const result = await callLLMWithRetry('analyzeSignals', {
                context: state.context,
                searchResults: batchText,
                // ONE policy for the whole run. Every analyze path — express, normal
                // batches, gap-fill retries — classifies against the same boundaries, so a
                // long run cannot judge the same evidence two different ways depending on
                // which step happened to reach it.
                temporalPolicy: runPolicy(state),
                previousSignals: state.memory?.previousSignalsTail || [],
                quoteBinding: SIGNAL_QUOTE_BINDING
            });

            // The IDENTICAL filter chain stepAnalyze uses. A weaker path here would let
            // express publish findings a normal first-pass signal could not.
            const signals = applySignalFilters(
                normalizeSignalResponse(result), batchText, state.context?.company_name, observations
            );

            // Classify before express publishes anything. A fast path must not buy its
            // speed by skipping the date rules — whatever it emits reaches the live
            // surface first and would set the reader's expectation for the whole run.
            e.signals = buildEvidencePackets({ signals, policy: runPolicy(state) }).signals;
            e.analyzedCount = observations.length;
            e.phase = 'done';
            e.cursor += 1;
            console.log(`[Express] ${signals.length} grounded signals from ${observations.length} observations`);
        }
    } catch (err) {
        // Fail-open by contract. An express failure must never cost the run.
        console.error('[Express] failed:', err.message);
        giveUp(
            `The express first pass failed (${err.message}).`,
            'First signals appear later in the run; the full analysis is unaffected.'
        );
        e.cursor += 1;
    }

    ctx.timer.logStep('Express scan');
}

/**
 * Product mode: find the PRODUCTS this one competes with, when the founder named none.
 *
 * The company's key_competitors are corporate rivals; a product run asks "how does mine
 * compare", which only means something against another product. Without this a product
 * run inherited the company's watchlist and spent its budget on it. Same extraction as
 * company discovery (search → buildContext's key_competitors), pointed at the product.
 * Writes `_product.competitor_products`, which persists with the product's context, so the
 * next run starts from it and skips this.
 */
async function discoverProductRivals(state, ctx) {
    const contextJson = state.context;
    const subject = runSubject(contextJson, { analysisMode: ctx.job.analysisMode });
    if (!subject.isProduct || subject.competitors.length > 0) return;
    if (!ctx.timer.canAfford('Product rival discovery', 18000)) {
        recordDegradation(state, {
            step: 'Product rival discovery',
            reason: 'Ran out of time budget before rival products could be identified.',
            impact: `Comparisons fall back to ${subject.maker || 'the company'}'s competitors rather than rival products.`
        });
        return;
    }

    try {
        ctx.onProgress?.(`Finding what competes with ${subject.searchName}...`);
        const year = new Date().getFullYear();
        const [direct, byCategory] = await Promise.allSettled([
            fetchTavilySearch(`"${subject.searchName}" alternatives OR competitors OR vs ${year}`, { max_results: 5, search_depth: 'basic' }),
            fetchTavilySearch(`best ${subject.category || 'software'} products ${year - 1} ${year}`, { max_results: 5, search_depth: 'basic' }),
        ]);
        const results = [
            ...(direct.status === 'fulfilled' ? (direct.value.results || []) : []),
            ...(byCategory.status === 'fulfilled' ? (byCategory.value.results || []) : []),
        ];
        if (results.length === 0) {
            console.warn(`[ProductRivals] No search results for ${subject.searchName}`);
            return;
        }

        const searchContent = results
            .map(r => `TITLE: ${r.title}\nURL: ${r.url}\nEXCERPT: ${(r.text || r.content || r.snippet || '').slice(0, 400)}`)
            .join('\n\n')
            .slice(0, 8000);
        const discovered = await callLLMWithRetry('buildContext', {
            url: subject.canonicalUrl || '',
            linkedin: '',
            rawText: `[COMPETITOR DISCOVERY for the PRODUCT "${subject.searchName}", made by ${subject.maker || 'the company'}, in ${subject.category || 'its category'}]\n` +
                `From these search results, identify named PRODUCTS that compete with ${subject.searchName} — another maker's product, never ${subject.maker || 'its maker'} or ${subject.searchName} itself. ` +
                `Populate only the key_competitors and category_peers fields — all other fields use minimal placeholders.\n\n${searchContent}`
        });

        // Never the product itself or its maker: the same self test as filterSelfSignals.
        const selfTokens = [subject.searchName, subject.maker].map(normalizeBrandToken).filter(t => t.length >= 3);
        const isSelf = (name) => {
            const t = normalizeBrandToken(name);
            return !t || selfTokens.some(s => t === s || t.includes(s) || s.includes(t));
        };
        const rivals = (discovered?.key_competitors || [])
            .filter(c => (c?.competitor_confidence ?? 60) >= 40)
            .map(c => (typeof c === 'object' ? c?.name : c))
            .filter(n => n && !isSelf(n));

        if (rivals.length > 0) {
            contextJson._product = normalizeProductProfile({ ...contextJson._product, competitor_products: rivals });
            console.log(`[ProductRivals] ✅ ${subject.searchName}: ${contextJson._product.competitor_products.join(', ')}`);
        } else {
            console.warn(`[ProductRivals] ⚠️ No rival products extracted for ${subject.searchName}`);
        }
        ctx.timer.logStep('Product Rival Discovery');
    } catch (err) {
        console.warn('[ProductRivals] Failed (non-blocking):', err.message);
    }
}

async function stepDiscoverCompetitors(state, ctx) {
    // Independent of the company check below: a product's context is inherited from its
    // company, so key_competitors is usually already set and that check returns early.
    if (ctx.job.analysisMode === PRODUCT_MODE) await discoverProductRivals(state, ctx);

    const contextJson = state.context;
    if (contextJson.key_competitors?.length || !contextJson.company_name) return;
    // Non-cursored: cannot return {defer:true} here — the worker's forward-progress guard
    // fingerprints only the search/analyze/news cursors, so a deferring non-cursored step
    // looks like "no progress" and aborts the whole job. Skip, but never silently.
    if (!ctx.timer.canAfford('Competitor Discovery', 18000)) {
        recordDegradation(state, {
            step: 'Competitor discovery',
            reason: 'Ran out of time budget before competitor discovery could run.',
            impact: 'Competitors may be missing or incomplete.'
        });
        return;
    }

    try {
        ctx.onProgress?.('Discovering competitors...');
        const companyName = contextJson.company_name;
        const industry = contextJson.strategic_anchors?.operational_reality || contextJson.industry || 'technology';
        const year = new Date().getFullYear();
        const websiteUrl = contextJson.website_url;

        // Turn raw search hits into named competitors. Run per-source rather than once over
        // a merged pool, so "did this source yield anything usable" is answerable — which is
        // what decides whether the fallback is needed.
        const extractCompetitors = async (results) => {
            if (!results.length) return [];
            const searchContent = results
                .map(r => `TITLE: ${r.title}\nURL: ${r.url}\nEXCERPT: ${(r.text || r.content || r.snippet || '').slice(0, 400)}`)
                .join('\n\n')
                .slice(0, 8000);

            const discoveredCtx = await callLLMWithRetry('buildContext', {
                url: contextJson.website_url || '',
                linkedin: '',
                rawText: `[COMPETITOR DISCOVERY for "${companyName}" in ${industry}]\nFrom these search results, identify named competitors. Populate only the key_competitors and category_peers fields — all other fields use minimal placeholders.\n\n${searchContent}`
            });

            const named = (discoveredCtx?.key_competitors || []).filter(c => (c.competitor_confidence ?? 60) >= 40);
            // Attach the real URL each competitor was discovered at. The model is shown
            // these URLs but populates the field inconsistently, and a competitor without
            // one falls through to primarySourceMapper's `${name}.com` guess — which is
            // what put dead URLs in entity_sources. Matching here is deterministic, and
            // matching per source pool means a competitor never picks up a URL from a
            // search it did not come out of.
            return attachDiscoveredUrls(named, results);
        };

        let discovered = [];

        if (websiteUrl) {
            const similar = await postExa({
                mode: 'findSimilar',
                url: websiteUrl,
                category: 'company',
                numResults: 25,
                excludeSourceDomain: true,
                includeContents: true,
                maxCharacters: 800,
            });
            const raw = similar.results || [];

            // findSimilar embeds the site, and a distinctive brand name dominates that
            // embedding — so it returns everything sharing the name rather than everything
            // in the business. Measured on vyaparapp.in: 9 of 25 results were exact-stem
            // collisions (a digital-marketing agency, a B2B matchmaking network, several
            // unrelated startups), and most of the survivors were spelling variants —
            // Vyapaar, Vyapaari, Byapar, Zyapaar.
            //
            // This filter is noise reduction, not the fix. It cheaply removes the results
            // that are provably collisions so the LLM below reasons over less garbage; the
            // fallback further down is what actually recovers a run like this one.
            //
            // The stem comes from the company NAME, not the URL: the collisions share the
            // brand ("vyapar"), not the domain label ("vyaparapp"), and normalizeBrandToken
            // on a ccTLD host leaves the TLD attached ("vyaparapp.in" -> "vyaparappin"),
            // which matches nothing. Stems under 5 characters are not filtered on — a name
            // that short is too generic to be evidence of a collision, and blanket-dropping
            // every domain containing it would take real competitors with it.
            const brandStem = normalizeBrandToken(companyName);
            const peers = brandStem.length >= 5
                ? raw.filter(r => !normalizeBrandToken(r.url).includes(brandStem))
                : raw;

            const dropped = raw.length - peers.length;
            console.log(
                `[CompetitorDiscovery] Exa findSimilar(${websiteUrl}) → ${peers.length} peer companies`
                + (dropped > 0 ? ` (${dropped} "${brandStem}" name collisions dropped)` : '')
            );

            discovered = await extractCompetitors(peers);
        }

        // Fall back to keyword search when findSimilar yielded no usable competitor — not
        // merely when it returned no rows. Twenty-five name collisions are zero competitors,
        // but they used to satisfy a `length === 0` check and suppress this fallback
        // entirely, which is how runs ended up shipping with an empty competitor set.
        if (discovered.length === 0) {
            console.warn('[CompetitorDiscovery] findSimilar yielded no competitors — falling back to Tavily keyword search');
            const [directSearch, industrySearch] = await Promise.allSettled([
                fetchTavilySearch(`"${companyName}" competitors alternatives ${year}`, { max_results: 5, search_depth: 'basic' }),
                fetchTavilySearch(`best ${industry} software tools companies ${year - 1} ${year}`, { max_results: 5, search_depth: 'basic' }),
            ]);

            const keywordResults = [
                ...(directSearch.status === 'fulfilled' ? (directSearch.value.results || []) : []),
                ...(industrySearch.status === 'fulfilled' ? (industrySearch.value.results || []) : []),
            ];
            discovered = await extractCompetitors(keywordResults);
        }

        if (discovered.length > 0) {
            contextJson.key_competitors = discovered;
            console.log(`[CompetitorDiscovery] ✅ ${discovered.length} competitors found: ${discovered.map(c => c.name).join(', ')}`);
        } else {
            console.warn('[CompetitorDiscovery] ⚠️ No competitors extracted from web search');
        }

        ctx.timer.logStep('Competitor Discovery');
    } catch (err) {
        console.warn('[CompetitorDiscovery] Failed (non-blocking):', err.message);
    }
}

// ─── validate_exa ─────────────────────────────────────────────────────────
// Validate competitor picks and seed funding_intel observations before Tavily runs.

async function stepValidateExa(state, ctx) {
    const contextJson = state.context;
    if (!contextJson.key_competitors?.length) return;
    if (!ctx.timer.canAfford('Exa Intelligence', 20000)) {
        recordDegradation(state, {
            step: 'Competitor validation',
            reason: 'Ran out of time budget before Exa validation could run.',
            impact: 'Competitor list is unvalidated; funding signals may be missing.'
        });
        return;
    }

    try {
        ctx.onProgress?.('Validating competitors and discovering funding signals...');
        const industry = contextJson.strategic_anchors?.operational_reality || contextJson.industry || 'technology';
        const geography = contextJson.operating_geography || 'global';
        const year = new Date().getFullYear();
        const yearStart = `${year - 1}-01-01`;

        const competitorsToValidate = contextJson.key_competitors
            .map(c => (typeof c === 'object' ? c.name : c))
            .filter(Boolean)
            .slice(0, 5);

        const [competitorResults, fundingResults] = await Promise.allSettled([
            Promise.all(competitorsToValidate.map(name =>
                validateCompetitorViaExa(name, { industry, startPublishedDate: yearStart })
                    .catch(() => ({ hasOwnSite: false, recentActivity: 0, resolvedUrl: null, skipped: true }))
            )),
            postExa({
                query: `${industry} ${geography} startup raised Series funding round ${year - 1} ${year}`,
                type: 'neural',
                numResults: 8,
                useAutoprompt: true,
                includeContents: true,
                maxCharacters: 1500,
                startPublishedDate: yearStart,
            })
        ]);

        if (competitorResults.status === 'fulfilled') {
            const evidenceByName = new Map(
                competitorsToValidate.map((name, idx) => [name, competitorResults.value[idx]])
            );

            const validatedCompetitors = contextJson.key_competitors.map(c => {
                const base = typeof c === 'object' ? c : { name: c };
                const baseConf = base.competitor_confidence || 70;
                const evidence = evidenceByName.get(base.name);

                // Competitors beyond the validation slice were never checked. Leave them
                // at base confidence rather than penalising them for a check we skipped.
                if (!evidence || evidence.skipped) return { ...base, competitor_confidence: baseConf };

                return {
                    ...base,
                    exa_has_own_site: evidence.hasOwnSite,
                    exa_recent_activity: evidence.recentActivity,
                    // The homepage an index actually returned, kept separate from `url`
                    // (which the model wrote). primarySourceMapper prefers this one, and
                    // only this one earns 'observed' confidence.
                    ...(evidence.resolvedUrl ? { resolved_url: evidence.resolvedUrl } : {}),
                    competitor_confidence: scoreCompetitorConfidence(baseConf, evidence),
                };
            });

            // Drop entities with no discoverable homepage and no recent activity.
            const confirmed = validatedCompetitors.filter(c => c.competitor_confidence >= 40);
            if (confirmed.length > 0) {
                contextJson.key_competitors = confirmed;
                const removed = validatedCompetitors.length - confirmed.length;
                console.log(`[Exa] Competitor validation: ${confirmed.length} confirmed, ${removed} removed (low confidence)`);
                confirmed.forEach(c => console.log(
                    `  → ${c.name}: own_site=${c.exa_has_own_site ?? 'n/a'}, recent=${c.exa_recent_activity ?? 'n/a'}, confidence=${c.competitor_confidence}`
                ));
            } else {
                console.warn('[Exa] Competitor validation rejected every candidate — keeping unvalidated set');
            }
        }

        if (fundingResults.status === 'fulfilled') {
            const exaFundingObs = (fundingResults.value.results || []).map(r => ({
                job: 'funding_intel',
                theme: 'funding_intel',
                source: 'Exa Intelligence',
                source_type: 'exa',
                data: `TITLE: ${r.title}\nURL: ${r.url}\nCONTENT: ${r.text || r.highlights?.join(' ') || ''}`,
                url: r.url,
                title: r.title,
                published_date: r.publishedDate || null,
                score: r.score || 0.8,
            }));
            if (exaFundingObs.length > 0) {
                await appendObservations(state, ctx, exaFundingObs, 'Funding discovery');
                console.log(`[Exa] ✅ Funding discovery: ${exaFundingObs.length} signals pre-seeded`);
            }
        } else if (fundingResults.status === 'rejected') {
            console.warn(`[Exa] ⚠️ Funding discovery failed: ${fundingResults.reason?.message || fundingResults.reason || 'Unknown error'}`);
        }

        ctx.timer.logStep('Exa Intelligence');
    } catch (exaErr) {
        console.warn('[Exa] Intelligence step failed (non-blocking):', exaErr.message);
    }
}

// ─── generate_queries ─────────────────────────────────────────────────────

// Theme travels with the query rather than being re-derived from its text later.
// The old path keyword-matched the query string in observationService.categorizeTheme(),
// which meant rewording a template silently re-routed its observations.
export const QUERY_BUCKET_THEMES = {
    competitor_intel: 'competitor_intel',
    talent_signals: 'talent_signals',
    funding_intel: 'funding_intel',
    customer_shifts: 'customer_shifts',
    regulatory_lens: 'regulatory_lens',
    market_expansion: 'customer_shifts',
    industry_momentum: 'customer_shifts',
    // Emitted by PROMPTS.buildQuery. They were absent here, so every query the LLM
    // generated for these two buckets was silently dropped at flatten time. The two
    // buckets that used to sit here instead (competitor_queries, market_queries) were
    // never emitted by any prompt — dead mappings for a shape that no longer exists.
    competitor_discovery: 'competitor_intel',
    adjacent_trends: 'customer_shifts',
    // Demand intelligence: segment/account buying behaviour.
    demand_signals: 'customer_shifts',
    decision_lens: 'customer_shifts',
    // The founder's stated bets. A bucket missing from this map is silently dropped before
    // search — how competitor_discovery and adjacent_trends were lost.
    assumption_lens: 'customer_shifts',
    // The product lens (stepGenerateQueries). Same failure mode as above if this entry
    // is ever removed: the bucket would still be assigned on `queries`, just never
    // reach `allQueries` below, so a product run would silently search nothing about
    // the product it was asked about.
    product_lens: 'customer_shifts',
    // Source tiers, derived from SOURCE_TIERS. Their value is the source *type* rather
    // than the theme, so most sit on the market/industry lens — except the two whose
    // subject matter has a real theme of its own, which would otherwise lose it.
    ...Object.fromEntries(TIER_BUCKETS.map(bucket => [
        bucket,
        { tier_government: 'regulatory_lens', tier_reviews: 'customer_shifts' }[bucket] || 'customer_shifts',
    ])),
};

// Which temporal window each bucket is retrieved under. Declared per bucket rather than
// inferred at search time, for the same reason `theme` is: inference from the query's
// wording or the provider's topic means rewording a template silently re-routes it.
//
//   current  — 6 months. Dated events: a funding round, a hire, a pricing change, a
//              policy notice. The only material allowed to become current news.
//   context  — 12 months. Reports, research, analyst notes, reviews, market sizing.
//              Explains a current event; is never itself the event.
//   profile  — unbounded. WHO an entity is, not what it did. A date window on the general
//              index filters undated pages OUT, so bounding these loses the homepage.
//
// A bucket missing from this map is DROPPED before search rather than retrieved under a
// guessed window — the same contract QUERY_BUCKET_THEMES has, and for the same reason: a
// bucket absent from that map silently lost every query it generated for months.
export const QUERY_BUCKET_WINDOWS = {
    competitor_intel: 'current',
    talent_signals: 'current',
    funding_intel: 'current',
    customer_shifts: 'current',
    regulatory_lens: 'current',
    market_expansion: 'current',
    industry_momentum: 'current',
    demand_signals: 'current',
    // The founder's stated bets are checked against recent evidence.
    assumption_lens: 'current',
    // Finding out WHO the competitors are, which is an entity question, not an event one.
    competitor_discovery: 'profile',
    // Adjacent market movement is a trend, and a trend needs more than two quarters.
    adjacent_trends: 'context',
    // The founder's own question ("should we deepen India or open the US"). Bounding a
    // strategic question to six months of news would starve exactly what it asked about.
    decision_lens: 'context',
    // Product inquiry questions ("how do buyers evaluate this alternative"). Same reasoning.
    product_lens: 'context',
    // Source tiers. Two of the eight are dated press and policy and belong in the current
    // window; the rest are research-shaped material that explains rather than announces.
    ...Object.fromEntries(TIER_BUCKETS.map(bucket => [
        bucket,
        (bucket === 'tier_regional_news' || bucket === 'tier_government') ? 'current' : 'context',
    ])),
};

/**
 * Flatten planned queries into search items, carrying theme, tier AND window.
 *
 * Extracted from stepGenerateQueries so the routing is testable without running a step
 * that calls an LLM. A bucket with no theme or no window mapping is dropped here —
 * deliberately, and visibly, rather than reaching search under a default nobody chose.
 */
export function buildQueryItems(queriesByBucket = {}) {
    return Object.entries(QUERY_BUCKET_THEMES).flatMap(([bucket, theme]) => {
        const retrievalWindow = QUERY_BUCKET_WINDOWS[bucket];
        if (!retrievalWindow) return [];
        return (queriesByBucket[bucket] || [])
            .map(q => String(q || '').trim())
            .filter(Boolean)
            .map(query => ({ query, theme, tier: QUERY_BUCKET_TIERS[bucket] || null, retrievalWindow }));
    });
}

// Which buckets carry a source tier. The tier travels with the query exactly as `theme`
// does, and becomes an include_domains allowlist at search time.
export const QUERY_BUCKET_TIERS = Object.fromEntries(
    TIER_BUCKETS.map(bucket => [bucket, tierForBucket(bucket)])
);

const normalizeQueryKey = (q) => {
    const s = String(q || '')
        .replace(/[“”]/g, '"')
        .replace(/[’]/g, '\'')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

    // Collapse most punctuation so superficial differences don't create duplicates.
    return s.replace(/[^\w\s"'-]/g, '');
};

function buildQueryScorer({ knownEntityNames, region, industry, year }) {
    const y = String(year);
    return (q) => {
        const text = String(q || '');
        const lower = text.toLowerCase();
        let score = 0;

        // Prefer exact-style queries (quoted entity mentions).
        if (text.includes('"')) score += 3;
        if (/\b(or|and)\b/i.test(text)) score += 2;

        // Time + geo specificity.
        if (lower.includes(y)) score += 6;
        if (region && lower.includes(String(region).toLowerCase())) score += 3;
        if (industry && lower.includes(String(industry).toLowerCase())) score += 1;

        // Entity anchoring.
        for (const name of knownEntityNames) {
            if (name && lower.includes(name)) {
                score += 4;
                break;
            }
        }

        // Specificity heuristic: queries naming a concrete signal type retrieve better.
        // These no longer affect theme assignment — theme travels with the query.
        const themeKeywordGroups = [
            { keywords: ['competitor', 'acquisition', 'funding', 'ceo', 'cfo', 'merger'], points: 2 },
            { keywords: ['hiring', 'layoff', 'engineer', 'talent', 'recruit'], points: 2 },
            { keywords: ['series', 'venture', 'capital', 'raised'], points: 2 },
            { keywords: ['customer', 'buyer', 'buying', 'pain', 'adoption'], points: 2 },
            { keywords: ['regulation', 'compliance', 'regulatory'], points: 2 }
        ];

        for (const group of themeKeywordGroups) {
            const matches = group.keywords.reduce((sum, k) => sum + (lower.includes(k) ? 1 : 0), 0);
            score += Math.min(8, matches * group.points);
        }

        // Slightly penalize extremely long queries.
        if (text.length > 140) score -= 2;

        return score;
    };
}

async function stepGenerateQueries(state, ctx) {
    const contextJson = state.context;
    ctx.onProgress?.('Generating strategic search patterns...');

    const safeCompetitors = (contextJson.key_competitors && contextJson.key_competitors.length > 0)
        ? contextJson.key_competitors
        : ['Major Competitors', 'Industry Leaders', 'Market Incumbents'];

    let queries;

    const startupCtx = contextJson._startupContext;
    const trackedEntities = contextJson._trackedEntities || [];
    const signalWeights = contextJson._signalWeights || {};

    // What the run is about. In product mode the generator below must name the product and
    // rotate over its rival PRODUCTS first; it used to be handed the company and the
    // company's watchlist, which is how a product run spent ~18 of 22 queries on its maker.
    const subject = runSubject(contextJson, { analysisMode: ctx.job.analysisMode });
    const queryEntities = subject.isProduct
        ? withProductRivals(trackedEntities, subject.competitors)
        : trackedEntities;
    const marketProfile = subject.isProduct && contextJson._product?.category
        ? { ...(startupCtx?.market_profile || {}), industry: contextJson._product.category }
        : startupCtx?.market_profile;

    // Deterministic query generation first (only possible once the context layer exists).
    if (startupCtx && trackedEntities.length > 0) {
        try {
            ctx.onProgress?.('Generating context-aware queries...');
            const contextQueries = generateContextAwareQueries({
                entities: queryEntities,
                signalWeights,
                marketProfile,
                geography: startupCtx.revenue_profile?.geography || contextJson.operating_geography,
                companyName: subject.searchName || contextJson.company_name,
                // Drives the demand floor. Extracted at context time and, until now,
                // never used for retrieval — only shown on screen and pasted into a prompt.
                customerSegments: contextJson.customer_segments,
                // Gates the conditional supply-chain tier. A SaaS company that ships
                // nothing must not spend reserved budget on freight rates.
                tierProfile: profileFromContext(contextJson),
                // Floors are re-derived per tier, not scaled: the full-tier floors sum to
                // 17 and would over-subscribe a shallow 8-query budget twice over.
                runBudget: budget(),
                // The founder's own High-sensitivity bets get reserved queries. Until now
                // these were collected, shown back on the review screen, persisted — and
                // read by nothing, while the form promised they steered the run.
                strategicAssumptions: startupCtx?.strategic_assumptions || []
            });
            queries = flattenQueriesForTavily(contextQueries);
            console.log(`✅ Deterministic query generation: ${Object.values(queries).flat().length} queries`);
            ctx.timer.logStep('Deterministic Query Generation');
        } catch (detErr) {
            console.warn('[Pipeline] Deterministic query gen failed, falling back to Gemini:', detErr.message);
            queries = null;
        }
    }

    if (!queries) {
        try {
            queries = await callLLMWithRetry('generateQueries', {
                context: contextJson,
                competitors: safeCompetitors,
                dateStr: new Date().toISOString().split('T')[0]
            });
            // Gemini usage reporting (tokens => approximate "credits" for query generation).
            const geminiUsage = queries?._gemini_usage;
            if (geminiUsage) {
                const totalTokens = geminiUsage.totalTokenCount ?? geminiUsage.totalTokens ?? null;
                const approxCredits = totalTokens ? Math.ceil(Number(totalTokens) / 1000) : null;
                // Ops telemetry, not founder-facing. This used to go through ctx.onProgress,
                // which put "…4831 tokens (~5 credits)" in the status line the founder
                // watches for the length of the run.
                console.debug(
                    `[Pipeline] Gemini query generation usage: ${totalTokens ? `${totalTokens} tokens` : 'tokens unavailable'}${
                        approxCredits ? ` (~${approxCredits} credits)` : ''
                    }`
                );
                const { _gemini_usage, ...rest } = queries;
                queries = rest;
            }
            ctx.timer.logStep('Gemini Query Generation');
        } catch (queryErr) {
            console.error('[Pipeline] Query generation failed:', queryErr.message);
            // GRACEFUL DEGRADATION: Use fallback generic queries
            ctx.onProgress?.('Using fallback intelligence patterns...');
            const companyName = contextJson.company_name || 'company';
            const industryName = contextJson.industry || 'technology';
            const yr = new Date().getFullYear();
            const competitorQueries = safeCompetitors.slice(0, 3).map(c => {
                const name = typeof c === 'object' ? c.name : c;
                return `${name} news ${yr}`;
            });
            // Always include the company name so fallback results are company-specific
            if (competitorQueries.length === 0) {
                competitorQueries.push(`${companyName} competitors ${yr}`);
            }
            queries = {
                competitor_intel: competitorQueries,
                talent_signals: [`${companyName} hiring ${yr}`, `${industryName} hiring trends ${yr}`],
                funding_intel: [`${companyName} funding ${yr}`, `${industryName} funding ${yr}`],
                customer_shifts: [`${companyName} customers review`, `${companyName} strategy ${yr}`],
                regulatory_lens: [`${companyName} ${industryName} regulation ${yr}`]
            };
            ctx.timer.logStep('Fallback Query Generation');
        }
    }

    if (ctx.job.analysisMode === DECISION_MODE || contextJson._decision) {
        queries.decision_lens = buildDecisionQueries({
            frame: contextJson._decision || ctx.job.decisionContext,
            context: contextJson,
            // A `situation` inquiry is usually "what are THEY doing", so the query builder
            // needs the actual watchlist rather than the industry noun.
            entities: trackedEntities,
        });
    }

    // The product lens spends inquiryQueryFloor, which a product run leaves free. Gated
    // on the TIER flag as well as the mode: a daily pursuit or a decision session must
    // never spend it, because there that floor is already claimed.
    //
    // Unlike the decision lens above (`analysisMode === DECISION_MODE || contextJson._decision`),
    // this gate does NOT accept a bare `productProfile` as an alternative to the mode check.
    // `_decision` is RUN-SCOPED (companyContextService.RUN_SCOPED_KEYS) — it is stripped on
    // reuse, so it cannot outlive the run that set it, which is what makes an `||` there
    // safe. `_product` is REUSABLE (companyContextService.REUSABLE_KEYS) — it is DESIGNED to
    // survive into later runs. Mirroring the `||` pattern here would mean any COMPANY run
    // that picks up a `_product` by any route (reuse, hydration, a stale job field) silently
    // spends the inquiry-query floor researching a product it was never asked about, with
    // nothing thrown and nothing disclosed. So all three conditions are mandatory, not two
    // of three alternatives.
    const productProfile = contextJson._product || ctx.job.productContext;
    if (ctx.job.analysisMode === PRODUCT_MODE && productProfile && budget().productLens) {
        queries.product_lens = buildProductQueries({
            product: productProfile,
            context: contextJson,
            entities: Array.isArray(trackedEntities) ? trackedEntities : [],
            limit: budget().inquiryQueryFloor,
        });
    }

    // Inject fallback queries only if a bucket is missing/empty.
    // These fallbacks are "fine grade" (theme keywords + year/geo) instead of generic news.
    const industry = contextJson.strategic_anchors?.operational_reality || contextJson.industry || 'technology';
    const region = contextJson.operating_geography || 'India';
    const year = new Date().getFullYear();
    const y = String(year);

    const regulators = trackedEntities.filter(e => e?.category === 'regulator').map(e => e?.name).filter(Boolean);
    const competitors = trackedEntities.filter(e => e?.category === 'competitor').map(e => e?.name).filter(Boolean);

    const bestRegulator = regulators[0] || industry;
    const bestCompetitor = competitors[0] || (safeCompetitors?.[0] ? (typeof safeCompetitors[0] === 'object' ? safeCompetitors[0].name : safeCompetitors[0]) : industry);

    if (!queries.regulatory_lens || queries.regulatory_lens.length === 0) {
        queries.regulatory_lens = [`"${bestRegulator}" regulation AND compliance update in ${region} ${y} for ${industry}`];
    }
    if (!queries.market_expansion || queries.market_expansion.length === 0) {
        queries.market_expansion = [`"${bestCompetitor}" partnership OR integration in ${region} ${y} buyer demand OR customer adoption`];
    }
    if (!queries.industry_momentum || queries.industry_momentum.length === 0) {
        queries.industry_momentum = [`${industry} customer adoption OR buying signals in ${region} ${y} market growth`];
    }
    if (!queries.customer_shifts || queries.customer_shifts.length === 0) {
        queries.customer_shifts = [`"${bestCompetitor}" enterprise buyer contract win in ${region} ${y} customer demand OR pain points`];
    }

    const allQueries = buildQueryItems(queries);

    const knownEntityNames = new Set(
        [
            ...(contextJson._trackedEntities || []).map(e => e?.name),
            ...(contextJson.key_competitors || []).map(c => (typeof c === 'object' ? c?.name : c)),
            // Product mode: the product and its rivals are the entities this run is about.
            // Unknown to the scorer, a query naming them ranked as unanchored.
            ...(subject.isProduct ? [subject.searchName, ...subject.competitors] : [])
        ]
            .filter(Boolean)
            .map(n => String(n).trim().toLowerCase())
            .filter(n => n.length >= 2)
    );

    const scoreQuery = buildQueryScorer({ knownEntityNames, region, industry, year });

    const dedupeCandidateMap = new Map(); // normalized -> { query, theme, tier, retrievalWindow, score }
    for (const { query: q, theme, tier, retrievalWindow } of allQueries) {
        const key = normalizeQueryKey(q);
        if (!key) continue;
        const score = scoreQuery(q);
        const existing = dedupeCandidateMap.get(key);
        if (!existing || existing.score < score) {
            dedupeCandidateMap.set(key, { query: q, theme, tier, retrievalWindow, score });
        }
    }

    // Tier queries are pinned ahead of the scored field. The scorer rewards entity
    // anchoring and news vocabulary, which a research/analyst query has by definition —
    // left to compete, the reserved floor would be silently competed away, exactly what
    // reserving it was meant to prevent.
    const candidates = [...dedupeCandidateMap.values()];
    const tierPinned = candidates.filter(c => c.tier);

    // ── The founder's own question is pinned too ────────────────────────────
    // Same failure mode as the tier floor, and worse. `buildQueryScorer` rewards entity
    // anchoring and news vocabulary; a question like "should we deepen India or open the
    // US" has almost none of either, so left to compete it loses to generic competitor
    // news. With 9 of 22 already pinned to tiers there was sometimes room for it to
    // survive by luck — at a shallow budget of 8 it loses every single time, which would
    // mean a run that never searched the thing it was asked about.
    const inquiryQueries = new Set([...(queries.decision_lens || []), ...(queries.product_lens || [])]);
    const inquiryPinned = candidates.filter(c => !c.tier && inquiryQueries.has(c.query));
    const rest = candidates
        .filter(c => !c.tier && !inquiryQueries.has(c.query))
        .sort((a, b) => b.score - a.score);

    const selected = [
        ...tierPinned.slice(0, budget().tierQueryFloor),
        ...inquiryPinned.slice(0, budget().inquiryQueryFloor),
        // Whatever the floors did not claim goes back into the pool, so a run with no
        // inquiry (plain company intelligence) spends the full budget as it always did.
        ...tierPinned.slice(budget().tierQueryFloor),
        ...inquiryPinned.slice(budget().inquiryQueryFloor),
        ...rest,
    ]
        .slice(0, budget().maxQueries)
        // Narrowed to exactly the fields the search step needs, because this object is
        // checkpointed. Any field added upstream has to be listed HERE too or it is
        // silently dropped at the step boundary.
        .map(({ query, theme, tier, retrievalWindow }) => ({ query, theme, tier, retrievalWindow }));

    state.queries = { buckets: queries, selected };
    // `served` lives on the checkpointed object, not in a local: stepSearch can defer
    // mid-run and resume in a later invocation, and a per-invocation tally would then
    // only describe the final wave.
    state.search = {
        cursor: 0,
        total: selected.length,
        phase: 'search',
        candidates: [],
        served: { tavily: 0, exa: 0 },
        // Provider use broken down by retrieval window, so a fallback can be attributed
        // to the evidence band it cost rather than to the run as a whole.
        servedByWindow: {}
    };
    console.log(`Selected ${selected.length} queries for search.`);
}

// ─── search ───────────────────────────────────────────────────────────────
// Waves of SEARCH_WAVE_SIZE concurrent queries, then a single deterministic deep-read
// pass over the candidates every query contributed.

async function stepSearch(state, ctx) {
    // A partial run may skip `generate_queries` and supply its own string query list. Keep
    // the step contract in one place: normalize those strings to the same shape as the full
    // planner and create the cursor when this is a fresh subset run.
    const selected = (Array.isArray(state.queries?.selected) ? state.queries.selected : [])
        .map(item => typeof item === 'string'
            ? { query: item, theme: 'customer_shifts', tier: null }
            : item)
        .filter(item => item?.query);
    const search = state.search || (state.search = {
        cursor: 0,
        total: selected.length,
        phase: 'search',
        candidates: [],
        served: { tavily: 0, exa: 0 }
    });

    // A checkpoint with work remaining but no query list cannot make forward progress:
    // `wave` would be empty and its cursor would never advance. Disclose and close it
    // rather than looping until the worker's progress guard aborts the job.
    if (search.cursor < search.total && selected.length === 0) {
        recordDegradation(state, {
            step: 'Reconnaissance',
            reason: 'Search state had remaining work but no recoverable query list.',
            impact: 'The remaining searches were skipped rather than retried indefinitely.'
        });
        search.cursor = search.total;
        search.phase = 'done';
        return;
    }

    const lookbackMonths = state.memory?.lookbackMonths ?? LOOKBACK_MONTHS_FIRST_RUN;
    const policy = runPolicy(state);

    // A job checkpointed before `served` existed resumes without it. Tallying into an
    // undefined object would throw and take the whole step down mid-run.
    if (!search.served) search.served = { tavily: 0, exa: 0 };
    // Added with the temporal windows; a job checkpointed before it resumes without one.
    if (!search.servedByWindow) search.servedByWindow = {};
    if (!Array.isArray(search.candidates)) search.candidates = [];

    const deepReadMode = jevModeFor('deep_reads');
    const waveBudgetMs = SEARCH_WAVE_BUDGET_MS + (deepReadMode === 'off' ? 0 : JEV_WAVE_DEADLINE_MS);

    while (search.cursor < search.total) {
        if (!ctx.timer.canAfford(`Search wave @${search.cursor}`, waveBudgetMs)) {
            if (ctx.stepped) return { defer: true };
            recordDegradation(state, {
                step: 'Reconnaissance',
                reason: 'Time budget ran out before all searches completed.',
                impact: `${search.total - search.cursor} of ${search.total} searches were not run.`
            });
            break;
        }

        const wave = selected.slice(search.cursor, search.cursor + SEARCH_WAVE_SIZE);
        ctx.onProgress?.(`Executing surgical reconnaissance (${search.cursor + wave.length}/${search.total})...`);

        // Which window each query in this wave belongs to, so the provider tally below
        // can attribute a fallback to the evidence band it actually cost.
        const windowOf = wave.map(item => item.retrievalWindow || 'current');

        const waveResults = await mapWithConcurrency(wave, SEARCH_WAVE_SIZE, (item, i) =>
            searchQuery(item.query, {
                theme: item.theme,
                tier: item.tier || null,
                // Absent on a job checkpointed before windows existed; searchQuery
                // defaults it to 'current' rather than to unbounded.
                retrievalWindow: item.retrievalWindow,
                temporalPolicy: policy,
                queryIdx: search.cursor + i,
                geography: state.context?.operating_geography || null
            }).catch(e => {
                console.warn(`Query failed: ${item.query}`, e.message);
                return { observations: [], candidates: [] };
            })
        );

        await appendObservations(state, ctx, waveResults.flatMap(r => r.observations), 'Reconnaissance');
        const waveCandidates = waveResults.flatMap(r => r.candidates);
        await scoreDeepReadCandidates(state, waveCandidates, deepReadMode);
        search.candidates.push(...waveCandidates);
        // Absent on a query that threw — that is neither provider serving it, so it is
        // correctly counted as neither.
        for (let i = 0; i < waveResults.length; i++) {
            const r = waveResults[i];
            if (!r.sourceType || search.served[r.sourceType] === undefined) continue;
            search.served[r.sourceType] += 1;

            // Per-window tally. A Tavily outage that hits only context queries is a
            // different problem from one that hits current events — the first thins the
            // explanation, the second means the run has no news. The single global
            // {tavily, exa} count could not tell them apart, so "the brief looks thin"
            // arrived with no diagnosis attached.
            const w = windowOf[i] || 'current';
            if (!search.servedByWindow[w]) search.servedByWindow[w] = { tavily: 0, exa: 0 };
            search.servedByWindow[w][r.sourceType] += 1;
        }
        search.cursor += wave.length;
    }

    // A whole run served by the fallback is an outage, and it used to be invisible: the
    // per-query warning scrolled past in the server log while the report shipped looking
    // normal. Tavily was down for two weeks before anyone noticed. Surface it as a
    // degradation so it reaches the founder reading the brief, not just the log.
    //
    // Reported at most once — deep reads below can defer and re-enter this function, and
    // the same outage logged twice reads as two separate failures.
    if (search.served.tavily === 0 && search.served.exa > 0 && !search.fallbackReported) {
        search.fallbackReported = true;
        recordDegradation(state, {
            step: 'search',
            reason: `Tavily failed on all ${search.served.exa} searches; every source came from the Exa fallback`,
            // The old wording said the evidence "was not date-bounded". That is no longer
            // true: the fallback now carries both publication bounds. Saying otherwise
            // would disclose a limitation the run does not have, which is its own kind of
            // wrong — a founder discounting good evidence on a stale warning.
            impact: 'Evidence is unscored (no relevance filtering), though still date-bounded'
        });
    }

    // A fallback confined to ONE window is not a run-wide outage and would not trip the
    // check above — but it is still worth disclosing, because the two bands fail
    // differently. Losing Tavily on context queries thins the explanation; losing it on
    // current queries means the run may have no verified current event at all.
    if (!search.windowFallbackReported) {
        for (const [window, tally] of Object.entries(search.servedByWindow || {})) {
            if (tally.tavily === 0 && tally.exa > 0 && search.served.tavily > 0) {
                search.windowFallbackReported = true;
                recordDegradation(state, {
                    step: 'search',
                    reason: `Tavily failed on all ${tally.exa} ${window}-window searches; those came from the Exa fallback`,
                    impact: window === 'current'
                        ? 'Current-event evidence is unscored, so this run may verify fewer current events than usual.'
                        : 'Explanatory context for this run is unscored.'
                });
            }
        }
    }

    if (search.phase === 'search') {
        // A product run reads the product's own page(s) first, whatever search found. They
        // take slots from the same budget, never extra ones.
        const pinned = subjectDeepReadCandidates(
            runSubject(state.context, { analysisMode: ctx.job.analysisMode }), budget().maxDeepReads
        );
        const pinnedUrls = new Set(pinned.map(p => p.url));
        const searched = search.candidates.filter(c => !pinnedUrls.has(c.url));
        const searchReads = budget().maxDeepReads - pinned.length;
        const targets = [...pinned, ...selectDeepReadTargets(searched, searchReads, { useJev: deepReadMode === 'on' })];
        if (deepReadMode !== 'off') {
            // What the other mode would have read, so a shadow run says what switching Jev on
            // would change — the number that decides whether to switch it on at all.
            const other = [...pinned, ...selectDeepReadTargets(searched, searchReads, { useJev: deepReadMode !== 'on' })];
            const picked = new Set(targets.map(t => t.url));
            recordJevUse(state, {
                useCase: 'deep_reads', mode: deepReadMode,
                targets: targets.length,
                wouldChange: other.filter(t => !picked.has(t.url)).length,
            });
        }
        if (targets.length > 0) {
            if (!ctx.timer.canAfford('Deep reads', DEEP_READ_BUDGET_MS)) {
                if (ctx.stepped) return { defer: true };
                recordDegradation(state, {
                    step: 'Deep reads',
                    reason: 'Time budget ran out before top sources could be read in full.',
                    impact: `${targets.length} high-value source${targets.length === 1 ? '' : 's'} analyzed from search snippets only.`
                });
            } else {
                ctx.onProgress?.('Reading top sources in depth...');
                console.log(`[DeepRead] Selected ${targets.length}: ${targets.map(t => t.url).join(', ')}`);
                const reads = await mapWithConcurrency(targets, targets.length, t => deepReadUrl(t));
                await appendObservations(state, ctx, reads, 'Deep reads');
            }
        }
        search.phase = 'done';
    }

    ctx.timer.logStep('Search & Deep Reads');
}

/**
 * Jev's deep-read score for one wave's candidates, stored as `jevScore` (0–1) on each.
 *
 * Runs whenever the use case is not `off`; only `on` lets selectDeepReadTargets use the
 * score. The snippet is dropped either way before the candidate is checkpointed. Fails open:
 * a candidate Jev did not answer for simply has no score and ranks as neutral.
 */
async function scoreDeepReadCandidates(state, candidates, mode) {
    try {
        if (mode === 'off' || !candidates.length) return;
        if (state.search?.jevUnavailable) {
            recordJevUse(state, { useCase: 'deep_reads', mode, n: candidates.length, skipped: candidates.length });
            return;
        }
        const company = compactContext(state.context);
        const client = jevClient();
        const out = await client.decideEach(candidates, c => deepReadRequest(company, c), {
            useCase: 'deep_reads', deadlineMs: JEV_WAVE_DEADLINE_MS,
        });
        out.results.forEach((answers, i) => {
            const f = scoreFraction(answers?.depth);
            if (f !== null) candidates[i].jevScore = f;
        });
        // No key: one round trip told us, so later waves in this and later invocations do
        // not each ask again.
        if (client.isUnavailable() && state.search) state.search.jevUnavailable = true;
        recordJevUse(state, {
            useCase: 'deep_reads', mode, n: out.n, answered: out.answered, failed: out.failed, skipped: out.skipped,
            ...(client.isUnavailable() ? { unavailable: true } : {}),
        });
    } finally {
        for (const c of candidates) delete c.snippet;
    }
}

/**
 * Attach each discovered competitor's real URL from the search results it came out of.
 *
 * The model is shown "URL: ..." for every result and asked to infer a website, but it
 * populates the field inconsistently and sometimes invents a plausible-looking domain.
 * Matching on the brand token against the result hostnames is deterministic and only
 * ever attaches a URL we actually saw. A competitor we cannot match keeps whatever the
 * model gave (or nothing) and is left for primarySourceMapper to handle.
 */
function attachDiscoveredUrls(competitors, searchResults) {
    const byToken = new Map();
    for (const r of searchResults || []) {
        if (!r?.url) continue;
        try {
            const host = new URL(r.url).hostname.replace(/^www\./, '');
            // "acme-health.com" → "acmehealth", so it can match the brand token of "Acme Health".
            const token = normalizeBrandToken(host.split('.')[0]);
            if (token && token.length >= 3 && !byToken.has(token)) {
                byToken.set(token, `https://${host}`);
            }
        } catch { /* unparseable result URL — skip */ }
    }

    return competitors.map(c => {
        const token = normalizeBrandToken(typeof c === 'object' ? c.name : c);
        if (!token || token.length < 3) return c;

        // Exact token match first, then containment (host "acmehealthapp" for "Acme Health").
        const matched = byToken.get(token)
            || [...byToken.entries()].find(([t]) => t.includes(token) || token.includes(t))?.[1];

        return matched ? { ...c, url: matched, url_source: 'discovered' } : c;
    });
}

// ─── watch ────────────────────────────────────────────────────────────────
// Read the tracked entities' OWN pages (pricing, changelog, careers, press) and emit an
// observation only where one changed since the last run. Costs no query budget — these
// URLs are already stored by primarySourceMapper — and produces the only first-party
// evidence in the run. See src/services/sourceWatch.js for the two rules that govern it.

async function stepWatch(state, ctx) {
    // Source Watch only compounds across runs spread over time, so it is the first thing
    // a single free run can do without: it re-reads tracked entities' own pages and emits
    // only what changed since last time, and a first run has no baseline to diff against.
    if (!budget().sourceWatch) {
        recordDepthGap(state, { step: 'watch', skipped: 'Primary-source checks of tracked companies’ own pages' });
        return;
    }

    const companyId = ctx.job.clientId;
    // Without a client there is no entity_sources table to read and no snapshot history
    // to diff against, so the whole step is inert.
    if (!companyId) return;

    if (!state.watch) state.watch = { cursor: 0, checked: 0, changed: 0, deferCount: 0 };

    if (!ctx.timer.canAfford('Source watch', WATCH_BUDGET_MS)) {
        // Bounded for the same reason stepVerify's defer is: this path moves no work, so
        // the cursor it contributes to the worker's forward-progress fingerprint has to
        // advance or the guard aborts the run. One defer buys a fresh STEP_MAX_MS; if
        // that still isn't enough the budget cannot pay for this step at all.
        if (ctx.stepped && state.watch.deferCount < MAX_WATCH_DEFERS) {
            state.watch.deferCount += 1;
            state.watch.cursor += 1;
            return { defer: true };
        }
        recordDegradation(state, {
            step: 'Source watch',
            reason: 'Time budget ran out before tracked sources could be checked.',
            impact: 'Competitor pricing, changelog and careers pages were not read this run.'
        });
        return;
    }

    try {
        const sources = await getEntitySources(companyId);
        if (!sources.length) {
            console.log('[SourceWatch] No tracked sources for this company yet');
            return;
        }

        ctx.onProgress?.('Checking tracked competitor pages for changes...');

        const { observations, checked, changed } = await watchSources(sources, {
            // watchSource wants `(url) => Promise<string|null>`; fetchPageExtract returns
            // the richer `{ text, source, title, publishDate }` this branch replaced
            // fetchFirecrawlScrape with. Adapt rather than widen watchSource's contract —
            // a watch only ever compares page text against the last snapshot.
            scrape: async (url) => (await fetchPageExtract(url))?.text || null,
            runId: state.runId,
            limit: MAX_WATCH_FETCHES_PER_RUN,
            // Each fetch is a scrape with a real timeout; stop before overrunning the step.
            canAfford: () => ctx.timer.canAfford('Source watch fetch', SINGLE_WATCH_FETCH_MS),
        });

        const kept = await judgePageChanges(state, ctx, observations);
        await appendObservations(state, ctx, kept);
        state.watch.checked = checked;
        state.watch.changed = changed;
        state.watch.suppressed = observations.length - kept.length;
        // Advancing on every pass keeps the worker's forward-progress fingerprint moving
        // even when nothing changed, which is the common case.
        state.watch.cursor += 1;
    } catch (err) {
        // A failed watch must never fail the run — the rest of the evidence still ships.
        console.warn('[SourceWatch] Step failed (non-blocking):', err.message);
        recordDegradation(state, {
            step: 'Source watch',
            reason: 'Tracked source pages could not be read.',
            impact: 'This run has no first-party evidence from competitor pages.'
        });
    }

    ctx.timer.logStep('Source Watch');
}

// Jev on Source Watch changes (JEV_WATCH). The hash rule already drops unchanged pages; a
// changed hash still includes a rotated banner, a new footer date or a cookie notice. `on`:
// a change Jev puts below WATCH_SUBSTANTIVE_BELOW is not handed to the analyzer. The snapshot
// was recorded before this runs, so a suppressed change is never re-judged next run.
const WATCH_JEV_DEADLINE_MS = 4000;
const WATCH_SUBSTANTIVE_BELOW = 0.3;

async function judgePageChanges(state, ctx, observations) {
    const mode = jevModeFor('watch');
    if (mode === 'off' || !observations.length) return observations;
    if (!ctx.timer.canAfford('Watch materiality', WATCH_JEV_DEADLINE_MS)) {
        recordJevUse(state, { useCase: 'watch', mode, n: observations.length, skipped: observations.length });
        return observations;
    }

    const company = compactContext(state.context);
    const out = await jevClient().decideEach(observations, o => pageChangeRequest(company, o.data), {
        useCase: 'watch', deadlineMs: WATCH_JEV_DEADLINE_MS,
    });
    const minor = out.results.map(a => {
        const p = pYes(a?.substantive);
        return p !== null && p < WATCH_SUBSTANTIVE_BELOW;
    });
    recordJevUse(state, {
        useCase: 'watch', mode, n: out.n, answered: out.answered, failed: out.failed, skipped: out.skipped,
        wouldSuppress: minor.filter(Boolean).length,
    });
    return mode === 'on' ? observations.filter((_, i) => !minor[i]) : observations;
}

// ─── collect ──────────────────────────────────────────────────────────────
// Structured sources that keyword search cannot reach: live tenders, regulatory
// filings, and the engagement metadata the search index strips off social threads.
// Costs no query budget — these are direct API calls, not searches. Every connector is
// off by default and self-disables when its key is absent; see connectorRegistry.js.

/** One connector call through the server-side gateway. Never throws. */
async function callConnector(call) {
    try {
        const r = await intelligenceRuntime.postJson(`${API_BASE}/connectors`, {
            source: call.source,
            ...call.params,
        });
        if (!r.ok) return { observations: [], error: `HTTP ${r.status}` };
        return await r.json();
    } catch (err) {
        return { observations: [], error: err.message };
    }
}

async function stepCollect(state, ctx) {
    // Tenders, filings and social engagement are the sources search cannot reach — which
    // makes them exactly the kind of evidence worth paying for, and the kind a shallow run
    // names as missing rather than quietly omitting.
    if (!budget().connectors) {
        recordDepthGap(state, { step: 'collect', skipped: 'Live tenders, regulatory filings and social engagement' });
        return;
    }

    if (!state.collect) state.collect = { cursor: 0, calls: null, collected: 0, deferCount: 0 };
    const collect = state.collect;

    // Plan once, then work the list across invocations — replanning each time would
    // re-run connectors already paid for.
    if (!collect.calls) {
        const { calls, skipped } = planConnectorCalls(state.context);
        collect.calls = calls;

        if (calls.length === 0) {
            // Nothing enabled is the normal state until a connector is switched on, so
            // it is logged rather than disclosed — an off feature is not a degradation.
            console.log(`[Connectors] No calls planned (${skipped.map(s => `${s.source}: ${s.reason}`).join('; ') || 'none registered'})`);
            return;
        }
        console.log(`[Connectors] Planned ${calls.length} call(s): ${calls.map(c => c.source).join(', ')}`);
    }

    while (collect.cursor < collect.calls.length) {
        if (!ctx.timer.canAfford('Connector call', SINGLE_CONNECTOR_MS)) {
            // Bounded, like stepWatch and stepVerify: this defer performs no work, so the
            // cursor it contributes to the worker's fingerprint must move or the
            // forward-progress guard aborts a run that is otherwise fine.
            if (ctx.stepped && collect.deferCount < MAX_COLLECT_DEFERS) {
                collect.deferCount += 1;
                return { defer: true };
            }
            recordDegradation(state, {
                step: 'Structured sources',
                reason: 'Time budget ran out before all structured sources were queried.',
                impact: `${collect.calls.length - collect.cursor} source(s) not checked — tenders and filings may be missing.`
            });
            break;
        }

        const call = collect.calls[collect.cursor];
        ctx.onProgress?.(`Checking ${call.label}...`);

        const result = await callConnector(call);
        collect.cursor += 1;

        if (result.disabled) {
            // A missing key is a configuration fact, not a failure. Disclose it once so
            // a founder is never told a source was checked when it never ran.
            recordDegradation(state, {
                step: 'Structured sources',
                reason: `${call.label} is not configured (${call.needs || 'missing credential'}).`,
                impact: 'This source contributed no evidence to the brief.'
            });
            continue;
        }

        if (result.error) {
            // Best-effort sources (GeM scrapes markup we do not control) are expected to
            // break; they still get disclosed rather than silently dropped.
            recordDegradation(state, {
                step: 'Structured sources',
                reason: `${call.label} could not be read (${String(result.error).slice(0, 120)}).`,
                impact: call.reliability === 'best-effort'
                    ? 'This source has no public API and is read on a best-effort basis.'
                    : 'This source contributed no evidence to the brief.'
            });
            continue;
        }

        const observations = (result.observations || []).slice(0, MAX_OBSERVATIONS_PER_CONNECTOR);
        if (observations.length > 0) {
            await appendObservations(state, ctx, observations);
            collect.collected += observations.length;
            console.log(`[Connectors] ${call.source} → ${observations.length} observation(s)`);
        }
    }

    ctx.timer.logStep('Structured Sources');
}

// ─── v6_pipeline ──────────────────────────────────────────────────────────

async function stepV6Pipeline(state, ctx) {
    const companyId = ctx.job.clientId;
    if (!companyId || !ctx.timer.canAfford('v6 Pipeline', 30000)) return;

    try {
        // A checkpoint from before `memory` took the baseline has none. Read it now, still
        // before clustering, which is correct for every attempt but a replay.
        if (state.v6.baseline === undefined) {
            state.v6.baseline = await getPatternBaseline(companyId);
            state.v6.since = state.v6.since || new Date().toISOString();
        }
        const { baseline, since } = state.v6;

        ctx.onProgress?.('Running pattern engine...');
        const patterns = await clusterObservations(companyId);
        state.v6.patterns = patterns;

        if (patterns.length > 0) {
            ctx.onProgress?.('Scanning for structural shifts...');
            if (baseline === null) {
                recordDegradation(state, {
                    step: 'Pattern and shift detection',
                    reason: 'The previous patterns could not be read, so there was nothing to measure a shift against.',
                    impact: 'No shifts could be detected this run; patterns, blind spots and opportunities are unaffected.'
                });
            }
            state.v6.shifts = await detectShifts(companyId, patterns, baseline);

            ctx.onProgress?.('Analyzing blind spots & opportunities...');
            const [blindSpots, opportunities] = await Promise.all([
                detectBlindSpots(companyId, patterns, state.context, { since }),
                detectOpportunities(companyId, patterns, state.context, { since })
            ]);
            state.v6.blindSpots = blindSpots;
            state.v6.opportunities = opportunities;

            await scoreStructuralFindings(state);
        }

        // Only this step reads it, and a completed step is never replayed.
        delete state.v6.baseline;

        console.log(`[v6] Pipeline: patterns=${state.v6.patterns.length}, shifts=${state.v6.shifts.length}, blindSpots=${state.v6.blindSpots.length}, opportunities=${state.v6.opportunities.length}`);
        ctx.timer.logStep('v6 Pipeline');
    } catch (v6Err) {
        console.warn('[v6] Pipeline error (non-blocking):', v6Err.message);
    }
}

// Jev on the engines' findings (JEV_SYNTHESIS). The engines decide what is a candidate by
// thresholds and substring matches; Jev asks whether this run's evidence for the theme
// actually shows it. `on`: a finding below SYNTHESIS_DROP_BELOW leaves the report, and the
// rest carry a confidence no higher than the evidence supports. The engines' database rows
// are untouched either way — they are the dedupe memory across runs, not the report.
const SYNTHESIS_DEADLINE_MS = 6000;
const SYNTHESIS_EVIDENCE_ROWS = 12;
const SYNTHESIS_DROP_BELOW = 0.2;
const BAND_RANK = { Low: 0, Medium: 1, High: 2 };

/** This run's evidence for a theme, one short line per source. */
function themeEvidence(observations, theme) {
    return observations
        .filter(o => (o.theme || 'general') === theme && o.data)
        .slice(0, SYNTHESIS_EVIDENCE_ROWS)
        .map(o => {
            const text = String(o.data);
            const title = String(o.title || text.split('\n')[0] || '').replace(/^TITLE:\s*/, '').slice(0, 160);
            const body = text.replace(/^(TITLE|URL):.*$/gm, '').replace(/^CONTENT:\s*/m, '').replace(/\s+/g, ' ').trim().slice(0, 280);
            return `- ${title} (${o.url || 'no url'}): ${body}`;
        })
        .join('\n');
}

async function scoreStructuralFindings(state) {
    const mode = jevModeFor('synthesis');
    if (mode === 'off') return;

    const v6 = state.v6;
    const items = [
        ...v6.shifts.map(finding => ({ kind: 'shift', finding })),
        // An untested bet is a finding about ABSENT evidence; there is nothing to ask of it.
        ...v6.blindSpots.filter(b => b?.blind_spot_type !== 'untested_assumption').map(finding => ({ kind: 'blind_spot', finding })),
        ...v6.opportunities.map(finding => ({ kind: 'opportunity', finding })),
    ].filter(i => i.finding?.theme);
    if (!items.length) return;

    const observations = await loadObservations(state);
    const company = compactContext(state.context);
    const companyName = state.context?.company_name || 'the company';
    const client = jevClient();
    const out = await client.decideEach(items, ({ kind, finding }) => findingRequest(company, {
        kind, theme: finding.theme, finding, companyName, evidence: themeEvidence(observations, finding.theme),
    }), { useCase: 'synthesis', deadlineMs: SYNTHESIS_DEADLINE_MS });

    const verdicts = new Map();
    let wouldDrop = 0, wouldLower = 0;
    items.forEach(({ finding }, i) => {
        const p = pYes(out.results[i]?.supported);
        if (p === null) return;
        const band = confidenceBand(p);
        const lowered = finding.confidence && BAND_RANK[band] < (BAND_RANK[finding.confidence] ?? 3);
        if (p < SYNTHESIS_DROP_BELOW) wouldDrop++;
        else if (lowered) wouldLower++;
        verdicts.set(finding, { p, band });
    });

    recordJevUse(state, {
        useCase: 'synthesis', mode, n: out.n, answered: out.answered, failed: out.failed, skipped: out.skipped,
        wouldDrop, wouldLower,
        findings: items.map(({ kind, finding }) => ({ kind, theme: finding.theme, p: verdicts.get(finding)?.p ?? null })),
    });
    if (mode !== 'on') return;

    // Never raises a confidence: Jev can say the evidence is weaker than the engine assumed,
    // not stronger than the evidence count supports.
    const apply = (list) => list.flatMap(finding => {
        const v = verdicts.get(finding);
        if (!v) return [finding];
        if (v.p < SYNTHESIS_DROP_BELOW) return [];
        const current = finding.confidence;
        const confidence = current && BAND_RANK[current] !== undefined && BAND_RANK[current] < BAND_RANK[v.band] ? current : v.band;
        return [{ ...finding, confidence, jev_p: Math.round(v.p * 100) / 100 }];
    });
    v6.shifts = apply(v6.shifts);
    v6.blindSpots = apply(v6.blindSpots);
    v6.opportunities = apply(v6.opportunities);
}

// ─── analyze ──────────────────────────────────────────────────────────────

const MAX_SNIPPET_CHARS = 1200; // title + first ~1200 chars (batch of 15 ≈ 20K chars ≈ 5-6K tokens)

// A deep read is bought for what sits below the fold — the finding on page 9 of a report
// whose first 1,200 chars are its cover and abstract. At the snippet budget it delivered
// ~9% of the page, no more than the search result it replaced (Tavily already returns full
// page text), so the paid read added close to nothing. Batches are bounded by BATCH_SIZE
// long before MAX_SIGNAL_PAYLOAD_CHARS (15 snippets ≈ 21K of a 40K budget), so this
// buys input tokens inside batches the run was already making, not extra batches.
export const DEEP_READ_SNIPPET_CHARS = 6000;
const MAX_TITLE_CHARS = 300;

/** Render one observation for the LLM. `displayIdx` is its 0-based position in the run. */
export function compressObservation(obs, displayIdx) {
    const sourceUrl = obs.url || 'Source unknown';
    const sourceType = obs.isDeepRead ? '[Deep]' : '[Search]';
    const rawData = String(obs.data || '');
    const firstLine = rawData.split('\n').find(l => l.trim().length > 10) || '';
    const pubDate = obs.published_date ? ` (published: ${obs.published_date})` : '';
    const header = `[${displayIdx + 1}] ${sourceType} ${sourceUrl}${pubDate}`;

    if (obs.isDeepRead) {
        // Extracted page text has no `TITLE:` line of its own, so the search-row logic below
        // would promote its first line to a title — and an extract with no line breaks would
        // pass whole, uncapped. Use the known title, and bound both parts.
        const known = String(obs.title || '').trim();
        const title = `TITLE: ${(known || firstLine).slice(0, MAX_TITLE_CHARS)}`;
        const start = known ? 0 : Math.max(0, rawData.indexOf(firstLine)) + Math.min(firstLine.length, MAX_TITLE_CHARS);
        const body = rawData.substring(start, start + DEEP_READ_SNIPPET_CHARS).replace(/\n+/g, ' ').trim();
        return `${header}\n${title}\n${body}`;
    }

    const title = firstLine.startsWith('TITLE:') ? firstLine : `TITLE: ${firstLine}`;
    const snippetStart = rawData.indexOf('\n', firstLine.length) + 1;
    const snippet = rawData.substring(snippetStart, snippetStart + MAX_SNIPPET_CHARS).replace(/\n+/g, ' ').trim();
    return `${header}\n${title}\n${snippet}`;
}

/**
 * Reduce a URL to a comparable key so the same page fetched by two channels collapses.
 *
 * Deliberately conservative: scheme, `www.`, a trailing slash and tracking parameters are
 * noise, but a path or a real query parameter can be the whole difference between two
 * pages on the same site. Anything unparseable falls back to the raw string rather than
 * being merged with something it may not equal.
 */
export function normalizeObservationUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    try {
        const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
        for (const key of [...u.searchParams.keys()]) {
            // `utm_` is a PREFIX (utm_source, utm_medium, …); the rest are exact names.
            if (/^utm_/i.test(key) || /^(fbclid|gclid|mc_cid|mc_eid|ref|source)$/i.test(key)) {
                u.searchParams.delete(key);
            }
        }
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        const path = u.pathname.replace(/\/+$/, '');
        return `${host}${path}${u.searchParams.toString() ? `?${u.searchParams}` : ''}`;
    } catch {
        return raw.replace(/\/+$/, '').toLowerCase();
    }
}

/**
 * Cap the observation count while preserving source-class diversity.
 *
 * The cost of a run scales with observations, not searches — each one may add an analyze
 * batch — so this is the ceiling that keeps the expanded evidence base inside its budget.
 *
 * A plain `.slice(0, cap)` would have been wrong in a way that is invisible in the code
 * and obvious in the report: observations arrive grouped by channel, and search runs
 * first, so truncation would evict the tender, filing and primary-page evidence wholesale
 * and leave a run that is nominally "capped" but back to being all press coverage. Instead
 * this round-robins across classes, strongest provenance first, so a cap thins every class
 * rather than deleting the rarest ones.
 */
export function capObservations(observations, cap = MAX_OBSERVATIONS_TOTAL, { scoreById = null } = {}) {
    if (!Array.isArray(observations) || observations.length <= cap) return observations;

    // Rarest-and-strongest first. `unclassified` is last: it is almost entirely untiered
    // general search, which is the most abundant and the least distinctive evidence we have.
    const CLASS_ORDER = [
        'primary_company', 'filing', 'tender', 'government', 'review',
        'research', 'analyst', 'code', 'social', 'news', 'unclassified',
    ];

    const buckets = new Map(CLASS_ORDER.map(c => [c, []]));
    observations.forEach((obs, index) => {
        const cls = obs?.source_class && buckets.has(obs.source_class) ? obs.source_class : 'unclassified';
        buckets.get(cls).push({ obs, index });
    });

    // With Jev triage on, each class keeps its most material rows rather than its earliest.
    // Only the order WITHIN a class changes: every class still gets its round-robin share,
    // so a relevance score can never evict a whole class of rare evidence. Unscored rows
    // rank as neutral; ties keep arrival order, so the selection stays deterministic.
    if (scoreById) {
        const rank = (entry) => rankFraction(scoreById[entry.obs?.id]);
        for (const bucket of buckets.values()) bucket.sort((a, b) => rank(b) - rank(a) || a.index - b.index);
    }

    const kept = [];
    let exhausted = false;
    for (let round = 0; kept.length < cap && !exhausted; round++) {
        exhausted = true;
        for (const cls of CLASS_ORDER) {
            if (kept.length >= cap) break;
            const bucket = buckets.get(cls);
            if (round >= bucket.length) continue;
            kept.push(bucket[round]);
            exhausted = false;
        }
    }

    // Restore the original ordering. Selection decides WHAT survives; it must not also
    // silently reorder the batches, which would change what the model sees together.
    const out = kept.sort((a, b) => a.index - b.index).map(k => k.obs);
    console.log(`[Pipeline] Capped ${observations.length} → ${out.length} observations (class-balanced)`);
    return out;
}

/**
 * The rows the observation cap chooses among: gated, deduped and relevance-filtered, in
 * arrival order. Everything planAnalyzeBatches does before the cap — split out so the triage
 * step scores exactly the rows the cap will see, through the same code.
 */
export function analyzeCandidates(observations) {
    // ═══ GATEKEEPING ═══
    const gated = observations.filter(o => o.data && o.data.length > 50);
    console.log(`After Gating: ${gated.length} observations`);

    // Dedupe on a NORMALIZED url. Exact-string matching was adequate when every
    // observation came from Tavily; with connectors, source watch and Exa all feeding the
    // same stream, the identical press release arrives as http/https, with and without
    // www, with and without a trailing slash or a utm_ tail — and each variant was paid
    // for twice: once in an analyze batch, once as a duplicate signal to deduplicate later.
    //
    // A deep read always shares its URL with the search result it was chosen from, and the
    // stepped pipeline reads rows back ordered by a random UUID. First-seen-wins therefore
    // discarded roughly half of all deep reads — a paid full-page read thrown away in favour
    // of the snippet it was bought to replace. Where a deep read exists, it stands in for
    // its URL regardless of order.
    const deepReadKeys = new Set(
        gated.filter(o => o.isDeepRead && o.url).map(o => normalizeObservationUrl(o.url))
    );
    const seenUrls = new Set();
    const deduped = gated.filter(obs => {
        if (!obs.url) return false;
        const key = normalizeObservationUrl(obs.url);
        if (seenUrls.has(key)) return false;
        if (!obs.isDeepRead && deepReadKeys.has(key)) return false;
        seenUrls.add(key);
        return true;
    });
    console.log(`After dedup: ${deduped.length} unique observations (from ${gated.length})`);

    // Pre-filter by relevance score — drop low-quality results (§5.9).
    //
    // `?? 1` is load-bearing for everything that is not a Tavily search result: deep reads
    // and Exa rows both carry a null score (Exa exposes no comparable relevance measure —
    // see fetchExaSearch), and coercing null to 0 would discard all of them. This gate is
    // Tavily-only by construction, not by accident.
    let scored = deduped.filter(obs => (obs.score ?? 1) >= MIN_TAVILY_SCORE);

    // Low-yield fallback. When the relevance bar leaves almost nothing, the bar — not the
    // evidence — is the problem, so drop it once rather than analyze a near-empty batch.
    // Restored after a merge dropped it: the branch that introduced Parallel AI had
    // `const scored` with no fallback, main had `let scored` plus this block and the cap
    // below. The resolution kept `const` AND the reassignment, so every run died at `analyze`
    // with "Assignment to constant variable" — found by the first live run against the merged
    // 15-step pipeline, not by any test, because no test executes this function.
    if (scored.length < MIN_ANALYZE_YIELD && deduped.length > scored.length) {
        // Take the best available rather than lowering to another fixed number.
        //
        // This used to re-filter at `fallbackScore = 0.15` — the SAME value as
        // MIN_TAVILY_SCORE — so it logged "lowering threshold to maximize yield" and changed
        // nothing. Someone lowered MIN_TAVILY_SCORE to 0.15 and the fallback silently became
        // a no-op. Verified against the live function: 20 observations scoring 0.14 produced
        // 20 gated and 0 batched, i.e. an empty analysis with a log line claiming a rescue.
        //
        // Ranking sidesteps that whole class of staleness: there is no second constant to
        // drift out of step with the first, and a run with weak-but-real evidence analyzes it
        // instead of producing nothing. This lowers the RETRIEVAL bar only — the grounding
        // gate and the verifier still decide what may be published, so weak observations
        // cannot become unsupported findings.
        const best = [...deduped].sort((a, b) => (b.score ?? 1) - (a.score ?? 1)).slice(0, MIN_ANALYZE_YIELD);
        console.log(`[Pipeline] Only ${scored.length} result(s) met ${MIN_TAVILY_SCORE}. Taking the top ${best.length} by score instead of analyzing nothing.`);
        scored = best;
    }

    if (scored.length < deduped.length) {
        console.log(`After relevance filter: ${scored.length} (dropped ${deduped.length - scored.length})`);
    }

    return { scored, gatedCount: gated.length };
}

/**
 * Deterministically gate, dedupe, filter and batch a run's observations. Returns ordered ids.
 * `scoreById` (obs id → Jev materiality, 0–1) is passed only when JEV_TRIAGE=on; see
 * capObservations for the one thing it may change.
 */
export function planAnalyzeBatches(observations, cap = null, { scoreById = null } = {}) {
    const { scored: candidates, gatedCount } = analyzeCandidates(observations);

    // Hard ceiling on what reaches the LLM. Applied after relevance filtering so the cap
    // thins good evidence rather than being spent on results we were going to drop anyway.
    // Express analysed some observations outside this plan, so its share must come off
    // the ceiling or the run quietly exceeds the cap that governs its LLM spend.
    const scored = capObservations(candidates, cap ?? budget().maxObservations, { scoreById });

    const perBatchLimit = Math.floor(MAX_SIGNAL_PAYLOAD_CHARS / 2); // ~40K per batch
    const batches = [];
    let currentBatch = [];
    let currentBatchChars = 0;

    scored.forEach((obs, idx) => {
        const length = compressObservation(obs, idx).length;
        if (currentBatch.length >= BATCH_SIZE || currentBatchChars + length > perBatchLimit) {
            if (currentBatch.length > 0) batches.push(currentBatch);
            currentBatch = [];
            currentBatchChars = 0;
        }
        currentBatch.push(obs.id);
        currentBatchChars += length;
    });
    if (currentBatch.length > 0) batches.push(currentBatch);

    return { order: scored.map(o => o.id), batches, gatedCount };
}

/**
 * The observations the main analysis plans over, and the ceiling it plans against. Shared by
 * `triage` and `analyze` so the rows triage scores are exactly the rows analysis receives —
 * a copy of these rules in either step is how the two would drift apart.
 */
async function analyzeInput(state) {
    // Express already analysed some of these. Excluding by id alone leaks: the dedupe
    // inside planAnalyzeBatches builds its url set from its OWN input and cannot know
    // what express read, so the same story arriving http:// from express and https://
    // from search would be paid for twice.
    const expressIds = new Set(state.express?.obsIds || []);
    const expressUrls = new Set(state.express?.urlKeys || []);
    // A deep read is exempt from the URL half. Express saw that page as a snippet; the
    // full read is the part it never had, not the same story paid for twice.
    const observations = (await loadObservations(state)).filter(o =>
        !expressIds.has(o.id) && (o.isDeepRead || !expressUrls.has(normalizeObservationUrl(o.url)))
    );
    // The monolith's in-memory observations have no database id. Give them a stable
    // one so batch membership can be expressed the same way in both drivers.
    observations.forEach((o, i) => { if (o.id == null) o.id = `mem:${i}`; });

    const remainingCap = Math.max(0, budget().maxObservations - (state.express?.analyzedCount || 0));
    return { observations, remainingCap };
}

// ─── triage ───────────────────────────────────────────────────────────────
// Jev's materiality score for the rows the observation cap chooses among. It matters only
// when the cap binds — then `on` lets each source class keep its most material rows instead
// of its earliest (capObservations). It never removes a row the cap would have kept for
// lack of candidates, and never touches a run under the cap, so it is skipped there.

// One slice of requests: ~40 at concurrency 8 is ~2-3s against a healthy vendor.
const TRIAGE_SLICE = 40;
const TRIAGE_SLICE_DEADLINE_MS = 8000;

async function stepTriage(state, ctx) {
    const mode = jevModeFor('triage');
    if (mode === 'off') return;

    if (!state.triage) {
        const { observations, remainingCap } = await analyzeInput(state);
        const quietLog = console.log;
        console.log = () => {};
        let candidates;
        try { ({ scored: candidates } = analyzeCandidates(observations)); }
        finally { console.log = quietLog; }
        const binds = candidates.length > remainingCap;
        state.triage = { mode, ids: binds ? candidates.map(o => o.id) : [], cursor: 0, scores: {}, binds };
        recordJevUse(state, { useCase: 'triage', mode, binds, candidates: candidates.length, cap: remainingCap });
        if (!binds) return;
        ctx.onProgress?.('Ranking evidence by materiality...');
    }

    const t = state.triage;
    const company = compactContext(state.context);
    const client = jevClient();
    const startCursor = t.cursor;

    while (t.cursor < t.ids.length) {
        if (client.isUnavailable()) {
            const left = t.ids.length - t.cursor;
            recordJevUse(state, { useCase: 'triage', mode, n: left, skipped: left, unavailable: true });
            t.cursor = t.ids.length;
            break;
        }
        if (!ctx.timer.canAfford(`Triage @${t.cursor}`, TRIAGE_SLICE_DEADLINE_MS + 1000)) {
            // Defer only after moving the cursor: a fresh invocation that cannot afford one
            // slice never will, and deferring on an unmoved cursor aborts the run.
            if (ctx.stepped && t.cursor > startCursor) return { defer: true };
            // Never a degradation: an unscored row is ranked neutral, which is exactly what
            // the cap did before triage existed. Recorded so the shadow data says so.
            const left = t.ids.length - t.cursor;
            recordJevUse(state, { useCase: 'triage', mode, n: left, skipped: left });
            t.cursor = t.ids.length;
            break;
        }

        const sliceIds = t.ids.slice(t.cursor, t.cursor + TRIAGE_SLICE);
        const byId = new Map((await loadObservations(state, sliceIds)).map(o => [o.id, o]));
        const slice = sliceIds.map(id => byId.get(id) || null);
        const out = await client.decideEach(slice, (o, i) => (o
            ? materialityRequest(company, compressObservation(o, t.cursor + i))
            : null), { useCase: 'triage', deadlineMs: TRIAGE_SLICE_DEADLINE_MS });
        out.results.forEach((answers, i) => {
            const f = scoreFraction(answers?.material);
            if (f !== null) t.scores[sliceIds[i]] = f;
        });
        recordJevUse(state, { useCase: 'triage', mode, n: out.n, answered: out.answered, failed: out.failed, skipped: out.skipped });
        t.cursor += sliceIds.length;
    }

    ctx.timer.logStep('Triage');
}

async function stepAnalyze(state, ctx) {
    // `state.memory` is null when a partial run skips the `memory` step, so the lookback is
    // resolved once here with the same fallback every other step uses.
    const lookbackMonths = state.memory?.lookbackMonths ?? LOOKBACK_MONTHS_FIRST_RUN;
    if (!state.analyze) {
        ctx.onProgress?.('Filtering signal noise...');
        const { observations, remainingCap } = await analyzeInput(state);

        // Triage scores change the plan only when JEV_TRIAGE=on. In shadow the alternative
        // plan is computed too, and how many rows it would have swapped is recorded.
        const triage = state.triage?.binds ? state.triage : null;
        const useJev = triage?.mode === 'on';
        const { order, batches, gatedCount } = planAnalyzeBatches(observations, remainingCap, useJev ? { scoreById: triage.scores } : {});
        if (triage) {
            const quietLog = console.log;
            console.log = () => {};
            let otherOrder;
            try {
                ({ order: otherOrder } = planAnalyzeBatches(observations, remainingCap, useJev ? {} : { scoreById: triage.scores }));
            } finally { console.log = quietLog; }
            const kept = new Set(order);
            recordJevUse(state, { useCase: 'triage', mode: triage.mode, wouldChange: otherOrder.filter(id => !kept.has(id)).length });
        }
        state.analyze = {
            order, batches, cursor: 0,
            // Seeded INSIDE the literal, not after: the `empty` early-return below would
            // otherwise drop every express signal on a run that found nothing else.
            signals: [...(state.express?.signals || [])],
            empty: gatedCount === 0 && (state.express?.signals || []).length === 0
        };

        // An empty plan still has to fall through when express contributed signals, or they
        // reach `summary` un-deduped and without the freshness downgrade.
        if (state.analyze.empty && state.analyze.signals.length === 0) return;
        console.log(`Signal analysis: ${batches.length} batches (${order.length} observations)`);
    }

    const a = state.analyze;
    // An empty plan with express signals must still fall through: `batches` is [] so the
    // loop below is a no-op, but the dedupe and freshness downgrade after it are not.
    if (a.empty && a.signals.length === 0) return;

    const orderIndex = new Map(a.order.map((id, i) => [id, i]));
    let failedBatches = 0;

    while (a.cursor < a.batches.length) {
        if (!ctx.timer.canAfford(`Signal Batch ${a.cursor + 1}`, ANALYZE_BATCH_BUDGET_MS)) {
            if (ctx.stepped) return { defer: true };
            recordDegradation(state, {
                step: 'Signal analysis',
                reason: 'Time budget ran out before all evidence was analyzed.',
                impact: `${a.batches.length - a.cursor} of ${a.batches.length} analysis batches were skipped — signals may be missing.`
            });
            break;
        }

        const batchIds = a.batches[a.cursor];
        const batchObs = await loadObservations(state, batchIds);
        // loadObservations does not promise input order; restore the planned order so the
        // numbering the model sees matches the batch plan.
        batchObs.sort((x, y) => (orderIndex.get(x.id) ?? 0) - (orderIndex.get(y.id) ?? 0));

        const batchText = batchObs.map(o => compressObservation(o, orderIndex.get(o.id) ?? 0)).join('\n\n');
        const batchLabel = a.batches.length > 1 ? ` (batch ${a.cursor + 1}/${a.batches.length})` : '';
        ctx.onProgress?.(`Analyzing intelligence${batchLabel}...`);

        try {
            // Use a longer inter-batch delay if 429s were already seen this run.
            let batchDelay = a.cursor === 0 ? 500 : (circuitBreaker.consecutive429s > 0 ? 30000 : 2000);
            if (ctx.stepped) batchDelay = Math.min(batchDelay, STEPPED_MAX_BATCH_DELAY_MS);
            if (batchDelay > 2000) console.log(`[Pipeline] Waiting ${batchDelay / 1000}s before batch ${a.cursor + 1} due to prior 429s...`);
            await new Promise(r => setTimeout(r, batchDelay));

            // Limit previous-signal context to 5 most recent — prevents over-deduplication
            // that suppresses valid new signals when data is similar to prior runs.
            const signalPayload = {
                context: state.context,
                searchResults: batchText,
                temporalPolicy: runPolicy(state),
                previousSignals: [...(state.memory?.previousSignalsTail || []), ...a.signals],
                // Opt-in: ask the gateway to require a verbatim evidence_quote per signal.
                quoteBinding: SIGNAL_QUOTE_BINDING
            };

            const result = await callLLMWithRetry('analyzeSignals', signalPayload);
            let batchSignals = normalizeSignalResponse(result);

            // Retry with split batch if 0 signals returned (weak LLM or thin content)
            if (batchSignals.length === 0 && batchObs.length > 3) {
                console.warn(`[Pipeline] Batch ${a.cursor + 1} returned 0 signals — retrying with split batch`);
                await new Promise(r => setTimeout(r, 1500));
                const half = Math.ceil(batchObs.length / 2);
                const splitText = batchObs.slice(0, half).map(o => compressObservation(o, orderIndex.get(o.id) ?? 0)).join('\n\n');
                try {
                    const retryResult = await callLLMWithRetry('analyzeSignals', { ...signalPayload, searchResults: splitText });
                    batchSignals = normalizeSignalResponse(retryResult);
                    console.log(`[Pipeline] Split retry: ${batchSignals.length} signals`);
                } catch (retryErr) {
                    console.warn(`[Pipeline] Split retry failed:`, retryErr.message);
                }
            }

            // The full filter chain: grounding (against batchObs, the authoritative URL
            // set), quote-binding when enabled, read guard, self guard, provenance.
            batchSignals = applySignalFilters(batchSignals, batchText, state.context?.company_name, batchObs);

            console.log(`✅ Batch ${a.cursor + 1}: ${batchSignals.length} signals (grounded)`);
            a.signals.push(...batchSignals);
        } catch (err) {
            console.error(`[Pipeline] Batch ${a.cursor + 1} failed:`, err.message);
            failedBatches++;
            if (a.cursor === 0) {
                ctx.onProgress?.('Signal analysis encountered an error. Continuing with available data...');
            }
        }

        a.cursor++;
    }

    // A batch that exhausted callLLMWithRetry's own retries is not a budget shortfall —
    // observations it held simply never produced signals, and nothing upstream of this
    // catch knew to disclose that. Same failure shape as the write-time loss in
    // appendObservations(): the run continues (correctly — one dead batch should not sink
    // the report), but continuing must not mean the loss goes unrecorded. `verify` already
    // gap-fills on thin coverage, so this also gives it a concrete reason instead of just
    // a low signal count.
    if (failedBatches > 0) {
        recordDegradation(state, {
            step: 'Signal analysis',
            reason: `${failedBatches} of ${a.batches.length} analysis batch(es) failed after retries.`,
            impact: 'Evidence in those batches produced no signals for this report.'
        });
    }

    a.signals = deduplicateSignals(a.signals);
    console.log(`✅ Total signals after dedup: ${a.signals.length}`);

    // Temporal classification + evidence packets.
    //
    // This replaces the old freshness downgrade, which set a "Background" chip and capped
    // relevance at 5 using its own `lookbackMonths * 30 * 86400000` window. That was
    // presentation-only: it never gated the news surface, so a 2024 article still reached
    // a news card — stamped with today's date, because the transformer set `timestamp` to
    // a fresh clock read. The chip made it look considered.
    //
    // Nothing is dropped here. `a.signals` stays the COMPLETE retained set that every
    // existing consumer already reads; the packets are projections beside it.
    applyEvidencePackets(state, a.signals);
    ctx.timer.logStep('Signal Analysis');

    // ═══ v6.0 FALLBACK: synthesize shifts from signals when the DB pipeline found none ═══
    // Ensures the Strategic Awareness Surface shows results from run 1.
    const v6IsEmpty = (state.v6.shifts.length + state.v6.blindSpots.length + state.v6.opportunities.length) === 0;
    if (v6IsEmpty && a.signals.length > 0) {
        try {
            console.log(`[v6] DB pipeline returned empty. Generating synthetic v6 from ${a.signals.length} signals...`);
            ctx.onProgress?.('Detecting structural shifts from signals...');
            const syntheticV6 = transformSignalsToV6(a.signals, state.context);
            state.v6.shifts = syntheticV6.shifts;
            state.v6.patterns = syntheticV6.patterns;
            state.v6.blindSpots = syntheticV6.blindSpots;
            state.v6.opportunities = syntheticV6.opportunities;
            state.v6.syntheticInterpretation = syntheticV6.interpretation;
            console.log(`[v6] Synthetic: shifts=${syntheticV6.shifts.length}, patterns=${syntheticV6.patterns.length}, blindSpots=${syntheticV6.blindSpots.length}, opportunities=${syntheticV6.opportunities.length}`);
            ctx.timer.logStep('Synthetic v6 Transform');
        } catch (synthErr) {
            console.warn('[v6] Synthetic transform failed (non-blocking):', synthErr.message);
        }
    }
}

// ─── summary ──────────────────────────────────────────────────────────────

// ─── verify ───────────────────────────────────────────────────────────────
// The pre-publish coverage gate. Runs BEFORE summary so a gap fill changes what the
// brief is written from, rather than invalidating a brief already written.
//
// Self-contained by design: it performs its own targeted retrieval and analysis inline
// instead of jumping back to `search`, so PIPELINE_STEPS stays a strictly linear list
// advanced by idx + 1. One bounded retry, once per run — see MAX ceiling rules in
// the internal design log.

/** Focused queries for a section that came back empty. Deterministic, entity-anchored. */
export function buildGapQueries(section, contextJson) {
    const company = contextJson?.company_name || '';
    const industry = contextJson?.industry || 'technology';
    const geo = contextJson?.operating_geography || 'global';
    const year = new Date().getFullYear();
    const competitors = (contextJson?.key_competitors || [])
        .map(c => (typeof c === 'object' ? c?.name : c))
        .filter(Boolean)
        .slice(0, 2);
    const segments = (contextJson?.customer_segments || [])
        .map(s => (typeof s === 'object' ? s?.segment : s))
        .filter(Boolean)
        .slice(0, 2);

    if (section === SECTIONS.OPPORTUNITIES) {
        const base = segments.length ? segments : [industry];
        const buyer = base.map(s => `"${s}" procurement OR budget OR tender ${geo} ${year} buyer buying signals`);
        // Partnership doors: programmes that open to new members, not deals others signed.
        const partner = `${industry} partner program OR marketplace OR reseller program ${geo} ${year}`;
        // Buyer first, partner second: a capped retry must still search both doors.
        return [buyer[0], partner, ...buyer.slice(1)];
    }
    if (section === SECTIONS.COMPETITION) {
        const base = competitors.length ? competitors : [`${industry} companies`];
        return base.map(c => `"${c}" launch OR funding OR partnership ${year} ${geo} competitor`);
    }
    if (section === SECTIONS.REGULATORY) {
        return [`${industry} regulation OR compliance change ${geo} ${year}`];
    }
    return company ? [`"${company}" ${industry} ${geo} ${year}`] : [];
}

/** Overall ceiling on the one gap-fill retry, and the share any single section may take. */
const GAP_FILL_MAX_QUERIES = 3;
// Both critical sections empty is exactly when the retry matters, and one section must not
// consume the whole budget — so each is capped before the overall ceiling applies.
const GAP_FILL_MAX_PER_SECTION = 2;

/** The final gap-fill query list: every empty section gets a share, none gets it all. */
export function planGapQueries(sections, contextJson) {
    return sections
        .flatMap(s => buildGapQueries(s, contextJson).slice(0, GAP_FILL_MAX_PER_SECTION))
        .slice(0, GAP_FILL_MAX_QUERIES);
}

/**
 * Coverage check plus the one bounded gap fill — the "what is missing?" half of this step.
 *
 * Split out of stepVerify so that every way this work can finish EARLY (nothing to analyse,
 * coverage already clean) returns to the caller instead of returning out of the step. Those
 * exits used to be bare `return`s inside stepVerify, which skipped the grounding gate below
 * and left `state.verify.verdict` unset — and `persist` fails closed on a missing verdict.
 * The healthier the run, the more reliably it died: clean coverage was the common path.
 *
 * @returns {Promise<boolean>} true when it wants another invocation (defer), false otherwise.
 */
async function runCoveragePhase(state, ctx) {
    if (state.analyze?.empty) return false;

    const signals = state.analyze?.signals || [];
    let result = verifyReport(signals);

    if (result.ok) {
        console.log(`[verify] Coverage OK — ${result.metrics.total} signals, ${result.metrics.domains} distinct sources`);
        return false;
    }

    console.warn(`[verify] ${result.gaps.length} gap(s): ${result.gaps.map(g => g.type).join(', ')}`);

    // ── One bounded gap-fill attempt ─────────────────────────────────────────
    const targets = retryTargetsFor(result.gaps);
    const needsRetry = targets.length > 0 || result.gaps.some(g => g.retryable);

    if (needsRetry && !state.verify.retried) {
        const budget = SEARCH_WAVE_BUDGET_MS + ANALYZE_BATCH_BUDGET_MS;
        if (!ctx.timer.canAfford('Gap fill', budget)) {
            // Defer rather than skip: the retry is worth another invocation, which starts
            // with a fresh STEP_MAX_MS budget.
            //
            // Bounded, because this defer moves no cursor. The worker's forward-progress
            // guard fingerprints search/analyze/news/verify, and an unbounded defer here
            // would either trip that guard (aborting a run whose report was fine) or spin
            // until MAX_RETRIGGERS. If a *fresh* invocation still cannot afford the gap
            // fill, STEP_MAX_MS is configured below one unit of work and no number of
            // retries will change that — see the internal design log §19.
            if (ctx.stepped && state.verify.deferCount < MAX_VERIFY_DEFERS) {
                state.verify.deferCount += 1;
                return true;
            }
            recordDegradation(state, {
                step: 'Coverage',
                reason: 'Time budget ran out before coverage gaps could be filled.',
                impact: `${result.gaps.length} gap(s) left unaddressed; they are disclosed below.`
            });
        } else {
            // Set BEFORE the work, not after. A crash mid-retry must not license a second
            // attempt on the next invocation — that is how a bounded retry becomes a loop.
            state.verify.retried = true;

            const sections = targets.length ? targets : [SECTIONS.OPPORTUNITIES];
            const queries = planGapQueries(sections, state.context);

            if (queries.length > 0) {
                ctx.onProgress?.('Filling coverage gaps...');
                console.log(`[verify] Gap fill: ${queries.length} query(s) for ${sections.join(', ')}`);
                try {
                    const waves = await mapWithConcurrency(queries, queries.length, (q, i) =>
                        searchQuery(q, {
                            theme: 'customer_shifts',
                            // Gap fill covers a MISSING SECTION of the brief, which is a
                            // coverage problem rather than a recency one — the context
                            // window gives it the explanatory material it is short of.
                            retrievalWindow: 'context',
                            temporalPolicy: runPolicy(state),
                            queryIdx: 1000 + i
                        }).catch(() => ({ observations: [], candidates: [] }))
                    );

                    const fresh = waves.flatMap(w => w.observations);
                    if (fresh.length > 0) {
                        await appendObservations(state, ctx, fresh);

                        fresh.forEach((o, i) => { if (o.id == null) o.id = `gap:${i}`; });
                        const batchText = fresh.map((o, i) => compressObservation(o, i)).join('\n\n');

                        const gapResult = await callLLMWithRetry('analyzeSignals', {
                            context: state.context,
                            searchResults: batchText,
                            // A gap fill must classify time exactly as the main path did.
                            temporalPolicy: runPolicy(state),
                            previousSignals: [...(state.memory?.previousSignalsTail || []), ...signals],
                            quoteBinding: SIGNAL_QUOTE_BINDING
                        });

                        // Identical filter chain to the main analysis path — a gap fill
                        // must never be allowed to publish weaker evidence than a
                        // first-pass signal would have needed to clear.
                        const gapSignals = applySignalFilters(
                            normalizeSignalResponse(gapResult),
                            batchText,
                            state.context?.company_name,
                            fresh
                        );

                        if (gapSignals.length > 0) {
                            // Re-classify the MERGED set rather than the new signals
                            // alone: gap-fill evidence can become the supporting context
                            // an existing anchor was missing, and that link only exists
                            // once both halves are in the same packet.
                            applyEvidencePackets(state, deduplicateSignals([...signals, ...gapSignals]));
                            console.log(`[verify] Gap fill added ${gapSignals.length} signal(s)`);
                        } else {
                            console.log('[verify] Gap fill found nothing that cleared the filters');
                        }
                    }
                } catch (err) {
                    // A failed gap fill must never fail the run — the report still ships,
                    // with the gap disclosed below.
                    console.warn('[verify] Gap fill failed (non-blocking):', err.message);
                }
            }

            result = verifyReport(state.analyze.signals || []);
        }
    }

    // ── Disclose whatever survived ───────────────────────────────────────────
    // recordDegradation is already persisted and already rendered to the founder, so an
    // honest "we found nothing credible here" needs no new UI.
    for (const gap of result.gaps) {
        recordDegradation(state, {
            step: gap.section ? `Coverage — ${gap.section}` : 'Coverage',
            reason: gap.reason,
            impact: gap.retryable && state.verify.retried
                ? 'Searched again for this and still found nothing that met the evidence bar.'
                : 'Reported as-is rather than filled with weaker evidence.'
        });
    }
    if (result.gaps.length > 0) {
        console.log(`[verify] Disclosed ${result.gaps.length} remaining gap(s) to the founder`);
    }

    return false;
}

export async function stepVerify(state, ctx) {
    // Initialised before anything else can exit: `retried` and `deferCount` bound the gap
    // fill, and the worker's forward-progress guard fingerprints state.verify.deferCount.
    if (!state.verify) state.verify = { retried: false, deferCount: 0 };

    // A defer is the ONLY exit that may skip the gate, because the step runs again.
    if (await runCoveragePhase(state, ctx)) return { defer: true };

    // ── Grounding gate ───────────────────────────────────────────────────────
    // Unconditional, and it must stay that way. `persist` refuses to publish without a
    // verdict, so any path that reaches the end of this step without setting one turns a
    // finished run into "Refusing to persist: no verification verdict for this run".
    // An empty or already-clean run still gets a verdict — one that honestly records
    // there was nothing to drop.
    //
    // Drops ungrounded and duplicate findings. This runs HERE, not in `persist`, and the
    // ordering is the point: `summary`, `interpret` and `news` all read
    // state.analyze.signals. While the gate lived in persist, the brief was written from the
    // ungrounded set and only then pruned — so a founder could read an insight citing a
    // finding that never appears in the published report. Gating before synthesis makes the
    // brief and the signal list describe the same evidence.
    //
    // The verdict is recorded on state so `persist` can refuse to publish without one
    // (§5.6): the agent that judges is not the agent that writes.
    const verifierMode = resolveVerifierMode({
        VERIFIER_MODE: readRuntimeEnv('VERIFIER_MODE'),
        VITE_VERIFIER_MODE: readRuntimeEnv('VITE_VERIFIER_MODE'),
    });

    if (verifierMode === 'off') {
        state.verify.verdict = { skipped: true, mode: 'off', checked_at: new Date().toISOString() };
        return;
    }

    // What the gate is given decides which of its gates are alive, so this argument list is
    // load-bearing:
    //
    //   • `brief` is NOT passed. It used to be, as `brief: state.summary || null`, which read
    //     as though the gate could judge the brief — it cannot, because `summary` has not run
    //     yet and never will before this point. `insight_grounding` believed that argument and
    //     spent its life reporting `pass` over an empty array. Anything that must judge the
    //     written brief needs a step after `summary`, not an argument here.
    //   • `context` IS passed, for the opposite reason: `competitor_validation` reads
    //     `_trackedEntities` and was being starved the same way, silently passing on every run
    //     because nobody handed it the entities to check.
    const gate = runVerifierGate(
        { signals: state.analyze?.signals || [], context: state.context },
        { mode: verifierMode }
    );
    state.verify.verdict = gate.report;

    if (gate.changed) {
        console.warn(`[verifier] ${gate.report.verdict}: ${gate.report.actions.join('; ')}`);
        if (state.analyze) state.analyze.signals = gate.signals;

        // A thin report caused by the gate is CORRECT, but must not read as a mysteriously
        // empty one. Measured across 49 historical reports, two would empty completely —
        // both held exactly two unsupported claims.
        const c = gate.report.counts;
        recordDegradation(state, {
            step: 'Verification',
            reason: c.signals_out === 0
                ? `None of the ${c.signals_in} findings could be traced to a usable source, so none were published.`
                : `${c.dropped} of ${c.signals_in} findings could not be traced to a usable source and were removed.`,
            impact: c.signals_out === 0
                ? 'This report has no verified findings. Re-running may surface better-sourced evidence.'
                : `${c.signals_out} verified finding(s) remain below.`,
        });
    }

    const failed = gate.report.gates.filter(g => g.status !== 'pass');
    console.log(`[verifier] mode=${verifierMode} verdict=${gate.report.verdict} `
        + `signals ${gate.report.counts.signals_in}\u2192${gate.report.counts.signals_out}`
        + (failed.length ? ` | flagged: ${failed.map(g => `${g.id}:${g.status}`).join(', ')}` : ''));
}

async function stepSummary(state, ctx) {
    // A partial run may never populate `state.analyze`. Absent and empty mean the same thing
    // here — there is nothing to summarise — and the difference must not be a TypeError.
    if (!state.analyze || state.analyze.empty) {
        if (ctx.job.analysisMode === DECISION_MODE || state.context._decision) {
            state.decisionBrief = buildDecisionBriefFallback(state.context._decision || ctx.job.decisionContext, []);
            state.summary = { type: 'decision', ...state.decisionBrief, decision_context: normalizeDecisionFrame(state.context._decision || ctx.job.decisionContext) };
        }
        return;
    }
    const signals = state.analyze.signals;

    if (signals.length === 0) {
        console.log('[Pipeline] Skipping summary — no signals to summarize');
        if (ctx.job.analysisMode === DECISION_MODE || state.context._decision) {
            state.decisionBrief = buildDecisionBriefFallback(state.context._decision || ctx.job.decisionContext, []);
            state.summary = { type: 'decision', ...state.decisionBrief, decision_context: normalizeDecisionFrame(state.context._decision || ctx.job.decisionContext) };
        } else {
            state.summary = {
                insights: [{
                    type: 'context',
                    text: `Intelligence scan completed for ${state.context.company_name || 'this company'}. While we scanned ${state.analyze?.order?.length || 'multiple'} recent data points, we didn't detect any high-conviction competitor moves or structural shifts for this period.`
                }]
            };
        }
        return;
    }

    if (!ctx.timer.canAfford('Summary Generation', 20000)) {
        recordDegradation(state, {
            step: 'Strategic brief',
            reason: 'Time budget ran out before the AI brief could be generated.',
            impact: 'The observation below is a deterministic summary, not a synthesized brief.'
        });
        if (ctx.job.analysisMode === DECISION_MODE || state.context._decision) {
            state.decisionBrief = buildDecisionBriefFallback(state.context._decision || ctx.job.decisionContext, signals);
            state.summary = { type: 'decision', ...state.decisionBrief, decision_context: normalizeDecisionFrame(state.context._decision || ctx.job.decisionContext) };
        } else {
            state.summary = buildClientSideSummary(state.context, signals);
        }
        ctx.timer.logStep('Client-Side Summary');
        return;
    }

    try {
        ctx.onProgress?.(ctx.job.analysisMode === DECISION_MODE ? 'Building decision tradeoffs...' : 'Generating strategic brief...');
        // Cap signals to top 20 by relevance score (§5.9 token budget)
        // Anchors first, then everything else, each half still ordered by relevance.
        //
        // The old ordering was relevance alone, which let a high-scoring 2023 market
        // report outrank February's actual event and land at the top of the brief. Sorting
        // by date instead would be just as wrong — a trivial recent item would outrank a
        // major one. Anchors are a separate BAND, and relevance orders within it.
        //
        // Nothing is excluded: context and historical signals still reach the summary,
        // they simply cannot lead it.
        const packets = state.analyze?.evidencePackets || null;
        const anchorUrls = new Set((packets?.anchors || []).map(a => a.source_url).filter(Boolean));
        const byRelevance = (a, b) => (b.relevance_score || 0) - (a.relevance_score || 0);
        const topSignalsForSummary = [
            ...signals.filter(s => anchorUrls.has(s.source_url)).sort(byRelevance),
            ...signals.filter(s => !anchorUrls.has(s.source_url)).sort(byRelevance),
        ].slice(0, budget().maxSummarySignals);

        // What the prompt needs to keep tenses honest: the cutoffs, and whether this run
        // verified any current event at all. A run with zero anchors has to SAY so rather
        // than write context up as though it were news.
        const temporalForPrompt = {
            policy: runPolicy(state),
            anchors: packets?.anchors || [],
            counts: packets?.counts || null,
        };

        if (ctx.job.analysisMode === DECISION_MODE || state.context._decision) {
            const decision = normalizeDecisionFrame(state.context._decision || ctx.job.decisionContext);
            const decisionResult = await callLLMWithRetry('generateDecisionBrief', {
                context: state.context,
                decision,
                signals: topSignalsForSummary,
                synthesis: {
                    patterns: state.v6?.patterns || [],
                    shifts: state.v6?.shifts || [],
                    blindSpots: state.v6?.blindSpots || [],
                    opportunities: state.v6?.opportunities || []
                },
                temporal: temporalForPrompt
            }, 1);
            state.decisionBrief = decisionResult?.decisionBrief || decisionResult;
            state.summary = {
                type: 'decision',
                ...state.decisionBrief,
                decision_context: decision
            };
            ctx.timer.logStep('Decision Brief Generation');
            return;
        }

        const summaryResult = await callLLMWithRetry('generateSummary', {
            context: state.context,
            signals: topSignalsForSummary,
            // Feed the already-detected v6 synthesis so the brief can reference
            // patterns/shifts/blind-spots/opportunities instead of re-deriving them.
            synthesis: {
                patterns: state.v6?.patterns || [],
                shifts: state.v6?.shifts || [],
                blindSpots: state.v6?.blindSpots || [],
                opportunities: state.v6?.opportunities || []
            },
            temporal: temporalForPrompt
        });
        state.summary = filterEchoInsights(summaryResult?.summary || summaryResult, signals);
        ctx.timer.logStep('Summary Generation');
    } catch (summaryErr) {
        console.warn('[Pipeline] Summary generation failed (non-blocking):', summaryErr.message);
        if (ctx.job.analysisMode === DECISION_MODE || state.context._decision) {
            state.decisionBrief = buildDecisionBriefFallback(state.context._decision || ctx.job.decisionContext, signals);
            state.summary = {
                type: 'decision',
                ...state.decisionBrief,
                decision_context: normalizeDecisionFrame(state.context._decision || ctx.job.decisionContext)
            };
        } else {
            state.summary = buildClientSideSummary(state.context, signals);
        }
        ctx.timer.logStep('Fallback Summary');
    }
}

// ─── attest ───────────────────────────────────────────────────────────────

/**
 * Check the finished brief against the evidence it was built from.
 *
 * Runs immediately after `summary` because it corrects confidence in place and everything
 * downstream should see the corrected value. It could not be a gate inside `verify`: that
 * step runs before any brief exists, which is exactly how G6 came to report `pass` on
 * every report ever produced without checking anything.
 *
 * ⚠️  Writes `state.attest`, NEVER `state.verify.verdict`. `stepPersist` throws unless the
 *     latter is set, and that guard exists to fail closed when the SIGNAL gate silently
 *     did not run. A run with VERIFIER_MODE=off sets `{ skipped: true }` and returns early;
 *     if this step overwrote that sentinel, the guard would pass on precisely the run it
 *     was built to catch. The two verdicts are also scored by different policy versions and
 *     are not comparable.
 *
 * A failing attestation does NOT block persistence. The only enforcing action available
 * would be withholding a brief the founder already paid a full run for, and the precedent
 * throughout this pipeline is measure-then-enforce. Failures are disclosed as degradations
 * instead, which the report surface already banners.
 */
async function stepAttest(state, ctx) {
    const mode = resolveBriefPolicyMode({
        BRIEF_POLICY_MODE: readRuntimeEnv('BRIEF_POLICY_MODE'),
        VITE_BRIEF_POLICY_MODE: readRuntimeEnv('VITE_BRIEF_POLICY_MODE'),
    });
    if (mode === 'off') {
        state.attest = { skipped: true };
        return;
    }

    const signals = Array.isArray(state.analyze?.signals) ? state.analyze.signals : [];
    const tier = ctx.job.runTier || DEFAULT_RUN_TIER;

    // The brief is normalized at buildReportData time, so attest over the same shape the
    // report will carry rather than over the raw model output.
    const candidate = normalizeBriefForRun(state.summary, state, ctx, signals);
    candidate.depth_gaps = describeDepthGaps(state, ctx);

    const result = attestBrief(
        { brief: candidate, signals, tier, verifierGates: state.verify?.verdict?.gates || [] },
        { mode }
    );
    state.attest = result.report;

    // B2 rewrites confidence. Carry the corrected brief forward so the report and the
    // attestation cannot disagree about what confidence this run earned.
    if (result.changed) {
        state.summary = { ...(typeof state.summary === 'object' ? state.summary : {}), confidence: result.brief.confidence };
    }

    const failed = result.report.gates.filter(g => g.status !== 'pass');
    console.log(`[attest] mode=${mode} verdict=${result.report.verdict} `
        + `claims=${result.report.counts.claims} falsifiers=${result.report.counts.falsifiers} `
        + `confidence=${result.report.counts.confidence}`
        + (failed.length ? ` | flagged: ${failed.map(g => `${g.id}:${g.status}`).join(', ')}` : ''));

    // Disclosed here and nowhere else, so a defect reaches the founder exactly once.
    // `advice_leakage` is a warn rather than a fail — the brief is still usable — but it is
    // the one warn worth surfacing, because a founder reading an instruction should know
    // Bahirjee did not mean to give one.
    for (const gate of result.report.gates) {
        const disclose = gate.status === 'fail' || (gate.id === 'advice_leakage' && gate.status === 'warn');
        if (!disclose) continue;
        recordDegradation(state, {
            step: 'Brief attestation',
            reason: gate.detail,
            impact: gate.id === 'advice_leakage'
                ? 'Bahirjee states what the evidence favours, not what to do. Read those lines as observations.'
                : 'The brief is published as written; treat the affected part with more caution.',
        });
    }

    ctx.timer.logStep('Brief Attestation');
}

// ─── review ───────────────────────────────────────────────────────────────
// Jev reads the finished brief the way attest's phrase lists cannot (JEV_REVIEW). Advisory
// ONLY: it never sets a verdict, never touches confidence or text, and never blocks —
// attest's deterministic gates stay authoritative, and `attest` itself still makes no call.
// `on` discloses hits once, as a degradation; shadow only records them. Either way the hits
// are saved in verification.review.
const REVIEW_DEADLINE_MS = 6000;
const REVIEW_ADVICE_AT = 0.7;      // P(instructs) at or above → flagged as advice
const REVIEW_FALSIFIER_BELOW = 0.3; // P(overturns) below → flagged as not a real falsifier

async function stepReview(state, ctx) {
    const mode = jevModeFor('review');
    if (mode === 'off' || state.analyze?.empty || !state.summary) return;

    const signals = Array.isArray(state.analyze?.signals) ? state.analyze.signals : [];
    const brief = normalizeBriefForRun(state.summary, state, ctx, signals);
    const read = String(brief.our_read || '').trim();
    const items = [
        ['our_read', brief.our_read],
        ['why_it_matters', brief.why_it_matters],
        ...(brief.what_to_consider || []).map((c, i) => [`what_to_consider[${i}]`, c?.text]),
    ].map(([field, text]) => ({ field, kind: 'advice', text: String(text || '').trim() }))
        .concat(read ? (brief.what_could_change_our_view || []).map((f, i) => ({
            field: `what_could_change_our_view[${i}]`, kind: 'falsifier', text: String(f?.text || '').trim(),
        })) : [])
        .filter(item => item.text);
    if (!items.length) return;

    if (!ctx.timer.canAfford('Brief review', REVIEW_DEADLINE_MS)) {
        recordJevUse(state, { useCase: 'review', mode, n: items.length, skipped: items.length });
        return;
    }

    const company = compactContext(state.context);
    const out = await jevClient().decideEach(items, item => (item.kind === 'advice'
        ? adviceRequest(company, item.text)
        : falsifierRequest(company, read, item.text)), { useCase: 'review', deadlineMs: REVIEW_DEADLINE_MS });

    const hits = [];
    items.forEach((item, i) => {
        const answers = out.results[i];
        const p = pYes(item.kind === 'advice' ? answers?.instructs : answers?.overturns);
        if (p === null) return;
        const flagged = item.kind === 'advice' ? p >= REVIEW_ADVICE_AT : p < REVIEW_FALSIFIER_BELOW;
        if (flagged) hits.push({ field: item.field, kind: item.kind, p: Math.round(p * 100) / 100 });
    });

    state.review = { mode, checked: items.length, answered: out.answered, hits };
    recordJevUse(state, {
        useCase: 'review', mode, n: out.n, answered: out.answered, failed: out.failed, skipped: out.skipped,
        flagged: hits.length,
    });
    console.log(`[review] mode=${mode} checked=${items.length} answered=${out.answered} flagged=${hits.length}`);

    if (mode !== 'on' || !hits.length) return;
    // attest already disclosed the advice it caught by phrase; do not tell the founder twice.
    const attestFields = new Set(
        (state.attest?.gates || []).find(g => g.id === 'advice_leakage')?.fields?.map(f => f.field) || []
    );
    const advice = hits.filter(h => h.kind === 'advice' && !attestFields.has(h.field)).map(h => h.field);
    const falsifiers = hits.filter(h => h.kind === 'falsifier').map(h => h.field);
    const parts = [
        advice.length && `${advice.length} passage(s) may read as instructions (${advice.join(', ')})`,
        falsifiers.length && `${falsifiers.length} "what could change our view" item(s) may restate the read rather than name what would overturn it (${falsifiers.join(', ')})`,
    ].filter(Boolean);
    if (!parts.length) return;
    recordDegradation(state, {
        step: 'Brief review',
        reason: `An advisory read of the brief flagged: ${parts.join('; ')}.`,
        impact: 'Advisory only — the brief is published as written. Read the flagged lines as observations, and weigh those conditions with care.',
    });
}

// ─── interpret ────────────────────────────────────────────────────────────

async function stepInterpret(state, ctx) {
    if (!state.analyze || state.analyze.empty) return;

    if (state.v6.syntheticInterpretation) {
        state.interpret = state.v6.syntheticInterpretation;
        console.log(`[v6] Using synthetic interpretation (${state.interpret?.interpretations?.length || 0} items)`);
        return;
    }

    const hasV6Findings = (state.v6.shifts.length + state.v6.blindSpots.length + state.v6.opportunities.length) > 0;
    if (!hasV6Findings || !ctx.timer.canAfford('v6 Interpretation', 20000) || circuitBreaker.isOpen()) return;

    try {
        ctx.onProgress?.('Interpreting strategic awareness findings...');
        state.interpret = await callLLMWithRetry('interpretShifts', {
            context: state.context,
            shifts: state.v6.shifts,
            blindSpots: state.v6.blindSpots,
            opportunities: state.v6.opportunities
        });
        console.log(`[v6] Interpretation complete: ${state.interpret?.interpretations?.length || 0} interpretations`);
        ctx.timer.logStep('v6 Interpretation');
    } catch (interpErr) {
        console.warn('[v6] Interpretation failed (non-blocking):', interpErr.message);
    }
}

// ─── news ─────────────────────────────────────────────────────────────────

// Jev on news relevance (JEV_NEWS). The exposure formula decides what is a candidate; Jev
// judges how material each candidate is to this company. `on`: rankNews drops what Jev calls
// unrelated and re-ranks the rest before the cap. Headlines stay the factual line — Jev
// generates no text.
const NEWS_JEV_DEADLINE_MS = 5000;

async function rankNewsWithJev(state, ctx, candidates) {
    const mode = jevModeFor('news');
    if (mode === 'off' || !candidates.length) return rankNews(candidates);
    if (!ctx.timer.canAfford('News relevance', NEWS_JEV_DEADLINE_MS)) {
        recordJevUse(state, { useCase: 'news', mode, n: candidates.length, skipped: candidates.length });
        return rankNews(candidates);
    }

    const company = compactContext(state.context);
    const out = await jevClient().decideEach(candidates, item => materialityRequest(company, [
        `HEADLINE: ${item.headline}`,
        item.linked_entity && `ENTITY: ${item.linked_entity}`,
        item.domain && `EXPOSURE: ${item.domain}`,
        item.signal?.raw_details && `DETAIL: ${String(item.signal.raw_details).slice(0, 1200)}`,
        item.source_url && `SOURCE: ${item.source_url}`,
    ].filter(Boolean).join('\n')), { useCase: 'news', deadlineMs: NEWS_JEV_DEADLINE_MS });
    const relevance = out.results.map(a => scoreFraction(a?.material));

    const formula = rankNews(candidates);
    const withJev = rankNews(candidates, { relevance });
    const shown = new Set(formula.map(i => i.source_url || i.headline));
    recordJevUse(state, {
        useCase: 'news', mode, n: out.n, answered: out.answered, failed: out.failed, skipped: out.skipped,
        wouldChange: withJev.filter(i => !shown.has(i.source_url || i.headline)).length,
    });
    return mode === 'on' ? withJev : formula;
}

async function stepNews(state, ctx) {
    if (!state.analyze || state.analyze.empty) return;

    const contextJson = state.context;
    const trackedEntities = contextJson._trackedEntities || [];
    // The CURRENT projection, not every signal. News is a claim that something is
    // happening now; feeding it the whole retained set is what let a 2024 article take a
    // news slot. The rest of the evidence is untouched and still in the report — it is
    // this one surface that narrows.
    //
    // Falls back to the full set only for a job checkpointed before packets existed,
    // where every signal still carries temporal_role null and scoreAndFilterNews will
    // decline them anyway. Belt and braces, in that order.
    const packets = state.analyze.evidencePackets || null;
    const signals = state.analyze.currentSignals || state.analyze.signals;
    if (trackedEntities.length === 0 || signals.length === 0) {
        state.news = { structuredSignals: [], items: [], cursor: 0, lines: [] };
        return;
    }

    if (!state.news) {
        try {
            ctx.onProgress?.('Building structured signal objects...');
            const structuredSignals = transformToStructuredSignals({
                geminiSignals: signals,
                entities: trackedEntities,
                signalWeights: contextJson._signalWeights || {},
                runId: state.runId
            });
            console.log(`✅ ${structuredSignals.length} structured signals created`);

            const exposureWeights = contextJson._startupContext?.exposure_weights || {};
            const candidates = scoreAndFilterNews({
                signals: structuredSignals, entities: trackedEntities, exposureWeights, limit: MAX_NEWS_CANDIDATES,
            });
            const items = await rankNewsWithJev(state, ctx, candidates);
            console.log(
                `✅ ${items.length} news items above threshold (${candidates.length} candidates)`
                + (packets ? ` (from ${packets.counts.anchors} current anchor(s); `
                    + `${packets.counts.supportingContext + packets.counts.historicalContext + packets.counts.undated} `
                    + `context/historical/undated signal(s) retained off-surface)` : '')
            );

            state.news = { structuredSignals, items, cursor: 0, lines: [] };
        } catch (ctxLayerErr) {
            console.warn('[Pipeline] Context layer processing failed (non-blocking):', ctxLayerErr.message);
            state.news = { structuredSignals: [], items: [], cursor: 0, lines: [] };
            return;
        }
    }

    // News-line LLM generation removed: the 3-line format was rendered only by
    // NewsThatMatters.jsx, which nothing imported — every run paid LLM calls for text no
    // founder ever saw. Scoring + persistence stay (structured signals and news_items feed
    // patterns and analytics); each item keeps its headline as the factual line.
    state.news.items = state.news.items.map(item => ({ ...item, line_1_fact: item.headline }));
    state.news.done = true;
    ctx.timer.logStep('News Curation');
}

// ─── persist ──────────────────────────────────────────────────────────────

/**
 * Put this run's brief into the shared brief.v2 shape.
 *
 * Both callers below go through here so company mode and decision mode persist the same
 * structure — the unification the workspace renders. `signals` is passed explicitly
 * because confidence is COMPUTED from the evidence actually gathered rather than taken
 * from the model, and because `what_changed` is built from the signal set.
 *
 * Voice regressions are logged, not repaired: rewriting the model's words to hide a
 * prompt that started giving advice would delete the only evidence that it did.
 */
function normalizeBriefForRun(rawBrief, state, ctx, signals) {
    const isDecision = ctx.job.analysisMode === DECISION_MODE || Boolean(state.context?._decision);
    const brief = normalizeBrief(rawBrief, {
        kind: isDecision ? 'decision' : 'company',
        signals,
        context: state.context || {},
        tier: ctx.job.runTier || DEFAULT_RUN_TIER,
        decisionFrame: isDecision
            ? normalizeDecisionFrame(state.context?._decision || ctx.job.decisionContext)
            : null,
        // The verifier has already run by the time a brief is shaped, so its findings are
        // available to the one number the founder reads. Confidence that ignores them is
        // how a run reported High while the same verdict recorded that every date was
        // unverifiable and 10 of 12 tracked competitors had no evidence.
        gates: state.verify?.verdict?.gates || [],
    });

    // Deliberately no voice audit or degradation here. This function runs twice per run —
    // once in `attest`, once in `persist` — so recording from it would disclose the same
    // defect to the founder twice. Judging the brief is `attest`'s job; this one only
    // shapes it.
    if (brief.confidence?.claimed) {
        console.warn(`[brief] confidence ${brief.confidence.claimed} → ${brief.confidence.level} (${brief.confidence.basis})`);
    }
    return brief;
}

/**
 * The `verification` jsonb a report is saved with, or null when `verify` never ran.
 *
 * Carries, under separate keys because they judge different things at different points:
 *   - the signal verdict itself (`verify`)
 *   - `brief`: the attestation of the brief written from those signals (`attest`)
 *   - `jev`: what each Jev use case did this run, in which mode, answered vs failed — the
 *     record shadow mode exists to produce
 *   - `review`: the advisory brief review's hits (stepReview) — never a verdict
 * Riding inside the existing column means no migration and no new optional-column entry.
 *
 * `brief` was once merged into a copy of this object only, and the bare verdict was what
 * reached saveReport — so no attestation was ever stored, and nothing failed. Building it
 * once, here, for both the in-run report and the saved row is what keeps them the same.
 */
export function verificationForPersist(state) {
    const verdict = state?.verify?.verdict || null;
    if (!verdict) return null;
    const out = { ...verdict };
    if (state.attest && !state.attest.skipped) out.brief = state.attest;
    if (state.jev && Object.keys(state.jev).length) out.jev = state.jev;
    if (state.review) out.review = state.review;
    return out;
}

/** Assemble the report object the workspace renders. Pure over `state`. */
function buildReportData(state, ctx) {
    const provenanceRecords = getRunProvenance();
    const provenanceSummary = summarizeProvenance(provenanceRecords);

    if (state.analyze?.empty) {
        console.log('[provenance]', JSON.stringify(provenanceSummary.byProvider), `total ${provenanceSummary.totalTokens} tokens`);
        return {
            inputs: { websiteUrl: ctx.job.websiteUrl },
            context: state.context,
            report_kind: ctx.job.analysisMode === DECISION_MODE ? 'decision' : ctx.job.analysisMode === PRODUCT_MODE ? 'product' : 'company',
            decision_context: ctx.job.analysisMode === DECISION_MODE ? (state.context._decision || ctx.job.decisionContext || null) : null,
            decision_brief: state.decisionBrief || null,
            queries: state.queries?.buckets || {},
            signals: [],
            brief: normalizeBriefForRun('No material shifts detected in selected signal rings.', state, ctx, []),
            degradations: state.degradations || [],
            run_tier: ctx.job.runTier || DEFAULT_RUN_TIER,
            depth_gaps: describeDepthGaps(state, ctx),
            v6: { ...state.v6, runId: state.runId },
            newsItems: [],
            provenance: provenanceRecords,
            provenance_summary: provenanceSummary,
            timestamp: new Date().toISOString()
        };
    }

    const provenanceLine = Object.entries(provenanceSummary.byProvider)
        .map(([p, s]) => `${p}: ${s.calls} calls, ${s.tokens} tok${s.failed ? `, ${s.failed} failed` : ''}${s.salvaged ? `, ${s.salvaged} salvaged` : ''}`)
        .join(' | ');
    console.log(`[provenance] ${provenanceLine || 'no LLM calls recorded'} — total ${provenanceSummary.totalTokens} tokens across ${provenanceSummary.totalCalls} calls`);

    return {
        inputs: { websiteUrl: ctx.job.websiteUrl },
        context: state.context,
        report_kind: ctx.job.analysisMode === DECISION_MODE ? 'decision' : ctx.job.analysisMode === PRODUCT_MODE ? 'product' : 'company',
        decision_context: ctx.job.analysisMode === DECISION_MODE ? (state.context._decision || ctx.job.decisionContext || null) : null,
        decision_brief: state.decisionBrief || null,
        queries: state.queries?.buckets || {},
        signals: Array.isArray(state.analyze?.signals) ? state.analyze.signals : [],
        brief: normalizeBriefForRun(state.summary, state, ctx, Array.isArray(state.analyze?.signals) ? state.analyze.signals : []),
        // Empty on a clean run. Non-empty means the brief is partial — carried into the
        // report and bannered by the UI, so a thinner report is never mistaken for a
        // complete one. Without this line every recordDegradation() call writes to a
        // field nothing ever reads.
        degradations: state.degradations || [],
        // What this tier deliberately did not do. Separate from `degradations` on purpose:
        // a degradation means the run tried and failed, a depth gap is a priced boundary.
        run_tier: ctx.job.runTier || DEFAULT_RUN_TIER,
        depth_gaps: describeDepthGaps(state, ctx),
        v6: {
            patterns: state.v6.patterns,
            shifts: state.v6.shifts,
            blindSpots: state.v6.blindSpots,
            opportunities: state.v6.opportunities,
            interpretation: state.interpret,
            // True only when Jev's confidence actually shaped these findings (JEV_SYNTHESIS=on
            // and it answered) — the surface says so instead of "deterministic engine".
            jevScored: state.jev?.synthesis?.mode === 'on' && (state.jev.synthesis.answered || 0) > 0,
            runId: state.runId
        },
        contextLayer: {
            startupContext: state.context._startupContext || null,
            trackedEntities: state.context._trackedEntities || [],
            signalWeights: state.context._signalWeights || {},
            structuredSignals: state.news?.structuredSignals || [],
            newsItems: state.news?.items || []
        },
        // The "News that matters" section, in the shape saveReport persists (reports.news_items,
        // v28) and mapReportRowToAppReport reads back — one shape on both sides of the save.
        newsItems: (state.news?.items || []).map(compactNewsItem),
        memory: state.memory?.companyState || null,
        provenance: provenanceRecords,
        provenance_summary: provenanceSummary,
        timestamp: new Date().toISOString()
    };
}

async function stepPersist(state, ctx) {
    const reportData = buildReportData(state, ctx);
    state.report = reportData;

    const { userId, clientId, websiteUrl } = ctx.job;
    if (!userId || !clientId) return;

    const contextJson = state.context;
    const startupCtx = contextJson._startupContext;
    const trackedEntities = contextJson._trackedEntities || [];
    const structuredSignals = state.news?.structuredSignals || [];
    const newsItems = state.news?.items || [];

    // ─── verdict check (the gate itself ran in `verify`) ─────────────────────
    // §5.6: the agent that judges is not the agent that writes. `verifier_agent` owns the
    // `verify` step and produces this verdict; `synthesis_agent` owns persistence and may
    // only publish what the verdict cleared. There is deliberately no branch here that
    // proceeds against a blocking verdict — an override is a human action, not an agent one.
    //
    // Failing closed matters: if the gate silently did not run, publishing anyway would ship
    // exactly the unsupported claims the gate exists to remove, with no trace that it was
    // skipped.
    const verification = verificationForPersist(state);
    if (!verification) {
        throw new Error(
            'Refusing to persist: no verification verdict for this run. The `verify` step must run '
            + 'before `persist` (set VERIFIER_MODE=off to publish without the gate deliberately).'
        );
    }
    if (!verification.skipped || verification.brief || verification.jev) {
        reportData.verification = verification;
    }

    // `_companyMemory` is the full company_memory_state row, un-summarised. On a measured
    // run it was 203 KB of a 267 KB context — 76% of the column — and it is redundant
    // storage: the active-card projection is already persisted in the `card_summary`
    // column, and both askBahirjee call sites build `memory.current_cards` from THAT, not
    // from here. Every share-link open was paying to fetch it, since /api/report selects *.
    //
    // Stripped from a copy, never from `contextJson` itself: the object is still read
    // in-run after this point, and mutating it would trade a storage bug for a data one.
    const { _companyMemory, ...persistedContext } = contextJson;
    if (_companyMemory) {
        const saved = JSON.stringify(_companyMemory).length;
        console.log(`[Pipeline] Context trimmed for persistence: -${(saved / 1024).toFixed(0)} KB (_companyMemory; card_summary carries it)`);
    }

    try {
        ctx.onProgress?.('Saving report to database...');
        const { data, error } = await saveReport({
            websiteUrl,
            context: persistedContext,
            signals: reportData.signals,
            brief: reportData.brief,
            analysisMode: ctx.job.analysisMode || 'company',
            decisionId: ctx.job.decisionId || reportData.decision_context?.id || null,
            decisionContext: reportData.decision_context,
            decisionBrief: reportData.decision_brief,
            // Same shape as decisionId above: the run's own target, so a product's report
            // is findable by (client_id, target_id) rather than only by the parent
            // company's domain — see resolveRunTarget in lib/handlers/intelligence.js.
            targetId: ctx.job.targetId || null,
            degradations: reportData.degradations || [],
            runTier: reportData.run_tier || DEFAULT_RUN_TIER,
            newsItems: reportData.newsItems || [],
            userId,
            clientId,
            verification,
            // Idempotency key for a replayed `persist`. state.runId is minted once and
            // rehydrated from __control.run_id on every resume, so a re-run of this step
            // updates the report it already wrote instead of inserting a second one.
            runId: state.runId
        });

        if (error) {
            console.error('Failed to save report to database:', error);
        } else {
            console.log('✅ Report saved to database with ID:', data?.id);
        }

        const persistedReportId = data?.id || null;
        if (persistedReportId) {
            const memoryBundle = await buildReportMemory({
                companyId: clientId,
                reportId: persistedReportId,
                report: reportData,
                basedOnReportId: state.memory?.lastReportId || null,
                contextVersionId: startupCtx?.context_version_id || null
            });

            await persistReportMemory({
                companyId: clientId,
                reportId: persistedReportId,
                latestContextVersionId: startupCtx?.context_version_id || null,
                report: reportData,
                memoryBundle
            });

            const signalMemoryMap = new Map(
                (memoryBundle.currentCards || [])
                    .filter(card => card.card_type === 'signal' && card.source_index !== undefined && card.source_index !== null)
                    .map(card => [card.source_index, card])
            );
            reportData.signals = (reportData.signals || []).map((signal, index) => {
                const card = signalMemoryMap.get(index);
                if (!card) return signal;
                return {
                    ...signal,
                    memory_state: {
                        card_key: card.card_key,
                        section_key: card.section_key,
                        trend_state: card.trend_state,
                        occurrence_count: card.occurrence_count,
                        status: card.status,
                        first_seen_report_id: card.first_seen_report_id || null,
                        last_seen_report_id: card.last_seen_report_id || null,
                        first_seen_at: card.first_seen_at || null,
                        last_seen_at: card.last_seen_at || null
                    }
                };
            });

            const insightMemoryMap = new Map(
                (memoryBundle.currentCards || [])
                    .filter(card => card.card_type === 'intro' && card.source_index !== undefined && card.source_index !== null)
                    .map(card => [card.source_index, card])
            );
            if (reportData.brief?.insights) {
                reportData.brief = {
                    ...reportData.brief,
                    insights: reportData.brief.insights.map((insight, index) => {
                        const card = insightMemoryMap.get(index);
                        if (!card) return insight;
                        return {
                            ...insight,
                            memory_state: {
                                card_key: card.card_key,
                                section_key: card.section_key,
                                trend_state: card.trend_state,
                                occurrence_count: card.occurrence_count,
                                status: card.status
                            }
                        };
                    })
                };
            }

            reportData.memory = {
                ...memoryBundle.memoryState,
                current_brief: memoryBundle.currentBrief,
                current_cards: memoryBundle.cardSummary
            };
            reportData.card_summary = memoryBundle.cardSummary;
            reportData.memory_state = memoryBundle.memoryState;
            reportData.based_on_report_id = state.memory?.lastReportId || null;
            reportData.run_fingerprint = `run_${persistedReportId}`;
            reportData.effective_at = new Date().toISOString();
            reportData.id = persistedReportId;
            reportData.share_token = data?.share_token || reportData.share_token || null;
            reportData.created_at = data?.created_at || reportData.created_at || new Date().toISOString();
            reportData.target_domain = data?.target_domain || reportData.target_domain || null;
        }

        // Persist context layer data. These are awaited rather than fire-and-forget: a
        // serverless invocation is frozen the moment its handler resolves, so a dangling
        // promise here is silently dropped.
        //
        // These run AFTER saveReport on purpose, and that ordering is deliberate rather than
        // incidental: none of them needs `persistedReportId`, so they COULD run first — but
        // report-first means a slow or hanging memory-layer write cannot cost the founder the
        // report itself on a serverless timeout. Do not reorder without accepting that trade.
        //
        // The consequence is that a failure here cannot be disclosed through
        // recordDegradation(): the report row is already written, so anything pushed to
        // state.degradations now will never reach it. This is the third instance of the
        // pattern in §0.2 of the internal multi-agent plan — non-blocking
        // implemented as invisible — and the fix is a surface that outlives this report:
        // ctx.onProgress lands in intelligence_jobs.progress, which is where anyone
        // debugging "why did the next run start from nothing?" actually looks.
        //
        // What each failure costs ON THIS BRANCH (checked, not assumed):
        //   • Company context   — REAL (v27 follow-up): the one server-driven runs could
        //                         previously never write at all (see below) — losing this
        //                         write is not a regression from before v27, it is v27's
        //                         whole fix not landing for this run.
        //   • Structured layer  — no longer written here: it is a computed projection of
        //                         contextJson, re-derived every time stepMemory needs it, so
        //                         there is nothing left to lose on this branch.
        //   • Structured signals— REAL for the live-signal panel (getLiveSignals).
        //   • Entity watchlist  — dormant: getTrackedEntities() has no caller yet.
        //   • Entity sources    — dormant: getEntitySources() has no caller (Source Watch is
        //                         a `main`-only step). On main this is the WORST case — the
        //                         row never lands, so Source Watch has nothing to diff and
        //                         stays permanently inert for that company.
        //   • Entity relationships (v28) — dormant: nothing reads entity_relationships yet.
        //                         It also silently skips (not fails) whenever entities did
        //                         store but generateEntityRelationships found no mappable
        //                         category — that is a normal outcome (e.g. a run whose
        //                         entities are all 'adjacent'), not a failure, so it is not
        //                         in layerFailures at all.
        //   • News items        — dormant: nothing selects from news_items yet.
        //
        // "Dormant" means the loss is invisible today and becomes real the moment a reader
        // lands. That is exactly when nobody will think to add the logging, so it goes in now.
        const layerFailures = [];
        // console.error, not warn: this is lost cross-run state, not a cosmetic hiccup.
        const noteFailure = (what, err) => {
            layerFailures.push(what);
            console.error(`[DB] ${what} save failed:`, err?.message || err);
        };

        // ─── company_contexts: server-side write (v27) ──────────────────────
        // The browser already wrote this at confirm time for a founder-driven run
        // (saveCompanyContext in IntelligenceDashboard.jsx), so this is usually a
        // hash-idempotent no-op. It is NOT a no-op for a run with no browser session at
        // confirm time — a cron run, or an admin re-run — which could previously only READ
        // company_contexts (getCurrentCompanyContext has no auth dependency) and never write
        // it, because set_current_company_context gates on auth.uid(), which is null for the
        // service-role client the worker holds. Every improvement such a run made to the
        // context was discarded the moment the invocation ended. set_current_company_context_service
        // (v27) trusts clientId instead, because only the service role can reach it.
        // Not gated on startupCtx below — this must run whether or not onboarding data
        // produced a structured layer for this run.
        if (clientId && websiteUrl && contextJson && Object.keys(contextJson).length > 0) {
            await saveCompanyContextFromServer({
                clientId,
                websiteUrl,
                context: contextJson,
                source: state.contextOrigin || 'built',
                createdBy: userId || null,
                // A product run's context carries _product and belongs to the PRODUCT
                // target. Without this it was written over the company's (v38 header).
                targetId: ctx.job.analysisMode === PRODUCT_MODE ? (ctx.job.targetId || null) : null,
                builtFrom: {
                    urls: [websiteUrl],
                    linkedin: ctx.job.linkedinUrl || null,
                    documents: (contextJson._documentQuality || []).map(d => d.fileName).filter(Boolean),
                    captured_at: new Date().toISOString(),
                    origin: 'server',
                },
            }).catch(err => noteFailure('Company context', err));
        }

        // Knowledge chunks (v29): embed this run's signals so a later Q&A question can
        // retrieve them by similarity instead of falling through to a live web search for
        // something the platform already found. Not gated on startupCtx — a signal exists
        // whether or not onboarding data produced a structured layer this run. Uses
        // intelligenceRuntime.postJson, not the plain browser fetch ragService.js defaults
        // to: on the server worker that is the in-process dispatcher
        // (lib/_internalRouteClient.js), which a relative '/api/gemini' URL has no origin to
        // resolve against outside a browser.
        if (clientId && reportData.signals?.length > 0) {
            await ingestSignals({
                clientId,
                signals: reportData.signals,
                reportId: persistedReportId,
                postJsonFn: intelligenceRuntime.postJson,
            }).catch(err => noteFailure('Knowledge chunks', err));
        }

        if (startupCtx && clientId) {
            // No storeStartupContext() call here any more (v27 follow-up) — the structured
            // layer is now a computed projection of contextJson (derived on demand in
            // stepMemory via enrichContextWithOnboarding), not a second persisted copy that
            // could drift from it. See companyMemoryService.loadCompanyMemory's comment.

            // Competitors this run's verified evidence named that the watchlist did not. Stored
            // so the NEXT run searches for them; never added to this run's context, which has
            // already spent its query budget on the list it started with.
            const runSignals = reportData.signals || state.analyze?.signals || [];
            const discoveredRaw = discoverCompetitors(runSignals, trackedEntities, { companyName: contextJson.company_name });
            const discovered = await resolveEvidenceHomepages(discoveredRaw, contextJson.industry)
                .catch(() => discoveredRaw);
            if (discovered.length) {
                console.log(`[EntityWatchlist] Promoting ${discovered.length} evidence-discovered competitor(s): ${discovered.map(d => d.name).join(', ')}`);
                state.discoveredCompetitors = discovered.map(d => d.name);
            }
            // Evidence-promoted entities this run named again are stamped as seen, so only a
            // competitor that has gone quiet ages out (see EVIDENCE_MAX_AGE_DAYS).
            const refreshed = refreshSeenEvidence(trackedEntities, runSignals);
            const watchlist = discovered.length ? [...refreshed, ...discovered] : refreshed;

            if (watchlist.length > 0) {
                const result = await storeEntityWatchlist(clientId, startupCtx.context_version_id, watchlist)
                    .catch(err => { noteFailure('Entity watchlist', err); return null; });

                if (result?.stored > 0 && contextJson._primarySources?.length > 0) {
                    await storeEntitySources(contextJson._primarySources)
                        .catch(err => noteFailure('Entity sources', err));
                }

                // Entity spine (v28): edges derived from the SAME trimmed entity list, keyed
                // to the ids storeEntityWatchlist just returned from THIS run's upsert — an
                // edge can never reference a stale run's id. Gated on result?.entityIdByName
                // rather than result?.stored: a company_contexts row can already carry
                // entities from a prior run even when this specific call stored zero (every
                // upsert failed, or the whole batch was already unchanged).
                if (result?.entityIdByName?.size > 0) {
                    const relationships = generateEntityRelationships(watchlist);
                    if (relationships.length > 0) {
                        await storeEntityRelationships(clientId, relationships, result.entityIdByName)
                            .catch(err => noteFailure('Entity relationships', err));
                    }
                }
            }

            if (structuredSignals.length > 0) {
                await storeStructuredSignals(clientId, state.runId, structuredSignals)
                    .catch(err => noteFailure('Structured signals', err));
            }

            if (newsItems.length > 0) {
                await storeNewsItems(clientId, newsItems)
                    .catch(err => noteFailure('News items', err));
            }
        }

        // ── Feed the Agenda ──────────────────────────────────────────────
        // Until now, every falsifier this brief generated — the concrete observables
        // that would OVERTURN Bahirjee's read, at least two per brief because gate B3
        // blocks without them — was discarded the moment the run ended. So were the
        // founder's stated bets and everything the run could not settle. With nothing
        // carried forward, the next run could only start over, which is why it
        // re-derives the same 22 templated queries every week.
        //
        // Harvesting is pure and the writes are individually guarded: a question that
        // fails to open costs this run nothing, and the brief is already saved.
        // openQuestion refuses to resurrect anything the founder retired.
        try {
            const targetDomain = extractTargetDomain(websiteUrl || contextJson?.website_url);
            if (targetDomain) {
                const questions = harvestQuestions(state.summary, contextJson, {
                    reportId: state.report?.id || null,
                });
                let opened = 0;
                for (const q of questions) {
                    if (await openQuestion({ ...q, clientId, targetDomain, createdBy: ctx.job?.userId || null })) opened += 1;
                }
                if (questions.length > 0) {
                    console.log(`[Agenda] ${opened}/${questions.length} question(s) open for ${targetDomain}`);
                }
            }
        } catch (err) {
            // 42P01 = v34 (agenda) not applied yet. A run must never fail because the Agenda
            // does not exist; it just does not compound until the migration lands.
            noteFailure('Agenda', err);
        }

        // Unconditional: a company_contexts write can fail (and be worth disclosing) even on
        // a run with no startupCtx at all — the two are no longer gated together.
        if (layerFailures.length > 0) {
            // One consolidated line rather than one per failure: these fail together far
            // more often than independently (one dead connection, one expired key), and
            // several near-identical progress entries read like separate incidents.
            ctx.onProgress?.(
                `Note: ${layerFailures.join(', ')} could not be saved. `
                + `This report is complete and unaffected; the next run rebuilds from a weaker baseline.`
            );
        }
    } catch (err) {
        console.error('Unexpected error saving report:', err);
    }
}

// ─── registry ─────────────────────────────────────────────────────────────

/**
 * Ordered pipeline. `context` is skipped unless the job asked the server to build it;
 * every other step runs on every run. The stepped worker walks this list by name.
 */
// Labels come from ./pipelineSteps.js so the progress UI and the executable list
// cannot drift — the worker writes these exact strings to job.current_step, and
// LiveActivityRail matches against them to derive "step N of TOTAL_PIPELINE_STEPS".
const STEP_RUNNERS = {
    context: { run: stepContext, whenServerContext: true },
    memory: { run: stepMemory },
    // `steppedOnly`: early signals are meaningless in the single-invocation monolith,
    // where nothing is shown until the whole run finishes.
    express: { run: stepExpress, cursored: true, steppedOnly: true },
    discover_competitors: { run: stepDiscoverCompetitors },
    validate_exa: { run: stepValidateExa },
    generate_queries: { run: stepGenerateQueries },
    search: { run: stepSearch, cursored: true },
    watch: { run: stepWatch, cursored: true },
    collect: { run: stepCollect, cursored: true },
    v6_pipeline: { run: stepV6Pipeline },
    triage: { run: stepTriage, cursored: true },
    analyze: { run: stepAnalyze, cursored: true },
    verify: { run: stepVerify, cursored: true },
    summary: { run: stepSummary },
    attest: { run: stepAttest },
    review: { run: stepReview },
    interpret: { run: stepInterpret },
    news: { run: stepNews, cursored: true },
    persist: { run: stepPersist }
};

export const PIPELINE_STEPS = PIPELINE_STEP_LABELS.map(({ name, label }) => ({
    name,
    label,
    ...STEP_RUNNERS[name]
}));

export const FIRST_STEP_WITH_CONTEXT = 'memory';

export function getPipelineStep(name) {
    return PIPELINE_STEPS.find(s => s.name === name) || null;
}

export function nextPipelineStep(name) {
    const idx = PIPELINE_STEPS.findIndex(s => s.name === name);
    return idx >= 0 && idx < PIPELINE_STEPS.length - 1 ? PIPELINE_STEPS[idx + 1].name : null;
}

/**
 * Run one step. Returns `{ defer }` when the step ran out of invocation budget mid-cursor,
 * or `{ pause }` when it deliberately parked the job (context review).
 */
export async function runPipelineStep(stepName, state, ctx) {
    const step = getPipelineStep(stepName);
    if (!step) throw new Error(`Unknown pipeline step: ${stepName}`);
    const outcome = await step.run(state, ctx) || {};
    return { defer: Boolean(outcome.defer), pause: outcome.pause || null };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MONOLITH DRIVER — every step in one invocation.
//
// NOT "retained for the browser". Nothing under src/components imports this: the dashboard
// submits a job and polls it. Its only caller is runMonolith() in api/_intelligenceWorker.js,
// reached solely when STEPPED_PIPELINE=0 — a hosting-tier fallback, because the stepped
// pipeline needs 60-second functions and cannot run on a 10-second tier at all.
//
// The stale claim mattered: it is why the multi-agent plan spent a revision designing the
// deprecation of a browser pipeline that had already been removed.
//
// This is a second DRIVER over the same PIPELINE_STEPS registry, not a second pipeline —
// the loop below dispatches the identical step functions the stepped worker calls one at a
// time. Keep it that way: correctness (contracts, budgets, gates) belongs in the steps, and
// a driver may own only invocation mechanics. Anything a driver owns exclusively is
// behaviour the other driver silently skips. Pinned by scripts/pipeline-drivers.test.mjs.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function runSignalGeneration(inputs, contextJson, onProgress, user = null, profile = null) {
    const timer = new PipelineTimer(PIPELINE_MAX_MS); // Hobby-safe budget (env: PIPELINE_MAX_MS)
    _runProvenance = []; // start a fresh provenance log for this run
    _runSpend = emptySpend(); // and a fresh spend ledger

    const state = createPipelineState(contextJson);
    const ctx = {
        job: {
            websiteUrl: inputs.websiteUrl,
            userId: user?.id || null,
            clientId: profile?.client_id || null,
            analysisMode: profile?.analysis_mode || (contextJson?._decision ? DECISION_MODE : 'company'),
            decisionId: profile?.decision_id || contextJson?._decision?.id || null,
            decisionContext: profile?.decision_context || contextJson?._decision || null,
            // Product mode CAN reach the monolith driver (STEPPED_PIPELINE=0 is orthogonal to
            // analysis_mode) — see lib/_intelligenceWorker.js runMonolith, which now forwards
            // both fields on the profile it builds from the job row.
            targetId: profile?.target_id || null,
            productContext: profile?.product_context || null
        },
        onProgress,
        timer,
        stepped: false
    };

    for (const step of PIPELINE_STEPS) {
        if (step.whenServerContext) continue; // context is already built by the caller
        // Declarative rather than an in-step `if (!ctx.stepped) return`, which is exactly
        // the driver divergence scripts/pipeline-drivers.test.mjs exists to catch. Express
        // only earns its cost when there is a screen watching it fill in.
        if (step.steppedOnly) continue;
        await step.run(state, ctx);
    }

    addRunWallClock(timer.elapsed()); // single invocation, so this is the whole run
    console.log(`[Pipeline] Complete in ${(timer.elapsed() / 1000).toFixed(1)}s: ${timer.summary()} | spend: ${JSON.stringify(getRunSpend().cost_usd.total)} USD est.`);
    return state.report || buildReportData(state, ctx);
}

/**
 * Bahirjee's context-first Q&A (v29 follow-up — Move 5 of the company-context plan).
 *
 * Three stages, in order, and Stage 2 only runs when Stage 1 actually falls short:
 *   1. Answer from what the platform already has — the confirmed context (with per-fact
 *      provenance, v27), retrieved signals/observations (knowledgeChunks, v29), and
 *      uploaded-doc excerpts (ragChunks). The model returns a small envelope —
 *      { answer, sufficiency, stale_facts_cited } — instead of a bare string, so escalation
 *      is a real decision, not a regex guess at the answer text.
 *   2. Escalate to a live web search ONLY when Stage 1 was not enough: low/medium
 *      sufficiency, a low-quality answer, or the model cited a fact this run's own
 *      provenance ledger already knows is stale (checked against staleFacts, never
 *      trusted blind — the model can only cite a field it was actually shown).
 *   3. Write a confident Stage-2 finding back as an embedded observation — opts.clientId
 *      required — so the NEXT identical question is answered from Stage 1, not paid for
 *      again. Best-effort; a failed write-back never affects the answer already produced.
 *
 * `opts.clientId` and `opts.knowledgeChunks` are optional — omitting them degrades to
 * Stage 1 running with no knowledge-base retrieval and Stage 3 disabled, never a throw.
 */
export async function askBahirjee(context, signal, question, ragChunks = [], opts = {}) {
    const { clientId = null, knowledgeChunks = [] } = opts;

    // Use compressed context cache to avoid re-encoding on every question (§5.9)
    const compressedContext = getCompressedContext(context);
    const memorySeed = context?.memory?.current_cards || context?._companyMemory?.current_cards || [];
    const memorySummary = Array.isArray(memorySeed)
        ? memorySeed
            .filter(card => card?.status === 'active')
            .slice(0, 8)
            .map((card, i) => `[${i + 1}] ${card.section_key}: ${card.title} (${card.trend_state || 'new'}, x${card.occurrence_count || 1})`)
            .join('\n')
        : '';
    const memoryLine = memorySummary ? `Current memory:\n${memorySummary}` : '';
    const focusedSignalLine = signal
        ? `\n\nFocused signal: ${signal.signal_headline || signal.category || 'unknown'}`
        : '';
    const ragLine = Array.isArray(ragChunks) && ragChunks.length > 0
        ? `\n\nRelevant document excerpts:\n${ragChunks.map((c, i) => `[${i + 1}] ${String(c.content || c).slice(0, 800)}`).join('\n\n')}`
        : '';
    const digest = `${compressedContext}${memoryLine ? '\n\n' + memoryLine : ''}${ragLine}${focusedSignalLine}`.trim();

    // Per-fact ages from context._factProvenance (v27) — computed here with THIS process's
    // clock, never asked of the model. The model only echoes back field names from this
    // list (stale_facts_cited); it never sees or invents a date itself.
    const staleFacts = listStaleFacts(context);
    const knownStaleFields = new Set(staleFacts.map(f => f.field));

    const payload = {
        context: buildAnswerContext(context),
        digest,
        signal,
        question,
    };

    const basePayload = {
        ...payload,
        ragChunks,
        knowledgeChunks,
        staleFacts,
        compressedContext,
        memoryLine
    };

    // ─── Stage 1 — answer from what the platform already has ──────────────
    let answer = '';
    let sufficiency = 'low';
    let citedStale = [];
    try {
        const envelope = await callLLMWithRetry('answerQuestion', basePayload);
        answer = envelope?.answer || '';
        sufficiency = envelope?.sufficiency || 'low';
        citedStale = Array.isArray(envelope?.stale_facts_cited) ? envelope.stale_facts_cited : [];
    } catch (e) {
        console.warn('[askBahirjee] Stage 1 (context-first) fetch failed:', e.message);
    }

    // Trust the model's citation only against fields it was actually shown — never let it
    // force an escalation over a "stale fact" it invented.
    const citedAKnownStaleFact = citedStale.some(f => knownStaleFields.has(f));
    const stage1Sufficient = answer && !isLowQualityAnswer(answer) && sufficiency === 'high' && !citedAKnownStaleFact;

    // ─── Stage 2 — escalate to a live web search, deliberately ────────────
    if (!stage1Sufficient) {
        try {
            // Unbounded: a founder's question can just as easily be about a stable fact as a
            // recent event, and on topic 'general' a date window silently drops undated pages.
            const searchRes = await fetchTavilySearch(question, {
                search_depth: 'advanced',
                max_results: 5
            });
            const webResultList = searchRes.results || [];
            const webResults = webResultList
                .map(r => `SOURCE: ${r.url}\n${r.raw_content || r.content || ''}`)
                .filter(Boolean)
                .join('\n\n')
                .substring(0, 8000);

            if (webResults.length > 500) {
                const retryEnvelope = await callLLMWithRetry('answerQuestion', { ...basePayload, webResults });
                if (retryEnvelope?.answer) {
                    answer = retryEnvelope.answer;

                    // ─── Stage 3 — write the finding back ──────────────────
                    if (clientId && retryEnvelope.sufficiency === 'high' && !isLowQualityAnswer(answer)) {
                        const citedUrl = webResultList.find(r => r.url)?.url || null;
                        ingestObservation({
                            clientId,
                            text: `Q: ${question}\nA: ${answer}`,
                            sourceUrl: citedUrl,
                            sourceName: question.slice(0, 120),
                            postJsonFn: intelligenceRuntime.postJson,
                        }).catch(err => console.warn('[askBahirjee] Stage 3 write-back failed (answer already returned):', err.message));
                        // Track 2: same finding into the tenant graph, so the
                        // next identical question resolves via recall instead of
                        // paying for the search again. Fire-and-forget.
                        import('./graphMemory.js')
                            .then(({ graphRecordFinding }) => graphRecordFinding({ question, answer, sourceUrl: citedUrl }))
                            .catch(err => console.warn('[askBahirjee] graph write-back failed:', err.message));
                    }
                }
            }
        } catch (e) {
            console.warn('[askBahirjee] Stage 2 (external web) fallback failed:', e.message);
        }
    }

    if (!answer || isLowQualityAnswer(answer)) {
        return 'I found some context but could not produce a confident answer. Please refine your question or try again shortly.';
    }

    return answer;
}
export { getLiveSignals };
