// What a mailbox may do through approvals (T-232): which buttons are enabled and why. Pure over the facts the policy,
// the lane config and the connection give; the database enforces the same gates at approve and at claim.
import type { LaneId } from "@nichols/core";
import { NOT_ENABLED_MESSAGE, NOT_ENABLED_MICROSOFT_MESSAGE, NOT_LIVE_MESSAGE, QBO_NOT_ENABLED_MESSAGE, TEAMS_NO_DRAFTS_MESSAGE, TEAMS_NOT_ENABLED_MESSAGE } from "./errors";
import type { ActionType, ApprovalsDeps, CapabilityFacts, EmailActionType } from "./types";
import { isEmailType, isTeamsType } from "./types";

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

/**
 * The Teams step-up window of a lane config value, mirroring `act.approve` EXACTLY (20261202100000):
 *   v_raw := lane_config -> approvals ->> 'teams_step_up_max_age_s'   -- jsonb text: a number's digits, a string as is, anything else
 *   v_max := case when v_raw ~ '^[0-9]{1,5}$' then least(greatest(v_raw::integer, 300), 43200) else 300 end
 * So: 1 to 5 digits only (no sign, no decimal point, no 6th digit: 100000 is NOT clamped, it falls back), clamped to 300..43,200; anything else is 300. A string of digits counts (as `->>` gives it as text).
 * One case JS cannot see: `3600.0` is stored by jsonb as "3600.0" (SQL: 300) but parses to 3600 here.
 */
export function teamsStepUpFromConfig(v: unknown): number {
  const raw = typeof v === "number" ? String(v) : typeof v === "string" ? v : null;
  return raw !== null && /^[0-9]{1,5}$/.test(raw) ? Math.min(Math.max(Number(raw), 300), 43200) : 300;
}

/**
 * The gates in front of a Teams CHAT send, in the order the route and the page report them (T-288; spec 10.3, 17 test 13), each by name so the person can be told which one is off:
 *   not_usable  the connection is not a usable Teams connection of the lane (or not the caller's: the caller has already been told "not found" before this runs)
 *   lane_off    the company's `teams.enabled` or its `teams.features` lacks `chat_send`
 *   reconnect   the connection lacks its own send grant (connected before sending was switched on): Reconnect
 *   policy_off  `teams_send` is not in the lane policy
 *   drafts_off  the lane does not store outbound drafts (a Teams send holds its text while open)
 *   not_live    `approvals_live` is not true
 * `null`: every gate is open. Pure over the facts; the database checks the same gates again at propose, approve and claim.
 */
export const TEAMS_SEND_GATES = ["not_usable", "lane_off", "reconnect", "policy_off", "drafts_off", "not_live"] as const;
export type TeamsSendGate = (typeof TEAMS_SEND_GATES)[number];
export function teamsChatSendGate(facts: CapabilityFacts): TeamsSendGate | null {
  const t = facts.teams;
  if (!t) return "not_usable";
  if (!(t.laneChatSend ?? t.chatSend)) return "lane_off";
  if (!(t.connChatSend ?? t.chatSend)) return "reconnect";
  if (!facts.writeActionsAllowed.includes("teams_send")) return "policy_off";
  if (facts.storeOutboundDrafts === false) return "drafts_off";
  if (!facts.approvalsLive) return "not_live";
  return null;
}

export function capabilityOf(laneId: LaneId, facts: CapabilityFacts, type: ActionType): Capability {
  if (isTeamsType(type)) {
    // T-286: a usable Teams connection of the lane, the connection's send permission and the lane's teams.features (chat_send for a chat, channels_send for a channel), the lane policy class
    // `teams_send`, then the same go-live gate as email (approvals_live). "Not enabled" before "not live": reconnecting is something the owner can do now.
    const t = facts.teams;
    const featureOn = t !== null && t !== undefined && (type === "teams.chat.send" ? t.chatSend : t.channelsSend);
    if (featureOn && facts.storeOutboundDrafts === false && facts.writeActionsAllowed.includes("teams_send")) return { enabled: false, reason: "not_enabled", message: TEAMS_NO_DRAFTS_MESSAGE, settingsHref: null };
    if (!featureOn || !facts.writeActionsAllowed.includes("teams_send")) return { enabled: false, reason: "not_enabled", message: TEAMS_NOT_ENABLED_MESSAGE, settingsHref: `/${laneId}/settings#connections` };
    if (!facts.approvalsLive) return { enabled: false, reason: "not_live", message: NOT_LIVE_MESSAGE, settingsHref: null };
    return { enabled: true, reason: null, message: null, settingsHref: null };
  }
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
    return { enabled: false, reason: "not_enabled", message: facts.provider === "microsoft" ? NOT_ENABLED_MICROSOFT_MESSAGE : NOT_ENABLED_MESSAGE, settingsHref: `/${laneId}/settings#connections` };
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
