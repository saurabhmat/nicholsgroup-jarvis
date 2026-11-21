// The strict mapper of the Microsoft mail sync (T-258, spec §8.2): field mapping, the window, the webLink host rule, the caps on what the
// documentation leaves unbounded, explicit flags, and that nothing outside the mapping (a body above all) reaches the record.
import { describe, expect, it } from "vitest";
import { MessageMetaSchema } from "../comms/schemas";
import { MAIL_BODY_CANARY, MAIL_PREVIEW_CANARY } from "../testing/msw/microsoft/mail";
import { mapMessage, MAX_CATEGORIES, MAX_CATEGORY_CHARS, MAX_ID_CHARS, MAX_RECIPIENTS, MESSAGE_SELECT, safeWebLink, type MapContext } from "./mail-map";

const SINCE = "2026-08-07T12:00:00.000Z";
const inbox: MapContext = { folder: "inbox", since: SINCE };
const sent: MapContext = { folder: "sentitems", since: SINCE };
const msg = (over: Record<string, unknown> = {}) => ({
  id: "AAMkMessage1=",
  conversationId: "AAQkConversation1=",
  webLink: "https://outlook.office.com/owa/?ItemID=AAMk&exvsurl=1&viewmodel=ReadMessageItem",
  from: { emailAddress: { address: "Sender@Sender.Example.Test", name: "Synthetic Sender" } },
  toRecipients: [{ emailAddress: { address: "exec@pubkgroup.example.test", name: "Exec" } }],
  ccRecipients: [{ emailAddress: { address: "cc@pubkgroup.example.test" } }],
  subject: "Quarterly numbers",
  receivedDateTime: "2026-11-04T10:00:00Z",
  sentDateTime: "2026-11-04T09:59:00Z",
  isRead: false,
  flag: { flagStatus: "notFlagged" },
  importance: "normal",
  hasAttachments: false,
  inferenceClassification: "focused",
  categories: [],
  lastModifiedDateTime: "2026-11-04T10:01:00Z",
  ...over,
});
const meta = (raw: unknown, ctx: MapContext = inbox) => {
  const r = mapMessage(raw, ctx);
  if (!("meta" in r)) throw new Error(`expected a record, got ${r.dropped}`);
  return r.meta;
};

