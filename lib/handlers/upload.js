// Document ingestion — the only internal, non-public data the platform ever sees.
//
// PDFs and images go through LiteParse (Rust/PDFium, markdown output with real headings
// and tables). DOCX stays on mammoth: LiteParse converts office formats via LibreOffice,
// which does not exist on Vercel. pdf-parse remains as a last-resort fallback so a native
// binary that fails to load degrades the feature instead of breaking intake.
//
// LiteParse runs with OCR disabled on purpose — the npm package ships no tessdata, so
// enabling it risks ocrFailureFatal aborting an otherwise-good parse. Text-sparse pages
// are instead detected via complexity signals, rendered to PNG, and read back by Claude
// vision (lib/_vision.js).

import Busboy from 'busboy';
import { applyApiSecurity } from '../_security.js';
import { requireAuthenticatedUser } from '../_auth.js';
import { recoverPageText, isVisionAvailable, visionPageCap } from '../_vision.js';

const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4 MB — Vercel's request body ceiling is ~4.5 MB
const MAX_FILES = 5;
const MAX_PAGES = 60;

// Overall wall-clock budget. vercel.json gives api/router.js maxDuration 60; this leaves
// headroom for auth, response serialisation, and the platform's own overhead.
const TOTAL_BUDGET_MS = 50000;

const LITEPARSE_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'tiff', 'tif', 'gif', 'bmp'];
const ALL_EXTENSIONS = [...LITEPARSE_EXTENSIONS, 'docx'];

// Extension is a hint, not a control — validate the actual bytes.
const MAGIC = {
    pdf: (b) => b.slice(0, 5).toString('latin1') === '%PDF-',
    docx: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
    png: (b) => b[0] === 0x89 && b.slice(1, 4).toString('latin1') === 'PNG',
    jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    gif: (b) => b.slice(0, 4).toString('latin1') === 'GIF8',
    bmp: (b) => b[0] === 0x42 && b[1] === 0x4d,
    webp: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP',
    tiff: (b) => (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a),
};

function magicMatches(ext, buffer) {
    if (buffer.length < 12) return false;
    const check = MAGIC[{ jpeg: 'jpg', tif: 'tiff' }[ext] || ext];
    return check ? check(buffer) : false;
}

/**
 * Stream-parse a multipart body into in-memory files.
 *
 * The request stream must not have been consumed upstream — api/router.js disables body
 * parsing and skips multipart requests precisely so this can work.
 */
function parseMultipart(req) {
    return new Promise((resolve, reject) => {
        const contentType = req.headers['content-type'] || '';
        if (!/^multipart\/form-data/i.test(contentType)) {
            reject(new Error('Expected a multipart/form-data upload'));
            return;
        }

        let busboy;
        try {
            busboy = Busboy({
                headers: req.headers,
                limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
            });
        } catch (err) {
            reject(new Error(`Invalid multipart request: ${err.message}`));
            return;
        }

        const files = [];
        const oversized = [];
        let settled = false;
        const fail = (err) => { if (!settled) { settled = true; reject(err); } };

        busboy.on('file', (_field, stream, info) => {
            // Strip any directory component before sanitising, so "../../etc/passwd"
            // cannot survive as ".._.._etc_passwd" and read as a plausible name.
            const base = String(info.filename || 'unknown').split(/[/\\]/).pop();
            const filename = base.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(0, 128) || 'unknown';

            const chunks = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('limit', () => oversized.push(filename));
            stream.on('end', () => {
                // A truncated file is discarded — a partial PDF parses to garbage.
                if (!oversized.includes(filename)) {
                    files.push({ filename, buffer: Buffer.concat(chunks) });
                }
            });
            stream.on('error', fail);
        });

        busboy.on('filesLimit', () => fail(new Error(`Too many files. Maximum is ${MAX_FILES}.`)));
        busboy.on('error', fail);
        busboy.on('close', () => {
            if (settled) return;
            settled = true;
            if (files.length === 0) {
                reject(new Error(
                    oversized.length > 0
                        ? `File too large: ${oversized.join(', ')}. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)} MB per file.`
                        : 'No file found in request'
                ));
                return;
            }
            resolve({ files, oversized });
        });

        req.pipe(busboy);
    });
}

// A page carrying less than this much text has effectively not been read. Sized to sit
// above a stray header/footer or page number but below any real slide's worth of content.
const THIN_PAGE_CHARS = 120;

function isThin(markdown) {
    return String(markdown || '').replace(/\s+/g, ' ').trim().length < THIN_PAGE_CHARS;
}

