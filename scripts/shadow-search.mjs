#!/usr/bin/env node

/**
 * Shadow-search harness — Tavily (incumbent) vs Parallel Search (candidate).
 *
 * WHY THIS EXISTS
 * ---------------
 * Parallel Search is ~15x cheaper per run than Tavily at list price ($1/1k requests for 10
 * results, vs 2 Tavily credits for 6 results at $0.008/credit — both figures measured, not
 * quoted). That alone does not justify a migration. The question that actually decides it is
 * whether the cheaper provider yields the same *signal*, and that cannot be reasoned to from
 * pricing pages. So this runs both providers over the same real queries and compares what
 * each one actually delivers into the pipeline.
 *
 * THE METRIC THAT MATTERS
 * -----------------------
 * `compressObservation` truncates every observation to MAX_SNIPPET_CHARS (1200) before the
 * model ever sees it. Tavily returns 12k-28k chars per result and the pipeline throws away
 * 90-96% of it. Parallel returns ~2-2.7k of pre-selected excerpt. If both clear 1200 chars
 * post-compression, the "Parallel returns less text" objection is moot — you are paying
 * Tavily to fetch bytes that are discarded before inference. This harness reports
 * fetched-vs-delivered per provider so that argument is settled with numbers.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * Writes nothing. It reads queries from past runs and calls providers; it never inserts an
 * observation, never touches a report, and never mutates a job. Safe to run against prod.
 *
 * COST
 * ----
 * Real money, both providers. Default 6 queries ≈ 12 Tavily credits (~$0.10 at PAYG) +
 * 6 Parallel searches (~$0.006). `--signals` adds 2 Gemini analyze batches on top.
 *
 * USAGE
 *   node --env-file=.env scripts/shadow-search.mjs
 *   node --env-file=.env scripts/shadow-search.mjs --queries 12 --mode one-shot
 *   node --env-file=.env scripts/shadow-search.mjs --signals          # + LLM signal yield
 *   node --env-file=.env scripts/shadow-search.mjs --run-id <uuid>    # queries from one run
 *   node --env-file=.env scripts/shadow-search.mjs --json out.json    # machine-readable dump
 */

import { createClient } from '@supabase/supabase-js';
import { internalPostJson } from '../lib/_internalRouteClient.js';
import { compressObservation, normalizeSignalResponse } from '../src/services/intelligenceService.js';
import { generateContextAwareQueries, flattenQueriesForTavily } from '../src/services/queryGenerator.js';
import { profileFromContext } from '../src/services/sourceTiers.js';

// ─── args ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const QUERY_COUNT = Math.max(1, Number(val('queries', 6)) || 6);
const PARALLEL_MODE = val('mode', 'fast');            // fast | one-shot | agentic
const RUN_ID = val('run-id', null);
const JSON_OUT = val('json', null);
const WITH_SIGNALS = flag('signals');
const CONCURRENCY = 3;

// Measured, not quoted: `include_usage:true` on api.tavily.com/search returns
// {credits:1} for search_depth 'basic' and {credits:2} for 'advanced', independent of
// max_results. Parallel bills one `sku_search` per request regardless of mode.
const TAVILY_CREDIT_USD = 0.008;              // Tavily PAYG list
const TAVILY_CREDITS_ADVANCED = 2;
const PARALLEL_USD_PER_SEARCH = { 'fast': 0.001, 'one-shot': 0.005, 'agentic': 0.005 };

// Production settings, mirrored so the comparison is against what actually ships.
const SEARCH_RESULTS_PER_QUERY = 6;
const MAX_SNIPPET_CHARS = 1200;
const SEARCHES_PER_RUN = 25;                  // 22 recon + 2 context + 1 LinkedIn

const PARALLEL_KEY = process.env.PARALLEL_AI_API_KEY;
const PARALLEL_BETA = 'search-extract-2025-10-10';

// ─── query sourcing ─────────────────────────────────────────────────────────

/**
 * Real queries from real runs beat invented ones: the whole question is how the providers
 * behave on this product's actual query shapes, which are template-generated and unusual.
 */
const FALLBACK_QUERIES = [
    { query: 'GST billing software India pricing change 2026', theme: 'pricing_moves' },
    { query: 'Khatabook vs Vyapar small business accounting competition', theme: 'competitor_intel' },
    { query: 'Indian SMB fintech funding round 2026', theme: 'funding_intel' },
    { query: 'GST e-invoicing compliance rule change India', theme: 'regulatory_lens' },
    { query: 'accounting software hiring engineering India', theme: 'talent_signals' },
    { query: 'small business billing app user reviews complaints', theme: 'customer_shifts' },
];

