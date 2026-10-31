// Sample protected route (T-017): 200 only for a verified AAL2 member of an enabled lane; 401/403 otherwise.
// Returns the lane code only, never lane data.
import { authErrorResponse } from "@nichols/core/auth";
import { guards } from "@/lib/guards";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: RouteContext<"/api/lanes/[laneId]">) {
  const { laneId } = await ctx.params;
  try {
    const { requireLane } = await guards();
    await requireLane(laneId);
    return Response.json({ lane: laneId }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
