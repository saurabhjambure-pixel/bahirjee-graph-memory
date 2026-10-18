/**
 * Artifact builders — turn pipeline state into the artifacts an agent promised to emit.
 *
 * Each agent spec declares `artifact_types_emitted`. Until this module existed those
 * declarations were aspirational: `recordArtifact()` was written but never called, so every
 * agent claimed outputs it never produced. A contract nothing checks is decoration, and a
 * declared-but-absent artifact is worse than an undeclared one because it makes the graph
 * look observable when it is not.
 *
 * ── The hard rule ────────────────────────────────────────────────────────────
 * Payloads are SUMMARIES AND REFERENCES ONLY. Never bulk evidence.
 *
 * `agent_artifacts` rows persist for the life of the job and are read back whole by replay
 * and evaluation tooling. Raw scrape text belongs in `observations`; copying it here would
 * recreate exactly the bloat that keeping the checkpoint small exists to prevent. Every
 * builder below therefore emits counts, identifiers and short strings — if you find yourself
 * adding a field that can hold a paragraph, put a reference here and leave the text where it
 * already lives.
 *
 * Builders must be pure and total: they run at an agent boundary, on whatever state exists,
 * and a missing or half-built section is normal (a step can be skipped, deferred, or
 * degraded). Return `[]` rather than throwing — a bookkeeping failure must never be what
 * breaks a run.
 */

import { ARTIFACT_TYPES } from '../schemas.js';

/** Trim a string field to something a summary can hold without becoming the evidence. */
const short = (v, n = 200) => (v == null ? null : String(v).slice(0, n));
const count = (v) => (Array.isArray(v) ? v.length : 0);

/** Distinct hostnames across a set of records carrying a url-ish field. */
function distinctHosts(records, key = 'url') {
    const hosts = new Set();
    for (const r of records || []) {
        const raw = r?.[key];
        if (!raw) continue;
        try { hosts.add(new URL(String(raw)).hostname.replace(/^www\./, '')); } catch { /* unparseable */ }
    }
    return hosts.size;
}

