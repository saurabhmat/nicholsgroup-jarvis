"use server";
// "Run now" on Home (T-231c). Order: lane id shape -> AAL2 session + owner role on the lane (requireRole) -> model
// configured -> the lane policy (unreadable: no run) -> a cooldown (one attempt per owner and lane every 2 minutes,
// from the newest attempt, failed ones included; enforced again in SQL by core.briefing_save_own under a lock) -> the
// run with the OWNER'S own lane client for every read (RLS applies) -> save with that same client through
// core.briefing_save_own (definer: owner = auth.uid()). No service client on this path. Errors return a code only; logs
// carry the class only.
import { getLLMProvider } from "@nichols/ai/config";
import type { LaneId } from "@nichols/core";
import { AuthError } from "@nichols/core/auth";
import { createBrainStore, loadBrainPromptContext, type BrainPromptContext, type ClientFor } from "@nichols/brain/server";
import { saveOwnBriefing } from "@nichols/briefing/jobs";
import { readGmailBody } from "@nichols/connectors/google";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { guards } from "@/lib/guards";
import { latestBriefing, viewerZone } from "@/lib/briefing";
import { policyFrom, runBriefing } from "@/lib/briefing-run";

export type RunNowState = { ok: true; status: string } | { error: "forbidden" | "not_configured" | "too_soon" | "unavailable" } | null;

const COOLDOWN_MS = 2 * 60_000;

const LANE = /^[A-Z]{1,8}$/;

export async function runBriefingNow(laneId: string): Promise<RunNowState> {
  if (typeof laneId !== "string" || !LANE.test(laneId)) return { error: "forbidden" };
  try {
    const g = await guards();
    const { client, session } = await g.requireRole(laneId as LaneId, ["owner"]);
    const p = getLLMProvider();
    if (!p.configured) return { error: "not_configured" };
    const latest = await latestBriefing(client, laneId);
    if (latest?.lastRunAt && Date.now() - Date.parse(latest.lastRunAt) < COOLDOWN_MS) return { error: "too_soon" };
    const pol = await client.schema("core").from("lane_policies").select("llm_allowed_categories, store_outbound_drafts").eq("lane_id", laneId).maybeSingle();
    if (pol.error) return { error: "unavailable" };
    const clientFor: ClientFor = async (l) => (await g.requireLane(l as LaneId)).client as never;
    let brain: BrainPromptContext | null = null;
    try {
      brain = await loadBrainPromptContext(createBrainStore({ clientFor, laneSettingsFor: async () => null }), { userId: session.userId, lanes: [laneId as LaneId] });
    } catch {
      brain = null;
    }
    const res = await runBriefing(
      {
        client,
        provider: p.provider,
        readBody: async (l, c, m) => (await readGmailBody(l, c, m)).text,
        brain,
        policy: policyFrom(pol.data),
        save: (l, r) => saveOwnBriefing(client, l, r),
      },
      { laneId: laneId as LaneId, ownerUserId: session.userId, trigger: "manual", now: new Date(), viewerTz: viewerZone((await cookies()).get("tz")?.value) },
    );
    revalidatePath(`/${laneId}`);
    return { ok: true, status: res.status };
  } catch (e) {
    if (e instanceof AuthError) return { error: "forbidden" };
    if (e instanceof Error && e.message === "briefing too_soon") return { error: "too_soon" };
    console.error("[briefing] run now failed", { laneId, error: e instanceof Error ? e.name : typeof e });
    return { error: "unavailable" };
  }
}
