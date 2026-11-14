// Home briefing sections (T-231a): Today's calendar, the 7-day look-ahead (collapsed under it, T-234) and the attention list, from synced metadata only.
// Coverage moved to Settings -> Connections (coverage-list.tsx) and the Money card was removed from Home (T-234 part 1).
// Home shows every time in America/New_York (the page passes it); an event's own zone is added when its clock differs. Declined and cancelled events
// never show; clashes, back-to-backs and unanswered invitations are flagged.
import Link from "next/link";
import { Badge, buttonVariants, EmptyState, laneHref, PageSection } from "@nichols/ui";
import { fieldText, subjectLine } from "@/lib/home-text";
import { DisclosureFooter } from "./collapsible-section";
import { ReplyAction } from "./reply-action";
import { inboxHref } from "@/lib/inbox-links";
import {
  ageShort,
  aheadSummaryText,
  attendeeSummary,
  attentionChips,
  noteSaysNoAction,
  senderParts,
  eventChips,
  formatDayIn,
  formatTimeIn,
  maskFigures,
  otherZoneTime,
  type AttentionNote,
  type DayEvent,
  type NotableEvent,
} from "@nichols/briefing/domain";
import type { BriefingView, CalendarSection, MailSection } from "@/lib/briefing";

const CHIP_VARIANT = { clash: "alert", rsvp: "gold", back_to_back: "outline", external: "outline" } as const;

/** At most two chips, by priority (Clash, RSVP pending, Back-to-back, External); the detail is a tooltip and screen-reader text. */
function Chips({ e }: { e: DayEvent }) {
  const chips = eventChips(e);
  if (chips.length === 0) return null;
  return (
    <span data-testid="event-chips" className="flex flex-wrap gap-2">
      {chips.map((c) => (
        <Badge key={c.key} variant={CHIP_VARIANT[c.key]} title={c.detail}>
          {c.label}
          <span className="sr-only"> ({c.detail})</span>
        </Badge>
      ))}
    </span>
  );
}

/** The host of an already-validated https URL, so the Join button says where it goes. */
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "the meeting host";
  }
};