describe("field mapping (spec §8.2)", () => {
  it("maps every index field", () => {
    const m = meta(msg());
    expect(m).toEqual({
      message_id: "AAMkMessage1=",
      thread_id: "AAQkConversation1=",
      source_url: "https://outlook.office.com/owa/?ItemID=AAMk&exvsurl=1&viewmodel=ReadMessageItem",
      from_address: "sender@sender.example.test",
      from_name: "Synthetic Sender",
      to_recipients: [{ address: "exec@pubkgroup.example.test", name: "Exec" }],
      cc_recipients: [{ address: "cc@pubkgroup.example.test" }],
      subject: "Quarterly numbers",
      received_at: "2026-11-04T10:00:00.000Z",
      is_read: false,
      is_starred: false,
      is_important: false,
      has_attachments: false,
      folder: "INBOX",
      labels: [],
      source_updated_at: "2026-11-04T10:01:00.000Z",
    });
    MessageMetaSchema.parse(m);
  });

  it("the canonical folders and the SENT label: INBOX, SENT (label SENT), ARCHIVE; received_at is the sent time for Sent Items", () => {
    expect(meta(msg()).folder).toBe("INBOX");
    expect(meta(msg()).labels).not.toContain("SENT");
    const s = meta(msg(), sent);
    expect(s.folder).toBe("SENT");
    expect(s.labels).toEqual(["SENT"]);
    expect(s.received_at).toBe("2026-11-04T09:59:00.000Z");
    expect(meta(msg(), { folder: "archive", since: SINCE }).folder).toBe("ARCHIVE");
    // the sent time is missing: the received time is used; a Sent item is never given an invented time
    expect(meta(msg({ sentDateTime: null }), sent).received_at).toBe("2026-11-04T10:00:00.000Z");
  });

  it("flags are explicit booleans on every record, including when Graph omits or nulls them", () => {
    const on = meta(msg({ isRead: true, flag: { flagStatus: "flagged" }, importance: "high", hasAttachments: true }));
    expect(on).toMatchObject({ is_read: true, is_starred: true, is_important: true, has_attachments: true });
    for (const stripped of [{ isRead: null, flag: null, importance: null, hasAttachments: null }, { isRead: undefined, flag: undefined, importance: undefined, hasAttachments: undefined }]) {
      const m = meta(msg(stripped));
      expect(m).toMatchObject({ is_read: false, is_starred: false, is_important: false, has_attachments: false });
    }
    expect(meta(msg({ flag: { flagStatus: "complete" } })).is_starred).toBe(false);
    expect(meta(msg({ importance: "low" })).is_important).toBe(false);
    // the header-derived flags are not set by this task: they are absent, so a later task's value is kept on update
    const m = meta(msg());
    for (const k of ["is_bulk", "is_calendar", "is_auto", "is_generated", "is_auth_pass"]) expect(k in m).toBe(false);
  });

  it("labels: OTHER for the Other tab, categories as cat:<name> so a category named SENT cannot pose as the system label", () => {
    const m = meta(msg({ inferenceClassification: "other", categories: ["SENT", "Red category", "Red category", "  ", "INBOX"] }));
    expect(m.labels).toEqual(["OTHER", "cat:SENT", "cat:Red category", "cat:INBOX"]);
    expect(m.labels).not.toContain("SENT");
    expect(meta(msg({ categories: ["SENT"] })).labels).toEqual(["cat:SENT"]);
    expect(meta(msg({ inferenceClassification: "Other" })).labels).toEqual(["OTHER"]);
  });

  it("caps what the documentation leaves unbounded: categories (count and length), ids, recipients", () => {
    const many = Array.from({ length: 200 }, (_v, i) => `c${String(i)}`);
    const m = meta(msg({ categories: many }));
    expect(m.labels.length).toBe(MAX_CATEGORIES);
    expect(meta(msg({ categories: ["x".repeat(500)] })).labels[0]).toHaveLength("cat:".length + MAX_CATEGORY_CHARS);
    expect(mapMessage(msg({ id: "x".repeat(MAX_ID_CHARS + 1) }), inbox)).toEqual({ dropped: "unusable" });
    expect(mapMessage(msg({ id: "" }), inbox)).toEqual({ dropped: "unusable" });
    expect(mapMessage(msg({ id: "a\u0007b" }), inbox)).toEqual({ dropped: "unusable" });
    expect(meta(msg({ id: "x".repeat(MAX_ID_CHARS) })).message_id).toHaveLength(MAX_ID_CHARS);
    expect(meta(msg({ conversationId: "x".repeat(MAX_ID_CHARS + 1) })).thread_id).toBeNull();
    const rcpts = Array.from({ length: 300 }, (_v, i) => ({ emailAddress: { address: `r${String(i)}@x.example.test` } }));
    const big = meta(msg({ toRecipients: rcpts, ccRecipients: rcpts }));
    expect(big.to_recipients).toHaveLength(MAX_RECIPIENTS);
    expect(big.cc_recipients).toHaveLength(MAX_RECIPIENTS);
  });

  it("recipients: unusable addresses are dropped, names cleaned and bounded, addresses lower-cased", () => {
    const m = meta(
      msg({
        from: { emailAddress: { address: "/O=EXCHANGELABS/OU=X/CN=RECIPIENTS/CN=abc", name: "Legacy DN" } },
        toRecipients: [{ emailAddress: { address: "not-an-address" } }, { emailAddress: { address: "<x@y.test>" } }, { emailAddress: { address: "Ok@X.Example.Test", name: `Ok‮Evil ${"n".repeat(300)}` } }, { emailAddress: null }, { emailAddress: { address: "same@x.example.test", name: "SAME@x.example.test" } }],
      }),
    );
    expect(m.from_address).toBeNull();
    expect(m.from_name).toBeNull();
    expect(m.to_recipients).toHaveLength(2);
    expect(m.to_recipients[0]?.address).toBe("ok@x.example.test");
    expect(m.to_recipients[0]?.name?.length).toBeLessThanOrEqual(200);
    expect(m.to_recipients[0]?.name).not.toMatch(/‮/);
    expect(m.to_recipients[1]).toEqual({ address: "same@x.example.test" });
  });

  it("subject: controls and bidi characters removed, whitespace collapsed, at most 998 characters, empty is null", () => {
    expect(meta(msg({ subject: "Hi\r\nBcc: x‮evil⁦y⁩  there" })).subject).toBe("Hi Bcc: x evil y there");
    expect(meta(msg({ subject: "s".repeat(5000) })).subject).toHaveLength(998);
    expect(meta(msg({ subject: "   " })).subject).toBeNull();
    expect(meta(msg({ subject: null })).subject).toBeNull();
  });
});

