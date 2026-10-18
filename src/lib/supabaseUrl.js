// supabase-js appends `rest/v1`, `auth/v1`, … to the URL it is given, so it must be the
// bare project origin. A value copied as the REST endpoint (https://<ref>.supabase.co/rest/v1)
// makes every query hit /rest/v1/rest/v1/<table>, and PostgREST answers PGRST125
// "Invalid path specified in request URL". Reduce whatever was configured to its origin.
//
// Unparseable values pass through untouched so the callers' "env not configured" paths and
// createClient's own validation still report them.
export function normalizeSupabaseUrl(url) {
    const trimmed = String(url || '').trim()
    if (!trimmed) return ''
    try {
        return new URL(trimmed).origin
    } catch {
        return trimmed
    }
}
