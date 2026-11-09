// H-042: the onboarding page's access check, run by the proxy BEFORE streaming starts, so a user without the owner role
// and the brain view gets a real 404 status. The page (components/onboarding-page.tsx) still checks again and renders
// nothing for them; this only decides the status code. Same rule as the page, the menu entry and the interview route:
// owner in the lane (has_lane_role) and the lane in allowed_lanes(uid, 'brain').
import { AuthError, type Guards } from "@nichols/core/auth";

type Rpc = { schema(s: string): { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> } };

/** `/<lane>/onboarding` and anything under it, also percent-encoded (Next matches routes on the decoded path). */
export function isOnboardingPath(pathname: string): boolean {
  const second = pathname.split("/")[2];
  if (second === undefined) return false;
  try {
    return decodeURIComponent(second) === "onboarding";
  } catch {
    return false;
  }
}

/**
 * "denied": not a member or not an owner of the lane (requireRole includes the lane check), or the lane is not in the
 * user's brain-view lanes. Note: requireRole also reports a failed has_lane_role call as "forbidden", so during that
 * outage an owner gets the 404 too (fails closed; the page would refuse in the same case).
 * "unknown": session problems, other outages, an unreadable allowed_lanes answer: the proxy passes the request on and
 * the page decides.
 */
export async function onboardingVerdict(guards: Pick<Guards, "requireRole">, laneId: string): Promise<"allowed" | "denied" | "unknown"> {
  let ctx: Awaited<ReturnType<Guards["requireRole"]>>;
  try {
    ctx = await guards.requireRole(laneId, ["owner"]);
  } catch (e) {
    return e instanceof AuthError && e.reason === "forbidden" ? "denied" : "unknown";
  }
  try {
    const { data, error } = await (ctx.client as unknown as Rpc).schema("core").rpc("allowed_lanes", { p_uid: ctx.session.userId, p_view: "brain" });
    if (error || !Array.isArray(data)) return "unknown";
    return data.includes(laneId) ? "allowed" : "denied";
  } catch {
    return "unknown";
  }
}