describe("the window: older messages are dropped by the mapper, never indexed", () => {
  it("drops a message received before `since`, keeps one at or after it", () => {
    expect(mapMessage(msg({ receivedDateTime: "2026-08-07T11:59:59Z", sentDateTime: "2026-08-07T11:59:59Z" }), inbox)).toEqual({ dropped: "old" });
    expect(mapMessage(msg({ receivedDateTime: "2026-08-07T12:00:00Z", sentDateTime: "2026-08-07T12:00:00Z" }), inbox)).toHaveProperty("meta");
    expect(mapMessage(msg({ receivedDateTime: "2025-01-01T00:00:00Z", sentDateTime: "2025-01-01T00:00:00Z" }), sent)).toEqual({ dropped: "old" });
  });
  it("a message with no usable time is unusable (a time is never invented)", () => {
    for (const t of [{ receivedDateTime: null, sentDateTime: null }, { receivedDateTime: "yesterday", sentDateTime: "later" }, { receivedDateTime: "", sentDateTime: undefined }]) {
      expect(mapMessage(msg(t), inbox)).toEqual({ dropped: "unusable" });
    }
  });
  it("anything that is not a message object is unusable", () => {
    for (const raw of [null, 5, "x", [], {}, { id: 5 }, msg({ isRead: "yes" }), msg({ toRecipients: "x" }), msg({ categories: [1] })]) {
      expect(mapMessage(raw, inbox), JSON.stringify(raw)).toEqual({ dropped: "unusable" });
    }
  });
});

describe("webLink: https and an allow-listed Outlook host, else null", () => {
  const ok = "https://outlook.office.com/owa/?ItemID=x";
  it("accepts the two assumed commercial hosts", () => {
    expect(safeWebLink(ok)).toBe(ok);
    expect(safeWebLink("https://outlook.office365.com/mail/id/x")).toBe("https://outlook.office365.com/mail/id/x");
  });
  it("refuses another host, scheme, port, credentials, look-alikes, junk and the gcc_high cloud (empty list until T-267)", () => {
    for (const l of ["http://outlook.office.com/x", "https://evil.example.test/x", "https://outlook.office.com.evil.example.test/x", "https://outlook.office.com@evil.example.test/x", "https://user:pw@outlook.office.com/x", "https://outlook.office.com:8443/x", "https://OUTLOOK.office.com.evil/x", "javascript:alert(1)", "https://outlook.office.com/x y", "https://outlook.office.com/x\n", "outlook.office.com/x", "", `https://outlook.office.com/${"a".repeat(2100)}`]) {
      expect(safeWebLink(l), l).toBeNull();
    }
    expect(safeWebLink(null)).toBeNull();
    expect(safeWebLink(undefined)).toBeNull();
    expect(safeWebLink(ok, "gcc_high")).toBeNull();
  });
  it("a bad link gives source_url null and keeps the message", () => {
    expect(meta(msg({ webLink: "https://evil.example.test/x" })).source_url).toBeNull();
  });
});

describe("rule 6: no body is ever read", () => {
  it("the request selects the index fields only", () => {
    expect([...MESSAGE_SELECT].sort()).toEqual(["categories", "conversationId", "flag", "from", "hasAttachments", "id", "importance", "inferenceClassification", "isRead", "lastModifiedDateTime", "receivedDateTime", "sentDateTime", "subject", "toRecipients", "ccRecipients", "webLink"].sort());
    for (const banned of ["body", "bodyPreview", "uniqueBody", "internetMessageHeaders", "attachments"]) expect(MESSAGE_SELECT as readonly string[]).not.toContain(banned);
  });
  it("body, bodyPreview, uniqueBody and every other field Graph returns anyway are dropped: the record has exactly the mapped keys", () => {
    const leaky = msg({
      body: { contentType: "text", content: MAIL_BODY_CANARY },
      bodyPreview: MAIL_PREVIEW_CANARY,
      uniqueBody: { content: MAIL_BODY_CANARY },
      internetMessageHeaders: [{ name: "X", value: MAIL_BODY_CANARY }],
      attachments: [{ name: MAIL_BODY_CANARY }],
      snippet: MAIL_BODY_CANARY,
      "@odata.etag": MAIL_BODY_CANARY,
    });
    const m = meta(leaky);
    expect(Object.keys(m).sort()).toEqual(Object.keys(meta(msg())).sort());
    expect(JSON.stringify(m)).not.toContain(MAIL_BODY_CANARY);
    expect(JSON.stringify(m)).not.toContain(MAIL_PREVIEW_CANARY);
    // and a subject that quotes the canary is just a subject: nothing else carries it into another field
    expect(MessageMetaSchema.safeParse({ ...m, body: "x" }).success).toBe(false);
    expect(MessageMetaSchema.safeParse({ ...m, bodyPreview: "x" }).success).toBe(false);
  });
});
