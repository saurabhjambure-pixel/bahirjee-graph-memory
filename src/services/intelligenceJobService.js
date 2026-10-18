import { authenticatedFetch, postJson } from './apiClient';

export async function submitIntelligenceJob(payload) {
    const response = await postJson('/api/intelligence', payload);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || 'Unable to submit intelligence job');
    }
    return data.job;
}

/**
 * Hand a job parked in `awaiting_context_review` the context the founder confirmed.
 * The server consumes the free-tier run here, not at submit — see api/intelligence.js.
 */
export async function resumeIntelligenceJob(jobId, reviewedContext) {
    const response = await postJson('/api/intelligence', { jobId, reviewedContext });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || 'Unable to resume intelligence job');
    }
    return data.job;
}

/**
 * Poll one job. `live` asks the server for the running pipeline's signal stream on top of
 * the status row — it is a DELTA: pass the cursor you have already consumed and you get
 * only what is new, so polling an unchanged run stays cheap.
 *
 * `{ sinceSignal, haveV6 }`. Omit `live` entirely for a plain status read.
 */
export async function getIntelligenceJob(jobId, live = null) {
    const params = new URLSearchParams({ id: jobId });
    if (live) {
        params.set('sinceSignal', String(live.sinceSignal ?? 0));
        if (live.haveV6) params.set('haveV6', '1');
    }
    const response = await authenticatedFetch(`/api/intelligence?${params.toString()}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || 'Unable to fetch intelligence job');
    }
    return data.job;
}

/**
 * Reconnect to whatever job the founder already has in flight (pending / processing /
 * awaiting_context_review), or null if there isn't one. `activeJobId` lives only in React
 * state, so a page reload during a context build otherwise strands that job — the founder
 * can't resume it and can't start a new one (server-side spam guard blocks a second create).
 */
export async function getActiveIntelligenceJob() {
    const response = await authenticatedFetch('/api/intelligence');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || 'Unable to check for an active intelligence job');
    }
    return data.job;
}
