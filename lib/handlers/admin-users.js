import { createClient } from '@supabase/supabase-js';
import { createFetchWithTimeout } from '../../src/lib/fetchWithTimeout.js';
import { randomUUID } from 'crypto';
import { applyApiSecurity } from '../_security.js';

function getEnv(name, fallback = '') {
    return process.env[name] || fallback;
}

function getSupabaseAdminConfig() {
    const supabaseUrl = getEnv('SUPABASE_URL', getEnv('VITE_SUPABASE_URL'));
    const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY', getEnv('VITE_SUPABASE_SERVICE_ROLE_KEY'));
    const missing = [];
    if (!supabaseUrl) missing.push('SUPABASE_URL / VITE_SUPABASE_URL');
    if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_SERVICE_ROLE_KEY');
    return { supabaseUrl, serviceRoleKey, missing };
}

function getBearerToken(req) {
    const header = req.headers?.authorization || req.headers?.Authorization || '';
    if (!header.startsWith('Bearer ')) return null;
    return header.slice('Bearer '.length).trim();
}

async function requireAdmin(req, supabaseAdmin) {
    const accessToken = getBearerToken(req);
    if (!accessToken) throw new Error('Missing access token');

    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(accessToken);
    if (authError || !authData?.user) throw new Error('Invalid access token');

    const { data: profile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('role')
        .eq('id', authData.user.id)
        .single();

    if (profileError || profile?.role !== 'admin') {
        throw new Error('Admin permission required');
    }

    return authData.user;
}

export async function handler(req, res) {
    if (await applyApiSecurity(req, res, { routeKey: 'admin-users', maxRequests: 20 })) return;

    const { supabaseUrl, serviceRoleKey, missing } = getSupabaseAdminConfig();
    if (missing.length) {
        console.error('Supabase admin env not configured: missing', missing.join(', '));
        return res.status(500).json({
            error: `Supabase admin env not configured. Missing ${missing.join(', ')}. Set SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (or VITE_SUPABASE_SERVICE_ROLE_KEY).`
        });
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { global: { fetch: createFetchWithTimeout() } });
    const { action, payload = {} } = req.body || {};

    try {
        const requester = await requireAdmin(req, supabaseAdmin);

        switch (action) {
            case 'createUser':
                return await createUser(payload, requester, supabaseAdmin, res);
            case 'setUserStatus':
                return await setUserStatus(payload, supabaseAdmin, res);
            case 'deleteUser':
                return await deleteUser(payload, requester, supabaseAdmin, res);
            default:
                return res.status(400).json({ error: 'Invalid action' });
        }
    } catch (error) {
        return res.status(403).json({ error: error.message || 'Forbidden' });
    }
}

async function createUser(payload, requester, supabaseAdmin, res) {
    const { email, fullName, clientId } = payload;
    if (!email || !clientId) {
        return res.status(400).json({ error: 'Missing required fields for createUser (email, clientId)' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    // Founders authenticate via magic link — no password is set here. We create a
    // confirmed auth user with an unused random password, then allowlist the email
    // so /api/auth-link will actually send them a link (otherwise they'd be locked out).
    const randomPassword = `${randomUUID()}-${randomUUID()}`;
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: normalizedEmail,
        password: randomPassword,
        email_confirm: true,
        user_metadata: { full_name: fullName || '' },
        app_metadata: { created_by: requester.id }
    });
    if (createErr || !created?.user?.id) {
        return res.status(500).json({ error: createErr?.message || 'Failed to create auth user' });
    }

    const userId = created.user.id;
    const { error: profileErr } = await supabaseAdmin
        .from('profiles')
        .upsert({
            id: userId,
            client_id: clientId,
            full_name: fullName || '',
            role: 'client_user',
            is_active: true
        });

    if (profileErr) {
        return res.status(500).json({ error: profileErr.message || 'Failed to sync profile' });
    }

    // Allowlist the email so the magic-link path admits this user regardless of domain.
    const { error: allowErr } = await supabaseAdmin
        .from('email_allowlist')
        .upsert({
            email: normalizedEmail,
            client_id: clientId,
            role: 'client_user',
            is_active: true
        }, { onConflict: 'email' });
    if (allowErr) {
        // Non-fatal: the auth user + profile already exist. Log and continue; a
        // matching active client domain may still admit them via /api/auth-link.
        console.warn('[admin-users] email_allowlist upsert failed:', allowErr.message);
    }

    return res.json({ success: true, userId });
}

async function setUserStatus(payload, supabaseAdmin, res) {
    const { userId, isActive } = payload;
    if (!userId || typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'Missing fields for setUserStatus' });
    }

    const { error } = await supabaseAdmin
        .from('profiles')
        .update({ is_active: isActive })
        .eq('id', userId);

    if (error) {
        return res.status(500).json({ error: error.message || 'Failed to update status' });
    }

    return res.json({ success: true });
}

async function deleteUser(payload, requester, supabaseAdmin, res) {
    const { userId } = payload;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    if (userId === requester.id) return res.status(400).json({ error: 'Cannot delete current admin user' });

    const { error: profileErr } = await supabaseAdmin
        .from('profiles')
        .delete()
        .eq('id', userId);
    if (profileErr) return res.status(500).json({ error: profileErr.message || 'Failed to delete profile' });

    const { error: userErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (userErr) return res.status(500).json({ error: userErr.message || 'Failed to delete auth user' });

    return res.json({ success: true });
}
