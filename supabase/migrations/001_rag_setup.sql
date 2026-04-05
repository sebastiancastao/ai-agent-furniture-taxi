-- ============================================================
-- Advanced RAG System: Supabase Migration
-- ============================================================
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Enable pg_trgm for fuzzy search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- TABLES
-- ============================================================

-- Documents table: stores original documents
CREATE TABLE IF NOT EXISTS documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  source      TEXT,                          -- file name, URL, etc.
  content     TEXT NOT NULL,                 -- full raw content
  metadata    JSONB DEFAULT '{}',            -- arbitrary metadata
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Chunks table: stores chunked + embedded pieces of documents
CREATE TABLE IF NOT EXISTS document_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content       TEXT NOT NULL,               -- chunk text
  embedding     VECTOR(1536),               -- OpenAI text-embedding-3-small
  chunk_index   INTEGER NOT NULL,           -- position within document
  token_count   INTEGER,                    -- approximate token count
  metadata      JSONB DEFAULT '{}',         -- inherited + chunk-level metadata
  tsv           TSVECTOR,                   -- for full-text (BM25) search
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================

-- HNSW index for fast approximate nearest-neighbor vector search
CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx
  ON document_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- GIN index for full-text search
CREATE INDEX IF NOT EXISTS document_chunks_tsv_idx
  ON document_chunks
  USING GIN (tsv);

-- Index on document_id for fast joins
CREATE INDEX IF NOT EXISTS document_chunks_document_id_idx
  ON document_chunks (document_id);

-- Trigram index for fuzzy/partial text matching
CREATE INDEX IF NOT EXISTS document_chunks_content_trgm_idx
  ON document_chunks
  USING GIN (content gin_trgm_ops);

