/**
 * Presentation-layer decisions about a signal that are pure enough to test.
 *
 * Lives outside the component because `addsBeyondHeadline` decides whether a founder sees
 * a sentence at all. A rule that can silently withhold evidence is exactly the kind this
 * codebase has been bitten by before, so it is a plain function with a test pinned to it
 * rather than an inline expression inside 300 lines of JSX.
 */

// Words that carry no fact. Stripped before comparing the headline to the move, so the
// comparison is about information rather than sentence construction.
const FACT_STOPWORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'at',
    'by', 'for', 'and', 'or', 'with', 'from', 'that', 'this', 'it', 'its', 'as', 'has', 'have',
    'had', 'will', 'usd', 'us', 'per', 'than', 'into', 'over', 'up', 'about', 'their', 'his',
]);

/**
 * Content tokens of a fact sentence, normalised so "$47.58B" and "USD 47.58 billion"
 * compare equal. Without the magnitude-suffix pass, the same figure written the two ways
 * the model actually writes it would look like two different facts, and the duplicate
 * check below would never fire on the case it exists for.
 */
export function factTokens(text) {
    return new Set(
        String(text || '')
            .toLowerCase()
            .replace(/[$,]/g, ' ')
            .replace(/(\d)\s*bn?\b/g, '$1 billion')
            .replace(/(\d)\s*m\b/g, '$1 million')
            .replace(/(\d)\s*k\b/g, '$1 thousand')
            .replace(/[^a-z0-9.%\s]/g, ' ')
            .split(/\s+/)
            .map(t => t.replace(/^\.+|\.+$/g, ''))
            .filter(t => t.length > 1 && !FACT_STOPWORDS.has(t))
    );
}

/** Above this share of shared content tokens, the move is the headline reworded. */
export const RESTATEMENT_OVERLAP = 0.6;

/**
 * Does the factual line say anything the headline did not?
 *
 * The model writes both, from the same evidence, and they routinely come out as one
 * sentence twice — the founder reads "$47.58B in 2026, 8.66% CAGR to 2032" as a headline
 * and then reads it again, reworded, under a "THE MOVE" label. Two paragraphs earning one
 * paragraph's information is the most expensive kind of noise in a list of twenty cards.
 *
 * The trade, stated plainly: when the move is mostly a restatement it is dropped whole,
 * including any marginal extra figure it carried. That is deliberate — a second number
 * does not earn re-reading the sentence — and the source link sits directly below either
 * way. It is conservative in the safe direction: anything genuinely different is kept.
 */
export function addsBeyondHeadline(move, headline) {
    const moveTokens = factTokens(move);
    if (moveTokens.size === 0) return false;
    const headlineTokens = factTokens(headline);
    // No headline to be redundant against — the move is all the reader has.
    if (headlineTokens.size === 0) return true;

    let shared = 0;
    for (const token of moveTokens) if (headlineTokens.has(token)) shared++;
    return shared / moveTokens.size < RESTATEMENT_OVERLAP;
}