async function loadQueries(limit) {
    const url = process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        console.warn('! Supabase creds absent — using built-in fallback queries');
        return FALLBACK_QUERIES.slice(0, limit);
    }

    // The literal query string is never persisted (observations stores theme/entity, not
    // `job`), so real queries cannot be read back. Regenerate them instead from a real
    // stored context through the production generator — same code path stepGenerateQueries
    // uses, so the shapes are the ones that actually ship.
    const sb = createClient(url, key);
    let q = sb.from('reports').select('id, run_id, context, created_at')
        .order('created_at', { ascending: false }).limit(1);
    if (RUN_ID) q = sb.from('reports').select('id, run_id, context, created_at').eq('run_id', RUN_ID).limit(1);

    const { data, error } = await q;
    const context = data?.[0]?.context;
    if (error || !context) {
        console.warn(`! No stored context available (${error?.message || 'none found'}) — using fallback`);
        return FALLBACK_QUERIES.slice(0, limit);
    }

    try {
        const categorized = generateContextAwareQueries({
            entities: context._trackedEntities || [],
            signalWeights: context._signalWeights || {},
            marketProfile: context.strategic_anchors || {},
            geography: context.operating_geography || 'Global',
            companyName: context.company_name || '',
            customerSegments: context.customer_segments || [],
            tierProfile: profileFromContext(context),
            strategicAssumptions: context.strategic_assumptions || [],
        });
        const flat = flattenQueriesForTavily(categorized);
        const out = [];
        const seen = new Set();
        // Round-robin the buckets so a small --queries sample still spans themes rather
        // than taking N variations of the first one.
        const buckets = Object.entries(flat).filter(([, v]) => Array.isArray(v) && v.length);
        for (let i = 0; out.length < limit && i < 40; i++) {
            for (const [theme, list] of buckets) {
                const query = (list[i] || '').trim?.() || (list[i]?.query || '').trim?.() || '';
                if (!query || seen.has(query)) continue;
                seen.add(query);
                out.push({ query, theme });
                if (out.length >= limit) break;
            }
        }
        if (out.length) {
            console.log(`  queries regenerated from stored context: ${context.company_name || data[0].id}`);
            return out;
        }
    } catch (e) {
        console.warn(`! Query regeneration failed (${e.message}) — using fallback`);
    }
    return FALLBACK_QUERIES.slice(0, limit);
}

// ─── providers ──────────────────────────────────────────────────────────────

/** Tavily through the real /api/search handler, so route-level behaviour is included. */
async function runTavily({ query, theme }) {
    const t0 = Date.now();
    try {
        const res = await internalPostJson('/api/search', {
            query,
            max_results: SEARCH_RESULTS_PER_QUERY,
            search_depth: 'advanced',
            topic: theme === 'funding_intel' || theme === 'regulatory_lens' ? 'news' : 'general',
            days: 180,
        });
        const ms = Date.now() - t0;
        if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}`, results: [] };
        const json = await res.json();
        const results = (json.results || []).slice(0, SEARCH_RESULTS_PER_QUERY).map(r => ({
            url: r.url,
            title: r.title || '',
            published_date: r.published_date || null,
            text: r.raw_content || r.content || '',
        }));
        return { ok: true, ms, results, credits: TAVILY_CREDITS_ADVANCED };
    } catch (e) {
        return { ok: false, ms: Date.now() - t0, error: e.message, results: [] };
    }
}

/** Parallel Search, called directly — there is no route for it yet, which is the point. */
async function runParallel({ query }) {
    const t0 = Date.now();
    try {
        const r = await fetch('https://api.parallel.ai/v1beta/search', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${PARALLEL_KEY}`,
                'Content-Type': 'application/json',
                'parallel-beta': PARALLEL_BETA,
            },
            body: JSON.stringify({ search_queries: [query], mode: PARALLEL_MODE }),
        });
        const ms = Date.now() - t0;
        const json = await r.json();
        if (!r.ok) return { ok: false, ms, error: json?.error?.message || `HTTP ${r.status}`, results: [] };
        const results = (json.results || []).map(x => ({
            url: x.url,
            title: x.title || '',
            published_date: x.publish_date || null,
            text: (x.excerpts || []).join('\n'),
        }));
        const searches = (json.usage || []).find(u => u.name === 'sku_search')?.count ?? 1;
        return { ok: true, ms, results, searches };
    } catch (e) {
        return { ok: false, ms: Date.now() - t0, error: e.message, results: [] };
    }
}

// ─── measurement ────────────────────────────────────────────────────────────

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

