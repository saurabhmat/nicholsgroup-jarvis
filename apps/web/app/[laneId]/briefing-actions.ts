"use server";
// Automatic AI summary on Home (T-235 part 1; replaces the old manual button, T-231c). Three owner-only actions:
//   ensureFreshBriefing(lane)  the Home trigger (a client effect, once per page load): starts a background run when the latest
//                              briefing is older than 3 hours;
//   regenerateBriefing(lane)   the "Regenerate" menu item (once per 30 minutes);
//   briefingRunState(lane)     the cheap poll: is a run open, and what is the newest briefing time.
// Order for a start: lane id shape -> AAL2 session + owner role (requireRole) -> model configured -> the lane policy (unreadable:
// no run) -> the tz cookie (read BEFORE the claim) -> sources (the owner must hold the mail view: gate `no_sources`, before the
// claim) -> the SQL CLAIM (core.briefing_claim_auto / _regenerate: stale, one running per lane, 6 per lane per New York day,
// 10-minute pause, Regenerate 30 minutes; refusals come back as a gate code, nothing is raised) -> the brain context is loaded
// (while cookies are available, 1.5 s limit; every lane client it needs is resolved through requireLane in that window, never
// the current lane's client for another lane) -> the run goes into Next's after(): the action returns {started: true} at once
// and the page is never blocked. Whatever fails between the claim and after() releases the claim (core.briefing_claim_release,
// closed as lost, not counted toward the cap), so no claim leaks. The run reuses runBriefingBounded: a 60 s abort whose timer
// starts at the action's start (the brain load is inside the budget), single-flight, coded failure reasons; its save through
// core.briefing_save_own closes the claim. Home's maxDuration (90 s) covers the action and the after().
// The run state and the cap are lane-wide by design: one cost cap per lane, whichever owner opens Home.
// No service client on this path; reply drafts become proposals through the approvals module. Errors are codes; logs carry the class only.
import { getLLMProvider } from "@nichols/ai/config";
import type { LaneId } from "@nichols/core";
import { AuthError } from "@nichols/core/auth";
import { LaneAccessError } from "@nichols/core/lane-router";
import { parseCoverageRows } from "@nichols/briefing/domain";
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
import { BACKGROUND_RUN_TIMEOUT_MS, policyFrom, runBriefingBounded } from "@/lib/briefing-run";
import { replyProposer } from "@/lib/briefing-proposals";
import { briefingRunStateFrom, type BriefingGate, type BriefingRunStateView } from "@/lib/briefing-runs";

export type BriefingStartState =
  | { started: true }
  | { started: false; gate: BriefingGate }
  | { error: "forbidden" | "not_configured" | "unavailable"; reason?: FailureCode; hint?: string };

const LANE = /^[A-Z]{1,8}$/;
const GATES: readonly string[] = ["not_stale", "running", "cap_reached", "cooldown", "rate_limited"];
const BRAIN_LOAD_MS = 1500;

