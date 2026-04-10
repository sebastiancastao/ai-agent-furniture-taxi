/**
 * Policy optimizer — uses Claude to analyse top-performing conversations,
 * extract winning patterns, and synthesize an improved prompt variant.
 *
 * Run periodically (e.g. weekly) once enough outcome data has accumulated.
 * Requires at least MIN_SAMPLES positive outcomes before optimizing.
 */

import Anthropic from "@anthropic-ai/sdk";
import { PRICING_PROMPT_BLOCK } from "@/lib/pricing";
import { supabase } from "@/lib/supabase";
import { RL_TABLES, RL_VIEWS } from "./schema";
import { getTopConversations } from "./tracker";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MIN_SAMPLES = 10; // minimum positive outcomes needed before optimizing

// ─── Analyse top conversations ────────────────────────────────────────────────

async function extractWinningPatterns(
  topConversations: Awaited<ReturnType<typeof getTopConversations>>
): Promise<string> {
  const examples = topConversations
    .slice(0, 6)
    .map((conv, i) => {
      const transcript = conv.messages
        .map((m) => `  ${m.role === "user" ? "Customer" : "Agent"}: ${m.content}`)
        .join("\n");
      return `--- Example ${i + 1} (outcome: ${conv.outcome}, reward: ${conv.reward}, variant: ${conv.variant_name}) ---\n${transcript}`;
    })
    .join("\n\n");

  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    messages: [
      {
        role: "user",
        content: `Analyze these high-converting moving service conversations. Identify the specific communication patterns, phrases, and strategies that led to bookings or strong positive outcomes.

${examples}

Extract 5–8 concrete, actionable patterns. Focus on:
- How the agent opened and built rapport
- How pricing was framed and presented
- What language reduced friction at key decision points
- Objection-handling techniques that worked
- The closing moves that pushed toward booking

Be specific and quote actual phrases where possible.`,
      },
    ],
  });

  return response.content.find((b) => b.type === "text")?.type === "text"
    ? (response.content.find((b) => b.type === "text") as { text: string }).text
    : "";
}

// ─── Synthesize new prompt variant ───────────────────────────────────────────

async function synthesizeImprovedPrompt(patterns: string): Promise<{
  name: string;
  description: string;
  system_prompt: string;
}> {
  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1200,
    thinking: { type: "adaptive" },
    messages: [
      {
        role: "user",
        content: `You are designing an AI prompt for a moving quote assistant. Use the winning patterns below to write an optimized system prompt that will convert more conversations into bookings.

Winning patterns identified from top-converting conversations:
${patterns}

Pricing rules to include verbatim:
${PRICING_PROMPT_BLOCK}

Write a complete system prompt that naturally incorporates these winning patterns. The prompt should guide the agent to gather complete origin and destination addresses, floors, items, date, and special items, and then present a compelling quote that leads to booking.

The prompt must explicitly require full addresses with street number, street name, city, state, and ZIP code, and it must tell the agent not to accept city-only answers such as Atlanta as complete.
The prompt must also explicitly say that once the required quoting inputs are complete, the agent should stop asking extra discovery questions and provide the quote immediately in the next reply.

Return ONLY valid JSON with this structure:
{
  "name": "optimized_v<number>",
  "description": "one sentence summary of the strategy",
  "system_prompt": "the complete system prompt text"
}`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text")?.type === "text"
    ? (response.content.find((b) => b.type === "text") as { text: string }).text
    : "{}";

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Optimizer returned invalid JSON");

  return JSON.parse(match[0]) as {
    name: string;
    description: string;
    system_prompt: string;
  };
}

// ─── Persist the new variant ──────────────────────────────────────────────────

async function saveNewVariant(variant: {
  name: string;
  description: string;
  system_prompt: string;
}): Promise<string> {
  // Ensure name is unique by appending a timestamp if needed
  const uniqueName = `${variant.name}_${Date.now()}`;

  const { data, error } = await supabase
    .from(RL_TABLES.VARIANTS)
    .insert({ ...variant, name: uniqueName })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to save new variant: ${error.message}`);
  return data.id as string;
}

// ─── Main optimizer entry point ───────────────────────────────────────────────

export type OptimizationResult = {
  success: boolean;
  newVariantId?: string;
  newVariantName?: string;
  patternsFound?: string;
  reason?: string;
};

export async function runOptimization(): Promise<OptimizationResult> {
  // 1. Check we have enough data
  const { data: stats } = await supabase
    .from(RL_VIEWS.VARIANT_STATS)
    .select("total_conversations")
    .limit(1);

  const totalConversations = (stats ?? []).reduce(
    (sum: number, row: Record<string, unknown>) => sum + (Number(row.total_conversations) || 0),
    0
  );

  if (totalConversations < MIN_SAMPLES) {
    return {
      success: false,
      reason: `Need at least ${MIN_SAMPLES} conversations, have ${totalConversations}.`,
    };
  }

  // 2. Fetch top conversations
  const topConvs = await getTopConversations(10);
  if (topConvs.length < 3) {
    return {
      success: false,
      reason: "Not enough positive-outcome conversations to learn from.",
    };
  }

  // 3. Extract winning patterns
  const patterns = await extractWinningPatterns(topConvs);

  // 4. Synthesize improved prompt
  const newVariant = await synthesizeImprovedPrompt(patterns);

  // 5. Save to DB
  const newVariantId = await saveNewVariant(newVariant);

  return {
    success: true,
    newVariantId,
    newVariantName: newVariant.name,
    patternsFound: patterns,
  };
}
