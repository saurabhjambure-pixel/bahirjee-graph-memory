/**
 * The Monday Letter.
 *
 * This is the product. Not a notification, not a digest — a letter: second person, signed,
 * arriving at the same hour every week. The app is the evidence room you visit when a line
 * in it surprises you.
 *
 * ── Why a pure function ──────────────────────────────────────────────────────
 * No network, no LLM, no database. Everything here is a transformation of a brief that has
 * already been persisted and already passed the pipeline's guards. Pure means the letter
 * is testable, and testable is the only thing that keeps it honest — including the advice
 * audit, which has to be able to run over the finished text.
 *
 * ── Voice ────────────────────────────────────────────────────────────────────
 * Bahirjee speaks in the FIRST person here. The interface describes Bahirjee in the third
 * ("Bahirjee last read on Monday"), but a letter is Bahirjee talking, so it is "I read 47
 * pages this week". That distinction is the whole reason this reads as correspondence from
 * a colleague rather than as a system export.
 *
 * ── Email rendering constraints, which are not stylistic preferences ─────────
 *   - Tables, not flexbox or grid. Outlook renders neither.
 *   - Inline styles. Most clients strip <style> blocks.
 *   - No web fonts. They do not load; Georgia is on every platform that matters and is
 *     the serif that carries the judgment voice.
 *   - Both a text/plain and a text/html part, generated from the same data so they cannot
 *     disagree. An HTML-only mail also scores worse with spam filters, which matters on a
 *     new sending domain.
 */

import { selectClaimAndMovements } from './briefSchema.js';
import { buildRecognitionLine } from './recognition.js';
import { sourceClassProvenance } from './sourceClass.js';

const SUBJECT_MAX = 78;

/** The refusal, said out loud. See the advice guard in briefSchema.js. */
export const REFUSAL_LINE = 'Nothing here says what you should do. That is still your call.';

// ── Palette ─────────────────────────────────────────────────────────────────
// Fixed hexes rather than CSS variables: mail clients do not resolve custom properties.
// These are the product's tokens transcribed, and must be changed together with them.
const C = {
    ground: '#f4f3f0',
    surface: '#ffffff',
    ink: '#12161a',
    body: '#33393d',
    muted: '#626a70',
    faint: '#878e93',
    rule: '#e4e2dd',
    accent: '#1a6b4a',
    accentSoft: '#e6f0ea',
    amber: '#8a6212',
};

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

/** Escape for HTML text nodes and attribute values alike. */
function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** "8 September" — the week the letter covers, in the reader's plain register. */
function formatWeekOf(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}

