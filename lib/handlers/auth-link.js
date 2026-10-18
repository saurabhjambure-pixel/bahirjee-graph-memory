import { createClient } from '@supabase/supabase-js';
import { createFetchWithTimeout } from '../../src/lib/fetchWithTimeout.js';
import { applyApiSecurity } from '../_security.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SINGLE-ACCOUNT SIGN-IN
//
// Exactly one email address may sign in, instantly — no password, no email click. Every
// other address is refused. There is no admin role and no self-serve signup.
//
// ⚠️  There is no proof of ownership: anyone who types LOGIN_EMAIL gets a session and can
//     start runs, which spend money on search and LLM calls. Keep the deployment URL
//     private, and rely on the per-IP rate limit below.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const DEFAULT_LOGIN_EMAIL = 'admin@bahirjee.in';

function getEnv(name, fallback = '') {
    return process.env[name] || fallback;
}

function getSupabaseAdminConfig() {
    const supabaseUrl = getEnv('SUPABASE_URL', getEnv('VITE_SUPABASE_URL'));
    const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY', getEnv('VITE_SUPABASE_SERVICE_ROLE_KEY'));
    const missing = [];
    if (!supabaseUrl) missing.push('SUPABASE_URL / VITE_SUPABASE_URL');
    if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    return { supabaseUrl, serviceRoleKey, missing };
}

export function getLoginEmail() {
    return getEnv('LOGIN_EMAIL', DEFAULT_LOGIN_EMAIL).trim().toLowerCase();
}

export async function handler(req, res) {
    if (await applyApiSecurity(req, res, { routeKey: 'auth-link', maxRequests: 20 })) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { supabaseUrl, serviceRoleKey, missing } = getSupabaseAdminConfig();
    if (missing.length) {
        console.error('Supabase admin env not configured: missing', missing.join(', '));
        return res.status(500).json({ error: `Supabase env not configured. Missing ${missing.join(', ')}.` });
    }

    const normalizedEmail = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ error: 'Valid email required' });
    }

    const loginEmail = getLoginEmail();
    if (normalizedEmail !== loginEmail) {
        console.warn(`[Auth Link] Refused sign-in for ${normalizedEmail}`);
        return res.json({ success: true, noAccess: true });
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { global: { fetch: createFetchWithTimeout() } });

    try {
        // The account's workspace is the client whose domain matches the login email
        // (sql/seed_bahirjee_in_domain.sql creates it for bahirjee.in).
        const domain = loginEmail.split('@').pop();
        const { data: client, error: clientError } = await supabaseAdmin
            .from('clients')
            .select('id')
            .ilike('domain', domain)
            .eq('status', 'active')
            .maybeSingle();
        if (clientError) {
            return res.status(500).json({ error: clientError.message || 'Failed to load workspace' });
        }
        if (!client) {
            console.error(`[Auth Link] No active client for ${domain} — run sql/seed_bahirjee_in_domain.sql.`);
            return res.status(500).json({ error: 'Workspace not set up' });
        }

        // No full_name: the app's name gate asks for it once on first sign-in.
        const createRes = await supabaseAdmin.auth.admin.createUser({
            email: loginEmail,
            email_confirm: true,
        });
        if (createRes.error && !/already|registered|exists/i.test(createRes.error.message || '')) {
            console.error('[Auth Link] createUser failed:', createRes.error.message);
            return res.status(500).json({ error: 'Unable to establish access' });
        }

        const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
            type: 'magiclink',
            email: loginEmail,
        });
        if (linkError || !linkData?.properties?.hashed_token || !linkData?.user?.id) {
            console.error('[Auth Link] generateLink failed:', linkError?.message);
            return res.status(500).json({ error: 'Unable to establish access' });
        }

        // handle_new_user() provisions a domain match as a read-only `brief_viewer`; this
        // account must be able to run analyses, so pin it to a full member every sign-in.
        const { error: profileError } = await supabaseAdmin
            .from('profiles')
            .upsert({
                id: linkData.user.id,
                role: 'client_user',
                client_id: client.id,
                is_active: true,
            }, { onConflict: 'id' });
        if (profileError) {
            console.error('[Auth Link] profile upsert failed:', profileError.message);
            return res.status(500).json({ error: 'Unable to establish access' });
        }

        return res.json({
            success: true,
            autoAccess: true,
            tokenHash: linkData.properties.hashed_token,
        });
    } catch (error) {
        console.error('[Auth Link] Error:', error);
        return res.status(500).json({ error: error.message || 'Unable to generate access link' });
    }
}
