import { describe, expect, it } from "vitest";
import { UntrustedBody, isUntrustedBody } from "./ephemeral";
import { COMMS_PROVIDER_KEYS, FORBIDDEN_EXECUTE_PATTERN } from "./provider";
import { CommsCursorSchema, ProviderIdParamSchema, CalendarWriteIntentSchema, EventMetaSchema, MailSyncResultSchema, MailWriteIntentSchema, MessageMetaSchema, WatchInfoSchema } from "./schemas";

const msg = {
  message_id: "m1",
  thread_id: "t1",
  source_url: null,
  from_address: "a@example.test",
  from_name: null,
  to_recipients: [{ address: "b@example.test" }],
  cc_recipients: [],
  subject: "Hello",
  received_at: "2026-10-01T12:00:00.000Z",
  is_read: false,
  is_starred: false,
  is_important: false,
  has_attachments: false,
  folder: "INBOX",
  labels: [],
  source_updated_at: null,
};
const evt = {
  calendar_id: "primary",
  event_id: "e1",
  ical_uid: null,
  source_url: null,
  title: "T",
  location: null,
  organizer_email: null,
  organizer_name: null,
  start_at: "2026-10-01T12:00:00.000Z",
  end_at: "2026-10-01T13:00:00.000Z",
  all_day: false,
  start_date: null,
  end_date: null,
  timezone: "America/New_York",
  attendees: [],
  status: "confirmed",
  recurring_event_id: null,
  original_start_at: null,
  online_meeting_url: null,
  source_updated_at: null,
};

describe("metadata schemas (rule 6: no content fields)", () => {
  it("accepts a message and rejects body, snippet and preview keys", () => {
    expect(MessageMetaSchema.safeParse(msg).success).toBe(true);
    for (const k of ["body", "snippet", "preview", "bodyPreview", "html"]) {
      expect(MessageMetaSchema.safeParse({ ...msg, [k]: "x" }).success, k).toBe(false);
    }
  });
  it("rejects control characters in subject and non-https urls", () => {
    expect(MessageMetaSchema.safeParse({ ...msg, subject: "a\nb" }).success).toBe(false);
    expect(MessageMetaSchema.safeParse({ ...msg, source_url: "http://x.test" }).success).toBe(false);
  });
  it("enforces the cal.event_index invariants", () => {
    expect(EventMetaSchema.safeParse(evt).success).toBe(true);
    expect(EventMetaSchema.safeParse({ ...evt, description: "x" }).success).toBe(false);
    expect(EventMetaSchema.safeParse({ ...evt, start_at: null, end_at: null }).success).toBe(false);
    expect(EventMetaSchema.safeParse({ ...evt, status: "cancelled", start_at: null, end_at: null }).success).toBe(true);
    expect(EventMetaSchema.safeParse({ ...evt, end_at: "2026-10-01T11:00:00.000Z" }).success).toBe(false);
    expect(EventMetaSchema.safeParse({ ...evt, all_day: true, start_date: "2026-10-01", end_date: "2026-10-01" }).success).toBe(false);
    const day = { ...evt, all_day: true, start_date: "2026-10-01", end_date: "2026-10-02", start_at: "2026-10-01T04:00:00.000Z", end_at: "2026-10-02T04:00:00.000Z" };
    expect(EventMetaSchema.safeParse(day).success).toBe(true);
    expect(EventMetaSchema.safeParse({ ...day, timezone: null }).success).toBe(false); // all-day needs a zone
    expect(EventMetaSchema.safeParse({ ...day, start_at: "2026-10-01T00:00:00.000Z" }).success).toBe(false); // not local midnight
    expect(EventMetaSchema.safeParse({ ...day, timezone: "Not/AZone" }).success).toBe(false);
    // DST end (Nov 1, 2026 in New York): EDT midnight is 04:00Z, EST midnight two days later is 05:00Z.
    const dst = { ...day, start_date: "2026-11-01", end_date: "2026-11-03", start_at: "2026-11-01T04:00:00.000Z", end_at: "2026-11-03T05:00:00.000Z" };
    expect(EventMetaSchema.safeParse(dst).success).toBe(true);
    expect(EventMetaSchema.safeParse({ ...dst, end_at: "2026-11-03T04:00:00.000Z" }).success).toBe(false);
  });
});

describe("sync result", () => {
  const ok = { upserts: [], removals: [], nextCursor: { value: "v1" }, hasMore: false, fullResyncRequired: false };
  it("requires a cursor unless a full resync is required, and then forbids data", () => {
    expect(MailSyncResultSchema.safeParse(ok).success).toBe(true);
    expect(MailSyncResultSchema.safeParse({ ...ok, nextCursor: null }).success).toBe(false);
    expect(MailSyncResultSchema.safeParse({ ...ok, nextCursor: null, fullResyncRequired: true }).success).toBe(true);
    expect(MailSyncResultSchema.safeParse({ ...ok, fullResyncRequired: true }).success).toBe(false);
    expect(MailSyncResultSchema.safeParse({ ...ok, nextCursor: null, fullResyncRequired: true, upserts: [msg] }).success).toBe(false);
  });
});

