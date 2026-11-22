// T-262/T-263 review (security L4): whether the briefing job may PROPOSE a reply for a mail row is decided by the row's own CONNECTION: its provider and that connection's
// write grant, never by whether a source label happened to be shown. Google: unchanged (always allowed here; the facade and the database gates are the rest). Microsoft: only
// where the connection holds `graph_mail_write`, is usable, and the lane policy allows an email write. Any other provider, an unreadable connection or unreadable facts: no
// proposal (fail closed). Pure over injected parts.
import type { LaneId } from "@nichols/core";
import type { CapabilityFacts, EmailConn } from "./types";

export type BriefingGateDeps = {
  loadWriteConnection(laneId: LaneId, connectionId: string): Promise<EmailConn>;
  readFacts(laneId: LaneId, connectionId: string): Promise<CapabilityFacts>;
};

export function createBriefingReplyGate(deps: BriefingGateDeps): (laneId: LaneId, connectionId: string) => Promise<boolean> {
  return async (laneId, connectionId) => {
    try {
      const conn = await deps.loadWriteConnection(laneId, connectionId);
      if (conn.provider === "google") return true;
      if (conn.provider !== "microsoft") return false;
      const f = await deps.readFacts(laneId, connectionId);
      return f.mailbox !== null && f.provider === "microsoft" && f.composeGranted && f.writeActionsAllowed.some((a) => a === "email_send" || a === "email_draft");
    } catch {
      return false;
    }
  };
}
