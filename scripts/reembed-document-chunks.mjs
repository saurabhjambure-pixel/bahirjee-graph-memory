#!/usr/bin/env node

/**
 * Re-embed every stored document chunk with the current embedding model.
 *
 * WHY THIS EXISTS
 * ---------------
 * Uploaded-document Q&A retrieves chunks by comparing a question's embedding against the
 * stored ones. Vectors are only comparable within one model: text-embedding-004 (retired
 * 2026-01-14) and gemini-embedding-001 place the same text in different spaces, so a new
 * query vector ranked against old stored vectors returns noise, not neighbours.
 *
 * `document_chunks.content` holds the original chunk text, so the stored vectors can be
 * rebuilt in place. Documents uploaded after the retirement likely never stored chunks at
 * all (the embed failed before insert) and have to be re-uploaded; this script cannot
 * recover text it was never given.
 *
 * Embeds through the same /api/gemini `embed` action the app uses (in-process, via
 * internalPostJson), so the model, dimensions and task type have one definition.
 *
 * USAGE
 *   node --env-file=.env scripts/reembed-document-chunks.mjs --dry-run   # count only
 *   node --env-file=.env scripts/reembed-document-chunks.mjs
 *
 * Needs VITE_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY.
 */

import { createClient } from '@supabase/supabase-js';
import { internalPostJson } from '../lib/_internalRouteClient.js';

const DRY_RUN = process.argv.includes('--dry-run');
const PAGE = 100; // the embed action's per-request cap

async function main() {
    const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('VITE_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required');
    if (!DRY_RUN && !process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');

    const sb = createClient(url, key);
    const { count, error: countErr } = await sb.from('document_chunks').select('id', { count: 'exact', head: true });
    if (countErr) throw new Error(`count failed: ${countErr.message}`);
    console.log(`\n${count ?? 0} stored chunk(s)${DRY_RUN ? ' — dry run, nothing written' : ''}`);
    if (DRY_RUN || !count) return;

    let done = 0;
    let failed = 0;
    // Keyset pagination on id: updating rows never reorders them, so no chunk is skipped
    // or visited twice the way offset pagination can.
    let after = null;
    for (;;) {
        let q = sb.from('document_chunks').select('id, content').order('id', { ascending: true }).limit(PAGE);
        if (after) q = q.gt('id', after);
        const { data: rows, error } = await q;
        if (error) throw new Error(`page read failed: ${error.message}`);
        if (!rows?.length) break;
        after = rows[rows.length - 1].id;

        const res = await internalPostJson('/api/gemini', {
            action: 'embed',
            payload: { texts: rows.map(r => r.content), taskType: 'RETRIEVAL_DOCUMENT' },
        });
        const body = await res.json();
        if (!res.ok || !Array.isArray(body.embeddings) || body.embeddings.length !== rows.length) {
            // Refuse a partial page rather than risk pairing a vector with the wrong row.
            console.error(`  ✗ page after ${rows[0].id}: ${body.error || `got ${body.embeddings?.length ?? 0} of ${rows.length} vectors`}`);
            failed += rows.length;
            continue;
        }

        for (let i = 0; i < rows.length; i++) {
            const { error: upErr } = await sb.from('document_chunks')
                .update({ embedding: body.embeddings[i] })
                .eq('id', rows[i].id);
            if (upErr) { failed++; console.error(`  ✗ ${rows[i].id}: ${upErr.message}`); }
            else done++;
        }
        process.stdout.write(`  re-embedded ${done}/${count}\r`);
    }

    console.log(`\n\nRe-embedded ${done} chunk(s)${failed ? `, ${failed} failed (safe to re-run)` : ''}.\n`);
    if (failed) process.exitCode = 1;
}

main().catch(e => { console.error('\nreembed failed:', e.message); process.exit(1); });
