import Anthropic from "@anthropic-ai/sdk";
import { selectVariant } from "@/lib/rl/bandit";
import { createConversation, updateConversation } from "@/lib/rl/tracker";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: Request) {
  const body = await request.json();
  const {
    messages,
    conversationId: existingConversationId,
    variantId: existingVariantId,
  } = body;

  const encoder = new TextEncoder();

  // ── On the first message: select a variant and create a conversation record ─
  let conversationId: string = existingConversationId;
  let variantId: string = existingVariantId;
  let systemPrompt: string;

  try {
    if (!existingConversationId || !existingVariantId) {
      const variant = await selectVariant();
      variantId = variant.id;
      systemPrompt = variant.system_prompt;
      conversationId = await createConversation(variantId);
    } else {
      // Fetch the system prompt for the existing variant from DB
      // (we trust the client sent the right variantId)
      const { supabase } = await import("@/lib/supabase");
      const { data } = await supabase
        .from("rl_prompt_variants")
        .select("system_prompt")
        .eq("id", existingVariantId)
        .single();
      systemPrompt = data?.system_prompt ?? "";
    }
  } catch (err) {
    // If RL setup isn't done yet (no Supabase), fall back to inline prompt
    console.warn("[chat] RL not configured, using fallback prompt:", err);
    systemPrompt = FALLBACK_PROMPT;
    conversationId = existingConversationId ?? "local";
    variantId = existingVariantId ?? "fallback";
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

      try {
        // Send session metadata so the client can persist conversationId / variantId
        send({ type: "meta", conversationId, variantId });

        const anthropicStream = client.messages.stream({
          model: "claude-opus-4-6",
          max_tokens: 1024,
          system: systemPrompt,
          messages,
          thinking: { type: "adaptive" },
        });

        let fullText = "";
        for await (const event of anthropicStream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            fullText += event.delta.text;
            send({ type: "text", text: event.delta.text });
          }
        }

        // Persist the updated conversation (fire-and-forget — don't block streaming)
        if (conversationId !== "local") {
          const allMessages = [
            ...messages,
            { role: "assistant", content: fullText },
          ];
          updateConversation(conversationId, { messages: allMessages }).catch(
            (e) => console.error("[chat] failed to update conversation:", e)
          );
        }

        send({ type: "done" });
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        send({ type: "error", message });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// Fallback used when Supabase/RL is not yet configured
const FALLBACK_PROMPT = `You are a friendly moving quote assistant for a furniture taxi and moving service. Your job is to chat with customers, understand their moving needs, and provide an accurate quote.

Gather through natural conversation: pickup address, delivery address, floor details + elevator, all items to move, moving date, special items.

Pricing:
- Base: $80 (truck + 2 movers, 1 hour)
- Distance: $2.50/km beyond 10km | Extra hours: $65/hour
- Stairs (no elevator): $15/floor at each end
- Small: $5 | Medium: $10 | Large: $25 | Extra-large: $75

Present a clear itemized quote, then warmly invite the customer to book.`;
