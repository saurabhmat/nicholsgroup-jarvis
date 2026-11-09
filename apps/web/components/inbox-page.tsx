// Inbox (T-202): the lane's synced mail, metadata only, newest first, with All / Unread / Important and paging. A row
// opens the message, whose text is read live from Gmail (message-page.tsx). Nothing is changed in Gmail (read-only).
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle, Badge, cn, EmptyState, laneHref, PageHeader } from "@nichols/ui";
import { guards } from "@/lib/guards";
import { inboxFor, INBOX_FILTERS, type InboxFilter, type InboxRow } from "@/lib/inbox";
import { loadLane } from "@/lib/lane-page";
import { timed } from "@/lib/timed";

const FILTER_LABEL: Record<InboxFilter, string> = { all: "All", unread: "Unread", important: "Important" };
const TZ = "America/New_York";
const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: TZ });
const YMD = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });

/** Today's mail by time, older mail by date (business time zone). */
function when(iso: string, now: Date): string {
  const d = new Date(iso);
  return YMD.format(d) === YMD.format(now) ? TIME.format(d) : DATE.format(d);
}

export async function InboxPage({ params, searchParams }: { params: Promise<{ laneId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const lane = await loadLane((await params).laneId);
  const view = await timed("load.inbox", async () => inboxFor(await guards(), lane.laneId, await searchParams));
  const now = new Date();
  const base = laneHref(lane.laneId, "inbox");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={lane.name} title="Inbox" />
      <nav aria-label="Filter mail" className="flex flex-wrap gap-2">
        {INBOX_FILTERS.map((f) => (
          <Link
            key={f}
            href={f === "all" ? base : `${base}?filter=${f}`}
            aria-current={view.filter === f ? "page" : undefined}
            className={cn(
              "rounded-full border px-4 py-1.5 text-sm font-medium transition-colors",
              view.filter === f ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-muted",
            )}
          >
            {FILTER_LABEL[f]}
          </Link>
        ))}
      </nav>
      {view.unavailable ? (
        <Alert variant="alert">
          <AlertTitle>Mail could not be loaded</AlertTitle>
          <AlertDescription>Reload the page in a minute. If it keeps happening, check Settings → Connections.</AlertDescription>
        </Alert>
      ) : view.rows.length === 0 ? (
        <EmptyState
          title={view.filter === "all" ? "No mail to show" : `No ${FILTER_LABEL[view.filter].toLowerCase()} mail`}
          description="Mail appears here once a mailbox is connected and synced, and only for roles that include mail."
        />
      ) : (
        <section aria-label="Messages" className="overflow-hidden rounded-card border border-border bg-card">
          <ul data-testid="inbox-list" className="divide-y divide-border">
            {view.rows.map((r) => (
              <Row key={r.messageId} row={r} href={`${base}/${encodeURIComponent(r.messageId)}`} when={when(r.receivedAt, now)} />
            ))}
          </ul>
        </section>
      )}
      {view.next ? (
        <div className="flex justify-center">
          <Link
            className="rounded-control border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
            href={`${base}?${new URLSearchParams({ ...(view.filter === "all" ? {} : { filter: view.filter }), before: view.next.before, bid: view.next.id }).toString()}`}
          >
            Older messages
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function Row({ row, href, when: time }: { row: InboxRow; href: string; when: string }) {
  const sender = row.fromName ?? row.fromAddress ?? "(unknown sender)";
  return (
    <li>
      {/* No prefetch: opening a message reads it live from Gmail; a list view must not read 50 bodies nobody opened. */}
      <Link href={href} prefetch={false} className={cn("flex items-start gap-3 px-4 py-3 hover:bg-muted sm:px-5", !row.isRead && "bg-primary-tint/40")}>
        <span aria-hidden className={cn("mt-2 size-2 shrink-0 rounded-full", row.isRead ? "bg-transparent" : "bg-primary")} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline justify-between gap-3">
            <span className={cn("truncate text-sm", row.isRead ? "text-foreground" : "font-semibold text-foreground")}>
              {sender}
              {row.isRead ? null : <span className="sr-only"> (unread)</span>}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{time}</span>
          </span>
          <span className="flex items-center gap-2">
            <span className={cn("truncate text-sm", row.isRead ? "text-muted-foreground" : "text-foreground")}>{row.subject ?? "(no subject)"}</span>
            {row.isImportant ? (
              <Badge variant="gold" className="shrink-0">
                Important
              </Badge>
            ) : null}
            {row.hasAttachments ? (
              <Badge variant="muted" className="shrink-0">
                Attachment
              </Badge>
            ) : null}
          </span>
        </span>
      </Link>
    </li>
  );
}
