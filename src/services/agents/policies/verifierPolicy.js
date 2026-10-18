/**
 * Verifier policy — the grounding gates a report must clear before it is persisted.
 *
 * Deterministic by design: every gate below is a rule over the signal set, never an LLM
 * judgement. A verifier that itself hallucinates is worse than no verifier, and this runs
 * on every report so it must be free and instant.
 *
 * Thresholds here are CALIBRATED against real production reports, not guessed. The most
 * important calibration: in real runs 100% of signals carry `date_confidence` of "low" or
 * undefined, so a gate that blocked on weak dates would reject every report ever produced.
 * Date confidence therefore annotates and never blocks. Re-check these numbers against
 * live data before tightening any of them.
 *
 * Modes (see resolveVerifierMode):
 *   off      — skip entirely
 *   report   — compute and record findings, change nothing (default; safe to roll out)
 *   enforce  — additionally DROP unsupported and duplicate signals before persistence
 */

// Single source of truth lives in pipelineVersions.js so the pin recorded on a job's
// checkpoint and the pin stamped on a verdict can never drift apart.
import { VERIFIER_POLICY_VERSION } from '../../pipelineVersions.js';

export { VERIFIER_POLICY_VERSION };

export const VERIFIER_THRESHOLDS = {
    /** A report standing on fewer distinct domains than this is single-sourced. */
    MIN_UNIQUE_DOMAINS: 3,
    /** Distinct domains per signal. Real reports sit near 0.77; 0.25 flags heavy reuse. */
    MIN_DOMAIN_RATIO: 0.25,
    /** Share of signals allowed to have weak/absent dates before the report is annotated. */
    MAX_WEAK_DATE_RATIO: 0.8,
    /** Share of tracked competitors allowed to have zero supporting evidence. */
    MAX_UNVALIDATED_COMPETITOR_RATIO: 0.5,
};

const STRONG_DATE_CONFIDENCE = new Set(['high', 'medium', 'med']);

/** Resolve the operating mode. Defaults to `report` — observe before enforcing. */
/**
 * Resolve the gate's mode. **Defaults to `enforce`.**
 *
 * It defaulted to `report` — record a verdict, drop nothing — while the call site's comment
 * claimed "an unsupported claim is never persisted". That was false: `persistedSignals =
 * originalSignals` in report mode, so ungrounded signals shipped to founders with a verdict
 * beside them saying they *would* have been dropped. A gate that does not gate is the same
 * defect shape as a contract nothing enforces (§0.2).
 *
 * Measured before flipping, over 49 real historical reports / 997 signals:
 *   • 38 signals dropped (3.8%) — all ungrounded, zero duplicates
 *   • 20 of 49 reports contained at least one ungrounded signal
 *   • 2 reports would empty entirely — both had exactly 2 signals, both unsupported
 *
 * Those two emptying is the correct outcome, not a regression: a report of two unsupported
 * claims was already worth nothing, and per the internal design log "fewer verified findings
 * beat more plausible ones". What makes it acceptable is that stepPersist now records a
 * degradation when the gate removes anything, so a thin report says why it is thin instead of
 * looking mysteriously empty. A gap is never closed by lowering the bar.
 *
 * `report` remains available for measuring a threshold change before adopting it, and `off`
 * for disabling the gate outright. Both are env-only, so reverting needs no deploy.
 */
export function resolveVerifierMode(env = {}) {
    const raw = String(env.VERIFIER_MODE || env.VITE_VERIFIER_MODE || 'enforce').toLowerCase().trim();
    return ['off', 'report', 'enforce'].includes(raw) ? raw : 'enforce';
}

function domainOf(url) {
    if (!url || typeof url !== 'string') return null;
    try {
        return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return null;
    }
}

