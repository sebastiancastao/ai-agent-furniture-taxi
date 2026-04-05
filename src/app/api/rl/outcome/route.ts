/**
 * POST /api/rl/outcome
 * Record the outcome of a conversation and update the bandit.
 */

import { updateThompsonParams } from "@/lib/rl/bandit";
import { computeReward } from "@/lib/rl/rewards";
import { closeConversation, recordOutcome, updateConversation } from "@/lib/rl/tracker";
import { type OutcomeKey } from "@/lib/rl/schema";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      conversationId,
      variantId,
      messages,
      explicitOutcome,  // optional: "BOOKED" | "QUOTE_ACCEPTED" etc.
      userFeedback,
    } = body;

    if (!conversationId || !variantId || !messages) {
      return Response.json(
        { error: "conversationId, variantId, and messages are required" },
        { status: 400 }
      );
    }

    // 1. Compute reward (heuristic + optional LLM classification)
    const result = await computeReward(
      messages,
      explicitOutcome as OutcomeKey | undefined
    );

    // 2. Save final messages and close the conversation
    await updateConversation(conversationId, { messages });
    await closeConversation(conversationId);

    // 3. Persist outcome
    await recordOutcome({
      conversationId,
      variantId,
      outcome:     result.outcome,
      reward:      result.reward,
      signals:     result.signals as Record<string, unknown>,
      userFeedback,
    });

    // 4. Update Thompson Sampling parameters
    await updateThompsonParams(variantId, result.reward);

    return Response.json({
      outcome: result.outcome,
      reward:  result.reward,
      signals: result.signals,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[RL outcome]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
