import { handler as geminiHandler } from './handlers/gemini.js';
import { handler as groqHandler } from './handlers/groq.js';
import { handler as claudeHandler } from './handlers/claude.js';
import { handler as sarvamHandler } from './handlers/sarvam.js';
import { handler as jevHandler } from './handlers/jev.js';
import { handler as searchHandler } from './handlers/search.js';
import { handler as scrapeHandler } from './handlers/scrape.js';
import { handler as exaHandler } from './handlers/exa.js';

const HANDLERS = new Map([
    ['/api/gemini', geminiHandler],
    ['/api/groq', groqHandler],
    ['/api/claude', claudeHandler],
    ['/api/sarvam', sarvamHandler],
    ['/api/jev', jevHandler],
    ['/api/search', searchHandler],
    ['/api/scrape', scrapeHandler],
    ['/api/exa', exaHandler]
]);

function createMockResponse() {
    const headers = new Headers();
    let statusCode = 200;
    let bodyText = '';
    let ended = false;

    return {
        res: {
            headersSent: false,
            setHeader(name, value) {
                headers.set(name, String(value));
            },
            status(code) {
                statusCode = code;
                return this;
            },
            json(payload) {
                bodyText = JSON.stringify(payload);
                ended = true;
                this.headersSent = true;
                return this;
            },
            end(payload = '') {
                bodyText = typeof payload === 'string' ? payload : JSON.stringify(payload);
                ended = true;
                this.headersSent = true;
                return this;
            }
        },
        toFetchLikeResponse() {
            return {
                ok: statusCode >= 200 && statusCode < 300,
                status: statusCode,
                headers,
                async json() {
                    return bodyText ? JSON.parse(bodyText) : {};
                },
                async text() {
                    return bodyText || '';
                },
                get ended() {
                    return ended;
                }
            };
        }
    };
}

export async function internalPostJson(input, body) {
    const url = new URL(input, 'http://internal.local');
    const handler = HANDLERS.get(url.pathname);
    if (!handler) {
        throw new Error(`No internal handler registered for ${url.pathname}`);
    }

    const { res, toFetchLikeResponse } = createMockResponse();
    const req = {
        method: 'POST',
        headers: {
            // Dedicated internal secret; falls back to the service-role key only until
            // INTERNAL_API_KEY is configured (must match hasValidInternalApiKey in _auth.js).
            'x-bahirjee-internal-key': process.env.INTERNAL_API_KEY
                || process.env.SUPABASE_SERVICE_ROLE_KEY
                || process.env.VITE_SUPABASE_SERVICE_ROLE_KEY
                || '',
        },
        body,
        query: Object.fromEntries(url.searchParams.entries()),
        socket: { remoteAddress: '127.0.0.1' }
    };

    await handler(req, res);
    return toFetchLikeResponse();
}
