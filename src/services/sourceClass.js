/**
 * What KIND of evidence a finding rests on — one definition, two renderings.
 *
 * `source_class` is resolved from the observation a signal came from, never asked of the
 * model: a hallucinated provenance label is worse than none. This module owns how that
 * resolved value is spoken to a founder.
 *
 * There are two registers because there are two voices (see the voice rule: Bahirjee
 * speaks in the first person, the interface describes Bahirjee in the third):
 *
 *   LABEL      — an interface chip. A noun. "Regulatory filing."
 *   PROVENANCE — Bahirjee saying how it knows. A phrase that completes
 *                "I read this …". "…in a regulatory filing."
 *
 * Both maps are keyed by the same closed set. `scripts/letter.test.mjs` asserts that every
 * class has both renderings — a comment asking a future editor to keep two objects in sync
 * is not a mechanism.
 */

/**
 * The closed set. A value outside it renders as no provenance at all, never as itself.
 *
 * ⚠️ The ORDER is load-bearing, not alphabetical or incidental: strongest provenance
 * first. A filing is a legally binding disclosure; a community thread is someone's
 * opinion. `EvidenceBase` renders the run's evidence strip in this order, so the sequence
 * is itself information. Insert a new class at its true strength, not at the end.
 */
export const SOURCE_CLASSES = [
    'primary_company',
    'filing',
    'tender',
    'government',
    'review',
    'research',
    'analyst',
    'code',
    'social',
    'news',
];

/** Interface chips — third person, noun form. */
export const SOURCE_CLASS_LABELS = {
    primary_company: 'Company page',
    filing: 'Regulatory filing',
    tender: 'Live tender',
    government: 'Government',
    review: 'Customer review',
    research: 'Research',
    analyst: 'Analyst report',
    code: 'Technology',
    social: 'Community',
    news: 'Press',
};

/**
 * Interface chips, counted form — "3 regulatory filings".
 *
 * Separate from the singular map because English does not pluralise these mechanically:
 * "Governments" and "Researches" are both wrong, so the plural of each is written out.
 */
export const SOURCE_CLASS_LABELS_PLURAL = {
    primary_company: 'Company pages',
    filing: 'Regulatory filings',
    tender: 'Live tenders',
    government: 'Government',
    review: 'Customer reviews',
    research: 'Research',
    analyst: 'Analyst reports',
    code: 'Technology',
    social: 'Community',
    news: 'Press',
};

/** Bahirjee's own voice — completes "I read this …". */
export const SOURCE_CLASS_PROVENANCE = {
    primary_company: 'on the company’s own page',
    filing: 'in a regulatory filing',
    tender: 'in a live tender',
    government: 'in a government publication',
    review: 'in customer reviews',
    research: 'in published research',
    analyst: 'in an analyst report',
    code: 'in a technical changelog',
    social: 'in a public community thread',
    news: 'in the press',
};

/**
 * Classes that stand on their own without corroboration.
 *
 * A competitor's own pricing page, a regulatory filing, a published tender and a
 * government notice are the primary record of the thing they describe — a second source
 * would only be reporting on them. Press, community threads, analyst notes and reviews are
 * someone's account of an event, and one of those alone is a claim, not a fact.
 *
 * This is the distinction behind "one source only" in a letter: the caveat belongs on a
 * lone news item, not on a screenshot of the competitor's own price list. Applying it
 * uniformly would either caveat facts or launder claims, and both cost trust.
 */
const SELF_ATTESTING = new Set(['primary_company', 'filing', 'tender', 'government']);

/**
 * Does one source of this class carry a claim on its own?
 *
 * Unknown classes return false — the conservative direction. An unclassified source gets
 * the caveat rather than the benefit of the doubt.
 */
export function isSelfAttesting(sourceClass) {
    return SELF_ATTESTING.has(sourceClass);
}

/** Chip text for a class, or null when the class is unknown or absent. */
export function sourceClassLabel(sourceClass) {
    return SOURCE_CLASS_LABELS[sourceClass] || null;
}

/**
 * How Bahirjee says it knows, or null.
 *
 * Null is a real answer and callers must handle it: the class is resolved from the
 * observation, and an observation the mapper could not classify has no honest phrase.
 * Saying nothing beats inventing a provenance.
 */
export function sourceClassProvenance(sourceClass) {
    return SOURCE_CLASS_PROVENANCE[sourceClass] || null;
}
