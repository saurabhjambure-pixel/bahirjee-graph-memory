import { applyApiSecurity } from '../_security.js';
import { requireAuthenticatedUser } from '../_auth.js';
import { processIntelligenceJob } from '../_intelligenceWorker.js';

export async function handler(req, res) {
    if (await applyApiSecurity(req, res, {
        routeKey: 'intelligence-worker',
        maxRequests: 120
    })) return;

    const auth = await requireAuthenticatedUser(req, res, { requireAdmin: true });
    if (!auth) return;

    const jobId = req.body?.jobId;
    if (!jobId) {
        return res.status(400).json({ error: 'jobId required' });
    }

    try {
        // `req` carries the headers the worker needs to build its own self-trigger URL
        // when it checkpoints a step and hands off to the next invocation.
        const job = await processIntelligenceJob(auth.supabaseAdmin, jobId, req);
        return res.json({
            success: true,
            jobId,
            status: job?.status || 'unknown',
            reportId: job?.report_id || null
        });
    } catch (error) {
        console.error('[intelligence-worker]', error);
        return res.status(500).json({
            error: error.message || 'Worker failed',
            jobId
        });
    }
}
