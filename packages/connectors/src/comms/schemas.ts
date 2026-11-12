// Metadata record types for mail, calendar and document providers (T-062). The mail and event records map 1:1 onto
// the columns of `comms.message_index` and `cal.event_index` (T-061, migration 20261105090000_comms_cal_index.sql), minus the
// identity columns the caller adds (lane_id, connection_id, provider) and minus classifier/summary columns the
// portal computes. Strict objects: a provider cannot smuggle a body, snippet or preview into a metadata record, and
// the schema (like the database) has no field for one (rule 6).
//
// Money is not involved. Times are ISO instants with offset; all-day events carry exclusive end dates.
import { z } from "zod";
import { isMailAddress } from "../google/headers";
import { InstantSchema, OpNameSchema } from "../contract/schemas";

/**
 * No C0/C1 controls, no line/paragraph separators (U+2028/2029) and no bidirectional controls (U+202A-202E,
 * U+2066-2069): these let a subject or display name spoof what an approver reads.
 */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const noCtrl = (s: string) => !UNSAFE_TEXT.test(s);

/**
 * An id passed as a call parameter (message, event, calendar, document, channel). Conservative on purpose: letters,
 * digits and `_ - = . @ + :` only, so no path separators, query or fragment characters can reach a provider URL.
 * Not "." or "..". Metadata records returned by sync use the looser `id512` (they mirror the table checks).
 */
export const ProviderIdParamSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_=@.+:-]+$/)
  .refine((s) => s !== "." && s !== "..", "path segment");

/** Optional bound on live content returned to the caller; the provider passes it through (e.g. truncates). */
export const ReadBodyOptionsSchema = z.strictObject({ maxChars: z.int().min(1).max(1_000_000).optional() });
export type ReadBodyOptions = z.infer<typeof ReadBodyOptionsSchema>;

/**
 * Sync cursor for comms providers: one per connection, opaque, up to 16 KB. It is a provider-encoded composite: for
 * Google Calendar one syncToken per calendar, for Graph one deltaLink per mail folder or calendar, for Gmail the
 * historyId. It must bind the connection (embed the connection id or an HMAC of lane + connection id) so that a cursor
 * taken from another connection is answered with `fullResyncRequired`, never used. It carries no tokens.
 */
export const CommsCursorSchema = z.strictObject({ value: z.string().min(1).max(16_384) });
export type CommsCursor = z.infer<typeof CommsCursorSchema>;

