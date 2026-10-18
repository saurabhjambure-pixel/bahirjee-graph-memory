/**
 * Brief attestation — deterministic checks over the finished brief.
 *
 * WHY THIS IS A SEPARATE POLICY FROM verifierPolicy.js
 *
 * The signal verifier runs at `verify`, before `summary`, so there is no brief for it to
 * read. A gate that assumed otherwise already cost us once: G6 (`insight_grounding`) read
 * `reportData.brief.insights` at a point where no brief existed, so it reported `pass` on
 * every report ever produced without checking anything. It was deleted, and the note in
 * verifierPolicy.js says plainly that anything needing the brief needs a step that runs
 * after `summary`. This is that step's policy.
 *
 * Deterministic only — no LLM, no network, no database. A verifier that can itself
 * hallucinate is worse than no verifier, because it launders a bad brief into a checked one.
 *
 * Pure: takes a brief, returns a verdict plus the brief that should actually be persisted.
 * B2 is the one gate that rewrites, and it rewrites arithmetic (a confidence level), never
 * prose.
 */

import { calibrateConfidence, auditBriefVoice } from '../../briefSchema.js';
import { BRIEF_POLICY_VERSION } from '../../pipelineVersions.js';

/**
 * `report` measures, `enforce` acts, `off` skips.
 *
 * Default is `report`, unlike the signal verifier's `enforce`. Two reasons: the gates are
 * new and unmeasured against real briefs, and — more importantly — the only enforcing
 * action available here would be refusing to publish a brief the founder already paid a
 * full run for. Measure first, then decide. Flipping to `enforce` needs no deploy.
 */
export function resolveBriefPolicyMode(env = {}) {
    const raw = String(env.BRIEF_POLICY_MODE || env.VITE_BRIEF_POLICY_MODE || 'report').toLowerCase().trim();
    return ['off', 'report', 'enforce'].includes(raw) ? raw : 'report';
}

function domainOf(url) {
    if (!url || typeof url !== 'string') return null;
    try {
        return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return null;
    }
}

const RANK = { Low: 0, Medium: 1, High: 2 };

/**
 * Attest a brief against the evidence it was built from.
 *
 * @param {object} input - `{ brief, signals, tier }`
 * @param {{ mode?: string }} [options]
 * @returns {{ report: object, brief: object, changed: boolean }}
 */
