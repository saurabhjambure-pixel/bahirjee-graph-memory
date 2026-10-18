// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OUTBOUND MAIL
//
// Until this file existed, nothing in the product could put anything in anyone's inbox.
// `lib/handlers/auth-link.js` sends sign-in links through `supabase.auth.signInWithOtp`,
// which renders Supabase's own auth templates — it cannot carry a brief.
//
// Two rules, both borrowed from the connector gateway:
//
//   1. A missing key SELF-DISABLES and is disclosed. It never throws, and it never
//      pretends the mail went out. Callers get `{ sent: false, reason }` and can say so.
//   2. It never throws into the pipeline. A run that produced a good brief must not be
//      marked failed because a mail provider had a bad minute — the brief is already
//      persisted and readable in the app by then.
//
// Provider is Resend over plain fetch. No SDK: the request is four fields, and a
// dependency here would be the only one in the repo that exists to format JSON.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = Number(process.env.MAIL_TIMEOUT_MS || 15000);

// Disclosure is once per process, not once per recipient. A cron firing for forty clients
// with no key configured should say so once, not forty times.
let disclosedMissingProvider = false;

function readConfig() {
    return {
        apiKey: process.env.RESEND_API_KEY || '',
        from: process.env.MAIL_FROM || '',
        replyTo: process.env.MAIL_REPLY_TO || '',
    };
}

/**
 * Can this deployment send mail at all?
 *
 * Exported so callers can decide BEFORE doing expensive work — rendering a letter for a
 * deployment that cannot post it is wasted effort, and worse, it hides the misconfiguration
 * behind a success path.
 */
export function isMailConfigured() {
    const { apiKey, from } = readConfig();
    return Boolean(apiKey && from);
}

function discloseMissingProvider(reason) {
    if (disclosedMissingProvider) return;
    disclosedMissingProvider = true;
    console.warn(
        `[mail] Outbound mail is DISABLED (${reason}). ` +
        'Set RESEND_API_KEY and MAIL_FROM to enable it. No mail will be sent until then.'
    );
}

/** Normalise to a list of plausible addresses; anything unparseable is dropped, not guessed. */
function normaliseRecipients(to) {
    const list = Array.isArray(to) ? to : [to];
    return [...new Set(
        list
            .map(v => String(v || '').trim().toLowerCase())
            .filter(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
    )];
}

/**
 * Send one message.
 *
 * @returns {Promise<{sent: boolean, reason?: string, id?: string, recipients?: number}>}
 *          Never rejects. `sent: false` always carries a `reason` a caller can log or show.
 */
export async function sendMail({ to, subject, html, text, tags = {} } = {}) {
    const { apiKey, from, replyTo } = readConfig();

    if (!apiKey || !from) {
        discloseMissingProvider(!apiKey ? 'no RESEND_API_KEY' : 'no MAIL_FROM');
        return { sent: false, reason: 'no_provider' };
    }

    const recipients = normaliseRecipients(to);
    if (!recipients.length) return { sent: false, reason: 'no_recipients' };
    if (!subject || !String(subject).trim()) return { sent: false, reason: 'no_subject' };
    if (!html && !text) return { sent: false, reason: 'no_body' };

    // Both parts always ship. A plain-text alternative is not politeness — a mail with only
    // an HTML part scores worse with spam filters, and this is a new sending domain.
    const payload = {
        from,
        to: recipients,
        subject: String(subject).slice(0, 200),
        ...(html ? { html } : {}),
        ...(text ? { text } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
        // Resend tag values are restricted to ASCII letters, digits, _ and -.
        ...(Object.keys(tags).length
            ? {
                tags: Object.entries(tags)
                    .map(([name, value]) => ({
                        name: String(name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40),
                        value: String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60),
                    }))
                    .filter(t => t.name && t.value)
                    .slice(0, 10),
            }
            : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

    try {
        const response = await fetch(RESEND_ENDPOINT, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        if (!response.ok) {
            // Read the body for the reason, but never let a malformed error body become the
            // thing that throws.
            let detail = '';
            try { detail = (await response.text()).slice(0, 300); } catch { /* ignore */ }
            console.error(`[mail] Provider rejected send (${response.status}): ${detail}`);
            return { sent: false, reason: `provider_${response.status}` };
        }

        const body = await response.json().catch(() => ({}));
        return { sent: true, id: body?.id || null, recipients: recipients.length };
    } catch (error) {
        const reason = error?.name === 'AbortError' ? 'timeout' : 'network_error';
        console.error(`[mail] Send failed (${reason}): ${error?.message || error}`);
        return { sent: false, reason };
    } finally {
        clearTimeout(timer);
    }
}

/** Test seam: lets a suite assert the once-per-process disclosure more than once. */
export function __resetMailDisclosureForTests() {
    disclosedMissingProvider = false;
}
