/**
 * brief.v2 — one shape for every kind of run.
 *
 * Company mode and decision mode used to produce structurally different briefs
 * (`{bahirjee_observation, insights}` vs the decision brief's option assessments), so the
 * product read as two products. This module maps both onto the judgment shape:
 *
 *     what changed → why it matters → our read → how confident, and why
 *                  → what could change our view → what to consider
 *
 * Three rules the rest of the pipeline depends on:
 *
 * 1. NOTHING IS REMOVED. `bahirjee_observation` and `insights` are preserved verbatim
 *    because three consumers read them directly — `BahirjeeObservationHero`,
 *    `filterEchoInsights`, and `buildReportMemory`, which rewrites `brief.insights[i]`
 *    with memory cards and drives the continuity panel. `our_read` is an ALIAS written
 *    here, not a new key the model must emit; fewer required keys means fewer JSON
 *    repair failures.
 *
 * 2. `what_changed` IS DETERMINISTIC. It is built from the signal set, never asked of the
 *    model, so every claim carries a real `evidence_refs` URL. Provenance is resolved,
 *    never requested — the same rule that governs `source_class`.
 *
 * 3. CONFIDENCE IS COMPUTED, NEVER TAKEN. See `calibrateConfidence`.
 *
 * Applied on the WRITE path (end of buildReportData) and the READ path
 * (mapReportRowToAppReport). The read path is not optional: `brief` is a plain string on
 * an empty run, and rows in that shape are already persisted.
 */

import { resolveRunTier, DEFAULT_RUN_TIER } from './runTiers.js';
import { isSelfAttesting } from './sourceClass.js';

export const BRIEF_SCHEMA_VERSION = 'brief.v2';

const MAX_WHAT_CHANGED = 6;
const MAX_FALSIFIERS = 6;
const MAX_CONSIDERATIONS = 5;

/** The hard cap. One claim is served with at most this many movements beneath it. */
export const MAX_MOVEMENTS = 3;

/**
 * Phrases that turn judgment into instruction.
 *
 * ⚠️  This ships WITH the prompt relaxation, not after it. `buildSummary` and
 * `generateDecisionBrief` are now allowed to say what the evidence favours and what a
 * founder would weigh — which is one careless edit away from "you should raise a Series
 * A". This regex is the only executable thing standing between the two.
 *
 * Detection only: a hit is reported, never silently rewritten. Editing a model's words to
 * hide a prompt regression would remove the signal that the prompt regressed.
 */
export const ADVICE_PHRASES = [
    'you should', 'we recommend', 'i recommend', 'consider doing', 'it is advisable',
    'act now', 'make sure to', 'the next step is', 'you need to', 'you must',
    'prioritise', 'prioritize', 'focus on', 'be sure to', 'start by', "don't wait",
    // Opportunity-shaped instructions. The opportunity block describes a door; these
    // phrases walk the founder through it.
    // Second-person / door forms only: a bare "apply before" or "reach out to" is also how a
    // source states a fact about someone else ("the rules apply before the audit").
    'worth applying', 'you could apply', 'apply to this call', 'apply to this programme',
    'apply to this program', 'apply to this grant', 'reach out to them',
    'you could reach out', 'pursue this opportunity',
];

