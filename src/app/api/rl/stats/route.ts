/** GET /api/rl/stats — per-variant performance dashboard data */

import { getVariantStats } from "@/lib/rl/tracker";

export async function GET() {
  try {
    const stats = await getVariantStats();
    return Response.json({ variants: stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