function summariseLayout(pages) {
    const warnings = new Set();
    for (const page of pages) {
        const layout = page.complexity?.layout;
        if (!layout) continue;
        if (layout.columnCount > 1) warnings.add('multi-column');
        if (layout.ruledTableCount > 0 || layout.textTableRunCount > 0) warnings.add('tables');
        if (layout.figureCount > 0) warnings.add('charts-or-figures');
    }
    return [...warnings];
}

function emptyQuality(overrides = {}) {
    return {
        pagesTotal: 0,
        pagesNeedingRecovery: 0,
        pagesRecoveredByVision: 0,
        pagesUnreadable: 0,
        layoutWarnings: [],
        visionSkipped: 0,
        degraded: false,
        ...overrides,
    };
}

/**
 * Parse a PDF or image with LiteParse, recovering text-sparse pages via vision.
 */
async function parseWithLiteParse(filename, buffer, budgetMs) {
    const { LiteParse } = await import('@llamaindex/liteparse');

    const parser = new LiteParse({
        outputFormat: 'markdown',
        imageMode: 'placeholder',
        extractLinks: true,
        ocrEnabled: false,       // no tessdata in the package — see file header
        includeComplexity: true, // per-page needsOcr + layout signals, one extra pass
        maxPages: MAX_PAGES,
        numWorkers: 1,           // serverless gives us ~1 usable core
        // 110 DPI puts a letter page at roughly 1.1 megapixels — enough for slide text,
        // small enough to stay inside Anthropic's per-image budget.
        dpi: 110,
        quiet: true,
    });

    const result = await parser.parse(buffer);
    const pages = result.pages || [];
    const markdown = pages.map(p => p.markdown || p.text || '');

    // needsOcr alone is not a good routing signal: it fires "sparse-text" on any page
    // whose text covers little of its area, which describes essentially every slide in a
    // deck. Recovering those would bill vision calls for pages that already parsed
    // perfectly. What actually matters is whether we ended up with usable text — so a
    // page is only sent to vision when the heuristic fires AND extraction came back thin.
    const needsRecovery = pages
        .map((page, i) => ({ page, i }))
        .filter(({ page, i }) => page.complexity?.needsOcr && isThin(markdown[i]))
        .map(({ i }) => i);

    let recoveredCount = 0;
    const cap = visionPageCap();
    const attempted = needsRecovery.slice(0, cap);

    if (attempted.length > 0 && isVisionAvailable() && cap > 0) {
        try {
            const shots = await parser.screenshot(buffer, attempted.map(i => pages[i].pageNum));
            const recovered = await recoverPageText(shots.map(s => s.imageBuffer), { deadlineMs: budgetMs });

            recovered.forEach((text, k) => {
                if (!text) return;
                markdown[attempted[k]] = text;
                recoveredCount++;
            });
        } catch (err) {
            console.warn(`[Upload] Vision recovery failed for ${filename}: ${err.message}`);
        }
    }

    // Still thin after the recovery attempt (or never attempted) = genuinely unreadable.
    const unreadable = needsRecovery.filter(i => isThin(markdown[i])).length;
    const text = markdown.filter(m => m && m.trim()).join('\n\n');

    return {
        text,
        pageCount: pages.length,
        parser: 'liteparse',
        quality: emptyQuality({
            pagesTotal: pages.length,
            pagesNeedingRecovery: needsRecovery.length,
            pagesRecoveredByVision: recoveredCount,
            pagesUnreadable: unreadable,
            layoutWarnings: summariseLayout(pages),
            visionSkipped: Math.max(0, needsRecovery.length - attempted.length),
            degraded: unreadable > 0 || needsRecovery.length > attempted.length,
        }),
    };
}

async function parseDocx(buffer) {
    const mammoth = await import('mammoth');
    // convertToMarkdown keeps the headings and lists that extractRawText flattens away.
    const result = await mammoth.convertToMarkdown({ buffer });
    const text = result.value || '';
    return {
        text,
        pageCount: Math.ceil(text.length / 3000), // DOCX has no page concept before layout
        parser: 'mammoth',
        quality: emptyQuality(),
    };
}

async function parsePdfFallback(buffer) {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);
    const text = data.text || '';
    return {
        text,
        pageCount: data.numpages || 0,
        parser: 'pdf-parse',
        // Flagged degraded: this path loses all layout, so callers know the text is flat.
        quality: emptyQuality({ pagesTotal: data.numpages || 0, degraded: true }),
    };
}

function describeParseError(message) {
    const lower = String(message || '').toLowerCase();
    if (lower.includes('password') || lower.includes('encrypted')) {
        return 'This PDF is password-protected. Remove the password and upload it again.';
    }
    return null;
}

