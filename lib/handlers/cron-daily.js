import { applyApiSecurity } from '../_security.js';
import { getSupabaseAdmin } from '../_auth.js';
import { isPendingJobStale, isProcessingJobStale } from '../_intelligenceJobs.js';
import { extractTargetDomain } from '../../src/services/reportService.js';
import { getEntitySources } from '../../src/services/primarySourceMapper.js';
import { watchSources, rotateSources, DAILY_WATCH_FETCHES, isSubstitutedPage } from '../../src/services/sourceWatch.js';

import { listAgenda, markChecked, markMoved, answerQuestion } from '../../src/services/agendaService.js';
import { planDailyWork, planPursuit } from '../../src/services/dailyPlan.js';
import { pursue } from '../../src/services/dailyRun.js';
import { createRead, recordDailyCheck, todaysCheck, checkDateKey } from '../../src/services/readsService.js';
import { callLLMAction, fetchPageExtract, configureIntelligenceRuntime } from '../../src/services/intelligenceService.js';
import { internalPostJson } from '../_internalRouteClient.js';
// Track 2: the ladder's rungs double as the watcher/triage/pursuer agents.
// Every write is fail-open — a graph outage can never stall the morning loop.
import { graphWriteSession, graphWriteFinding, graphWriteHandoff, graphWriteRead, graphCompleteHandoff } from '../_graphWriter.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// THE DAILY LADDER
//
// Every morning, for every client on a cadence: check a rotating slice of the pages
// Bahirjee watches, and decide whether any of it is worth spending on. Four rungs,
// cheapest first, and MOST DAYS IT STOPS AT THE FIRST:
//
//   Sense      hash-diff ~4 tracked pages           no LLM, ~free
//   Triage     one Flash call: is this material?    ~$0.002, only if something moved
//   Pursue     ≤4 queries → one analyze batch       ~$0.04, ~2x/week
//   Synthesize the weekly full run                  unchanged — /api/cron-runs owns it
//
// This handler deliberately does NOT touch cron-runs. Vercel Hobby allows two cron
// entries, so the Monday synthesis keeps its own firing and its own tested code path, and
// this one is purely additive. On Mondays both fire; the active-job guard below keeps them
// from colliding, and the hour offset in vercel.json lets the synthesis start first.
//
// WHY THE WHOLE THING EXISTS. Today a run rebuilds everything from scratch and a quiet
// week costs exactly as much as a loud one, because nothing is carried between runs —
// every falsifier the brief generates is discarded at the end of the run. With an Agenda
// that persists, a morning becomes a PURSUIT of what is still open rather than a
// regeneration of everything, and silence becomes a valid, cheap, honest outcome.
//
// ⚠️ NOTHING RUNS UNTIL A CLIENT HAS A CADENCE. The sweep below selects only clients whose
// `auto_run_cadence` is set and not 'off' — the same filter cron-runs uses. Verified against
// production on 2026-09-15: all five clients have it NULL, none has ever been queued, and no
// job with job_origin='scheduled' has ever existed. So the weekly cron has been firing every
// Monday since v18 and queueing nothing, and this one would do the same. That is not a bug in
// either handler; it is a precondition nobody has set. Its failure mode is total silence,
// which is indistinguishable from a quiet morning, so it is written down here.
//
// This spends real money on a timer. Every guard below is load-bearing.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Ceiling per firing. A pursuit is ~20-30s inside a 60s function, so this is bounded by
// wall clock, not just cost. Clients are ordered least-recently-checked, so nobody starves.
const MAX_CLIENTS_PER_FIRING = Number(process.env.CRON_MAX_DAILY_CLIENTS || 8);

// Hard stop before Vercel's 60s ceiling, leaving room to record the ledger.
const FIRING_MAX_MS = 50000;

// At most one pursuit per FIRING, on top of the one-per-company-per-day rule. A morning
// that pursued for one client still senses for the rest and pursues for them tomorrow —
// which is fair, because clients are ordered least-recently-checked.
const MAX_PURSUITS_PER_FIRING = 1;

// The auth precedence chain is imported, never re-derived. the engineering notes records what a
// mismatched copy of it cost: every self-trigger 401'd and jobs stalled in `pending`.
// A third copy is a third place for that to drift.
import { isAuthorizedScheduler } from './cron-runs.js';