/** "2 Sep" — compact, for a source line. */
function formatShortDate(value) {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * One movement's source line, in Bahirjee's voice: where, when, and how it was known.
 *
 * Every part is optional and each is omitted rather than guessed. A movement whose date
 * the pipeline could not verify simply has no date here — an invented date in a letter
 * reads as breaking news, which is the most expensive kind of wrong.
 */
function sourceLine(movement) {
    const parts = [];
    if (movement.host) parts.push(movement.host);
    const date = formatShortDate(movement.date);
    if (date) parts.push(date);

    const provenance = sourceClassProvenance(movement.source_class);
    if (provenance) parts.push(`I read it ${provenance}`);

    if (movement.corroboration > 0) {
        parts.push(movement.corroboration === 1
            ? '1 other source agrees'
            : `${movement.corroboration} other sources agree`);
    } else if (movement.needs_caveat) {
        // Said in words, not as a badge. A caveat the reader has to decode is not a caveat.
        parts.push('one source only — I have not confirmed this elsewhere');
    }

    return parts.join(' · ');
}

/**
 * What would raise the confidence, phrased as something Bahirjee is doing about it.
 *
 * `calibrateConfidence` already computes why a level was reached and what capped it; this
 * turns that arithmetic into the sentence that makes uncertainty a reason to stay rather
 * than a disclaimer to skim.
 */
function confidenceNextStep(confidence) {
    const level = confidence?.level || 'Low';
    if (level === 'High') return 'I am watching for anything that would weaken this.';
    if (confidence?.depth === 'shallow') {
        return 'This was a shallow scan. A full run reads more of the record and can reach a higher confidence than I can claim here.';
    }
    if (Array.isArray(confidence?.capped_by) && confidence.capped_by.length) {
        return 'I held this below where the volume of evidence alone would put it, because unresolved checks remain. I am watching for what settles them.';
    }
    return level === 'Low'
        ? 'This rises as more independent sources confirm it. I am watching for them.'
        : 'This becomes High when more independent sources confirm it. I am watching for them.';
}

/**
 * Proof of work.
 *
 * Only what is actually known. `calibrateConfidence` counted the sourced findings and the
 * distinct domains behind them, so those are real; pages read and pages unchanged come
 * from run telemetry the report does not yet carry, and are therefore not claimed here.
 * A footer that inflates the work is the one place a trust-first product cannot afford to
 * round up.
 */
function proofOfWork(confidence, signalCount) {
    const parts = [];
    const findings = confidence?.evidence_count ?? signalCount ?? 0;
    const domains = confidence?.unique_domains ?? 0;
    if (findings) {
        parts.push(`I traced ${findings} finding${findings === 1 ? '' : 's'} to a source this week`);
        if (domains) parts.push(`across ${domains} domain${domains === 1 ? '' : 's'}`);
    }
    return parts.length ? `${parts.join(' ')}.` : '';
}

/** Subject: the claim itself, trimmed at a word boundary. Never a generic label. */
function buildSubject(claim) {
    const text = String(claim || '').replace(/\s+/g, ' ').trim();
    if (!text) return 'Nothing moved in your market this week';
    if (text.length <= SUBJECT_MAX) return text;
    const cut = text.slice(0, SUBJECT_MAX);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:]$/, '')}…`;
}

/**
 * Render one letter.
 *
 * @param {object}  args
 * @param {object}  args.report     A persisted report: { brief, signals, context, created_at }.
 * @param {object} [args.context]   Company context; falls back to report.context.
 * @param {object} [args.recipient] { name } — used for the salutation only.
 * @param {string} [args.evidenceUrl]  Authenticated deep link. NOT a share token: a URL is
 *                                     a pointer, never a credential.
 * @param {string} [args.unsubscribeUrl]
 * @returns {{subject: string, html: string, text: string, movementCount: number, hasClaim: boolean}}
 */
export function buildLetter({ report, context, recipient, evidenceUrl, unsubscribeUrl } = {}) {
    const brief = report?.brief && typeof report.brief === 'object' ? report.brief : {};
    const signals = Array.isArray(report?.signals) ? report.signals : [];
    const ctx = context || report?.context || {};

    const { claim, movements, total } = selectClaimAndMovements(brief, signals);
    const recognition = buildRecognitionLine(ctx);
    const confidence = brief.confidence || {};
    const weekOf = formatWeekOf(report?.created_at);
    const firstName = String(recipient?.name || '').trim().split(/\s+/)[0] || '';
    const remaining = Math.max(0, total - movements.length);

    return {
        subject: buildSubject(claim),
        html: renderHtml({ claim, movements, recognition, confidence, weekOf, firstName, remaining, evidenceUrl, unsubscribeUrl, signals }),
        text: renderText({ claim, movements, recognition, confidence, weekOf, firstName, remaining, evidenceUrl, unsubscribeUrl, signals }),
        movementCount: movements.length,
        hasClaim: Boolean(claim),

        // ── What the advice guard must actually inspect ──────────────────────
        // Every string in the letter that came from the pipeline rather than from this
        // file. Auditing the rendered letter instead would always fail: the refusal line
        // contains the words "you should" by design ("Nothing here says what you SHOULD
        // do"), and so would match the guard that exists to catch the model saying it.
        //
        // Collecting the variable content here excludes the fixed copy BY CONSTRUCTION
        // rather than by subtracting known strings afterwards — a subtraction would go
        // stale the first time someone reworded the boilerplate, and would fail open.
        auditText: [
            claim,
            recognition,
            ...movements.map(m => m.text),
            confidence.basis,
        ].filter(Boolean).join('\n'),
    };
}

// ── text/plain ──────────────────────────────────────────────────────────────

function renderText({ claim, movements, recognition, confidence, weekOf, firstName, remaining, evidenceUrl, unsubscribeUrl, signals }) {
    const lines = [];
    if (weekOf) lines.push(`Week of ${weekOf}`, '');
    if (firstName) lines.push(`${firstName},`, '');
    if (claim) lines.push(claim, '');
    if (recognition) lines.push(recognition, '');

    movements.forEach((m, i) => {
        lines.push(`${i + 1}. ${m.text}`);
        const source = sourceLine(m);
        if (source) lines.push(`   ${source}`);
        if (m.url) lines.push(`   ${m.url}`);
        lines.push('');
    });

    if (confidence.level) {
        lines.push(`Confidence: ${confidence.level}.`);
        if (confidence.basis) lines.push(confidence.basis);
        lines.push(confidenceNextStep(confidence), '');
    }

    lines.push(REFUSAL_LINE, '');
    if (remaining > 0) lines.push(`I saw ${remaining} other thing${remaining === 1 ? '' : 's'} this week that did not clear the bar.`);
    if (evidenceUrl) lines.push(`See the evidence: ${evidenceUrl}`);
    lines.push('');

    const proof = proofOfWork(confidence, signals.length);
    if (proof) lines.push(proof);
    lines.push('— Bahirjee');
    if (unsubscribeUrl) lines.push('', `Stop these letters: ${unsubscribeUrl}`);

    return lines.join('\n');
}

// ── text/html ───────────────────────────────────────────────────────────────

/** One full-width row of the letter's single-column table. */
function row(content, { padTop = 0, padBottom = 0 } = {}) {
    return `<tr><td style="padding:${padTop}px 28px ${padBottom}px 28px;">${content}</td></tr>`;
}

function renderMovementHtml(movement, isLast) {
    const source = sourceLine(movement);
    const border = isLast ? '' : `border-bottom:1px solid ${C.rule};`;
    const headingText = movement.url
        ? `<a href="${esc(movement.url)}" style="color:${C.ink};text-decoration:none;">${esc(movement.text)}</a>`
        : esc(movement.text);

    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${border}">
      <tr><td style="padding:14px 0 14px 0;">
        <div style="font-family:${SANS};font-size:15px;font-weight:600;line-height:1.36;color:${C.ink};">${headingText}</div>
        ${source ? `<div style="font-family:${SANS};font-size:12px;line-height:1.5;color:${movement.needs_caveat ? C.amber : C.faint};padding-top:5px;">${esc(source)}</div>` : ''}
      </td></tr>
    </table>`;
}

