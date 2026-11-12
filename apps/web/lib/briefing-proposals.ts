import "server-only";
// Briefing reply drafts -> email.send proposals (T-231d). The one place the briefing reaches the Approval Center, through
// the approvals module's bound `proposeBriefingReply` (it proposes only: never approves or sends; the briefing holds no
// approvals deps and no service client). proposerKind "job", the owner as the person it is for, derivedFromRetrieved
// true (recipient and thread came from email: the card shows the banner and the recipient flags).
import type { LaneId } from "@nichols/core";
import { proposeBriefingReply } from "@nichols/approvals/wire";
import type { ReplyProposal } from "./briefing-run";

export function replyProposer(ownerUserId: string): (laneId: LaneId, reply: ReplyProposal, signal?: AbortSignal) => Promise<string> {
  return (laneId, reply, signal) =>
    proposeBriefingReply(laneId, ownerUserId, {
      connectionId: reply.connectionId,
      compose: { to: reply.to, subject: reply.subject, bodyText: reply.bodyText, inReplyTo: reply.inReplyTo },
      rationale: reply.rationale.slice(0, 2000),
      sourceRefs: reply.sourceRefs,
      ...(signal ? { signal } : {}),
    });
}