// `verifierGates` are the SIGNAL-level gates the verifier already produced for this run.
// Distinct from the local `gates` below, which are the BRIEF-level gates this function
// produces — the two never mix.
export function attestBrief({ brief, signals = [], tier = 'full', verifierGates = [] } = {}, { mode = 'report' } = {}) {
    const gates = [];
    const addGate = (id, status, detail, extra = {}) => gates.push({ id, status, detail, ...extra });
    const enforcing = mode === 'enforce';

    // A brief that is not an object cannot be attested. Say so rather than reporting a
    // pass over nothing — that is precisely the G6 failure.
    if (!brief || typeof brief !== 'object') {
        return {
            report: {
                policy_version: BRIEF_POLICY_VERSION,
                mode,
                verdict: 'blocked',
                checked_at: new Date().toISOString(),
                gates: [{ id: 'brief_present', status: 'fail', detail: 'No brief object to attest.', blocking: true }],
                actions: [],
            },
            brief,
            changed: false,
        };
    }

    const out = { ...brief };
    let changed = false;

    const groundedDomains = new Set(
        (Array.isArray(signals) ? signals : []).map(s => domainOf(s?.source_url)).filter(Boolean)
    );

    // ─── B1: claim grounding ────────────────────────────────────────────────
    // Every "what changed" item must trace to a domain that is actually in this run's
    // signal set. `what_changed` is built deterministically from those signals, so a
    // failure here means the brief and its evidence have come apart — a real defect, not
    // a model quirk.
    const whatChanged = Array.isArray(out.what_changed) ? out.what_changed : [];
    const orphans = whatChanged.filter(item => {
        const refs = Array.isArray(item?.evidence_refs) ? item.evidence_refs : [];
        return !refs.some(ref => groundedDomains.has(domainOf(ref)));
    });
    if (whatChanged.length === 0) {
        addGate('claim_grounding', 'warn', 'The brief states no changes to ground.', { blocking: false });
    } else if (orphans.length) {
        addGate('claim_grounding', 'fail', `${orphans.length} of ${whatChanged.length} stated changes cite no source from this run.`, { blocking: true });
    } else {
        addGate('claim_grounding', 'pass', `All ${whatChanged.length} stated changes trace to a source in this run.`, { blocking: true });
    }

    // ─── B2: confidence calibration ─────────────────────────────────────────
    // The one gate that rewrites. Confidence is recomputed from the evidence actually
    // gathered and capped by run tier; if the stored level is above that ceiling it is
    // corrected in place and the correction is recorded in `basis`.
    //
    // This is the product mechanic, not hygiene: `High` requires a full-depth run, so a
    // free run is structurally incapable of claiming it. Without this gate the free tier
    // reports High on eight searches and the paywall argument evaporates.
    // Recomputed with the SAME gates normalizeBrief used. If this call saw a different
    // ceiling from the one that shaped the brief, B2 would "downgrade" a level it had
    // itself just produced, on every run.
    const recomputed = calibrateConfidence({
        signals,
        depth: tier,
        claimed: out.confidence?.level,
        gates: verifierGates,
    });
    const stored = out.confidence?.level;
    if (stored && RANK[recomputed.level] < RANK[stored]) {
        out.confidence = {
            ...recomputed,
            basis: `${recomputed.basis} Downgraded from ${stored} — the evidence does not support it.`,
            claimed: stored,
        };
        changed = true;
        addGate('confidence_calibration', 'warn', `Confidence downgraded ${stored} → ${recomputed.level}.`, { blocking: false });
    } else {
        out.confidence = out.confidence || recomputed;
        addGate('confidence_calibration', 'pass', `Confidence ${recomputed.level} is within what the evidence supports.`, { blocking: false });
    }

    // ─── B3: falsifier present ──────────────────────────────────────────────
    // "What would change our view" is the section the positioning rests on. A brief that
    // asserts a read and names nothing that would overturn it is the thing this product
    // exists not to be.
    const falsifiers = Array.isArray(out.what_could_change_our_view) ? out.what_could_change_our_view : [];
    const minFalsifiers = whatChanged.length === 0 ? 1 : 2;
    if (falsifiers.length >= minFalsifiers) {
        addGate('falsifier_present', 'pass', `${falsifiers.length} stated way(s) this read could be wrong.`, { blocking: true });
    } else {
        addGate('falsifier_present', 'fail', `Only ${falsifiers.length} falsifier(s); ${minFalsifiers} required.`, { blocking: true });
    }

    // ─── B4: advice leakage ─────────────────────────────────────────────────
    // The prompts were relaxed to permit judgment ("what the evidence favours") after a
    // blanket ban on it. This is the executable half of that trade.
    //
    // Detect, never rewrite: editing the model's words to hide the leak would remove the
    // only evidence that the prompt started giving advice.
    const leaks = auditBriefVoice(out);
    if (leaks.length) {
        const summary = leaks.map(l => `${l.field}: ${l.phrases.join(', ')}`).join(' | ');
        addGate('advice_leakage', 'warn', `Instructional language in ${leaks.length} field(s) — ${summary}`, { blocking: false, fields: leaks });
    } else {
        addGate('advice_leakage', 'pass', 'No instructional language detected.', { blocking: false });
    }

    // ─── B6: required narrative is present ──────────────────────────────────
    // `why_it_matters` is requested by the prompt, and `clean(undefined)` yields ''. When
    // the model omitted it — which the summary call can do, since it is the call most
    // likely to be JSON-repaired after a truncation — the field shipped as an empty string
    // and every gate above it passed: B4 finds no advice in '', B3 counts falsifiers, B2
    // counts signals. A live company brief published with why_it_matters: "" and nothing
    // anywhere objected.
    //
    // Non-blocking: an empty section is a degraded brief, not a dishonest one, and holding
    // the whole run back over it would cost the founder the evidence too.
    const REQUIRED_NARRATIVE = out.kind === 'decision'
        ? ['our_read']
        : ['our_read', 'why_it_matters'];
    const emptyNarrative = REQUIRED_NARRATIVE.filter(f => !String(out[f] || '').trim());
    if (emptyNarrative.length) {
        addGate(
            'narrative_complete', 'warn',
            `${emptyNarrative.join(', ')} shipped empty — the prompt asks for ${emptyNarrative.length === 1 ? 'it' : 'them'} and the model returned nothing.`,
            { blocking: false, fields: emptyNarrative }
        );
    } else {
        addGate('narrative_complete', 'pass', 'Every required narrative field carries text.', { blocking: false });
    }

    // ─── B5: depth disclosure ───────────────────────────────────────────────
    // A shallow run must say what it did not do. An undisclosed thin run is the one
    // outcome that would make the free tier dishonest rather than merely limited.
    const isShallow = String(tier) === 'shallow';
    const gaps = Array.isArray(out.depth_gaps) ? out.depth_gaps : [];
    if (!isShallow) {
        addGate('depth_disclosure', 'pass', 'Full-depth run; nothing to disclose.', { blocking: true });
    } else if (gaps.length > 0) {
        addGate('depth_disclosure', 'pass', `Shallow run discloses ${gaps.length} gap(s).`, { blocking: true });
    } else {
        addGate('depth_disclosure', 'fail', 'Shallow run does not disclose what a full run would add.', { blocking: true });
    }

    const blocking = gates.filter(g => g.blocking !== false);
    const hasFail = blocking.some(g => g.status === 'fail');
    const hasWarn = blocking.some(g => g.status === 'warn') || gates.some(g => g.status === 'warn');
    const verdict = hasFail ? 'blocked' : hasWarn ? 'downgraded' : 'pass';

    const actions = [];
    if (changed) actions.push('confidence corrected to match the evidence');
    if (leaks.length) actions.push(`${leaks.length} field(s) flagged for instructional language`);
    if (!enforcing && hasFail) actions.push('report-only mode: this brief would be flagged under enforce');

    return {
        report: {
            policy_version: BRIEF_POLICY_VERSION,
            mode,
            verdict,
            checked_at: new Date().toISOString(),
            gates,
            counts: {
                claims: whatChanged.length,
                orphan_claims: orphans.length,
                falsifiers: falsifiers.length,
                considerations: Array.isArray(out.what_to_consider) ? out.what_to_consider.length : 0,
                advice_flags: leaks.length,
                confidence: out.confidence?.level || null,
            },
            actions,
        },
        brief: out,
        changed,
    };
}