const BUILDERS = {
    // Summaries and counts only — never the signals themselves. Express is optional by
    // contract, so this must be total: a run where it never executed, deferred out, or
    // failed still has to produce a valid artifact.
    express_agent(state) {
        const e = state?.express || {};
        const signals = Array.isArray(e.signals) ? e.signals : [];
        const hosts = new Set();
        for (const sig of signals) {
            try { hosts.add(new URL(String(sig?.source_url)).hostname.replace(/^www\./, '')); } catch { /* skip */ }
        }
        return [
            {
                artifactType: ARTIFACT_TYPES.EXPRESS_QUERY_PLAN,
                payload: {
                    query_count: count(e.queries),
                    // The queries are deterministic and short; keeping a few makes a run
                    // reproducible without carrying evidence into the artifact store.
                    queries: (Array.isArray(e.queries) ? e.queries : []).slice(0, 6).map(q => short(q, 160)),
                    phase: short(e.phase, 20),
                    defer_count: Number(e.deferCount) || 0,
                },
            },
            {
                artifactType: ARTIFACT_TYPES.EXPRESS_SIGNAL_SET,
                payload: {
                    count: signals.length,
                    observations_analyzed: Number(e.analyzedCount) || 0,
                    distinct_source_hosts: hosts.size,
                    headlines: signals.slice(0, 10).map(sig => short(sig?.signal_headline, 160)),
                },
            },
        ];
    },

    context_agent(state) {
        const ctx = state?.context || {};
        const competitors = Array.isArray(ctx.key_competitors) ? ctx.key_competitors : [];
        // A gap is an absence, so it is recorded as a list of field names — never as the
        // (missing) values themselves.
        const gaps = ['company_name', 'industry', 'operating_geography', 'customer_segments', 'strategic_anchors']
            .filter(f => {
                const v = ctx[f];
                return v == null || (typeof v === 'string' && !v.trim())
                    || (Array.isArray(v) && v.length === 0)
                    || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
            });

        return [
            {
                artifactType: ARTIFACT_TYPES.CONTEXT_SNAPSHOT,
                payload: {
                    company_name: short(ctx.company_name, 120),
                    industry: short(ctx.industry, 120),
                    operating_geography: short(ctx.operating_geography, 120),
                    competitor_count: competitors.length,
                    customer_segment_count: count(ctx.customer_segments),
                    has_strategic_anchors: Boolean(ctx.strategic_anchors && Object.keys(ctx.strategic_anchors).length),
                    memory_cards: count(state?.memory?.currentCards ?? state?.memory?.current_cards),
                    lookback_months: state?.memory?.lookbackMonths ?? null,
                },
            },
            {
                artifactType: ARTIFACT_TYPES.CONTEXT_CONFIDENCE_REPORT,
                payload: {
                    overall_confidence: short(ctx.overall_confidence, 40),
                    anchors_confidence: short(ctx.strategic_anchors?.confidence, 40),
                    // Present-or-explicitly-unknown is this agent's success criterion.
                    resolved_fields: 5 - gaps.length,
                    total_fields: 5,
                },
            },
            { artifactType: ARTIFACT_TYPES.CONTEXT_GAPS, payload: { missing_fields: gaps, gap_count: gaps.length } },
        ];
    },

    competitor_scout_agent(state) {
        const competitors = (state?.context?.key_competitors || []).map(c => (typeof c === 'object' ? c : { name: c }));
        return [
            {
                artifactType: ARTIFACT_TYPES.COMPETITOR_CANDIDATES,
                sourceCount: competitors.length,
                payload: {
                    count: competitors.length,
                    // Names and domains only — the evidence that justified each one is in
                    // observations, keyed by the same run.
                    candidates: competitors.slice(0, 25).map(c => ({
                        name: short(c.name, 80),
                        domain: short(c.domain || c.website || null, 120),
                    })),
                },
            },
            {
                artifactType: ARTIFACT_TYPES.COMPETITOR_VALIDATION_REPORT,
                payload: {
                    total: competitors.length,
                    with_domain: competitors.filter(c => c.domain || c.website).length,
                    validated: competitors.filter(c => c.validated || c.confidence).length,
                },
            },
        ];
    },

    research_planner_agent(state) {
        const buckets = state?.queries?.buckets || {};
        const selected = state?.queries?.selected || [];
        const perTheme = Object.fromEntries(
            Object.entries(buckets).map(([theme, qs]) => [theme, count(qs)])
        );
        return [
            {
                artifactType: ARTIFACT_TYPES.RETRIEVAL_PLAN,
                payload: { themes: Object.keys(buckets), queries_per_theme: perTheme, total_planned: count(selected) },
            },
            {
                artifactType: ARTIFACT_TYPES.QUERY_WAVE_PLAN,
                payload: {
                    selected_count: count(selected),
                    // The queries themselves are short and are the plan, so they are the one
                    // case where the text IS the summary. Still bounded.
                    queries: selected.slice(0, 30).map(q => short(typeof q === 'object' ? q.query : q, 160)),
                },
            },
            {
                artifactType: ARTIFACT_TYPES.BUDGET_PLAN,
                payload: { planned_queries: count(selected), theme_count: Object.keys(buckets).length },
            },
        ];
    },

    evidence_retrieval_agent(state) {
        const search = state?.search || {};
        const candidates = search.candidates || [];
        return [
            {
                artifactType: ARTIFACT_TYPES.EVIDENCE_LEDGER,
                sourceCount: search.total || 0,
                payload: {
                    queries_run: search.cursor ?? 0,
                    queries_total: search.total ?? 0,
                    phase: short(search.phase, 40),
                    deep_read_candidates: candidates.length,
                    distinct_candidate_hosts: distinctHosts(candidates),
                },
            },
            {
                artifactType: ARTIFACT_TYPES.RETRIEVAL_METRICS,
                payload: {
                    completed: (search.cursor ?? 0) >= (search.total ?? 0),
                    deep_read_candidates: candidates.length,
                },
            },
            {
                // Observations live in their own table; this records HOW to find them
                // rather than copying any of them.
                artifactType: ARTIFACT_TYPES.OBSERVATION_REFS,
                payload: { run_id: state?.runId || null, lookup: 'public.observations WHERE run_id = payload.run_id' },
            },
        ];
    },

    signal_analyst_agent(state) {
        const signals = state?.analyze?.signals || [];
        const v6 = state?.v6 || {};
        const withSource = signals.filter(s => s?.source_url).length;
        return [
            {
                artifactType: ARTIFACT_TYPES.SIGNAL_SET,
                sourceCount: signals.length,
                evidenceRefs: [...new Set(signals.map(s => s?.source_url).filter(Boolean))].slice(0, 50),
                payload: {
                    count: signals.length,
                    with_source_url: withSource,
                    distinct_source_hosts: distinctHosts(signals, 'source_url'),
                    batches_planned: count(state?.analyze?.batches),
                    // Headlines are the index into the signals, not the signals themselves.
                    headlines: signals.slice(0, 20).map(s => short(s?.signal_headline, 140)),
                },
            },
            { artifactType: ARTIFACT_TYPES.PATTERN_SET, payload: { count: count(v6.patterns) } },
            { artifactType: ARTIFACT_TYPES.SHIFT_SET, payload: { count: count(v6.shifts) } },
            { artifactType: ARTIFACT_TYPES.BLIND_SPOT_SET, payload: { count: count(v6.blindSpots) } },
            { artifactType: ARTIFACT_TYPES.OPPORTUNITY_SET, payload: { count: count(v6.opportunities) } },
        ];
    },

    // The verifier emits its verdict and nothing else — it writes no report (§5.6).
    verifier_agent(state) {
        const verdict = state?.verify?.verdict || null;
        const signals = state?.analyze?.signals || [];
        const degradations = state?.degradations || [];
        const counts = verdict?.counts || {};

        return [
            {
                artifactType: ARTIFACT_TYPES.VERIFICATION_REPORT,
                sourceCount: signals.length,
                payload: {
                    verdict: short(verdict?.verdict, 40),
                    mode: short(verdict?.mode, 20),
                    policy_version: short(verdict?.policy_version, 40),
                    skipped: Boolean(verdict?.skipped),
                    signals_in: counts.signals_in ?? null,
                    signals_out: counts.signals_out ?? null,
                    dropped: counts.dropped ?? null,
                    ungrounded: counts.ungrounded ?? null,
                    duplicates: counts.duplicates ?? null,
                    // Which gates were not clean, and why — the audit trail for every drop.
                    failed_gates: (verdict?.gates || [])
                        .filter(g => g?.status && g.status !== 'pass')
                        .map(g => `${g.id}:${g.status}`)
                        .slice(0, 20),
                    // Coverage gaps disclosed to the founder by this same step.
                    disclosed_gaps: degradations
                        .filter(d => String(d?.step || '').startsWith('Coverage'))
                        .map(d => short(d?.step, 60))
                        .slice(0, 10),
                    gap_fill_attempted: Boolean(state?.verify?.retried),
                },
            },
        ];
    },

    synthesis_agent(state) {
        const report = state?.report || null;
        const signals = state?.analyze?.signals || [];

        return [
            {
                artifactType: ARTIFACT_TYPES.REPORT_PAYLOAD,
                sourceCount: signals.length,
                payload: {
                    report_id: report?.id || null,
                    run_id: state?.runId || null,
                    signal_count: count(report?.signals),
                    has_brief: Boolean(report?.brief),
                    insight_count: count(report?.brief?.insights),
                    news_count: count(state?.news?.items ?? report?.news),
                    // Publication is only legitimate against a verdict; record which one.
                    verified_under: short(state?.verify?.verdict?.verdict, 40),
                },
            },
            {
                artifactType: ARTIFACT_TYPES.MEMORY_UPDATE,
                payload: {
                    based_on_report_id: report?.based_on_report_id || null,
                    card_count: count(report?.card_summary ?? report?.memory?.current_cards),
                },
            },
        ];
    },
};

/**
 * Artifacts for `agentId` given the run's state. Never throws.
 *
 * @returns {Array<{artifactType: string, payload: object, sourceCount?: number, evidenceRefs?: string[]}>}
 */
export function buildArtifactsFor(agentId, state) {
    const builder = BUILDERS[agentId];
    if (!builder) return [];
    try {
        return (builder(state) || []).filter(a => a && a.artifactType);
    } catch (e) {
        console.warn(`[agents] artifact builder for "${agentId}" failed (non-blocking): ${e.message}`);
        return [];
    }
}

/** Agent ids this module can build artifacts for — used by the registry conformance test. */
export const agentIdsWithBuilders = () => Object.keys(BUILDERS);
