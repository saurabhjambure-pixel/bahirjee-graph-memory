#!/usr/bin/env node

/**
 * Jev shadow harness — would a Jev relevance gate in front of `analyzeSignals` have cost us
 * evidence?
 *
 * WHY THIS EXISTS
 * ---------------
 * `stepAnalyze` filters observations on `(obs.score ?? 1) >= MIN_TAVILY_SCORE` — Tavily's
 * own *query* relevance — then `capObservations()` thins by source class. Nothing in that
 * chain asks whether an observation matters to THIS company. The pipeline's triage step asks
 * that question of Jev (`materialityRequest` in src/services/jevService.js); this harness
 * asks the same question of a past run and checks the answer against where that run's
 * evidence actually ended up — BEFORE any Jev score is allowed to change a live run.
 *
 * THE METRIC THAT MATTERS
 * -----------------------
 * The regret curve: if every observation scoring below T had been dropped, how much evidence
 * that reached the published brief would have been destroyed, and how many analyze batches
 * would have been saved? An observation is graded by where it ended up:
 *
 *   brief   — its URL appears in `brief.what_changed[].evidence_refs`
 *   signal  — its URL appears in a persisted signal's `source_url`
 *   nothing — it cost an analyze batch and produced neither
 *
 * A gate that drops `nothing` rows is free money. A gate that drops `brief` rows is the
 * failure this codebase is most vulnerable to: nothing throws, and the report is quietly
 * worse. The curve prices both at once.
 *
 * HOW IT CALLS JEV
 * ----------------
 * `--live` goes through the pipeline's own gateway (/api/jev, in-process) and client, one
 * observation per request — Jev judges one state per request, and its accuracy falls as the
 * state carries content unrelated to the decision. The wire format lives only in
 * lib/_jevWire.js. Without `--live` the client is a STUB producing deterministic
 * pseudo-scores: stub output measures the harness, never Jev, and every report says which.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * Writes nothing. Reads one stored report and its observations; never inserts an
 * observation, never touches a report, never mutates a job. Safe against prod.
 *
 * COST
 * ----
 * Stub: free. `--live`: one request per analyzed observation (~200), ~500 input tokens each,
 * output free — well under a cent at $0.042/M.
 *
 * USAGE
 *   node --env-file=.env scripts/jev-shadow.mjs                    # stub, latest report
 *   node --env-file=.env scripts/jev-shadow.mjs --run-id <uuid>
 *   node --env-file=.env scripts/jev-shadow.mjs --live             # real Jev (needs JEV_API_KEY)
 *   node --env-file=.env scripts/jev-shadow.mjs --json out.json
 */

import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';
import { compressObservation, normalizeUrlForMatch, planAnalyzeBatches } from '../src/services/intelligenceService.js';
import { isDeepReadSourceType } from '../src/services/observationService.js';
import { compactContext, materialityRequest, scoreFraction, createJevClient } from '../src/services/jevService.js';
import { validateRequest } from '../lib/_jevWire.js';

const JEV_USD_PER_M_INPUT = 0.042; // output is free

// Mirrored from production so the comparison is against what actually ships.
const PER_BATCH_CHARS = 40000;     // floor(MAX_SIGNAL_PAYLOAD_CHARS / 2)

// Thresholds on the materiality scale as a fraction (0 = unrelated … 1 = directly material).
// "Drop below 1/3" drops what Jev placed under "background"; 2/3 under "relevant".
export const THRESHOLDS = [0, 1 / 3, 2 / 3, 1];

// ─── args ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

// ─── pure: the population a gate would actually act on ──────────────────────

/**
 * The observations `analyzeSignals` actually receives, in the order it receives them.
 *
 * A run stores more rows than it analyzes: `planAnalyzeBatches` gates empty rows, collapses
 * duplicate URLs (a deep read replaces its own search result), applies the Tavily score
 * filter and the class-balanced cap. A gate in front of `analyzeSignals` only ever sees the
 * survivors. Runs the pipeline's own function rather than a copy of its rules.
 */
export function analyzedPopulation(observations) {
    const log = console.log;
    console.log = () => {};
    try {
        const { order } = planAnalyzeBatches(observations);
        const byId = new Map(observations.map(o => [o.id, o]));
        return order.map(id => byId.get(id)).filter(Boolean);
    } finally {
        console.log = log;
    }
}

// ─── pure: one request per observation ──────────────────────────────────────

/**
 * The triage request for each observation, exactly as the pipeline builds it. An observation
 * whose request would exceed Jev's limits is REPORTED in `skipped` rather than silently left
 * unscored — an unscored observation is never gated, so a silent skip would make any gate
 * look safer than it is.
 */
export function buildRequests(observations, context) {
    const company = compactContext(context);
    const requests = [];
    const skipped = [];
    observations.forEach((obs, i) => {
        const request = materialityRequest(company, compressObservation(obs, i));
        const check = validateRequest(request);
        if (check.ok) requests[i] = request;
        else { requests[i] = null; skipped.push({ index: i, url: obs.url || null, reason: check.error }); }
    });
    return { requests, skipped };
}