/** Start of `date` (YYYY-MM-DD) in IANA zone `tz`, as epoch ms. Throws RangeError for an unknown zone. */
export function zonedMidnightMs(date: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const offset = (utc: number): number => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(utc)).map((p) => [p.type, Number(p.value)]));
    return Date.UTC(parts.year as number, (parts.month as number) - 1, parts.day as number, parts.hour as number, parts.minute as number, parts.second as number) - Math.floor(utc / 1000) * 1000;
  };
  const guess = Date.UTC(y, m - 1, d);
  return guess - offset(guess - offset(guess));
}
const id512 = z.string().min(1).max(512).refine(noCtrl, "control characters");
const httpsUrl = z
  .string()
  .max(2048)
  .regex(/^https:\/\//)
  .refine((s) => !/[\u0000-\u001f\u007f\s]/.test(s), "control characters or whitespace");
const address = z.string().min(3).max(320).refine(noCtrl, "control characters").refine(isMailAddress, "not an email address");
const dateOnly = z.iso.date();

export const RecipientSchema = z.strictObject({
  address,
  name: z.string().max(200).refine(noCtrl, "control characters").optional(),
});
export type Recipient = z.infer<typeof RecipientSchema>;

const labelSchema = z.string().min(1).max(256).refine(noCtrl, "control characters");

/**
 * One mail message's metadata (comms.message_index columns). No body, snippet or preview.
 * Mapping: `folder` is the single primary container (Graph parent folder name; Gmail "INBOX" when the INBOX label is
 * set, else null); `labels` are Gmail labels / Graph categories; `is_important` is Gmail IMPORTANT / Graph importance
 * "high". Graph requires `Prefer: IdType="ImmutableId"` so ids survive moves between folders.
 */
export const MessageMetaSchema = z.strictObject({
  message_id: id512,
  thread_id: id512.nullable(),
  source_url: httpsUrl.nullable(),
  from_address: address.nullable(),
  from_name: z.string().max(200).refine(noCtrl, "control characters").nullable(),
  to_recipients: z.array(RecipientSchema).max(200),
  cc_recipients: z.array(RecipientSchema).max(200),
  subject: z.string().max(998).refine(noCtrl, "control characters").nullable(),
  received_at: InstantSchema,
  is_read: z.boolean(),
  is_starred: z.boolean(),
  is_important: z.boolean(),
  has_attachments: z.boolean(),
  // Flags derived from headers at sync time (T-234 part 2): bulk/list mail, calendar notification, auto-reply. Booleans only; the
  // headers themselves are never kept. Optional: absent = false (a provider that cannot tell, and records from before the flags).
  is_bulk: z.boolean().optional(),
  is_calendar: z.boolean().optional(),
  is_auto: z.boolean().optional(),
  is_generated: z.boolean().optional(),
  is_auth_pass: z.boolean().optional(),
  folder: id512.nullable(),
  labels: z.array(labelSchema).max(50),
  source_updated_at: InstantSchema.nullable(),
});
export type MessageMeta = z.infer<typeof MessageMetaSchema>;

/**
 * Provider reported the message truly gone: sets `comms.message_index.deleted` (Gmail messagesDeleted, Graph @removed
 * with reason "deleted", or a reconciled move out of the synced folders). Trash/archive are labels, not removals.
 * Apply a page atomically: removals first, then upserts (so remove-then-re-add of one id ends present).
 */
export const MessageRemovalSchema = z.strictObject({ message_id: id512 });
export type MessageRemoval = z.infer<typeof MessageRemovalSchema>;

export const ATTENDEE_RESPONSES = ["accepted", "declined", "tentative", "needs_action"] as const;
export const AttendeeSchema = z.strictObject({
  email: address,
  name: z.string().max(200).refine(noCtrl, "control characters").optional(),
  response: z.enum(ATTENDEE_RESPONSES).optional(),
});
export type Attendee = z.infer<typeof AttendeeSchema>;

export const EVENT_STATUSES = ["confirmed", "tentative", "cancelled"] as const;

/**
 * One calendar event instance's metadata (cal.event_index columns). Recurring series arrive expanded into
 * instances (each with its own `event_id`, `recurring_event_id` = series id, `original_start_at`). A `cancelled` stub
 * may have no times. All-day events: `all_day`, `start_date`, `end_date` (exclusive, > start_date), a non-null
 * `timezone`, and, because the table requires instants for every non-cancelled event, `start_at`/`end_at` = local
 * midnight of those dates in `timezone` (checked with Intl). Consumers display `start_date`/`end_date` for all-day
 * events, never the instants. No description.
 * A `cancelled` stub is a status change: merge it by updating `status` only; do not null the stored title, times or
 * attendees (the provider sent none).
 */
export const EventMetaSchema = z
  .strictObject({
    calendar_id: id512,
    event_id: id512,
    ical_uid: id512.nullable(),
    source_url: httpsUrl.nullable(),
    title: z.string().max(1000).refine(noCtrl, "control characters").nullable(),
    location: z.string().max(1000).refine(noCtrl, "control characters").nullable(),
    organizer_email: address.nullable(),
    organizer_name: z.string().max(200).refine(noCtrl, "control characters").nullable(),
    start_at: InstantSchema.nullable(),
    end_at: InstantSchema.nullable(),
    all_day: z.boolean(),
    start_date: dateOnly.nullable(),
    end_date: dateOnly.nullable(),
    timezone: z.string().regex(/^[A-Za-z0-9_+./-]{1,64}$/).nullable(),
    attendees: z.array(AttendeeSchema).max(500),
    status: z.enum(EVENT_STATUSES),
    recurring_event_id: id512.nullable(),
    original_start_at: InstantSchema.nullable(),
    online_meeting_url: httpsUrl.nullable(),
    source_updated_at: InstantSchema.nullable(),
  })
  .superRefine((e, ctx) => {
    // Same invariants as the cal.event_index check constraints, so a bad record fails here, not in the upsert.
    if (e.status !== "cancelled" && (e.start_at === null || e.end_at === null)) {
      ctx.addIssue({ code: "custom", message: "start_at and end_at are required unless status is cancelled", path: ["start_at"] });
    }
    if (e.start_at !== null && e.end_at !== null && Date.parse(e.end_at) < Date.parse(e.start_at)) {
      ctx.addIssue({ code: "custom", message: "end_at is before start_at", path: ["end_at"] });
    }
    if (e.all_day) {
      if (e.start_date === null || e.end_date === null || e.end_date <= e.start_date) {
        ctx.addIssue({ code: "custom", message: "all-day events need start_date and an exclusive end_date after it", path: ["end_date"] });
      } else if (e.timezone === null) {
        ctx.addIssue({ code: "custom", message: "all-day events need a timezone", path: ["timezone"] });
      } else if (e.start_at !== null && e.end_at !== null) {
        try {
          if (Date.parse(e.start_at) !== zonedMidnightMs(e.start_date, e.timezone) || Date.parse(e.end_at) !== zonedMidnightMs(e.end_date, e.timezone)) {
            ctx.addIssue({ code: "custom", message: "all-day start_at/end_at must be local midnight of the dates in timezone", path: ["start_at"] });
          }
        } catch {
          ctx.addIssue({ code: "custom", message: "unknown timezone", path: ["timezone"] });
        }
      }
    }
  });
export type EventMeta = z.infer<typeof EventMetaSchema>;

/** Provider reported an event/instance gone (hard delete). Cancellations arrive as `cancelled` upserts instead. */
export const EventRemovalSchema = z.strictObject({ calendar_id: id512, event_id: id512 });
export type EventRemoval = z.infer<typeof EventRemovalSchema>;

/** A document's metadata and link. Never content (live search returns links only). */
export const DocumentLinkSchema = z.strictObject({
  document_id: id512,
  title: z.string().max(1000).refine(noCtrl, "control characters").nullable(),
  mime_type: z.string().max(255).refine(noCtrl, "control characters").nullable(),
  source_url: httpsUrl,
  owner_email: address.nullable(),
  modified_at: InstantSchema.nullable(),
});
export type DocumentLink = z.infer<typeof DocumentLinkSchema>;

/**
 * Result of one sync page for one connection. Cursors (Gmail historyId, Calendar syncToken, Graph deltaLink) are per
 * connection, opaque, and persisted by the caller only after it has applied `upserts` and `removals`.
 * - `hasMore`: call again with `nextCursor` to continue this run (page-bounded work).
 * - Failure: a sync that throws never advances the cursor; the caller keeps its old one and retries (retries live in
 *   the HTTP client, not here).
 * - `fullResyncRequired`: the supplied cursor is too old, invalid or belongs to another connection (Gmail 404
 *   history, Calendar 410, Graph 410). It is an answer, not an error.
 *   Arrays are empty and `nextCursor` is null; the caller discards its cursor and calls `sync(.., null)`.
 *   `nextCursor` is non-null in every other result.
 */
export function syncResultSchema<U extends z.ZodType, R extends z.ZodType>(upsert: U, removal: R) {
  return z
    .strictObject({
      upserts: z.array(upsert),
      removals: z.array(removal),
      nextCursor: CommsCursorSchema.nullable(),
      hasMore: z.boolean(),
      fullResyncRequired: z.boolean(),
    })
    .refine((r) => (r.fullResyncRequired ? r.nextCursor === null && !r.hasMore && r.upserts.length === 0 && r.removals.length === 0 : r.nextCursor !== null), {
      message: "fullResyncRequired results are empty with a null cursor; all others carry a cursor",
    });
}
export const MailSyncResultSchema = syncResultSchema(MessageMetaSchema, MessageRemovalSchema);
/**
 * Same rules as `syncResultSchema`, plus `dropCalendars` (Google, T-064): calendars that left the synced selection in a
 * discovery that SUCCEEDED; the apply deletes their rows for this lane and connection in the same transaction as the
 * page. Absent/empty = none.
 */
export const CalendarSyncResultSchema = z
  .strictObject({
    upserts: z.array(EventMetaSchema),
    removals: z.array(EventRemovalSchema),
    nextCursor: CommsCursorSchema.nullable(),
    hasMore: z.boolean(),
    fullResyncRequired: z.boolean(),
    dropCalendars: z.array(z.string().min(1).max(512)).max(10).optional(),
  })
  .refine((r) => (r.fullResyncRequired ? r.nextCursor === null && !r.hasMore && r.upserts.length === 0 && r.removals.length === 0 : r.nextCursor !== null), {
    message: "fullResyncRequired results are empty with a null cursor; all others carry a cursor",
  });
export type MailSyncResult = z.infer<typeof MailSyncResultSchema>;
export type CalendarSyncResult = z.infer<typeof CalendarSyncResultSchema>;

export const CommsSyncOptionsSchema = z.strictObject({
  /** Upper bound on records in one page. */
  pageSize: z.int().min(1).max(500).optional(),
});
export type CommsSyncOptions = z.infer<typeof CommsSyncOptionsSchema>;

/**
 * `query` is plain text. Implementers quote or escape it for the vendor (Gmail `q`, Graph `$search`/KQL, Drive `q`):
 * search operators such as `from:` or `OR` in it must not widen the search. `limit` caps the provider calls and the
 * result size.
 */
export const SearchQuerySchema = z.strictObject({
  query: z.string().min(1).max(500).refine(noCtrl, "control characters"),
  limit: z.int().min(1).max(100).default(25),
});
export type SearchQuery = z.input<typeof SearchQuerySchema>;

export const WATCH_RESOURCES = ["mail", "calendar"] as const;
/**
 * Push subscription state (Gmail users.watch, Calendar events.watch per calendar, Graph subscriptions). Persist it
 * (non-secret) so `renew` and `stop` need only this object. The channel token (Google) or clientState (Graph) is a
 * Vault secret and is never in `WatchInfo`. `resource_id` is the vendor's resource handle (Google resourceId, Graph
 * subscription id); `state` is optional opaque non-secret data (e.g. the calendar id the channel covers).
 * `polling` is returned by a provider with no push: no channel, resource or expiry; `renew`/`stop` are no-ops. The
 * callback URL is server configuration, never a parameter, so retrieved content cannot choose it.
 */
export const WatchInfoSchema = z
  .strictObject({
    mode: z.enum(["push", "polling"]),
    resource: z.enum(WATCH_RESOURCES),
    channel_id: z.string().min(1).max(256).nullable(),
    resource_id: z.string().min(1).max(256).nullable(),
    state: z.string().min(1).max(1024).optional(),
    expires_at: InstantSchema.nullable(),
    created_at: InstantSchema,
  })
  .refine(
    (w) =>
      w.mode === "polling"
        ? w.channel_id === null && w.resource_id === null && w.expires_at === null
        : w.expires_at !== null && (w.channel_id !== null || w.resource_id !== null),
    { message: "push needs an expiry and a channel or resource id; polling has none of them" },
  );
export type WatchInfo = z.infer<typeof WatchInfoSchema>;

// ---- prepareWrite intents (approvals spec §8). Phase-4 calendar writes are typed but unsupported. ----

const headerText = (max: number) => z.string().min(1).max(max).refine(noCtrl, "line breaks and control characters are not allowed");
const recipientAddress = z.email().max(320);
/** Lower-cased and de-duplicated, order kept, so the approved list has no look-alike repeats. */
const recipientList = (min: number, max: number) =>
  z
    .array(recipientAddress)
    .min(min)
    .max(max)
    .transform((a) => [...new Set(a.map((x) => x.toLowerCase()))]);

/** Payload for email.send / email.save_draft: only text the user or assistant composed (no quoted thread text). */
export const EmailComposeSchema = z.strictObject({
  fromMailbox: recipientAddress,
  to: recipientList(1, 100),
  cc: recipientList(0, 100).default([]),
  bcc: recipientList(0, 100).default([]),
  subject: headerText(998),
  bodyText: z.string().min(1).max(100_000),
  inReplyTo: z.strictObject({ threadId: ProviderIdParamSchema, messageId: ProviderIdParamSchema }).optional(),
});
export type EmailCompose = z.infer<typeof EmailComposeSchema>;

export const MAIL_ACTION_TYPES = ["email.send", "email.save_draft"] as const;
export const MailWriteIntentSchema = z.strictObject({
  action_type: z.enum(MAIL_ACTION_TYPES),
  compose: EmailComposeSchema,
});
export type MailWriteIntent = z.input<typeof MailWriteIntentSchema>;

export const CALENDAR_ACTION_TYPES = ["calendar.event.create", "calendar.event.move", "calendar.event.decline", "calendar.event.propose_time"] as const;
/** Defined for T-117/T-181; every provider answers `unsupported_op` until phase 4. */
export const CalendarWriteIntentSchema = z.strictObject({
  action_type: z.enum(CALENDAR_ACTION_TYPES),
  calendar_id: id512,
  event_id: id512.optional(),
  changes: z.record(z.string(), z.json()),
});
export type CalendarWriteIntent = z.input<typeof CalendarWriteIntentSchema>;

export const DocumentWriteIntentSchema = z.strictObject({
  action_type: OpNameSchema,
  document_id: id512.optional(),
  changes: z.record(z.string(), z.json()),
});
export type DocumentWriteIntent = z.input<typeof DocumentWriteIntentSchema>;

export const EMAIL_PAYLOAD_SCHEMA_VERSION = 1;
