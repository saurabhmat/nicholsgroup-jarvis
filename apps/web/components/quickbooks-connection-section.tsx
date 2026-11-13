// "QuickBooks" row of Settings -> Connections (T-233; T-197 completes it and folds in the connection test of T-198).
// Shown only to owner or admin_technical at AAL2 (see settings-page.tsx); other roles get no view at all, and the routes behind
// every button check the role and AAL2 themselves. "Connect QuickBooks" / "Reconnect QuickBooks" start the existing T-050 flow with a
// same-origin form POST. "Check connection" is a read-only health check. "Disconnect QuickBooks" only asks: it is an approval
// (D-24, T-195). The page shows status, times and the class-tracking flag; never a figure, a company name, a token or the full
// company id.
import { Badge, buttonVariants } from "@nichols/ui";
import type { QuickBooksConnectionState, QuickBooksConnectionView, QuickBooksJob, QuickBooksSectionView } from "@/lib/quickbooks-connection";
import { canDisconnect } from "@/lib/quickbooks-connection";
import { defaultExportRange } from "@/lib/quickbooks-export-range";
import { ConnectionCheckButton } from "./connection-check-button";
import { ConnectionRow, when } from "./connection-rows";
import { QuickBooksDisconnectButton } from "./quickbooks-disconnect-button";
import { SUPPORT_HREF } from "@/lib/support";
import { QuickBooksErrorBanner } from "./quickbooks-error-banner";
import { QuickBooksErrorExport } from "./quickbooks-error-export";

const LABEL: Record<QuickBooksConnectionState, { text: string; variant: "success" | "alert" | "muted" }> = {
  connected: { text: "Connected", variant: "success" },
  connecting: { text: "Connecting", variant: "muted" },
  degraded: { text: "Connected, with problems", variant: "alert" },
  reconnect_required: { text: "Reconnect needed", variant: "alert" },
};

const JOB_LABEL: Record<QuickBooksJob, string> = { sync: "Books", reports: "Reports", normalize: "Finance data" };

const needsReconnect = (view: QuickBooksSectionView) => view.connections.some((c) => c.state === "reconnect_required");
const degraded = (view: QuickBooksSectionView) => view.connections.some((c) => c.state === "degraded");

export function QuickBooksNotices({ view }: { view: QuickBooksSectionView }) {
  return (
    <>
      {needsReconnect(view) ? <QuickBooksErrorBanner kind="reconnect_required" /> : null}
      {degraded(view) ? <QuickBooksErrorBanner kind="degraded" /> : null}
      {view.unavailable ? <QuickBooksErrorBanner kind="unavailable" /> : null}
    </>
  );
}

function LastSync({ c }: { c: QuickBooksConnectionView }) {
  return (
    <>
      {c.jobs.map((j) => (
        <span key={j.job} className="block">
          {JOB_LABEL[j.job]}: {when(j.at ?? (j.job === "sync" ? c.lastSyncAt : null))}
        </span>
      ))}
    </>
  );
}

function ClassTracking({ on }: { on: boolean | null }) {
  return (
    <div data-testid="qbo-class-tracking" className="flex flex-col gap-1">
      <span>Class tracking: {on === null ? "not checked yet" : on ? "on" : "off"}</span>
      {on === false ? (
        <span data-testid="qbo-class-tracking-warning" className="text-alert-foreground">
          Class tracking is off in QuickBooks, so figures are shown unsplit: they are not broken down by class.
        </span>
      ) : null}
    </div>
  );
}

export function QuickBooksRows({ laneId, view }: { laneId: string; view: QuickBooksSectionView }) {
  const action = `/api/connect/qbo/start?lane=${encodeURIComponent(laneId)}`;
  const reconnect = needsReconnect(view);
  const connected = view.connections.length > 0;
  const sub = "Books, read-only";
  const button = view.unavailable ? null : (
    <form method="post" action={action}>
      <button type="submit" className={buttonVariants({ variant: connected && !reconnect ? "outline" : "default" })}>
        {connected ? "Reconnect QuickBooks" : "Connect QuickBooks"}
      </button>
    </form>
  );
  if (!connected) {
    return (
      <ConnectionRow
        testId="quickbooks-not-connected"
        provider="QuickBooks"
        sub={sub}
        account={<span className="text-muted-foreground">Not connected</span>}
        status={<Badge variant="muted">{view.wasDisconnected ? "Disconnected" : "Not connected"}</Badge>}
        lastSync="Not synced yet"
        actions={button}
        note={view.wasDisconnected ? "QuickBooks was disconnected. The saved connection is deleted and nothing is syncing. Connect again to resume." : null}
      />
    );
  }
  return (
    <>
      {view.connections.map((c, i) => (
        <ConnectionRow
          key={c.id}
          testId="quickbooks-connection"
          provider="QuickBooks"
          sub={sub}
          account={<span>{c.realmTail ? `Company ID ending ${c.realmTail}` : "Connected company"}</span>}
          status={<Badge variant={LABEL[c.state].variant}>{LABEL[c.state].text}</Badge>}
          lastSync={<LastSync c={c} />}
          actions={
            <div className="flex flex-col gap-3">
              {c.state === "reconnect_required" || (!reconnect && i === view.connections.length - 1) ? button : null}
              {c.state === "reconnect_required" || c.state === "connecting" ? null : <ConnectionCheckButton laneId={laneId} />}
              {canDisconnect(c.state) ? <QuickBooksDisconnectButton laneId={laneId} connectionId={c.id} disconnect={c.disconnect} /> : null}
            </div>
          }
          note={<ClassTracking on={c.classTracking} />}
        />
      ))}
    </>
  );
}

export function QuickBooksNotes({ laneId, now = new Date() }: { laneId: string; now?: Date }) {
  const range = defaultExportRange(now);
  return (
    <div className="flex flex-col gap-4 text-small text-muted-foreground">
      <p>
        QuickBooks is read-only: the portal cannot post, change or delete anything in QuickBooks. Check connection makes one read-only request and changes nothing.
        Disconnecting needs an approval. Problems with QuickBooks?{" "}
        <a href={SUPPORT_HREF} className="font-medium text-foreground underline underline-offset-4">
          Contact support
        </a>
        .
      </p>
      <QuickBooksErrorExport laneId={laneId} defaultFrom={range.from} defaultTo={range.to} />
    </div>
  );
}
