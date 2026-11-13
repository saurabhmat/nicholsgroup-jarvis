// What a mailbox may do through approvals (T-232): which buttons are enabled and why. Pure over the facts the policy,
// the lane config and the connection give; the database enforces the same gates at approve and at claim.
import type { LaneId } from "@nichols/core";
import { NOT_ENABLED_MESSAGE, NOT_LIVE_MESSAGE, QBO_NOT_ENABLED_MESSAGE } from "./errors";
import type { ActionType, ApprovalsDeps, CapabilityFacts, EmailActionType } from "./types";
import { isEmailType } from "./types";

const POLICY_KEY: Record<EmailActionType, string> = { "email.send": "email_send", "email.save_draft": "email_draft" };

export type Capability =
  | { enabled: true; reason: null; message: null; settingsHref: null }
  | { enabled: false; reason: "not_enabled" | "not_live"; message: string; settingsHref: string | null };

export type EmailWriteCapability = {
  /** The mailbox that would send (the connection's), or null when the connection is unusable. */
  mailbox: string | null;
  stepUpMaxAgeS: number;
  "email.send": Capability;
  "email.save_draft": Capability;
};

export function capabilityOf(laneId: LaneId, facts: CapabilityFacts, type: ActionType): Capability {
  if (!isEmailType(type)) {
    // qbo.disconnect (T-195): a QuickBooks connection of the lane that is not disconnected, the lane policy class `qbo_disconnect`,
    // and the same go-live gate as email (approvals_live). Same order: "not enabled" before "not live".
    if (!facts.qbo || !facts.writeActionsAllowed.includes("qbo_disconnect")) return { enabled: false, reason: "not_enabled", message: QBO_NOT_ENABLED_MESSAGE, settingsHref: null };
    if (!facts.approvalsLive) return { enabled: false, reason: "not_live", message: NOT_LIVE_MESSAGE, settingsHref: null };
    return { enabled: true, reason: null, message: null, settingsHref: null };
  }
  // Not enabled (no compose grant, or the lane policy lacks the type, or no usable connection) comes before "not live":
  // reconnecting is something the owner can do now, the go-live gate is not.
  if (facts.mailbox === null || !facts.composeGranted || !facts.writeActionsAllowed.includes(POLICY_KEY[type])) {
    return { enabled: false, reason: "not_enabled", message: NOT_ENABLED_MESSAGE, settingsHref: `/${laneId}/settings#connections` };
  }
  if (!facts.approvalsLive) return { enabled: false, reason: "not_live", message: NOT_LIVE_MESSAGE, settingsHref: null };
  return { enabled: true, reason: null, message: null, settingsHref: null };
}

/** Which approve buttons are enabled for a mailbox, and the exact message when one is not. */
export async function emailWriteCapability(deps: Pick<ApprovalsDeps, "readFacts">, laneId: LaneId, connectionId: string): Promise<EmailWriteCapability> {
  const facts = await deps.readFacts(laneId, connectionId);
  return {
    mailbox: facts.mailbox,
    stepUpMaxAgeS: facts.stepUpMaxAgeS,
    "email.send": capabilityOf(laneId, facts, "email.send"),
    "email.save_draft": capabilityOf(laneId, facts, "email.save_draft"),
  };
}

/** The connection statuses a QuickBooks disconnect may target. One list: `act.connection_ok` and the status trigger in SQL use the same three (T-195 review L4). */
export const QBO_DISCONNECTABLE_STATUSES: readonly string[] = ["active", "degraded", "reconnect_required"];
export const isQboDisconnectable = (status: string): boolean => QBO_DISCONNECTABLE_STATUSES.includes(status);
