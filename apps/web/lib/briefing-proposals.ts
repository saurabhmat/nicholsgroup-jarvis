import "server-only";
// Briefing reply drafts -> email.send proposals (T-231d). The one place the briefing reaches the Approval Center: it
// only proposes (never approves or executes). The approvals module holds its own job client (rule 5 boundary); the
// briefing code never sees it. proposerKind "job", the owner the briefing is for as proposer (they see it as their own),
// derivedFromRetrieved true (recipient and thread came from email: the card shows the banner).
import type { LaneId } from "@nichols/core";
import { proposeEmailAction } from "@nichols/approvals/server";
import { approvalsDeps } from "@nichols/approvals/wire";
import type { ReplyProposal } from "./briefing-run";

export function replyProposer(ownerUserId: string): (laneId: LaneId, reply: ReplyProposal) => Promise<string> {
  return async (laneId, reply) => {
    const { id } = await proposeEmailAction(approvalsDeps, laneId, {
      actionType: "email.send",
      connectionId: reply.connectionId,
      compose: { to: reply.to, subject: reply.subject, bodyText: reply.bodyText, inReplyTo: reply.inReplyTo },
      rationale: reply.rationale.slice(0, 2000),
      sourceRefs: reply.sourceRefs,
      proposerKind: "job",
      proposerUserId: ownerUserId,
      derivedFromRetrieved: true,
    });
    return id;
  };
}
