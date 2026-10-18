/**
 * Primary Source Watch — turn tracked entities' own pages into a monitor.
 *
 * Every other retrieval path in this pipeline asks the web "what happened?" and gets
 * back journalism. This one asks a competitor's own /pricing page "are you different
 * from last week?" — which is a stronger claim, arrives earlier, and cites the company
 * itself rather than someone's account of it.
 *
 * The URLs have existed since v7 (primarySourceMapper writes them to entity_sources).
 * Nothing ever read them back. This module is the missing half.
 *
 * Two rules shape everything here:
 *
 *   1. A page we have never seen is NOT news. The first sighting stores a baseline and
 *      emits nothing. Reporting "Competitor X has a pricing page" as a signal would be
 *      noise on every client's first run, and would train founders to skim the section.
 *
 *   2. Only changes become observations. An unchanged page costs one hash comparison and
 *      produces nothing, so the LLM never pays to re-read a page that did not move.
 *
 * This only compounds when runs are spread over time — it is the weekly cron
 * (lib/handlers/cron-runs.js) that makes it worth anything.
 */

import { supabase } from '../lib/supabase.js';

/** Fetches per run. Bounded because each one is a scrape with a real timeout. */
export const MAX_WATCH_FETCHES_PER_RUN = 12;

/** Stored extract cap. Enough to diff a pricing table; not enough to bloat the row. */
const EXTRACT_CAP = 12000;

/** Diff payload handed to the analyzer. A signal needs the delta, not the document. */
const DIFF_CAP = 800;

/** Retire a source after this many consecutive failed fetches. */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Which entity categories are worth watching, best first.
 * A competitor's pricing page moving matters more than an infra vendor's blog.
 */
const ENTITY_PRIORITY = { competitor: 0, platform: 1, infra: 2, regulator: 3, industry_body: 4 };

/** Page types whose change is about the founder's own dependencies, not a rival's moves. */
const DEPENDENCY_SOURCE_TYPES = new Set(['status']);

/**
 * Which page types carry the most signal per fetch.
 * Pricing changes are strategy; a blog post is usually already in the news index.
 */
// `status` ranks just behind pricing: a provider the founder runs on going down is
// actionable today, where a changelog entry is actionable this quarter.
const SOURCE_TYPE_PRIORITY = { pricing: 0, status: 1, changelog: 2, careers: 3, regulatory: 4, press: 5, api_docs: 6, blog: 7 };

/** Map a watched page type onto the theme the analyzer already understands. */
const SOURCE_TYPE_THEME = {
    pricing: 'competitor_intel',
    changelog: 'competitor_intel',
    api_docs: 'competitor_intel',
    press: 'competitor_intel',
    blog: 'competitor_intel',
    careers: 'talent_signals',
    regulatory: 'regulatory_lens',
    // A dependency outage is a risk to the founder's own operation, not competitor news.
    status: 'industry_momentum',
};

/**
 * Strip the furniture that changes on every render — nav, cookie banners, CSRF tokens,
 * timestamps, cache-busting query strings. Without this, a page's hash changes on every
 * fetch and every run reports a "change" that is really just a rotating session id.
 */
export function normalizeForHash(text) {
    return String(text || '')
        .replace(/\r/g, '')
        // Dates and times in any common shape — footers love a "last updated".
        .replace(/\b\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?\b/g, '')
        .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/gi, '')
        // Long hex/base64-ish runs: tokens, build hashes, asset fingerprints.
        .replace(/\b[a-f0-9]{16,}\b/gi, '')
        .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '')
        // Collapse whitespace so reflow alone is not a change.
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/** SHA-256 of the normalized text. Works in both the browser and the Node worker. */
export async function hashContent(text) {
    const normalized = normalizeForHash(text);
    const bytes = new TextEncoder().encode(normalized);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Line-level diff, capped.
 *
 * Deliberately not a real LCS diff: the analyzer needs "what appeared and what vanished",
 * and a set difference answers that in a fraction of the time on pages that are mostly
 * boilerplate. Order changes are not reported, which is the intended trade — a reordered
 * pricing table is not a pricing change.
 */
export function summarizeDiff(previousText, currentText) {
    const lines = (t) => String(t || '')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 2);

    const prev = new Set(lines(previousText));
    const curr = lines(currentText);

    const added = curr.filter(l => !prev.has(l));
    const currSet = new Set(curr);
    const removed = [...prev].filter(l => !currSet.has(l));

    const section = (label, items) => items.length
        ? `${label}:\n${items.slice(0, 40).join('\n').substring(0, DIFF_CAP)}`
        : '';

    return [section('ADDED', added), section('REMOVED', removed)]
        .filter(Boolean)
        .join('\n\n');
}