const ADVICE_RE = new RegExp(`\\b(${ADVICE_PHRASES.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');

/** Every advice phrase present in `text`. Empty means clean. */
export function detectAdviceLeakage(text) {
    const value = String(text || '');
    return ADVICE_PHRASES.filter(phrase => new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(value));
}

export function hasAdviceLeakage(text) {
    return ADVICE_RE.test(String(text || ''));
}

const clean = (value, limit = 600) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

function hostOf(url) {
    try {
        return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return null;
    }
}

function dedupeByText(items, limit) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const key = clean(item?.text, 160).toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
        if (out.length >= limit) break;
    }
    return out;
}

/**
 * Confidence, computed from the evidence actually gathered.
 *
 * `High` requires `depth === 'full'`. That is the product mechanic, not a detail: a
 * shallow run is structurally incapable of reporting High confidence, which is what makes
 * "uncertainty is the paywall" true rather than a slogan. Without this the free tier would
 * cheerfully report High on eight searches and there would be nothing left to sell.
 *
 * The model's own claim is accepted only when it is at or below this ceiling — it may be
 * more humble than the arithmetic, never more certain.
 */
export function calibrateConfidence({ signals = [], depth = DEFAULT_RUN_TIER, claimed = null, gates = [] } = {}) {
    const grounded = signals.filter(s => hostOf(s?.source_url));
    const domains = new Set(grounded.map(s => hostOf(s.source_url)));
    const classes = new Set(grounded.map(s => s?.source_class).filter(Boolean));
    const isFull = resolveRunTier(depth).name === 'full';

    const evidence_count = grounded.length;
    const unique_domains = domains.size;
    const source_classes = classes.size;

    // ── Calibration note (2026-08-16, revised) ───────────────────────────────
    // The original note recorded that source-class diversity was measured but deliberately
    // NOT gated, because live runs produced zero classes and gating on an always-empty
    // field would pin every run to Low. It attributed the emptiness to attachSourceClass
    // matching URLs by exact string.
    //
    // That was half the cause. The larger half: getObservationsForRun never SELECTED
    // source_class, so on the stepped pipeline the field never reached attachSourceClass
    // at all and the lookup was empty before a single URL was compared. Both are fixed.
    // Classes now populate, so the note's own instruction applies — `>= 2` for Medium,
    // `>= 3` for High.
    let ceiling = 'Low';
    if (evidence_count >= 5 && unique_domains >= 3 && source_classes >= 2) ceiling = 'Medium';
    if (evidence_count >= 12 && unique_domains >= 6 && source_classes >= 3 && isFull) ceiling = 'High';

    // ── Gates cap the ceiling ────────────────────────────────────────────────
    // Volume is not strength. A live run reported High off 90 findings across 58 domains
    // while the verifier simultaneously reported that 100% of those findings had
    // unverifiable dates and 10 of 12 tracked competitors had no supporting evidence at
    // all. Both facts were already computed, printed, and then ignored by the one number
    // the founder actually reads.
    //
    // One warning is a caveat; two is a pattern. Non-blocking gates are exactly the ones
    // that belong here — a blocking gate stops the run, so it never reaches this function.
    const warnings = (Array.isArray(gates) ? gates : []).filter(g => g?.status === 'warn');
    const RANK = { Low: 0, Medium: 1, High: 2 };
    const ORDER = ['Low', 'Medium', 'High'];
    let gateCeiling = null;
    if (warnings.length === 1) gateCeiling = 'Medium';
    else if (warnings.length >= 2) gateCeiling = 'Low';
    if (gateCeiling && RANK[gateCeiling] < RANK[ceiling]) ceiling = gateCeiling;

    const claimedNorm = ORDER.find(l => l.toLowerCase() === String(claimed || '').trim().toLowerCase());
    const level = claimedNorm && RANK[claimedNorm] < RANK[ceiling] ? claimedNorm : ceiling;

    const basisParts = [
        `${evidence_count} sourced finding${evidence_count === 1 ? '' : 's'}`,
        `${unique_domains} domain${unique_domains === 1 ? '' : 's'}`,
        `${source_classes} kind${source_classes === 1 ? '' : 's'} of source`,
    ];
    if (!isFull) basisParts.push('shallow scan — a full run is required for high confidence');

    // Name what held it back, so the level is auditable rather than merely asserted.
    let basis = basisParts.join(', ') + '.';
    if (warnings.length) {
        basis += ` Held at ${ceiling} by ${warnings.length} unresolved check${warnings.length === 1 ? '' : 's'}: ` +
            warnings.map(w => w.detail || w.id).join('; ') + '.';
    }

    return {
        level,
        basis,
        evidence_count,
        unique_domains,
        source_classes,
        depth: isFull ? 'full' : 'shallow',
        // What the gates cost, kept so a run that was capped can be told apart from one
        // that simply had thin evidence.
        capped_by: warnings.length ? warnings.map(w => w.id).filter(Boolean) : [],
        // Recorded when the model claimed more than the evidence supports. Kept rather
        // than discarded: repeated overreach is a prompt problem worth seeing.
        claimed: claimedNorm && claimedNorm !== level ? claimedNorm : null,
    };
}

/**
 * "What changed" — the top findings, straight from the signal set.
 *
 * Deterministic on purpose. Asking the model to restate its own evidence is a
 * hallucination surface with no upside, and it would make the grounding check
 * unfalsifiable: every item here carries the URL it came from.
 */
function buildWhatChanged(signals) {
    return [...(Array.isArray(signals) ? signals : [])]
        .filter(s => hostOf(s?.source_url))
        .sort((a, b) => (b?.relevance_score || 0) - (a?.relevance_score || 0))
        .slice(0, MAX_WHAT_CHANGED)
        .map(s => ({
            text: clean(s.the_move || s.signal_headline, 300),
            evidence_refs: [s.source_url],
            source_class: s.source_class || null,
        }))
        .filter(item => item.text);
}

/**
 * Does this sentence describe something that would OVERTURN a read, rather than support it?
 *
 * A falsifier is conditional or negating: it names a state of the world under which the
 * read stops holding. A confirmation asserts the read is already right. The two are easy
 * to tell apart structurally, and getting it wrong in the permissive direction is the
 * expensive one — a confirmation printed under "what could change our view" quietly turns
 * the most adversarial section of the brief into more agreement.
 *
 * Deliberately conservative. A sentence that does not clearly read as a falsifier is
 * dropped, not reworded: the model-supplied and contradiction-derived items are higher
 * trust and already fill this section, so the cost of a false negative is one fewer item.
 */
function readsAsFalsifier(sentence) {
    const s = String(sentence || '').toLowerCase();
    if (!s) return false;
    return [
        /\bif\b/, /\bunless\b/, /\bwere\b/, /\bshould\b/, /\bwould\s+(?:be\s+)?(?:wrong|invalid|weaken|change|overturn)/,
        /\bfail(?:s|ed|ing)?\b/, /\bstops?\b/, /\bstalls?\b/, /\breverses?\b/, /\bno longer\b/,
        /\bdoes not\b/, /\bdo not\b/, /\bdoesn't\b/, /\bdon't\b/, /\bwithout\b/,
        /\brather than\b/, /\binstead of\b/, /\bcontrary\b/, /\bhowever\b/, /\bbut\b/,
        /\bweaken/, /\bovertur/, /\binvalidat/, /\bcontradict/, /\bwrong\b/,
    ].some(re => re.test(s));
}

/**
 * "What could change our view" — assembled from three sources, in trust order.
 *
 * (2) and (3) are why this is satisfiable without asking the model twice. Both already
 * exist on every run and neither was ever shown to the founder:
 *   - `context.contradictions` is produced by `buildContext` and rendered nowhere.
 *   - each signal's `analyst_note` already ends with the thing that would overturn its
 *     read, buried behind a collapsed "Why This Read" disclosure.
 */
/**
 * The `watch_for` stamped on a falsifier derived from `context.contradictions`.
 *
 * Exported because it is the only PROVENANCE marker distinguishing the two very different
 * things this section carries. A model-written or signal-derived falsifier names something
 * that could change IN THE WORLD — "if Janitri announces partnerships with hospital
 * chains". A contradiction names a disagreement between two of our own sources — "Tracxn
 * says 26 employees, LinkedIn says 51-200". Both belong in the brief; only the first is
 * worth standing watch over, because no amount of daily watching resolves the second.
 *
 * agendaService.harvestQuestions filters on this exact string, so the two must not drift —
 * one literal, derived everywhere it is used, the same rule as signalTaxonomy and
 * sourceClass. scripts/agenda.test.mjs asserts the pairing.
 */
export const CONTRADICTION_WATCH_FOR = 'An unresolved contradiction in your own context.';

function buildFalsifiers({ modelItems = [], contradictions = [], signals = [] }) {
    const fromModel = (Array.isArray(modelItems) ? modelItems : []).map(item => ({
        text: clean(typeof item === 'string' ? item : item?.text, 400),
        watch_for: clean(typeof item === 'object' ? item?.watch_for : '', 200) || null,
    }));

    const fromContradictions = (Array.isArray(contradictions) ? contradictions : []).map(c => ({
        text: clean(typeof c === 'string' ? c : c?.observation, 400),
        watch_for: CONTRADICTION_WATCH_FOR,
    }));

    const fromFalsifiers = [...(Array.isArray(signals) ? signals : [])]
        .sort((a, b) => (b?.relevance_score || 0) - (a?.relevance_score || 0))
        .slice(0, 3)
        .map(s => {
            const note = clean(s?.analyst_note, 600);
            if (!note) return null;
            // The prompt asks for "what would confirm or overturn it" in the last sentence
            // of the analyst note — but it is free to write either, and the tail was taken
            // unconditionally. A live brief listed "This trend is a strong driver for
            // Edgistify's growth." under what could change our view. That is a
            // confirmation; publishing it as a falsifier is worse than publishing nothing,
            // because the section's entire value is that it is adversarial.
            const sentences = note.split(/(?<=[.!?])\s+/).filter(Boolean);
            const tail = sentences.length > 1 ? sentences[sentences.length - 1] : note;
            if (!readsAsFalsifier(tail)) return null;
            // `watch_for` is "where it would show up first". The entity is a real answer to
            // that; a bare hostname ("Watch: dhl.com") is just the citation restated, and a
            // full article URL is where it showed up LAST, not where it will show up next.
            return {
                text: clean(tail, 400),
                watch_for: clean(s?.entity_involved, 200) || null,
                source_url: s?.source_url || null,
            };
        })
        .filter(Boolean);

    return dedupeByText([...fromModel, ...fromContradictions, ...fromFalsifiers].filter(i => i.text), MAX_FALSIFIERS);
}

function buildConsiderations(items) {
    return dedupeByText(
        (Array.isArray(items) ? items : []).map(item => ({
            text: clean(typeof item === 'string' ? item : item?.text, 400),
            tradeoff: clean(typeof item === 'object' ? item?.tradeoff : '', 300) || null,
        })).filter(i => i.text),
        MAX_CONSIDERATIONS
    );
}

/**
 * Map any brief this pipeline has ever produced onto brief.v2.
 *
 * Idempotent: re-normalizing an already-v2 brief returns an equivalent object, which
 * matters because the write path and the read path both call it.
 */
export function normalizeBrief(raw, { kind = 'company', signals = [], context = {}, tier = DEFAULT_RUN_TIER, decisionFrame = null, gates = [] } = {}) {
    // An empty run persists `brief` as a plain STRING. Rows in that shape already exist in
    // the database, which is why the read path must normalize too.
    if (typeof raw === 'string' || raw == null) {
        const headline = clean(raw, 300) || 'No material shifts detected this run.';
        return {
            schema: BRIEF_SCHEMA_VERSION,
            kind,
            headline,
            what_changed: [],
            why_it_matters: '',
            our_read: headline,
            confidence: calibrateConfidence({ signals: [], depth: tier, gates }),
            what_could_change_our_view: [
                { text: 'A wider scan of the same period, which may surface evidence this run did not reach.', watch_for: null },
                { text: 'Any move by a tracked competitor between now and the next run.', watch_for: null },
            ],
            what_to_consider: [],
            assumption_status: [],
            bahirjee_observation: headline,
            insights: [],
            decision_context: decisionFrame || null,
        };
    }

    const source = typeof raw === 'object' ? raw : {};
    const isDecision = kind === 'decision' || source.type === 'decision' || Boolean(source.decision_snapshot);

    // `current_read` is the decision brief's name for the same thing.
    const ourRead = clean(source.our_read || source.bahirjee_observation || source.current_read, 1200);

    const confidence = calibrateConfidence({
        signals,
        depth: tier,
        claimed: typeof source.confidence === 'string' ? source.confidence : source.confidence?.level,
        gates,
    });

    const considerations = buildConsiderations(
        source.what_to_consider
        // The decision brief already produces both of these; they are considerations in
        // everything but name.
        ?? [...(source.validation_steps || []), ...(source.tradeoffs || [])]
    );

    return {
        schema: BRIEF_SCHEMA_VERSION,
        kind: isDecision ? 'decision' : (kind || 'company'),
        headline: clean(source.headline || source.decision_snapshot || decisionFrame?.decision_statement, 300)
            || clean(ourRead.split(/(?<=[.!?])\s+/)[0], 300),
        what_changed: source.what_changed?.length ? source.what_changed : buildWhatChanged(signals),
        why_it_matters: clean(source.why_it_matters, 1200),
        our_read: ourRead,
        confidence,
        what_could_change_our_view: buildFalsifiers({
            modelItems: source.what_could_change_our_view || source.what_would_change_assessment || [],
            contradictions: context?.contradictions || [],
            signals,
        }),
        what_to_consider: considerations,
        assumption_status: Array.isArray(source.assumption_status) ? source.assumption_status : [],

        // ── Preserved verbatim. Removing any of these breaks a live consumer. ──
        bahirjee_observation: source.bahirjee_observation || ourRead,
        insights: Array.isArray(source.insights) ? source.insights : [],
        option_assessments: Array.isArray(source.option_assessments) ? source.option_assessments : [],
        tradeoffs: Array.isArray(source.tradeoffs) ? source.tradeoffs : [],
        unknowns: Array.isArray(source.unknowns) ? source.unknowns : [],
        validation_steps: Array.isArray(source.validation_steps) ? source.validation_steps : [],
        follow_up_questions: Array.isArray(source.follow_up_questions) ? source.follow_up_questions : [],
        decision_context: source.decision_context || decisionFrame || null,
        ...(isDecision ? { type: 'decision' } : {}),
    };
}

/**
 * One claim, three movements.
 *
 * The pipeline routinely finds twenty things worth knowing. A founder with four minutes
 * reads the top of a list of twenty and leaves, so serving all of them is not generosity —
 * it is handing back the sorting job they were paying to have done. This function is where
 * the product exercises judgment about its own output.
 *
 * The cap is enforced HERE rather than configured per surface, because a surface-level
 * default is one careless prop away from being twenty again. `rest` is returned rather
 * than discarded: everything stays reachable under "everything else I saw", just never
 * above the fold.
 *
 * Deterministic throughout. `what_changed` is already built from the signal set in
 * relevance order (see `buildWhatChanged`), so this re-ranks nothing and invents nothing —
 * it selects, and enriches each selection with the provenance the founder needs to judge
 * it without clicking.
 *
 * @returns {{claim: string, movements: Array<object>, rest: Array<object>, total: number}}
 */
export function selectClaimAndMovements(brief, signals = []) {
    const safeBrief = brief && typeof brief === 'object' ? brief : {};
    const changed = Array.isArray(safeBrief.what_changed) ? safeBrief.what_changed : [];

    // The claim is the brief's own headline. Falling back to the first sentence of the
    // read mirrors what `normalizeBrief` does, so a v1 brief still produces a claim.
    const claim = clean(safeBrief.headline, 300)
        || clean(String(safeBrief.our_read || '').split(/(?<=[.!?])\s+/)[0], 300)
        || '';

    const index = indexSignalsByUrl(signals);
    const enriched = changed.map(item => enrichMovement(item, index));

    return {
        claim,
        movements: enriched.slice(0, MAX_MOVEMENTS),
        rest: enriched.slice(MAX_MOVEMENTS),
        total: enriched.length,
    };
}

/**
 * Normalised URL key.
 *
 * ⚠️ Exact-string matching is what broke `attachSourceClass`: it compared observation URLs
 * to signal URLs character for character, almost never hit, and every persisted signal
 * carried no class for months while nothing errored. Same two URL populations, same join,
 * so the same failure is available here — hence normalising rather than comparing raw.
 *
 * Host is lowercased and de-www'd; the fragment and common tracking parameters are
 * dropped; a trailing slash is removed. The path and any remaining query are kept, because
 * they can be the whole identity of a page.
 */
function urlKey(url) {
    try {
        const u = new URL(String(url));
        u.hash = '';
        for (const p of [...u.searchParams.keys()]) {
            if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref|source$)/i.test(p)) u.searchParams.delete(p);
        }
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        const path = u.pathname.replace(/\/+$/, '');
        return `${host}${path}${u.search}`;
    } catch {
        return null;
    }
}

/** Every signal reachable by any URL it cites, primary or corroborating. */
function indexSignalsByUrl(signals) {
    const index = new Map();
    for (const signal of Array.isArray(signals) ? signals : []) {
        for (const url of [signal?.source_url, ...(signal?.corroborating_urls || [])]) {
            const key = urlKey(url);
            if (key && !index.has(key)) index.set(key, signal);
        }
    }
    return index;
}

/**
 * Attach the provenance a reader needs to weigh a movement without leaving the page:
 * where it came from, when, how it was known, and whether anything corroborates it.
 *
 * A date is printed only when the source actually carried one. `date_confidence: 'low'`
 * means the model could not find a real date, and a guessed date in a letter reads as
 * breaking news — "prefer a gap over a guess anywhere the founder might act on the value".
 */
function enrichMovement(item, index) {
    const url = item?.evidence_refs?.[0] || null;
    const signal = url ? index.get(urlKey(url)) || null : null;
    const sourceClass = item?.source_class || signal?.source_class || null;
    const corroboration = (signal?.corroborating_urls || []).length;

    const dateIsTrustworthy = Boolean(signal?.date) && signal?.date_confidence !== 'low';

    return {
        text: clean(item?.text, 300),
        url,
        host: hostOf(url),
        source_class: sourceClass,
        date: dateIsTrustworthy ? signal.date : null,
        corroboration,
        // A lone account of an event, as opposed to the primary record of one. Drives the
        // "one source, unconfirmed" caveat — see `isSelfAttesting`.
        needs_caveat: corroboration === 0 && !isSelfAttesting(sourceClass),
        entity: clean(signal?.entity_involved, 120) || null,
    };
}

/** Every advice phrase found in the judgment-bearing fields of a brief. */
export function auditBriefVoice(brief) {
    if (!brief || typeof brief !== 'object') return [];
    const fields = [
        ['our_read', brief.our_read],
        ['why_it_matters', brief.why_it_matters],
        ...(brief.what_to_consider || []).map((c, i) => [`what_to_consider[${i}]`, c?.text]),
    ];
    return fields
        .map(([field, text]) => ({ field, phrases: detectAdviceLeakage(text) }))
        .filter(entry => entry.phrases.length > 0);
}
