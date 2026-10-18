/**
 * Retry policies referenced by agent specs.
 *
 * Named rather than inline so a spec declares intent ("network_tolerant") and the numbers
 * live in one auditable place. Versioned for the same reason prompts are: a change in
 * retry behaviour changes cost and latency, and that must be attributable.
 */

export const RETRY_POLICY_VERSION = 'v1';

export const RETRY_POLICIES = Object.freeze({
    /** Default. One retry, short backoff — enough for a blip, not enough to burn budget. */
    standard: {
        max_attempts: 2,
        backoff_ms: 1000,
        backoff_multiplier: 2,
        retry_on: ['timeout', 'network', '5xx', '429'],
    },

    /** Retrieval talks to flaky third parties; give it more rope but still bounded. */
    network_tolerant: {
        max_attempts: 3,
        backoff_ms: 2000,
        backoff_multiplier: 2,
        retry_on: ['timeout', 'network', '5xx', '429'],
    },

    /** For work that must not be repeated blindly (anything that writes a report row). */
    none: {
        max_attempts: 1,
        backoff_ms: 0,
        backoff_multiplier: 1,
        retry_on: [],
    },
});

export const getRetryPolicy = (name) => RETRY_POLICIES[name] || RETRY_POLICIES.standard;

/** Escalation behaviours a spec may declare when retries are exhausted. */
export const ESCALATIONS = Object.freeze({
    FAIL_FAST: 'fail_fast',
    DEGRADE_AND_CONTINUE: 'degrade_and_continue',
    PAUSE_FOR_HUMAN_REVIEW: 'pause_for_human_review',
    QUARANTINE_OUTPUT: 'quarantine_output',
});

const ESCALATION_VALUES = new Set(Object.values(ESCALATIONS));
export const isKnownEscalation = (e) => ESCALATION_VALUES.has(e);
