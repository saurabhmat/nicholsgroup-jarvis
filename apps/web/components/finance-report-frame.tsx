// The frame shared by the Finance report tabs (spec finance.md 15.1): the page header, the tab row (links, not client state), the
// connection note and the empty states that every tab shows in the same words. Server component: no client state.
import Link from "next/link";
import type { ReactNode } from "react";
import { EmptyState, PageHeader, PageSection, laneHref } from "@nichols/ui";
import { CONNECT_TEXT, connectionNoteFor, emptyTextFor } from "@/lib/home-finance";
import { FINANCE_TABS, type FinanceTabKey } from "@/lib/finance-reports";

export const UNAVAILABLE = "Could not load. Reload in a minute.";
export const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

export const Small = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <p {...(testId ? { "data-testid": testId } : {})} className="text-small text-muted-foreground">{children}</p>
);

/** The tab row. On a phone it scrolls sideways inside its own box and never moves the page. */
export function FinanceTabs({ laneId, active }: { laneId: string; active: FinanceTabKey }) {
  return (
    <nav aria-label="Finance reports" data-testid="finance-tabs" className="max-w-full overflow-x-auto overscroll-x-contain">
      <ul className="flex w-max min-w-full gap-1 border-b border-border">
        {FINANCE_TABS.map((t) => (
          <li key={t.key}>
            <Link
              href={laneHref(laneId, t.segment)}
              aria-current={active === t.key ? "page" : undefined}
              data-tab={t.key}
              className={`block whitespace-nowrap border-b-2 px-3 py-2 text-body ${active === t.key ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export type ReportState = { state: "unavailable" | "no_access" | "not_connected" | "no_data" | "mapping_missing" | "ok"; lastSyncAt?: string | null; connectionStatus?: string | null };

/**
 * Header, tabs, connection note, and the state of the page: no access (no tabs, no figures), an outage, not connected, no data or no
 * mapping (one sentence saying what is needed, never a number), or the figures (`children`).
 */
export function ReportFrame({ laneId, laneName, accent, active, title, status, children }: { laneId: string; laneName: string; accent: string; active: FinanceTabKey; title: string; status: ReportState; children: ReactNode }) {
  const header = <PageHeader eyebrow={laneName} title="Finance" accent={accent} />;
  if (status.state === "no_access") {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState title="No access to finance figures" description="Finance figures are shown to roles with the finance view for this company." />
      </div>
    );
  }
  const empty = emptyTextFor(status.state, status.lastSyncAt ?? null);
  const note = connectionNoteFor(status.connectionStatus ?? null);
  return (
    <div className="flex flex-col gap-6">
      {header}
      <FinanceTabs laneId={laneId} active={active} />
      {note ? <p data-testid="finance-connection-note" className="text-small text-muted-foreground">{note}</p> : null}
      {empty === null ? (
        children
      ) : (
        <PageSection title={title}>
          <EmptyState
            title={empty}
            className="border-0 bg-transparent px-0 py-6"
            {...(status.state === "not_connected"
              ? { action: <Link href={`${laneHref(laneId, "settings")}#connections`} className="text-small font-medium text-primary underline-offset-2 hover:underline">{CONNECT_TEXT}</Link> }
              : {})}
          />
        </PageSection>
      )}
    </div>
  );
}
