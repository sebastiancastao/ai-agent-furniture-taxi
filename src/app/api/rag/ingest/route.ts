import { supabase } from "@/lib/supabase";
import { chunkDocument, cleanText } from "@/lib/rag/chunker";
import { embedBatch } from "@/lib/rag/embeddings";
import { TABLES, VIEWS, COLUMNS } from "@/lib/rag/schema";

export const maxDuration = 60; // Vercel function timeout in seconds

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { title, content, source, metadata = {}, chunkOptions = {} } = body;

    if (!title || !content) {
      return Response.json(
        { error: "title and content are required" },
        { status: 400 }
      );
    }

    // 1. Clean the raw text
    const cleanedContent = cleanText(content);

    // 2. Insert the parent document
    const { data: doc, error: docError } = await supabase
      .from(TABLES.DOCUMENTS)
      .insert({ title, content: cleanedContent, source, metadata })
      .select()
      .single();

    if (docError) throw new Error(`Failed to insert document: ${docError.message}`);

    // 3. Chunk the document
    const chunks = chunkDocument(cleanedContent, metadata, chunkOptions);

    if (chunks.length === 0) {
      return Response.json(
        { error: "Document produced no valid chunks" },
        { status: 422 }
      );
    }

    // 4. Generate embeddings in batch
    const texts = chunks.map((c) => c.content);
    const embeddings = await embedBatch(texts);

    // 5. Insert chunks with embeddings into Supabase
    const chunkRows = chunks.map((chunk, i) => ({
      document_id: doc.id,
      content: chunk.content,
      embedding: embeddings[i],
      chunk_index: chunk.chunkIndex,
      token_count: chunk.tokenCount,
      metadata: { ...chunk.metadata, documentTitle: title, source },
    }));

    // Insert in batches of 50 to avoid request size limits
    const BATCH = 50;
    for (let i = 0; i < chunkRows.length; i += BATCH) {
      const { error: chunkError } = await supabase
        .from(TABLES.CHUNKS)
        .insert(chunkRows.slice(i, i + BATCH));

      if (chunkError)
        throw new Error(`Failed to insert chunks: ${chunkError.message}`);
    }

    return Response.json({
      success: true,
      documentId: doc.id,
      chunkCount: chunks.length,
      title,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[RAG ingest]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}

/** DELETE /api/rag/ingest?documentId=<id> */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const documentId = searchParams.get("documentId");

  if (!documentId) {
    return Response.json({ error: "documentId is required" }, { status: 400 });
  }

  // Chunks are deleted via ON DELETE CASCADE
  const { error } = await supabase
    .from(TABLES.DOCUMENTS)
    .delete()
    .eq(COLUMNS.DOCUMENTS.ID, documentId);

  if (error)
    return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ success: true });
}

/** GET /api/rag/ingest — list all documents */
export async function GET() {
  const { data, error } = await supabase
    .from(VIEWS.DOCUMENT_STATS)
    .select("*")
    .order(COLUMNS.DOCUMENT_STATS.CREATED_AT, { ascending: false });

  if (error)
    return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ documents: data });
}
