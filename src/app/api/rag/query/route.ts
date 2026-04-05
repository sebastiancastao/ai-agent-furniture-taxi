import { retrieve } from "@/lib/rag/retriever";
import { generateAnswer } from "@/lib/rag/generator";

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      query,
      topK = 6,
      useQueryExpansion = true,
      useReranking = true,
      useCompression = true,
      filterMetadata,
      stream: shouldStream = true,
      conversationHistory = [],
    } = body;

    if (!query?.trim()) {
      return Response.json({ error: "query is required" }, { status: 400 });
    }

    // ── 1. Retrieve relevant chunks ─────────────────────────────────────────
    const chunks = await retrieve(query, {
      topK,
      candidateK: Math.min(topK * 3, 30),
      useQueryExpansion,
      useReranking,
      filterMetadata,
    });

    if (!shouldStream) {
      // ── Non-streaming response ──────────────────────────────────────────
      const result = await generateAnswer(query, chunks, {
        useCompression,
        conversationHistory,
      });
      return Response.json({
        answer: result.answer,
        citations: result.citations,
        contextUsed: result.contextUsed,
        chunksRetrieved: chunks.length,
      });
    }

    // ── 2. Streaming response (SSE) ─────────────────────────────────────────
    const encoder = new TextEncoder();

    const readableStream = new ReadableStream({
      async start(controller) {
        const send = (payload: unknown) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
          );
        };

        try {
          // Send metadata first (chunks retrieved, citations)
          send({
            type: "meta",
            chunksRetrieved: chunks.length,
          });

          let fullAnswer = "";

          const result = await generateAnswer(query, chunks, {
            useCompression,
            conversationHistory,
            onToken: (token) => {
              fullAnswer += token;
              send({ type: "token", text: token });
            },
          });

          // Send citations after streaming completes
          send({
            type: "citations",
            citations: result.citations,
            contextUsed: result.contextUsed,
          });

          send({ type: "done" });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Generation failed";
          send({ type: "error", message });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readableStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[RAG query]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
