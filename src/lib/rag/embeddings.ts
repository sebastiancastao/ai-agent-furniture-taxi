import OpenAI from "openai";
import { DEFAULTS } from "./schema";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const EMBEDDING_MODEL = "text-embedding-3-small";
// Dimension must match the VECTOR(n) column in 001_rag_setup.sql — kept in sync via DEFAULTS
export const EMBEDDING_DIMENSIONS = DEFAULTS.EMBEDDING_DIMENSIONS;
export const EMBED_BATCH_SIZE = 100; // OpenAI limit per request

/**
 * Embed a single text string.
 */
export async function embedText(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.replace(/\n/g, " "),
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data[0].embedding;
}

/**
 * Embed multiple texts in batches (respects OpenAI rate limits).
 * Returns embeddings in the same order as the input texts.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts
      .slice(i, i + EMBED_BATCH_SIZE)
      .map((t) => t.replace(/\n/g, " "));

    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
      dimensions: EMBEDDING_DIMENSIONS,
    });

    // OpenAI returns results in order by index
    const sorted = response.data.sort((a, b) => a.index - b.index);
    embeddings.push(...sorted.map((d) => d.embedding));

    // Small back-off between batches to be polite to the API
    if (i + EMBED_BATCH_SIZE < texts.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return embeddings;
}
