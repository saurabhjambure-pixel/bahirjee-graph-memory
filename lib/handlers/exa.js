import { applyApiSecurity } from '../_security.js';
import { requireAuthenticatedUser } from '../_auth.js';

const EXA_SEARCH_URL = 'https://api.exa.ai/search';
const EXA_CONTENTS_URL = 'https://api.exa.ai/contents';
const EXA_FIND_SIMILAR_URL = 'https://api.exa.ai/findSimilar';
const DEFAULT_TIMEOUT_MS = 15000;

// Exa's `category` restricts results to an entity type; it is NOT a `type`.
const VALID_CATEGORIES = new Set([
    'company', 'news', 'research paper', 'pdf', 'github',
    'tweet', 'personal site', 'linkedin profile', 'financial report',
]);
const VALID_TYPES = new Set(['neural', 'keyword', 'auto', 'fast']);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HANDLER
// Modes:
//   search      — neural/keyword/auto search returning results + optional content snippets
//   findSimilar — embedding-based lookup of pages semantically similar to a URL
//   contents    — fetch content for given IDs
//
// Entity typing is done with `category` (e.g. 'company'), not `type`.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function handler(req, res) {
    if (await applyApiSecurity(req, res, { routeKey: 'exa', maxRequests: 60 })) return;
    if (!await requireAuthenticatedUser(req, res, { rateLimit: { routeKey: 'exa', maxRequests: 60 } })) return;

    const EXA_API_KEY = process.env.EXA_API_KEY;
    if (!EXA_API_KEY) {
        return res.status(503).json({ error: 'Exa not configured', code: 'PROVIDER_UNAVAILABLE' });
    }

    const {
        mode = 'search',
        query,
        url,                   // findSimilar: the seed URL
        ids,
        type = 'auto',         // 'neural' | 'keyword' | 'auto' | 'fast'
        category,              // 'company' | 'news' | ... — entity-type filter
        numResults = 10,
        useAutoprompt = true,
        includeContents = true,
        includeDomains,
        excludeDomains,
        excludeSourceDomain,   // findSimilar: drop results from the seed URL's own domain
        maxCharacters = 3000,
        startPublishedDate,    // ISO date string — filter to recent results
        endPublishedDate,
    } = req.body;

    try {
        const safeMaxCharacters = Math.min(Math.max(Number(maxCharacters) || 3000, 500), 10000);
        // Entity discovery (findSimilar) needs a wider net than article search.
        const safeNumResults = Math.min(Math.max(Number(numResults) || 10, 1), 25);

        if (category && !VALID_CATEGORIES.has(category)) {
            return res.status(400).json({ error: `Invalid category: ${category}` });
        }
        if (type && !VALID_TYPES.has(type)) {
            return res.status(400).json({ error: `Invalid type: ${type}. Did you mean category?` });
        }

        if (mode === 'contents' && Array.isArray(ids) && ids.length > 0) {
            const result = await fetchContents(EXA_API_KEY, ids.slice(0, 10), safeMaxCharacters);
            return res.json(result);
        }

        if (mode === 'findSimilar') {
            if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
                return res.status(400).json({ error: 'A valid http(s) url is required for findSimilar mode' });
            }
            const result = await exaFindSimilar(EXA_API_KEY, {
                url,
                category,
                numResults: safeNumResults,
                includeContents,
                maxCharacters: safeMaxCharacters,
                excludeSourceDomain: excludeSourceDomain !== false,
                includeDomains,
                excludeDomains,
                startPublishedDate,
                endPublishedDate,
            });
            return res.json(result);
        }

        if (!query || typeof query !== 'string' || query.trim().length < 2 || query.length > 500) {
            return res.status(400).json({ error: 'query is required for search mode' });
        }

        const results = await exaSearch(EXA_API_KEY, {
            query,
            type,
            category,
            numResults: safeNumResults,
            useAutoprompt,
            includeContents,
            maxCharacters: safeMaxCharacters,
            includeDomains,
            excludeDomains,
            startPublishedDate,
            endPublishedDate,
        });

        return res.json(results);
    } catch (err) {
        console.error('[Exa] Error:', err.message);
        return res.status(500).json({ error: err.message });
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXA SEARCH — returns results with optional inline content
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function normalizeResults(json) {
    return (json.results || []).map(r => ({
        id: r.id,
        url: r.url,
        title: r.title || '',
        publishedDate: r.publishedDate,
        text: r.text || '',
        highlights: r.highlights || [],
        score: r.score,
    }));
}

function buildContentsBlock(maxCharacters) {
    return {
        text: { maxCharacters },
        highlights: { numSentences: 3, highlightsPerUrl: 2 },
    };
}

async function exaSearch(apiKey, {
    query, type, category, numResults, useAutoprompt, includeContents,
    maxCharacters, includeDomains, excludeDomains, startPublishedDate, endPublishedDate
}) {
    const body = {
        query,
        type,
        numResults,
        useAutoprompt,
    };

    if (category) body.category = category;
    if (startPublishedDate) body.startPublishedDate = startPublishedDate;
    if (endPublishedDate) body.endPublishedDate = endPublishedDate;
    if (Array.isArray(includeDomains) && includeDomains.length) body.includeDomains = includeDomains;
    if (Array.isArray(excludeDomains) && excludeDomains.length) body.excludeDomains = excludeDomains;

    if (includeContents) body.contents = buildContentsBlock(maxCharacters);

    const response = await exaFetch(EXA_SEARCH_URL, body, apiKey);

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Exa search ${response.status}: ${errText.slice(0, 200)}`);
    }

    const results = normalizeResults(await response.json());
    console.log(`[Exa] ✅ Search "${query.substring(0, 60)}"${category ? ` [${category}]` : ''} → ${results.length} results`);
    return { results };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXA FIND SIMILAR — embedding-based neighbours of a seed URL.
// With category:'company' this returns companies, not articles about them,
// which is what competitor discovery actually needs.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function exaFindSimilar(apiKey, {
    url, category, numResults, includeContents, maxCharacters,
    excludeSourceDomain, includeDomains, excludeDomains,
    startPublishedDate, endPublishedDate
}) {
    const body = { url, numResults, excludeSourceDomain };

    if (category) body.category = category;
    if (startPublishedDate) body.startPublishedDate = startPublishedDate;
    if (endPublishedDate) body.endPublishedDate = endPublishedDate;
    if (Array.isArray(includeDomains) && includeDomains.length) body.includeDomains = includeDomains;
    if (Array.isArray(excludeDomains) && excludeDomains.length) body.excludeDomains = excludeDomains;

    if (includeContents) body.contents = buildContentsBlock(maxCharacters);

    const response = await exaFetch(EXA_FIND_SIMILAR_URL, body, apiKey);

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Exa findSimilar ${response.status}: ${errText.slice(0, 200)}`);
    }

    const results = normalizeResults(await response.json());
    console.log(`[Exa] ✅ findSimilar "${url}"${category ? ` [${category}]` : ''} → ${results.length} results`);
    return { results };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXA CONTENTS — fetch full text for given result IDs
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function fetchContents(apiKey, ids, maxCharacters = 5000) {
    const response = await exaFetch(EXA_CONTENTS_URL, {
        ids,
        text: { maxCharacters, includeHtmlTags: false },
    }, apiKey);

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Exa contents ${response.status}: ${errText.slice(0, 200)}`);
    }

    const json = await response.json();
    return { results: json.results || [] };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SHARED FETCH HELPER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function exaFetch(url, body, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}
