// The "Reply" action on a Needs-your-attention item (T-234 part 2). This is the single hook for part 3: the Reply drawer replaces
// this component (same props), so the attention list never changes. Until then: with a T-231d draft it goes to that
// proposal in Approvals (edit, approve there); without one it opens the thread in Jarvis. Nothing is sent from here.
import Link from "next/link";
import { buttonVariants, laneHref } from "@nichols/ui";
import { inboxHref } from "@/lib/inbox-links";

export type ReplyTarget = {
  laneId: string;
  connectionId: string;
  messageId: string;
  threadKey: string;
  /** The T-231d draft's email.send proposal, when the briefing prepared one. */
  proposalId: string | null;
};

export function ReplyAction({ target }: { target: ReplyTarget }) {
  const href = target.proposalId ? `${laneHref(target.laneId, "approvals")}#action-${target.proposalId}` : inboxHref(target.laneId, target.messageId);
  return (
    <Link href={href} data-testid="attention-reply" data-has-draft={target.proposalId ? "true" : "false"} className={buttonVariants({ variant: "outline", size: "sm" })}>
      Reply
    </Link>
  );
}
