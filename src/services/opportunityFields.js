/**
 * The opportunity block — the structured half of a signal that describes a door the founder
 * could walk through: who holds it, what opened it, until when, for how much, how the founder
 * fits, and what the evidence does not settle.
 *
 * The same quote-or-drop rule as evidence_quote, applied field by field. A grant deadline the
 * model invented is worse than none: it is the one field a founder may plan a week around.
 * So the deadline survives only when the model also copied the words that state it and those
 * words are in the analyzed batch; the amount only when it appears verbatim. A field that
 * fails is removed — the signal is kept, because the door may still be real.
 *
 * `status` is derived from the grounded deadline and the clock, never taken from the model.
 * A closed opportunity is kept and labelled closed: nothing is deleted, and "this closed last
 * week" is itself worth knowing.
 */
import { OPPORTUNITY_CATEGORIES } from './signalTaxonomy.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIST_ITEMS = 4;

// Accepted spellings per month, full name first. Interpolated only via a non-capturing group.
const MONTH_FORMS = [
    ['january', 'jan'], ['february', 'feb'], ['march', 'mar'], ['april', 'apr'],
    ['may'], ['june', 'jun'], ['july', 'jul'], ['august', 'aug'],
    ['september', 'sept', 'sep'], ['october', 'oct'], ['november', 'nov'], ['december', 'dec'],
];

const norm = (text) => String(text || '').replace(/\s+/g, ' ').toLowerCase().trim();

const clean = (value, max) => {
    if (typeof value !== 'string') return null;
    const s = value.replace(/\s+/g, ' ').trim();
    return s ? s.slice(0, max) : null;
};

const cleanList = (value) => (Array.isArray(value) ? value : [])
    .map(item => clean(item, 200))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);

/**
 * Check if a deadline quote contains the ISO date in any of these forms:
 * - ISO string itself (2026-10-31)
 * - Day + month name: 31 October 2026, October 31 2026, 01 Nov 2026, Oct. 31, 2026
 *   Allow optional ordinal suffix (st/nd/rd/th), optional period after abbreviation,
 *   optional comma, optional leading zero on day, 'sept' for September, and year must appear
 * - Numeric day-first or month-first (31/10/2026, 10/31/2026, 31-10-2026, 31.10.2026) — only
 *   when unambiguous: the day is above 12, or day and month are the same number.
 *
 * Match day numbers on word boundaries.
 */
export function quoteStatesDate(quote, iso) {
    if (typeof quote !== 'string' || typeof iso !== 'string') return false;
    const q = quote.toLowerCase();

    // ISO string itself
    if (q.includes(iso)) return true;

    // Extract parts from ISO date
    const [year, month, day] = iso.split('-');
    const dayNum = parseInt(day, 10);
    const monthNum = parseInt(month, 10);

    // One place builds the month alternation, always as a single non-capturing group with the
    // full name first. Never interpolate an alternation raw: a bare `sep|sept` splits the whole
    // pattern and lets the word "September" alone ground any September date.
    const monthAlternation = monthNum >= 1 && monthNum <= 12
        ? `(?:${MONTH_FORMS[monthNum - 1].join('|')})`
        : null;

    // Day: optional leading zero, optional ordinal suffix. Whole-number match is enforced by the
    // surrounding word boundary / whitespace, so "1" never matches inside "11" or "21".
    const dayPattern = `0?${dayNum}(?:st|nd|rd|th)?`;

    if (monthAlternation) {
        // day + month + year (31 October 2026, 01 Nov 2026) and month + day + year (Oct. 31, 2026).
        // The year must be adjacent: a month name without a day and year states no date.
        const patterns = [
            new RegExp(`\\b${dayPattern}\\s+${monthAlternation}\\.?\\s+${year}\\b`, 'i'),
            new RegExp(`\\b${monthAlternation}\\.?\\s+${dayPattern}(?:\\s*,)?\\s+${year}\\b`, 'i'),
        ];
        for (const pattern of patterns) {
            if (pattern.test(q)) return true;
        }
    }

    // Numeric forms (d/m/y or m/d/y, separators / - . or space) ground a date ONLY when there
    // is one possible reading: the day is above 12 (31/10/2026 and 10/31/2026 cannot mean
    // anything else) or day and month are the same number (05/05/2026). "02/01/2027" is
    // 2 January to one source and 1 February to another; a deadline a founder plans around
    // does not get to guess. The ISO string and month-name forms above are the ways to state it.
    const numDay = `0?${dayNum}`;
    const monthPattern = `0?${monthNum}`;
    const unambiguous = dayNum > 12 || dayNum === monthNum;
    if (!unambiguous) return false;

    // Numeric day-first: 31/10/2026, 31-10-2026, 31.10.2026, 05/05/2026
    const dayFirstPatterns = [
        new RegExp(`\\b${numDay}[/\\-.\\s]${monthPattern}[/\\-.\\s]${year}\\b`),
    ];
    for (const pattern of dayFirstPatterns) {
        if (pattern.test(q)) return true;
    }

    // Numeric month-first: 10/31/2026 (day > 12, so unambiguous)
    if (dayNum > 12) {
        const monthFirstPatterns = [
            new RegExp(`\\b${monthPattern}[/\\-.\\s]${numDay}[/\\-.\\s]${year}\\b`),
        ];
        for (const pattern of monthFirstPatterns) {
            if (pattern.test(q)) return true;
        }
    }

    return false;
}

