// Whether the Send box is offered for an open conversation, and if not, which gate is off (T-288, spec 10.5, 22.8; spec 17 test 13: "the composer says which gate is off"). DATABASE ONLY: the facts of the ONE connection
// the conversation was opened through (its provider, features, owner, status; the lane's `teams` settings, `teams_send` in the lane policy, outbound drafts, `approvals_live`), read through the approvals module's
// own facts, and the person's write role. No Graph call, no token read, no clock. This only decides what is DRAWN: the route and the database check every one of these again when Send is pressed.
import { teamsChatSendGate, type CapabilityFacts } from "@nichols/approvals/server";
import type { SendOffReason } from "./teams-wording";

export type SendView = { kind: "ready"; account: string } | { kind: "off"; reason: SendOffReason };

export type SendViewDeps = {
  readFacts: (laneId: string, connectionId: string) => Promise<CapabilityFacts>;
  /** Whether the signed-in person holds a role that may send (owner, admin_technical: the approvals write roles). */
  canWrite: () => Promise<boolean>;
};

export async function loadSendView(deps: SendViewDeps, laneId: string, connectionId: string, account: string, userId: string): Promise<SendView> {
  try {
    if (!(await deps.canWrite())) return { kind: "off", reason: "role" };
    const facts = await deps.readFacts(laneId, connectionId);
    // another person's connection or one that is not usable: the page only asks about the person's own usable account, so this is "reconnect", never a hint about anyone else
    if (!facts.teams || facts.teams.ownerUserId !== userId) return { kind: "off", reason: "reconnect" };
    const gate = teamsChatSendGate(facts);
    if (gate === null) return { kind: "ready", account };
    return { kind: "off", reason: gate === "not_usable" ? "reconnect" : gate };
  } catch {
    return { kind: "off", reason: "unavailable" };
  }
}
