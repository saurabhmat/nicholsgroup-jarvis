// One message (T-202). Visibility is proved under RLS first (lib/inbox.ts); then the text is read live from Gmail and
// rendered as plain text: never stored (rule 6), never interpreted (rule 9: untrusted data, no HTML, no links followed).
// The page is per request (loadLane calls connection()) and nothing here is cached.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { LaneId } from "@nichols/core";
import { readGmailBody } from "@nichols/connectors/google";
import { Alert, AlertDescription, AlertTitle, laneHref, PageHeader } from "@nichols/ui";
import { guards } from "@/lib/guards";
import { messageFor, type ReadBody } from "@/lib/inbox";
import { loadLane } from "@/lib/lane-page";

const WHEN = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/New_York",
});

const readBody: ReadBody = (laneId, connectionId, messageId) => readGmailBody(laneId as LaneId, connectionId, messageId);

export async function MessagePage({ params }: { params: Promise<{ laneId: string; messageId: string }> }) {
  const { laneId, messageId } = await params;
  const lane = await loadLane(laneId);
  // A malformed escape is an unknown message, not a server error; the id pattern in lib/inbox.ts rejects anything odd.
  let id: string;
  try {
    id = decodeURIComponent(messageId);
  } catch {
    notFound();
  }
  const view = await messageFor(await guards(), lane.laneId, id, readBody);
  if (view.state === "not_found") notFound();
  const m = view.meta;
  return (
    <div className="flex flex-col gap-6">
      <Link href={laneHref(lane.laneId, "inbox")} className="text-sm font-medium text-primary hover:underline">
        ← Inbox
      </Link>
      <PageHeader eyebrow={lane.name} title={m.subject ?? "(no subject)"} />
      <article className="flex flex-col gap-4 rounded-card border border-border bg-card p-5 sm:p-6">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">From</dt>
          <dd className="min-w-0 break-words">{m.fromName ? `${m.fromName} <${m.fromAddress ?? ""}>` : (m.fromAddress ?? "(unknown sender)")}</dd>
          {m.to.length > 0 ? (
            <>
              <dt className="text-muted-foreground">To</dt>
              <dd className="min-w-0 break-words">{m.to.join(", ")}</dd>
            </>
          ) : null}
          {m.cc.length > 0 ? (
            <>
              <dt className="text-muted-foreground">Cc</dt>
              <dd className="min-w-0 break-words">{m.cc.join(", ")}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Received</dt>
          <dd>{WHEN.format(new Date(m.receivedAt))} ET</dd>
        </dl>
        {m.sourceUrl ? (
          <a href={m.sourceUrl} target="_blank" rel="noopener noreferrer" className="self-start text-sm font-medium text-primary hover:underline">
            Open in Gmail
          </a>
        ) : null}
        <hr className="border-border" />
        {view.state === "ok" ? (
          <>
            <pre data-testid="message-body" className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground">
              {view.text}
            </pre>
            {view.truncated ? <p className="text-xs text-muted-foreground">This message is long; open it in Gmail to read the rest.</p> : null}
          </>
        ) : (
          <Alert variant="alert">
            <AlertTitle>{view.reason === "gone" ? "This message is no longer in Gmail" : "The message text could not be loaded"}</AlertTitle>
            <AlertDescription>
              {view.reason === "reconnect"
                ? "Google needs to be reconnected in Settings → Connections."
                : view.reason === "gone"
                  ? "It may have been deleted or moved."
                  : "Try again in a minute, or open it in Gmail."}
            </AlertDescription>
          </Alert>
        )}
      </article>
    </div>
  );
}
