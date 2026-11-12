"use server";
// Automatic AI summary on Home (T-235 part 1; replaces "Run now", T-231c). Three owner-only actions:
//   ensureFreshBriefing(lane)  the Home trigger (a client effect, once per page load): starts a background run when the latest
//                              briefing is older than 3 hours;
//   regenerateBriefing(lane)   the "Regenerate" menu item (once per 30 minutes);
//   briefingRunState(lane)     the cheap poll: is a run open, and what is the newest briefing time.
// Order for a start: lane id shape -> AAL2 session + owner role (requireRole) -> model configured -> the lane policy (unreadable:
// no run) -> the SQL CLAIM (core.briefing_claim_auto / _regenerate: stale, one running per lane, 6 per lane per New York day,
// 10-minute pause, Regenerate 30 minutes; refusals come back as a gate code, nothing is raised) -> the run goes into Next's after():
// the action returns {started: true} at once and the page is never blocked. Everything the run needs is captured BEFORE after()
// (the owner's lane client carries a bearer token, not cookies; after() callbacks cannot read cookies). The run reuses
// runBriefingBounded: a 75 s abort that guards every write, single-flight, coded failure reasons (a failed attempt is saved with
// its code); its save through core.briefing_save_own closes the claim. Home's maxDuration (90 s) covers the action and the after().
// No service client on this path; reply drafts become proposals through the approvals module. Errors are codes; logs carry the class only.
import { getLLMProvider } from "@nichols/ai/config";
import type { LaneId } from "@nichols/core";
import { AuthError } from "@nichols/core/auth";
import { createBrainStore, loadBrainPromptContext, type BrainPromptContext, type ClientFor } from "@nichols/brain/server";
import { saveOwnBriefing } from "@nichols/briefing/jobs";
import { classifyFailure, type FailureCode } from "@nichols/briefing/domain";
import { adminHint } from "@nichols/briefing/hints";
import { aiSetupFailure } from "@/lib/briefing-setup";
import { readGmailBody } from "@nichols/connectors/google";
import { cookies } from "next/headers";
import { after } from "next/server";
import { guards } from "@/lib/guards";
import { viewerZone } from "@/lib/briefing";
import { policyFrom, runBriefingBounded } from "@/lib/briefing-run";
import { replyProposer } from "@/lib/briefing-proposals";
import { briefingRunStateFrom, type BriefingGate, type BriefingRunStateView } from "@/lib/briefing-runs";

export type BriefingStartState =
  | { started: true }
  | { started: false; gate: BriefingGate }
  | { error: "forbidden" | "not_configured" | "unavailable"; reason?: FailureCode; hint?: string };

const LANE = /^[A-Z]{1,8}$/;
const GATES: readonly string[] = ["not_stale", "running", "cap_reached", "cooldown", "rate_limited"];

async function start(laneId: string, kind: "auto" | "regenerate"): Promise<BriefingStartState> {
  if (typeof laneId !== "string" || !LANE.test(laneId)) return { error: "forbidden" };
  try {
    const g = await guards();
    const { client, session } = await g.requireRole(laneId as LaneId, ["owner"]);
    // 60 s per model call, one SDK retry; the whole run is bounded again by RUN_NOW_TIMEOUT_MS inside after().
    const p = getLLMProvider({ timeoutMs: 60_000, maxRetries: 1 });
    if (!p.configured) {
      const setup = aiSetupFailure();
      const code = setup?.code ?? "key_missing";
      return { error: "not_configured", reason: code, hint: adminHint(code, setup?.names ?? []) };
    }
    const pol = await client.schema("core").from("lane_policies").select("llm_allowed_categories, store_outbound_drafts").eq("lane_id", laneId).maybeSingle();
    if (pol.error) return { error: "unavailable" };
    const claim = await client.schema("core").rpc(kind === "auto" ? "briefing_claim_auto" : "briefing_claim_regenerate", { p_lane: laneId });
    if (claim.error) return { error: "unavailable" };
    const res = claim.data as { id?: unknown; gate?: unknown } | null;
    if (typeof res?.gate === "string") return { started: false, gate: (GATES.includes(res.gate) ? res.gate : "running") as BriefingGate };
    if (typeof res?.id !== "string") return { error: "unavailable" };
    // Captured now: the cookie-backed pieces. The lane client is a bearer-token client and stays valid inside after().
    const viewerTz = viewerZone((await cookies()).get("tz")?.value);
    const policy = policyFrom(pol.data);
    const userId = session.userId;
    const provider = p.provider;
    const clientFor: ClientFor = async () => client as never;
    after(async () => {
      try {
        let brain: BrainPromptContext | null = null;
        try {
          brain = await loadBrainPromptContext(createBrainStore({ clientFor, laneSettingsFor: async () => null }), { userId, lanes: [laneId as LaneId] });
        } catch {
          brain = null;
        }
        await runBriefingBounded(
          {
            client,
            provider,
            readBody: async (l, c, m) => (await readGmailBody(l, c, m)).text,
            brain,
            policy,
            save: (l, r) => saveOwnBriefing(client, l, r),
            proposeReply: replyProposer(userId),
          },
          { laneId: laneId as LaneId, ownerUserId: userId, trigger: "manual", now: new Date(), viewerTz },
        );
      } catch (e) {
        // The claim stays open until the next claim closes it as lost (10 minutes); nothing else to do here.
        console.error("[briefing] background run failed", { laneId, kind, error: e instanceof Error ? e.name : typeof e, reason: classifyFailure(e) });
      }
    });
    return { started: true };
  } catch (e) {
    if (e instanceof AuthError) return { error: "forbidden" };
    if (e instanceof Error && e.name === "EnvValidationError") {
      const reason = classifyFailure(e);
      return { error: "not_configured", reason, hint: adminHint(reason) };
    }
    console.error("[briefing] start failed", { laneId, kind, error: e instanceof Error ? e.name : typeof e });
    return { error: "unavailable" };
  }
}

/** Home trigger: a background run when the owner's latest briefing is older than 3 hours (the SQL claim decides). */
export async function ensureFreshBriefing(laneId: string): Promise<BriefingStartState> {
  return start(laneId, "auto");
}

/** The "Regenerate" menu item: owner only, once per 30 minutes, inside the daily cap (all enforced in SQL). */
export async function regenerateBriefing(laneId: string): Promise<BriefingStartState> {
  return start(laneId, "regenerate");
}

/** The poll: owner only; null when not allowed or unreadable. */
export async function briefingRunState(laneId: string): Promise<BriefingRunStateView | null> {
  if (typeof laneId !== "string" || !LANE.test(laneId)) return null;
  try {
    const g = await guards();
    const { client } = await g.requireRole(laneId as LaneId, ["owner"]);
    const { data, error } = await client.schema("core").rpc("briefing_run_state", { p_lane: laneId });
    return error ? null : briefingRunStateFrom(data);
  } catch {
    return null;
  }
}
