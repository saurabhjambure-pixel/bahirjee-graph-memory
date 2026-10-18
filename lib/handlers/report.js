import { applyApiSecurity } from '../_security.js';
import { requireAuthenticatedUser } from '../_auth.js';

/**
 * GET /api/report?id=<uuid> — fetch one report by id.
 *
 * WHY THIS EXISTS
 * The browser used to select from `reports` directly and let RLS decide. That works in
 * production but breaks under DEV_AUTH_BYPASS, where the mock user has no Supabase JWT:
 * auth.uid() is NULL, every policy below fails, and the select returns 0 rows. Net effect
 * locally — the worker saves the report (service role) and the UI can never read it back,
 * so a completed analysis never displays.
 *
 * SECURITY
 * This reads with the SERVICE ROLE, which bypasses RLS entirely, so authorization is
 * re-implemented here and MUST stay equivalent to the policies on `public.reports`
 * (schema.sql). Those are:
 *   1. "Admins all reports"        — is_admin()
 *   2. "clients view reports"      — report.client_id == caller's profile.client_id
 *   3. "Client-domain view reports"— report's client is active AND its domain == the
 *                                    domain of the caller's email
 *   ...and (2) and (3) are both additionally gated by report_access_blocks: a blocked
 *   email loses access even inside the owning client.
 *
 * If you change a policy in schema.sql, change this too or the two drift apart and this
 * endpoint silently becomes the looser one.
 *
 * Non-entitled callers get 404, never 403 — mirroring RLS's "0 rows", so this cannot be
 * used to probe which report ids exist.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handler(req, res) {
    // applyApiSecurity defaults allowedMethods to ['POST']; this route is read-only.
    if (await applyApiSecurity(req, res, {
        routeKey: 'report',
        allowedMethods: ['GET'],
        maxRequests: 60
    })) return;

    const auth = await requireAuthenticatedUser(req, res);
    if (!auth) return; // requireAuthenticatedUser already sent 401/500

    const { user, profile, supabaseAdmin } = auth;

    // ── LIST MODE: GET /api/report?list=1 ────────────────────────────────
    // Same reason as the single read: historyService selected directly and RLS returned
    // 0 rows under DEV_AUTH_BYPASS, so the history drawer and the intake "Recent briefs"
    // strip were always empty locally. Scoped to the caller's own client (or, with no
    // client, their own reports) — never a client they don't belong to.
    if (req.query?.list) {
        // Only the columns the history UI renders/filters on — selecting '*' pulled the
        // full context/signals/brief JSONB for 50 reports (~527KB) into the landing page.
        // report_kind is included so callers can tell a product's report apart from the
        // company's own, even where the filter below doesn't already remove it.
        // decision_context is included so the history drawer can label a decision report
        // with its own decision_statement (ReportWorkspace.jsx) instead of the bare
        // "Decision brief" string every decision row otherwise renders — it's a small jsonb
        // column (v19, long applied, default '{}'), not the report-sized JSONB this comment
        // above is warning about.
        //
        // target_id is deliberately NOT selected here. It is a v37_intelligence_targets.sql
        // column, and that migration has never been applied to any database. Every other
        // v37 touchpoint fails soft (42703 / 42P01 caught and logged), but this select does
        // not — an unmigrated deployment gets a bare Postgres 42703 here, the handler 500s,
        // getHistory() returns [], deskDomain resolves undefined, and the Desk never renders
        // at all. Confirmed by grep that no consumer reads `.targetId` off a history row
        // (mapReportRowToAppReport maps it through, but nothing downstream reads it) — so
        // there is nothing to lose by leaving it out until v31 ships. If a future change
        // needs it here, make this select fail soft on 42703 the way getLastReportForTarget
        // does, rather than re-adding the column bare.
        const COLUMNS = 'id, created_at, website_url, share_token, target_domain, report_kind, decision_context';
        let query = supabaseAdmin.from('reports').select(COLUMNS)
            // Company-scoped history ONLY (N2). A product's report shares its parent's
            // target_domain verbatim (v31), so without this filter a product run can land
            // at history[0] and be shown as the company's own latest brief — the company
            // card's "Latest brief", the Desk's quiet-day invitation, lastReadAt and the
            // history drawer all read from this same list. A product's own brief is still
            // reachable, from its own target card via getLastReportForTarget — this only
            // stops it from being presented under the company's name.
            // `.neq('report_kind', 'product')` alone would ALSO drop every report written
            // before the column existed: SQL's `NULL <> 'product'` is NULL, not true, so a
            // plain neq silently excludes them — exactly the quiet-loss shape this codebase
            // is most vulnerable to. Treat a NULL report_kind as the company report it has
            // always meant (see mapReportRowToAppReport's `|| 'company'` fallback).
            .or('report_kind.is.null,report_kind.neq.product')
            .order('created_at', { ascending: false })
            .limit(50);

        query = profile?.client_id
            ? query.eq('client_id', profile.client_id)
            : query.eq('created_by', user.id);

        const { data, error: listError } = await query;
        if (listError) {
            console.error('[api/report] History lookup failed:', listError.message);
            res.status(500).json({ error: 'Could not load your briefs.' });
            return;
        }
        res.status(200).json({ reports: data || [] });
        return;
    }

    // ── TOKEN MODE: GET /api/report?token=<share_token> ──────────────────
    // Replaces the get_shared_report() RPC for the browser. That RPC opens with
    // `if auth.uid() is null then return;`, so it returns nothing under DEV_AUTH_BYPASS.
    // It also does two things beyond a plain read, both preserved here:
    //   • authorization via can_access_report(), which allows one grant the plain SELECT
    //     policies don't — an explicit email_allowlist entry (see isEntitled's
    //     viaShareToken branch)
    //   • an audit row in report_access_log
    // The RPC remains the source of truth for any non-browser caller.
    if (req.query?.token !== undefined) {
        const token = String(req.query.token || '').trim();
        if (!UUID_RE.test(token)) {
            res.status(400).json({ error: 'A valid share token is required.' });
            return;
        }

        const { data: rows, error: tokenError } = await supabaseAdmin
            .from('reports').select('*').eq('share_token', token).limit(1);

        if (tokenError) {
            console.error('[api/report] Token lookup failed:', tokenError.message);
            res.status(500).json({ error: 'Could not load the brief.' });
            return;
        }
        const shared = rows?.[0];
        if (!shared || !(await isEntitled({ supabaseAdmin, user, profile, report: shared, viaShareToken: true }))) {
            res.status(404).json({ error: 'Report not found.' });
            return;
        }

        // Audit trail. Non-fatal: access is already authorized above, and under
        // DEV_AUTH_BYPASS the mock user id isn't in auth.users so the FK would reject —
        // failing the view over a log write would be the wrong trade. Logged loudly.
        const { error: logError } = await supabaseAdmin.from('report_access_log').insert({
            report_id: shared.id,
            client_id: shared.client_id,
            user_id: user?.id || null,
            email: String(user?.email || '').toLowerCase(),
            accessed_via: 'share_token'
        });
        if (logError) console.error('[api/report] Access log write failed:', logError.message);

        res.status(200).json({ report: shared });
        return;
    }

    // ── SLUG MODE: GET /api/report?slug=<company> ────────────────────────
    // The workspace rewrites the address bar to /company/<slug> once a brief is open, so
    // this is where a post-run refresh lands. It went through a direct RLS select and so
    // was dead under DEV_AUTH_BYPASS too. Authorization below is the SAME check applied
    // to the resolved report — the slug only selects a candidate, it never grants access.
    const slug = String(req.query?.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (req.query?.slug !== undefined) {
        if (!slug) {
            res.status(400).json({ error: 'A valid company slug is required.' });
            return;
        }
        const { data: rows, error: slugError } = await supabaseAdmin
            .from('reports')
            .select('*')
            .or(`target_domain.eq.${slug},target_domain.like.${slug}.%`)
            .order('created_at', { ascending: false })
            .limit(1);

        if (slugError) {
            console.error('[api/report] Slug lookup failed:', slugError.message);
            res.status(500).json({ error: 'Could not load the brief.' });
            return;
        }
        const candidate = rows?.[0];
        if (!candidate) {
            res.status(404).json({ error: 'Report not found.' });
            return;
        }
        if (!(await isEntitled({ supabaseAdmin, user, profile, report: candidate }))) {
            res.status(404).json({ error: 'Report not found.' });
            return;
        }
        res.status(200).json({ report: candidate });
        return;
    }

    const reportId = String(req.query?.id || '').trim();

    // Reject anything that isn't a UUID before it reaches Postgres.
    if (!UUID_RE.test(reportId)) {
        res.status(400).json({ error: 'A valid report id is required.' });
        return;
    }

    const { data: report, error } = await supabaseAdmin
        .from('reports')
        .select('*')
        .eq('id', reportId)
        .maybeSingle();

    if (error) {
        console.error('[api/report] Lookup failed:', error.message);
        res.status(500).json({ error: 'Could not load the report.' });
        return;
    }
    if (!report) {
        res.status(404).json({ error: 'Report not found.' });
        return;
    }

    if (!(await isEntitled({ supabaseAdmin, user, profile, report }))) {
        res.status(404).json({ error: 'Report not found.' });
        return;
    }
    res.status(200).json({ report });
}

/**
 * The single authorization gate — every read mode above funnels through this, so the
 * id and slug paths cannot drift apart. Mirrors the SELECT policies on public.reports.
 * Returns false (⇒ 404) on ANY uncertainty; never throws.
 */