async function start(laneId: string, kind: "auto" | "regenerate"): Promise<BriefingStartState> {
  const t0 = Date.now();
  if (typeof laneId !== "string" || !LANE.test(laneId)) return { error: "forbidden" };
  let client: Awaited<ReturnType<Awaited<ReturnType<typeof guards>>["requireRole"]>>["client"] | null = null;
  let claimId: string | null = null;
  let handedOff = false;
  const release = async () => {
    if (!client || !claimId || handedOff) return;
    try {
      await client.schema("core").rpc("briefing_claim_release", { p_lane: laneId, p_claim: claimId });
    } catch {
      /* best effort: the next claim closes it as lost after 10 minutes */
    }
  };
  try {
    const g = await guards();
    const role = await g.requireRole(laneId as LaneId, ["owner"]);
    client = role.client;
    const { session } = role;
    const lane = client;
    // 60 s per model call, one SDK retry; the whole run is bounded again by BACKGROUND_RUN_TIMEOUT_MS inside after().
    const p = getLLMProvider({ timeoutMs: 60_000, maxRetries: 1 });
    if (!p.configured) {
      const setup = aiSetupFailure();
      const code = setup?.code ?? "key_missing";
      return { error: "not_configured", reason: code, hint: adminHint(code, setup?.names ?? []) };
    }
    const pol = await lane.schema("core").from("lane_policies").select("llm_allowed_categories, store_outbound_drafts").eq("lane_id", laneId).maybeSingle();
    if (pol.error) return { error: "unavailable" };
    // Cookie-backed values first: nothing between the claim and after() can fail on them.
    const viewerTz = viewerZone((await cookies()).get("tz")?.value);
    // No sources, no run: the owner must hold the mail view (the briefing is built on the mail index). Before the claim.
    const cov = await lane.schema("core").rpc("briefing_coverage", { p_lane: laneId });
    if (cov.error) return { error: "unavailable" };
    if (!parseCoverageRows(cov.data).some((c) => c.stream === "mail")) return { started: false, gate: "no_sources" };
    const claim = await lane.schema("core").rpc(kind === "auto" ? "briefing_claim_auto" : "briefing_claim_regenerate", { p_lane: laneId });
    if (claim.error) return { error: "unavailable" };
    const res = claim.data as { id?: unknown; gate?: unknown } | null;
    // An unknown gate is a no-op for the card (never "running": that would start a poll for nothing).
    if (typeof res?.gate === "string") return { started: false, gate: (GATES.includes(res.gate) ? res.gate : "not_stale") as BriefingGate };
    if (typeof res?.id !== "string") return { error: "unavailable" };
    claimId = res.id;

    const policy = policyFrom(pol.data);
    const userId = session.userId;
    const provider = p.provider;
    // Every lane client the brain context needs is resolved NOW (cookies are available), through requireLane for that exact lane;
    // after the load window closes, any further request is refused: never the current lane's client for another lane.
    let open = true;
    const resolved = new Map<string, Promise<never>>();
    const clientFor: ClientFor = (l) => {
      if (!open) return Promise.reject(new LaneAccessError("not_allowed"));
      let c = resolved.get(l);
      if (c === undefined) {
        c = g.requireLane(l as LaneId).then((r) => r.client as never);
        resolved.set(l, c);
      }
      return c;
    };
    let brain: BrainPromptContext | null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const load = loadBrainPromptContext(createBrainStore({ clientFor, laneSettingsFor: async () => null }), { userId, lanes: [laneId as LaneId] });
      load.catch(() => undefined);
      brain = await Promise.race([load, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), BRAIN_LOAD_MS)))]);
    } catch {
      brain = null;
    } finally {
      clearTimeout(timer);
      open = false;
    }
    const id = claimId;
    after(async () => {
      try {
        const out = await runBriefingBounded(
          {
            client: lane,
            provider,
            readBody: async (l, c, m) => (await readGmailBody(l, c, m)).text,
            brain,
            policy,
            save: (l, r) => saveOwnBriefing(lane, l, r),
            proposeReply: replyProposer(userId),
          },
          { laneId: laneId as LaneId, ownerUserId: userId, trigger: "manual", now: new Date(), viewerTz },
          { timeoutMs: Math.max(5_000, BACKGROUND_RUN_TIMEOUT_MS - (Date.now() - t0)) },
        );
        if ("busy" in out) {
          await lane.schema("core").rpc("briefing_claim_release", { p_lane: laneId, p_claim: id });
        }
      } catch (e) {
        // The run died before its save: close the claim (lost) so the card stops showing "Updating summary…".
        console.error("[briefing] background run failed", { laneId, kind, error: e instanceof Error ? e.name : typeof e, reason: classifyFailure(e) });
        try {
          await lane.schema("core").rpc("briefing_claim_release", { p_lane: laneId, p_claim: id });
        } catch {
          /* the next claim closes it as lost */
        }
      }
    });
    handedOff = true;
    return { started: true };
  } catch (e) {
    await release();
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
