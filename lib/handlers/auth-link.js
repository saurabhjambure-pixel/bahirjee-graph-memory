import { createClient } from '@supabase/supabase-js';
import { createFetchWithTimeout } from '../../src/lib/fetchWithTimeout.js';
import { applyApiSecurity } from '../_security.js';
import { classifySelfServeDomain } from '../freeMailDomains.js';
import { resolveSiteOrigin } from '../_siteUrl.js';

function getEnv(name, fallback = '') {
    return process.env[name] || fallback;
}

function getSupabaseAdminConfig() {
    const supabaseUrl = getEnv('SUPABASE_URL', getEnv('VITE_SUPABASE_URL'));
    const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY', getEnv('VITE_SUPABASE_SERVICE_ROLE_KEY'));
    const anonKey = getEnv('SUPABASE_ANON_KEY', getEnv('VITE_SUPABASE_ANON_KEY'));
    const missing = [];
    if (!supabaseUrl) missing.push('SUPABASE_URL / VITE_SUPABASE_URL');
    if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_SERVICE_ROLE_KEY');
    if (!anonKey) missing.push('SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY');
    return { supabaseUrl, serviceRoleKey, anonKey, missing };
}

function normalizeDomain(email) {
    if (!email || !email.includes('@')) return null;
    return email.split('@').pop().trim().toLowerCase();
}

function getAdminEmailAllowlist() {
    const rawList = getEnv('ADMIN_EMAILS', '').split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    const single = getEnv('ADMIN_EMAIL', '').trim().toLowerCase();
    const set = new Set(rawList);
    if (single) set.add(single); // only added if explicitly configured
    return set;
}

