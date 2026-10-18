import { supabase } from '../lib/supabase.js';

// Admin-side queries for brief sharing: who opened what, who is blocked, and who has
// asked for access. All of these are admin-only at the RLS layer (see schema.sql 4b),
// so they use the browser client directly — matching the existing allowlist CRUD style
// in ClientDetail.jsx rather than routing through an API.

/**
 * Access rows for a client's briefs, aggregated per (report, email).
 * @returns {Object} map of report_id -> [{ email, count, firstSeen, lastSeen }]
 */
export async function getAccessLogByClient(clientId) {
    if (!supabase || !clientId) return {};
    try {
        const { data, error } = await supabase
            .from('report_access_log')
            .select('report_id, email, created_at')
            .eq('client_id', clientId)
            .order('created_at', { ascending: false })
            .limit(2000);

        if (error) {
            console.error('[briefAccess] access log fetch failed:', error.message);
            return {};
        }

        // One row per open; collapse to one entry per viewer so the admin sees people,
        // not page-refreshes.
        const byReport = {};
        for (const row of data || []) {
            const bucket = (byReport[row.report_id] ||= new Map());
            const existing = bucket.get(row.email);
            if (existing) {
                existing.count += 1;
                if (row.created_at < existing.firstSeen) existing.firstSeen = row.created_at;
                if (row.created_at > existing.lastSeen) existing.lastSeen = row.created_at;
            } else {
                bucket.set(row.email, {
                    email: row.email,
                    count: 1,
                    firstSeen: row.created_at,
                    lastSeen: row.created_at
                });
            }
        }

        return Object.fromEntries(
            Object.entries(byReport).map(([reportId, bucket]) => [
                reportId,
                [...bucket.values()].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
            ])
        );
    } catch (err) {
        console.error('[briefAccess] unexpected access log error:', err);
        return {};
    }
}

export async function getBlockedEmails(clientId) {
    if (!supabase || !clientId) return [];
    const { data, error } = await supabase
        .from('report_access_blocks')
        .select('*')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false });

    if (error) {
        console.error('[briefAccess] blocks fetch failed:', error.message);
        return [];
    }
    return data || [];
}

export async function blockEmail(clientId, email, reason = null) {
    if (!supabase) throw new Error('Supabase not configured');
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized) throw new Error('Email is required');

    const { error } = await supabase
        .from('report_access_blocks')
        .upsert({ client_id: clientId, email: normalized, reason }, { onConflict: 'client_id,email' });

    if (error) throw error;
    return normalized;
}

export async function unblockEmail(clientId, email) {
    if (!supabase) throw new Error('Supabase not configured');
    const { error } = await supabase
        .from('report_access_blocks')
        .delete()
        .eq('client_id', clientId)
        .eq('email', email);

    if (error) throw error;
}

export async function getAccessRequests(clientId) {
    if (!supabase || !clientId) return [];
    const { data, error } = await supabase
        .from('report_access_requests')
        .select('*')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false });

    if (error) {
        console.error('[briefAccess] requests fetch failed:', error.message);
        return [];
    }
    return data || [];
}

/**
 * Approve a request: grant the email view-only access to this client's briefs via the
 * existing allowlist, then mark the request resolved.
 */
export async function approveAccessRequest(request) {
    if (!supabase) throw new Error('Supabase not configured');

    // email is a GLOBAL primary key on email_allowlist — don't steal an address that
    // already belongs to a different client.
    const { data: existing, error: lookupError } = await supabase
        .from('email_allowlist')
        .select('email, client_id')
        .eq('email', request.email)
        .maybeSingle();
    if (lookupError) throw lookupError;
    if (existing && existing.client_id && existing.client_id !== request.client_id) {
        throw new Error('That email is already assigned to a different client.');
    }

    const { error: grantError } = await supabase
        .from('email_allowlist')
        .upsert({
            email: request.email,
            client_id: request.client_id,
            role: 'brief_viewer',
            is_active: true
        }, { onConflict: 'email' });

    if (grantError) throw grantError;

    const { data: { user } = {} } = await supabase.auth.getUser();
    const { error: updateError } = await supabase
        .from('report_access_requests')
        .update({
            status: 'approved',
            resolved_at: new Date().toISOString(),
            resolved_by: user?.id || null
        })
        .eq('id', request.id);

    if (updateError) throw updateError;
}

export async function denyAccessRequest(request) {
    if (!supabase) throw new Error('Supabase not configured');
    const { data: { user } = {} } = await supabase.auth.getUser();

    const { error } = await supabase
        .from('report_access_requests')
        .update({
            status: 'denied',
            resolved_at: new Date().toISOString(),
            resolved_by: user?.id || null
        })
        .eq('id', request.id);

    if (error) throw error;
}
