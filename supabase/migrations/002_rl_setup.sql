-- ============================================================
-- Reinforcement Learning: Booking Conversion Optimization
-- ============================================================
-- Run AFTER 001_rag_setup.sql
-- ============================================================

-- ─── Prompt variants under A/B test ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rl_prompt_variants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL UNIQUE,
  description  TEXT,                        -- human-readable strategy explanation
  system_prompt TEXT NOT NULL,
  is_active    BOOLEAN DEFAULT TRUE,
  -- Thompson Sampling Beta(alpha, beta) parameters
  alpha        FLOAT DEFAULT 1.0,           -- 1 + weighted booking successes
  beta         FLOAT DEFAULT 1.0,           -- 1 + weighted non-bookings
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Conversation sessions ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rl_conversations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id     UUID REFERENCES rl_prompt_variants(id),
  messages       JSONB DEFAULT '[]',         -- full conversation history
  stage          TEXT DEFAULT 'greeting',    -- greeting | gathering | quoting | closing
  quote_amount   NUMERIC(10,2),             -- final quote shown (if any)
  metadata       JSONB DEFAULT '{}',
  started_at     TIMESTAMPTZ DEFAULT NOW(),
  ended_at       TIMESTAMPTZ
);

-- ─── Outcome/reward per conversation ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rl_outcomes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES rl_conversations(id) ON DELETE CASCADE,
  variant_id       UUID REFERENCES rl_prompt_variants(id),
  outcome          TEXT NOT NULL,          -- see OUTCOME_TYPES below
  reward           FLOAT NOT NULL,         -- continuous reward signal
  signals          JSONB DEFAULT '{}',     -- detected intermediate signals
  user_feedback    TEXT,                   -- optional explicit user rating
  recorded_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Valid outcome values (enforced by application):
-- 'booked'            reward = 1.0   — user explicitly confirmed booking
-- 'quote_accepted'    reward = 0.7   — user accepted quote positively
-- 'contact_provided'  reward = 0.5   — user shared phone/email
-- 'high_engagement'   reward = 0.3   — long engaged conversation
-- 'completed'         reward = 0.1   — conversation finished without clear signal
-- 'abandoned'         reward = -0.2  — user dropped off with no engagement
-- 'negative'          reward = -0.3  — user expressed frustration/refusal

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS rl_outcomes_variant_idx  ON rl_outcomes (variant_id);
CREATE INDEX IF NOT EXISTS rl_outcomes_outcome_idx  ON rl_outcomes (outcome);
CREATE INDEX IF NOT EXISTS rl_conversations_variant_idx ON rl_conversations (variant_id);

-- ─── Trigger: keep updated_at fresh ──────────────────────────────────────────
CREATE TRIGGER rl_variants_updated_at
  BEFORE UPDATE ON rl_prompt_variants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── View: per-variant stats ──────────────────────────────────────────────────
CREATE OR REPLACE VIEW rl_variant_stats AS
SELECT
  v.id,
  v.name,
  v.description,
  v.alpha,
  v.beta,
  v.is_active,
  v.created_at,
  COUNT(o.id)                                         AS total_conversations,
  ROUND(AVG(o.reward)::NUMERIC, 4)                    AS avg_reward,
  ROUND(SUM(CASE WHEN o.outcome = 'booked'         THEN 1 ELSE 0 END)::NUMERIC
        / NULLIF(COUNT(o.id), 0) * 100, 2)            AS booking_rate_pct,
  ROUND(SUM(CASE WHEN o.reward > 0 THEN 1 ELSE 0 END)::NUMERIC
        / NULLIF(COUNT(o.id), 0) * 100, 2)            AS positive_rate_pct,
  v.alpha / (v.alpha + v.beta)                        AS thompson_mean
FROM rl_prompt_variants v
LEFT JOIN rl_outcomes o ON o.variant_id = v.id
GROUP BY v.id, v.name, v.description, v.alpha, v.beta, v.is_active, v.created_at
ORDER BY thompson_mean DESC;

-- ─── Function: update Thompson Sampling params after an outcome ───────────────
CREATE OR REPLACE FUNCTION update_thompson_params(
  p_variant_id UUID,
  p_reward     FLOAT
)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_reward > 0 THEN
    -- Positive outcome: increment alpha (weighted by reward magnitude)
    UPDATE rl_prompt_variants
    SET alpha = alpha + p_reward, updated_at = NOW()
    WHERE id = p_variant_id;
  ELSE
    -- Negative/neutral outcome: increment beta
    UPDATE rl_prompt_variants
    SET beta = beta + ABS(p_reward), updated_at = NOW()
    WHERE id = p_variant_id;
  END IF;
