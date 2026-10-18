// Maps raw Postgres/PostgREST/Supabase error text into a message safe to show founders —
// hides schema/constraint names (info leak) and replaces jargon with something actionable.
// Messages we already write by hand (e.g. "Your organization could not be found…") pass
// through unchanged; only text that looks like a raw DB/driver error gets rewritten.

const RULES = [
    {
        test: /violates foreign key constraint.*client_id/i,
        friendly: "Your account isn't linked to a valid organization. Please sign out and back in — if that doesn't fix it, contact support."
    },
    {
        test: /violates foreign key constraint/i,
        friendly: "We couldn't complete that because of a data reference issue. Please retry — if it persists, contact support."
    },
    {
        test: /could not find the .* column .* schema cache/i,
        friendly: "Something went wrong on our end while saving your analysis. Please retry — if this keeps happening, contact support."
    },
    {
        test: /violates row-level security policy/i,
        friendly: "You don't have permission to do that."
    },
    {
        test: /duplicate key value violates unique constraint/i,
        friendly: "That already exists — please refresh and try again."
    },
    {
        test: /JWT expired|invalid JWT|invalid access token/i,
        friendly: "Your session expired. Please sign in again."
    },
    {
        test: /permission denied for/i,
        friendly: "You don't have permission to do that."
    },
    {
        test: /relation ".*" does not exist/i,
        friendly: "Something went wrong on our end. Please retry — if this keeps happening, contact support."
    },
    {
        // The pre-publish verification gate refused the run. Worth its own message rather
        // than the generic one below: nothing was saved, and a retry is genuinely the right
        // advice — the gate judges a single run's evidence, not the account or the company.
        test: /refusing to persist|verification verdict|verifier gate/i,
        friendly: "We couldn't publish this brief — its findings didn't clear our verification check, so nothing was saved. Please run the analysis again; if it keeps happening, contact support."
    },
    {
        // The run completed but the save returned nothing. Same founder-visible outcome as
        // the refusal above — work happened, no brief exists to open — so it gets the same
        // shape of message rather than the generic one.
        test: /no persisted report id|report id was returned/i,
        friendly: "Your analysis ran, but the brief couldn't be saved. Please run it again — if it keeps happening, contact support."
    }
];

// Generic fallback: text that "looks like" a raw DB/driver error (quoted identifiers,
// SQL/Postgres jargon) but didn't match a specific rule above.
const LOOKS_TECHNICAL = /violates|constraint|schema cache|PGRST\d|relation ".*"|column ".*"|syntax error at or near/i;

// ── Internal engineering copy ────────────────────────────────────────────────
// The errors WE throw are hand-authored, so they sail past the DB rules above and land on
// the human-authored passthrough at the bottom of getFriendlyError() — which showed them to
// founders verbatim. Hand-authored is not the same as founder-facing. One real run put a
// pipeline step name, an internal invariant and an env var on a founder's screen:
//
//   "Refusing to persist: no verification verdict for this run. The `verify` step must run
//    before `persist` (set VERIFIER_MODE=off to publish without the gate deliberately)."
//
// It is not a one-off: the pipeline throws provider names, HTTP statuses, retry counts and
// even a 200-character dump of an unparseable LLM response (lib/_llmUtils.js), all of which
// reach this function on the way to a founder. The markers below are the vocabulary of those
// messages; none of them appears in copy written FOR founders.
//
// Nothing is hidden by this — the raw text is still returned as `technical`, so it keeps
// going to the console and the collapsed "Technical details" panel. It just stops being the
// headline on the error screen.
const LOOKS_INTERNAL = new RegExp([
    '`[^`]+`',                                     // backticked identifiers: `verify`, `persist`
    '\\b[A-Z][A-Z0-9_]{3,}=',                      // env-var directives: VERIFIER_MODE=off
    '\\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\\b',      // bare env-var names: SUPABASE_SERVICE_ROLE_KEY
    '\\b(?:pipeline|checkpoint|serverless|payload|env var|cursor|re-trigger|circuit breaker)\\b',
    '\\b(?:Gemini|Claude|Exa|Tavily|Groq|Sarvam|Supabase|Upstash|Parallel AI)\\b',
    '\\b(?:LLM|JSON|API key|handler|embedding)\\b',
    '\\b(?:persist|persisted|persistence)\\b',     // a founder never sees the word "persist"
    '\\bstep "[^"]*"',                             // Step "analyze" deferred without…
    '\\bPreview:',                                 // …a 200-char dump of a bad LLM response
    // A bare 4xx/5xx anywhere in the text. Deliberately loose: a founder-facing sentence has
    // no reason to carry an HTTP status, and erring toward the generic message is the safe
    // direction — the exact text is still one click away under "Technical details".
    '\\b[45]\\d{2}\\b',
].join('|'), 'i');

// Uncaught JS exceptions, which reach here through ErrorBoundary. A founder should never be
// shown a stack-adjacent message, and these are never actionable for them.
const LOOKS_LIKE_JS_ERROR = /\b(?:TypeError|ReferenceError|SyntaxError|RangeError):|is not a function|Cannot read propert|undefined is not an?/i;

export function getFriendlyError(rawMessage) {
    const raw = String(rawMessage || '').trim();
    if (!raw) {
        return { friendly: 'Something went wrong. Please try again.', technical: null };
    }

    for (const rule of RULES) {
        if (rule.test.test(raw)) {
            return { friendly: rule.friendly, technical: raw };
        }
    }

    if (LOOKS_TECHNICAL.test(raw) || LOOKS_INTERNAL.test(raw) || LOOKS_LIKE_JS_ERROR.test(raw)) {
        return {
            friendly: 'Something unexpected happened on our end. Please retry — if this keeps happening, contact support.',
            technical: raw
        };
    }

    // Already a message written FOR a founder — show as-is.
    //
    // This stays a passthrough rather than a deny-by-default, because the callers pass raw
    // `error.message` from Supabase auth and our own services, and several of those are
    // deliberately founder-facing sentences with nothing to allowlist them by. The residual
    // risk is a NEW internal error phrased in plain English with none of the markers above;
    // scripts/error-messages.test.mjs pins the real corpus so that shows up as a test failure
    // rather than on a founder's screen.
    return { friendly: raw, technical: null };
}
