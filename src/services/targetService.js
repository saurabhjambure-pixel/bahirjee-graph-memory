/**
 * Intelligence targets — the subjects a workspace watches.
 *
 * One company target per workspace (backfilled by v37), plus any number of products.
 * A product carries its PARENT's target_domain verbatim, which is why the Agenda, Reads,
 * daily_checks and both crons needed no change: they key on the domain and a product
 * resolves to the same one.
 *
 * The writer, the reader and the columns are pinned together in scripts/targets.test.mjs.
 * A field the mapper reads that the query never selected reads back as `undefined` and
 * throws nothing — the shape that cost this codebase `source_class` for months.
 *
 * See scripts/migrations/v37_intelligence_targets.sql.
 */

import { supabase } from '../lib/supabase.js';
import { getCurrentCompanyContext, saveCompanyContext } from './companyContextService.js';
import { normalizeProductProfile } from './productService.js';

/** Mirrors intelligence_targets_type_check in v37. Add here and in SQL in ONE commit. */
export const TARGET_TYPES = ['company', 'product'];

/** Mirrors intelligence_targets_status_check in v37. */
export const TARGET_STATUSES = ['draft', 'active', 'archived'];

/** Every column mapTarget reads appears here. */
export const TARGET_COLUMNS = [
    'id', 'client_id', 'type', 'name', 'slug', 'status',
    'target_domain', 'created_by', 'created_at', 'updated_at',
].join(', ');

/** Every column mapSources reads appears here. */
export const SOURCE_COLUMNS = [
    'id', 'target_id', 'canonical_url', 'linkedin_url',
    'supporting_urls', 'documents', 'created_at', 'updated_at',
].join(', ');

/** Postgres "relation does not exist" / PostgREST "table not found". */
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205', 'PGRST204']);

/** Postgres unique-violation — a slug collision on (client_id, slug). */
const UNIQUE_VIOLATION_CODE = '23505';

export function slugify(name) {
    const s = String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    // Never empty: an empty slug would collide on the unique index for every target.
    return s || `target-${Date.now().toString(36)}`;
}

/**
 * Give a product its own context by SNAPSHOTTING the parent company's.
 *
 * A snapshot, not a reference, on purpose: a later edit to the company context must not
 * silently change what a product run already did, or what a historical product brief was
 * based on. Same discipline as the immutable scope snapshot a composite run will need.
 *
 * Refuses when the parent has no confirmed context. Inheriting `{}` would produce a brief
 * about nothing and throw nothing — the exact failure shape this codebase is most
 * vulnerable to.
 */
export async function inheritCompanyContext({ clientId, parentTargetId, parentDomain, targetId, product }) {
    // Deliberately no targetId here. getCurrentCompanyContext skips its last-report
    // fallback whenever a targetId is supplied — right for a product's OWN context lookup,
    // wrong for the parent: a company can have reports and no company_contexts row yet
    // (the v31 backfill builds a company target from reports alone), and the report
    // fallback is exactly what v26 built for that case. The no-targetId path already
    // resolves the company target internally and strips any foreign _product before
    // returning, so passing parentTargetId here would make inheritance fail for every
    // company whose context has only ever existed as a report.
    const parent = await getCurrentCompanyContext(clientId, parentDomain);
    if (!parent?.context) {
        return { ok: false, message: 'I don\'t know your company well enough yet. Run your company brief first.' };
    }

    const profile = normalizeProductProfile(product);
    if (!profile) return { ok: false, message: 'That product needs a name I can work with.' };

    // The overlay rides ON the snapshot. It is in REUSABLE_KEYS, so it survives
    // hydrateStoredContext and participates in the context hash — editing positioning
    // later correctly mints a new version instead of silently reusing this one.
    const context = { ...parent.context, _product: profile };

    // Scoped to the PRODUCT's target id. Writing this against the parent would put
    // _product on the company's own context, where every company run would then read it.
    const saved = await saveCompanyContext({
        clientId,
        websiteUrl: parentDomain,
        context,
        source: 'inherited',
        builtFrom: {
            inherited_from: parentTargetId,
            captured_at: new Date().toISOString(),
            urls: profile.canonical_url ? [profile.canonical_url] : [],
        },
        targetId,
    });

    // saveCompanyContext never throws — it swallows errors and warns, returning the
    // mapped row on success or null on ANY failure. There is no { ok } shape to read.
    if (!saved) {
        return { ok: false, message: 'Could not save that product\'s context.' };
    }
    return { ok: true };
}

function mapTarget(row) {
    if (!row) return null;
    return {
        id: row.id,
        clientId: row.client_id,
        type: row.type,
        name: row.name,
        slug: row.slug,
        status: row.status,
        targetDomain: row.target_domain,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        sources: null,
        parentTargetId: null,
    };
}