END;
$$;

-- ─── Seed: initial prompt variants ───────────────────────────────────────────
INSERT INTO rl_prompt_variants (name, description, system_prompt) VALUES

('baseline',
 'Friendly and thorough — collects all info then presents detailed breakdown.',
 $PROMPT$You are a friendly moving quote assistant for a furniture taxi and moving service.

Gather through natural conversation:
1. Pickup address (city/area)
2. Delivery address
3. Floor details + elevator availability at both ends
4. All items to move (furniture, appliances, boxes)
5. Moving date/timeframe
6. Special items (piano, safe, artwork)

Pricing:
- Base: $80 (truck + 2 movers, 1 hour)
- Distance: $2.50/km beyond 10km
- Extra hours: $65/hour
- Stairs (no elevator): $15/floor at each address
- Small items/boxes: $5 | Medium: $10 | Large: $25 | Extra-large: $75

Once you have all details, show a clear itemized quote breakdown.
Be friendly, thorough, and professional.$PROMPT$),

('urgency',
 'Creates mild urgency around availability and booking slots.',
 $PROMPT$You are a moving quote specialist for a popular furniture taxi service. Slots fill up fast — help customers lock in their move quickly.

Gather through natural conversation:
1. Pickup address (city/area)
2. Delivery address
3. Floor details + elevator at both ends
4. All items (furniture, appliances, boxes)
5. Moving date — mention that weekends book 2–3 weeks ahead
6. Special items (piano, safe, artwork)

Pricing:
- Base: $80 (truck + 2 movers, 1 hour)
- Distance: $2.50/km beyond 10km
- Extra hours: $65/hour
- Stairs (no elevator): $15/floor at each end
- Small: $5 | Medium: $10 | Large: $25 | Extra-large: $75

After quoting, naturally mention that reserving a slot only takes a minute and protects their preferred date.
Be warm but create a gentle sense of momentum — help them take the next step today.$PROMPT$),

('empathy',
 'Leads with emotional rapport — acknowledges moving stress before quoting.',
 $PROMPT$You are a caring moving assistant who understands that moving is one of life's most stressful events. Your warmth and thoroughness put customers at ease.

Open by acknowledging the move and asking a warm question. Then gently gather:
1. Pickup address (city/area)
2. Delivery address
3. Floors + elevator at both ends
4. All items — let them describe freely, you categorize
5. Moving date
6. Anything fragile or precious they're worried about

Pricing:
- Base: $80 (truck + 2 movers, 1 hour)
- Distance: $2.50/km beyond 10km
- Extra hours: $65/hour
- Stairs (no elevator): $15/floor at each end
- Small: $5 | Medium: $10 | Large: $25 | Extra-large: $75

After quoting, reassure them their items are in good hands and offer to answer any concerns.
Be empathetic, patient, and make them feel their move is in safe hands.$PROMPT$),

('value_anchor',
 'Anchors value and savings vs. competitors before revealing the price.',
 $PROMPT$You are a value-focused moving consultant helping customers get the best deal on their move.

Gather through conversation:
1. Pickup address (city/area)
2. Delivery address
3. Floor details + elevator at both ends
4. All items to move
5. Moving date
6. Special items

Pricing:
- Base: $80 (truck + 2 movers, 1 hour)
- Distance: $2.50/km beyond 10km
- Extra hours: $65/hour
- Stairs (no elevator): $15/floor at each end
- Small: $5 | Medium: $10 | Large: $25 | Extra-large: $75

When presenting the quote, briefly note that most moving companies charge $120–160 base rate plus hidden fees. Frame your quote around the value: transparent pricing, no surprises, professional crew.
Help them see clearly what they're getting for their money.$PROMPT$),

('social_proof',
 'Builds trust through implied reputation and satisfied customers.',
 $PROMPT$You are a trusted moving assistant representing a 5-star-rated furniture taxi service with hundreds of happy customers.

Gather through friendly conversation:
1. Pickup address (city/area)
2. Delivery address
3. Floor details + elevator availability
4. All items (furniture, appliances, boxes)
5. Moving date
6. Special or fragile items

Pricing:
- Base: $80 (truck + 2 movers, 1 hour)
- Distance: $2.50/km beyond 10km
- Extra hours: $65/hour
- Stairs (no elevator): $15/floor at each end
- Small: $5 | Medium: $10 | Large: $25 | Extra-large: $75

When appropriate, naturally weave in trust signals: "Our crew handled a similar 2-bedroom move last week in 3 hours flat" or "Customers love how stress-free we make it."
End with the quote and a confident, warm close.$PROMPT$)

ON CONFLICT (name) DO NOTHING;