/**
 * Rank sources so a capped run spends its fetches on the pages most likely to matter.
 * Total ordering (entity category → page type → url) so two runs over the same set
 * always choose the same pages.
 */
export function prioritizeSources(sources) {
    return [...sources].sort((a, b) => {
        const entityA = ENTITY_PRIORITY[a.entity?.category] ?? 99;
        const entityB = ENTITY_PRIORITY[b.entity?.category] ?? 99;
        if (entityA !== entityB) return entityA - entityB;

        const typeA = SOURCE_TYPE_PRIORITY[a.source_type] ?? 99;
        const typeB = SOURCE_TYPE_PRIORITY[b.source_type] ?? 99;
        if (typeA !== typeB) return typeA - typeB;

        return String(a.url || '').localeCompare(String(b.url || ''));
    });
}

/**
 * How many pages the DAILY loop fetches. The weekly sweep still uses
 * MAX_WATCH_FETCHES_PER_RUN.
 *
 * Sized so a company with a full watchlist is swept every ~3 days rather than every
 * 7. Be honest about what this costs: 4/day is roughly 120 fetches a month against
 * today's ~52, so scrape volume goes UP about 2.3x. It is still the right trade —
 * a scrape is the cheapest call in the stack, and the spend that actually dominates
 * (analyze batches, which scale with observation count) goes DOWN, because most
 * mornings produce no batch at all.
 */
export const DAILY_WATCH_FETCHES = 4;

/**
 * Did the scraper actually return the page we asked for?
 *
 * The Exa fallback keyword-searches the requested URL and returns the best result even when
 * nothing matches — so a page that does not exist comes back as a confident 24k-character
 * success from somewhere else entirely. A discovery read can live with that. A change
 * monitor cannot: the hash would be taken over a substitute whose content moves whenever
 * Exa's ranking moves, and every such move is reported as a change on a page nobody
 * touched. That is noise shaped exactly like signal, which is the one thing
 * `normalizeForHash` exists to keep out.
 *
 * Host comparison, not exact URL: providers legitimately normalise paths, follow redirects
 * and strip tracking params, and rejecting those would throw away real reads. A different
 * HOST is never the page we asked for.
 *
 * Unknown resolvedUrl (Parallel AI, or an older gateway) is ACCEPTED — the check can only
 * catch what the provider chooses to disclose, and failing closed on silence would stop the
 * watch working at all.
 */
export function isSubstitutedPage(requestedUrl, resolvedUrl) {
    if (!resolvedUrl) return false;
    try {
        const want = new URL(requestedUrl).hostname.replace(/^www\./, '').toLowerCase();
        const got = new URL(resolvedUrl).hostname.replace(/^www\./, '').toLowerCase();
        return want !== got;
    } catch {
        return false;
    }
}

/**
 * Pick today's slice: least-recently-checked first.
 *
 * `prioritizeSources` is a TOTAL ORDERING by importance, which is exactly right for a
 * weekly run that fetches a capped set once — but wrong for a daily loop, where it would
 * re-fetch the same top 4 pages every morning and never look at the tail at all. A
 * competitor's pricing page would be checked 30 times a month and their careers page
 * never.
 *
 * So: rotate on `last_checked` (which entity_sources already carries and sourceWatch
 * already stamps on every fetch, success or failure — so a permanently failing page
 * cannot jam the rotation), and fall back to the standing priority as the tie-break. That
 * keeps the ordering deterministic, sweeps everything, and needs no cursor to persist or
 * go stale.
 */
