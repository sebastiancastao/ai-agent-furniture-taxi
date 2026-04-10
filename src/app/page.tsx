"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

const starterMessage: Message = {
  role: "assistant",
  content:
    "Hello. I am your moving quote assistant.\n\nTell me what you are moving, where it is going, and any details about stairs, elevators, or timing. I will help you build a clear quote.",
};

function escapeHtml(content: string): string {
  return content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMessage(content: string): string {
  const safeContent = escapeHtml(content).replace(
    /\*\*(.+?)\*\*/g,
    "<strong>$1</strong>"
  );
  const lines = safeContent.split(/\r?\n/);
  const html: string[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    html.push(`<ul>${listItems.join("")}</ul>`);
    listItems = [];
  };

  for (const line of lines) {
    const isListItem =
      line.startsWith("- ") || line.startsWith("* ") || line.startsWith("\u2022 ");

    if (isListItem) {
      listItems.push(`<li>${line.slice(2)}</li>`);
      continue;
    }

    flushList();

    if (!line.trim()) {
      html.push('<div class="message-spacer"></div>');
      continue;
    }

    html.push(`<p>${line}</p>`);
  }

  flushList();

  return html.join("");
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([starterMessage]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [outcomeRecorded, setOutcomeRecorded] = useState(false);
  const [showBookingBar, setShowBookingBar] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "0px";
    const nextHeight = Math.min(textarea.scrollHeight, 160);
    textarea.style.height = `${Math.max(nextHeight, 56)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 160 ? "auto" : "hidden";
  }, [input]);

  useEffect(() => {
    const hasQuote = messages.some(
      (message) =>
        message.role === "assistant" &&
        /\$\d+/.test(message.content) &&
        /total|quote|estimate/i.test(message.content)
    );

    if (hasQuote && !outcomeRecorded) {
      setShowBookingBar(true);
    }
  }, [messages, outcomeRecorded]);

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
            messages: messages.filter((message) => message.content),
            explicitOutcome: outcome,
          }),
        });
      } catch (error) {
        console.error("Failed to record outcome:", error);
      }
    },
    [conversationId, messages, outcomeRecorded, variantId]
  );

  useEffect(() => {
    const handleUnload = () => {
      if (conversationId && variantId && !outcomeRecorded && messages.length > 1) {
        navigator.sendBeacon(
          "/api/rl/outcome",
          JSON.stringify({
            conversationId,
            variantId,
            messages: messages.filter((message) => message.content),
          })
        );
      }
    };

    window.addEventListener("beforeunload", handleUnload);

    return () => {
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, [conversationId, messages, outcomeRecorded, variantId]);

  const sendMessage = async () => {
    const trimmedInput = input.trim();
    if (!trimmedInput || isLoading) return;

    const userMessage: Message = { role: "user", content: trimmedInput };
    const nextMessages = [...messages, userMessage];

    setMessages(nextMessages);
    setInput("");
    setIsLoading(true);
    setMessages((currentMessages) => [
      ...currentMessages,
      { role: "assistant", content: "" },
    ]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages,
          conversationId,
          variantId,
        }),
      });

      if (!response.body) {
        throw new Error("No response body");
      }

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
            const event = JSON.parse(line.slice(6));

            if (event.type === "meta") {
              if (!conversationId) setConversationId(event.conversationId);
              if (!variantId) setVariantId(event.variantId);
            } else if (event.type === "text") {
              setMessages((currentMessages) => {
                const updatedMessages = [...currentMessages];
                const lastMessage = updatedMessages[updatedMessages.length - 1];

                updatedMessages[updatedMessages.length - 1] = {
                  role: "assistant",
                  content: lastMessage.content + event.text,
                };

                return updatedMessages;
              });
            } else if (event.type === "error") {
              setMessages((currentMessages) => {
                const updatedMessages = [...currentMessages];
                updatedMessages[updatedMessages.length - 1] = {
                  role: "assistant",
                  content: "Sorry, something went wrong. Please try again.",
                };
                return updatedMessages;
              });
            }
          } catch {
            continue;
          }
        }
      }
    } catch {
      setMessages((currentMessages) => {
        const updatedMessages = [...currentMessages];
        updatedMessages[updatedMessages.length - 1] = {
          role: "assistant",
          content: "Sorry, something went wrong. Please check your API key.",
        };
        return updatedMessages;
      });
    } finally {
      setIsLoading(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  const conversationStatus = isLoading
    ? "Generating quote"
    : showBookingBar
      ? "Ready to confirm"
      : messages.length > 1
        ? "Conversation active"
        : "Awaiting details";

  return (
    <main className="relative min-h-screen overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute left-[-8%] top-[-6%] h-80 w-80 rounded-full bg-white/90 blur-3xl [animation:drift_18s_ease-in-out_infinite]" />
        <div className="absolute right-[-4%] top-[10%] h-72 w-72 rounded-full bg-sky-200/55 blur-3xl [animation:drift_16s_ease-in-out_infinite]" />
        <div className="absolute bottom-[-10%] left-[24%] h-72 w-72 rounded-full bg-blue-100/55 blur-3xl [animation:drift_20s_ease-in-out_infinite]" />
      </div>

      <div className="relative mx-auto flex min-h-screen w-full max-w-[1440px] flex-col px-4 py-4 sm:px-6 lg:px-8">
        <header className="mb-4 rounded-[28px] border border-white/70 bg-white/72 px-5 py-4 shadow-[0_16px_60px_rgba(15,23,42,0.08)] backdrop-blur-2xl">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <div className="relative flex h-12 w-12 items-center justify-center overflow-hidden rounded-2xl bg-[linear-gradient(160deg,#0f172a,#334155)] text-sm font-semibold tracking-[0.3em] text-white shadow-[0_14px_30px_rgba(15,23,42,0.2)]">
                FT
                <div className="pointer-events-none absolute inset-x-2 top-1 h-px bg-white/45 [animation:gleam_7s_ease-in-out_infinite]" />
              </div>
              <div>
                <p className="text-[0.68rem] font-medium uppercase tracking-[0.34em] text-slate-400">
                  Furniture Taxi
                </p>
                <h1 className="text-lg font-semibold tracking-[-0.03em] text-slate-950 sm:text-xl">
                  Premium moving quote assistant
                </h1>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-500">
              <span className="rounded-full border border-white/85 bg-white/80 px-3 py-1.5 shadow-sm">
                White-glove planning
              </span>
              <span className="rounded-full border border-white/85 bg-white/80 px-3 py-1.5 shadow-sm">
                Real-time pricing
              </span>
              <span className="rounded-full border border-white/85 bg-white/80 px-3 py-1.5 shadow-sm">
                Clean booking flow
              </span>
            </div>
          </div>
        </header>

        <div className="flex flex-1 justify-center">
          <section className="flex min-h-[72vh] w-full max-w-[1120px] flex-col overflow-hidden rounded-[34px] border border-white/70 bg-[linear-gradient(180deg,rgba(248,250,252,0.86),rgba(255,255,255,0.82))] shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur-2xl">
            <div className="border-b border-white/70 bg-white/55 px-5 py-4 sm:px-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-[0.68rem] font-medium uppercase tracking-[0.34em] text-slate-400">
                    Live quote studio
                  </p>
                  <h2 className="mt-1 text-lg font-semibold tracking-[-0.03em] text-slate-950">
                    Concierge conversation
                  </h2>
                </div>

                <div className="flex items-center gap-2 self-start rounded-full bg-slate-950/[0.04] px-3 py-1.5 text-xs font-medium text-slate-600 sm:self-auto">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      isLoading
                        ? "animate-pulse bg-sky-500"
                        : showBookingBar
                          ? "bg-emerald-500"
                          : "bg-slate-400"
                    }`}
                  />
                  {conversationStatus}
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
              <div className="space-y-4">
                {messages.map((message, index) => {
                  const isAssistant = message.role === "assistant";

                  return (
                    <div
                      key={`${message.role}-${index}`}
                      className={`flex items-end gap-3 ${
                        isAssistant ? "justify-start" : "justify-end"
                      }`}
                    >
                      {isAssistant && (
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[linear-gradient(160deg,#0f172a,#334155)] text-[0.68rem] font-semibold tracking-[0.28em] text-white shadow-[0_12px_30px_rgba(15,23,42,0.18)]">
                          FT
                        </div>
                      )}

                      <div
                        className={`max-w-[86%] rounded-[28px] px-4 py-3.5 sm:max-w-[78%] sm:px-5 ${
                          isAssistant
                            ? "rounded-bl-md border border-white/80 bg-white/92 text-slate-800 shadow-[0_18px_45px_rgba(15,23,42,0.07)]"
                            : "rounded-br-md bg-[linear-gradient(135deg,#0f172a,#1e3a8a)] text-white shadow-[0_18px_45px_rgba(15,23,42,0.14)]"
                        }`}
                      >
                        {message.content ? (
                          <div
                            className={`message-content text-sm leading-7 ${
                              isAssistant ? "text-slate-700" : "text-white/92"
                            }`}
                            dangerouslySetInnerHTML={{
                              __html: formatMessage(message.content),
                            }}
                          />
                        ) : (
                          <div className="flex items-center gap-1.5 py-1 text-slate-400">
                            <span className="h-2 w-2 rounded-full bg-current animate-bounce [animation-delay:0ms]" />
                            <span className="h-2 w-2 rounded-full bg-current animate-bounce [animation-delay:150ms]" />
                            <span className="h-2 w-2 rounded-full bg-current animate-bounce [animation-delay:300ms]" />
                          </div>
                        )}
                      </div>

                      {!isAssistant && (
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/80 bg-white/82 text-xs font-semibold text-slate-600 shadow-sm">
                          Y
                        </div>
                      )}
                    </div>
                  );
                })}

                <div ref={messagesEndRef} />
              </div>
            </div>

            <div className="border-t border-white/70 bg-white/60 px-4 pb-4 pt-4 sm:px-6 sm:pb-6">
              {showBookingBar && !outcomeRecorded && (
                <div className="mb-4 rounded-[28px] border border-emerald-200/80 bg-emerald-50/85 p-4 shadow-[0_12px_34px_rgba(16,185,129,0.08)]">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-emerald-950">
                        Ready to lock in this move?
                      </p>
                      <p className="mt-1 text-sm text-emerald-700">
                        Confirm the quote or save your interest for follow-up.
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => recordOutcome("BOOKED")}
                        className="rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700"
                      >
                        Book now
                      </button>
                      <button
                        type="button"
                        onClick={() => recordOutcome("QUOTE_ACCEPTED")}
                        className="rounded-full border border-emerald-300 bg-white px-4 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100"
                      >
                        Interested
                      </button>
                      <button
                        type="button"
                        onClick={() => recordOutcome("NEGATIVE")}
                        className="rounded-full px-4 py-2 text-sm font-medium text-emerald-700/80 transition hover:bg-emerald-100"
                      >
                        Not now
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {outcomeRecorded && (
                <div className="mb-4 rounded-[28px] border border-sky-200/80 bg-sky-50/90 px-4 py-3 text-sm font-medium text-sky-800 shadow-[0_10px_24px_rgba(14,165,233,0.08)]">
                  Thank you. Your response has been recorded and the team can
                  follow up from here.
                </div>
              )}

              <div className="rounded-[30px] border border-white/85 bg-white/88 p-2 shadow-[0_16px_40px_rgba(15,23,42,0.08)]">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Describe the move, inventory, and timing..."
                    className="min-h-[56px] flex-1 resize-none bg-transparent px-4 py-3 text-[15px] leading-6 text-slate-900 placeholder:text-slate-400 focus:outline-none"
                    disabled={isLoading}
                  />

                  <button
                    type="button"
                    onClick={sendMessage}
                    disabled={!input.trim() || isLoading}
                    className="inline-flex h-14 items-center justify-center gap-2 rounded-[22px] bg-[linear-gradient(135deg,#0f172a,#1e3a8a)] px-5 text-sm font-semibold text-white shadow-[0_16px_36px_rgba(15,23,42,0.18)] transition hover:translate-y-[-1px] hover:shadow-[0_20px_40px_rgba(15,23,42,0.22)] disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
                  >
                    {isLoading ? (
                      <svg
                        className="h-4 w-4 animate-spin"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                      </svg>
                    ) : (
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.8}
                          d="M4.75 12.75l13.5-7-4.5 12-2.25-4.75-4.75-.25z"
                        />
                      </svg>
                    )}
                    Send
                  </button>
                </div>
              </div>

              <p className="mt-3 text-center text-xs font-medium tracking-[0.08em] text-slate-400">
                Press Enter to send | Shift+Enter for a new line
              </p>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
