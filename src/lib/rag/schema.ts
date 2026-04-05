/**
 * RAG System — Supabase Schema Constants
 *
 * Single source of truth for every table, view, function, and column name
 * used in the RAG pipeline. Import from here instead of using raw strings.
 *
 * Mirrors: supabase/migrations/001_rag_setup.sql
 */

// ─── Tables ───────────────────────────────────────────────────────────────────

export const TABLES = {
  /** Stores original full documents before chunking */
  DOCUMENTS: "documents",
  /** Stores chunked + embedded pieces of documents */
  CHUNKS: "document_chunks",
} as const;

// ─── Views ────────────────────────────────────────────────────────────────────

export const VIEWS = {
  /** Aggregated document metadata: chunk_count, total_tokens, etc. */
  DOCUMENT_STATS: "document_stats",
} as const;

// ─── RPC Functions ────────────────────────────────────────────────────────────

export const FUNCTIONS = {
  /**
   * Hybrid search using Reciprocal Rank Fusion.
   * Combines pgvector cosine similarity + tsvector BM25.
   */
  HYBRID_SEARCH: "hybrid_search",
  /**
   * Pure semantic (vector cosine) search.
   */
  SEMANTIC_SEARCH: "semantic_search",
  /**
   * Pure full-text (BM25-like) search via tsvector.
   */
  FULLTEXT_SEARCH: "fulltext_search",
} as const;

// ─── Column names ─────────────────────────────────────────────────────────────

export const COLUMNS = {
  DOCUMENTS: {
    ID: "id",
    TITLE: "title",
    SOURCE: "source",
    CONTENT: "content",
    METADATA: "metadata",
    CREATED_AT: "created_at",
    UPDATED_AT: "updated_at",
  },
  CHUNKS: {
    ID: "id",
    DOCUMENT_ID: "document_id",
    CONTENT: "content",
    EMBEDDING: "embedding",
    CHUNK_INDEX: "chunk_index",
    TOKEN_COUNT: "token_count",
    METADATA: "metadata",
    TSV: "tsv",
    CREATED_AT: "created_at",
  },
  DOCUMENT_STATS: {
    ID: "id",
    TITLE: "title",
    SOURCE: "source",
    CREATED_AT: "created_at",
    CHUNK_COUNT: "chunk_count",
    TOTAL_TOKENS: "total_tokens",
  },
} as const;

// ─── RPC Parameter shapes ─────────────────────────────────────────────────────

/** Parameters for the hybrid_search() Postgres function */
export type HybridSearchParams = {
  query_text: string;
  query_embedding: number[];
  match_count?: number;
  semantic_weight?: number;
  fulltext_weight?: number;
  rrf_k?: number;
  filter_metadata?: Record<string, unknown> | null;
};

/** Parameters for the semantic_search() Postgres function */
export type SemanticSearchParams = {
  query_embedding: number[];
  match_count?: number;
  min_similarity?: number;
  filter_metadata?: Record<string, unknown> | null;
};

/** Parameters for the fulltext_search() Postgres function */
export type FulltextSearchParams = {
  query_text: string;
  match_count?: number;
  filter_metadata?: Record<string, unknown> | null;
};

// ─── Row shapes (mirror DB schema) ────────────────────────────────────────────

/** A row in the `documents` table */
export type DocumentRow = {
  id: string;
  title: string;
  source: string | null;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

/** A row in the `document_chunks` table (embedding omitted — large array) */
export type ChunkRow = {
  id: string;
  document_id: string;
  content: string;
  chunk_index: number;
  token_count: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

/** A row returned by the `document_stats` view */
export type DocumentStatRow = {
  id: string;
  title: string;
  source: string | null;
  created_at: string;
  chunk_count: number;
  total_tokens: number | null;
};

/** A row returned by hybrid_search() */
export type HybridSearchRow = {
  id: string;
  document_id: string;
  content: string;
  metadata: Record<string, unknown>;
  chunk_index: number;
  rrf_score: number;
  sem_rank: number | null;
  fts_rank: number | null;
};

/** A row returned by semantic_search() */
export type SemanticSearchRow = {
  id: string;
  document_id: string;
  content: string;
  metadata: Record<string, unknown>;
  chunk_index: number;
  similarity: number;
};

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULTS = {
  /** Embedding model dimensions (must match the VECTOR(n) column) */
  EMBEDDING_DIMENSIONS: 1536,
  /** Default candidate count before reranking */
  CANDIDATE_K: 20,
  /** Final top-K chunks returned to the caller */
  TOP_K: 6,
  /** Semantic weight in hybrid search (0–1) */
  SEMANTIC_WEIGHT: 0.7,
  /** Full-text weight in hybrid search (0–1) */
  FULLTEXT_WEIGHT: 0.3,
  /** RRF smoothing constant */
  RRF_K: 60,
  /** Chunk size in characters (~300 tokens @ 4 chars/token) */
  CHUNK_SIZE: 1200,
  /** Overlap between consecutive chunks in characters */
  CHUNK_OVERLAP: 200,
} as const;
