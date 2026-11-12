// Home briefing sections (T-231a): Today's calendar, the 7-day look-ahead (collapsed under it, T-234) and the attention list, from synced metadata only.
// Coverage moved to Settings -> Connections (coverage-list.tsx) and the Money card was removed from Home (T-234 part 1).
// Times are in the viewer's zone; an event's own zone is added when its clock differs. Declined and cancelled events
// never show; clashes, back-to-backs and unanswered invitations are flagged.
import Link from "next/link";
import { Badge, buttonVariants, EmptyState, laneHref, PageSection } from "@nichols/ui";
import { CollapsibleSection } from "./collapsible-section";
import { ReplyAction } from "./reply-action";
import { inboxHref } from "@/lib/inbox-links";
import {
  ageLabel,
  attendeeSummary,
  formatDayIn,
  formatTimeIn,
  maskFigures,
  timeWithZone,
  type AttentionNote,
  type AttentionThread,
  type DayEvent,
  type NotableEvent,
  type ThreadRow,
} from "@nichols/briefing/domain";
import type { BriefingView, CalendarSection, MailSection } from "@/lib/briefing";

function Flags({ e }: { e: DayEvent }) {
  const flags: { text: string; variant: "alert" | "outline" | "gold" }[] = [];
  if (e.clashesWith.length > 0) flags.push({ text: `Clashes with ${e.clashesWith.join(", ")}`, variant: "alert" });
  if (e.backToBack) flags.push({ text: "Back-to-back", variant: "outline" });
  if (e.rsvpPending) flags.push({ text: "RSVP pending", variant: "gold" });
  if (e.external.length > 0) flags.push({ text: "External", variant: "outline" });
  if (flags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-2">
      {flags.map((f) => (
        <Badge key={f.text} variant={f.variant}>
          {f.text}
        </Badge>
      ))}
    </span>
  );
}

