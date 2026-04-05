import Anthropic from "@anthropic-ai/sdk";
import { RetrievedChunk } from "./retriever";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type Citation = {
  chunkId: string;
  documentId: string;
  documentTitle?: string;
  documentSource?: string;
  chunkIndex: number;
  excerpt: string;
};

export type GenerationResult = {
  answer: string;
  citations: Citation[];
  contextUsed: number; // number of chunks actually used
};

/**
 * Compress a retrieved chunk to only the sentences relevant to the query.
 * Reduces context window usage while preserving signal.
 */
export async function compressChunk(
  query: string,
  chunk: string
): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 400,
    messages: [
      {
        role: "user",
        content: `Extract ONLY the sentences from the passage that are directly relevant to answering the question. Preserve exact wording. If nothing is relevant, return "NOT_RELEVANT".

Question: ${query}

Passage:
${chunk}

Relevant sentences only:`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text.trim() : "";
  return text === "NOT_RELEVANT" ? "" : text;
}

/**
 * Build the context block from retrieved chunks.
 * Optionally compresses each chunk.
 */
async function buildContext(
  query: string,
  chunks: RetrievedChunk[],
  useCompression: boolean
): Promise<{ contextText: string; citations: Citation[] }> {
  const citations: Citation[] = [];
  const contextParts: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let content = chunk.content;

    if (useCompression) {
      const compressed = await compressChunk(query, content);
      if (!compressed) continue; // skip irrelevant chunks
      content = compressed;
    }

    const refNum = i + 1;
    contextParts.push(`[${refNum}] ${content}`);

    citations.push({
      chunkId: chunk.id,
      documentId: chunk.document_id,
      documentTitle: chunk.documentTitle,
      documentSource: chunk.documentSource,
      chunkIndex: chunk.chunk_index,
      excerpt: chunk.content.slice(0, 200) + (chunk.content.length > 200 ? "…" : ""),
    });
  }

  return {
    contextText: contextParts.join("\n\n"),
    citations,
  };
}

/**
 * Generate a grounded, cited answer using Claude.
 *
 * Supports streaming (pass onToken callback) or returns full text.
 */
export async function generateAnswer(
  query: string,
  chunks: RetrievedChunk[],
  options: {
    useCompression?: boolean;
    onToken?: (token: string) => void;
    conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  } = {}
): Promise<GenerationResult> {
  const { useCompression = true, onToken, conversationHistory = [] } = options;

  const { contextText, citations } = await buildContext(
    query,
    chunks,
    useCompression
  );

  if (!contextText.trim()) {
    const noAnswerText =
      "I couldn't find relevant information in the documents to answer your question.";
    onToken?.(noAnswerText);
    return { answer: noAnswerText, citations: [], contextUsed: 0 };
  }

  const systemPrompt = `You are a precise, helpful assistant that answers questions using ONLY the provided context.

Rules:
- Base your answer exclusively on the numbered context passages [1], [2], etc.
- Cite your sources inline using bracket notation, e.g. "The process works as follows [1][3]."
- If the context doesn't contain enough information, say so clearly.
- Be concise but complete.
- Use markdown formatting for clarity (bullet points, bold, etc.) when appropriate.`;

  const userMessage = `Context:
${contextText}

Question: ${query}`;

  // Build messages with optional conversation history
  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory,
    { role: "user", content: userMessage },
  ];

  let fullAnswer = "";

  if (onToken) {
    // Streaming mode
    const stream = anthropic.messages.stream({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      thinking: { type: "adaptive" },
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        fullAnswer += event.delta.text;
        onToken(event.delta.text);
      }
    }
  } else {
    // Non-streaming mode
    const response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      thinking: { type: "adaptive" },
    });

    fullAnswer =
      response.content.find((b) => b.type === "text")?.type === "text"
        ? (response.content.find((b) => b.type === "text") as { type: "text"; text: string }).text
        : "";
  }

  return {
    answer: fullAnswer,
    citations,
    contextUsed: citations.length,
  };
}
