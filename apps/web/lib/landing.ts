// Where a user lands after finishing sign-in (T-023). A server-action redirect to "/" would render the first lane under
// the "/" URL (the entry page redirects while streaming, and client navigation keeps the old address), so the actions
// resolve the first allowed lane themselves. The lane list comes from the server-side guards, never from the URL.
import "server-only";
import type { Guards } from "@nichols/core/auth";
import { guards } from "@/lib/guards";
import { loadLaneGate } from "@/lib/lane-modules";

/**
 * The company a user lands on when no page was asked for (T-265). The list is ordered by code, so a mail-only company (one that limits
 * itself to a module list) could otherwise become the landing page of someone who also has a full company. Companies that show every
 * module come first, then limited ones; within each group the order is unchanged. One config read per company, only for a user with
 * two or more; an unreadable config counts as not limited (the order is then the plain one).
 */
export async function firstLaneId(g: Pick<Guards, "listLanes" | "requireLane">): Promise<string | undefined> {
  const lanes = await g.listLanes();
  if (lanes.length < 2) return lanes[0]?.laneId;
  const limited = await Promise.all(
    lanes.map(async (l) => {
      try {
        const { client } = await g.requireLane(l.laneId as Parameters<Guards["requireLane"]>[0]);
        return (await loadLaneGate(client, l.laneId)).limited;
      } catch {
        return false;
      }
    }),
  );
  return (lanes.find((_, i) => !limited[i]) ?? lanes[0])?.laneId;
}

export async function landingPath(next: string): Promise<string> {
  // Only the entry page ("/", with or without a query) is resolved; any other return path is kept as it is.
  if (new URL(next, "http://entry.invalid").pathname !== "/") return next;
  try {
    const first = await firstLaneId(await guards());
    return first ? `/${first}` : "/";
  } catch {
    return "/"; // the entry page shows the right error or notice
  }
}
