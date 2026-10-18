
const STORAGE_KEY = 'bahirjee_history_v1';

export const historyService = {
    // 1. Get previous report for incremental learning
    getLastReportForUrl: async (clientId, url) => {
        if (!clientId || !url) return null;
        try {
            const { getLastReportForUrl } = await import('./reportService.js');
            const { data } = await getLastReportForUrl(clientId, url);
            return data;
        } catch (e) {
            console.error("Failed to fetch last report:", e);
            return null;
        }
    },

    // 2. Get history. When a clientId is given, returns the whole ORG's reports
    //    (every member sees the company's reports, not just their own); otherwise
    //    falls back to the caller's own reports. RLS enforces visibility either way.
    // Goes through GET /api/report?list=1 rather than selecting directly. The direct
    // select relied on RLS, which returns 0 rows under DEV_AUTH_BYPASS (no Supabase JWT
    // ⇒ auth.uid() is null) — so the history drawer and the intake "Recent briefs" strip
    // were permanently empty locally. The endpoint scopes to the caller's own client and
    // returns the same trimmed column set. See lib/handlers/report.js.
    getHistory: async (userId, clientId = null) => {
        if (!userId && !clientId) return [];
        try {
            const { authenticatedFetch } = await import('./apiClient.js');
            const { mapReportRowToAppReport } = await import('./reportService.js');
            const res = await authenticatedFetch('/api/report?list=1');
            if (!res.ok) {
                console.error('Failed to fetch history:', res.status);
                return [];
            }
            const { reports } = await res.json();
            return (reports || []).map(mapReportRowToAppReport);
        } catch (e) {
            console.error("Failed to fetch history:", e);
            return [];
        }
    },

    // 3. Save a new report (now hands off to reportService)
    saveReport: async (report, userId, clientId) => {
        try {
            const { saveReport } = await import('./reportService.js');
            const { data } = await saveReport({
                websiteUrl: report.inputs?.websiteUrl,
                context: report.context,
                signals: report.signals,
                brief: report.brief,
                userId,
                clientId
            });
            return data;
        } catch (e) {
            console.error("Failed to save report:", e);
            return null;
        }
    },

    // 4. Get delta (changes) between current and previous report
    getDeltaAsync: async (clientId, url, currentSignals) => {
        const lastReport = await historyService.getLastReportForUrl(clientId, url);
        if (!lastReport || !lastReport.signals) {
            return { isFirstAnalysis: true, newSignals: currentSignals, resolvedSignals: [] };
        }

        const previousHeadlines = new Set(lastReport.signals.map(s => s.signal_headline?.toLowerCase()));
        const currentHeadlines = new Set(currentSignals.map(s => s.signal_headline?.toLowerCase()));

        // New signals not in previous
        const newSignals = currentSignals.filter(s =>
            !previousHeadlines.has(s.signal_headline?.toLowerCase())
        );

        // Signals that were in previous but not in current (resolved/no longer relevant)
        const resolvedSignals = lastReport.signals.filter(s =>
            !currentHeadlines.has(s.signal_headline?.toLowerCase())
        );

        return {
            isFirstAnalysis: false,
            newSignals,
            resolvedSignals,
            previousDate: lastReport.created_at
        };
    },
    
    // Fallback sync getDelta (keep signature for IntelligenceDashboard if needed)
    getDelta: (url, currentSignals) => {
        console.warn("Sync getDelta called - Please use getDeltaAsync for DB-backed history");
        return { isFirstAnalysis: true, newSignals: currentSignals, resolvedSignals: [] };
    }
};
