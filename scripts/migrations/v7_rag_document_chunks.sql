-- ==========================================
-- BAHIRJEE — RAG: DOCUMENT CHUNKS (pgvector)
-- ==========================================
-- Stores chunked + embedded uploaded documents for retrieval-augmented Q&A.
-- Embeddings: Gemini text-embedding-004 (768 dimensions).
-- Run in Supabase SQL Editor. Requires the `vector` extension (pgvector).

create extension if not exists vector;

create table if not exists public.document_chunks (
  id uuid default gen_random_uuid() primary key,
  client_id uuid references public.clients(id) on delete cascade not null,
  report_id uuid references public.reports(id) on delete set null,
  website_url text,
  source_name text,
  chunk_index int not null default 0,
  content text not null,
  embedding vector(768),
  created_at timestamptz default timezone('utc'::text, now()) not null
);

create index if not exists idx_document_chunks_client on public.document_chunks(client_id);
-- Approximate-nearest-neighbour index for cosine distance.
create index if not exists idx_document_chunks_embedding
  on public.document_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

alter table public.document_chunks enable row level security;

drop policy if exists "Admins all document_chunks" on public.document_chunks;
create policy "Admins all document_chunks" on public.document_chunks for all
using (public.is_admin());

-- A client's members can read/write only their own company's chunks.
drop policy if exists "clients rw document_chunks" on public.document_chunks;
create policy "clients rw document_chunks" on public.document_chunks for all
using (client_id in (select client_id from public.profiles where id = auth.uid()))
with check (client_id in (select client_id from public.profiles where id = auth.uid()));

-- Cosine-similarity retrieval scoped to a client. Runs as invoker, so the RLS
-- policy above still constrains which rows are visible.
create or replace function public.match_document_chunks(
  p_client_id uuid,
  p_query_embedding vector(768),
  p_match_count int default 6
)
returns table (id uuid, content text, source_name text, similarity float)
language sql stable
as $$
  select dc.id, dc.content, dc.source_name,
         1 - (dc.embedding <=> p_query_embedding) as similarity
  from public.document_chunks dc
  where dc.client_id = p_client_id
    and dc.embedding is not null
  order by dc.embedding <=> p_query_embedding
  limit p_match_count;
$$;
