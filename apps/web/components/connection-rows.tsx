// Shared pieces of the Settings -> Connections list (T-230 B): one row per account with provider, account, status chip,
// last sync and actions. On desktop the row is a five-column grid under a header line; on iPhone each row is a small card
// whose cells carry their own labels. Presentational only: what is shown is decided by the loaders.
import type { ReactNode } from "react";
import { cn } from "@nichols/ui";

export const TIME = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });
export const when = (iso: string | null) => (iso ? `${TIME.format(new Date(iso))} ET` : "not synced yet");

const COLUMNS = "md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,1.7fr)]";

export function ConnectionsHeader() {
  return (
    <li aria-hidden className={cn("hidden gap-x-4 border-b border-border pb-2 text-secondary font-medium text-muted-foreground md:grid", COLUMNS)}>
      <span>Provider</span>
      <span>Account</span>
      <span>Status</span>
      <span>Last sync</span>
      <span>Actions</span>
    </li>
  );
}

function Cell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 text-body", className)}>
      <span className="text-secondary text-muted-foreground md:sr-only">{label}</span>
      <div className="min-w-0 [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

export function ConnectionRow({
  testId,
  provider,
  sub,
  account,
  status,
  lastSync,
  actions,
  note,
}: {
  testId: string;
  provider: ReactNode;
  sub?: ReactNode;
  account: ReactNode;
  status: ReactNode;
  lastSync: ReactNode;
  actions?: ReactNode;
  /** Full-width line under the row (a warning or an explanation). */
  note?: ReactNode;
}) {
  return (
    <li data-testid={testId} className="flex flex-col gap-2 py-3 first:pt-0">
      <div className={cn("grid gap-x-4 gap-y-2", COLUMNS)}>
        <Cell label="Provider">
          <span className="font-medium text-foreground">{provider}</span>
          {sub ? <span className="block text-secondary text-muted-foreground">{sub}</span> : null}
        </Cell>
        <Cell label="Account">{account}</Cell>
        <Cell label="Status">{status}</Cell>
        <Cell label="Last sync">{lastSync}</Cell>
        <Cell label="Actions" className="md:items-start">
          <div className="flex flex-wrap items-start gap-2">{actions}</div>
        </Cell>
      </div>
      {note ? <div className="text-secondary text-muted-foreground">{note}</div> : null}
    </li>
  );
}
