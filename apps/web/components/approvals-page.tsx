// Approvals (T-232, T-195): emails and QuickBooks disconnects waiting for approval, then recent history. Nothing is sent or saved in Gmail until
// the owner approves the exact content shown here (with a fresh authenticator code). Pending cards are editable; history
// shows recipients and subject only: the composed text is deleted when an action finishes (D-19).
import { Suspense } from "react";
import { approvalsDeps } from "@nichols/approvals/wire";
import { Alert, AlertDescription, AlertTitle, Badge, EmptyState, PageHeader, PageSection } from "@nichols/ui";
import { loadApprovals, type HistoryItem } from "@/lib/approvals";
import { guards } from "@/lib/guards";
import { loadLane } from "@/lib/lane-page";
import { timed } from "@/lib/timed";
import { ApprovalCard } from "./approval-card";
import { DisconnectApprovalCard } from "./disconnect-card";
import { CardSkeleton } from "./page-skeleton";

const STATUS: Record<HistoryItem["status"], { text: string; variant: "success" | "alert" | "muted" | "secondary" }> = {
  proposed: { text: "Waiting", variant: "secondary" },
  approved: { text: "Approved", variant: "secondary" },
  executing: { text: "In progress", variant: "secondary" },
  verified: { text: "Done", variant: "success" },
  failed: { text: "Failed", variant: "alert" },
  rejected: { text: "Rejected", variant: "muted" },
  expired: { text: "Expired", variant: "muted" },
  invalidated: { text: "Replaced by an edit", variant: "muted" },
};
const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

export async function ApprovalsPage({ params }: { params: Promise<{ laneId: string }> }) {
  const lane = await loadLane((await params).laneId);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow="Nothing is sent or changed until you approve it" title="Approvals" accent="waiting for you" />
      <Suspense fallback={<CardSkeleton />}>
        <ApprovalsBody laneId={lane.laneId} />
      </Suspense>
    </div>
  );
}

async function ApprovalsBody({ laneId }: { laneId: string }) {
  const view = await timed("load.approvals", async () => loadApprovals(await guards(), approvalsDeps, laneId));
  return (
    <>
      {view.unavailable ? (
        <Alert variant="alert">
          <AlertTitle>Approvals could not be loaded</AlertTitle>
          <AlertDescription>Reload the page in a minute. Nothing was sent.</AlertDescription>
        </Alert>
      ) : null}
      <PageSection title="Waiting for you" note={view.pending.length + view.disconnects.length > 0 ? `${view.pending.length + view.disconnects.length} waiting` : undefined}>
        {view.pending.length + view.disconnects.length === 0 ? (
          <EmptyState title="Nothing is waiting" description="Emails Jarvis drafts for you appear here. Nothing goes out until you approve it." className="border-0 bg-transparent px-0 py-6" />
        ) : (
          <div className="flex flex-col gap-4" data-testid="approvals-pending">
            {view.disconnects.map((card) => (
              <DisconnectApprovalCard key={card.id} laneId={laneId} card={card} canAct={view.canActDisconnect} />
            ))}
            {view.pending.map((card) => (
              <ApprovalCard key={card.id} laneId={laneId} card={card} canAct={view.isOwner} />
            ))}
          </div>
        )}
      </PageSection>
      <PageSection title="Recent" note="Recipients and subject only; the text is deleted when an action finishes">
        {view.history.length === 0 ? (
          <EmptyState title="No history yet" description="Approved, rejected and expired emails are listed here." className="border-0 bg-transparent px-0 py-6" />
        ) : (
          <ul data-testid="approvals-history" className="flex flex-col divide-y divide-border">
            {view.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-body">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{h.subject || "(no subject)"}</p>
                  <p className="truncate text-small text-muted-foreground">
                    {h.actionType === "qbo.disconnect" ? "QuickBooks connection" : `${h.actionType === "email.send" ? "To" : "Draft to"} ${h.to.join(", ") || "unknown"}`}
                    {h.failureCode ? ` · ${h.failureCode.replaceAll("_", " ")}` : ""}
                  </p>
                  {h.outcomeUnknown && h.actionType === "qbo.disconnect" ? (
                    <p data-testid="approvals-outcome-unknown" className="text-small text-alert-foreground">
                      The disconnect could not be confirmed. Check the QuickBooks connection in Settings before asking again.
                    </p>
                  ) : null}
                  {h.outcomeUnknown && h.actionType !== "qbo.disconnect" ? (
                    <p data-testid="approvals-outcome-unknown" className="text-small text-alert-foreground">
                      {h.failureCode === "reconcile_sent_unverified"
                        ? `It was ${h.actionType === "email.send" ? "sent" : "saved"} but could not be read back. Check the mailbox before asking for it again.`
                        : `Outcome unknown: it may have been ${h.actionType === "email.send" ? "sent" : "saved"}. Check the mailbox before asking for it again.`}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-small text-muted-foreground">{WHEN.format(new Date(h.at))}</span>
                  <Badge variant={STATUS[h.status].variant}>{STATUS[h.status].text}</Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PageSection>
    </>
  );
}
