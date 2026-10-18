/**
 * Report Verifier — the pre-publish coverage gate.
 *
 * Every other quality control in this pipeline is SUBTRACTIVE and per-item: grounding,
 * quote-binding, read-guard, self-guard, echo-filter, dedupe. Each drops a bad signal.
 * Nothing looked at the finished set and asked whether it is worth publishing, so a run
 * whose filters stripped it bare shipped thin and silent.
 *
 * This module answers one question — "what is missing?" — and it answers it
 * deterministically. No LLM: a judge that can hallucinate a pass is not a gate. It scores
 * the assembled signals and returns the gaps; the caller decides whether to retrieve more
 * (once) and how to report what remains.
 *
 * Implements the checks specified in the internal multi-agent plan §6.4.
 *
 * IMPORTANT: a gap is never fixed by lowering the bar. Per the internal design log
 * ("Fewer verified findings beat more plausible ones"), the only valid response to a gap
 * is more evidence or an honest disclosure — never a relaxed filter.
 */

import { SECTION_MAP, CRITICAL_SECTIONS, sectionForCategory } from './signalTaxonomy.js';

// Display sections a founder expects to see, and the signal categories that feed each.
// Sourced from signalTaxonomy.js so this can no longer drift out of sync with the
// report's grouping — it used to be a hand-maintained mirror of it.
export const SECTION_CATEGORIES = SECTION_MAP;

// Re-exported so existing importers (and scripts/report-verifier.test.mjs) keep working.
export { CRITICAL_SECTIONS, sectionForCategory };

export const VERIFIER_THRESHOLDS = {
    // Below this, the report is too thin to be worth publishing without comment.
    minSignals: 4,
    // Distinct source domains. Six signals from one outlet is one story, not six.
    minSourceDomains: 3,
    // No single domain may account for more than this share of signals.
    maxDomainShare: 0.6,
    // Share of signals allowed to carry an unverifiable date.
    maxLowDateConfidence: 0.5,
    // Share of signals allowed to lack a source URL entirely.
    maxMissingSource: 0.25,
    // Distinct KINDS of evidence (filing, tender, review, primary_company, news, …).
    // Ten domains that are all news outlets is still one kind of knowing. This is the
    // gate that makes the source expansion mean something: a brief drawn only from press
    // coverage is a weaker brief than one that also read a filing and a live tender.
    // Deliberately low — many companies are genuinely quiet in most classes in most
    // weeks, and a gate that fires every run trains the founder to ignore it.
    minSourceClasses: 2,
    // Above this many signals, ZERO classified evidence is a plumbing failure rather than
    // a thin run, and is reported as such.
    //
    // Derived from the shallow tier's own ceiling (RUN_TIERS.shallow.maxSummarySignals is
    // 20): a shallow run reserves only 2 tier queries, so it can legitimately produce a
    // handful of signals none of which came from a tier. A full run reserves 9 and cannot.
    // Sitting just above the shallow ceiling means this gate only judges runs where the
    // absence of any class is unambiguous.
    minSignalsForClassCheck: 25,
};

/** Extract a comparable hostname, or '' when the URL is unusable. */
function domainOf(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    try {
        return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname
            .replace(/^www\./, '')
            .toLowerCase();
    } catch {
        return '';
    }
}

/**
 * Score the assembled signals.
 *
 * @param {Array} signals - post-filter signals about to be published
 * @param {Object} [options]
 * @param {string[]} [options.criticalSections] - sections whose emptiness counts as a gap
 * @param {Object}   [options.thresholds] - override VERIFIER_THRESHOLDS
 * @returns {{ ok: boolean, gaps: Array, metrics: Object }}
 *          `gaps[]` entries are { type, section?, reason, retryable }.
 *          `retryable` marks gaps that more retrieval could plausibly fix — a thin
 *          section can be; a set of signals with unverifiable dates cannot.
 */
