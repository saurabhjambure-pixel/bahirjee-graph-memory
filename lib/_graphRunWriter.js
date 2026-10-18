/**
 * Analysis run → tenant memory graph.
 *
 * Until this existed the main intelligence pipeline wrote nothing to the graph: a founder
 * could finish a full run and open `bahirjee:{client_id}` in FalkorDB Browser to find it
 * empty until the next daily cron. Called by the worker (lib/_intelligenceWorker.js) once a
 * run's report is persisted and its job completed.
 *
 * What one run writes, all through the whitelisted helpers in _graphWriter.js:
 *   Company  co:{client_id}                      (name, domain)
 *   Entity   ent:{id | name_key}                 per tracked entity, Company-[:MONITORS]->Entity
 *   Session  sess:run:{run_id}                   kind 'analysis_run', run_id, report_id
 *   Finding  fnd:run:{run_id}:{signal hash}      per published signal
 *            Finding-[:ABOUT]->Entity (entity_involved)
 *            Finding-[:SUPPORTED_BY]->Evidence  ev:run:{run_id}:{signal hash} (source_url)
 *            Evidence-[:ABOUT]->Entity
 *
 * Every id is derived from run_id (minted once per run and rehydrated on every resume) and
 * the signal's own content, so a worker retry re-MERGEs the same nodes instead of adding a
 * second copy of the run.
 *
 * Same contract as every other graph writer: fail-open. Never throws, never makes the run
 * wait longer than GRAPH_RUN_WRITE_BUDGET_MS, and MEMORY_GRAPH_ENABLED != 1 is a no-op that
 * issues no query at all. Past the budget no NEW write is issued; one already in flight is
 * abandoned rather than awaited.
 *
 * Server-side only — imports the falkordb client through _graph.js.
 */

import { createHash } from 'node:crypto';
import { isGraphEnabled } from './_graph.js';
import { graphWriteCompany, graphWriteEntity, graphWriteFinding, graphWriteSession } from './_graphWriter.js';

const WRITE_BUDGET_MS = Number(process.env.GRAPH_RUN_WRITE_BUDGET_MS || 8000);
// A full-tier run publishes well under these; the caps only bound a pathological report.
const MAX_ENTITIES = 30;
const MAX_FINDINGS = 40;
// Writes are independent MERGEs (FalkorDB applies each atomically), so a few can be in
// flight at once — sequential round trips to a cloud instance would blow the budget.
const CONCURRENCY = 6;

const hostOf = (url) => {
    try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, ''); }
    catch { return null; }
};

/** Stable per-signal key: the same signal on a retried persist hashes the same. */
export function signalSeed(runId, signal) {
    const basis = [signal?.source_url, signal?.signal_headline || signal?.the_move, signal?.entity_involved]
        .map(v => String(v || '').trim().toLowerCase())
        .join('|');
    return `run:${runId}:${createHash('sha1').update(basis).digest('hex').slice(0, 16)}`;
}

async function runBounded(tasks, { deadline }) {
    let next = 0;
    let written = 0;
    const worker = async () => {
        while (next < tasks.length && Date.now() < deadline) {
            const task = tasks[next++];
            try { if (await task()) written++; }
            catch (err) { console.warn('[graph-run] write failed:', err?.message || err); }
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
    return written;
}

async function writeRun(clientId, { runId, reportId, report, websiteUrl, analysisMode }, deadline) {
    const context = report?.context || {};
    const signals = (Array.isArray(report?.signals) ? report.signals : []).slice(0, MAX_FINDINGS);
    const tracked = (report?.contextLayer?.trackedEntities || context._trackedEntities || [])
        .filter(e => e?.name)
        .slice(0, MAX_ENTITIES);

    // Company first: every Entity's MONITORS edge MATCHes it.
    const company = await graphWriteCompany(clientId, {
        name: context.company_name || null,
        domain: hostOf(websiteUrl || report?.inputs?.websiteUrl || ''),
    });

    if (Date.now() >= deadline) return null;
    const session = await graphWriteSession(clientId, {
        sessionId: `run:${runId}`,
        kind: 'analysis_run',
        props: {
            run_id: runId,
            report_id: reportId || null,
            analysis_mode: analysisMode || report?.report_kind || 'company',
            signal_count: signals.length,
        },
    });

    const entities = Date.now() < deadline
        ? await runBounded(tracked.map(e => () => graphWriteEntity(clientId, {
            entityId: e.id || null,
            name: e.name,
            category: e.category || null,
        })), { deadline })
        : 0;

    const observedAt = Date.parse(report?.timestamp || '') || Date.now();
    const findings = Date.now() < deadline
        ? await runBounded(signals
            .filter(s => s?.signal_headline || s?.the_move)
            .map(s => () => graphWriteFinding(clientId, {
                seed: signalSeed(runId, s),
                headline: String(s.signal_headline || s.the_move).slice(0, 300),
                entityName: s.entity_involved || null,
                url: s.source_url || null,
                sourceType: 'analysis_run',
                observedAt,
                props: {
                    run_id: runId,
                    report_id: reportId || null,
                    category: s.category || null,
                    relevance_score: Number.isFinite(s.relevance_score) ? s.relevance_score : null,
                },
            })), { deadline })
        : 0;

    return { company: Boolean(company), session: Boolean(session), entities, findings };
}

/**
 * Write one completed run into the tenant graph. Returns a summary for the log line, or
 * null when nothing was attempted (flag off, no run id) or the write failed/timed out.
 */
export async function graphWriteAnalysisRun(clientId, {
    runId, reportId = null, report, websiteUrl = null, analysisMode = null, budgetMs = WRITE_BUDGET_MS,
} = {}) {
    if (!isGraphEnabled()) return null;
    const id = runId || reportId;
    if (!clientId || !id || !report) return null;

    const deadline = Date.now() + budgetMs;
    let timer;
    try {
        return await Promise.race([
            writeRun(clientId, { runId: id, reportId, report, websiteUrl, analysisMode }, deadline),
            new Promise((resolve) => {
                timer = setTimeout(() => {
                    console.warn(`[graph-run] run ${id} graph write exceeded ${budgetMs}ms — abandoned`);
                    resolve(null);
                }, budgetMs);
            }),
        ]);
    } catch (err) {
        console.warn(`[graph-run] run ${id} graph write failed:`, err?.message || err);
        return null;
    } finally {
        clearTimeout(timer);
    }
}
