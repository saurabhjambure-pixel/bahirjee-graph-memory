import { createClient } from '@supabase/supabase-js';
import { createFetchWithTimeout } from '../../src/lib/fetchWithTimeout.js';
import { normalizeSupabaseUrl } from '../../src/lib/supabaseUrl.js';
import { applyApiSecurity } from '../_security.js';

// Records a request for access to a shared brief.
//
// This deliberately does NOT require a session: a visitor whose email domain matches no
// client is never signed in by /api/auth-link, so requiring auth here would make the
// "Request access" path unreachable for exactly the people who need it.
//
// Responses are intentionally uniform ({ status: 'pending' }) so the endpoint can't be
// used to probe which briefs exist or who is blocked.

function getEnv(name, fallback = '') {
    return process.env[name] || fallback;
}

function getSupabaseAdmin() {
    const supabaseUrl = normalizeSupabaseUrl(getEnv('SUPABASE_URL', getEnv('VITE_SUPABASE_URL')));
    const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY', getEnv('VITE_SUPABASE_SERVICE_ROLE_KEY'));
    if (!supabaseUrl || !serviceRoleKey) return null;
    return createClient(supabaseUrl, serviceRoleKey, { global: { fetch: createFetchWithTimeout() } });
}

export async function handler(req, res) {
    if (await applyApiSecurity(req, res, { routeKey: 'brief-access', maxRequests: 10 })) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const supabaseAdmin = getSupabaseAdmin();
    if (!supabaseAdmin) {
        console.error('[Brief Access] Supabase admin env not configured');
        return res.status(500).json({ error: 'Server not configured' });
    }

    const { shareToken, email } = req.body || {};
    const normalizedEmail = String(email || '').trim().toLowerCase();

    if (!shareToken || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ error: 'Valid shareToken and email required' });
    }

    try {
        const { data: report, error: reportError } = await supabaseAdmin
            .from('reports')
            .select('id, client_id')
            .eq('share_token', shareToken)
            .maybeSingle();

        if (reportError) {
            console.error('[Brief Access] report lookup failed:', reportError.message);
            return res.status(500).json({ error: 'Unable to record request' });
        }
        // Unknown token: respond as if queued so the endpoint reveals nothing.
        if (!report) {
            return res.json({ status: 'pending' });
        }

        // Already blocked: look like a no-op rather than re-queueing them.
        const { data: blocked } = await supabaseAdmin
            .from('report_access_blocks')
            .select('email')
            .eq('client_id', report.client_id)
            .ilike('email', normalizedEmail)
            .maybeSingle();

        if (blocked) {
            return res.json({ status: 'pending' });
        }

        const { data: existing } = await supabaseAdmin
            .from('report_access_requests')
            .select('id, status')
            .eq('report_id', report.id)
            .eq('email', normalizedEmail)
            .maybeSingle();

        if (existing) {
            // Re-asking after a denial re-opens the request; an already-pending or
            // approved one is left alone.
            if (existing.status === 'denied') {
                await supabaseAdmin
                    .from('report_access_requests')
                    .update({ status: 'pending', created_at: new Date().toISOString(), resolved_at: null, resolved_by: null })
                    .eq('id', existing.id);
            }
            return res.json({ status: 'pending' });
        }

        const { error: insertError } = await supabaseAdmin
            .from('report_access_requests')
            .insert({
                report_id: report.id,
                client_id: report.client_id,
                email: normalizedEmail,
                status: 'pending'
            });

        if (insertError) {
            console.error('[Brief Access] insert failed:', insertError.message);
            return res.status(500).json({ error: 'Unable to record request' });
        }

        return res.json({ status: 'pending' });
    } catch (error) {
        console.error('[Brief Access] Error:', error);
        return res.status(500).json({ error: 'Unable to record request' });
    }
}
