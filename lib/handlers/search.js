import { applyApiSecurity } from '../_security.js';
import { requireAuthenticatedUser } from '../_auth.js';


export async function handler(req, res) {
    if (await applyApiSecurity(req, res, { routeKey: 'search', maxRequests: 60 })) return;
    if (!await requireAuthenticatedUser(req, res, { rateLimit: { routeKey: 'search', maxRequests: 60 } })) return;

    const { query } = req.body;
    if (!query || typeof query !== 'string' || query.trim().length < 2 || query.length > 500) {
        return res.status(400).json({ error: 'Valid query required' });
    }

    const tavilyKeys = (process.env.TAVILY_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
    if (!tavilyKeys.length) return res.status(500).json({ error: 'Tavily not configured' });

    try {
        // Tavily allows up to 20; we used to clamp at 10 for no reason other than habit.
        const maxResults = Math.min(Math.max(Number(req.body.max_results) || 6, 1), 20);
        const searchDepth = req.body.search_depth === 'advanced' ? 'advanced' : 'basic';
        const days = Math.min(Math.max(Number(req.body.days) || 120, 1), 365);
        const topic = req.body.topic || 'general';

        // Tavily honours `days` only on topic 'news' and start_date/end_date only on the
        // other topics, so the caller picks one form and we forward exactly that one —
        // sending both would let the ignored half look like it was applied.
        const isIsoDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
        const dateWindow = topic === 'news'
            ? { days }
            : {
                ...(isIsoDay(req.body.start_date) ? { start_date: req.body.start_date } : {}),
                ...(isIsoDay(req.body.end_date) ? { end_date: req.body.end_date } : {}),
            };

        // ── Source steering + date scoping ────────────────────────────────────
        // Tavily supports all of these; the gateway used to drop them silently, which
        // made it impossible to steer retrieval at research/analyst sources, and left
        // `topic: 'general'` searches with no date filter at all (`days` is news-only).
        const cleanDomains = (value, cap) => {
            if (!Array.isArray(value)) return null;
            const list = value
                .map(d => String(d || '').trim().toLowerCase())
                // Accept a bare host or a full URL; Tavily wants the host.
                .map(d => d.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0])
                .filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
            const unique = [...new Set(list)].slice(0, cap);
            return unique.length ? unique : null;
        };

        const includeDomains = cleanDomains(req.body.include_domains, 300);
        const excludeDomains = cleanDomains(req.body.exclude_domains, 150);

        const TIME_RANGES = new Set(['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y']);
        const timeRange = TIME_RANGES.has(req.body.time_range) ? req.body.time_range : null;

        // start_date/end_date are handled by `dateWindow` above, which also knows they are
        // mutually exclusive with `days` depending on the topic.

        // Only valid on advanced depth; Tavily rejects/ignores it otherwise.
        const chunksPerSource = searchDepth === 'advanced'
            ? Math.min(Math.max(Number(req.body.chunks_per_source) || 3, 1), 3)
            : null;

        // Reusable fetch wrapper with key rotation on 429 and exponential backoff
        const tavilyFetch = async (attempt = 1, keyIndex = 0) => {
            const controller = new AbortController();
            const timeoutMs = searchDepth === 'advanced' ? 30000 : 15000;
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            const apiKey = tavilyKeys[keyIndex] || tavilyKeys[0];

            try {
                const res = await fetch('https://api.tavily.com/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        api_key: apiKey,
                        query,
                        search_depth: searchDepth,
                        max_results: maxResults,
                        topic,
                        ...dateWindow,
                        include_raw_content: true, // full page text arrives with the result — no separate scrape needed
                        ...(includeDomains  ? { include_domains: includeDomains } : {}),
                        ...(excludeDomains  ? { exclude_domains: excludeDomains } : {}),
                        ...(timeRange       ? { time_range: timeRange }           : {}),
                        ...(chunksPerSource ? { chunks_per_source: chunksPerSource } : {}),
                    }),
                    signal: controller.signal
                });

                if (res.status === 429) {
                    // Try next key immediately if available
                    if (keyIndex + 1 < tavilyKeys.length) {
                        console.warn(`[Search] Tavily 429 on key index ${keyIndex}. Switching to key index ${keyIndex + 1}...`);
                        clearTimeout(timer);
                        return await tavilyFetch(1, keyIndex + 1);
                    }
                    if (attempt < 3) {
                        console.warn(`[Search] Tavily 429 Rate Limit (all keys exhausted). Retrying in 4s... (Attempt ${attempt}/3)`);
                        await new Promise(r => setTimeout(r, 4000));
                        return await tavilyFetch(attempt + 1, keyIndex);
                    }
                }

                if (res.status >= 500 && attempt < 3) {
                    console.warn(`[Search] Tavily ${res.status} Error. Retrying in 2s... (Attempt ${attempt}/3)`);
                    await new Promise(r => setTimeout(r, 2000));
                    return await tavilyFetch(attempt + 1, keyIndex);
                }

                if (keyIndex > 0) console.log(`[Search] ✅ Tavily success on key index ${keyIndex}`);
                return res;
            } finally {
                clearTimeout(timer);
            }
        };

        const response = await tavilyFetch();

        if (!response.ok) {
            const errJson = await response.json().catch(() => ({}));
            return res.status(response.status).json({
                error: errJson.error || `Tavily request failed (${response.status})`,
                provider: 'tavily'
            });
        }

        const json = await response.json();
        return res.json({ results: json.results || [] });
    } catch (error) {
        console.error('Tavily Error:', error);
        return res.status(500).json({ error: error.message });
    }
}
