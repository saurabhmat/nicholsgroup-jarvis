// Messages: what a chat list and a conversation LOOK like (T-283, T-284). Presentational: it draws the views that lib/teams-chats.ts built and nothing else, with no directive and no server
// import, so server components and the small client components (older messages) share it. Every string from Teams (names, topics, text, file names) is drawn as React text, never as HTML
// (rule 9: there is no `dangerouslySetInnerHTML` anywhere in this file; a source test pins that). Links come from the reader already checked (https only) and open in a new tab with
// `rel="noopener noreferrer nofollow"`; they are never opened or fetched by the portal. A picture is a neutral placeholder: nothing is loaded from Microsoft or anyone else.
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants, cn } from "@nichols/ui";
import type { MessageNode } from "@nichols/connectors/teams-pure";
import { dayLabel } from "@/lib/teams-format";
import type { AttachmentView, ChatRowView, MessageView } from "@/lib/teams-chats";
import { MESSAGES_FILE_OPENS_IN_MICROSOFT, MESSAGES_IMAGE_TEXT, MESSAGES_TRUNCATED_TEXT } from "@/lib/teams-wording";

// ---- message bodies: typed nodes -> elements
const LINK_CLASS = "font-medium text-primary underline underline-offset-2 [overflow-wrap:anywhere]";

/** The text a link shows (C7e: the host is not repeated when the text already holds it). */
function linkText(nodes: readonly MessageNode[]): string {
  return nodes.map((n) => (n.t === "text" || n.t === "mention" || n.t === "emoji" ? n.v : "c" in n ? linkText(n.c) : "")).join("").toLowerCase();
}

export function renderNodes(nodes: readonly MessageNode[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return n.v;
      case "br":
        return <br key={i} />;
      case "mention":
        return (
          <span key={i} className="font-medium text-primary" data-mention>
            {n.v}
          </span>
        );
      case "emoji":
        return <span key={i}>{n.v}</span>;
      case "image":
        return (
          <span key={i} data-testid="image-placeholder" className="inline-block rounded-control border border-dashed border-border px-2 py-0.5 text-small text-muted-foreground">
            {MESSAGES_IMAGE_TEXT}
          </span>
        );
      case "link":
        // The converter only emits https links; this is a second look, so a node that somehow carried anything else is drawn as its text and nothing is clickable.
        if (!/^https:\/\//i.test(n.href)) return <span key={i}>{n.c.length > 0 ? renderNodes(n.c) : n.host}</span>;
        return (
          <span key={i}>
            <a href={n.href} target="_blank" rel="noopener noreferrer nofollow" className={LINK_CLASS}>
              {n.c.length > 0 ? renderNodes(n.c) : n.host}
            </a>
            {linkText(n.c).includes(n.host) ? null : <span className="text-small text-muted-foreground"> ({n.host})</span>}
          </span>
        );
      case "b":
        return <strong key={i}>{renderNodes(n.c)}</strong>;
      case "i":
        return <em key={i}>{renderNodes(n.c)}</em>;
      case "u":
        return <u key={i}>{renderNodes(n.c)}</u>;
      case "s":
        return <s key={i}>{renderNodes(n.c)}</s>;
      case "code":
        return (
          <code key={i} className="rounded bg-muted px-1 font-mono text-small">
            {renderNodes(n.c)}
          </code>
        );
      case "p":
        return (
          <p key={i} className="my-1 first:mt-0 last:mb-0">
            {renderNodes(n.c)}
          </p>
        );
      case "quote":
        return (
          <blockquote key={i} className="my-1 border-l-2 border-border pl-3 text-muted-foreground">
            {renderNodes(n.c)}
          </blockquote>
        );
      case "codeblock":
        return (
          <pre key={i} className="my-1 overflow-x-auto whitespace-pre-wrap rounded-control bg-muted p-2 font-mono text-small [overflow-wrap:anywhere]">
            {renderNodes(n.c)}
          </pre>
        );
      case "ul":
        return (
          <ul key={i} className="my-1 list-disc pl-5">
            {renderNodes(n.c)}
          </ul>
        );
      case "ol":
        return (
          <ol key={i} className="my-1 list-decimal pl-5">
            {renderNodes(n.c)}
          </ol>
        );
      case "li":
        return <li key={i}>{renderNodes(n.c)}</li>;
    }
  });
}

function Attachment({ a }: { a: AttachmentView }) {
  const name = a.name !== "" ? a.name : a.kind === "file" ? "File" : "Attachment";
  if (a.kind === "file") {
    return (
      <li data-testid="attachment" className="flex flex-wrap items-baseline gap-x-2 rounded-control border border-border px-2 py-1 text-small">
        <span className="font-medium [overflow-wrap:anywhere]">{name}</span>
        {a.href ? (
          <a href={a.href} target="_blank" rel="noopener noreferrer nofollow" className={LINK_CLASS}>
            Open <span className="font-normal text-muted-foreground">({a.host ?? MESSAGES_FILE_OPENS_IN_MICROSOFT})</span>
          </a>
        ) : (
          <span className="text-muted-foreground">Open it in Teams</span>
        )}
      </li>
    );
  }
  return (
    <li data-testid="attachment" className="rounded-control border border-border px-2 py-1 text-small text-muted-foreground">
      {a.kind === "reply" ? "Replied to an earlier message" : a.kind === "card" ? `Card${a.name !== "" ? `: ${a.name}` : ""}: open in Teams` : `${name}: open in Teams`}
    </li>
  );
}

