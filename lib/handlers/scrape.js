import { applyApiSecurity } from '../_security.js';
import { requireAuthenticatedUser } from '../_auth.js';


export async function handler(req, res) {
    if (await applyApiSecurity(req, res, { routeKey: 'scrape', maxRequests: 30 })) return;
    if (!await requireAuthenticatedUser(req, res, { rateLimit: { routeKey: 'scrape', maxRequests: 30 } })) return;

    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    // SSRF Protection: Validate URL format and block internal/private IPs
    try {
        const parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return res.status(400).json({ error: 'Invalid URL protocol. Must be HTTP or HTTPS.' });
        }

        const hostname = parsedUrl.hostname.toLowerCase();
        // Strip IPv6 brackets. Note new URL() normalizes an IPv4-mapped address like
        // [::ffff:127.0.0.1] to its hex form (::ffff:7f00:1), so we can't rely on
        // parsing the dotted IPv4 back out — instead the whole ::ffff: mapped space
        // is blocked below (no legitimate scrape target is ever expressed that way).
        const bareHost = hostname.replace(/^\[|\]$/g, '');

        // Block internal / loopback / link-local / private representations (IPv4 + IPv6)
        if (
            bareHost === 'localhost' ||
            bareHost.endsWith('.local') ||
            bareHost.endsWith('.internal') ||
            // IPv6 loopback / unspecified / unique-local (fc00::/7) / link-local (fe80::/10)
            bareHost === '::1' ||
            bareHost === '::' ||
            bareHost.startsWith('::ffff:') ||   // IPv4-mapped IPv6 (any form)
            /^f[cd][0-9a-f]{2}:/i.test(bareHost) ||
            /^fe80:/i.test(bareHost) ||
            // IPv4 loopback (entire 127.0.0.0/8) and unspecified
            /^127\./.test(bareHost) ||
            bareHost === '0.0.0.0' ||
            // IPv4 private ranges
            bareHost.startsWith('10.') ||
            bareHost.startsWith('192.168.') ||
            /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(bareHost) ||
            // Link-local, incl. cloud metadata endpoint 169.254.169.254
            /^169\.254\./.test(bareHost)
        ) {
            console.warn(`[Scrape] Blocked SSRF attempt for: ${hostname}`);
            return res.status(400).json({ error: 'Invalid URL. Internal addresses are not allowed.' });
        }
    } catch (e) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    const PARALLEL_AI_KEY = process.env.PARALLEL_AI_API_KEY;
    const EXA_API_KEY = process.env.EXA_API_KEY;
    const mode = req.body.mode || 'content';

    // STRATEGY: Parallel AI Extract (primary) → Exa (fallback)

    // --- ATTEMPT 1: PARALLEL AI EXTRACT ---
    if (PARALLEL_AI_KEY) {
        try {
            console.log(`[Scrape] Attempting Parallel AI Extract for ${url}`);

            const controller = new AbortController();
            // Parallel serves a cached page in ~0.4-3.3s (measured across six real target
            // sites) but takes 60-90s on a cold fetch — longer than this function's whole
            // 60s budget, so waiting one out is never an option. Fail over fast instead:
            // 10s clears the slowest observed cached read 3x, and a cold miss costs 10s
            // rather than 20 before Exa takes it. The cold attempt still warms Parallel's
            // cache, so the same URL is fast on the next run.
            const timer = setTimeout(() => controller.abort(), 10000);

            let response;
            try {
                // Extract lives on the /v1beta surface and requires the version header —
                // without it the request is rejected 422. Full page markdown is only
                // available here; the stable /v1 endpoint returns short excerpts only.
                response = await fetch('https://api.parallel.ai/v1beta/extract', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${PARALLEL_AI_KEY}`,
                        'Content-Type': 'application/json',
                        'parallel-beta': 'search-extract-2025-10-10',
                    },
                    // `excerpts` and `full_content` bill as separate SKUs and excerpts
                    // defaults to ON, so it must be switched off explicitly — measured:
                    // omitting the field bills both sku_extract_excerpts and
                    // sku_extract_full, `excerpts: false` bills only the latter for
                    // byte-identical full_content. Only full_content is ever stored.
                    //
                    // No `objective` for the same reason: it only steers excerpt selection
                    // and leaves full_content unchanged, so here it would be inert.
                    body: JSON.stringify({
                        urls: [url],
                        full_content: true,
                        excerpts: false,
                    }),
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timer);
            }

            if (response.ok) {
                const json = await response.json();
                const first = json.results?.[0];
                const text = first?.full_content || '';
                if (text.length >= 500) {
                    console.log(`[Scrape] ✅ Parallel AI success (${text.length} chars)`);
                    return res.json({
                        text,
                        title: first.title || '',
                        publishDate: first.publish_date || null,
                        source: 'parallel_ai',
                    });
                }
                console.warn(`[Scrape] ⚠️ Parallel AI content too small (${text.length} chars). Trying Exa...`);
            } else {
                const errText = await response.text().catch(() => '');
                console.warn(`[Scrape] ⚠️ Parallel AI ${response.status}: ${errText.slice(0, 100)}. Trying Exa...`);
            }
        } catch (error) {
            console.warn(`[Scrape] ⚠️ Parallel AI error: ${error.message}. Trying Exa...`);
        }
    } else {
        console.log('[Scrape] Parallel AI key not configured, skipping to Exa');
    }

    // --- ATTEMPT 2: EXA (FALLBACK) ---
    if (EXA_API_KEY) {
        try {
            console.log(`[Scrape] Attempting Exa for ${url}`);

            const checkExaContent = (extract) => {
                if (extract && extract.text && extract.text.length >= 500) {
                    return extract;
                }
                console.warn(`[Scrape] ⚠️ Exa returned insufficient content (${extract?.text?.length || 0} chars).`);
                return null;
            };

            const directExtract = await exaContentsByUrl(EXA_API_KEY, url);
            const validDirect = checkExaContent(directExtract);
            if (validDirect) {
                return res.json({ ...validDirect, source: 'exa' });
            }

            if (mode === 'content') {
                const searchThenExtract = await exaSearchThenContents(EXA_API_KEY, url);
                const validSearch = checkExaContent(searchThenExtract);
                if (validSearch) {
                    return res.json({ ...validSearch, source: 'exa' });
                }
            }

            throw new Error('Exa returned insufficient or no content');
        } catch (error) {
            console.error(`[Scrape] ❌ Exa error: ${error.message}`);
            return res.status(500).json({ error: `Both scraping services failed. Exa: ${error.message}` });
        }
    }

    // --- NO SERVICES AVAILABLE ---
    console.error('[Scrape] ❌ No scraping services configured');
    return res.status(500).json({ error: 'No scraping services available. Configure PARALLEL_AI_API_KEY or EXA_API_KEY.' });
}

async function exaFetch(url, body, apiKey, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } finally {
        clearTimeout(timer);
    }
}

function readExaContentFromResponse(json) {
    const rows = json?.results || json?.data || [];
    const first = rows[0];
    if (!first?.text) return null;
    return {
        text: first.text,
        title: first.title || '',
        // Mirrors the Parallel AI branch so both providers hand callers the same shape.
        publishDate: first.publishedDate || null,
        // WHICH PAGE THIS TEXT ACTUALLY CAME FROM.
        //
        // `exaSearchThenContents` keyword-searches the requested URL and returns the top
        // result even when nothing matches it — so asking for janitri.in/changelog, a page
        // that does not exist, returns 24k characters of a different page, indistinguishable
        // from success. For a DISCOVERY read that is a reasonable fallback: you wanted
        // material about this page and here is the closest thing.
        //
        // For a CHANGE MONITOR it is corrosive. sourceWatch hashes the text and reports a
        // change whenever the hash moves; over substituted content the hash moves whenever
        // Exa's ranking does, manufacturing "changes" that look exactly like real ones.
        // Reporting the resolved URL lets a caller that cannot tolerate substitution notice
        // it, without changing what any existing caller gets.
        resolvedUrl: first.url || null
    };
}

async function exaContentsByUrl(apiKey, url) {
    const response = await exaFetch('https://api.exa.ai/contents', {
        ids: [url],
        text: {
            maxCharacters: 60000,
            includeHtmlTags: false
        }
    }, apiKey);

    if (!response.ok) return null;
    const json = await response.json().catch(() => ({}));
    const parsed = readExaContentFromResponse(json);
    if (parsed) console.log(`[Scrape] ✅ Exa direct content success (${parsed.text.length} chars)`);
    return parsed;
}

async function exaSearchThenContents(apiKey, url) {
    const searchResponse = await exaFetch('https://api.exa.ai/search', {
        query: url,
        type: 'keyword',
        numResults: 3
    }, apiKey, 10000);
    if (!searchResponse.ok) return null;

    const searchJson = await searchResponse.json().catch(() => ({}));
    const ids = (searchJson.results || [])
        .filter(r => r.id && r.url)
        .sort((a, b) => {
            const aMatches = a.url?.includes(url) ? 1 : 0;
            const bMatches = b.url?.includes(url) ? 1 : 0;
            return bMatches - aMatches;
        })
        .map(r => r.id)
        .slice(0, 2);
    if (ids.length === 0) return null;

    const contentsResponse = await exaFetch('https://api.exa.ai/contents', {
        ids,
        text: {
            maxCharacters: 60000,
            includeHtmlTags: false
        }
    }, apiKey, 12000);
    if (!contentsResponse.ok) return null;

    const contentsJson = await contentsResponse.json().catch(() => ({}));
    const parsed = readExaContentFromResponse(contentsJson);
    if (parsed) console.log(`[Scrape] ✅ Exa search->content success (${parsed.text.length} chars)`);
    return parsed;
}