// ─── clients ────────────────────────────────────────────────────────────────

/**
 * Deterministic pseudo-scores so the harness runs end-to-end with no Jev access. Seeded off
 * the URL so re-runs are stable, with a mild lift for deep reads. THIS IS NOT JEV.
 */
export function stubScore(obs) {
    const s = String(obs?.url || obs?.id || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    const base = (h >>> 0) / 4294967295;
    const level = Math.min(3, Math.round(base * 3 + (obs?.isDeepRead ? 0.5 : 0)));
    return level / 3;
}

async function scoreObservations(observations, requests, { live }) {
    if (!live) {
        return { fractions: observations.map((o, i) => (requests[i] ? stubScore(o) : null)), stats: null };
    }
    const { internalPostJson } = await import('../lib/_internalRouteClient.js');
    const client = createJevClient({ post: internalPostJson, endpoint: '/api/jev' });
    const out = await client.decideEach(observations, (_obs, i) => requests[i], { useCase: 'triage' });
    return {
        fractions: out.results.map(a => (a ? scoreFraction(a.material) : null)),
        stats: { answered: out.answered, failed: out.failed, skipped: out.skipped, unavailable: client.isUnavailable() },
    };
}

// ─── pure: outcome grading ──────────────────────────────────────────────────

/**
 * Where a run's evidence actually ended up, as two sets of normalized URLs. Both sides of
 * every comparison go through `normalizeUrlForMatch` — the pipeline's own normalizer — so an
 * `http://` vs `https://` difference cannot make the gate look more destructive than it is.
 */
export function outcomeIndex(report) {
    const brief = new Set();
    const signal = new Set();
    for (const item of report?.brief?.what_changed || []) {
        for (const ref of item?.evidence_refs || []) {
            const n = normalizeUrlForMatch(ref);
            if (n) brief.add(n);
        }
    }
    for (const s of report?.signals || []) {
        const n = normalizeUrlForMatch(s?.source_url);
        if (n) signal.add(n);
    }
    return { brief, signal };
}

export function gradeObservation(obs, outcome) {
    const n = normalizeUrlForMatch(obs?.url);
    if (!n) return 'nothing';
    if (outcome.brief.has(n)) return 'brief';
    if (outcome.signal.has(n)) return 'signal';
    return 'nothing';
}

/**
 * The regret curve. `fractions[i]` is observation i's materiality in [0,1], or null when Jev
 * gave no answer. For each threshold: what a gate would have dropped, and what that cost.
 * `briefLost` decides it: evidence that reached the brief and would not have survived.
 */
export function regretCurve({ observations, fractions, outcome, thresholds = THRESHOLDS }) {
    const graded = observations.map((obs, i) => ({
        obs,
        grade: gradeObservation(obs, outcome),
        score: typeof fractions?.[i] === 'number' ? fractions[i] : null,
        chars: compressObservation(obs, i).length,
    }));

    const totals = {
        n: graded.length,
        brief: graded.filter(g => g.grade === 'brief').length,
        signal: graded.filter(g => g.grade === 'signal').length,
        nothing: graded.filter(g => g.grade === 'nothing').length,
        unscored: graded.filter(g => g.score === null).length,
        chars: graded.reduce((a, g) => a + g.chars, 0),
    };

    const rows = thresholds.map(t => {
        // An unscored observation is never dropped: absent evidence is not evidence of absence.
        const dropped = graded.filter(g => g.score !== null && g.score < t);
        const droppedChars = dropped.reduce((a, g) => a + g.chars, 0);
        return {
            threshold: t,
            dropped: dropped.length,
            droppedChars,
            briefLost: dropped.filter(g => g.grade === 'brief').length,
            signalLost: dropped.filter(g => g.grade === 'signal').length,
            wasteCut: dropped.filter(g => g.grade === 'nothing').length,
            batchesSaved: Math.floor(droppedChars / PER_BATCH_CHARS),
        };
    });

    return { totals, rows, graded };
}

// ─── io ─────────────────────────────────────────────────────────────────────

async function loadRun(runId) {
    const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('VITE_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required');

    const sb = createClient(url, key);
    let q = sb.from('reports')
        .select('id, run_id, context, signals, brief, created_at')
        .order('created_at', { ascending: false })
        .limit(1);
    if (runId) q = sb.from('reports').select('id, run_id, context, signals, brief, created_at').eq('run_id', runId).limit(1);

    const { data, error } = await q;
    if (error) throw new Error(`report fetch failed: ${error.message}`);
    const report = data?.[0];
    if (!report) throw new Error(runId ? `no report for run ${runId}` : 'no reports found');

    const { data: obsRows, error: obsErr } = await sb.from('observations')
        .select('id, theme, source_url, source_type, raw_text, published_date, relevance_score, title, source_class')
        .eq('run_id', report.run_id)
        .order('id', { ascending: true });
    if (obsErr) throw new Error(`observation fetch failed: ${obsErr.message}`);

    const observations = (obsRows || []).map(row => ({
        id: row.id,
        theme: row.theme,
        source: row.source_type,
        data: row.raw_text,
        url: row.source_url,
        title: row.title,
        source_class: row.source_class ?? null,
        published_date: row.published_date,
        score: row.relevance_score ?? null,
        // Must mirror getObservationsForRun exactly: the harness measures what production
        // does. jev-shadow.test.mjs fails the moment the two expressions differ.
        isDeepRead: isDeepReadSourceType(row.source_type),
    }));

    return { report, observations };
}

// ─── run ────────────────────────────────────────────────────────────────────

const pct = (t) => (t === 0 ? '0' : `${Math.round(t * 100)}%`);

async function main() {
    const RUN_ID = val('run-id', null);
    const JSON_OUT = val('json', null);
    const LIVE = flag('live');

    if (LIVE && !process.env.JEV_API_KEY) { console.error('--live requires JEV_API_KEY'); process.exit(1); }

    const { report, observations: stored } = await loadRun(RUN_ID);
    if (!stored.length) { console.error(`run ${report.run_id} has no stored observations`); process.exit(1); }

    const observations = analyzedPopulation(stored);
    const { requests, skipped } = buildRequests(observations, report.context);

    console.log(`\nJev shadow — ${report.context?.company_name || report.id} · run ${report.run_id}`);
    console.log(`  stored ${stored.length} → analyzed ${observations.length} (gate, URL dedupe, score filter, cap)`);
    console.log(`  client: ${LIVE ? 'LIVE — /api/jev → TypeSafe' : 'STUB (deterministic fake scores — measures the harness, not Jev)'}`);
    if (skipped.length) console.log(`  ! ${skipped.length} observation(s) exceed Jev's limits — reported, left unscored, never gated`);

    const { fractions, stats } = await scoreObservations(observations, requests, { live: LIVE });
    if (stats) {
        console.log(`  Jev: ${stats.answered} answered, ${stats.failed} failed, ${stats.skipped} skipped`);
        if (stats.answered === 0) {
            console.error(`\n  Jev answered nothing${stats.unavailable ? ' (no key, or the gateway refused)' : ''} — no curve to draw.`);
            process.exit(1);
        }
    }

    const outcome = outcomeIndex(report);
    const { totals, rows, graded } = regretCurve({ observations, fractions, outcome });

    console.log(`\n  Where this run's evidence actually landed:`);
    console.log(`    reached the brief   ${totals.brief}`);
    console.log(`    became a signal     ${totals.signal}`);
    console.log(`    produced nothing    ${totals.nothing}   <- what a gate should be cutting`);
    if (totals.unscored) console.log(`    unscored            ${totals.unscored}   (never dropped by any threshold)`);

    console.log(`\n${'─'.repeat(78)}`);
    console.log(`  drop below   dropped   brief lost   signal lost   waste cut   batches saved`);
    console.log(`${'─'.repeat(78)}`);
    for (const r of rows) {
        console.log(
            `  ${pct(r.threshold).padStart(9)}   ${String(r.dropped).padStart(7)}   `
            + `${String(r.briefLost).padStart(10)}   ${String(r.signalLost).padStart(11)}   `
            + `${String(r.wasteCut).padStart(9)}   ${String(r.batchesSaved).padStart(13)}`
        );
    }
    console.log(`${'─'.repeat(78)}`);

    const inputTokens = requests.filter(Boolean).reduce((a, r) => a + (validateRequest(r).tokens || 0), 0);
    console.log(`\n  Jev spend for this scan: ~${inputTokens.toLocaleString()} input tokens ≈ $${((inputTokens / 1e6) * JEV_USD_PER_M_INPUT).toFixed(5)} (output free)`);
    console.log(`  Compare against ~${Math.ceil(totals.chars / PER_BATCH_CHARS)} Gemini analyze batch(es) for the same observations.`);

    if (!LIVE) {
        console.log(`\n  ⚠ STUB RUN. The curve above is a plumbing test, not a verdict on Jev.`);
        console.log(`    Set JEV_API_KEY (and allowlist api.typesafe.ai) and re-run with --live.`);
    }
    console.log(`\n  One run is not a verdict either. Read the curve across several runs before`);
    console.log(`  switching JEV_TRIAGE on — and treat any nonzero "brief lost" as disqualifying.\n`);

    if (JSON_OUT) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(JSON_OUT, JSON.stringify({
            generatedAt: new Date().toISOString(),
            client: LIVE ? 'live' : 'stub',
            runId: report.run_id,
            company: report.context?.company_name || null,
            totals, rows, skipped, jev: stats,
            observations: graded.map(g => ({ url: g.obs.url, grade: g.grade, score: g.score, chars: g.chars })),
        }, null, 2));
        console.log(`  Wrote ${JSON_OUT}\n`);
    }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch(e => { console.error('\njev-shadow failed:', e.message); process.exit(1); });
