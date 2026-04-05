"use client";

import { useState, useRef, useEffect, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Citation = {
  chunkId: string;
  documentId: string;
  documentTitle?: string;
  documentSource?: string;
  chunkIndex: number;
  excerpt: string;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  chunksRetrieved?: number;
};

type DocumentStat = {
  id: string;
  title: string;
  source?: string;
  chunk_count: number;
  total_tokens: number;
  created_at: string;
};

type Tab = "chat" | "ingest" | "documents";

// ─── Sub-components ───────────────────────────────────────────────────────────

function CitationCard({ citation, index }: { citation: Citation; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      onClick={() => setOpen(!open)}
      className="text-left w-full"
      aria-expanded={open}
    >
      <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-medium mr-1 mb-1 hover:bg-blue-200 transition-colors">
        [{index}] {citation.documentTitle ?? "Unknown"}
      </div>
      {open && (
        <div className="mt-1 p-2 bg-gray-50 border border-gray-200 rounded text-xs text-gray-600 leading-relaxed">
          <div className="font-medium mb-1 text-gray-800">{citation.documentTitle}</div>
          <div className="italic">&ldquo;{citation.excerpt}&rdquo;</div>
        </div>
      )}
    </button>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  return (
    <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} mb-4`}>
      {msg.role === "assistant" && (
        <div className="w-8 h-8 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center mr-2 mt-1 shrink-0">
          RAG
        </div>
      )}
      <div className="max-w-[80%]">
        <div
          className={`rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
            msg.role === "user"
              ? "bg-indigo-600 text-white rounded-tr-sm"
              : "bg-white text-gray-800 shadow-sm border border-gray-100 rounded-tl-sm"
          }`}
        >
          {msg.content || (
            <span className="flex gap-1">
              <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce [animation-delay:0ms]" />
              <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce [animation-delay:150ms]" />
              <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce [animation-delay:300ms]" />
            </span>
          )}
        </div>
        {msg.citations && msg.citations.length > 0 && (
          <div className="mt-2 px-1">
            <div className="text-xs text-gray-400 mb-1">
              Sources ({msg.chunksRetrieved} chunks retrieved):
            </div>
            <div>
              {msg.citations.map((c, i) => (
                <CitationCard key={c.chunkId} citation={c} index={i + 1} />
              ))}
            </div>
          </div>
        )}
      </div>
      {msg.role === "user" && (
        <div className="w-8 h-8 rounded-full bg-gray-200 text-gray-600 text-xs font-bold flex items-center justify-center ml-2 mt-1 shrink-0">
          You
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function RAGPage() {
  const [tab, setTab] = useState<Tab>("chat");

  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [query, setQuery] = useState("");
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [useExpansion, setUseExpansion] = useState(true);
  const [useReranking, setUseReranking] = useState(true);
  const [useCompression, setUseCompression] = useState(true);
  const [topK, setTopK] = useState(6);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Ingest state
  const [ingestTitle, setIngestTitle] = useState("");
  const [ingestContent, setIngestContent] = useState("");
  const [ingestSource, setIngestSource] = useState("");
  const [isIngesting, setIsIngesting] = useState(false);
  const [ingestResult, setIngestResult] = useState<string | null>(null);

  // Documents state
  const [documents, setDocuments] = useState<DocumentStat[]>([]);
  const [isLoadingDocs, setIsLoadingDocs] = useState(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Load documents ──────────────────────────────────────────────────────────
  const loadDocuments = useCallback(async () => {
    setIsLoadingDocs(true);
    try {
      const res = await fetch("/api/rag/ingest");
      const data = await res.json();
      setDocuments(data.documents ?? []);
    } finally {
      setIsLoadingDocs(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "documents") loadDocuments();
  }, [tab, loadDocuments]);

  // ── Send query ──────────────────────────────────────────────────────────────
  const sendQuery = async () => {
    const q = query.trim();
    if (!q || isChatLoading) return;

    const history = messages
      .filter((m) => m.content)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, { role: "user", content: q }]);
    setQuery("");
    setIsChatLoading(true);
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/rag/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: q,
          topK,
          useQueryExpansion: useExpansion,
          useReranking,
          useCompression,
          stream: true,
          conversationHistory: history,
        }),
      });

      if (!res.body) throw new Error("No stream body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === "token") {
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  content: updated[updated.length - 1].content + evt.text,
                };
                return updated;
              });
            } else if (evt.type === "citations") {
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  citations: evt.citations,
                  chunksRetrieved: evt.contextUsed,
                };
                return updated;
              });
            } else if (evt.type === "error") {
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  content: `Error: ${evt.message}`,
                };
                return updated;
              });
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          content: "Something went wrong. Please check your configuration.",
        };
        return updated;
      });
    } finally {
      setIsChatLoading(false);
    }
  };

  // ── Ingest document ─────────────────────────────────────────────────────────
  const ingestDocument = async () => {
    if (!ingestTitle.trim() || !ingestContent.trim()) return;
    setIsIngesting(true);
    setIngestResult(null);

    try {
      const res = await fetch("/api/rag/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: ingestTitle,
          content: ingestContent,
          source: ingestSource,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setIngestResult(
        `✅ Ingested "${data.title}" — ${data.chunkCount} chunks created.`
      );
      setIngestTitle("");
      setIngestContent("");
      setIngestSource("");
    } catch (err) {
      setIngestResult(
        `❌ ${err instanceof Error ? err.message : "Ingest failed"}`
      );
    } finally {
      setIsIngesting(false);
    }
  };

  // ── Delete document ─────────────────────────────────────────────────────────
  const deleteDocument = async (id: string) => {
    if (!confirm("Delete this document and all its chunks?")) return;
    await fetch(`/api/rag/ingest?documentId=${id}`, { method: "DELETE" });
    loadDocuments();
  };

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 shadow-sm">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🧠</span>
            <div>
              <h1 className="text-lg font-bold text-gray-900">Advanced RAG System</h1>
              <p className="text-xs text-gray-500">Hybrid search · Query expansion · Reranking · Citations</p>
            </div>
          </div>
          <nav className="flex gap-1">
            {(["chat", "ingest", "documents"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-sm font-medium rounded-lg capitalize transition-colors ${
                  tab === t
                    ? "bg-indigo-100 text-indigo-700"
                    : "text-gray-600 hover:bg-gray-100"
                }`}
              >
                {t}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* ── Chat Tab ─────────────────────────────────────────────────────────── */}
      {tab === "chat" && (
        <div className="flex flex-1 overflow-hidden max-w-5xl w-full mx-auto">
          {/* Sidebar: settings */}
          <aside className="w-52 border-r border-gray-200 bg-white p-4 shrink-0 overflow-y-auto">
            <h2 className="text-xs font-semibold text-gray-500 uppercase mb-3">
              Retrieval Settings
            </h2>
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useExpansion}
                  onChange={(e) => setUseExpansion(e.target.checked)}
                  className="rounded"
                />
                Query Expansion
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useReranking}
                  onChange={(e) => setUseReranking(e.target.checked)}
                  className="rounded"
                />
                LLM Reranking
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useCompression}
                  onChange={(e) => setUseCompression(e.target.checked)}
                  className="rounded"
                />
                Compression
              </label>
              <div>
                <label className="text-xs text-gray-500 block mb-1">
                  Top-K chunks: {topK}
                </label>
                <input
                  type="range"
                  min={2}
                  max={12}
                  value={topK}
                  onChange={(e) => setTopK(Number(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>
            <div className="mt-6 pt-4 border-t border-gray-100">
              <p className="text-xs text-gray-400 leading-relaxed">
                <strong>Pipeline:</strong> Multi-query expansion → Hybrid search
                (semantic + BM25 + RRF) → LLM reranking → Contextual
                compression → Claude generation with citations.
              </p>
            </div>
          </aside>

          {/* Chat area */}
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="flex-1 overflow-y-auto px-6 py-6">
              {messages.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-center text-gray-400">
                  <div className="text-5xl mb-4">🔍</div>
                  <p className="text-lg font-medium text-gray-600">
                    Ask anything about your documents
                  </p>
                  <p className="text-sm mt-1">
                    First upload some documents in the{" "}
                    <button
                      onClick={() => setTab("ingest")}
                      className="text-indigo-500 underline"
                    >
                      Ingest
                    </button>{" "}
                    tab.
                  </p>
                </div>
              )}
              {messages.map((msg, i) => (
                <MessageBubble key={i} msg={msg} />
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="border-t border-gray-200 bg-white px-4 py-3">
              <div className="flex gap-2 items-end">
                <textarea
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendQuery();
                    }
                  }}
                  placeholder="Ask a question about your documents…"
                  rows={1}
                  disabled={isChatLoading}
                  className="flex-1 resize-none rounded-xl border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 max-h-32 overflow-y-auto"
                />
                <button
                  onClick={sendQuery}
                  disabled={!query.trim() || isChatLoading}
                  className="shrink-0 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 text-white rounded-xl px-4 py-2.5 text-sm font-medium transition-colors"
                >
                  {isChatLoading ? "…" : "Ask"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Ingest Tab ────────────────────────────────────────────────────────── */}
      {tab === "ingest" && (
        <div className="flex-1 overflow-y-auto px-4 py-8">
          <div className="max-w-2xl mx-auto space-y-4">
            <h2 className="text-lg font-semibold text-gray-800">
              Ingest Document
            </h2>
            <p className="text-sm text-gray-500">
              Paste text content below. The system will chunk, embed, and index
              it automatically.
            </p>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Title <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={ingestTitle}
                onChange={(e) => setIngestTitle(e.target.value)}
                placeholder="e.g. Product Documentation v2"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Source / URL (optional)
              </label>
              <input
                type="text"
                value={ingestSource}
                onChange={(e) => setIngestSource(e.target.value)}
                placeholder="e.g. https://docs.example.com"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Content <span className="text-red-500">*</span>
              </label>
              <textarea
                value={ingestContent}
                onChange={(e) => setIngestContent(e.target.value)}
                placeholder="Paste your document text here…"
                rows={14}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <p className="text-xs text-gray-400 mt-1">
                {ingestContent.length.toLocaleString()} chars ≈{" "}
                {Math.ceil(ingestContent.length / 4).toLocaleString()} tokens
              </p>
            </div>

            <button
              onClick={ingestDocument}
              disabled={
                isIngesting || !ingestTitle.trim() || !ingestContent.trim()
              }
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 text-white rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
            >
              {isIngesting ? "Processing…" : "Ingest Document"}
            </button>

            {ingestResult && (
              <div
                className={`p-3 rounded-lg text-sm ${
                  ingestResult.startsWith("✅")
                    ? "bg-green-50 text-green-800 border border-green-200"
                    : "bg-red-50 text-red-800 border border-red-200"
                }`}
              >
                {ingestResult}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Documents Tab ─────────────────────────────────────────────────────── */}
      {tab === "documents" && (
        <div className="flex-1 overflow-y-auto px-4 py-8">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-800">
                Indexed Documents
              </h2>
              <button
                onClick={loadDocuments}
                className="text-sm text-indigo-600 hover:underline"
              >
                Refresh
              </button>
            </div>

            {isLoadingDocs ? (
              <div className="text-center text-gray-400 py-12">Loading…</div>
            ) : documents.length === 0 ? (
              <div className="text-center text-gray-400 py-12">
                No documents yet.{" "}
                <button
                  onClick={() => setTab("ingest")}
                  className="text-indigo-500 underline"
                >
                  Ingest one
                </button>
                .
              </div>
            ) : (
              <div className="space-y-3">
                {documents.map((doc) => (
                  <div
                    key={doc.id}
                    className="bg-white border border-gray-200 rounded-xl p-4 flex items-start justify-between gap-4 shadow-sm"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate">
                        {doc.title}
                      </div>
                      {doc.source && (
                        <div className="text-xs text-indigo-500 truncate mt-0.5">
                          {doc.source}
                        </div>
                      )}
                      <div className="flex gap-3 mt-2 text-xs text-gray-400">
                        <span>{doc.chunk_count} chunks</span>
                        <span>~{doc.total_tokens?.toLocaleString()} tokens</span>
                        <span>
                          {new Date(doc.created_at).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => deleteDocument(doc.id)}
                      className="shrink-0 text-xs text-red-500 hover:text-red-700 border border-red-200 hover:border-red-400 rounded-lg px-2 py-1 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
