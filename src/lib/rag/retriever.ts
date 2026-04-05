import Anthropic from "@anthropic-ai/sdk";
import { supabase, HybridSearchResult } from "../supabase";
import { embedBatch } from "./embeddings";
import {
  TABLES,
  FUNCTIONS,
  DEFAULTS,
  type HybridSearchParams,
} from "./schema";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Types ────────────────────────────────────────────────────────────────────

export type RetrievedChunk = HybridSearchResult & {
  documentTitle?: string;
  documentSource?: string;
  rerankScore?: number;
};

export type RetrievalOptions = {
  topK?: number;              // final number of chunks to return
  candidateK?: number;        // broader candidate set before reranking
  semanticWeight?: number;    // 0–1 (default 0.7)
  fulltextWeight?: number;    // 0–1 (default 0.3)
  useQueryExpansion?: boolean;
  useReranking?: boolean;
  filterMetadata?: Record<string, unknown>;
};

// ─── Query Expansion ──────────────────────────────────────────────────────────

/**
 * Use Claude to generate multiple paraphrased query variants.
 * Multi-query retrieval catches docs that one phrasing might miss.
 */
export async function expandQuery(query: string): Promise<string[]> {
  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `Generate 4 different search queries that capture the same information need as the original query, but with different phrasing, synonyms, or perspectives. Return ONLY a JSON array of strings — no explanation.

Original query: "${query}"

Example output format:
["query variant 1", "query variant 2", "query variant 3", "query variant 4"]`,
      },
    ],
  });

  try {
    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const variants: string[] = JSON.parse(match[0]);
      return [query, ...variants.slice(0, 4)];
    }
  } catch {
    // fall through
  }
  return [query];
}

// ─── Hybrid Search ────────────────────────────────────────────────────────────

/**
 * Run hybrid search (semantic + BM25) against Supabase via RRF fusion.
 */
async function hybridSearch(
  query: string,
  embedding: number[],
  k: number,
  semanticWeight: number,
  fulltextWeight: number,
  filterMetadata?: Record<string, unknown>
): Promise<HybridSearchResult[]> {
  const params: HybridSearchParams = {
    query_text: query,
    query_embedding: embedding,
    match_count: k,
    semantic_weight: semanticWeight,
    fulltext_weight: fulltextWeight,
    rrf_k: DEFAULTS.RRF_K,
    filter_metadata: filterMetadata ?? null,
  };

  const { data, error } = await supabase.rpc(FUNCTIONS.HYBRID_SEARCH, params);

  if (error) throw new Error(`Hybrid search failed: ${error.message}`);
  return (data as HybridSearchResult[]) ?? [];
}

// ─── RRF Fusion for multi-query results ───────────────────────────────────────

/**
 * Merge and re-rank results from multiple queries using RRF.
 * Deduplicates by chunk id.
 */
function fuseResults(
  resultSets: HybridSearchResult[][],
  k: number = 60
): HybridSearchResult[] {
  const scoreMap = new Map<string, { chunk: HybridSearchResult; score: number }>();

  for (const results of resultSets) {
    results.forEach((chunk, rank) => {
      const existing = scoreMap.get(chunk.id);
      const addedScore = 1 / (k + rank + 1);
      if (existing) {
        existing.score += addedScore;
      } else {
        scoreMap.set(chunk.id, { chunk, score: addedScore });
      }
    });
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map(({ chunk }) => chunk);
}

// ─── LLM Reranker ────────────────────────────────────────────────────────────

/**
 * Use Claude to score each chunk for relevance to the query.
 * Returns chunks sorted by relevance (highest first).
 */
export async function rerankChunks(
  query: string,
  chunks: HybridSearchResult[]
): Promise<RetrievedChunk[]> {
  if (chunks.length === 0) return [];

  const chunkList = chunks
    .map((c, i) => `[${i}] ${c.content.slice(0, 500)}`)
    .join("\n\n---\n\n");

  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `Score each passage for relevance to the query. Return ONLY a JSON array of objects with "index" (0-based) and "score" (0.0–1.0). No explanation.

Query: "${query}"

Passages:
${chunkList}

Return format: [{"index": 0, "score": 0.9}, {"index": 1, "score": 0.3}, ...]`,
      },
    ],
  });

  try {
    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const scores: Array<{ index: number; score: number }> = JSON.parse(
        match[0]
      );
      const ranked = scores
        .sort((a, b) => b.score - a.score)
        .map(({ index, score }) => ({
          ...chunks[index],
          rerankScore: score,
        }));
      return ranked as RetrievedChunk[];
    }
  } catch {
    // fall through to unranked
  }

  return chunks.map((c) => ({ ...c, rerankScore: undefined }));
}

// ─── Enrich with document metadata ───────────────────────────────────────────

async function enrichWithDocumentInfo(
  chunks: HybridSearchResult[]
): Promise<RetrievedChunk[]> {
  const docIds = [...new Set(chunks.map((c) => c.document_id))];

  const { data: docs } = await supabase
    .from(TABLES.DOCUMENTS)
    .select("id, title, source")
    .in("id", docIds);

  const docMap = new Map(
    (docs ?? []).map((d: { id: string; title: string; source: string }) => [
      d.id,
      d,
    ])
  );

  return chunks.map((c) => {
    const doc = docMap.get(c.document_id) as
      | { title: string; source: string }
      | undefined;
    return {
      ...c,
      documentTitle: doc?.title,
      documentSource: doc?.source,
    };
  });
}

// ─── Main Retrieval Pipeline ──────────────────────────────────────────────────

/**
 * Full advanced RAG retrieval:
 * 1. Optional query expansion (multi-query)
 * 2. Hybrid search (semantic + BM25 via RRF) for each query variant
 * 3. Multi-query RRF fusion
 * 4. Optional LLM reranking
 * 5. Enrich with document metadata
 */
export async function retrieve(
  query: string,
  options: RetrievalOptions = {}
): Promise<RetrievedChunk[]> {
  const {
    topK = DEFAULTS.TOP_K,
    candidateK = DEFAULTS.CANDIDATE_K,
    semanticWeight = DEFAULTS.SEMANTIC_WEIGHT,
    fulltextWeight = DEFAULTS.FULLTEXT_WEIGHT,
    useQueryExpansion = true,
    useReranking = true,
    filterMetadata,
  } = options;

  // Step 1: Query expansion
  const queries = useQueryExpansion
    ? await expandQuery(query)
    : [query];

  // Step 2: Embed all query variants in parallel
  const embeddings = await embedBatch(queries);

  // Step 3: Hybrid search for each query variant
  const searchPromises = queries.map((q, i) =>
    hybridSearch(
      q,
      embeddings[i],
      candidateK,
      semanticWeight,
      fulltextWeight,
      filterMetadata
    )
  );
  const resultSets = await Promise.all(searchPromises);

  // Step 4: Fuse multi-query results
  const fused = fuseResults(resultSets).slice(0, candidateK);

  if (fused.length === 0) return [];

  // Step 5: Optional LLM reranking
  const reranked = useReranking
    ? await rerankChunks(query, fused)
    : fused.map((c) => ({ ...c, rerankScore: undefined }));

  // Step 6: Take top-K and enrich with document info
  const topChunks = reranked.slice(0, topK);
  return enrichWithDocumentInfo(topChunks);
}
