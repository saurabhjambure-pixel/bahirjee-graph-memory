/**
 * Bahirjee's shift.
 *
 * An agent that is invisible between runs is a cron job. This module owns the answers to
 * two of the seven questions a colleague can always answer — *when did you last work?* and
 * *when will you work next?* — and it owns them in one place because they were previously
 * spread across three that could not see each other:
 *
 *   - the cadence maths lived in `lib/handlers/cron-runs.js` (server only)
 *   - the firing schedule lived in `vercel.json` (config only)
 *   - the founder-facing answer lived nowhere at all
 *
 * `auto_run_cadence` has been an admin column since v18: the shift exists, and the person
 * it serves could not see it. Telling someone "I check every Monday at six" is the
 * difference between a scheduled job and a colleague.
 */

/** Days between runs, per cadence. The scheduler and the UI must agree on this. */
export const CADENCE_DAYS = { weekly: 7, monthly: 30 };

/**
 * When the scheduler actually fires, as UTC.
 *
 * ⚠️ MUST match the `crons` entry in vercel.json (`0 6 * * 1`). A mismatch does not throw;
 * it makes Bahirjee promise a time it does not keep, which is a small lie told weekly.
 * `scripts/cadence.test.mjs` reads vercel.json and fails if these drift, because a comment
 * asking a future editor to keep two files in sync is not a mechanism.
 */
export const SCHEDULE = { dayOfWeek: 1, hourUtc: 6 }; // Monday 06:00 UTC

/** Is a cadence one that actually runs? */
export function isActiveCadence(cadence) {
    return Boolean(cadence) && cadence !== 'off' && Boolean(CADENCE_DAYS[cadence]);
}

/**
 * Is this client due for a scheduled run?
 *
 * Moved here from cron-runs.js so the UI can say "due now" with the same arithmetic the
 * scheduler uses, rather than an approximation of it.
 */
export function isDue(client, now = Date.now()) {
    const cadence = client?.auto_run_cadence;
    if (!isActiveCadence(cadence)) return false;

    // Never queued before — due immediately.
    if (!client.auto_run_last_queued_at) return true;

    const last = new Date(client.auto_run_last_queued_at).getTime();
    if (!Number.isFinite(last)) return true;

    return now - last >= CADENCE_DAYS[cadence] * 24 * 60 * 60 * 1000;
}

/**
 * The next moment Bahirjee will actually read, or null when no cadence is set.
 *
 * Not simply "last queued + N days": the scheduler only fires on its cron tick, so a run
 * that becomes due on a Wednesday is picked up the following Monday. Returning the due
 * date would promise a read three days before one can happen.
 *
 * @returns {Date|null}
 */
export function nextScheduledRead(client, now = new Date()) {
    const cadence = client?.auto_run_cadence;
    if (!isActiveCadence(cadence)) return null;

    const from = now instanceof Date ? now : new Date(now);
    const last = client?.auto_run_last_queued_at ? new Date(client.auto_run_last_queued_at) : null;

    // Earliest moment the run is allowed: now if never queued or already overdue.
    const dueAt = last && Number.isFinite(last.getTime())
        ? new Date(last.getTime() + CADENCE_DAYS[cadence] * 24 * 60 * 60 * 1000)
        : from;

    return nextTickOnOrAfter(dueAt > from ? dueAt : from);
}

/** The first scheduler tick at or after `moment`. */
function nextTickOnOrAfter(moment) {
    const tick = new Date(Date.UTC(
        moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate(), SCHEDULE.hourUtc, 0, 0, 0
    ));
    // Walk forward to the scheduled weekday; if today IS that weekday but the hour has
    // passed, this still lands on next week because the += 7 below catches the equal case.
    const daysAhead = (SCHEDULE.dayOfWeek - tick.getUTCDay() + 7) % 7;
    tick.setUTCDate(tick.getUTCDate() + daysAhead);
    if (tick < moment) tick.setUTCDate(tick.getUTCDate() + 7);
    return tick;
}

/**
 * How Bahirjee describes its own shift, in the third person.
 *
 * The interface refers to Bahirjee in the third person; Bahirjee itself speaks in the
 * first. This is chrome, so: "Bahirjee reads every Monday", not "I read every Monday".
 */
export function describeCadence(cadence) {
    if (!isActiveCadence(cadence)) return 'Not watching yet';
    return cadence === 'weekly' ? 'Reads every Monday' : 'Reads monthly';
}

/** "2 days ago", "today", "in 3 days" — relative time a person would actually say. */
export function relativeDays(date, now = new Date()) {
    if (!date) return null;
    const then = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(then.getTime())) return null;

    const startOf = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const days = Math.round((startOf(then) - startOf(now)) / 86400000);

    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days === -1) return 'yesterday';
    return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}
