// The server-side lane check for every page under /[laneId] (T-023). The lane comes from the URL and is NEVER trusted:
// requireLane (T-017) verifies the session at AAL2, the lane's registry row (enabled, served here) and the user's
// membership through the lane router. Any failure to open the lane is answered with 404, the same for an unknown,
// disabled or not-yours lane, so the response does not reveal which lanes exist. proxy.ts is not the gate; the layout
// AND each page call this (a layout is not re-rendered on client navigation between its pages). Memoised per request.
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { AuthError } from "@nichols/core/auth";
import type { LaneSummary } from "@nichols/core/lanes";
import { guards } from "./guards";
import { timed } from "./timed";

export type LoadedLane = { laneId: string; name: string; lanes: LaneSummary[]; /** The verified session's user id (from the same lane check). */ userId: string };

export const loadLane = cache(async (laneParam: string): Promise<LoadedLane> => {
  await connection(); // per request, never prerendered
  const g = await guards();
  try {
    // (A refused lane now costs one extra read: the list is fetched in parallel and its result is unused.)
    // The lane check and the lane list are independent (both read the one session): run them together. If both fail, the
    // lane check's error wins, as when they ran in sequence.
    const [check, list] = await Promise.allSettled([timed("lane.check", () => g.requireLane(laneParam)), timed("lane.list", () => g.listLanes())]);
    if (check.status === "rejected") throw check.reason;
    if (list.status === "rejected") throw list.reason;
    const lanes = list.value;
    const lane = lanes.find((l) => l.laneId === laneParam);
    if (!lane) notFound();
    return { laneId: lane.laneId, name: lane.name, lanes, userId: check.value.session.userId };
  } catch (e) {
    if (e instanceof AuthError) {
      if (e.reason === "no_session") redirect("/sign-in");
      if (e.reason === "mfa_required") redirect("/mfa");
      notFound();
    }
    throw e; // an outage or misconfiguration is an error page, never a 404 and never access
  }
});