/** The title, a link to the event in the calendar (https only, new tab) when there is one; no separate "Open in Calendar". */
function EventTitle({ title, url }: { title: string; url: string | null }) {
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" className="line-clamp-2 font-medium text-foreground underline-offset-2 hover:underline">
      {title}
    </a>
  ) : (
    <span className="line-clamp-2 font-medium text-foreground">{title}</span>
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
  const known = new Map(Object.entries(calendar.knownNames ?? {}));
  return (
    <ul data-testid="today-calendar" className="flex flex-col divide-y divide-border">
      {calendar.today.map((e) => {
        const past = !e.allDay && Date.parse(e.endAt) <= now.getTime();
        const who = attendeeSummary(e, owners, 3, known);
        const own = e.allDay ? null : otherZoneTime(e.startAt, tz, e.timezone);
        return (
          <li key={e.key} data-testid="calendar-event" className={`flex gap-3 py-3 text-body ${past ? "opacity-60" : ""}`}>
            <span data-testid="event-time" className="flex w-24 shrink-0 flex-col tabular-nums">
              {e.allDay ? (
                <span className="font-medium text-foreground">All day</span>
              ) : (
                <>
                  <time dateTime={e.startAt} className="font-medium text-foreground">
                    {formatTimeIn(e.startAt, tz)}
                  </time>
                  {own ? <span data-testid="event-zone" className="text-small text-muted-foreground">{own}</span> : null}
                  <span className="text-small text-muted-foreground">
                    to{" "}
                    <time dateTime={e.endAt}>{formatTimeIn(e.endAt, tz)}</time>
                  </span>
                </>
              )}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex min-w-0 items-start justify-between gap-2">
                <EventTitle title={e.title} url={e.calendarUrl} />
                {e.meetingUrl && !past ? (
                  <a href={e.meetingUrl} target="_blank" rel="noopener noreferrer" aria-label={`Join ${e.title} on ${hostOf(e.meetingUrl)}`} title={`Join on ${hostOf(e.meetingUrl)}`} className={`${buttonVariants({ variant: "outline", size: "sm" })} shrink-0`}>
                    Join
                  </a>
                ) : null}
              </span>
              {e.location ? <span className="truncate text-small text-muted-foreground">{e.location}</span> : null}
              {who ? <span title={who} className="truncate text-small text-muted-foreground">With {who}</span> : null}
              <Chips e={e} />
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
      {events.map((e) => {
        const own = e.allDay ? null : otherZoneTime(e.startAt, tz, e.timezone);
        return (
          <li key={e.key} className="flex gap-3 py-3 text-body">
            <span className="flex w-24 shrink-0 flex-col tabular-nums">
              <time dateTime={e.allDay && e.startDate ? e.startDate : e.startAt} className="font-medium text-foreground">
                {formatDayIn(e.allDay && e.startDate ? `${e.startDate}T12:00:00Z` : e.startAt, tz)}
              </time>
              {e.allDay ? null : (
                <>
                  <time dateTime={e.startAt} className="text-small text-muted-foreground">
                    {formatTimeIn(e.startAt, tz)}
                  </time>
                  {own ? <span className="text-small text-muted-foreground">{own}</span> : null}
                </>
              )}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <EventTitle title={e.title} url={e.calendarUrl} />
              <span className="text-small text-muted-foreground">{e.why.join(" · ")}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** IANA names of US Eastern time: the Today note says "Eastern time" for all of them. */
const EASTERN_ZONES: ReadonlySet<string> = new Set(["America/New_York", "US/Eastern"]);

/** Right column of row 1: Today's calendar, with "Next 7 days" collapsed below it (one-line summary in its header; expands on click). */
export function CalendarSections({ view, now }: { view: BriefingView; now: Date }) {
  const c = view.calendar;
  const summary = c.access && c.aheadSummary ? aheadSummaryText(c.aheadSummary).replace(", ", " \u00b7 ") : undefined;
  return (
    <PageSection title="Today" ariaLabel="Today's calendar" note={EASTERN_ZONES.has(view.viewerTz) ? "Eastern time" : `Times in ${view.viewerTz.replace(/_/g, " ")}`}>
      <TodayCalendar calendar={view.calendar} tz={view.viewerTz} now={now} />
      <DisclosureFooter title="Next 7 days" testId="next-7-days" persistId="next-7-days" {...(summary ? { note: summary } : {})}>
        {c.access ? <LookAhead events={c.ahead} tz={view.viewerTz} /> : <p className="text-body text-muted-foreground">No calendar to look ahead in. See Settings → Connections.</p>}
      </DisclosureFooter>
    </PageSection>
  );
}

/** T-240: "Still waiting: N older threads", a link to the Inbox's waiting view; nothing at 0. */
export function StillWaiting({ laneId, count }: { laneId: string; count: number }) {
  if (count <= 0) return null;
  return (
    <Link href={`${laneHref(laneId, "inbox")}?view=waiting`} data-testid="attention-still-waiting" className="self-start py-1 text-small text-muted-foreground underline-offset-2 hover:text-foreground hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center">
      Still waiting: {count} older {count === 1 ? "thread" : "threads"} <span aria-hidden>{"\u2192"}</span>
    </Link>
  );
}

/** Avatar colours: text and ground are token pairs checked for 4.5:1 in light and dark (tokens.test.ts). */
const AVATAR = ["bg-primary-tint text-primary", "bg-alert-surface text-alert-foreground", "bg-success-surface text-success", "bg-muted text-foreground"] as const;
/** The phone shows the first three attention rows (the iPhone design); desktop shows up to five. */
const PHONE_ROWS = 3;
const CHIP_TONE = { alert: "alert", gold: "gold", outline: "outline" } as const;

/**
 * "Needs your attention" rows (T-234 part 2, T-235 part 2: scannable). Line 1: initials avatar (decorative), sender name (semibold),
 * company or domain (muted), age right-aligned (`<time>`, full date in the title). Line 2: subject, one line with an ellipsis
 * (figures masked, rule 7). Line 3: the AI's "why it matters -> next step", only when today's briefing has it. Then at most two
 * chips and, only when the lane has several mailboxes, "to <mailbox>". Actions on the right, vertically centred (stacked under
 * the text on a phone, 44 px targets): Reply (the owner's drawer, T-234 part 3; a link to the thread for other roles) and Open
 * (the thread in Jarvis, never a Google page).
 *
 * The whole row opens the thread with the "stretched link" pattern, not a button holding buttons: Open's ::after covers the row
 * and Reply sits above it (`relative z-[1]`). The keyboard path is Tab: Reply, then Open. The Reply drawer is portaled to
 * <body>, so it is outside the row. Hover background on desktop only.
 *
 * Footer: "View all in Inbox · N need attention ->" where N = the items the rules ranked (the rows shown plus `mail.more`), i.e.
 * the threads that currently need attention, not the Inbox size. It links to the plain Inbox: the Inbox filters are
 * All / Unread / Priority, none of which is "needs attention", so a filtered link would show a different list than N.
 *
 * Tooltips: the row is covered by the Open link's ::after, so a `title` on the subject or the age is never reached by the
 * pointer; they are dropped. The full subject is in Open's aria-label, the full sender address is sr-only text, and the age
 * reads "3h ago" to screen readers. Focus: the ::after carries the ring plus a transparent outline, which Windows High Contrast
 * (forced-colors) paints, so the focus stays visible there. The divider lines sit on the <li> (no horizontal bleed); only the
 * hover ground and the focus ring bleed 8 px each side, into the card padding.
 */
export function AttentionSection({ laneId, mail, now, notes, replies, canReply = false, tz = "America/New_York" }: { laneId: string; mail: MailSection; now: Date; notes?: Map<string, AttentionNote>; replies?: Map<string, string>; canReply?: boolean; tz?: string }) {
  if (!mail.access) {
    return mail.unavailable ? (
      <EmptyState title="Mail could not be read" description="Reload in a minute. Settings → Connections shows the last sync." className="border-0 bg-transparent px-0 py-6" />
    ) : (
      <EmptyState title="No mail to show" description="Your role in this company does not include mail." className="border-0 bg-transparent px-0 py-6" />
    );
  }
  const stillWaiting = <StillWaiting laneId={laneId} count={mail.stillWaiting.length} />;
  if (mail.attention.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-body text-muted-foreground">Nothing new needs you in the mail that was read (newsletters, calendar invitations, auto-replies, codes and automated alerts are left out). Settings → Connections shows what was read.</p>
        {stillWaiting}
      </div>
    );
  }
  // "to <mailbox>" only tells something when the lane reads more than one mailbox.
  const showMailbox = new Set(Object.values(mail.mailboxOf)).size > 1;
  const total = mail.attention.length + mail.more;
  return (
    <div className="flex flex-col gap-3">
      <ol role="list" data-testid="attention-list" className="flex flex-col divide-y divide-border">
        {mail.attention.map((a, index) => {
          const t = a.thread;
          const note = notes?.get(`${t.connectionId}:${t.messageId}`);
          const mailbox = mail.mailboxOf[t.connectionId];
          const who = senderParts(t.fromName, t.fromAddress, AVATAR.length);
          // T-243: the subject is always shown ("(no subject)" when there is none). Figures stay masked; a mask token reads as an ellipsis.
          const subject = a.kind === "repeated_failures" ? (fieldText(a.reason, tz) ?? subjectLine(null, maskFigures, tz)) : subjectLine(t.subject, maskFigures, tz);
          const why = fieldText(note?.why, tz);
          const next = fieldText(note?.next, tz);
          const chips = attentionChips({ kind: a.kind, unread: t.unreadCount > 0, vip: a.flags.vip, money: a.flags.money !== null, deadline: a.flags.deadline, waitingOnYou: a.flags.waitingOnYou && !noteSaysNoAction(note) });
          const age = ageShort(t.receivedAt, now);
          return (
            <li key={a.key} data-testid="attention-item" data-kind={a.kind} className={`group relative py-1 ${index >= PHONE_ROWS ? "max-md:hidden" : ""}`}>
              <div className="-mx-2 flex flex-col gap-3 rounded-control px-2 py-3 md:flex-row md:items-center md:gap-4 md:group-hover:bg-muted/60">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span aria-hidden data-testid="attention-avatar" className={`flex size-8 shrink-0 items-center justify-center rounded-full text-small font-medium ${AVATAR[who.slot] ?? AVATAR[0]}`}>
                    {who.initials}
                  </span>
                  <span className="min-w-0 truncate text-body" {...(who.nameIsAddress ? { title: who.name } : {})}>
                    <span data-testid="attention-sender" className="font-medium text-foreground">{who.name}</span>
                    {who.company && !who.nameIsAddress ? <span data-testid="attention-company" className="text-muted-foreground">{` \u00b7 ${who.company}`}</span> : null}
                    {t.fromAddress ? <span className="sr-only">{`, from ${t.fromAddress}`}</span> : null}
                  </span>
                  <time data-testid="attention-age" dateTime={t.receivedAt} className="ml-auto shrink-0 text-small text-muted-foreground">
                    {age}
                    <span className="sr-only">{age === "now" ? "" : " ago"}</span>
                  </time>
                </div>
                <p data-testid="attention-subject" className="break-words text-body text-foreground">
                  {subject}
                </p>
                {why || next ? (
                  <p data-testid="attention-note" className="line-clamp-2 text-small text-muted-foreground">
                    {why ? (
                      <>
                        <span className="sr-only">Why it matters: </span>
                        {why}
                      </>
                    ) : null}
                    {why && next ? (
                      <>
                        <span aria-hidden>{" \u2192 "}</span>
                        <span className="sr-only"> </span>
                      </>
                    ) : null}
                    {next ? (
                      <>
                        <span className="sr-only">Next step: </span>
                        {next}
                      </>
                    ) : null}
                  </p>
                ) : null}
                {chips.length > 0 || (showMailbox && mailbox) ? (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {chips.map((c) => (
                      <Badge key={c.key} variant={CHIP_TONE[c.tone]} data-testid="attention-chip">
                        {c.label}
                      </Badge>
                    ))}
                    {showMailbox && mailbox ? <span data-testid="attention-mailbox" className="text-small text-muted-foreground">to {mailbox}</span> : null}
                  </div>
                ) : null}
              </div>
              <div data-testid="attention-actions" className="flex shrink-0 items-center gap-3 max-md:[&_a]:min-h-11 max-md:[&_button]:min-h-11">
                {a.kind === "repeated_failures" ? null : (
                  <span className="relative z-[1] inline-flex">
                    <ReplyAction canReply={canReply} target={{ laneId, connectionId: t.connectionId, messageId: t.messageId, threadKey: t.threadKey, proposalId: replies?.get(`${t.connectionId}:${t.messageId}`) ?? null }} />
                  </span>
                )}
                <Link
                  href={inboxHref(laneId, t.messageId)}
                  data-testid="attention-open"
                  aria-label={`Open: ${subject}`}
                  className="inline-flex items-center px-2 text-small font-medium text-primary underline-offset-2 after:absolute after:inset-y-0 after:-inset-x-2 after:rounded-control after:content-[''] hover:underline focus-visible:outline-none focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-transparent focus-visible:after:ring-2 focus-visible:after:ring-ring"
                >
                  Open
                </Link>
              </div>
              </div>
            </li>
          );
        })}
      </ol>
      <Link href={laneHref(laneId, "inbox")} data-testid="attention-view-all" className="self-start py-1 text-small font-medium text-primary underline-offset-2 hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center">
        <span className="max-md:hidden">View all in Inbox {"\u00b7"} {total} need attention</span>
        <span className="md:hidden">View all {"\u00b7"} {total} in Inbox</span> <span aria-hidden>{"\u2192"}</span>
      </Link>
      {stillWaiting}
    </div>
  );
}
