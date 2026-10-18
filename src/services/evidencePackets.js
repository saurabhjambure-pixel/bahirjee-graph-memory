/**
 * Evidence Packets — projecting current signals out of retained evidence.
 *
 * This module answers "what may this surface show?" It never answers "what do we keep."
 * Every signal handed to it comes back out of `internal_evidence`, whatever its date. The
 * separation matters because the obvious implementation of "stop showing old material as
 * news" is to filter old material out, and that would throw away the evidence that makes a
 * recent event legible: the 2024 price rise is exactly what makes the 2026 price cut
 * interesting.
 *
 * So older evidence is ATTACHED rather than dropped. One anchor, labelled context behind
 * it, nothing deleted.
 *
 * Pure by design — no Supabase, no React, no provider calls. It takes signals and returns
 * new objects; it does not mutate, reorder or remove anything from the arrays it is given.
 */

import { buildTemporalPolicy, classifyEvidenceDate, normalizeIsoDate } from './temporalPolicy.js';

// How much context one anchor may carry. Past this the card stops being a signal and
// becomes a reading list — and the supporting material starts competing with the event
// it was attached to explain.
export const MAX_SUPPORTING_PER_ANCHOR = 3;
export const MAX_HISTORICAL_PER_ANCHOR = 2;

const ROLE_LABELS = {
    anchor: 'Current',
    supporting_context: 'Supporting context',
    historical_context: 'Historical context',
};

// ─── normalisation ──────────────────────────────────────────────────────────