export function verifyReport(signals, options = {}) {
    const list = Array.isArray(signals) ? signals.filter(Boolean) : [];
    const t = { ...VERIFIER_THRESHOLDS, ...(options.thresholds || {}) };
    const criticalSections = options.criticalSections || CRITICAL_SECTIONS;

    const gaps = [];

    // ── Volume ──────────────────────────────────────────────────────────────
    if (list.length === 0) {
        return {
            ok: false,
            gaps: [{ type: 'no_signals', reason: 'No publishable signals survived verification.', retryable: true }],
            metrics: { total: 0, sections: {}, domains: 0, sourceClasses: {}, distinctSourceClasses: 0 },
        };
    }
    if (list.length < t.minSignals) {
        gaps.push({
            type: 'thin_report',
            reason: `Only ${list.length} signal(s) survived verification (expected at least ${t.minSignals}).`,
            retryable: true,
        });
    }

    // ── Section coverage ────────────────────────────────────────────────────
    const sections = {};
    for (const section of Object.keys(SECTION_CATEGORIES)) sections[section] = 0;
    for (const s of list) {
        const section = sectionForCategory(s.category);
        if (section) sections[section] += 1;
    }
    for (const section of criticalSections) {
        if ((sections[section] || 0) === 0) {
            gaps.push({
                type: 'empty_section',
                section,
                reason: `No credible signals found for "${section}".`,
                retryable: true,
            });
        }
    }

    // ── Source diversity ────────────────────────────────────────────────────
    const domainCounts = new Map();
    let missingSource = 0;
    for (const s of list) {
        const domain = domainOf(s.source_url);
        if (!domain) { missingSource += 1; continue; }
        domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    }

    const distinctDomains = domainCounts.size;
    if (distinctDomains > 0 && distinctDomains < t.minSourceDomains) {
        gaps.push({
            type: 'low_source_diversity',
            reason: `Signals came from only ${distinctDomains} distinct source(s) (expected at least ${t.minSourceDomains}).`,
            retryable: true,
        });
    }

    const topDomainCount = domainCounts.size ? Math.max(...domainCounts.values()) : 0;
    const domainShare = list.length ? topDomainCount / list.length : 0;
    if (distinctDomains > 1 && domainShare > t.maxDomainShare) {
        const [topDomain] = [...domainCounts.entries()].sort((a, b) => b[1] - a[1])[0];
        gaps.push({
            type: 'source_concentration',
            reason: `${Math.round(domainShare * 100)}% of signals come from a single source (${topDomain}).`,
            retryable: true,
        });
    }

    // ── Source-class diversity ──────────────────────────────────────────────
    // Only counts signals we could actually classify. An unclassified signal is not
    // evidence of narrowness — untiered general search legitimately carries no class —
    // so the gate only fires once enough of the run IS classified to judge it.
    const classCounts = new Map();
    for (const s of list) {
        if (!s.source_class) continue;
        classCounts.set(s.source_class, (classCounts.get(s.source_class) || 0) + 1);
    }
    const classifiedCount = [...classCounts.values()].reduce((n, v) => n + v, 0);
    const distinctClasses = classCounts.size;
    if (classifiedCount >= t.minSignals && distinctClasses > 0 && distinctClasses < t.minSourceClasses) {
        const [onlyClass] = [...classCounts.keys()];
        gaps.push({
            type: 'low_source_class_diversity',
            reason: `All classified evidence is one kind (${onlyClass}) — expected at least ${t.minSourceClasses} distinct source types.`,
            retryable: true,
        });
    } else if (list.length >= t.minSignalsForClassCheck && classifiedCount === 0) {
        // Nothing classified AT ALL is a different failure from narrow classification, and
        // the `distinctClasses > 0` guard above deliberately lets it through — which meant
        // the worst case was the one case that stayed silent. Every run spends a fixed floor
        // of tier queries, and tiers stamp a class, so a full run that classified nothing is
        // a plumbing failure upstream, not a quiet week.
        //
        // Not retryable: searching again cannot repair a label lost between observation and
        // signal. It is reported so the run is visibly unclassified rather than invisibly so.
        gaps.push({
            type: 'no_source_class',
            reason: `None of ${list.length} signals carry a source class — provenance was lost between observation and signal, not absent from the evidence.`,
            retryable: false,
        });
    }

    // ── Evidence density ────────────────────────────────────────────────────
    // Not retryable: a missing citation is a defect in what we already have, and more
    // searching does not repair it.
    const missingShare = list.length ? missingSource / list.length : 0;
    if (missingShare > t.maxMissingSource) {
        gaps.push({
            type: 'missing_sources',
            reason: `${Math.round(missingShare * 100)}% of signals carry no source URL.`,
            retryable: false,
        });
    }

    // ── Date confidence ─────────────────────────────────────────────────────
    // Date precedence is the temporal policy's (event > published > legacy `date`), never
    // retrieved_at. Signals carry `event_date`/`published_date`, not `date`: reading only
    // `date` counted every dated signal as undated and put "67% unverifiable" on a brief
    // whose own verify gate measured 17%.
    const hasDate = s => Boolean(s.event_date || s.published_date || s.date);
    const lowDate = list.filter(s => s.date_confidence === 'low' || !hasDate(s)).length;
    const lowDateShare = list.length ? lowDate / list.length : 0;
    if (lowDateShare > t.maxLowDateConfidence) {
        gaps.push({
            type: 'low_date_confidence',
            reason: `${Math.round(lowDateShare * 100)}% of signals have an unverifiable date.`,
            retryable: false,
        });
    }

    return {
        ok: gaps.length === 0,
        gaps,
        metrics: {
            total: list.length,
            sections,
            domains: distinctDomains,
            // Powers the evidence-base strip in the report, so it ships even on a clean run.
            sourceClasses: Object.fromEntries(classCounts),
            distinctSourceClasses: distinctClasses,
            topDomainShare: Number(domainShare.toFixed(2)),
            lowDateShare: Number(lowDateShare.toFixed(2)),
            missingSourceShare: Number(missingShare.toFixed(2)),
        },
    };
}

/** The sections a retrieval retry should target — retryable gaps only. */
export function retryTargetsFor(gaps) {
    if (!Array.isArray(gaps)) return [];
    return [...new Set(
        gaps.filter(g => g?.retryable && g.section).map(g => g.section)
    )];
}
