/**
 * RL System — Schema constants
 * Mirrors supabase/migrations/002_rl_setup.sql
 */

export const RL_TABLES = {
  VARIANTS:      "rl_prompt_variants",
  CONVERSATIONS: "rl_conversations",
  OUTCOMES:      "rl_outcomes",
} as const;

export const RL_VIEWS = {
  VARIANT_STATS: "rl_variant_stats",
} as const;

export const RL_FUNCTIONS = {
  UPDATE_THOMPSON: "update_thompson_params",
} as const;

// ─── Outcome types + rewards ──────────────────────────────────────────────────

export const OUTCOMES = {
  BOOKED:           { key: "booked",           reward: 1.0 },
  QUOTE_ACCEPTED:   { key: "quote_accepted",   reward: 0.7 },
  CONTACT_PROVIDED: { key: "contact_provided", reward: 0.5 },
  HIGH_ENGAGEMENT:  { key: "high_engagement",  reward: 0.3 },
  COMPLETED:        { key: "completed",        reward: 0.1 },
  ABANDONED:        { key: "abandoned",        reward: -0.2 },
  NEGATIVE:         { key: "negative",         reward: -0.3 },
} as const;

export type OutcomeKey = keyof typeof OUTCOMES;
export type OutcomeValue = (typeof OUTCOMES)[OutcomeKey];

// ─── Conversation stages ──────────────────────────────────────────────────────

export const STAGES = {
  GREETING:   "greeting",
  GATHERING:  "gathering",
  QUOTING:    "quoting",
  CLOSING:    "closing",
} as const;

// ─── DB row types ─────────────────────────────────────────────────────────────

export type PromptVariant = {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  is_active: boolean;
  alpha: number;
  beta: number;
  created_at: string;
  updated_at: string;
};

export type ConversationRow = {
  id: string;
  variant_id: string;
  messages: Array<{ role: string; content: string }>;
  stage: string;
  quote_amount: number | null;
  metadata: Record<string, unknown>;
  started_at: string;
  ended_at: string | null;
};

export type OutcomeRow = {
  id: string;
  conversation_id: string;
  variant_id: string;
  outcome: string;
  reward: number;
  signals: Record<string, unknown>;
  user_feedback: string | null;
  recorded_at: string;
};

export type VariantStatRow = {
  id: string;
  name: string;
  description: string | null;
  alpha: number;
  beta: number;
  is_active: boolean;
  created_at: string;
  total_conversations: number;
  avg_reward: number | null;
  booking_rate_pct: number | null;
  positive_rate_pct: number | null;
  thompson_mean: number;
};