/**
 * Fetched vs delivered. `delivered` runs the pipeline's own compressObservation, so it is
 * literally the text the model receives — not an estimate of it.
 */
function measure(results) {
    let fetched = 0, delivered = 0, dated = 0;
    const domains = new Set();
    results.forEach((r, i) => {
        fetched += (r.text || '').length;
        const obs = { url: r.url, data: `TITLE: ${r.title}\nURL: ${r.url}\nCONTENT: ${r.text}`, published_date: r.published_date };
        delivered += compressObservation(obs, i).length;
        if (r.published_date) dated += 1;
        const h = host(r.url);
        if (h) domains.add(h);
    });
    return { n: results.length, fetched, delivered, dated, domains };
}

function toObservations(results, theme, query) {
    return results.map(r => ({
        job: query, theme, url: r.url, title: r.title,
        published_date: r.published_date,
        data: `TITLE: ${r.title}\nURL: ${r.url}\nCONTENT: ${r.text}`,
    }));
}

/** Optional: does the cheaper retrieval actually produce fewer signals? */
async function signalYield(observations, label) {
    if (!observations.length) return { signals: 0, grounded: 0, error: 'no observations' };
    const batchText = observations.slice(0, 15).map((o, i) => compressObservation(o, i)).join('\n\n');
    try {
        const res = await internalPostJson('/api/gemini', {
            action: 'analyzeSignals',
            payload: {
                context: { company_name: 'Shadow Test', industry: 'software' },
                searchResults: batchText,
                startDate: new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10),
                lookbackMonths: 6,
                previousSignals: [],
            },
        });
        if (!res.ok) return { signals: 0, grounded: 0, error: `HTTP ${res.status}` };
        const signals = normalizeSignalResponse(await res.json());
        const urls = new Set(observations.map(o => o.url));
        const grounded = signals.filter(s => {
            const cited = s.source_url || s.url || '';
            return cited && [...urls].some(u => u === cited || host(u) === host(cited));
        }).length;
        return { signals: signals.length, grounded };
    } catch (e) {
        console.warn(`  ! signal yield failed for ${label}: ${e.message}`);
        return { signals: 0, grounded: 0, error: e.message };
    }
}

// ─── run ────────────────────────────────────────────────────────────────────

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
    }));
    return out;
}

const pct = (a, b) => (b === 0 ? '—' : `${Math.round((a / b) * 100)}%`);
const usd = (n) => `$${n.toFixed(4)}`;

