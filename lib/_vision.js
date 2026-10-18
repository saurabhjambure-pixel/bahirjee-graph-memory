// Vision-based page recovery for scanned / image-only document pages.
//
// LiteParse ships no tessdata, so local Tesseract OCR cannot run on Vercel. Instead the
// upload handler detects text-sparse pages via LiteParse's complexity signals, renders
// them to PNG, and hands them here for Claude to read back as markdown.
//
// This is a direct Anthropic call rather than a new action on lib/handlers/claude.js:
// both live inside the same function bundle, so routing through the gateway would mean
// the upload handler HTTP-calling its own deployment with a forwarded bearer token —
// an extra hop and an extra failure mode for no benefit. The retry/timeout plumbing is
// still shared, imported from _llmUtils.js.

import { fetchWithTimeout, ModelFailureTracker, buildModelList } from './_llmUtils.js';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Haiku reads slide text accurately and cheaply; Sonnet is the fallback when Haiku is
// blocked or erroring, not a per-page quality escalation (that would double the cost of
// every scanned deck for marginal gain on what is mostly large-format slide text).
const VISION_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'];

const IMAGES_PER_REQUEST = 8;
const MAX_REQUESTS = 2;

// Anthropic rejects images above ~5MB base64. LiteParse renders at the DPI we ask for,
// but a dense page can still exceed this; such pages are skipped rather than failing
// the batch.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const modelTracker = new ModelFailureTracker();

const PROMPT = `You are transcribing pages of a business document that could not be read by a text parser (they are scans or image-only slides).

For EACH image, in order, transcribe all visible text as clean markdown:
- Preserve headings, bullet lists, and tables (use markdown table syntax).
- Transcribe numbers, labels, and axis values in charts. Describe the chart type and what it shows in one line.
- Do NOT summarise, interpret, or add commentary. Transcribe only.
- If a page is genuinely blank or illegible, output exactly: [unreadable]

Separate each page with a line containing only "---PAGE---". Output exactly one section per image, in the order supplied. No preamble.`;

/**
 * How many pages this module is willing to recover in one upload.
 * Tunable per-deployment: scanned decks are the expensive case.
 */
export function visionPageCap() {
    const raw = Number(process.env.UPLOAD_VISION_PAGE_CAP);
    if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
    return IMAGES_PER_REQUEST * MAX_REQUESTS;
}

export function isVisionAvailable() {
    return Boolean(process.env.CLAUDE_API_KEY);
}

function detectMediaType(buffer) {
    if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
    if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
    if (buffer.length > 12 && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    return 'image/png';
}

async function callVisionBatch(images, timeoutMs) {
    const models = buildModelList('CLAUDE_VISION_MODEL', VISION_MODELS);
    let lastErr;

    for (const model of models) {
        if (modelTracker.isBlocked(model)) continue;

        const content = [];
        images.forEach((buf, i) => {
            content.push({ type: 'text', text: `Image ${i + 1}:` });
            content.push({
                type: 'image',
                source: { type: 'base64', media_type: detectMediaType(buf), data: buf.toString('base64') },
            });
        });
        content.push({ type: 'text', text: PROMPT });

        try {
            const response = await fetchWithTimeout(
                CLAUDE_API_URL,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': process.env.CLAUDE_API_KEY,
                        'anthropic-version': ANTHROPIC_VERSION,
                    },
                    body: JSON.stringify({
                        model,
                        max_tokens: 1500 * images.length,
                        temperature: 0,
                        messages: [{ role: 'user', content }],
                    }),
                },
                timeoutMs
            );

            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                lastErr = new Error(`Claude vision ${response.status}: ${detail.slice(0, 200)}`);
                modelTracker.recordFailure(model);
                continue;
            }

            const data = await response.json();
            modelTracker.reset(model);
            return data.content?.[0]?.text || '';
        } catch (err) {
            lastErr = err;
            modelTracker.recordFailure(model);
        }
    }

    throw lastErr || new Error('All vision models exhausted');
}

/**
 * Transcribe rendered page images back into markdown.
 *
 * Never throws: recovery is best-effort, and a document that partially recovered is far
 * more useful than a hard failure. Pages that could not be recovered come back as null
 * so the caller can report them honestly.
 *
 * @param {Buffer[]} pngBuffers  One rendered image per page needing recovery.
 * @param {{ deadlineMs?: number }} opts  Wall-clock budget shared across all batches.
 * @returns {Promise<Array<string|null>>} Aligned to pngBuffers; null = not recovered.
 */
export async function recoverPageText(pngBuffers, { deadlineMs = 45000 } = {}) {
    const results = new Array(pngBuffers.length).fill(null);
    if (!isVisionAvailable() || pngBuffers.length === 0) return results;

    const startedAt = Date.now();
    const batches = [];
    for (let i = 0; i < pngBuffers.length; i += IMAGES_PER_REQUEST) {
        batches.push({ offset: i, images: pngBuffers.slice(i, i + IMAGES_PER_REQUEST) });
    }

    for (const batch of batches.slice(0, MAX_REQUESTS)) {
        const remaining = deadlineMs - (Date.now() - startedAt);
        if (remaining < 5000) {
            console.warn('[Vision] Out of time budget; leaving remaining pages unrecovered.');
            break;
        }

        // Oversized images are dropped rather than failing their whole batch. Their slots
        // stay null and get reported as unreadable.
        const keptIndices = [];
        const kept = [];
        batch.images.forEach((buf, i) => {
            if (buf.length <= MAX_IMAGE_BYTES) {
                keptIndices.push(i);
                kept.push(buf);
            }
        });
        if (kept.length === 0) continue;

        try {
            const text = await callVisionBatch(kept, Math.min(remaining - 2000, 50000));
            const sections = text.split(/^---PAGE---$/m).map(s => s.trim());

            keptIndices.forEach((localIndex, keptIndex) => {
                const section = sections[keptIndex];
                if (!section || section === '[unreadable]') return;
                results[batch.offset + localIndex] = section;
            });
        } catch (err) {
            console.warn(`[Vision] Batch at page offset ${batch.offset} failed: ${err.message}`);
        }
    }

    const recovered = results.filter(Boolean).length;
    console.log(`[Vision] Recovered ${recovered}/${pngBuffers.length} page(s)`);
    return results;
}