/**
 * Check if a substring at a given position in the haystack is not preceded by a digit/separator
 * and not followed by a digit. This ensures standalone occurrences (e.g., '$5' does not match
 * inside '$50', and '50,000' does not match inside '1,50,000').
 */
function isStandaloneAt(haystack, index, length) {
    const charBefore = index > 0 ? haystack[index - 1] : null;
    const charAfter = index + length < haystack.length ? haystack[index + length] : null;

    // Character before must not be digit or separator (/, -, ., ,)
    const validBefore = !charBefore || !/[\d/\-.,]/.test(charBefore);
    // Character after must not be a digit, nor a decimal/thousands separator that continues into
    // one ("$5" is not inside "$5.5m" or "$5,000"). A sentence-ending "$50." still passes.
    const charAfter2 = index + length + 1 < haystack.length ? haystack[index + length + 1] : null;
    const validAfter = !charAfter
        || (!/\d/.test(charAfter) && !(/[.,]/.test(charAfter) && charAfter2 && /\d/.test(charAfter2)));

    return validBefore && validAfter;
}

/**
 * A valid calendar date in strict YYYY-MM-DD, or null. Non-throwing on any input: a month of
 * 00 or 13 makes `toISOString()` throw a RangeError, and a model-controlled string must never
 * throw inside the shared filter chain (it would discard the whole analyze batch).
 */
function validIsoDate(value) {
    const iso = String(value || '').trim();
    if (!ISO_DATE.test(iso)) return null;
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * Open / closed / unknown for an opportunity, from its deadline and the clock only.
 * The stored `status` is a record of the day of analysis; a report opened after the deadline
 * must not still say "Closes". A due date equal to today is still open.
 */
export function opportunityStatusOn(opportunity, today = new Date().toISOString().slice(0, 10)) {
    const deadline = validIsoDate(opportunity?.deadline);
    if (!deadline) return 'unknown';
    // ISO dates compare correctly as strings.
    return deadline < today ? 'closed' : 'open';
}

function groundOne(signal, haystack, today) {
    if (!signal || typeof signal !== 'object') return signal;
    const { opportunity, ...rest } = signal;
    if (!('opportunity' in signal)) return signal;
    if (!OPPORTUNITY_CATEGORIES.includes(String(signal.category || '').trim())) return rest;
    if (!opportunity || typeof opportunity !== 'object') return rest;

    const counterparty = clean(opportunity.counterparty, 120);
    const trigger = clean(opportunity.trigger, 300);
    // No door without who holds it and what opened it.
    if (!counterparty || !trigger) return rest;

    const deadlineQuote = clean(opportunity.deadline_quote, 300);
    const deadlineIso = String(opportunity.deadline || '').trim();

    // Deadline: quote must exist, be in batch, state the exact ISO date, and be a valid calendar date
    const deadline = deadlineQuote
        && deadlineQuote.length >= 6
        && haystack.includes(norm(deadlineQuote))
        && validIsoDate(deadlineIso)
        && quoteStatesDate(deadlineQuote, deadlineIso)
        ? deadlineIso
        : null;

    // Amount: must contain at least one digit, be >= 2 chars, and be standalone in the batch
    const amountRaw = clean(opportunity.amount, 80);
    let amount = null;
    if (amountRaw && /\d/.test(amountRaw) && amountRaw.length >= 2) {
        const amountNorm = norm(amountRaw);
        let searchIndex = 0;
        while (true) {
            const index = haystack.indexOf(amountNorm, searchIndex);
            if (index === -1) break;

            if (isStandaloneAt(haystack, index, amountNorm.length)) {
                amount = amountRaw;
                break;
            }
            searchIndex = index + 1;
        }
    }

    return {
        ...rest,
        opportunity: {
            counterparty,
            trigger,
            deadline,
            deadline_quote: deadline ? deadlineQuote : null,
            amount,
            fit: cleanList(opportunity.fit),
            unknowns: cleanList(opportunity.unknowns),
            status: opportunityStatusOn({ deadline }, today),
        },
    };
}

/**
 * @param {Array} signals
 * @param {string} batchText - the exact text the model analyzed
 * @param {{ today?: string }} [options] - YYYY-MM-DD; injectable so tests are clock-free
 */
export function groundOpportunityFields(signals, batchText, { today = new Date().toISOString().slice(0, 10) } = {}) {
    if (!Array.isArray(signals) || signals.length === 0) return [];
    const haystack = norm(batchText);
    let removed = 0;
    const out = signals.map(signal => {
        const grounded = groundOne(signal, haystack, today);
        // Only count removed fields when the block itself is kept and grounded is an object
        if (grounded && typeof grounded === 'object' && 'opportunity' in grounded) {
            if (signal?.opportunity?.deadline && !grounded?.opportunity?.deadline) removed += 1;
            if (signal?.opportunity?.amount && !grounded?.opportunity?.amount) removed += 1;
        }
        return grounded;
    });
    if (removed > 0) {
        console.warn(`[opportunity-guard] Removed ${removed} deadline/amount field(s) not found verbatim in the analyzed batch`);
    }
    return out;
}
