"use server";
// "Run now" on Home (T-231c). Order: lane id shape -> AAL2 session + owner role on the lane (requireRole) -> model
// configured -> the lane policy (unreadable: no run) -> a cooldown (one attempt per owner and lane every 2 minutes,
// from the newest attempt, failed ones included; enforced again in SQL by core.briefing_save_own under a lock) -> the
// run with the OWNER'S own lane client for every read (RLS applies) -> save with that same client through
// core.briefing_save_own (definer: owner = auth.uid()). No service client in briefing code on this path; reply drafts
// become proposals through the approvals module's bound proposeBriefingReply (T-231d), which keeps its own job client
// inside the module (rule 5 boundary) and only proposes. Errors return a code only; logs carry the class only.
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
import { revalidatePath } from "next/cache";
import { guards } from "@/lib/guards";
import { latestBriefing, viewerZone } from "@/lib/briefing";
import { policyFrom, runBriefingBounded } from "@/lib/briefing-run";
import { replyProposer } from "@/lib/briefing-proposals";

// `reason` is a fixed failure code (domain/failure.ts); the client maps it to short text and, for admins, a hint.
export type RunNowState =
  | { ok: true; status: string; reason?: FailureCode; hint?: string }
  | { error: "forbidden" | "not_configured" | "too_soon" | "busy" | "unavailable"; reason?: FailureCode; hint?: string }
  | null;

const COOLDOWN_MS = 2 * 60_000;

const LANE = /^[A-Z]{1,8}$/;

export async function runBriefingNow(laneId: string): Promise<RunNowState> {
  if (typeof laneId !== "string" || !LANE.test(laneId)) return { error: "forbidden" };
  try {
    const g = await guards();
    const { client, session } = await g.requireRole(laneId as LaneId, ["owner"]);
    // 60 s per model call, one retry: the whole run is bounded again by RUN_NOW_TIMEOUT_MS (Home's maxDuration is 90 s).
    const p = getLLMProvider({ timeoutMs: 60_000, maxRetries: 1 });
    // Run now is owner-only and owners are admins, so the hint (names only) goes with every coded reason here.
    if (!p.configured) {
      const setup = aiSetupFailure();
      const code = setup?.code ?? "key_missing";
      return { error: "not_configured", reason: code, hint: adminHint(code, setup?.names ?? []) };
    }
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
    const res = await runBriefingBounded(
      {
        client,
        provider: p.provider,
        readBody: async (l, c, m) => (await readGmailBody(l, c, m)).text,
        brain,
        policy: policyFrom(pol.data),
        save: (l, r) => saveOwnBriefing(client, l, r),
        proposeReply: replyProposer(session.userId),
      },
      { laneId: laneId as LaneId, ownerUserId: session.userId, trigger: "manual", now: new Date(), viewerTz: viewerZone((await cookies()).get("tz")?.value) },
    );
    if ("busy" in res) return { error: "busy" };
    revalidatePath(`/${laneId}`);
    return { ok: true, status: res.status, ...(res.reason ? { reason: res.reason, hint: adminHint(res.reason) } : {}) };
  } catch (e) {
    if (e instanceof AuthError) return { error: "forbidden" };
    // A bad AI setting in production throws EnvValidationError (names only): say which code, never the message.
    if (e instanceof Error && e.name === "EnvValidationError") { const reason = classifyFailure(e); return { error: "not_configured", reason, hint: adminHint(reason) }; }
    if (e instanceof Error && e.message === "briefing too_soon") return { error: "too_soon" };
    console.error("[briefing] run now failed", { laneId, error: e instanceof Error ? e.name : typeof e });
    return { error: "unavailable" };
  }
}