export async function handler(req, res) {
    // Vercel Cron issues a GET; internal/manual invocation uses POST.
    if (await applyApiSecurity(req, res, {
        routeKey: 'cron-daily',
        allowedMethods: ['GET', 'POST'],
        allowHeaders: ['Content-Type', 'Authorization', 'x-bahirjee-internal-key'],
        maxRequests: 20
    })) return;

    if (!isAuthorizedScheduler(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    let supabaseAdmin;
    try {
        supabaseAdmin = getSupabaseAdmin();
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }

    // ⚠️ EVERY network call the pipeline makes goes through `intelligenceRuntime.postJson`,
    // which DEFAULTS to the browser client and its authenticated user session. A cron has
    // no session, so without this line every scrape and every search returns "No active
    // session", the ladder finds nothing every morning, and the loop is completely inert —
    // while still writing a tidy "nothing moved" to the ledger. Silent, total, permanent.
    // Observed in a live dry-run; no unit test can catch it, because the default is a
    // working function. The stepped worker sets the same thing at its own entry point.
    configureIntelligenceRuntime({ postJson: internalPostJson });

    const startedAt = Date.now();
    const today = checkDateKey();
    const summary = { considered: 0, sensed: 0, triaged: 0, pursued: 0, quiet: 0, skipped: [], errors: [] };

    try {
        const { data: clients, error } = await supabaseAdmin
            .from('clients')
            .select('id, name, auto_run_cadence')
            .eq('status', 'active')
            .not('auto_run_cadence', 'is', null)
            .neq('auto_run_cadence', 'off')
            .limit(MAX_CLIENTS_PER_FIRING * 3);
        if (error) throw error;

        summary.considered = (clients || []).length;

        for (const client of clients || []) {
            if (summary.sensed >= MAX_CLIENTS_PER_FIRING) break;
            if (Date.now() - startedAt > FIRING_MAX_MS) {
                summary.skipped.push({ clientId: client.id, reason: 'firing_time_budget' });
                break;
            }

            try {
                const outcome = await runDailyForClient(supabaseAdmin, client, {
                    today,
                    mayPursue: summary.pursued < MAX_PURSUITS_PER_FIRING,
                });
                if (outcome.skipped) {
                    summary.skipped.push({ clientId: client.id, reason: outcome.skipped });
                    continue;
                }
                summary.sensed += 1;
                if (outcome.triaged) summary.triaged += 1;
                if (outcome.pursued) summary.pursued += 1;
                else summary.quiet += 1;
            } catch (clientErr) {
                // One bad client must not abort the sweep.
                console.error(`[cron-daily] client ${client.id} failed:`, clientErr.message);
                summary.errors.push({ clientId: client.id, error: clientErr.message });
            }
        }

        console.log('[cron-daily]', JSON.stringify(summary));
        return res.status(200).json(summary);
    } catch (err) {
        console.error('[cron-daily] sweep failed:', err.message);
        return res.status(500).json({ error: err.message, summary });
    }
}

/**
 * One company's morning.
 *
 * Returns `{ skipped }` when nothing was spent, or `{ triaged, pursued }` describing how
 * far up the ladder it went.
 */
async function runDailyForClient(supabaseAdmin, client, { today, mayPursue }) {
    // ── Never collide with a LIVE full run ───────────────────────────────────
    // On Mondays the synthesis is queued an hour earlier. A daily pursuit racing it would
    // bill twice and both would write memory for the same company.
    //
    // But the guard must age out, and this is not hypothetical: there is a job in this
    // database that has sat in `processing` since 2026-09-13. A naive "any pending or
    // processing job" check would make that client's daily loop skip EVERY morning,
    // forever, reporting a tidy `full_run_in_progress` each time — nothing throws, the
    // founder simply never hears from Bahirjee again. Reuse the same thresholds the worker
    // already uses to decide a job is abandoned, rather than inventing a second answer to
    // "is this run still alive?".
    const { data: activeJobs } = await supabaseAdmin
        .from('intelligence_jobs')
        .select('id, status, created_at, updated_at, last_heartbeat_at')
        .eq('client_id', client.id)
        .in('status', ['pending', 'processing'])
        .order('created_at', { ascending: false })
        .limit(5);
    const live = (activeJobs || []).filter(j => !isPendingJobStale(j) && !isProcessingJobStale(j));
    if (live.length) return { skipped: 'full_run_in_progress' };

    // ── What company is this, and what do we know about it? ──────────────────
    const { data: lastReport } = await supabaseAdmin
        .from('reports')
        .select('website_url, context, created_by')
        .eq('client_id', client.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (!lastReport?.website_url) return { skipped: 'no_prior_report' };
    const targetDomain = extractTargetDomain(lastReport.website_url);
    if (!targetDomain) return { skipped: 'no_target_domain' };

    // ── Idempotency, before any spend ────────────────────────────────────────
    // A cron that fires twice — a retry, a manual trigger, a platform hiccup — must cost
    // nothing the second time. The ledger is keyed on the domain, so this is the earliest
    // point the claim can be checked. Same discipline as completeIntelligenceJob's
    // compare-and-set: read the claim first, then do the work.
    if (await todaysCheck(client.id, targetDomain, today)) return { skipped: 'already_read_today' };

    // Prefer the context the founder actually approved. lastReport.context is a run
    // OUTPUT — mutated by discover/validate/memory — and replaying it compounds those
    // mutations. Queried with supabaseAdmin rather than through companyContextService,
    // which imports the anon-key browser client.
    let context = lastReport.context || {};
    const { data: current, error: currentErr } = await supabaseAdmin
        .from('company_contexts')
        .select('context')
        .eq('client_id', client.id)
        .eq('target_domain', targetDomain)
        .eq('is_current', true)
        .maybeSingle();
    // 42P01 = table missing (v26 not applied): fall through to the report silently.
    if (currentErr && currentErr.code !== '42P01') {
        console.warn(`[cron-daily] company_contexts lookup failed for ${client.id}:`, currentErr.message);
    } else if (current?.context && Object.keys(current.context).length > 0) {
        context = current.context;
    }
    // A daily read is never a decision run. Inheriting a stored decision frame would make
    // the pipeline emit a decision brief nobody asked for.
    if (context?._decision) { context = { ...context }; delete context._decision; }

    // ── RUNG 1: SENSE ────────────────────────────────────────────────────────
    // Hash-diff a rotating slice. No LLM. An unchanged page contributes literally nothing
    // and costs one fetch. This is the rung almost every morning stops at.
    const allSources = await getEntitySources(client.id);
    const slice = rotateSources(allSources, DAILY_WATCH_FETCHES);
    const watch = await watchSources(slice, {
        // watchSource wants `(url) => Promise<string|null>`; fetchPageExtract returns the
        // richer `{ text, source, title, publishDate, resolvedUrl }`. Adapt here rather than
        // widen watchSource's contract — exactly as stepWatch does.
        //
        // The extra step over stepWatch: DROP a page the scraper substituted. Returning null
        // routes it through markFailure, so a URL that can never be fetched for real retires
        // itself after three tries instead of seeding a baseline of somebody else's page and
        // then reporting phantom changes against it forever.
        scrape: async (url) => {
            const page = await fetchPageExtract(url);
            if (!page?.text) return null;
            if (isSubstitutedPage(url, page.resolvedUrl)) {
                console.warn(`[cron-daily] ${url} resolved to ${page.resolvedUrl} — refusing a substituted page`);
                return null;
            }
            return page.text;
        },
        // A daily sense is not a pipeline run and mints no run_id. The snapshot column is
        // nullable for precisely this case.
        runId: null,
        limit: DAILY_WATCH_FETCHES,
    });

    // watchSource emits a pipeline observation: { job, theme, source_class, data, url,
    // title, published_date }. `title` is already "Entity — page changed" and `data` is
    // the framed diff, so the triage prompt reads them directly rather than re-deriving
    // fields that do not exist on the row.
    const changes = watch.observations.map(o => ({
        url: o.url,
        entityName: o.title,
        sourceType: o.theme,
        summary: String(o.data || '').slice(0, 500),
    }));

    const agenda = await listAgenda(client.id, targetDomain);
    const plan = planDailyWork({ agenda, changes });

    // ── Track 2 graph writes — the ladder rungs ARE the agents ─────────────
    // Fail-open throughout (returns null on failure; no-ops when
    // MEMORY_GRAPH_ENABLED=0 — that flag is the removal-test path).
    await graphWriteSession(client.id, {
        sessionId: `daily:${client.id}:${today}`,
        kind: 'daily_ladder',
        agent: 'watcher',
    });
    const findingIds = [];
    for (const o of watch.observations) {
        const src = slice.find(s => s.url === o.url);
        const fid = await graphWriteFinding(client.id, {
            seed: `${src?.id || o.url}:${today}`,
            headline: o.title,
            entityId: src?.entity?.id || src?.entity_id || null,
            entityName: src?.entity?.name || src?.entity_name || null,
            url: o.url,
            sourceType: 'source_watch',
        });
        if (fid) findingIds.push(fid);
    }

    // `watch.read` — successful fetches — NOT `watch.checked`, which counts attempts.
    // The Desk turns this number into "Bahirjee read N pages", so claiming an attempt as a
    // read means a scraper outage reads as a quiet morning forever.
    const ledger = {
        clientId: client.id,
        targetDomain,
        checkedOn: today,
        pagesChecked: watch.read,
        pagesChanged: watch.changed,
    };

    // Nothing could be fetched at all. That is an outage, not a quiet morning, and it must
    // not be dressed as one — a gap beats a guess, and a wrong reassurance is worse than
    // either. The note is what the Desk renders when pagesChecked is 0.
    if (watch.read === 0 && watch.failed > 0) {
        await recordDailyCheck({
            ...ledger,
            note: `Could not reach any of the ${watch.failed} page(s) I watch this morning. That is a problem at my end, not quiet news.`,
        });
        return { triaged: false, pursued: false };
    }

    // Everything the loop looked at is stamped, whatever it concluded — that is what makes
    // the rotation walk the whole Agenda instead of re-checking its favourite.
    await markChecked(plan.candidates.map(c => c.questionId));

    if (plan.action === 'quiet') {
        await recordDailyCheck({ ...ledger, note: plan.reason });
        return { triaged: false, pursued: false };
    }

    // ── RUNG 2: TRIAGE ───────────────────────────────────────────────────────
    // One small Flash call. Its most common correct answer is "nothing here is material",
    // and the prompt is written to make that the expected outcome rather than a failure.

    // Track 2: watcher hands its findings to triage — visible shared state.
    await graphWriteHandoff(client.id, {
        seed: `w2t:${client.id}:${today}`,
        fromAgent: 'watcher',
        toAgent: 'triage',
        findingId: findingIds[0] || null,
        reason: `${changes.length} watched page(s) changed`,
    });

    let verdict = null;
    try {
        verdict = await callLLMAction('triageDaily', {
            context,
            candidates: plan.candidates,
            unmatchedChanges: plan.unmatchedChanges,
        });
    } catch (err) {
        // A failed triage is a quiet morning, not a broken one — and it says so, because
        // "nothing moved" and "I could not tell" are different facts.
        console.warn(`[cron-daily] triage failed for ${client.id}:`, err.message);
        await recordDailyCheck({ ...ledger, triaged: true, note: 'Checked the watched pages, but could not finish reading them this morning.' });
        return { triaged: true, pursued: false };
    }

    const pursuit = planPursuit(verdict, plan.candidates);

    if (!pursuit.pursue) {
        await recordDailyCheck({ ...ledger, triaged: true, note: pursuit.reason });
        return { triaged: true, pursued: false };
    }
    if (!mayPursue) {
        // Worth pursuing, but this firing has already spent its pursuit. The question stays
        // open and rises in tomorrow's ranking, so nothing is lost.
        await recordDailyCheck({ ...ledger, triaged: true, note: 'Something worth following up. Picking it up on the next read.' });
        return { triaged: true, pursued: false };
    }

    // ── RUNG 3: PURSUE ───────────────────────────────────────────────────────
    // Track 2: triage hands the chosen question to the pursuer.
    await graphWriteHandoff(client.id, {
        seed: `t2p:${client.id}:${today}`,
        fromAgent: 'triage',
        toAgent: 'pursuer',
        findingId: findingIds[0] || null,
        reason: pursuit.reason,
    });

    const result = await pursue(pursuit, context, {
        clientId: client.id,
        userId: lastReport.created_by,
        websiteUrl: lastReport.website_url,
    });

    if (!result.read) {
        // The question was still moved — evidence was gathered even if none of it cleared
        // the bar — so it does not immediately come up again tomorrow.
        await markMoved(pursuit.questionId);
        await recordDailyCheck({ ...ledger, triaged: true, note: result.reason });
        return { triaged: true, pursued: false };
    }

    const read = await createRead({
        clientId: client.id,
        targetDomain,
        ...result.read,
    });

    // Track 2: the Read answers its Question; the pursuer's handoff is consumed.
    await graphWriteRead(client.id, {
        readId: read?.id || `unpersisted:${client.id}:${today}`,
        questionId: pursuit.questionId,
        headline: result.read.headline,
        evidence: result.read.evidence,
        confidence: result.read.confidence,
    });
    await graphCompleteHandoff(client.id, `t2p:${client.id}:${today}`);

    await markMoved(pursuit.questionId);
    // A Read that answers its question closes it. Anything less leaves it open — the
    // Agenda must be able to shrink, but only on evidence.
    if (read && result.read.confidence === 'High') {
        await answerQuestion(pursuit.questionId, { summary: read.headline, readId: read.id });
    }

    await recordDailyCheck({
        ...ledger,
        triaged: true,
        pursued: true,
        readId: read?.id || null,
        note: pursuit.reason,
    });

    console.log(`[cron-daily] Read for client ${client.id}: ${read?.headline || '(not persisted)'}`);
    return { triaged: true, pursued: true };
}