function isNativeLoadFailure(message) {
    return /failed to load native module|cannot find module|\.node/i.test(String(message || ''));
}

async function parseOne(filename, buffer, budgetMs) {
    const ext = filename.toLowerCase().split('.').pop();

    if (!ALL_EXTENSIONS.includes(ext)) {
        return { filename, error: `Unsupported file type: .${ext}. Accepted: ${ALL_EXTENSIONS.join(', ')}.` };
    }
    if (!magicMatches(ext, buffer)) {
        return { filename, error: `${filename} does not look like a valid .${ext} file (its contents do not match its extension).` };
    }

    try {
        let parsed;
        if (ext === 'docx') {
            parsed = await parseDocx(buffer);
        } else {
            try {
                parsed = await parseWithLiteParse(filename, buffer, budgetMs);
            } catch (err) {
                const friendly = describeParseError(err.message);
                if (friendly) return { filename, error: friendly };
                // Only PDFs have a fallback; an image that LiteParse cannot read is done.
                if (ext !== 'pdf') throw err;
                console.warn(
                    `[Upload] LiteParse failed for ${filename} (${err.message})` +
                    `${isNativeLoadFailure(err.message) ? ' — native binary missing from the bundle' : ''}; ` +
                    'falling back to pdf-parse.'
                );
                parsed = await parsePdfFallback(buffer);
            }
        }

        const text = (parsed.text || '').trim();
        if (text.length < 50) {
            return {
                filename,
                error: parsed.quality?.pagesNeedingRecovery > 0
                    ? `No readable text in ${filename}. Every page appears to be a scan or image, and text recovery did not succeed.`
                    : `No readable text in ${filename}. The file may be empty or corrupted.`,
                quality: parsed.quality,
            };
        }

        console.log(
            `[Upload] ✅ ${filename} — parser=${parsed.parser}, pages=${parsed.pageCount}, ` +
            `chars=${text.length}, recovered=${parsed.quality.pagesRecoveredByVision}, ` +
            `unreadable=${parsed.quality.pagesUnreadable}`
        );

        return {
            fileName: filename,
            text,
            pageCount: parsed.pageCount,
            charCount: text.length,
            format: ext,
            quality: { ...parsed.quality, parser: parsed.parser },
        };
    } catch (error) {
        console.error(`[Upload] ❌ ${filename}: ${error.message}`);
        return { filename, error: describeParseError(error.message) || `Could not process ${filename}: ${error.message}` };
    }
}

/**
 * Everything the upload route does after authentication: read the multipart stream,
 * parse each file, and shape the response. Exported so the parsing pipeline can be
 * exercised end-to-end over a real request without stubbing the security middleware.
 *
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function processUpload(req) {
    const startedAt = Date.now();

    try {
        const { files, oversized } = await parseMultipart(req);

        const documents = [];
        const failures = oversized.map(name => ({
            filename: name,
            error: `${name} is larger than ${MAX_FILE_SIZE / (1024 * 1024)} MB and was skipped.`,
        }));

        for (let i = 0; i < files.length; i++) {
            // Split the remaining budget across the files still to be parsed, so one
            // scan-heavy deck cannot starve the rest of the batch.
            const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
            const perFileBudget = Math.max(5000, Math.floor(remaining / (files.length - i)));

            const result = await parseOne(files[i].filename, files[i].buffer, perFileBudget);
            if (result.error) failures.push(result);
            else documents.push(result);
        }

        if (documents.length === 0) {
            return {
                status: 400,
                body: {
                    error: failures[0]?.error || 'Could not extract text from any uploaded document.',
                    failures,
                },
            };
        }

        return {
            status: 200,
            body: {
                documents,
                failures,
                // Back-compat: older clients read the flat single-document shape.
                text: documents[0].text,
                fileName: documents[0].fileName,
                pageCount: documents[0].pageCount,
                charCount: documents[0].charCount,
            },
        };
    } catch (error) {
        console.error('[Upload] ❌ Error:', error.message);
        const status = /too large|too many files|no file found|multipart/i.test(error.message) ? 400 : 500;
        return { status, body: { error: `Document processing failed: ${error.message}` } };
    }
}

export async function handler(req, res) {
    if (await applyApiSecurity(req, res, { routeKey: 'upload', maxRequests: 10 })) return;
    if (!await requireAuthenticatedUser(req, res, { rateLimit: { routeKey: 'upload', maxRequests: 10 } })) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { status, body } = await processUpload(req);
    return res.status(status).json(body);
}
