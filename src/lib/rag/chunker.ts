/**
 * Recursive character text splitter with sliding-window overlap.
 * Mimics LangChain's RecursiveCharacterTextSplitter behaviour.
 *
 * Default sizes come from schema.ts DEFAULTS so they stay in sync
 * with the SQL column constraints and embedding model limits.
 */
import { DEFAULTS } from "./schema";

export type Chunk = {
  content: string;
  chunkIndex: number;
  tokenCount: number;
  metadata: Record<string, unknown>;
};

export type ChunkOptions = {
  chunkSize?: number;       // target chunk size in chars (≈ tokens * 4)
  chunkOverlap?: number;    // overlap in chars
  separators?: string[];    // ordered list of separators to try
};

const DEFAULT_SEPARATORS = ["\n\n", "\n", ". ", "! ", "? ", " ", ""];

/** Rough token estimate: 1 token ≈ 4 chars for English text */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Split text at the first separator that produces pieces ≤ chunkSize */
function splitText(
  text: string,
  separators: string[],
  chunkSize: number
): string[] {
  for (const sep of separators) {
    const parts = sep ? text.split(sep) : text.split("");
    if (parts.length > 1) {
      // Re-join with separator so we don't lose it
      const rejoined: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const piece = i < parts.length - 1 ? parts[i] + sep : parts[i];
        if (piece) rejoined.push(piece);
      }
      // If at least one piece fits our chunk size, this separator works
      if (rejoined.some((p) => p.length <= chunkSize)) {
        return rejoined;
      }
    }
  }
  // Fallback: hard-split at chunkSize
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

/** Merge small pieces into chunks respecting chunkSize, with overlap */
function mergeChunks(
  pieces: string[],
  chunkSize: number,
  chunkOverlap: number
): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const piece of pieces) {
    if (current.length + piece.length > chunkSize && current.length > 0) {
      chunks.push(current.trimEnd());
      // Keep the overlapping tail of the current chunk
      const overlapStart = Math.max(0, current.length - chunkOverlap);
      current = current.slice(overlapStart) + piece;
    } else {
      current += piece;
    }
  }
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks;
}

/**
 * Split a document into chunks using recursive character splitting.
 * Returns an array of Chunk objects ready to embed and store.
 */
export function chunkDocument(
  content: string,
  metadata: Record<string, unknown> = {},
  options: ChunkOptions = {}
): Chunk[] {
  const {
    chunkSize = DEFAULTS.CHUNK_SIZE,
    chunkOverlap = DEFAULTS.CHUNK_OVERLAP,
    separators = DEFAULT_SEPARATORS,
  } = options;

  const pieces = splitText(content, separators, chunkSize);
  const rawChunks = mergeChunks(pieces, chunkSize, chunkOverlap);

  return rawChunks
    .map((text, i) => ({
      content: text.trim(),
      chunkIndex: i,
      tokenCount: estimateTokens(text),
      metadata: { ...metadata, chunkIndex: i, totalChunks: rawChunks.length },
    }))
    .filter((c) => c.content.length > 20); // drop trivially small chunks
}

/**
 * Clean and normalize raw text before chunking:
 * - Collapse excessive whitespace / blank lines
 * - Remove null bytes
 */
export function cleanText(text: string): string {
  return text
    .replace(/\0/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
