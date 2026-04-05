"use client";

import { useState, useRef, useEffect, useCallback } from "react";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type OutcomeKey =
  | "BOOKED"
  | "QUOTE_ACCEPTED"
  | "CONTACT_PROVIDED"
  | "HIGH_ENGAGEMENT"
  | "COMPLETED"
  | "ABANDONED"
  | "NEGATIVE";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMessage(content: string): string {
  return content
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .split("\n")
    .map((line) => {
      if (line.startsWith("- ") || line.startsWith("• "))
        return `<li class="ml-4 list-disc">${line.slice(2)}</li>`;
      return line ? `<span>${line}</span>` : "<br/>";
    })
    .join("\n");
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // RL session state — persisted across turns
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);

  // Booking UI state
  const [outcomeRecorded, setOutcomeRecorded] = useState(false);
  const [showBookingBar, setShowBookingBar] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Show booking bar once a quote appears in the conversation
  useEffect(() => {
    const hasQuote = messages.some(
      (m) =>
        m.role === "assistant" &&
        /\$\d+/.test(m.content) &&
        /total|quote|estimate/i.test(m.content)
    );
    if (hasQuote && !outcomeRecorded) setShowBookingBar(true);
  }, [messages, outcomeRecorded]);

  useEffect(() => {
    if (messages.length === 0) {
      setMessages([
        {
          role: "assistant",
          content:
            "Hi! I'm your moving quote assistant 🚛\n\nI'll help you get an accurate quote for your move. To get started — what are you looking to move, and where are you moving from and to?",
        },
      ]);
    }
  }, []);

  // ─── Record outcome ──────────────────────────────────────────────────────────

  const recordOutcome = useCallback(
    async (outcome: OutcomeKey) => {
      if (!conversationId || !variantId || outcomeRecorded) return;
      setOutcomeRecorded(true);
      setShowBookingBar(false);

      try {
        await fetch("/api/rl/outcome", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            variantId,
            messages: messages.filter((m) => m.content),
            explicitOutcome: outcome,
          }),
        });
      } catch (err) {
        console.error("Failed to record outcome:", err);
      }
    },
    [conversationId, variantId, messages, outcomeRecorded]
  );

  // Auto-record on page unload
  useEffect(() => {
    const handleUnload = () => {
      if (conversationId && variantId && !outcomeRecorded && messages.length > 1) {
        // Best-effort beacon
        navigator.sendBeacon(
          "/api/rl/outcome",
          JSON.stringify({
            conversationId,
            variantId,
            messages: messages.filter((m) => m.content),
          })
        );
      }
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [conversationId, variantId, messages, outcomeRecorded]);

  // ─── Send message ────────────────────────────────────────────────────────────

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    const userMessage: Message = { role: "user", content: text };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setIsLoading(true);
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages,
          conversationId,
          variantId,
        }),
      });

      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6));

            if (evt.type === "meta") {
              // Capture session IDs on first response
              if (!conversationId) setConversationId(evt.conversationId);
              if (!variantId) setVariantId(evt.variantId);
            } else if (evt.type === "text") {
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: updated[updated.length - 1].content + evt.text,
                };
                return updated;
              });
            } else if (evt.type === "error") {
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: "Sorry, something went wrong. Please try again.",
                };
                return updated;
              });
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } catch {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: "assistant",
          content: "Sorry, something went wrong. Please check your API key.",
        };
        return updated;
      });
    } finally {
      setIsLoading(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-4 shadow-sm">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <div className="text-3xl">🚛</div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">
              Moving Quote Assistant
            </h1>
            <p className="text-sm text-gray-500">
              Get an instant quote for your furniture move
            </p>
          </div>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              {msg.role === "assistant" && (
                <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-bold mr-2 mt-1 shrink-0">
                  AI
                </div>
              )}
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white rounded-tr-sm"
                    : "bg-white text-gray-800 shadow-sm border border-gray-100 rounded-tl-sm"
                }`}
              >
                {msg.content ? (
                  <div
                    className="text-sm leading-relaxed whitespace-pre-wrap"
                    dangerouslySetInnerHTML={{
                      __html: formatMessage(msg.content),
                    }}
                  />
                ) : (
                  <div className="flex gap-1 py-1">
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:0ms]" />
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:150ms]" />
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:300ms]" />
                  </div>
                )}
              </div>
              {msg.role === "user" && (
                <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-gray-600 text-sm font-bold ml-2 mt-1 shrink-0">
                  You
                </div>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Booking bar — appears once a quote is shown */}
      {showBookingBar && !outcomeRecorded && (
        <div className="bg-green-50 border-t border-green-200 px-4 py-3">
          <div className="max-w-3xl mx-auto flex flex-col sm:flex-row items-center gap-3">
            <p className="text-sm text-green-800 font-medium flex-1">
              Ready to lock in your move? 🎉
            </p>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => recordOutcome("BOOKED")}
                className="bg-green-600 hover:bg-green-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
              >
                ✓ Book Now
              </button>
              <button
                onClick={() => recordOutcome("QUOTE_ACCEPTED")}
                className="bg-white border border-green-300 hover:bg-green-50 text-green-700 text-sm font-medium px-4 py-2 rounded-lg transition-colors"
              >
                Interested
              </button>
              <button
                onClick={() => recordOutcome("NEGATIVE")}
                className="text-gray-400 hover:text-gray-600 text-sm px-3 py-2 transition-colors"
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Booking confirmation */}
      {outcomeRecorded && (
        <div className="bg-blue-50 border-t border-blue-200 px-4 py-3 text-center text-sm text-blue-700">
          Thank you! Your response has been recorded. We&apos;ll be in touch shortly. 📞
        </div>
      )}

      {/* Input */}
      <div className="bg-white border-t border-gray-200 px-4 py-4">
        <div className="max-w-3xl mx-auto flex gap-3 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe what you need to move…"
            rows={1}
            className="flex-1 resize-none rounded-xl border border-gray-300 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent max-h-32 overflow-y-auto"
            style={{ minHeight: "48px" }}
            disabled={isLoading}
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || isLoading}
            className="shrink-0 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white rounded-xl px-4 py-3 text-sm font-medium transition-colors flex items-center gap-2"
          >
            {isLoading ? (
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            )}
            Send
          </button>
        </div>
        <p className="text-xs text-gray-400 text-center mt-2">
          Press Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}