// Extra domains signed in INSTANTLY even without a matching client row (internal use).
// Any ACTIVE client's own domain also gets instant access — see the DB lookup below.
function getAutoAccessDomains() {
    const raw = getEnv('AUTO_ACCESS_DOMAINS', 'bahirjee.in');
    return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

// Self-serve signup is dark-launchable: set SELF_SERVE_ENABLED=0 to restore the previous
// invite-only behaviour without a rollback.
function selfServeEnabled() {
    return getEnv('SELF_SERVE_ENABLED', '1') !== '0';
}

/**
 * Find or create the self-serve workspace for `domain`.
 *
 * Deliberately INSERT-then-recover rather than upsert. `clients.domain` is UNIQUE, so an
 * upsert would converge on a concurrent signup — but it would also overwrite a row that
 * an admin created in the meantime, flipping `self_serve` to true on an admin-provisioned
 * client and promoting everyone at that domain from `brief_viewer` to `client_user`.
 * Insert + read-back on 23505 can only ever create a row that was absent, and reports
 * what it found when it was not.
 */
async function ensureSelfServeWorkspace({ supabaseAdmin, domain, normalizedEmail }) {
    const { data: inserted, error: insertError } = await supabaseAdmin
        .from('clients')
        .insert({
            name: domain,
            domain,
            status: 'active',
            self_serve: true,
            seed_email: normalizedEmail,
        })
        .select('id, self_serve')
        .maybeSingle();

    if (!insertError && inserted) {
        return { id: inserted.id, selfServe: inserted.self_serve === true };
    }

    // 23505 = unique_violation: someone else's signup (or an admin) got there first.
    const isRace = insertError?.code === '23505' || /duplicate key|unique constraint/i.test(insertError?.message || '');
    if (!isRace) return { error: insertError?.message || 'client insert failed' };

    const { data: existing, error: readError } = await supabaseAdmin
        .from('clients')
        .select('id, self_serve, status')
        .ilike('domain', domain)
        .maybeSingle();

    if (readError || !existing) return { error: readError?.message || 'client read-back failed' };
    if (existing.status !== 'active') return { error: 'workspace is inactive' };
    return { id: existing.id, selfServe: existing.self_serve === true };
}

/**
 * Ownership proof for anyone who will be able to spend money on runs. Same call the
 * allowlist branch makes — never the instant `autoAccess` token path.
 */
async function sendSelfServeLink({ supabasePublic, normalizedEmail, returnTo, res, clientId }) {
    const { error } = await supabasePublic.auth.signInWithOtp({
        email: normalizedEmail,
        options: {
            shouldCreateUser: true,
            emailRedirectTo: returnTo,
        }
    });

    if (error) {
        console.error('[Auth Link] Self-serve email error:', error.message);
        return res.status(500).json({ error: 'Unable to send authentication email' });
    }

    return res.json({
        success: true,
        emailSent: true,
        selfServe: true,
        clientId: clientId || null,
    });
}

export async function handler(req, res) {
    if (await applyApiSecurity(req, res, { routeKey: 'auth-link', maxRequests: 20 })) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { supabaseUrl, serviceRoleKey, anonKey, missing } = getSupabaseAdminConfig();
    if (missing.length) {
        console.error('Supabase admin env not configured: missing', missing.join(', '));
        return res.status(500).json({
            error: `Supabase admin env not configured. Missing ${missing.join(', ')}. Set SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (or VITE_SUPABASE_SERVICE_ROLE_KEY).`
        });
    }

    const { email, mode = 'signin' } = req.body || {};
    const domain = normalizeDomain(email);
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail || !domain || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ error: 'Valid email required' });
    }
    if (!['signin', 'signup'].includes(mode)) {
        return res.status(400).json({ error: 'Invalid auth mode' });
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { global: { fetch: createFetchWithTimeout() } });
    const supabasePublic = createClient(supabaseUrl, anonKey, { global: { fetch: createFetchWithTimeout() } });

    // Build returnTo — priority order:
    //   1. SITE_URL env var (manual override) — only if it's a real URL, not localhost
    //   2. VERCEL_PROJECT_PRODUCTION_URL (auto-injected, always fixed production domain)
    //   3. VERCEL_URL (auto-injected, per-deployment URL)
    //   4. req.headers.origin — only if it's not localhost (prevents dev leaking into prod)
    //   5. localhost:5173 fallback (local dev only)
    // The priority chain lives in lib/_siteUrl.js — the worker and the Monday Letter need
    // the same answer, and three copies of it would drift into three different deployments.
    const siteUrl       = getEnv('SITE_URL');
    const prodUrl       = getEnv('VERCEL_PROJECT_PRODUCTION_URL'); // e.g. "bahirjee-poc.vercel.app"
    const deployUrl     = getEnv('VERCEL_URL');                    // e.g. "bahirjee-poc.vercel.app"
    const origin        = req.headers.origin || '';

    // The trailing slash is required to match Supabase's redirect-allowlist wildcard, so it
    // is re-applied here rather than carried by the resolver, which strips it for everyone
    // else (an "evidence" link should not be ".../read/abc/").
    const returnTo = `${resolveSiteOrigin({ requestOrigin: origin })}/`;

    console.log(`[Auth Link] returnTo=${returnTo} | SITE_URL=${siteUrl||'unset'} | PROD_URL=${prodUrl||'unset'} | DEPLOY_URL=${deployUrl||'unset'} | origin=${origin||'none'}`);
    const adminAllowlist = getAdminEmailAllowlist();
    const autoAccessDomains = getAutoAccessDomains();

    try {
        let client = null;
        // Set when the pre-v24 schema is detected, so the self-serve branches below stay
        // shut rather than trying to write a column that does not exist yet.
        let selfServeColumnMissing = false;

        // Look up the per-email allowlist row (carries role + client_id).
        const { data: allowlistRow, error: allowlistError } = await supabaseAdmin
            .from('email_allowlist')
            .select('email, client_id, role, is_active')
            .eq('email', normalizedEmail)
            .eq('is_active', true)
            .maybeSingle();

        if (allowlistError && allowlistError.code !== 'PGRST116') {
            const isMissingTable = allowlistError.code === '42P01' || /email_allowlist/i.test(allowlistError.message || '');
            if (!isMissingTable) {
                return res.status(500).json({ error: allowlistError.message || 'Failed to validate email allowlist' });
            }
        }

        // Admins authenticate with a password at /admin/login — never via magic link.
        // Return a generic success (no email sent, no enumeration signal).
        const isAdminEmail = adminAllowlist.has(normalizedEmail) || allowlistRow?.role === 'admin';
        if (isAdminEmail) {
            console.warn(`[Auth Link] Admin email requested magic link; suppressed (use /admin/login): ${normalizedEmail}`);
            // `success: true` alone is indistinguishable from a real send — the frontend
            // showed "check your email" for an email that was never sent. `adminRedirect`
            // lets it say what actually happened.
            return res.json({ success: true, adminRedirect: true });
        }

        // ── Explicitly granted individual ───────────────────────────────────
        // Checked BEFORE instant domain access. An invited person whose domain also has a
        // self-serve workspace must keep the role their allowlist row records; letting the
        // domain branch answer first would silently downgrade them.
        if (allowlistRow) {
            const { error } = await supabasePublic.auth.signInWithOtp({
                email: normalizedEmail,
                options: {
                    shouldCreateUser: true,
                    emailRedirectTo: returnTo,
                }
            });

            if (error) {
                console.error('[Auth Link] Supabase email error:', error.message);
                return res.status(500).json({ error: 'Unable to send authentication email' });
            }

            return res.json({
                success: true,
                emailSent: true,
                clientId: allowlistRow.client_id || null
            });
        }

        // Does this email's domain belong to an active client?
        const lookupClient = (columns) => supabaseAdmin
            .from('clients')
            .select(columns)
            .ilike('domain', domain)
            .eq('status', 'active')
            .maybeSingle();

        let { data: clientRow, error: clientError } = await lookupClient('id, domain, status, self_serve');

        // `self_serve` arrives with migration v24. This read sits on the path EVERY sign-in
        // takes, so shipping the code before the migration would 500 every existing user
        // out of the product, not just self-serve ones. Fall back to the pre-v24 columns
        // and treat every client as admin-provisioned — which is exactly the old
        // behaviour — instead of taking the whole door down.
        if (clientError?.code === '42703' || /self_serve/i.test(clientError?.message || '')) {
            console.warn('[Auth Link] clients.self_serve missing — run migration v24. Falling back to pre-v24 behaviour.');
            selfServeColumnMissing = true;
            ({ data: clientRow, error: clientError } = await lookupClient('id, domain, status'));
        }

        if (clientError) {
            return res.status(500).json({ error: clientError.message || 'Failed to validate domain' });
        }
        client = clientRow;

        // ── Frictionless domain access ──────────────────────────────────────
        // Anyone on an ACTIVE ADMIN-PROVISIONED client's own domain (or an internal
        // override domain) is signed in INSTANTLY: no password, no email click. We create
        // the user if needed — handle_new_user() provisions them as a read-only
        // `brief_viewer` of that client — and mint a magic-link token the browser
        // verifies at once.
        // ⚠️  SECURITY: this grants a session to anyone who merely TYPES an address at
        //     such a domain; there is no proof of ownership. Mitigations: these users
        //     are view-only (cannot run analyses), and any individual can be revoked
        //     via the client's blocked-emails list.
        //
        //     `self_serve` workspaces are EXCLUDED for exactly that reason. Their members
        //     are provisioned `client_user` — they can start runs, which spend real money
        //     on search and LLM calls — so "view-only" no longer carries the risk, and
        //     ownership has to be proven by clicking a link in the inbox.
        if ((client && !client.self_serve) || autoAccessDomains.has(domain)) {
            const derivedName = normalizedEmail.split('@')[0]
                .replace(/[._-]+/g, ' ')
                .replace(/\b\w/g, c => c.toUpperCase());

            const createRes = await supabaseAdmin.auth.admin.createUser({
                email: normalizedEmail,
                email_confirm: true,
                user_metadata: { full_name: derivedName },
            });
            if (createRes.error && !/already|registered|exists/i.test(createRes.error.message || '')) {
                console.error('[Auth Link] auto-access createUser failed:', createRes.error.message);
                return res.status(500).json({ error: 'Unable to establish access' });
            }

            const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
                type: 'magiclink',
                email: normalizedEmail,
            });
            if (linkError || !linkData?.properties?.hashed_token) {
                console.error('[Auth Link] auto-access generateLink failed:', linkError?.message);
                return res.status(500).json({ error: 'Unable to establish access' });
            }

            return res.json({
                success: true,
                autoAccess: true,
                tokenHash: linkData.properties.hashed_token,
            });
        }

        // ── Self-serve ──────────────────────────────────────────────────────
        // Two distinct levers, deliberately not the same one:
        //
        //   SELF_SERVE_BLOCKED_DOMAINS / the blocklist — a per-domain lockout. Applies to
        //     BOTH joining an existing workspace and creating a new one, because its whole
        //     purpose is to stop a domain that should never have been pooled. Gating only
        //     creation would leave the already-leaking workspace open.
        //
        //   SELF_SERVE_ENABLED=0 — stops NEW workspaces only. Existing self-serve members
        //     keep their sign-in, because they already have reports in there and a growth
        //     switch should not lock people out of their own data.
        const verdict = classifySelfServeDomain(domain);
        if (!verdict.allowed) {
            console.warn(`[Auth Link] Self-serve refused for ${domain}: ${verdict.reason}`);
            return res.json({ success: true, noAccess: true, reason: verdict.reason });
        }

        // A member of an existing self-serve workspace. The instant branch above skipped
        // it on purpose, so prove ownership by email.
        if (client?.self_serve) {
            return await sendSelfServeLink({ supabasePublic, normalizedEmail, returnTo, res, clientId: client.id });
        }

        // Brand-new signup. No client row, no allowlist grant. Before this branch existed
        // the request ended below with `noAccess` and no auth user was ever created —
        // which is why handle_new_user()'s final `else` branch (assigning `client_user`)
        // was unreachable in practice.
        if (selfServeEnabled() && !selfServeColumnMissing) {
            const workspace = await ensureSelfServeWorkspace({ supabaseAdmin, domain, normalizedEmail });
            if (workspace.error) {
                console.error('[Auth Link] Self-serve workspace failed:', workspace.error);
                return res.status(500).json({ error: 'Unable to establish access' });
            }
            // A workspace appeared between the lookup above and the insert, and it is NOT
            // self-serve — i.e. an admin provisioned this domain in that window. Do not
            // grant self-serve rights over an admin-owned client; the next attempt will
            // route through the instant branch correctly.
            if (!workspace.selfServe) {
                console.warn(`[Auth Link] Domain ${domain} became admin-provisioned mid-signup; deferring.`);
                return res.json({ success: true, noAccess: true });
            }

            return await sendSelfServeLink({ supabasePublic, normalizedEmail, returnTo, res, clientId: workspace.id });
        }

        // No access by domain and no explicit grant. Reported so the brief page can
        // offer "Request access" instead of silently appearing to do nothing.
        console.warn(`[Auth Link] No access for domain: ${domain}`);
        return res.json({ success: true, noAccess: true });
    } catch (error) {
        console.error('[Auth Link] Error:', error);
        return res.status(500).json({ error: error.message || 'Unable to generate access link' });
    }
}