describe("watch info", () => {
  const base = { resource: "mail", created_at: "2026-10-01T12:00:00.000Z" };
  const exp = "2026-10-08T12:00:00.000Z";
  it("push needs an expiry and a channel or resource id; polling has none", () => {
    expect(WatchInfoSchema.safeParse({ ...base, mode: "push", channel_id: "c", resource_id: null, expires_at: exp }).success).toBe(true);
    expect(WatchInfoSchema.safeParse({ ...base, mode: "push", channel_id: null, resource_id: "sub-1", state: "calendar-1", expires_at: exp }).success).toBe(true);
    expect(WatchInfoSchema.safeParse({ ...base, mode: "push", channel_id: null, resource_id: null, expires_at: exp }).success).toBe(false);
    expect(WatchInfoSchema.safeParse({ ...base, mode: "push", channel_id: "c", resource_id: null, expires_at: null }).success).toBe(false);
    expect(WatchInfoSchema.safeParse({ ...base, mode: "polling", channel_id: null, resource_id: null, expires_at: null }).success).toBe(true);
    expect(WatchInfoSchema.safeParse({ ...base, mode: "polling", channel_id: "c", resource_id: null, expires_at: null }).success).toBe(false);
    expect(WatchInfoSchema.safeParse({ ...base, mode: "push", channel_id: "c", resource_id: null, expires_at: exp, secret_token: "x" }).success).toBe(false);
  });
});

describe("write intents", () => {
  const compose = { fromMailbox: "a@example.test", to: ["b@example.test"], subject: "s", bodyText: "b" };
  it("accepts only email.send and email.save_draft, rejects header injection and unknown keys", () => {
    expect(MailWriteIntentSchema.safeParse({ action_type: "email.send", compose }).success).toBe(true);
    expect(MailWriteIntentSchema.safeParse({ action_type: "email.delete", compose }).success).toBe(false);
    expect(MailWriteIntentSchema.safeParse({ action_type: "email.send", compose: { ...compose, subject: "a\r\nBcc: x@y.test" } }).success).toBe(false);
    expect(MailWriteIntentSchema.safeParse({ action_type: "email.send", compose: { ...compose, attachments: [] } }).success).toBe(false);
  });
  it("lower-cases and de-duplicates recipients", () => {
    const r = MailWriteIntentSchema.parse({ action_type: "email.send", compose: { ...compose, to: ["A@Example.test", "a@example.test"] } });
    expect(r.compose.to).toEqual(["a@example.test"]);
  });
  it("rejects C1 controls, line separators and bidi controls in subjects and display names", () => {
    for (const bad of ["a\u0085b", "a\u2028b", "a\u2029b", "a\u202Ab", "a\u202Eb", "a\u2066b", "a\u2069b"]) {
      expect(MailWriteIntentSchema.safeParse({ action_type: "email.send", compose: { ...compose, subject: bad } }).success, bad).toBe(false);
      expect(MessageMetaSchema.safeParse({ ...msg, from_name: bad }).success, bad).toBe(false);
    }
  });
  it("types calendar writes", () => {
    expect(CalendarWriteIntentSchema.safeParse({ action_type: "calendar.event.move", calendar_id: "primary", event_id: "e", changes: {} }).success).toBe(true);
    expect(CalendarWriteIntentSchema.safeParse({ action_type: "calendar.event.delete", calendar_id: "primary", changes: {} }).success).toBe(false);
  });
});

describe("provider surface", () => {
  it("lists no execute-like member", () => {
    for (const k of COMMS_PROVIDER_KEYS) if (k !== "prepareWrite") expect(FORBIDDEN_EXECUTE_PATTERN.test(k), k).toBe(false);
  });
});

describe("UntrustedBody", () => {
  it("is branded untrusted and hides its text from serialisation", () => {
    const b = new UntrustedBody({ origin: "document", contentType: "text/html", text: "<p>hi</p>", truncated: true });
    expect(isUntrustedBody(b)).toBe(true);
    expect(isUntrustedBody({ trust: "untrusted" })).toBe(false);
    expect(b.trust).toBe("untrusted");
    expect(b.truncated).toBe(true);
    expect(JSON.stringify(b)).not.toContain("<p>");
  });
});

describe("param and cursor schemas", () => {
  it("rejects ids that could alter a URL", () => {
    for (const bad of ["", "a/b", "..", ".", "x?y", "x#y", "x\u0007y", "a".repeat(513)]) expect(ProviderIdParamSchema.safeParse(bad).success, bad).toBe(false);
    for (const ok of ["18c2f", "AAMkAD=", "user@example.test", "a-b_c.d"]) expect(ProviderIdParamSchema.safeParse(ok).success, ok).toBe(true);
  });
  it("accepts cursors up to 16 KB", () => {
    expect(CommsCursorSchema.safeParse({ value: "x".repeat(16_384) }).success).toBe(true);
    expect(CommsCursorSchema.safeParse({ value: "x".repeat(16_385) }).success).toBe(false);
  });
});
