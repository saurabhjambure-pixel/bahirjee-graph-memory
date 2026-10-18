// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DELIVERING THE MONDAY LETTER
//
// The pipeline has produced a weekly brief on a cron since v?—and nobody was ever told.
// The report was written to Postgres and waited for someone to log in. This is the step
// that makes "it speaks first" true rather than aspirational.
//
// Three rules, in order of how expensive it is to get them wrong:
//
//  1. NEVER THROW. A run that produced a good brief must not be marked failed because a
//     mail provider had a bad minute. By the time this runs the report is persisted and
//     readable in the app; the letter is delivery, not the product's only copy.
//
//  2. EXACTLY ONCE. Completion can be observed more than once — the stepped worker
//     re-triggers itself, and a job can be re-claimed after a lock expires. The guard is
//     the status transition itself (see `completeIntelligenceJob`): whoever flips the row
//     from not-completed to completed is the single winner, and only the winner sends.
//     A "have we sent this yet?" column would be a second source of truth racing the first.
//
//  3. A LINK IS A POINTER, NEVER A CREDENTIAL. The letter's evidence link goes to an
//     authenticated route. Possessing it must not be permission to read the brief —
//     forwarded mail is the most ordinary way a link escapes its intended reader.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { sendMail, isMailConfigured } from './_mail.js';
import { absoluteUrl } from './_siteUrl.js';
import { buildLetter } from '../src/services/letterService.js';

/** Hard ceiling on recipients per report. A workspace is a team, not a mailing list. */
const MAX_RECIPIENTS = 25;

/** Off by default is wrong for a launch feature; explicitly '0' disables it. */
function lettersEnabled() {
    return process.env.LETTER_ENABLED !== '0';
}

/**
 * Postgres rejecting a column that a pending migration would add.
 *
 * 42703 is "undefined_column"; PostgREST also reports schema-cache misses as PGRST204.
 * Mirrors the tolerance `saveReport` has always had for its own later-migration columns.
 */
function isMissingColumn(error) {
    return error?.code === '42703'
        || error?.code === 'PGRST204'
        || /column .* does not exist/i.test(error?.message || '');
}

/**
 * Who should receive this report's letter.
 *
 * Active members of the report's client, minus anyone who opted out. Emails live on
 * `auth.users`, not on `profiles`, so each address costs one admin lookup — fine at a
 * workspace's size, and cheaper than denormalising an email column that would then need
 * to be kept in step with auth.
 */
async function resolveRecipients(supabaseAdmin, clientId) {
    const base = 'id, full_name, is_active';

    // v27 adds profiles.letter_opt_out. Selecting a column that does not exist fails the
    // whole query, so the un-migrated case falls back rather than returning nobody — but
    // it says so loudly, because here "degraded" means someone who opted out gets a letter.
    let rows = null;
    const withOptOut = await supabaseAdmin
        .from('profiles')
        .select(`${base}, letter_opt_out`)
        .eq('client_id', clientId)
        .eq('is_active', true);

    if (withOptOut.error && isMissingColumn(withOptOut.error)) {
        console.warn(
            '[letter] profiles.letter_opt_out is missing — run scripts/migrations/v33_letter_opt_out.sql. ' +
            'Until then opt-outs CANNOT be honoured and every active member will be written to.'
        );
        const fallback = await supabaseAdmin
            .from('profiles')
            .select(base)
            .eq('client_id', clientId)
            .eq('is_active', true);
        if (fallback.error) throw fallback.error;
        rows = fallback.data || [];
    } else if (withOptOut.error) {
        throw withOptOut.error;
    } else {
        rows = (withOptOut.data || []).filter(p => !p.letter_opt_out);
    }

    const recipients = [];
    for (const profile of rows.slice(0, MAX_RECIPIENTS)) {
        const { data, error } = await supabaseAdmin.auth.admin.getUserById(profile.id);
        if (error || !data?.user?.email) continue;
        recipients.push({ id: profile.id, email: data.user.email, name: profile.full_name || '' });
    }
    return recipients;
}

/**
 * Send the letter for a freshly completed run.
 *
 * @param {object} supabaseAdmin  Service-role client.
 * @param {{clientId: string, reportId: string}} args
 * @returns {Promise<{sent: boolean, reason?: string, delivered?: number}>} Never rejects.
 */
export async function deliverLetterForReport(supabaseAdmin, { clientId, reportId } = {}) {
    try {
        if (!lettersEnabled()) return { sent: false, reason: 'disabled' };
        if (!reportId || !clientId) return { sent: false, reason: 'missing_ids' };

        // Checked before the report is loaded and the letter rendered: doing that work for
        // a deployment that cannot post it wastes the effort and, worse, hides the
        // misconfiguration behind a code path that looks like it succeeded.
        if (!isMailConfigured()) return { sent: false, reason: 'no_provider' };

        const { data: report, error } = await supabaseAdmin
            .from('reports')
            .select('id, brief, signals, context, created_at, share_token')
            .eq('id', reportId)
            .single();
        if (error) throw error;

        const recipients = await resolveRecipients(supabaseAdmin, clientId);
        if (!recipients.length) return { sent: false, reason: 'no_recipients' };

        // An authenticated route, not the share token. The token identifies WHICH brief;
        // the viewer's identity decides WHETHER they may read it, and that decision cannot
        // be delegated to whoever is holding the email.
        const evidenceUrl = absoluteUrl(`/report-by-id/${report.id}`);

        let delivered = 0;
        for (const recipient of recipients) {
            const letter = buildLetter({
                report,
                context: report.context,
                recipient,
                evidenceUrl,
                unsubscribeUrl: absoluteUrl(`/letters/off?u=${encodeURIComponent(recipient.id)}`),
            });

            // A run that found nothing produces no claim. Saying "nothing moved" once is
            // honest; saying it every Monday is how a weekly letter teaches people to
            // ignore it, and the silence is itself accurate.
            if (!letter.hasClaim && letter.movementCount === 0) {
                return { sent: false, reason: 'nothing_to_report' };
            }

            const result = await sendMail({
                to: recipient.email,
                subject: letter.subject,
                html: letter.html,
                text: letter.text,
                tags: { kind: 'weekly_letter', report: String(report.id).slice(0, 8) },
            });
            if (result.sent) delivered += 1;
        }

        return delivered > 0
            ? { sent: true, delivered }
            : { sent: false, reason: 'all_sends_failed' };
    } catch (err) {
        // The brief is already persisted and readable. Losing the letter is a bad week;
        // failing the job would discard a run that actually succeeded.
        console.error(`[letter] Delivery failed for report ${reportId}: ${err?.message || err}`);
        return { sent: false, reason: 'error' };
    }
}
