import { applyApiSecurity } from '../_security.js';
import { requireAuthenticatedUser } from '../_auth.js';
import { askGraph } from '../_graphAgent.js';
import { graphRoQuery, isGraphEnabled } from '../_graph.js';
import { graphWriteQaFinding } from '../_graphWriter.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// /api/graph — the Track 2 memory & coordination surface.
//
// THREE fixed actions, no arbitrary query surface anywhere:
//   ask            → the bounded Reason→Tool→Observe loop (_graphAgent.js)
//   activity       → the Memory & Coordination feed: recent handoffs, findings,
//                    reads (fixed capped Cypher, nothing else)
//   record_finding → the Ask-Bahirjee write-back. The browser cannot speak the
//                    Redis protocol, so the accepted Q&A finding is posted here
//                    and written to the tenant graph by the server. (Extends
//                    the plan's two-action minimum for the write path the
//                    plan itself requires — still fixed, still no Cypher in.)
//
// TENANT ISOLATION: client_id comes from the authenticated profile. The
// request body never supplies it — a request cannot name a tenant it is not.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const MAX_QUESTION_CHARS = 2000;

export async function handler(req, res) {
    if (await applyApiSecurity(req, res, {
        routeKey: 'graph',
        allowedMethods: ['POST'],
        allowHeaders: ['Content-Type', 'Authorization'],
        maxRequests: 30,
    })) return;

    const auth = await requireAuthenticatedUser(req, res, {
        rateLimit: { routeKey: 'graph', maxRequests: 30 },
    });
    if (!auth) return;

    const clientId = auth.profile?.client_id;
    if (!clientId) {
        return res.status(400).json({ error: 'no_tenant', message: 'This account is not attached to a workspace.' });
    }

    const { action, payload } = req.body || {};
    if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    if (!isGraphEnabled()) {
        return res.status(200).json({ outcome: 'graph_unavailable', degraded: true });
    }

    try {
        switch (action) {
            case 'ask': {
                const question = String(payload.question || '').trim();
                if (!question) return res.status(400).json({ error: 'question required' });
                if (question.length > MAX_QUESTION_CHARS) {
                    return res.status(400).json({ error: 'question_too_long' });
                }
                const result = await askGraph(clientId, question);
                return res.status(200).json(result);
            }

            case 'activity': {
                // The Memory & Coordination feed. Fixed query, fixed cap — this
                // is read-what-the-writers-wrote, not a query builder.
                const recent = await graphRoQuery(
                    clientId,
                    `MATCH (n)
                     WHERE n:Handoff OR n:Finding OR n:Read OR n:Session
                     RETURN n ORDER BY coalesce(n.ts, n.created_ts, n.started_ts, n.observed_at, 0) DESC
                     LIMIT $limit`,
                    { limit: 25 },
                );
                if (!recent.ok) {
                    return res.status(200).json({ outcome: 'graph_unavailable', degraded: true, items: [] });
                }
                const items = (recent.data || []).map((row) => {
                    const n = row.n || {};
                    const p = n.properties || n;
                    return {
                        kind: (n.labels && n.labels[0]) || null,
                        id: p.id || null,
                        name: p.name || p.headline || p.question || p.kind || p.id || null,
                        status: p.status || null,
                        ts: p.ts || p.created_ts || p.started_ts || p.observed_at || null,
                        reason: p.reason || null,
                    };
                });
                return res.status(200).json({ outcome: 'ok', items });
            }

            case 'record_finding': {
                const question = String(payload.question || '').slice(0, MAX_QUESTION_CHARS);
                const answer = String(payload.answer || '').slice(0, 4000);
                const sourceUrl = payload.sourceUrl ? String(payload.sourceUrl).slice(0, 500) : null;
                if (!question || !answer) {
                    return res.status(400).json({ error: 'question and answer required' });
                }
                const id = await graphWriteQaFinding(clientId, { question, answer, sourceUrl });
                return res.status(200).json({ ok: Boolean(id), id });
            }

            default:
                return res.status(400).json({ error: 'Invalid action' });
        }
    } catch (err) {
        console.error('[graph] handler error:', err.message);
        return res.status(500).json({ error: err.message });
    }
}
