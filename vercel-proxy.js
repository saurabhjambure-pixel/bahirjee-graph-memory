
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function vercelApiProxy() {
    return {
        name: 'vercel-api-proxy',
        configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
                if (req.url.startsWith('/api/')) {
                    // Strip query parameters for local route resolution
                    const urlWithoutQueryParams = req.url.split('?')[0];
                    const apiName = urlWithoutQueryParams.split('/api/')[1]?.split('/')[0];

                    // Vercel's real runtime parses the query string onto req.query for every
                    // handler. Node's raw http.IncomingMessage (what this middleware wraps)
                    // never does that — req only has the unparsed req.url. Any handler reading
                    // req.query.* (e.g. the intelligence handler's GET ?id=) silently saw
                    // `undefined` here while still working under `vercel dev` and in production.
                    req.query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);

                    // Dispatch through the same router used in production, so dev and prod
                    // resolve routes identically. (Production serves ONE function — see
                    // api/router.js — because Vercel's Hobby plan caps functions per deployment.)
                    const { resolveRouteHandler, parseRequestBody } = await import(
                        path.resolve(__dirname, 'api', 'router.js') + '?t=' + Date.now()
                    );
                    const handler = apiName ? await resolveRouteHandler(apiName) : null;

                    if (handler) {
                        try {
                            console.log(`[API Proxy] Handling ${req.method} ${req.url}`);

                            // Mock Express-like req/res for the Vercel handler
                            const mockRes = {
                                setHeader: (k, v) => res.setHeader(k, v),
                                status: (code) => {
                                    res.statusCode = code;
                                    return mockRes;
                                },
                                json: (data) => {
                                    res.setHeader('Content-Type', 'application/json');
                                    res.end(JSON.stringify(data));
                                },
                                end: (data) => res.end(data)
                            };

                            // Body parsing goes through the same code path as production
                            // (api/router.js). Critically, it leaves multipart streams
                            // untouched — buffering them here would starve busboy in the
                            // upload handler and hang the request forever.
                            await parseRequestBody(req);
                            await handler(req, mockRes);

                            return;
                        } catch (error) {
                            console.error(`[API Proxy] Error in ${apiName}:`, error);
                            res.statusCode = 500;
                            res.end(JSON.stringify({ error: error.message }));
                            return;
                        }
                    }
                }
                next();
            });
        },
    };
}
