/**
 * Recognition before revelation.
 *
 * An operator's first reaction to any machine-written analysis is "is this real, or is it
 * generic?" They do not check citations. They scan for one sentence about their OWN
 * business that is specifically, verifiably true — and if they find it, they extend credit
 * to everything that follows. If they don't, the best analysis in the world reads as
 * filler.
 *
 * So every brief and every letter opens by saying back what Bahirjee holds about them.
 * That is the handshake, and it costs nothing: all of it is already in the stored context.
 *
 * ── Two rules ────────────────────────────────────────────────────────────────
 *
 * 1. DERIVED, NEVER ASKED. No model call. Asking a model to restate the context it was
 *    given is a hallucination surface with no upside — the same reason `what_changed` is
 *    built from the signal set rather than requested.
 *
 * 2. A GAP BEATS A GUESS. Any part that does not resolve confidently is dropped, not
 *    filled. A recognition line that gets the reader's own business wrong is worse than no
 *    recognition line at all: it fails the exact test it exists to pass.
 */

const clean = (value, limit = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

/** First non-empty string from a list of candidates. */
function firstOf(...candidates) {
    for (const candidate of candidates) {
        const value = clean(candidate);
        if (value) return value;
    }
    return '';
}

/**
 * The first candidate that resolves, together with the field path it came from.
 *
 * The pairing is the point. A sentence's correction is recorded against a field path, and
 * `applyContextPatch` refuses to overwrite exactly the paths in `_userEdits.fields`. If a
 * sentence renders a value read from `dependency_map.regulatory_exposure` but records the
 * edit against `strategic_anchors.primary_risk`, the founder's correction protects a field
 * they never saw while the one they actually fixed stays open to being overwritten by the
 * next merge — and nothing errors. Value and field have to travel together.
 *
 * @param {Array<[string, unknown]>} candidates  [fieldPath, value] pairs, best first.
 */
function firstFieldOf(candidates) {
    for (const [field, raw] of candidates) {
        const value = clean(raw);
        if (value) return { value, field };
    }
    return { value: '', field: null };
}

/**
 * Join a list the way a person would say it: "a, b and c".
 *
 * Oxford comma deliberately omitted — the letter is written in a plain register, not a
 * legal one.
 */
export function listPhrase(items, max = 3) {
    const list = (Array.isArray(items) ? items : [])
        .map(i => clean(typeof i === 'string' ? i : (i?.name || i?.label), 60))
        .filter(Boolean)
        .slice(0, max);
    if (!list.length) return '';
    if (list.length === 1) return list[0];
    return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** Geography can arrive as a string, a list, or an object with a region. */
function geographyPhrase(context) {
    const geo = context?.operating_geography ?? context?.strategic_anchors?.operating_geography;
    if (Array.isArray(geo)) return listPhrase(geo);
    if (geo && typeof geo === 'object') return firstOf(geo.primary, geo.region, geo.name);
    return clean(geo, 120);
}

/** What the company actually sells, preferring the observed reality over the pitch. */
function whatTheySell(context) {
    return firstOf(
        context?.strategic_anchors?.operational_reality,
        context?.what_they_sell,
        context?.industry
    );
}

/** Who they sell to — the buyer type, or the named segments, or nothing. */
function whoTheySellTo(context) {
    const buyer = firstOf(
        context?.strategic_anchors?.buyer_type?.primary,
        context?.strategic_anchors?.buyer_type
    );
    const segments = listPhrase(context?.customer_segments, 2);
    if (buyer && segments) return `${buyer.toLowerCase()} ${segments}`;
    return buyer ? buyer.toLowerCase() : segments;
}

/** The competitors being tracked, by name. */
function competitorsPhrase(context) {
    return listPhrase(context?.key_competitors ?? context?.competitors, 3);
}

/**
 * The recognition line: one sentence, second person, checkable.
 *
 * Built from at most three clauses so it stays a sentence rather than a dossier. Returns
 * an empty string when too little resolves — callers must handle that by omitting the
 * line, never by substituting a generic greeting.
 */
export function buildRecognitionLine(context = {}) {
    const sells = whatTheySell(context);
    const to = whoTheySellTo(context);
    const where = geographyPhrase(context);

    if (!sells) return '';

    let line = `You sell ${lowerFirst(sells)}`;
    if (to) line += ` to ${to}`;
    if (where) line += ` in ${where}`;
    return `${line}.`;
}

/**
 * The five sentences of "Is this you?".
 *
 * Same derivation as the recognition line, rendered as a list the founder can correct one
 * line at a time. Each carries the `field` path it edits so the confirmation screen can
 * record a correction against the exact field — which is what keeps `_userEdits` honest.
 *
 * A sentence whose value does not resolve is DROPPED rather than shown blank. Four true
 * sentences beat five with a gap: a blank line invites the reader to do data entry, which
 * is the failure mode this screen exists to remove.
 */
export function buildContextSentences(context = {}) {
    const to = whoTheySellTo(context);
    const where = geographyPhrase(context);
    const rivals = competitorsPhrase(context);

    // Each of these resolves a value AND the field path that produced it, so a correction
    // is recorded against the field the founder was actually shown.
    const sells = firstFieldOf([
        ['strategic_anchors.operational_reality', context?.strategic_anchors?.operational_reality],
        ['what_they_sell', context?.what_they_sell],
        ['industry', context?.industry],
    ]);
    const edge = firstFieldOf([
        ['strategic_anchors.narrative_lens', context?.strategic_anchors?.narrative_lens],
        ['value_proposition', context?.value_proposition],
        ['strategic_anchors.current_optimization', context?.strategic_anchors?.current_optimization?.focus],
    ]);
    const risk = firstFieldOf([
        ['strategic_anchors.primary_risk', context?.strategic_anchors?.primary_risk],
        ['dependency_map.regulatory_exposure', (context?.dependency_map?.regulatory_exposure || [])[0]],
        ['customer_segments', (context?.customer_segments || [])[0]?.pain_point],
    ]);

    return [
        sells.value && { id: 'sells', field: sells.field, lead: 'You sell', value: lowerFirst(sells.value), tail: to ? ` to ${to}.` : '.' },
        where && { id: 'where', field: 'operating_geography', lead: 'Your customers are mostly in', value: where, tail: '.' },
        rivals && { id: 'rivals', field: 'key_competitors', lead: 'The competitors worth watching are', value: rivals, tail: '.' },
        edge.value && { id: 'edge', field: edge.field, lead: 'You win on', value: lowerFirst(edge.value), tail: '.' },
        risk.value && { id: 'risk', field: risk.field, lead: 'What would hurt most is', value: lowerFirst(risk.value), tail: '.' },
    ]
        .filter(Boolean)
        // `text` is the joined sentence; `lead`/`value`/`tail` are the same sentence split
        // so the confirmation screen can make `value` the editable span. Both are provided
        // because the join is not obvious — `tail` carries its own leading space where one
        // is needed, and a caller doing `[lead, value, tail].join(' ')` would print " .".
        .map(s => ({ ...s, text: `${s.lead} ${s.value}${s.tail}` }));
}

/**
 * Write a founder's correction back into the context, and record that they made it.
 *
 * This is the other half of `buildContextSentences`, and it lives beside it deliberately:
 * a derivation whose inverse is written somewhere else drifts from it, and the drift is
 * silent — the sentence renders from one field while the correction lands in another.
 *
 * ── Where an edit lands ──────────────────────────────────────────────────────
 * Usually the field the value was read from. The exception is a sentence whose value was
 * inferred from a LIST the founder did not author — "what would hurt most", when it fell
 * back to a regulatory exposure or a segment's pain point. Editing that sentence must not
 * rewrite the regulatory exposure list; it means "here is my actual risk", so it writes to
 * `strategic_anchors.primary_risk`, which is the founder's own field. `editField` is
 * therefore separate from `field`, and the recorded edit always names where we WROTE.
 *
 * ── Why recording matters more than the write ────────────────────────────────
 * `applyContextPatch` refuses to overwrite any path in `_userEdits.fields`, and
 * `stepMemory` refuses to re-add any name in `_userEdits.removed`. A correction that is
 * not recorded is a correction the next merge will quietly undo.
 *
 * @returns {object} A NEW context. The input is never mutated.
 */
export function applySentenceEdit(context, sentence, newValue) {
    const value = clean(newValue, 400);
    if (!sentence || !value) return context;

    const field = editFieldFor(sentence);
    const next = structuredCloneish(context);

    if (field === 'key_competitors') {
        // "Holisol, Stockarea and Increff" back into objects, keeping whatever we already
        // knew about a competitor whose name survived the edit (its url, why_competitor,
        // evidence_quote). Re-deriving those from a name would throw away real evidence.
        const existing = Array.isArray(next.key_competitors) ? next.key_competitors : [];
        const byName = new Map(existing.map(c => [clean(c?.name).toLowerCase(), c]));
        const names = splitListPhrase(value);
        next.key_competitors = names.map(name => byName.get(name.toLowerCase()) || { name });

        // Anyone the founder struck out is recorded as removed, not merely absent — absence
        // is indistinguishable from "we never found them", and the next run would re-add.
        const removed = existing
            .map(c => clean(c?.name))
            .filter(name => name && !names.some(n => n.toLowerCase() === name.toLowerCase()));
        return recordEdit(next, field, removed);
    }

    setAtPath(next, field, value);
    return recordEdit(next, field, []);
}

/** Where an edit to this sentence is written. See applySentenceEdit. */
export function editFieldFor(sentence) {
    if (sentence?.id === 'risk' && sentence.field !== 'strategic_anchors.primary_risk') {
        return 'strategic_anchors.primary_risk';
    }
    return sentence?.field;
}

/** Shallow-enough clone: every path we write is re-created on the way down. */
function structuredCloneish(context) {
    return { ...(context || {}) };
}

/** Set a dotted path, copying each object on the way so callers' objects are untouched. */
function setAtPath(target, path, value) {
    const parts = String(path || '').split('.');
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i++) {
        cursor[parts[i]] = { ...(cursor[parts[i]] || {}) };
        cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
}

/**
 * Append to `_userEdits` in exactly the shape ContextReviewScreen has always written.
 *
 * Same keys, same semantics, same de-duplication. The confirmation screen is a new way to
 * express a correction, not a new way to record one — `applyContextPatch` and `stepMemory`
 * must not be able to tell which screen the founder used.
 */
function recordEdit(context, field, removedNames = []) {
    const prior = context._userEdits || {};
    context._userEdits = {
        ...prior,
        fields: [...new Set([...(prior.fields || []), field].filter(Boolean))],
        removed: [...new Set([...(prior.removed || []), ...removedNames.filter(Boolean)])],
        at: new Date().toISOString(),
    };
    return context;
}

/** The inverse of `listPhrase`: "a, b and c" → ['a','b','c']. */
export function splitListPhrase(phrase) {
    return String(phrase || '')
        .split(/,|\band\b|&/i)
        .map(part => clean(part, 60))
        .filter(Boolean);
}

/**
 * Below this many resolved sentences the confirmation screen is not worth showing — there
 * is not enough for the founder to recognise, and asking "is this you?" about two facts
 * reads as an admission that Bahirjee learned nothing.
 */
export const MIN_SENTENCES_FOR_CONFIRM = 3;

/** Lowercase a leading capital unless it looks like a proper noun or acronym. */
function lowerFirst(text) {
    const value = clean(text);
    if (!value) return '';
    const firstWord = value.split(/\s/)[0];
    const isAcronym = firstWord.length > 1 && firstWord === firstWord.toUpperCase();
    const looksProper = /^[A-Z][a-z]+$/.test(firstWord) && /^[A-Z]/.test(value.split(/\s/)[1] || '');
    if (isAcronym || looksProper) return value;
    return value.charAt(0).toLowerCase() + value.slice(1);
}
