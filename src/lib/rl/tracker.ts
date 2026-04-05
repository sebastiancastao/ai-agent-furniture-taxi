/**
 * Conversation lifecycle tracking.
 * Creates, updates, and closes conversation records in Supabase.
 */

import { supabase } from "@/lib/supabase";
import { RL_TABLES, RL_VIEWS, type VariantStatRow } from "./schema";

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createConversation(variantId: string): Promise<string> {
  const { data, error } = await supabase
    .from(RL_TABLES.CONVERSATIONS)
    .insert({ variant_id: variantId, stage: "greeting" })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to create conversation: ${error.message}`);
  return data.id as string;
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateConversation(
  conversationId: string,
  patch: {
    messages?: Array<{ role: string; content: string }>;
    stage?: string;
    quote_amount?: number;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const { error } = await supabase
    .from(RL_TABLES.CONVERSATIONS)
    .update(patch)
    .eq("id", conversationId);

  if (error) throw new Error(`Failed to update conversation: ${error.message}`);
}

// ─── Close ────────────────────────────────────────────────────────────────────

export async function closeConversation(conversationId: string): Promise<void> {
  const { error } = await supabase
    .from(RL_TABLES.CONVERSATIONS)
    .update({ ended_at: new Date().toISOString() })
    .eq("id", conversationId);

  if (error) throw new Error(`Failed to close conversation: ${error.message}`);
}

// ─── Record outcome ───────────────────────────────────────────────────────────

export async function recordOutcome(opts: {
  conversationId: string;
  variantId: string;
  outcome: string;
  reward: number;
  signals?: Record<string, unknown>;
  userFeedback?: string;
}): Promise<void> {
  const { error } = await supabase.from(RL_TABLES.OUTCOMES).insert({
    conversation_id: opts.conversationId,
    variant_id:      opts.variantId,
    outcome:         opts.outcome,
    reward:          opts.reward,
    signals:         opts.signals ?? {},
    user_feedback:   opts.userFeedback ?? null,
  });

  if (error) throw new Error(`Failed to record outcome: ${error.message}`);
}

// ─── Read stats ───────────────────────────────────────────────────────────────

export async function getVariantStats(): Promise<VariantStatRow[]> {
  const { data, error } = await supabase
    .from(RL_VIEWS.VARIANT_STATS)
    .select("*");

  if (error) throw new Error(`Failed to fetch variant stats: ${error.message}`);
  return (data ?? []) as VariantStatRow[];
}

// ─── Fetch top conversations for optimization ─────────────────────────────────

export async function getTopConversations(limit = 10): Promise<
  Array<{
    messages: Array<{ role: string; content: string }>;
    outcome: string;
    reward: number;
    variant_name: string;
  }>
> {
  const { data, error } = await supabase
    .from(RL_TABLES.OUTCOMES)
    .select(`
      reward, outcome,
      rl_conversations!inner(messages),
      rl_prompt_variants!inner(name)
    `)
    .gte("reward", 0.5)
    .order("reward", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to fetch top conversations: ${error.message}`);

  return (data ?? []).map((row: Record<string, unknown>) => ({
    messages: (row.rl_conversations as { messages: Array<{ role: string; content: string }> }).messages,
    outcome:  row.outcome as string,
    reward:   row.reward as number,
    variant_name: (row.rl_prompt_variants as { name: string }).name,
  }));
}
