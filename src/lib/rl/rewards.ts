/**
 * Reward signal detection for the moving quote conversation.
 *
 * Combines fast keyword heuristics (no LLM call) with an optional
 * Claude-powered classification for ambiguous cases.
 */

import Anthropic from "@anthropic-ai/sdk";
import { OUTCOMES, type OutcomeKey } from "./schema";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Keyword heuristics ───────────────────────────────────────────────────────

const BOOKING_SIGNALS = [
  /\b(book|booking|reserve|confirm|let'?s do it|sign me up|i'?m in|go ahead)\b/i,
  /\b(when can you come|what'?s your availability|how do i pay|payment)\b/i,
  /\b(deal|perfect|sounds good|great price|that works)\b/i,
];

const CONTACT_SIGNALS = [
  /\b(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})\b/,          // phone number
  /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i,   // email
  /\b(call me|my number is|my email is|reach me)\b/i,
];

const NEGATIVE_SIGNALS = [
  /\b(too expensive|can'?t afford|never mind|forget it|not interested|too much)\b/i,
  /\b(going with someone else|found another|other company)\b/i,
];

const ACCEPTANCE_SIGNALS = [
  /\b(accept|that'?s fair|reasonable|ok with that|happy with|works for me)\b/i,
  /\b(proceed|move forward|let'?s go|yes please)\b/i,
];

type DetectedSignals = {
  hasBookingKeyword: boolean;
  hasContactInfo: boolean;
  hasNegativeKeyword: boolean;
  hasAcceptanceKeyword: boolean;
  messageCount: number;
  lastUserMessage: string;
};

function detectHeuristicSignals(
  messages: Array<{ role: string; content: string }>
): DetectedSignals {
  const userMessages = messages.filter((m) => m.role === "user");
  const lastUserMessage = userMessages.at(-1)?.content ?? "";
  const allUserText = userMessages.map((m) => m.content).join(" ");

  return {
    hasBookingKeyword:    BOOKING_SIGNALS.some((r)  => r.test(allUserText)),
    hasContactInfo:       CONTACT_SIGNALS.some((r)  => r.test(allUserText)),
    hasNegativeKeyword:   NEGATIVE_SIGNALS.some((r) => r.test(allUserText)),
    hasAcceptanceKeyword: ACCEPTANCE_SIGNALS.some((r) => r.test(allUserText)),
    messageCount:         userMessages.length,
    lastUserMessage,
  };
}

// ─── LLM classification (for ambiguous / longer conversations) ────────────────

type LLMSignal = {
  outcome: OutcomeKey;
  confidence: number;   // 0–1
  reasoning: string;
};

export async function classifyConversationOutcome(
  messages: Array<{ role: string; content: string }>
): Promise<LLMSignal> {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "Customer" : "Agent"}: ${m.content}`)
    .join("\n");

  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: `Classify this moving service conversation's outcome. Return ONLY valid JSON.

Conversation:
${transcript}

Classify as one of:
- "BOOKED"           — customer explicitly confirmed/booked
- "QUOTE_ACCEPTED"   — customer accepted the price positively
- "CONTACT_PROVIDED" — customer shared phone/email
- "HIGH_ENGAGEMENT"  — long, engaged conversation with real interest
- "COMPLETED"        — normal conversation ended without clear signal
- "ABANDONED"        — customer disengaged early / gave up
- "NEGATIVE"         — customer was frustrated or rejected the offer

Return JSON: {"outcome": "KEY", "confidence": 0.0-1.0, "reasoning": "one sentence"}`,
      },
    ],
  });

  try {
    const text =
      response.content[0].type === "text" ? response.content[0].text : "{}";
    const match = text.match(/\{[\s\S]*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as LLMSignal;
      return parsed;
    }
  } catch {
    // fall through to default
  }

  return { outcome: "COMPLETED", confidence: 0.5, reasoning: "Could not classify" };
}

// ─── Combined reward computation ──────────────────────────────────────────────

export type RewardResult = {
  outcome: OutcomeKey;
  reward: number;
  signals: DetectedSignals & { llmOutcome?: string; llmConfidence?: number };
};

/**
 * Compute the reward for a completed conversation.
 *
 * Strategy:
 * 1. Run fast keyword heuristics (synchronous)
 * 2. If booking/negative detected with high confidence → return immediately
 * 3. Otherwise run Claude classification for nuanced cases
 */
export async function computeReward(
  messages: Array<{ role: string; content: string }>,
  explicitOutcome?: OutcomeKey   // set when the user clicks "Book" in the UI
): Promise<RewardResult> {
  // Explicit outcome from UI always wins
  if (explicitOutcome) {
    return {
      outcome: explicitOutcome,
      reward: OUTCOMES[explicitOutcome].reward,
      signals: detectHeuristicSignals(messages),
    };
  }

  const signals = detectHeuristicSignals(messages);

  // High-confidence heuristic shortcuts
  if (signals.hasBookingKeyword) {
    return { outcome: "BOOKED", reward: OUTCOMES.BOOKED.reward, signals };
  }
  if (signals.hasNegativeKeyword) {
    return { outcome: "NEGATIVE", reward: OUTCOMES.NEGATIVE.reward, signals };
  }
  if (signals.hasContactInfo) {
    return { outcome: "CONTACT_PROVIDED", reward: OUTCOMES.CONTACT_PROVIDED.reward, signals };
  }

  // Short / disengaged conversations → abandoned
  if (signals.messageCount <= 1) {
    return { outcome: "ABANDONED", reward: OUTCOMES.ABANDONED.reward, signals };
  }

  // Use LLM for everything else
  const llm = await classifyConversationOutcome(messages);
  const outcomeKey = (llm.outcome in OUTCOMES ? llm.outcome : "COMPLETED") as OutcomeKey;

  return {
    outcome: outcomeKey,
    reward: OUTCOMES[outcomeKey].reward,
    signals: {
      ...signals,
      llmOutcome: llm.outcome,
      llmConfidence: llm.confidence,
    },
  };
}