/** Normalize a headline for duplicate detection: case, punctuation and spacing collapse. */
function normalizeClaim(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const isGrounded = (signal) => Boolean(domainOf(signal?.source_url));

/**
 * Run every gate over a report payload.
 *
 * Pure: takes the report data, returns a verdict plus the signal set that should actually
 * be persisted. Never mutates its input and never touches the network or database.
 *
 * A gate here may only read what the call site actually supplies at `verify` time: the
 * signal set, and the tracked entities via `context`/`contextLayer`. There is no brief yet —
 * `summary` runs later — so a gate that reads one is dead on arrival. See the G6 note.
 *
 * @param {object} reportData - `{ signals, context? , contextLayer? }`
 * @param {{ mode?: string }} [options]
 * @returns {{ report: object, signals: Array, changed: boolean }}
 */
export function verifyReport(reportData, { mode = 'report' } = {}) {
    const originalSignals = Array.isArray(reportData?.signals) ? reportData.signals : [];
    // Deliberately no read of `reportData.brief`: this runs before `summary`, so there is
    // never one. See the G6 note below for what that cost when a gate assumed otherwise.
    const trackedEntities = Array.isArray(reportData?.contextLayer?.trackedEntities)
        ? reportData.contextLayer.trackedEntities
        : (reportData?.context?._trackedEntities || []);

    const gates = [];
    const addGate = (id, status, detail, extra = {}) => gates.push({ id, status, detail, ...extra });

    // ─── G1: grounding. A claim with no resolvable source URL is unsupported. ───
    const ungrounded = originalSignals.filter(s => !isGrounded(s));
    const grounded = originalSignals.filter(isGrounded);
    addGate(
        'signal_grounding',
        ungrounded.length === 0 ? 'pass' : 'fail',
        `${ungrounded.length} of ${originalSignals.length} signal(s) have no resolvable source URL`,
        { affected: ungrounded.map(s => s.signal_headline || s.the_move || '(untitled)').slice(0, 20) }
    );

    // ─── G1b: citation precision. ───
    // `filterGroundedSignals()` marks a signal `domain_only` when the model cited a path that
    // was never in the evidence — the domain was real, the article was not. Those signals are
    // kept (their link is repointed at something real) but they are a weaker citation than an
    // exact match, and their true rate was invisible until now because the old grounding
    // check counted them as fully grounded.
    //
    // This gate exists to MEASURE that rate in production. It warns rather than fails: the
    // decision to drop domain-only citations should be made against real numbers, the way the
    // enforce-by-default flip was, not guessed at here.
    const domainOnly = grounded.filter(s => s?.source_confidence === 'domain_only');
    const domainOnlyRatio = grounded.length ? domainOnly.length / grounded.length : 0;
    addGate(
        'citation_precision',
        domainOnly.length === 0 ? 'pass' : 'warn',
        `${domainOnly.length} of ${grounded.length} grounded signal(s) cite a domain rather than a verified page`,
        {
            domain_only_ratio: Number(domainOnlyRatio.toFixed(3)),
            affected: domainOnly.map(s => s.signal_headline || s.the_move || '(untitled)').slice(0, 20),
            blocking: false,
        }
    );

    // ─── G2: duplicate / same-event findings. ───
    // Two signals describing the same event from the same URL are one finding counted twice,
    // which silently inflates apparent evidence volume.
    const seen = new Map();
    const duplicates = [];
    const deduped = [];
    for (const s of grounded) {
        const key = `${domainOf(s.source_url)}::${normalizeClaim(s.signal_headline)}`;
        const urlKey = `${s.source_url}::${normalizeClaim(s.entity_involved)}::${normalizeClaim(s.signal_headline)}`;
        if (seen.has(key) || seen.has(urlKey)) {
            duplicates.push(s);
            continue;
        }
        seen.set(key, true);
        seen.set(urlKey, true);
        deduped.push(s);
    }
    addGate(
        'duplicate_findings',
        duplicates.length === 0 ? 'pass' : 'warn',
        `${duplicates.length} duplicate finding(s) detected`,
        { affected: duplicates.map(s => s.signal_headline || '(untitled)').slice(0, 20) }
    );

    // ─── G3: source diversity. ───
    const domains = new Set(grounded.map(s => domainOf(s.source_url)).filter(Boolean));
    const domainRatio = grounded.length ? domains.size / grounded.length : 0;
    const diversityOk = domains.size >= VERIFIER_THRESHOLDS.MIN_UNIQUE_DOMAINS
        && domainRatio >= VERIFIER_THRESHOLDS.MIN_DOMAIN_RATIO;
    addGate(
        'source_diversity',
        grounded.length === 0 ? 'fail' : (diversityOk ? 'pass' : 'warn'),
        `${domains.size} unique domain(s) across ${grounded.length} grounded signal(s) (ratio ${domainRatio.toFixed(2)})`,
        { unique_domains: domains.size, domain_ratio: Number(domainRatio.toFixed(3)) }
    );

    // ─── G4: date confidence. ANNOTATE ONLY — see the calibration note at the top. ───
    const weakDated = grounded.filter(s => !STRONG_DATE_CONFIDENCE.has(String(s.date_confidence || '').toLowerCase()));
    const weakDateRatio = grounded.length ? weakDated.length / grounded.length : 0;
    addGate(
        'date_confidence',
        weakDateRatio > VERIFIER_THRESHOLDS.MAX_WEAK_DATE_RATIO ? 'warn' : 'pass',
        `${weakDated.length} of ${grounded.length} grounded signal(s) have weak or missing date confidence (${(weakDateRatio * 100).toFixed(0)}%)`,
        { weak_date_ratio: Number(weakDateRatio.toFixed(3)), blocking: false }
    );

    // ─── G5: competitor validation. A tracked competitor nobody found evidence for is a
    // claim about the market, not an observation of it. ───
    //
    // ANNOTATE ONLY, for now. Until 2026-08-16 the call site passed only `{ signals }`, so
    // `trackedEntities` was always `[]` and this gate reported `pass` on every run without
    // checking anything — the same defect that killed `insight_grounding` below. It is now
    // fed `state.context`, which makes it live for the first time.
    //
    // That means MAX_UNVALIDATED_COMPETITOR_RATIO has never been scored against a real report,
    // and the calibration note at the top of this file exists precisely because thresholds
    // guessed here have been wrong before. So it follows the `citation_precision` precedent:
    // measure the real rate first, then decide whether it should move a verdict. Flipping it
    // to blocking is a one-line change once there are numbers behind it.
    const competitors = trackedEntities.filter(e => String(e?.category || '').toLowerCase() === 'competitor');
    const evidenceBlob = normalizeClaim(
        grounded.map(s => `${s.entity_involved} ${s.signal_headline} ${s.the_move}`).join(' ')
    );
    const unvalidated = competitors.filter(c => {
        const name = normalizeClaim(c?.name);
        return name && !evidenceBlob.includes(name);
    });
    const unvalidatedRatio = competitors.length ? unvalidated.length / competitors.length : 0;
    addGate(
        'competitor_validation',
        competitors.length === 0
            ? 'pass'
            : (unvalidatedRatio > VERIFIER_THRESHOLDS.MAX_UNVALIDATED_COMPETITOR_RATIO ? 'warn' : 'pass'),
        `${unvalidated.length} of ${competitors.length} tracked competitor(s) have no supporting evidence in this run`,
        {
            unvalidated_ratio: Number(unvalidatedRatio.toFixed(3)),
            affected: unvalidated.map(c => c.name).slice(0, 20),
            blocking: false,
        }
    );

    // ─── G6 (removed): insight grounding. ───
    //
    // Gone as of 2026-08-16. It read `reportData.brief.insights` and failed when insights
    // existed on fewer than 3 grounded signals. It never once did that, for two independent
    // reasons — and it reported `pass` on every run regardless, which is the same defect
    // shape as a contract nothing enforces (§0.2): a check that announces a result it did
    // not compute.
    //
    // 1. UNREACHABLE. `verify` runs before `summary` in PIPELINE_STEPS, deliberately, so the
    //    brief is written from gated signals (see stepVerify's comment and the ordering
    //    assertion in scripts/verifier-gate.test.mjs). The call site therefore has no brief
    //    to hand over — `insights` was always `[]`, so `insights.length === 0` short-circuited
    //    the check to `pass` on every report ever produced.
    //
    // 2. REDUNDANT even if it were reachable. Its fail condition is a strict subset of
    //    `source_diversity`'s: duplicates only ever collapse onto a signal from the same
    //    domain, so distinct domains <= deduped.length, and `deduped.length < 3` therefore
    //    forces `domains.size < MIN_UNIQUE_DOMAINS` — G3 already warns or fails, and the
    //    verdict is already `downgraded`. Measured across grounded counts 0–4 at maximum
    //    diversity before removing it: G6 failed on 0/1/2 and G3 was non-pass on exactly the
    //    same three.
    //
    // So re-checking insights after `summary` (the other option considered) would have added
    // a second pass reporting nothing the verdict does not already carry. To raise the
    // evidence floor a report must clear, raise MIN_UNIQUE_DOMAINS or MIN_DOMAIN_RATIO —
    // one gate, live inputs, no new pass.
    //
    // The general rule this leaves behind, pinned executably by the "every gate must be able
    // to fail" test: a gate here may only read what the call site actually supplies, which is
    // the signal set and the tracked entities. Anything needing the brief needs a step that
    // runs after `summary`, not a gate in this function.

    // ─── verdict ───
    const enforcing = mode === 'enforce';
    const dropped = enforcing ? [...ungrounded, ...duplicates] : [];
    const persistedSignals = enforcing ? deduped : originalSignals;

    // Only BLOCKING gates move the verdict. Gates marked `blocking: false` annotate the
    // report — date confidence and citation precision are both deliberately advisory — and
    // must not drag the verdict down on an otherwise clean run.
    //
    // Without this, `pass` was unreachable on every report ever produced: the date-confidence
    // gate warns on essentially all real signals (see the calibration note at the top of this
    // file), so every verdict was at best `downgraded`. A verdict value that never occurs
    // carries no information, and "downgraded" stops meaning anything if it is the floor.
    // Found by the golden-case harness (§9.5) the first time it ran.
    const blocking = gates.filter(g => g.blocking !== false);
    const hasFail = blocking.some(g => g.status === 'fail');
    const hasWarn = blocking.some(g => g.status === 'warn');
    const verdict = dropped.length > 0 ? 'blocked' : hasFail || hasWarn ? 'downgraded' : 'pass';

    const actions = [];
    if (enforcing && ungrounded.length) actions.push(`dropped ${ungrounded.length} ungrounded signal(s)`);
    if (enforcing && duplicates.length) actions.push(`dropped ${duplicates.length} duplicate signal(s)`);
    if (!enforcing && (ungrounded.length || duplicates.length)) {
        actions.push(`report-only mode: ${ungrounded.length + duplicates.length} signal(s) would be dropped under enforce`);
    }

    return {
        report: {
            policy_version: VERIFIER_POLICY_VERSION,
            mode,
            verdict,
            checked_at: new Date().toISOString(),
            gates,
            counts: {
                signals_in: originalSignals.length,
                signals_out: persistedSignals.length,
                grounded: grounded.length,
                ungrounded: ungrounded.length,
                duplicates: duplicates.length,
                dropped: dropped.length,
            },
            actions,
        },
        signals: persistedSignals,
        changed: dropped.length > 0,
    };
}
