import { applyApiSecurity } from '../_security.js';
import { requireAuthenticatedUser } from '../_auth.js';

/**
 * Targets CRUD.
 *
 * The client_id ALWAYS comes from the authenticated profile, never the body. An id in a
 * request body is a claim, not a fact — the same discipline reserveFounderRun applies to
 * run tier, and for the same reason: these rows decide what a run is allowed to spend.
 */

// Shared with the browser service rather than redefined. lib/ already imports across this
// boundary (cron-daily.js -> reportService.js), and src/lib/supabase.js is isomorphic: it
// detects the server and uses the service-role key there.
//
// Sharing is not cosmetic. TARGET_TYPES and TARGET_STATUSES are pinned against the v31
// CHECK constraints by scripts/targets.test.mjs. A second copy here would be invisible to
// that test and free to drift — which is precisely the v25 failure the pin exists to stop.
import {
    TARGET_TYPES,
    TARGET_STATUSES,
    TARGET_COLUMNS,
    slugify,
} from '../../src/services/targetService.js';

// Mirrors the constant pinned in targetService.js (not exported there, so duplicated here
// rather than reached across the module boundary for a single literal).
const UNIQUE_VIOLATION_CODE = '23505';

export async function handler(req, res) {
    // applyApiSecurity defaults allowedMethods to ['POST']; this route also serves GET and
    // PATCH, and without this the 405 in applyApiSecurity fires before req.method dispatch
    // below ever runs — GET and PATCH were unreachable.
    if (await applyApiSecurity(req, res, {
        routeKey: 'intelligence-targets',
        allowedMethods: ['GET', 'POST', 'PATCH'],
        maxRequests: 60,
    })) return;

    const auth = await requireAuthenticatedUser(req, res);
    if (!auth) return;

    const clientId = auth.profile.role === 'admin' && req.query?.clientId
        ? String(req.query.clientId)
        : auth.profile.client_id;

    if (!clientId) {
        return res.status(403).json({ error: 'Your account is not linked to an organization yet.' });
    }

    try {
        if (req.method === 'GET') {
            const { data, error } = await auth.supabaseAdmin
                .from('intelligence_targets')
                .select(TARGET_COLUMNS)
                .eq('client_id', clientId)
                .order('type', { ascending: true })
                .order('created_at', { ascending: true });
            if (error) throw error;
            return res.json({ targets: data || [] });
        }

        if (req.method === 'POST') {
            const { type, name, targetDomain, parentTargetId, sources = {} } = req.body || {};
            if (!TARGET_TYPES.includes(type)) return res.status(400).json({ error: 'Unknown target type.' });
            if (!String(name || '').trim()) return res.status(400).json({ error: 'Give this target a name.' });
            if (!String(targetDomain || '').trim()) return res.status(400).json({ error: 'A target needs a domain.' });
            if (type === 'product' && !parentTargetId) {
                return res.status(400).json({ error: 'A product has to belong to your company.' });
            }

            const normalizedDomain = String(targetDomain).trim().toLowerCase();

            // The parent must belong to the SAME client and be a COMPANY target, and the
            // product must carry its parent's target_domain verbatim — the invariant the
            // Agenda, Reads, daily_checks and both crons rely on to key off one domain per
            // company. Mirrors createTarget's parent check (src/services/targetService.js)
            // so the two writers cannot disagree about what a valid parent is.
            if (parentTargetId) {
                const { data: parent, error: parentErr } = await auth.supabaseAdmin
                    .from('intelligence_targets')
                    .select('id, client_id, type, target_domain')
                    .eq('id', parentTargetId)
                    .maybeSingle();
                if (parentErr) throw parentErr;
                if (!parent || parent.client_id !== clientId) {
                    return res.status(403).json({ error: 'That parent target is not yours.' });
                }
                if (parent.type !== 'company') {
                    return res.status(400).json({ error: 'That parent must be your company target.' });
                }
                if (parent.target_domain !== normalizedDomain) {
                    return res.status(400).json({ error: 'A product must share its company\'s domain.' });
                }
            }

            const { data: target, error } = await auth.supabaseAdmin
                .from('intelligence_targets')
                .insert({
                    client_id: clientId,
                    type,
                    name: String(name).trim(),
                    slug: slugify(name),
                    status: 'draft',
                    target_domain: normalizedDomain,
                    created_by: auth.user.id,
                })
                .select(TARGET_COLUMNS)
                .single();
            if (error) {
                if (error.code === UNIQUE_VIOLATION_CODE) {
                    return res.status(409).json({ error: 'A target with that name already exists.' });
                }
                throw error;
            }

            const { error: sourcesError } = await auth.supabaseAdmin.from('intelligence_target_sources').insert({
                target_id: target.id,
                canonical_url: sources.canonicalUrl || null,
                linkedin_url: sources.linkedinUrl || null,
                supporting_urls: Array.isArray(sources.supportingUrls) ? sources.supportingUrls : [],
                documents: Array.isArray(sources.documents) ? sources.documents : [],
            });

            let relError = null;
            if (!sourcesError && parentTargetId) {
                const relResult = await auth.supabaseAdmin.from('intelligence_target_relationships').insert({
                    parent_target_id: parentTargetId,
                    child_target_id: target.id,
                    relation: 'belongs_to',
                });
                relError = relResult.error;
            }

            // Mirrors createTarget's handling (src/services/targetService.js): either
            // follow-up insert failing leaves the target row an orphan — a product with no
            // canonical_url on file, or no belongs_to link to its company. The target row
            // was just committed by THIS call, so removing it is a rollback of a failed
            // create, never the user-facing archive path. Without this the caller got 201
            // and believed the target was fully created.
            if (sourcesError || relError) {
                const failure = sourcesError || relError;
                console.error(
                    '[intelligence-targets] create failed after target row committed — rolling back:',
                    failure.message, 'target:', target.id
                );
                const { error: cleanupError } = await auth.supabaseAdmin
                    .from('intelligence_targets')
                    .delete()
                    .eq('id', target.id);
                if (cleanupError) {
                    console.error(
                        '[intelligence-targets] rollback delete FAILED — orphan target row left behind:',
                        target.id, cleanupError.message
                    );
                }
                if (failure.code === UNIQUE_VIOLATION_CODE) {
                    return res.status(409).json({ error: 'A target with that name already exists.' });
                }
                return res.status(500).json({ error: 'Could not save that target — nothing was created.' });
            }

            // A company target IS the context — nothing to inherit, so it is runnable
            // immediately (mirrors createTarget's promotion, which does the same for
            // type === 'company'). A product target stays 'draft' ON PURPOSE: inheriting
            // the parent's context writes through set_current_company_context, which
            // authorises via auth.uid() and is therefore BROWSER-ONLY — this server route
            // cannot perform that write. inheritCompanyContext (src/services/targetService.js)
            // is the step that completes it, from the browser. The response reports the
            // real status so a caller can see the row is not yet runnable.
            let finalTarget = target;
            if (type === 'company') {
                const { data: promoted, error: promoteError } = await auth.supabaseAdmin
                    .from('intelligence_targets')
                    .update({ status: 'active', updated_at: new Date().toISOString() })
                    .eq('id', target.id)
                    .select(TARGET_COLUMNS)
                    .single();
                if (promoteError) {
                    console.error(
                        '[intelligence-targets] promotion to active failed — target exists but is not runnable:',
                        promoteError.message, 'target:', target.id
                    );
                } else {
                    finalTarget = promoted;
                }
            }

            return res.status(201).json({ target: finalTarget, status: finalTarget.status });
        }

        if (req.method === 'PATCH') {
            const { id, name, status } = req.body || {};
            if (!id) return res.status(400).json({ error: 'Which target?' });
            if (status && !TARGET_STATUSES.includes(status)) {
                return res.status(400).json({ error: 'Unknown status.' });
            }

            const patch = { updated_at: new Date().toISOString() };
            if (name) { patch.name = String(name).trim(); patch.slug = slugify(name); }
            if (status) patch.status = status;

            const { data, error } = await auth.supabaseAdmin
                .from('intelligence_targets')
                .update(patch)
                .eq('id', id)
                .eq('client_id', clientId)   // scoping, not filtering: a foreign id matches nothing
                .select(TARGET_COLUMNS)
                .maybeSingle();
            if (error) {
                if (error.code === UNIQUE_VIOLATION_CODE) {
                    return res.status(409).json({ error: 'A target with that name already exists.' });
                }
                throw error;
            }
            if (!data) return res.status(404).json({ error: 'Target not found.' });
            return res.json({ target: data });
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (error) {
        console.error('[intelligence-targets] failed:', error.message);
        return res.status(500).json({ error: 'Could not reach the target store.' });
    }
}
