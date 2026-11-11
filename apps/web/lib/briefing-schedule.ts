// The scheduled briefing (T-231c): which owners are due, and one run. Wired into the Inngest route, which passes
// `clientFor` (the job client: only the route creates it). Off unless lane_config.briefing.schedule_enabled is true.
// Every run re-checks the owner's membership and views (briefing, comms, calendar). The job client reads the whole lane's
// mail index: today an owner may see every mailbox in the lane (comms RLS is per lane, not per mailbox), so this equals
// what the owner's own "Run now" sees. If RLS ever narrows to a mailbox or connection, this path must filter by owner.
// The brain profile needs the owner's session, so a scheduled run goes without it (note "no_brain_in_schedule").
import { getLLMProvider } from "@nichols/ai/config";
import type { LaneId } from "@nichols/core";
import { isBriefingDue } from "@nichols/core/inngest";
import { briefingOwners, saveBriefing } from "@nichols/briefing/jobs";
import { readGmailBody } from "@nichols/connectors/google";
import { BUSINESS_TZ } from "@nichols/briefing/domain";
import { briefingConfigFrom } from "./briefing";
import { policyFrom, runBriefing } from "./briefing-run";
import { replyProposer } from "./briefing-proposals";

type Db = Parameters<typeof briefingOwners>[0] & Parameters<typeof runBriefing>[0]["client"];
export type ClientFor = (laneId: string) => Promise<Db>;

const VIEWS = ["briefing", "comms", "calendar"] as const;

export async function dueOwners(clientFor: ClientFor, laneId: string, now: Date): Promise<string[]> {
  const c = await clientFor(laneId);
  const cfg = await c.schema("core").from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle();
  if (cfg.error) return [];
  const { briefing } = briefingConfigFrom(cfg.data?.config);
  if (!briefing.schedule_enabled || !isBriefingDue(briefing.time, briefing.days, now)) return [];
  const owners = await briefingOwners(c, laneId as LaneId);
  const allowed = await Promise.all(
    owners.map(async (uid) => {
      const views = await Promise.all(VIEWS.map((v) => c.schema("core").rpc("allowed_lanes", { p_uid: uid, p_view: v })));
      return views.every((r) => !r.error && Array.isArray(r.data) && (r.data as unknown[]).includes(laneId)) ? uid : null;
    }),
  );
  return allowed.filter((u): u is string => u !== null);
}

/** One scheduled run. Throws when the model failed, so the Inngest step retries (the failed attempt is still saved). */
export async function runScheduled(clientFor: ClientFor, laneId: string, ownerUserId: string, now: Date): Promise<string> {
  const p = getLLMProvider();
  if (!p.configured) throw new Error("model not configured");
  const c = await clientFor(laneId);
  const pol = await c.schema("core").from("lane_policies").select("llm_allowed_categories, store_outbound_drafts").eq("lane_id", laneId).maybeSingle();
  if (pol.error) throw new Error("lane policy unavailable");
  const res = await runBriefing(
    {
      client: c,
      provider: p.provider,
      readBody: async (l, conn, m) => (await readGmailBody(l, conn, m)).text,
      brain: { brainUser: null, laneBrain: {}, notes: ["no_brain_in_schedule"] },
      policy: policyFrom(pol.data),
      save: (l, r) => saveBriefing(c, l, r),
      proposeReply: replyProposer(ownerUserId),
    },
    { laneId: laneId as LaneId, ownerUserId, trigger: "schedule", now, viewerTz: BUSINESS_TZ },
  );
  if (res.status === "failed") throw new Error("briefing model step failed");
  return res.id;
}
