/**
 * Setting Bahirjee's shift.
 *
 * `cadence.js` stays PURE — it is imported by `lib/handlers/cron-runs.js`, and the
 * scheduler has no business carrying a database client. The write lives here instead.
 *
 * ── Why this module exists at all ────────────────────────────────────────────
 * `clients.auto_run_cadence` has been readable since v18 and settable by nobody. The cron
 * reads it, the CadenceBar renders it, and no code path has ever written it — which is why
 * it is NULL on every client in production, why /api/cron-runs has fired every Monday
 * since v18 and queued nothing, and why no job has ever carried job_origin='scheduled'.
 * The entire premise of an agent that works between visits has never run, for want of one
 * UPDATE.
 *
 * ── Why it goes through an RPC ───────────────────────────────────────────────
 * RLS on `clients` grants non-admins SELECT only, so a plain client-side update would
 * match zero rows and return success with empty data. And enabling a cadence spends money
 * every week while scheduled runs deliberately bypass the freemium quota
 * (cron-runs passes `reservedRun: false`), so entitlement has to be decided server-side —
 * the same rule as run tier, which is never read from a request body.
 *
 * See scripts/migrations/v35_set_client_cadence.sql.
 */

import { supabase } from '../lib/supabase.js';
import { CADENCE_DAYS } from './cadence.js';

/**
 * What a person may choose, derived from CADENCE_DAYS so the picker cannot offer a
 * cadence the scheduler does not understand.
 *
 * `off` is not in CADENCE_DAYS because it has no interval — it is the absence of one — so
 * it is appended here rather than added there, where it would have to be special-cased in
 * `isActiveCadence` and `isDue`.
 *
 * ⚠️ These literals must stay inside the v18 CHECK constraint and the v29 RPC's own
 * validation. Widen one, widen all three in the same commit.
 */
export const CADENCE_OPTIONS = [
    ...Object.keys(CADENCE_DAYS).map(value => ({
        value,
        // Second person, present tense: this is a commitment the founder is making with
        // Bahirjee, not a setting on a form.
        label: value === 'weekly' ? 'Every Monday' : 'Once a month',
        detail: value === 'weekly'
            ? 'A full read every week, plus a look every morning.'
            : 'A full read every month, plus a look every morning.',
    })),
    { value: 'off', label: 'Not right now', detail: 'Bahirjee stops reading until you ask.' },
];

/** Is this a cadence the scheduler and the CHECK constraint both accept? */
export function isSettableCadence(value) {
    return CADENCE_OPTIONS.some(o => o.value === value);
}

/**
 * Set a client's cadence.
 *
 * Returns `{ ok: true, client }` or `{ ok: false, reason, message }`. It never throws:
 * this is a control a founder clicks, and the failure that matters — "your plan does not
 * include a standing read" — is a normal answer, not an exception.
 *
 * `reason` is a code the UI can branch on; `message` is what a person reads.
 */
export async function setClientCadence(clientId, cadence) {
    if (!supabase) return { ok: false, reason: 'unavailable', message: 'Not connected.' };
    if (!clientId) return { ok: false, reason: 'no_client', message: 'No workspace to set this on.' };
    if (!isSettableCadence(cadence)) {
        return { ok: false, reason: 'invalid', message: `Unknown cadence: ${cadence}` };
    }

    try {
        const { data, error } = await supabase.rpc('set_client_cadence', {
            p_client_id: clientId,
            p_cadence: cadence,
        });
        if (error) throw error;

        // The RPC returns the row. An empty result means the function exists but wrote
        // nothing, which should be impossible — it RAISEs instead — so treat it as a
        // failure rather than reporting a success nobody made.
        const client = Array.isArray(data) ? data[0] : data;
        if (!client) {
            return { ok: false, reason: 'no_row', message: 'That did not save. Try again.' };
        }
        return { ok: true, client };
    } catch (err) {
        const raw = String(err?.message || '');

        // 42883 = function does not exist (v29 not applied). Say so plainly rather than
        // letting a missing migration read as a permissions problem — the migration window
        // is exactly when this code is most likely to run un-migrated.
        if (err?.code === '42883' || /set_client_cadence.*does not exist/i.test(raw)) {
            console.error('[cadence] v35_set_client_cadence.sql has not been applied');
            return { ok: false, reason: 'not_migrated', message: 'Scheduling is not switched on yet.' };
        }
        if (/premium workspace/i.test(raw)) {
            return {
                ok: false,
                reason: 'not_entitled',
                message: 'A standing read is part of a paid workspace.',
            };
        }
        if (/not authorised/i.test(raw)) {
            return { ok: false, reason: 'forbidden', message: 'You cannot change this workspace.' };
        }
        console.error('[cadence] set failed:', raw);
        return { ok: false, reason: 'error', message: 'That did not save. Try again.' };
    }
}
