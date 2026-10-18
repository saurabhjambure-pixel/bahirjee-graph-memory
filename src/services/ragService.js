// RAG Service — chunk, embed, store, and retrieve knowledge for grounded Q&A.
//
// Replaces the old "dump the whole (truncated) document into the prompt" approach.
// document_chunks (pgvector, Gemini gemini-embedding-001, 768-dim) started as an
// uploaded-document store; v32_knowledge_chunks.sql widened it with a `kind` column so the
// SAME store also holds embedded signals and observations (ingestSignals / ingestObservation
// below) — a question like "has this competitor changed pricing before?" is then a cosine
// query over evidence the platform already has, instead of falling straight through to a
// live web search for something a past run already found. At Q&A time we embed the
// question and pull the most similar chunks — of whichever kind the caller asks for — via
// the match_document_chunks RPC.

import { supabase } from '../lib/supabase.js';
import { postJson } from './apiClient.js';

const viteEnv = typeof import.meta !== 'undefined' ? import.meta.env || {} : {};
const API_BASE = viteEnv.VITE_API_BASE_URL || '/api';

const CHUNK_SIZE = 1200;      // ~300 tokens
const CHUNK_OVERLAP = 150;
const EMBED_BATCH = 100;      // Gemini batchEmbedContents cap enforced server-side

/**
 * Split text into overlapping chunks, preferring paragraph/sentence boundaries so
 * chunks stay semantically coherent.
 * @returns {string[]}
 */
export function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
    const clean = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!clean) return [];
    if (clean.length <= size) return [clean];

    const chunks = [];
    let start = 0;
    while (start < clean.length) {
        let end = Math.min(start + size, clean.length);
        if (end < clean.length) {
            // Prefer to break on a paragraph, then a sentence, then whitespace.
            const window = clean.slice(start, end);
            const breakAt = Math.max(
                window.lastIndexOf('\n\n'),
                window.lastIndexOf('. '),
                window.lastIndexOf('\n')
            );
            if (breakAt > size * 0.5) end = start + breakAt + 1;
        }
        const piece = clean.slice(start, end).trim();
        if (piece) chunks.push(piece);
        if (end >= clean.length) break;
        start = end - overlap; // overlap for context continuity
    }
    return chunks;
}

/**
 * Embed an array of strings via the Gemini gateway.
 *
 * `postJsonFn` defaults to the plain browser POST (this file's only caller used to be the
 * browser upload flow), but stepPersist and askBahirjee's server-side write-back both need
 * intelligenceRuntime.postJson instead — the in-process dispatcher the worker installs, since
 * a relative '/api/gemini' fetch has no origin to resolve against outside a browser. Pass it
 * explicitly rather than importing intelligenceService.js here, which would pull the entire
 * pipeline into this file's dependency graph for one function pointer.
 *
 * @returns {Promise<number[][]>} embeddings aligned to input order
 */