-- ============================================================
-- TRIGGERS: auto-update tsvector and updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_tsv()
RETURNS TRIGGER AS $$
BEGIN
  NEW.tsv := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_chunks_tsv_trigger
  BEFORE INSERT OR UPDATE ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION update_tsv();

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documents_updated_at_trigger
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- FUNCTION: Semantic search (cosine similarity)
-- ============================================================
CREATE OR REPLACE FUNCTION semantic_search(
  query_embedding  VECTOR(1536),
  match_count      INT     DEFAULT 20,
  min_similarity   FLOAT   DEFAULT 0.0,
  filter_metadata  JSONB   DEFAULT NULL
)
RETURNS TABLE (
  id           UUID,
  document_id  UUID,
  content      TEXT,
  metadata     JSONB,
  chunk_index  INTEGER,
  similarity   FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    dc.id,
    dc.document_id,
    dc.content,
    dc.metadata,
    dc.chunk_index,
    1 - (dc.embedding <=> query_embedding) AS similarity
  FROM document_chunks dc
  WHERE
    dc.embedding IS NOT NULL
    AND (filter_metadata IS NULL OR dc.metadata @> filter_metadata)
    AND 1 - (dc.embedding <=> query_embedding) >= min_similarity
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ============================================================
-- FUNCTION: Full-text (BM25-like) search
-- ============================================================
CREATE OR REPLACE FUNCTION fulltext_search(
  query_text      TEXT,
  match_count     INT   DEFAULT 20,
  filter_metadata JSONB DEFAULT NULL
)
RETURNS TABLE (
  id          UUID,
  document_id UUID,
  content     TEXT,
  metadata    JSONB,
  chunk_index INTEGER,
  rank        FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    dc.id,
    dc.document_id,
    dc.content,
    dc.metadata,
    dc.chunk_index,
    ts_rank_cd(dc.tsv, websearch_to_tsquery('english', query_text))::FLOAT AS rank
  FROM document_chunks dc
  WHERE
    dc.tsv @@ websearch_to_tsquery('english', query_text)
    AND (filter_metadata IS NULL OR dc.metadata @> filter_metadata)
  ORDER BY rank DESC
  LIMIT match_count;
$$;

-- ============================================================
-- FUNCTION: Hybrid search using Reciprocal Rank Fusion (RRF)
-- Combines semantic + full-text results with configurable weights
-- ============================================================
CREATE OR REPLACE FUNCTION hybrid_search(
  query_text       TEXT,
  query_embedding  VECTOR(1536),
  match_count      INT   DEFAULT 10,
  semantic_weight  FLOAT DEFAULT 0.7,
  fulltext_weight  FLOAT DEFAULT 0.3,
  rrf_k           INT   DEFAULT 60,
  filter_metadata  JSONB DEFAULT NULL
)
RETURNS TABLE (
  id           UUID,
  document_id  UUID,
  content      TEXT,
  metadata     JSONB,
  chunk_index  INTEGER,
  rrf_score    FLOAT,
  sem_rank     BIGINT,
  fts_rank     BIGINT
)
LANGUAGE sql STABLE
AS $$
  WITH
  -- Semantic search results (top 40 candidates)
  sem AS (
    SELECT
      dc.id,
      ROW_NUMBER() OVER (ORDER BY dc.embedding <=> query_embedding) AS rank,
      1 - (dc.embedding <=> query_embedding) AS similarity
    FROM document_chunks dc
    WHERE
      dc.embedding IS NOT NULL
      AND (filter_metadata IS NULL OR dc.metadata @> filter_metadata)
    ORDER BY dc.embedding <=> query_embedding
    LIMIT 40
  ),
  -- Full-text search results (top 40 candidates)
  fts AS (
    SELECT
      dc.id,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(dc.tsv, websearch_to_tsquery('english', query_text)) DESC) AS rank
    FROM document_chunks dc
    WHERE
      dc.tsv @@ websearch_to_tsquery('english', query_text)
      AND (filter_metadata IS NULL OR dc.metadata @> filter_metadata)
    ORDER BY ts_rank_cd(dc.tsv, websearch_to_tsquery('english', query_text)) DESC
    LIMIT 40
  ),
  -- Compute RRF scores, merging both result sets
  fused AS (
    SELECT
      COALESCE(sem.id, fts.id) AS id,
      COALESCE(
        semantic_weight  * (1.0 / (rrf_k + COALESCE(sem.rank, 1000))),
        0
      ) +
      COALESCE(
        fulltext_weight * (1.0 / (rrf_k + COALESCE(fts.rank, 1000))),
        0
      ) AS rrf_score,
      sem.rank AS sem_rank,
      fts.rank AS fts_rank
    FROM sem
    FULL OUTER JOIN fts ON sem.id = fts.id
  )
  SELECT
    dc.id,
    dc.document_id,
    dc.content,
    dc.metadata,
    dc.chunk_index,
    fused.rrf_score,
    fused.sem_rank,
    fused.fts_rank
  FROM fused
  JOIN document_chunks dc ON dc.id = fused.id
  ORDER BY fused.rrf_score DESC
  LIMIT match_count;
$$;

-- ============================================================
-- FUNCTION: Get document with its chunks (for inspection)
-- ============================================================
CREATE OR REPLACE FUNCTION get_document_chunks(doc_id UUID)
RETURNS TABLE (
  chunk_id    UUID,
  content     TEXT,
  chunk_index INTEGER,
  token_count INTEGER,
  metadata    JSONB
)
LANGUAGE sql STABLE
AS $$
  SELECT id, content, chunk_index, token_count, metadata
  FROM document_chunks
  WHERE document_id = doc_id
  ORDER BY chunk_index;
$$;

-- ============================================================
-- ROW LEVEL SECURITY (optional — enable if using Supabase Auth)
-- ============================================================
-- ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- USEFUL VIEWS
-- ============================================================

CREATE OR REPLACE VIEW document_stats AS
SELECT
  d.id,
  d.title,
  d.source,
  d.created_at,
  COUNT(dc.id)         AS chunk_count,
  SUM(dc.token_count)  AS total_tokens
FROM documents d
LEFT JOIN document_chunks dc ON dc.document_id = d.id
GROUP BY d.id, d.title, d.source, d.created_at
ORDER BY d.created_at DESC;