export function rotateSources(sources, limit = DAILY_WATCH_FETCHES) {
    const ranked = prioritizeSources((sources || []).filter(s => s?.url && s?.id));
    const standing = new Map(ranked.map((s, i) => [s.id, i]));

    return [...ranked]
        .sort((a, b) => {
            // A page never checked sorts first — it has no baseline yet, and until it does
            // it can never report a change.
            const ta = a.last_checked ? Date.parse(a.last_checked) : 0;
            const tb = b.last_checked ? Date.parse(b.last_checked) : 0;
            if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
            return standing.get(a.id) - standing.get(b.id);
        })
        .slice(0, limit);
}

/** The most recent stored snapshot for a source, or null on the first ever fetch. */
async function latestSnapshot(entitySourceId) {
    if (!supabase) return null;
    const { data, error } = await supabase
        .from('entity_source_snapshots')
        .select('content_hash, extract, fetched_at')
        .eq('entity_source_id', entitySourceId)
        .order('fetched_at', { ascending: false })
        .limit(1);

    if (error) {
        console.warn('[SourceWatch] Snapshot read failed:', error.message);
        return null;
    }
    return data?.[0] || null;
}

/** Record a snapshot. Unchanged content collides on the unique index and is ignored. */
async function recordSnapshot({ entitySourceId, runId, contentHash, extract }) {
    if (!supabase) return;
    const { error } = await supabase
        .from('entity_source_snapshots')
        .upsert(
            {
                entity_source_id: entitySourceId,
                run_id: runId || null,
                content_hash: contentHash,
                extract: String(extract || '').substring(0, EXTRACT_CAP),
            },
            { onConflict: 'entity_source_id,content_hash', ignoreDuplicates: true }
        );
    if (error) console.warn('[SourceWatch] Snapshot write failed:', error.message);
}

/** Mark a successful read, clearing the failure streak. */
async function markChecked(entitySourceId) {
    if (!supabase) return;
    await supabase
        .from('entity_sources')
        .update({ last_checked: new Date().toISOString(), consecutive_failures: 0 })
        .eq('id', entitySourceId);
}

/**
 * Mark a failed read. A source that fails repeatedly is deactivated rather than retried
 * every week — most of these are the `${name}.com` guesses primarySourceMapper makes when
 * it cannot resolve a real domain, and they will never resolve.
 */
async function markFailure(entitySourceId, currentFailures) {
    if (!supabase) return;
    const failures = (currentFailures || 0) + 1;
    const patch = { consecutive_failures: failures, last_checked: new Date().toISOString() };
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
        patch.is_active = false;
        console.log(`[SourceWatch] Retiring source ${entitySourceId} after ${failures} failures`);
    }
    await supabase.from('entity_sources').update(patch).eq('id', entitySourceId);
}

/**
 * The Supabase-backed snapshot store. Injectable so the rules above can be tested
 * without a database — they are the part of this module most worth pinning.
 */
export const supabaseSnapshotStore = {
    latest: latestSnapshot,
    record: recordSnapshot,
    markChecked,
    markFailure,
};

/**
 * Fetch one watched source and decide whether it produced a signal.
 *
 * @param {Object} source   - row from getEntitySources()
 * @param {Object} deps
 * @param {Function} deps.scrape - (url) => Promise<string>, the shared scrape gateway
 * @param {string}   deps.runId
 * @param {Object}   [deps.store] - snapshot store; defaults to Supabase
 * @returns {Promise<Object|null>} an observation, or null for baseline/unchanged/failed
 */