export async function embedTexts(texts, options = {}) {
    const postJsonFn = typeof options === 'function' ? options : (options?.postJsonFn || postJson);
    const taskType = (typeof options === 'object' && options?.taskType) || 'RETRIEVAL_DOCUMENT';
    const list = (texts || []).filter(t => typeof t === 'string' && t.trim());
    if (list.length === 0) return [];

    const all = [];
    for (let i = 0; i < list.length; i += EMBED_BATCH) {
        const batch = list.slice(i, i + EMBED_BATCH);
        const res = await postJsonFn(`${API_BASE}/gemini`, { action: 'embed', payload: { texts: batch, taskType } });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Embedding failed (${res.status})`);
        }
        const data = await res.json();
        all.push(...(data.embeddings || []));
    }
    return all;
}

/**
 * Chunk + embed + store an uploaded document. Non-blocking by design at call sites —
 * a failure here must never break the main upload/analysis flow.
 * Replaces any prior chunks for the same (client, source, url) to avoid duplicates.
 * @returns {Promise<{ stored: number, error?: string }>}
 */
export async function ingestDocument({ clientId, reportId = null, websiteUrl = null, sourceName = 'uploaded-document', text, postJsonFn }) {
    if (!supabase) return { stored: 0, error: 'Supabase unavailable' };
    if (!clientId || !text) return { stored: 0, error: 'clientId and text required' };

    try {
        const chunks = chunkText(text);
        if (chunks.length === 0) return { stored: 0 };

        // Embed BEFORE clearing the old chunks. This used to delete first: when the
        // embedding model was retired, every re-upload wiped the document's existing chunks
        // and stored nothing in their place. A failed embed now leaves the old ones intact.
        const embeddings = await embedTexts(chunks, { taskType: 'RETRIEVAL_DOCUMENT', postJsonFn });
        if (embeddings.length === 0) return { stored: 0, error: 'No embeddings produced' };

        // Clear previous chunks for this source so re-uploads don't accumulate.
        await supabase
            .from('document_chunks')
            .delete()
            .eq('client_id', clientId)
            .eq('source_name', sourceName)
            .eq('website_url', websiteUrl);
        if (embeddings.length !== chunks.length) {
            console.warn(`[RAG] Embedding count (${embeddings.length}) != chunk count (${chunks.length}); storing the overlap.`);
        }

        const rows = chunks.map((content, i) => ({
            client_id: clientId,
            report_id: reportId,
            website_url: websiteUrl,
            source_name: sourceName,
            kind: 'uploaded_doc',
            chunk_index: i,
            content,
            embedding: embeddings[i] || null,
        })).filter(r => r.embedding);

        if (rows.length === 0) return { stored: 0, error: 'No embeddings produced' };

        const { error, insertedRows } = await insertChunksWithKindTolerance(rows);
        if (error) return { stored: 0, error: error.message };

        console.log(`[RAG] Ingested ${insertedRows.length} chunks for "${sourceName}"`);
        return { stored: insertedRows.length };
    } catch (err) {
        console.error('[RAG] ingestDocument failed:', err.message);
        return { stored: 0, error: err.message };
    }
}

/**
 * Insert document_chunks rows, retrying without `kind`/`source_url` if the database has not
 * run v32_knowledge_chunks.sql yet — the same migration-tolerance pattern used throughout
 * this session (structuredSignalTransformer.js's corroborating_urls, v17). Without this, an
 * unmigrated database would reject every chunk insert, not just miss the new kind/source_url
 * fields — worse than the feature this file is adding.
 */
let hasKindColumns = true;
async function insertChunksWithKindTolerance(rows) {
    const insertedRows = hasKindColumns ? rows : rows.map(({ kind, source_url, ...rest }) => rest);
    let { error } = await supabase.from('document_chunks').insert(insertedRows);
    if (error?.code === 'PGRST204' && /kind|source_url/i.test(error.message || '')) {
        console.warn('[RAG] document_chunks.kind/source_url unavailable (run scripts/migrations/v32_knowledge_chunks.sql); retrying without them.');
        hasKindColumns = false;
        const stripped = rows.map(({ kind, source_url, ...rest }) => rest);
        ({ error } = await supabase.from('document_chunks').insert(stripped));
        return { error, insertedRows: error ? [] : stripped };
    }
    return { error, insertedRows: error ? [] : insertedRows };
}

/**
 * Embed and store a company's signals as retrievable knowledge (v29). Called from
 * stepPersist, alongside the other context-layer writes — non-blocking there, and never
 * throws here, by the same contract as every sibling context-layer writer in this pipeline:
 * a failed embed costs the NEXT question a web search it could have skipped, which is
 * strictly better than failing the run in progress.
 *
 * One chunk per signal (headline + entity + details is short enough that chunkText's
 * paragraph-splitting almost never fires) rather than running full document chunking — the
 * point is retrieval granularity at the signal level, not squeezing more chunks out of one.
 *
 * @returns {Promise<{ stored: number, error?: string }>}
 */
export async function ingestSignals({ clientId, signals, reportId = null, postJsonFn }) {
    if (!supabase) return { stored: 0, error: 'Supabase unavailable' };
    if (!clientId || !Array.isArray(signals) || signals.length === 0) return { stored: 0 };

    try {
        const usable = signals
            .map(s => ({
                text: [
                    s?.signal_headline || s?.headline || s?.the_move,
                    s?.entity_name || s?.entity_involved || s?.entity,
                    s?.signal_details || s?.the_move,
                ].filter(Boolean).join(' — '),
                sourceUrl: s?.source_url || null,
                sourceName: (s?.signal_headline || s?.headline || 'signal').slice(0, 200),
            }))
            .filter(s => s.text.trim().length > 0);
        if (usable.length === 0) return { stored: 0 };

        const embeddings = await embedTexts(usable.map(s => s.text), postJsonFn);
        const rows = usable.map((s, i) => ({
            client_id: clientId,
            report_id: reportId,
            source_name: s.sourceName,
            source_url: s.sourceUrl,
            kind: 'signal',
            chunk_index: 0,
            content: s.text,
            embedding: embeddings[i] || null,
        })).filter(r => r.embedding);
        if (rows.length === 0) return { stored: 0, error: 'No embeddings produced' };

        const { error, insertedRows } = await insertChunksWithKindTolerance(rows);
        if (error) return { stored: 0, error: error.message };
        console.log(`[RAG] Ingested ${insertedRows.length} signal chunk(s)`);
        return { stored: insertedRows.length };
    } catch (err) {
        console.error('[RAG] ingestSignals failed:', err.message);
        return { stored: 0, error: err.message };
    }
}

/**
 * Embed and store ONE web finding as an observation (v29) — the write-back half of
 * askBahirjee's Stage 3: a confident answer that only came from a live web search is worth
 * remembering, or the next identical question pays for the same search again.
 *
 * @returns {Promise<{ stored: number, error?: string }>}
 */
export async function ingestObservation({ clientId, text, sourceUrl = null, sourceName = null, postJsonFn }) {
    if (!supabase) return { stored: 0, error: 'Supabase unavailable' };
    if (!clientId || !text?.trim()) return { stored: 0, error: 'clientId and text required' };

    try {
        const [embedding] = await embedTexts([text], postJsonFn);
        if (!embedding) return { stored: 0, error: 'No embedding produced' };

        const row = {
            client_id: clientId,
            source_name: (sourceName || sourceUrl || 'web finding').slice(0, 200),
            source_url: sourceUrl,
            kind: 'observation',
            chunk_index: 0,
            content: text,
            embedding,
        };
        const { error, insertedRows } = await insertChunksWithKindTolerance([row]);
        if (error) return { stored: 0, error: error.message };
        console.log(`[RAG] Ingested 1 observation chunk from ${sourceUrl || 'the web'}`);
        return { stored: insertedRows.length };
    } catch (err) {
        console.error('[RAG] ingestObservation failed:', err.message);
        return { stored: 0, error: err.message };
    }
}

// Migration tolerance for the p_kinds argument (v29): PostgREST resolves an RPC by its
// exact declared parameter set, so calling a pre-v29 3-parameter function with a 4th named
// argument fails outright rather than degrading — there is no partial match to fall back
// to. Remembered per call, same as document_chunks.kind above, so a database that has not
// migrated pays this fallback once and then stops re-probing until the process restarts.
let supportsKindsFilter = true;

/**
 * Retrieve the most relevant knowledge chunks for a query, scoped to a client and
 * optionally to specific kinds (v29) — `['uploaded_doc']` for the original Q&A behaviour,
 * `['signal', 'observation']` for askBahirjee's Stage 1 knowledge-base lookup, or omitted
 * for every kind at once.
 * @returns {Promise<Array<{ content: string, source_name: string, source_url: string|null, kind: string, similarity: number }>>}
 */
export async function retrieveRelevantChunks({ clientId, query, topK = 6, kinds = null, postJsonFn }) {
    if (!supabase || !clientId || !query) return [];
    try {
        const [queryEmbedding] = await embedTexts([query], { taskType: 'RETRIEVAL_QUERY', postJsonFn });
        if (!queryEmbedding) return [];

        const payload = { p_client_id: clientId, p_query_embedding: queryEmbedding, p_match_count: topK };
        if (kinds && supportsKindsFilter) payload.p_kinds = kinds;

        let { data, error } = await supabase.rpc('match_document_chunks', payload);
        if (error && kinds && supportsKindsFilter && /p_kinds|match_document_chunks/i.test(error.message || '')) {
            console.warn('[RAG] match_document_chunks p_kinds unavailable (run scripts/migrations/v32_knowledge_chunks.sql); retrying without a kind filter.');
            supportsKindsFilter = false;
            const { p_kinds, ...withoutKinds } = payload;
            ({ data, error } = await supabase.rpc('match_document_chunks', withoutKinds));
        }
        if (error) {
            console.warn('[RAG] match_document_chunks failed:', error.message);
            return [];
        }
        return data || [];
    } catch (err) {
        console.warn('[RAG] retrieveRelevantChunks failed:', err.message);
        return [];
    }
}
