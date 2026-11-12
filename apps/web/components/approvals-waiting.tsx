// Home (T-237 part C): "N approvals waiting" banner, hidden at 0, with a link to the Approvals page (T-232). Renders nothing when none are waiting or approvals
// are not available (it never blocks or breaks Home). Counts only: no recipient, subject or text appears on Home. No per-type breakdown ("1 email reply, 1 invoice note"): the count comes from
// core's pendingApprovalCount; a breakdown would need the full pending list with its capability reads, and there is only email.send / email.save_draft.
import Link from "next/link";
import { buttonVariants, laneHref } from "@nichols/ui";
import { waitingCount } from "@/lib/approvals";
import { guards } from "@/lib/guards";

export async function ApprovalsWaiting({ laneId }: { laneId: string }) {
  const count = await waitingCount(await guards(), laneId);
  if (count === 0) return null;
  return (
    <section aria-label="Approvals waiting" data-testid="approvals-waiting" className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-gold bg-card px-5 py-3 text-card-foreground shadow-card">
      <p data-testid="approvals-waiting-text" className="text-body font-medium text-foreground">
        {count === 1 ? "1 approval waiting" : `${String(count)} approvals waiting`}
      </p>
      <Link href={laneHref(laneId, "approvals")} className={buttonVariants({ variant: "outline" })}>
        Review
      </Link>
    </section>
  );
}