export async function watchSource(source, { scrape, runId, store = supabaseSnapshotStore }) {
    const entityName = source.entity?.name || 'Unknown';
    let content;

    try {
        content = await scrape(source.url);
    } catch (err) {
        console.warn(`[SourceWatch] Fetch failed ${source.url}: ${err.message}`);
        await store.markFailure(source.id, source.consecutive_failures);
        return null;
    }

    // Too short to be a real page — a redirect stub, a JS shell, or a soft 404.
    if (!content || content.length < 500) {
        await store.markFailure(source.id, source.consecutive_failures);
        return null;
    }

    const contentHash = await hashContent(content);
    const previous = await store.latest(source.id);

    await store.record({ entitySourceId: source.id, runId, contentHash, extract: content });
    await store.markChecked(source.id);

    // Rule 1: first sighting is a baseline, never a signal.
    if (!previous) {
        console.log(`[SourceWatch] Baseline stored for ${entityName} ${source.source_type}`);
        return null;
    }

    // Rule 2: unchanged pages produce nothing.
    if (previous.content_hash === contentHash) return null;

    const diff = summarizeDiff(previous.extract, content);
    if (!diff) return null; // changed only in normalized-away noise

    console.log(`[SourceWatch] CHANGE on ${entityName} ${source.source_type} — ${source.url}`);

    // A dependency's status page is a different kind of claim from a rival's pricing
    // page: it is about the founder's own operating risk, not someone else's strategy.
    // Saying so explicitly stops the analyzer filing an AWS outage as competitor news.
    const isDependency = DEPENDENCY_SOURCE_TYPES.has(source.source_type);

    return {
        job: `${entityName} ${source.source_type} page changed`,
        theme: SOURCE_TYPE_THEME[source.source_type] || 'competitor_intel',
        source: 'Primary Source Watch',
        source_type: 'source_watch',
        source_class: 'primary_company',
        // Framed so the analyzer knows this is a first-party change, not a news report.
        data: `PRIMARY SOURCE CHANGE DETECTED\n`
            + `Entity: ${entityName}\n`
            + `Page type: ${source.source_type}\n`
            + `URL: ${source.url}\n`
            + `Previously read: ${previous.fetched_at || 'unknown'}\n\n`
            + (isDependency
                ? `This is the STATUS PAGE of a provider ${'the company'} depends on. A change here `
                    + `means service degradation or an incident at a dependency — an operating risk `
                    + `to the founder, NOT a competitor's move. Report it as dependency exposure.\n\n`
                : `This is the entity's OWN page, not a report about them. `
                    + `The change below is what differs since we last read it.\n\n`)
            + diff,
        url: source.url,
        title: isDependency
            ? `${entityName} — service status changed`
            : `${entityName} — ${source.source_type} changed`,
        published_date: new Date().toISOString().split('T')[0],
    };
}

/**
 * Watch a prioritized slice of a company's tracked sources.
 *
 * @param {Array} sources   - from getEntitySources(companyId)
 * @param {Object} deps     - { scrape, runId, limit, canAfford }
 * @returns {Promise<{ observations: Array, checked: number, changed: number }>}
 */
export async function watchSources(sources, { scrape, runId, limit = MAX_WATCH_FETCHES_PER_RUN, canAfford = () => true, store = supabaseSnapshotStore }) {
    const active = (sources || []).filter(s => s?.url && s?.id);
    if (active.length === 0) return { observations: [], checked: 0, changed: 0, failed: 0, read: 0 };

    const targets = prioritizeSources(active).slice(0, limit);
    const observations = [];
    let checked = 0;
    let failed = 0;

    // `watchSource` returns null for THREE different outcomes — baseline, unchanged, and
    // failed — which is fine for the pipeline (all three contribute nothing) but not for a
    // founder-facing claim. The Desk says "Bahirjee read 4 pages, nothing moved", and that
    // sentence must be true: a total scraper outage would otherwise render as a permanently
    // quiet morning, every morning, with nothing anywhere reporting a problem. Observed
    // live — four failed fetches were reported as four pages read.
    //
    // Counting through the store keeps watchSource's return contract intact (stepWatch and
    // its tests depend on it) while still telling the two apart, because markFailure is
    // called on exactly the failure paths.
    const counting = { ...store, markFailure: (...args) => { failed += 1; return store.markFailure(...args); } };

    for (const source of targets) {
        if (!canAfford()) break;
        const observation = await watchSource(source, { scrape, runId, store: counting });
        checked += 1;
        if (observation) observations.push(observation);
    }

    const read = checked - failed;
    console.log(`[SourceWatch] Attempted ${checked}/${active.length} source(s), ${read} read, ${failed} failed, ${observations.length} changed`);
    // `checked` keeps its original meaning (attempts) so stepWatch is unaffected; `read` and
    // `failed` are additive, and `read` is the only one safe to claim to a founder.
    return { observations, checked, changed: observations.length, failed, read };
}