function renderHtml({ claim, movements, recognition, confidence, weekOf, firstName, remaining, evidenceUrl, unsubscribeUrl, signals }) {
    const proof = proofOfWork(confidence, signals.length);

    const movementsHtml = movements
        .map((m, i) => renderMovementHtml(m, i === movements.length - 1))
        .join('');

    const confidenceBlock = confidence.level
        ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.accentSoft};border-radius:6px;">
        <tr><td style="padding:14px 16px;font-family:${SANS};font-size:13px;line-height:1.55;color:#1c4f39;">
          <strong style="font-weight:600;">Confidence: ${esc(confidence.level)}.</strong>
          ${confidence.basis ? ` ${esc(confidence.basis)}` : ''}
          <span style="display:block;padding-top:6px;">${esc(confidenceNextStep(confidence))}</span>
        </td></tr>
      </table>`
        : '';

    const actions = [
        evidenceUrl
            ? `<a href="${esc(evidenceUrl)}" style="display:inline-block;background:${C.ink};color:#ffffff;font-family:${SANS};font-size:13px;font-weight:500;text-decoration:none;padding:10px 16px;border-radius:5px;">See the evidence</a>`
            : '',
    ].filter(Boolean).join('&nbsp;&nbsp;');

    // preheader: the grey line a client previews next to the subject. Repeating the
    // subject there wastes the one extra sentence the reader sees before opening.
    const preheader = recognition || claim || '';

    return `<!-- Bahirjee weekly letter -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.ground};margin:0;padding:0;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${C.surface};border:1px solid ${C.rule};border-radius:8px;">

      ${row(`<div style="font-family:${SANS};font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:${C.accent};font-weight:600;">${weekOf ? `Week of ${esc(weekOf)}` : 'This week'}</div>`, { padTop: 24, padBottom: 0 })}

      ${firstName ? row(`<div style="font-family:${SERIF};font-size:16px;color:${C.body};padding-top:16px;">${esc(firstName)},</div>`) : ''}

      ${claim ? row(`<div style="font-family:${SERIF};font-size:20px;line-height:1.34;font-weight:500;color:${C.ink};padding-top:14px;">${esc(claim)}</div>`) : ''}

      ${recognition ? row(`<div style="font-family:${SERIF};font-size:15px;line-height:1.6;color:${C.body};padding-top:12px;">${esc(recognition)}</div>`) : ''}

      ${movementsHtml ? row(`<div style="padding-top:18px;border-top:1px solid ${C.rule};margin-top:18px;"></div>${movementsHtml}`) : ''}

      ${confidenceBlock ? row(confidenceBlock, { padTop: 8 }) : ''}

      ${row(`<div style="font-family:${SERIF};font-size:15px;font-style:italic;line-height:1.55;color:${C.muted};padding-top:18px;">${esc(REFUSAL_LINE)}</div>`)}

      ${actions ? row(`<div style="padding-top:18px;">${actions}</div>`) : ''}

      ${remaining > 0 ? row(`<div style="font-family:${SANS};font-size:12px;line-height:1.5;color:${C.faint};padding-top:14px;">I saw ${remaining} other thing${remaining === 1 ? '' : 's'} this week that did not clear the bar.</div>`) : ''}

      ${row(`<div style="padding-top:22px;"></div>`, { padBottom: 0 })}

      <tr><td style="padding:16px 28px 20px 28px;background:${C.ground};border-top:1px solid ${C.rule};border-radius:0 0 8px 8px;">
        ${proof ? `<div style="font-family:${SANS};font-size:11px;line-height:1.6;color:${C.faint};">${esc(proof)}</div>` : ''}
        <div style="font-family:${SERIF};font-size:14px;color:${C.muted};padding-top:8px;">— Bahirjee</div>
        ${unsubscribeUrl ? `<div style="font-family:${SANS};font-size:11px;padding-top:10px;"><a href="${esc(unsubscribeUrl)}" style="color:${C.faint};">Stop these letters</a></div>` : ''}
      </td></tr>

    </table>
  </td></tr>
</table>`;
}
