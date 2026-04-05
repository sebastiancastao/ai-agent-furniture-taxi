/**
 * POST /api/rl/optimize
 * Trigger policy optimization: analyse top conversations and synthesise
 * a new improved prompt variant using Claude.
 *
 * Should be called periodically (e.g. via a cron job) — not on every request.
 */

import { runOptimization } from "@/lib/rl/optimizer";

export const maxDuration = 60;

export async function POST() {
  try {
    const result = await runOptimization();
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[RL optimize]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