async function isEntitled({ supabaseAdmin, user, profile, report, viaShareToken = false }) {
    // (1) Admins see everything.
    if (profile?.role === 'admin') return true;

    const email = String(user?.email || '').toLowerCase();

    // Block check first: it revokes (2) and (3) alike.
    if (email && report.client_id) {
        // report_access_blocks has a composite PK (client_id, email) and no `id` column.
        // limit(1) rather than maybeSingle(): maybeSingle errors on >1 row, which would
        // trip the fail-closed branch below and lock out a legitimate caller.
        const { data: blocks, error: blockError } = await supabaseAdmin
            .from('report_access_blocks')
            .select('email')
            .eq('client_id', report.client_id)
            .ilike('email', email)
            .limit(1);

        // Fail CLOSED — if the block table can't be read we must not assume "not blocked".
        if (blockError) {
            console.error('[api/report] Block lookup failed, denying:', blockError.message);
            return false;
        }
        if (blocks?.length) return false;
    }

    // (2) Same client as the caller's profile.
    if (profile?.client_id && report.client_id && profile.client_id === report.client_id) return true;

    // (3) Caller's email domain matches an ACTIVE client that owns the report.
    const emailDomain = email.includes('@') ? email.split('@')[1] : '';
    if (emailDomain && report.client_id) {
        const { data: client, error: clientError } = await supabaseAdmin
            .from('clients')
            .select('id, status, domain')
            .eq('id', report.client_id)
            .maybeSingle();

        if (clientError) {
            console.error('[api/report] Client lookup failed, denying:', clientError.message);
            return false;
        }
        if (client?.status === 'active' && String(client.domain || '').toLowerCase() === emailDomain) return true;
    }

    // (4) Share-link only: an explicit grant, e.g. an approved access request.
    // This path exists in can_access_report() (which governs share tokens) but NOT in the
    // plain SELECT policies, so it is deliberately gated to the token route — otherwise
    // this endpoint would be looser than RLS for direct id/slug reads.
    if (viaShareToken && email && report.client_id) {
        const { data: grants, error: grantError } = await supabaseAdmin
            .from('email_allowlist')
            .select('email')
            .eq('client_id', report.client_id)
            .eq('is_active', true)
            .ilike('email', email)
            .limit(1);

        if (grantError) {
            console.error('[api/report] Allowlist lookup failed, denying:', grantError.message);
            return false;
        }
        if (grants?.length) return true;
    }

    return false;
}