function mapSources(row) {
    if (!row) return null;
    return {
        id: row.id,
        targetId: row.target_id,
        canonicalUrl: row.canonical_url,
        linkedinUrl: row.linkedin_url,
        supportingUrls: Array.isArray(row.supporting_urls) ? row.supporting_urls : [],
        documents: Array.isArray(row.documents) ? row.documents : [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * Every target for a workspace, company first, with its source bundle and parent.
 *
 * Fails soft on ANY error, including a missing table: an un-migrated deployment renders
 * a Desk without the targets band rather than an error screen. Same discipline as
 * listAgenda, and for the same reason.
 */
export async function listTargets(clientId) {
    if (!supabase || !clientId) return [];
    try {
        const { data, error } = await supabase
            .from('intelligence_targets')
            .select(TARGET_COLUMNS)
            .eq('client_id', clientId)
            .neq('status', 'archived')
            .order('type', { ascending: true })
            .order('created_at', { ascending: true });
        if (error) throw error;

        const targets = (data || []).map(mapTarget).filter(Boolean);
        if (targets.length === 0) return [];

        const ids = targets.map((t) => t.id);
        const [sourcesRes, relsRes] = await Promise.all([
            supabase.from('intelligence_target_sources').select(SOURCE_COLUMNS).in('target_id', ids),
            supabase
                .from('intelligence_target_relationships')
                .select('parent_target_id, child_target_id, relation')
                .in('child_target_id', ids),
        ]);

        // A failure here must not read as "no sources yet" — that is indistinguishable from
        // a genuine empty result. Same silent-on-missing-table, loud-otherwise convention as
        // the outer catch below.
        if (sourcesRes.error && !MISSING_TABLE_CODES.has(sourcesRes.error.code)) {
            console.error('[targets] list sources failed:', sourcesRes.error.message);
        }
        if (relsRes.error && !MISSING_TABLE_CODES.has(relsRes.error.code)) {
            console.error('[targets] list relationships failed:', relsRes.error.message);
        }

        const sources = sourcesRes.data;
        const rels = relsRes.data;

        const byTarget = new Map((sources || []).map((r) => [r.target_id, mapSources(r)]));
        const parentOf = new Map((rels || []).map((r) => [r.child_target_id, r.parent_target_id]));

        return targets.map((t) => ({
            ...t,
            sources: byTarget.get(t.id) || null,
            parentTargetId: parentOf.get(t.id) || null,
        }));
    } catch (err) {
        if (!MISSING_TABLE_CODES.has(err?.code)) {
            console.error('[targets] list failed:', err.message);
        }
        return [];
    }
}

/**
 * Create a target and its source bundle.
 *
 * A product MUST name a parent. An orphan product has no context to inherit, and
 * inheriting `{}` would produce a brief about nothing while throwing nothing.
 */
export async function createTarget({ clientId, type, name, targetDomain, parentTargetId = null, sources = {}, product = {} }) {
    if (!supabase) return { ok: false, message: 'Not connected.' };
    if (!TARGET_TYPES.includes(type)) return { ok: false, message: 'Unknown target type.' };
    if (!String(name || '').trim()) return { ok: false, message: 'Give this target a name.' };
    if (type === 'product' && !parentTargetId) {
        return { ok: false, message: 'A product has to belong to your company.' };
    }
    if (type === 'product' && !String(sources.canonicalUrl || '').trim()) {
        return { ok: false, message: 'A product needs a page I can read.' };
    }

    // A parent must be a COMPANY target in the SAME workspace. RLS stops a cross-tenant
    // parent for a real browser session, but nothing else stops a product being parented
    // to another product — which silently breaks the assumption (context inheritance,
    // the Agenda, cadence) that a parent has a company context to hand down.
    if (parentTargetId) {
        const { data: parent, error: parentError } = await supabase
            .from('intelligence_targets')
            .select('id, client_id, type, target_domain')
            .eq('id', parentTargetId)
            .maybeSingle();
        if (parentError) {
            console.error('[targets] parent lookup failed:', parentError.message);
            return { ok: false, message: 'Could not verify the parent target.' };
        }
        if (!parent || parent.client_id !== clientId || parent.type !== 'company') {
            return { ok: false, message: 'That parent must be your company target.' };
        }
        // A product carries its parent's target_domain verbatim (see the file header) —
        // the Agenda, Reads and both crons key on it and needed no change ONLY because
        // that holds. A refusal here, not a silent correction: rewriting the caller's
        // domain would hide a real bug in whatever constructed this request.
        if (parent.target_domain !== targetDomain) {
            console.error(
                '[targets] parent domain mismatch:', parent.target_domain, '!==', targetDomain,
                'parent:', parentTargetId
            );
            return { ok: false, message: 'A product must share its company\'s domain.' };
        }
    }

    try {
        const { data: target, error } = await supabase
            .from('intelligence_targets')
            .insert({
                client_id: clientId,
                type,
                name: String(name).trim(),
                slug: slugify(name),
                status: 'draft',
                target_domain: targetDomain,
            })
            .select(TARGET_COLUMNS)
            .single();
        if (error) throw error;

        const { error: sourcesError } = await supabase.from('intelligence_target_sources').insert({
            target_id: target.id,
            canonical_url: sources.canonicalUrl || null,
            linkedin_url: sources.linkedinUrl || null,
            supporting_urls: sources.supportingUrls || [],
            documents: sources.documents || [],
        });

        let relError = null;
        if (!sourcesError && parentTargetId) {
            const relResult = await supabase.from('intelligence_target_relationships').insert({
                parent_target_id: parentTargetId,
                child_target_id: target.id,
                relation: 'belongs_to',
            });
            relError = relResult.error;
        }

        // Either follow-up insert failing leaves the target row an orphan: a product with
        // no canonical_url on file, or no belongs_to link to its company. The target row
        // was just committed by THIS call (status 'draft', seconds old), so removing it is
        // a rollback of a failed create, not the user-facing archive path — that path must
        // still never delete anything.
        if (sourcesError || relError) {
            const failure = sourcesError || relError;
            console.error(
                '[targets] create failed after target row committed — rolling back:',
                failure.message, 'target:', target.id
            );
            const { error: cleanupError } = await supabase
                .from('intelligence_targets')
                .delete()
                .eq('id', target.id);
            if (cleanupError) {
                console.error(
                    '[targets] rollback delete FAILED — orphan target row left behind:',
                    target.id, cleanupError.message
                );
            }
            if (failure.code === UNIQUE_VIOLATION_CODE) {
                return { ok: false, message: 'A target with that name already exists.' };
            }
            return { ok: false, message: 'Could not save that target — nothing was created.' };
        }

        // A company target is runnable immediately — it IS the context. A product is only
        // runnable once it has inherited one, so promotion out of 'draft' happens here and
        // nowhere else. Without this a new product would sit in draft forever and both
        // TargetCard and resolveRunTarget would keep refusing to run it.
        if (type === 'product') {
            const inherited = await inheritCompanyContext({
                clientId,
                parentTargetId,
                parentDomain: targetDomain,
                targetId: target.id,
                // The founder's own description of the product — category, positioning,
                // the rivals they named. Dropped here, a product run had no rival to
                // compare against and fell back to the company's industry for everything.
                // normalizeProductProfile clamps it; identity fields always win.
                product: { ...product, target_id: target.id, name, canonical_url: sources.canonicalUrl },
            });
            if (!inherited.ok) {
                return { ok: false, target: mapTarget(target), message: inherited.message };
            }
        }

        const { data: promoted, error: promoteError } = await supabase
            .from('intelligence_targets')
            .update({ status: 'active', updated_at: new Date().toISOString() })
            .eq('id', target.id)
            .select(TARGET_COLUMNS)
            .single();

        // Unlike the follow-up inserts above, a failed promotion does NOT roll back: the
        // target row and its source bundle (and, for a product, its inherited context) are
        // all valid — a retry can still promote it. But the caller must be told the truth:
        // without this check, `promoted` comes back undefined, the code fell back to the
        // pre-update `target` (still 'draft'), and returned ok:true — the founder was told
        // the product was created when both the UI card and the server run path refuse to
        // run a draft, with no message saying why.
        if (promoteError) {
            console.error(
                '[targets] promotion to active failed — target exists but is not runnable:',
                promoteError.message, 'target:', target.id
            );
            return {
                ok: false,
                target: mapTarget(target),
                message: 'Saved, but I couldn\'t mark it ready to run yet — try again in a moment; nothing was lost.',
            };
        }

        return { ok: true, target: mapTarget(promoted) };
    } catch (err) {
        if (err?.code === UNIQUE_VIOLATION_CODE) {
            return { ok: false, message: 'A target with that name already exists.' };
        }
        console.error('[targets] create failed:', err.message);
        return { ok: false, message: 'Could not save that target.' };
    }
}

export async function updateTarget(id, patch = {}) {
    if (!supabase || !id) return { ok: false, message: 'Not connected.' };
    const row = { updated_at: new Date().toISOString() };
    if (patch.name) { row.name = String(patch.name).trim(); row.slug = slugify(patch.name); }
    if (patch.status) {
        if (!TARGET_STATUSES.includes(patch.status)) return { ok: false, message: 'Unknown status.' };
        row.status = patch.status;
    }
    try {
        const { data, error } = await supabase
            .from('intelligence_targets')
            .update(row)
            .eq('id', id)
            .select(TARGET_COLUMNS)
            .single();
        if (error) throw error;
        return { ok: true, target: mapTarget(data) };
    } catch (err) {
        if (err?.code === UNIQUE_VIOLATION_CODE) {
            return { ok: false, message: 'A target with that name already exists.' };
        }
        console.error('[targets] update failed:', err.message);
        return { ok: false, message: 'Could not update that target.' };
    }
}

/** Archiving never deletes reports. The brief a founder already read stays readable. */
export const archiveTarget = (id) => updateTarget(id, { status: 'archived' });
export const restoreTarget = (id) => updateTarget(id, { status: 'active' });