async function main() {
    if (!PARALLEL_KEY) { console.error('PARALLEL_AI_API_KEY is required'); process.exit(1); }
    if (!PARALLEL_USD_PER_SEARCH[PARALLEL_MODE]) {
        console.error(`--mode must be one of: ${Object.keys(PARALLEL_USD_PER_SEARCH).join(', ')}`);
        process.exit(1);
    }

    const queries = await loadQueries(QUERY_COUNT);
    console.log(`\nShadow search — Tavily (advanced, ${SEARCH_RESULTS_PER_QUERY} results) vs Parallel (${PARALLEL_MODE})`);
    console.log(`${queries.length} queries${RUN_ID ? ` from run ${RUN_ID}` : ''}${WITH_SIGNALS ? ' · signal yield ON (costs LLM calls)' : ''}\n`);

    const rows = await mapLimit(queries, CONCURRENCY, async (q, i) => {
        const [tav, par] = await Promise.all([runTavily(q), runParallel(q)]);
        const t = measure(tav.results), p = measure(par.results);
        console.log(
            `${String(i + 1).padStart(2)}. ${q.query.slice(0, 58).padEnd(58)}`
            + ` T:${String(t.n).padStart(2)}r/${String(t.delivered).padStart(5)}ch/${String(t.dated).padStart(2)}d ${String(tav.ms).padStart(5)}ms`
            + ` | P:${String(p.n).padStart(2)}r/${String(p.delivered).padStart(5)}ch/${String(p.dated).padStart(2)}d ${String(par.ms).padStart(5)}ms`
            + (tav.ok ? '' : `  [tavily: ${tav.error}]`) + (par.ok ? '' : `  [parallel: ${par.error}]`)
        );
        return { q, tav, par, t, p };
    });

    // ─── aggregate ───
    const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
    const allDomains = (side) => new Set(rows.flatMap(r => [...r[side].domains]));
    const overlap = rows.map(r => {
        const tu = new Set(r.tav.results.map(x => x.url));
        const shared = r.par.results.filter(x => tu.has(x.url)).length;
        const th = new Set([...r.t.domains]), sharedDom = [...r.p.domains].filter(d => th.has(d)).length;
        return { shared, sharedDom, tDom: r.t.domains.size, pDom: r.p.domains.size };
    });

    const tCredits = sum(r => r.tav.credits || 0);
    const pSearches = sum(r => r.par.searches || 0);
    const tCostRun = SEARCHES_PER_RUN * TAVILY_CREDITS_ADVANCED * TAVILY_CREDIT_USD;
    const pCostRun = SEARCHES_PER_RUN * PARALLEL_USD_PER_SEARCH[PARALLEL_MODE];

    const line = (label, a, b) => console.log(`  ${label.padEnd(30)} ${String(a).padStart(16)}   ${String(b).padStart(16)}`);
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`  ${''.padEnd(30)} ${'TAVILY'.padStart(16)}   ${'PARALLEL'.padStart(16)}`);
    console.log(`${'─'.repeat(70)}`);
    line('results returned', sum(r => r.t.n), sum(r => r.p.n));
    line('unique domains', allDomains('t').size, allDomains('p').size);
    line('with published_date', `${sum(r => r.t.dated)} (${pct(sum(r => r.t.dated), sum(r => r.t.n))})`,
                                `${sum(r => r.p.dated)} (${pct(sum(r => r.p.dated), sum(r => r.p.n))})`);
    line('chars FETCHED', sum(r => r.t.fetched).toLocaleString(), sum(r => r.p.fetched).toLocaleString());
    line(`chars DELIVERED (<=${MAX_SNIPPET_CHARS}/obs)`, sum(r => r.t.delivered).toLocaleString(), sum(r => r.p.delivered).toLocaleString());
    line('  -> discarded before LLM', pct(sum(r => r.t.fetched) - sum(r => r.t.delivered), sum(r => r.t.fetched)),
                                      pct(sum(r => r.p.fetched) - sum(r => r.p.delivered), sum(r => r.p.fetched)));
    line('median latency ms', median(rows.map(r => r.tav.ms)), median(rows.map(r => r.par.ms)));
    line('billed this test', `${tCredits} credits`, `${pSearches} searches`);
    line('  = cost of this test', usd(tCredits * TAVILY_CREDIT_USD), usd(pSearches * PARALLEL_USD_PER_SEARCH[PARALLEL_MODE]));
    console.log(`${'─'.repeat(70)}`);
    line(`projected / run (${SEARCHES_PER_RUN} searches)`, usd(tCostRun), usd(pCostRun));
    line('projected / 1,000 runs', usd(tCostRun * 1000), usd(pCostRun * 1000));
    console.log(`${'─'.repeat(70)}`);

    const sharedUrls = overlap.reduce((a, o) => a + o.shared, 0);
    console.log(`\n  Agreement: ${sharedUrls} identical URLs, `
        + `${overlap.reduce((a, o) => a + o.sharedDom, 0)} shared domains across ${rows.length} queries.`);
    console.log('  Low URL overlap is expected and is not itself a defect — different indexes.');
    console.log('  What matters is whether both surface evidence the analyst step can use.');

    if (WITH_SIGNALS) {
        console.log('\n  Signal yield (1 batch of <=15 observations per provider, real analyzeSignals):');
        const tObs = rows.flatMap(r => toObservations(r.tav.results, r.q.theme, r.q.query));
        const pObs = rows.flatMap(r => toObservations(r.par.results, r.q.theme, r.q.query));
        const [ts, ps] = [await signalYield(tObs, 'tavily'), await signalYield(pObs, 'parallel')];
        line('signals extracted', ts.signals, ps.signals);
        line('  grounded in a source', ts.grounded, ps.grounded);
        console.log('\n  This is ONE batch, not a verdict. Re-run across several days and query');
        console.log('  sets before concluding — signal counts are noisy at n=1.');
    } else {
        console.log('\n  Re-run with --signals to compare extracted signal counts (adds LLM cost).');
    }

    if (JSON_OUT) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(JSON_OUT, JSON.stringify({
            generatedAt: new Date().toISOString(), mode: PARALLEL_MODE,
            rows: rows.map(r => ({
                query: r.q.query, theme: r.q.theme,
                tavily: { ...r.t, domains: [...r.t.domains], ms: r.tav.ms, ok: r.tav.ok, error: r.tav.error },
                parallel: { ...r.p, domains: [...r.p.domains], ms: r.par.ms, ok: r.par.ok, error: r.par.error },
            })),
        }, null, 2));
        console.log(`\n  Wrote ${JSON_OUT}`);
    }
    console.log('');
}

function median(xs) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

main().catch(e => { console.error('\nshadow-search failed:', e); process.exit(1); });
