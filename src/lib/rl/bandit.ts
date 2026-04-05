/**
 * Thompson Sampling bandit for prompt variant selection.
 *
 * Each variant has a Beta(alpha, beta) distribution over its expected reward.
 * We sample from each distribution and pick the variant with the highest sample.
 * This naturally balances exploration (new/uncertain variants) and exploitation
 * (variants with a proven track record).
 *
 * Reference: Thompson (1933), Chapelle & Li (2011).
 */

import { supabase } from "@/lib/supabase";
import { RL_TABLES, RL_FUNCTIONS, type PromptVariant } from "./schema";

// ─── Beta distribution sampling ───────────────────────────────────────────────

/** Standard normal via Box-Muller transform */
function sampleNormal(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Gamma(shape, 1) sample using Marsaglia-Tsang's method.
 * Required as a building block for Beta sampling.
 */
function sampleGamma(shape: number): number {
  if (shape < 1) {
    // Reduction: Gamma(a) = Gamma(a+1) * U^(1/a)
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number, v: number;
    do {
      x = sampleNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Sample from Beta(alpha, beta) in [0, 1].
 * Represents the probability that this variant converts a conversation.
 */
export function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

// ─── Variant selection ────────────────────────────────────────────────────────

/**
 * Select the best variant using Thompson Sampling.
 * Fetches active variants from DB, samples from each Beta posterior,
 * and returns the variant with the highest sample (most promising).
 */
export async function selectVariant(): Promise<PromptVariant> {
  const { data: variants, error } = await supabase
    .from(RL_TABLES.VARIANTS)
    .select("*")
    .eq("is_active", true);

  if (error || !variants || variants.length === 0) {
    throw new Error("No active prompt variants found. Run 002_rl_setup.sql.");
  }

  // Sample from Beta(alpha, beta) for each variant, pick the max
  let bestVariant: PromptVariant = variants[0];
  let bestSample = -Infinity;

  for (const variant of variants as PromptVariant[]) {
    const sample = sampleBeta(variant.alpha, variant.beta);
    if (sample > bestSample) {
      bestSample = sample;
      bestVariant = variant;
    }
  }

  return bestVariant;
}

// ─── Parameter update ─────────────────────────────────────────────────────────

/**
 * Update the Beta distribution parameters after observing an outcome.
 * Delegates to the Postgres function so the update is atomic.
 *
 * Positive reward → alpha++ (success)
 * Negative/zero reward → beta++ (failure)
 */
export async function updateThompsonParams(
  variantId: string,
  reward: number
): Promise<void> {
  const { error } = await supabase.rpc(RL_FUNCTIONS.UPDATE_THOMPSON, {
    p_variant_id: variantId,
    p_reward: reward,
  });
  if (error) throw new Error(`Thompson update failed: ${error.message}`);
}