/** Strip a URL to something comparable: no protocol, no trailing slash, no case. */
function normalizeUrl(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return '';
    return s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

/** Entity names arrive as "RivalPay", "RivalPay Inc.", "rivalpay". Compare the stem. */
function normalizeEntity(raw) {
    return String(raw || '')
        .toLowerCase()
        .replace(/\b(inc|ltd|llc|plc|pvt|private|limited|corp|corporation|co|gmbh|sa|bv)\b/g, '')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

/**
 * Give a signal its temporal fields, derived from its dates rather than its claims.
 *
 * The model is asked for `evidence_role` and will sometimes get it wrong — usually in the
 * flattering direction, because a current signal reads as more valuable than an old one.
 * The date is checkable and the claim is not, so the date wins. The model's answer is kept
 * as `claimed_evidence_role` for telemetry, never for display.
 *
 * @param {Object} signal
 * @param {Object} policy  from buildTemporalPolicy()
 * @param {Object} [retrievalMetadata] { retrievedAt, observedChange, sourceClass, retrievalWindow }
 */
export function normalizeSignalTemporalFields(signal, policy, retrievalMetadata = {}) {
    const s = signal || {};
    const p = policy || buildTemporalPolicy();
    const meta = retrievalMetadata || {};

    // `date` is what every signal in every stored report uses. Dropping it would make the
    // entire report history temporally unreadable, so it stays a first-class input.
    const eventDate = s.event_date ?? s.date ?? null;
    const publishedDate = s.published_date ?? meta.publishedDate ?? null;
    const retrievedAt = s.retrieved_at ?? meta.retrievedAt ?? null;

    const classification = classifyEvidenceDate({
        eventDate,
        publishedDate,
        retrievedAt,
        sourceClass: s.source_class ?? meta.sourceClass ?? null,
        sourceType: s.source_type ?? meta.sourceType ?? null,
        observedChange: meta.observedChange === true,
    }, p);

    return {
        ...s,
        event_date: classification.dateKind === 'event' ? classification.effectiveDate : normalizeIsoDate(eventDate),
        published_date: normalizeIsoDate(publishedDate),
        retrieved_at: retrievedAt || null,
        temporal_role: classification.temporalRole,
        date_confidence: classification.dateConfidence,
        effective_date: classification.effectiveDate,
        age_days: classification.ageDays,
        // What the model said, kept apart from what the dates say. Useful for measuring
        // how often the two disagree; never used to decide a surface.
        claimed_evidence_role: s.evidence_role ?? null,
        // The existing UI chip reads this. Keeping it in sync means the Background label
        // keeps working on every card that already renders it, including in stored
        // reports rendered by the shared-report path.
        freshness: classification.temporalRole === 'anchor' ? (s.freshness === 'background' ? undefined : s.freshness) : 'background',
        supporting_evidence: Array.isArray(s.supporting_evidence) ? s.supporting_evidence : [],
    };
}

// ─── linking ────────────────────────────────────────────────────────────────

/** A compact, clearly-labelled reference to one piece of older evidence. */
function toContextRef(signal) {
    return {
        source_url: signal.source_url || null,
        headline: signal.signal_headline || signal.raw_headline || signal.headline || '',
        entity: signal.entity_involved || signal.entity_name || null,
        event_date: signal.event_date || signal.effective_date || null,
        temporal_role: signal.temporal_role,
        date_confidence: signal.date_confidence,
        // The label travels WITH the reference rather than being re-derived at render
        // time, so no surface can accidentally present this as current.
        label: ROLE_LABELS[signal.temporal_role] || 'Context',
    };
}

/**
 * Attach older evidence to the recent anchors it explains.
 *
 * Linking order, strictest first:
 *   1. URLs the model named explicitly — accepted ONLY if they appear in the analyzed
 *      batch. A URL no observation contains is a fabrication, and attaching it would
 *      launder it into the report with the anchor's credibility behind it.
 *   2. Same entity, same category.
 *   3. Same category alone.
 *
 * Returns NEW anchor objects. The input arrays are not mutated and nothing is removed
 * from them: a context signal that gets attached here still exists in its own right.
 */
export function attachSupportingEvidence({
    anchors = [],
    contextSignals = [],
    historicalSignals = [],
    allowedUrls = null,
} = {}) {
    const pool = [...contextSignals, ...historicalSignals];
    const allowed = allowedUrls instanceof Set
        ? allowedUrls
        : new Set(pool.map(s => normalizeUrl(s.source_url)).filter(Boolean));

    return anchors.map(anchor => {
        const anchorUrl = normalizeUrl(anchor.source_url);
        const anchorEntity = normalizeEntity(anchor.entity_involved || anchor.entity_name);
        const anchorCategory = anchor.category || anchor.domain || null;

        const explicit = new Set(
            (Array.isArray(anchor.supporting_source_urls) ? anchor.supporting_source_urls : [])
                .map(normalizeUrl)
                .filter(u => u && allowed.has(u))
        );

        const scored = [];
        for (const candidate of pool) {
            const url = normalizeUrl(candidate.source_url);
            // An anchor citing itself is not corroboration.
            if (!url || url === anchorUrl) continue;

            const candidateEntity = normalizeEntity(candidate.entity_involved || candidate.entity_name);
            const sameEntity = Boolean(anchorEntity && candidateEntity && (
                anchorEntity === candidateEntity
                || (anchorEntity.length > 3 && candidateEntity.includes(anchorEntity))
                || (candidateEntity.length > 3 && anchorEntity.includes(candidateEntity))
            ));
            const sameCategory = Boolean(
                anchorCategory && (candidate.category === anchorCategory || candidate.domain === anchorCategory)
            );

            // Rank: an explicit link beats an inferred one; same-entity beats
            // same-category-only. Relevance and date confidence only break ties — a
            // high-scoring signal about a different company is still about a different
            // company.
            let tier = 0;
            if (explicit.has(url)) tier = 3;
            else if (sameEntity && sameCategory) tier = 2;
            else if (sameEntity) tier = 2;
            else if (sameCategory) tier = 1;
            if (tier === 0) continue;

            scored.push({
                candidate,
                tier,
                relevance: Number(candidate.relevance_score) || 0,
                confidence: CONFIDENCE_RANK[candidate.date_confidence] || 0,
            });
        }

        scored.sort((a, b) =>
            b.tier - a.tier
            || b.confidence - a.confidence
            || b.relevance - a.relevance
            || String(a.candidate.source_url).localeCompare(String(b.candidate.source_url))
        );

        // Separate caps per band, so a pile of 2024 material cannot crowd out the
        // 12-month context that is usually the more useful explanation.
        const seen = new Set();
        const attached = [];
        let supporting = 0;
        let historical = 0;
        for (const { candidate } of scored) {
            const url = normalizeUrl(candidate.source_url);
            if (seen.has(url)) continue;
            if (candidate.temporal_role === 'historical_context') {
                if (historical >= MAX_HISTORICAL_PER_ANCHOR) continue;
                historical++;
            } else {
                if (supporting >= MAX_SUPPORTING_PER_ANCHOR) continue;
                supporting++;
            }
            seen.add(url);
            attached.push(toContextRef(candidate));
        }

        return { ...anchor, supporting_evidence: attached };
    });
}

// ─── the packet ─────────────────────────────────────────────────────────────

/**
 * Classify a run's signals and build the surface projections.
 *
 * `signals` comes back unchanged in the result and is the complete retained set. The
 * anchors/context/historical arrays are VIEWS of it, not partitions that consume it.
 */
export function buildEvidencePackets({ signals = [], policy = null, retrievalMetadata = null } = {}) {
    const p = policy || buildTemporalPolicy();
    const lookup = retrievalMetadata instanceof Map
        ? retrievalMetadata
        : new Map(Object.entries(retrievalMetadata || {}));

    const normalized = (Array.isArray(signals) ? signals : []).map(s =>
        normalizeSignalTemporalFields(s, p, lookup.get(normalizeUrl(s?.source_url)) || {})
    );

    const rawAnchors = normalized.filter(s => s.temporal_role === 'anchor');
    const supportingContext = normalized.filter(s => s.temporal_role === 'supporting_context' && s.effective_date);
    const historicalContext = normalized.filter(s => s.temporal_role === 'historical_context');
    // Undated evidence classifies as supporting_context (we cannot show it as current),
    // but it is worth counting separately: a run that is mostly undated has a retrieval
    // problem, not a judgement one, and the disclosure should say which.
    const undated = normalized.filter(s => !s.effective_date);

    const anchors = attachSupportingEvidence({
        anchors: rawAnchors,
        contextSignals: supportingContext,
        historicalSignals: historicalContext,
    });

    return {
        policy: p,
        // The complete retained set. Every caller that needs "all the evidence" reads
        // this, and it is exactly what was passed in, normalised.
        signals: normalized,
        anchors,
        supportingContext,
        historicalContext,
        undated,
        counts: {
            total: normalized.length,
            anchors: anchors.length,
            supportingContext: supportingContext.length,
            historicalContext: historicalContext.length,
            undated: undated.length,
            anchorsWithSupport: anchors.filter(a => a.supporting_evidence.length > 0).length,
        },
    };
}

/**
 * What a given surface may show.
 *
 * `internal_evidence` is the full retained set and is what makes the no-deletion
 * guarantee checkable: whatever went in comes out of this projection.
 *
 * An unrecognised surface returns NOTHING rather than everything. A typo in a surface
 * name should show an empty section, not silently publish historical material as news.
 */
export function projectEvidenceForSurface(packets, surface) {
    if (!packets) return [];
    switch (surface) {
        case 'current_news':
        case 'signal_cards':
        case 'summary':
            return packets.anchors || [];
        case 'internal_evidence':
            return packets.signals || [];
        default:
            return [];
    }
}
