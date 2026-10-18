-- ============================================================================
-- v32 — document_chunks becomes a knowledge store, not just an upload store
--
-- askBahirjee's Q&A is already context-first in INTENT — it grounds on the confirmed
-- context before ever calling Tavily — but "context" meant only the compressed context
-- object plus document_chunks, and document_chunks held ONLY the founder's uploaded
-- documents. A question like "has this competitor changed pricing before?" therefore
-- fell through to a live web search for something a past run had already found and
-- persisted as a signal or an observation — the platform paying, in latency and a Tavily
-- call, to re-discover its own evidence.
--
-- This widens document_chunks with a `kind` column so the SAME pgvector store and the SAME
-- match_document_chunks RPC (v7_rag_document_chunks.sql) also hold embedded signals and
-- observations, retrievable by semantic similarity alongside uploaded-doc excerpts — one
-- store, one RPC, filterable by kind rather than a second table with its own index and
-- policies to keep in sync.
--
-- DEPENDENCIES: v7_rag_document_chunks.sql (document_chunks, match_document_chunks, the
-- `vector` extension). Idempotent. Safe to re-run.
-- ============================================================================

-- ── 1. kind + a real source_url ─────────────────────────────────────────────

ALTER TABLE public.document_chunks
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'uploaded_doc',
    -- Nullable and separate from source_name: an uploaded document has a filename worth
    -- showing (source_name) but no URL; a signal or observation has both a short label AND
    -- a real, citable URL — collapsing them into one column would lose whichever the chunk
    -- didn't happen to have.
    ADD COLUMN IF NOT EXISTS source_url TEXT;

-- Separate CHECK, not inline on the column — same reason v25_entity_categories.sql widened
-- tracked_entities.category this way rather than re-adding the column: a value this enum
-- can't yet hold ('context_narrative', maybe, later) must be addable without touching the
-- column itself.
ALTER TABLE public.document_chunks DROP CONSTRAINT IF EXISTS document_chunks_kind_check;
ALTER TABLE public.document_chunks ADD CONSTRAINT document_chunks_kind_check
    CHECK (kind IN ('uploaded_doc', 'signal', 'observation'));

CREATE INDEX IF NOT EXISTS idx_document_chunks_client_kind
ON public.document_chunks (client_id, kind);

-- ── 2. filterable retrieval ──────────────────────────────────────────────────
--
-- Adds p_kinds with a NULL default — every existing caller (uploaded-doc Q&A) keeps
-- calling this with three arguments and keeps getting exactly what it got before; only a
-- caller that supplies p_kinds narrows the search.

CREATE OR REPLACE FUNCTION public.match_document_chunks(
    p_client_id uuid,
    p_query_embedding vector(768),
    p_match_count int DEFAULT 6,
    p_kinds text[] DEFAULT NULL
)
RETURNS TABLE (id uuid, content text, source_name text, source_url text, kind text, similarity float)
LANGUAGE sql STABLE
AS $$
  SELECT dc.id, dc.content, dc.source_name, dc.source_url, dc.kind,
         1 - (dc.embedding <=> p_query_embedding) AS similarity
  FROM public.document_chunks dc
  WHERE dc.client_id = p_client_id
    AND dc.embedding IS NOT NULL
    AND (p_kinds IS NULL OR dc.kind = ANY(p_kinds))
  ORDER BY dc.embedding <=> p_query_embedding
  LIMIT p_match_count;
$$;