export function MessageItem({ m, showSender }: { m: MessageView; showSender: boolean }) {
  return (
    <li data-testid="message" data-mine={m.mine ? "true" : "false"} className={cn("flex flex-col gap-0.5", m.mine ? "items-end" : "items-start")}>
      <div className={cn("max-w-[92%] min-w-0 rounded-card border px-3 py-2 sm:max-w-[80%]", m.mine ? "border-primary/30 bg-primary/10" : "border-border bg-card")}>
        {showSender && !m.mine && m.sender ? (
          <p dir="auto" className="mb-0.5 text-small font-medium [overflow-wrap:anywhere]">
            {m.sender}
          </p>
        ) : null}
        {m.deleted ? (
          <p className="text-body italic text-muted-foreground">This message was deleted</p>
        ) : m.system ? (
          <p className="text-body italic text-muted-foreground">Teams event</p>
        ) : (
          <div dir="auto" data-testid="message-body" className="min-w-0 text-body [overflow-wrap:anywhere]">
            {m.nodes.length > 0 ? renderNodes(m.nodes) : m.attachments.length === 0 ? <span className="text-muted-foreground">(no text)</span> : null}
          </div>
        )}
        {m.truncated ? <p className="mt-1 text-small text-muted-foreground">{MESSAGES_TRUNCATED_TEXT}</p> : null}
        {m.attachments.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1">
            {m.attachments.map((a, i) => (
              <Attachment key={i} a={a} />
            ))}
          </ul>
        ) : null}
      </div>
      <p className="px-1 text-small text-muted-foreground">
        <time dateTime={m.at} title={m.fullTime}>
          {m.time}
        </time>
        {m.edited ? " · Edited" : ""}
      </p>
    </li>
  );
}

/** Messages oldest first, with a separator whenever the New York day changes. Sender names are drawn in group chats. */
export function MessageList({ messages, group, after }: { messages: readonly MessageView[]; group: boolean; after?: string | null }) {
  const items: ReactNode[] = [];
  let day = after ?? null;
  for (const m of messages) {
    if (m.day !== day) {
      items.push(
        <li key={`d-${m.day}-${m.id}`} className="flex justify-center py-1">
          <div role="separator" aria-label={dayLabel(m.at)} className="rounded-full bg-muted px-3 py-0.5 text-small text-muted-foreground">
            {dayLabel(m.at)}
          </div>
        </li>,
      );
      day = m.day;
    }
    items.push(<MessageItem key={m.id} m={m} showSender={group} />);
  }
  return <>{items}</>;
}

// ---- the chat list
export function ChatListRows({ rows, selectedKey, hrefFor }: { rows: readonly ChatRowView[]; selectedKey: string | null; hrefFor: (chatKey: string) => string }) {
  return (
    <ul className="divide-y divide-border rounded-card border border-border bg-card" data-testid="chat-list">
      {rows.map((r) => (
        <li key={r.key}>
          <Link
            href={hrefFor(r.key)}
            scroll={false}
            aria-current={r.key === selectedKey ? "page" : undefined}
            data-testid="chat-row"
            data-unread={r.unread ? "true" : "false"}
            className={cn("flex min-h-14 items-start gap-3 px-4 py-3 hover:bg-muted focus-visible:bg-muted", r.key === selectedKey && "bg-muted")}
          >
            <span aria-hidden className="mt-1.5 flex h-3 w-3 shrink-0 items-center justify-center">
              {r.unread ? <span data-testid="unread-dot" className="h-2.5 w-2.5 rounded-full bg-primary" /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span dir="auto" className={cn("truncate text-body", r.unread ? "font-semibold" : "font-medium")}>
                  {r.title}
                </span>
                <span className="shrink-0 text-small text-muted-foreground">{r.time}</span>
              </span>
              <span className="flex items-center gap-2">
                <span dir="auto" className={cn("truncate text-small", r.unread ? "text-foreground" : "text-muted-foreground")}>
                  {r.preview}
                </span>
                {r.external ? <span className="shrink-0 rounded-full border border-border px-2 text-small text-muted-foreground">External</span> : null}
              </span>
              {r.unread ? <span className="sr-only">Unread</span> : null}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** "Sign in to Teams" / "Reconnect Teams": a plain form that posts to the Teams connect route of this lane (the same one Settings uses). */
export function SignIn({ laneId, connectionId, label }: { laneId: string; connectionId?: string; label: string }) {
  const action = `/api/connect/teams/start?lane=${encodeURIComponent(laneId)}${connectionId ? `&connection=${encodeURIComponent(connectionId)}` : ""}`;
  return (
    <form method="post" action={action}>
      <button type="submit" className={buttonVariants({ variant: "default" })}>
        {label}
      </button>
    </form>
  );
}