export function TodayCalendar({ calendar, tz, now }: { calendar: CalendarSection; tz: string; now: Date }) {
  if (!calendar.access) {
    return calendar.unavailable ? (
      <EmptyState title="Calendar could not be read" description="Reload in a minute. Settings → Connections shows the last sync." className="border-0 bg-transparent px-0 py-6" />
    ) : (
      <EmptyState title="No calendar to show" description="Your role in this company does not include the calendar." className="border-0 bg-transparent px-0 py-6" />
    );
  }
  if (calendar.today.length === 0) return <p className="text-body text-muted-foreground">Nothing scheduled today.</p>;
  const owners = new Set(calendar.owners);
  return (
    <ul data-testid="today-calendar" className="flex flex-col divide-y divide-border">
      {calendar.today.map((e) => {
        const past = !e.allDay && Date.parse(e.endAt) <= now.getTime();
        const who = attendeeSummary(e, owners);
        return (
          <li key={e.key} data-testid="calendar-event" className={`flex flex-col gap-1 py-3 text-body ${past ? "opacity-60" : ""}`}>
            <span className="tabular-nums text-muted-foreground">
              {e.allDay ? "All day" : `${timeWithZone(e.startAt, tz, e.timezone)} – ${formatTimeIn(e.endAt, tz)}`}
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate font-medium text-foreground">{e.title}</span>
              {e.location ? <span className="truncate text-muted-foreground">{e.location}</span> : null}
              {who ? <span className="truncate text-small text-muted-foreground">With {who}</span> : null}
              <Flags e={e} />
              {e.meetingUrl || e.calendarUrl ? (
                <span className="flex gap-3">
                  {e.meetingUrl && !past ? (
                    <a href={e.meetingUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
                      Join
                    </a>
                  ) : null}
                  {e.calendarUrl ? (
                    <a href={e.calendarUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
                      Open in Calendar
                    </a>
                  ) : null}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function LookAhead({ events, tz }: { events: NotableEvent[]; tz: string }) {
  if (events.length === 0) return <p className="text-body text-muted-foreground">Nothing notable in the next 7 days (no holidays, external meetings or open invitations).</p>;
  return (
    <ul data-testid="look-ahead" className="flex flex-col divide-y divide-border">
      {events.map((e) => (
        <li key={e.key} className="flex flex-col gap-1 py-3 text-body">
          <span className="tabular-nums text-muted-foreground">
            {formatDayIn(e.allDay && e.startDate ? `${e.startDate}T12:00:00Z` : e.startAt, tz)}
            {e.allDay ? null : (
              <>
                <br />
                {timeWithZone(e.startAt, tz, e.timezone)}
              </>
            )}
          </span>
          <span className="flex min-w-0 flex-col gap-1">
            {e.calendarUrl ? (
              <a href={e.calendarUrl} target="_blank" rel="noopener noreferrer" className="truncate font-medium text-foreground underline-offset-2 hover:underline">
                {e.title}
              </a>
            ) : (
              <span className="truncate font-medium text-foreground">{e.title}</span>
            )}
            <span className="text-small text-muted-foreground">{e.why.join(" · ")}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Right column of row 1: Today's calendar, with "Next 7 days" collapsed below it (expands on click). */
export function CalendarSections({ view, now }: { view: BriefingView; now: Date }) {
  return (
    <>
      <PageSection title="Today's calendar" note={`Times in ${view.viewerTz.replace(/_/g, " ")}`}>
        <TodayCalendar calendar={view.calendar} tz={view.viewerTz} now={now} />
      </PageSection>
      <CollapsibleSection title="Next 7 days" testId="next-7-days" persistId="next-7-days">
        {view.calendar.access ? <LookAhead events={view.calendar.ahead} tz={view.viewerTz} /> : <p className="text-body text-muted-foreground">No calendar to look ahead in. See Settings → Connections.</p>}
      </CollapsibleSection>
    </>
  );
}

const KIND_LABEL: Record<AttentionThread["kind"], string> = {
  priority: "Priority",
  security: "Security",
  waiting: "Waiting on you",
  unread: "Unread",
  repeated_failures: "Repeated failures",
};

/** Sender text is untrusted metadata: rendered as plain text. */
const senderOf = (t: ThreadRow) => (t.fromName && t.fromAddress ? `${t.fromName} <${t.fromAddress}>` : (t.fromAddress ?? t.fromName ?? "Unknown sender"));

/**
 * "Needs your attention" items (T-234 part 2): the top 5 by rules. Each shows the title (figures masked, rule 7), the AI's
 * why-it-matters and next step when today's briefing has them, then sender, mailbox and age with a status chip, and two
 * actions: Reply (the owner's drawer, T-234 part 3; a link to the thread for other roles) and Open (the thread in Jarvis, never a Google page).
 */
export function AttentionSection({ laneId, mail, now, notes, replies, canReply = false }: { laneId: string; mail: MailSection; now: Date; notes?: Map<string, AttentionNote>; replies?: Map<string, string>; canReply?: boolean }) {
  if (!mail.access) {
    return mail.unavailable ? (
      <EmptyState title="Mail could not be read" description="Reload in a minute. Settings → Connections shows the last sync." className="border-0 bg-transparent px-0 py-6" />
    ) : (
      <EmptyState title="No mail to show" description="Your role in this company does not include mail." className="border-0 bg-transparent px-0 py-6" />
    );
  }
  if (mail.attention.length === 0) {
    return <p className="text-body text-muted-foreground">Nothing needs you in the mail that was read (newsletters, calendar invitations, auto-replies, codes and automated alerts are left out). Settings → Connections shows what was read.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <ol data-testid="attention-list" className="flex flex-col divide-y divide-border">
        {mail.attention.map((a) => {
          const t = a.thread;
          const note = notes?.get(`${t.connectionId}:${t.messageId}`);
          const mailbox = mail.mailboxOf[t.connectionId];
          return (
            <li key={a.key} data-testid="attention-item" data-kind={a.kind} className="flex flex-col gap-1.5 py-3">
              <span className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                <span className="min-w-0 flex-1 break-words font-medium text-foreground">{a.kind === "repeated_failures" ? a.reason : t.subject ? maskFigures(t.subject) : "(No subject)"}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {a.kind === "repeated_failures" ? null : <ReplyAction canReply={canReply} target={{ laneId, connectionId: t.connectionId, messageId: t.messageId, threadKey: t.threadKey, proposalId: replies?.get(`${t.connectionId}:${t.messageId}`) ?? null }} />}
                  <Link href={inboxHref(laneId, t.messageId)} data-testid="attention-open" className={buttonVariants({ variant: "outline", size: "sm" })}>
                    Open
                  </Link>
                </span>
              </span>
              {note ? (
                <dl data-testid="attention-note" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-small">
                  <dt className="text-muted-foreground">Why</dt>
                  <dd className="text-foreground">{note.why}</dd>
                  <dt className="text-muted-foreground">Next</dt>
                  <dd className="text-foreground">{note.next}</dd>
                </dl>
              ) : null}
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted-foreground">
                <Badge variant={a.kind === "priority" || a.kind === "security" ? "alert" : "outline"}>{KIND_LABEL[a.kind]}</Badge>
                <span data-testid="attention-meta" className="min-w-0 break-words">
                  {[senderOf(t), mailbox ? `to ${mailbox}` : null, `${ageLabel(t.receivedAt, now)} ago`].filter(Boolean).join(" · ")}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      {mail.more > 0 ? (
        <p className="text-small text-muted-foreground">
          {mail.more} more in the{" "}
          <Link href={laneHref(laneId, "inbox")} className="text-primary underline-offset-2 hover:underline">
            Inbox
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
