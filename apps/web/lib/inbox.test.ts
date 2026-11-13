import { afterEach, describe, expect, it, vi } from "vitest";
import { displayText, inboxFor, isWaitingView, waitingFor, loadInbox, openMessage, parseInboxQuery, PAGE_SIZE, toRows } from "./inbox";

type Result = { data: unknown; error: unknown };
const client = (handler: (fn: string, args: Record<string, unknown>) => Result, calls: unknown[] = []) => ({
  schema: () => ({ rpc: (fn: string, args: Record<string, unknown>) => (calls.push([fn, args]), Promise.resolve(handler(fn, args))) }),
});
const row = (i: number, extra: Record<string, unknown> = {}) => ({
  message_id: `m${String(i)}`,
  from_name: "Ann",
  from_address: "ann@example.test",
  subject: `Subject ${String(i)}`,
  received_at: new Date(Date.UTC(2026, 10, 6, 12, 0, 0) - i * 60_000).toISOString(),
  is_read: false,
  is_important: false,
  is_starred: false,
  has_attachments: false,
  ...extra,
});

afterEach(() => vi.restoreAllMocks());

describe("parseInboxQuery", () => {
  it("accepts the known filters and a well-formed cursor", () => {
    expect(parseInboxQuery({ filter: "unread", before: "2026-11-06T12:00:00Z", bid: "18f0a1b2" })).toEqual({ filter: "unread", cursor: { before: "2026-11-06T12:00:00.000Z", id: "18f0a1b2" } });
  });
  it("falls back to the first page of All on anything malformed", () => {
    expect(parseInboxQuery({ filter: "spam", before: "yesterday", bid: "x" })).toEqual({ filter: "all", cursor: null });
    expect(parseInboxQuery({ filter: ["unread", "all"], before: "2026-11-06T12:00:00Z", bid: "../etc" })).toEqual({ filter: "all", cursor: null });
  });
});

describe("toRows / loadInbox", () => {
  it("drops rows with a bad id or time", () => {
    expect(toRows([row(1), { ...row(2), message_id: "a/b" }, { ...row(3), received_at: "nope" }]).map((r) => r.messageId)).toEqual(["m1"]);
  });

  it("asks for one page of this lane and offers the next page only when the page is full", async () => {
    const calls: unknown[] = [];
    const full = client(() => ({ data: Array.from({ length: PAGE_SIZE }, (_, i) => row(i)), error: null }), calls);
    const view = await loadInbox(full as never, "PKG", "unread", null);
    expect(calls[0]).toEqual(["inbox_messages", { p_lane: "PKG", p_filter: "unread", p_limit: PAGE_SIZE }]);
    expect(view.next).toEqual({ before: toRows([row(PAGE_SIZE - 1)])[0]?.receivedAt, id: `m${String(PAGE_SIZE - 1)}` });

    const calls2: unknown[] = [];
    const short = client(() => ({ data: [row(1)], error: null }), calls2);
    const v2 = await loadInbox(short as never, "PKG", "all", { before: "2026-11-06T12:00:00.000Z", id: "m0" });
    expect(calls2[0]).toEqual(["inbox_messages", { p_lane: "PKG", p_filter: "all", p_limit: PAGE_SIZE, p_before: "2026-11-06T12:00:00.000Z", p_before_id: "m0" }]);
    expect(v2.next).toBeNull();
  });

  it("an outage is 'unavailable', not an empty inbox", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const g = { requireLane: async () => ({ client: client(() => ({ data: null, error: { message: "x" } })) }) as never };
    expect(await inboxFor(g, "PKG", {})).toEqual({ filter: "all", rows: [], next: null, unavailable: true });
  });
});

describe("openMessage", () => {
  const ref = { connection_id: "00000000-0000-4000-8000-000000000001", provider: "google", from_name: "Ann", from_address: "ann@example.test", to_recipients: [{ address: "me@example.test", name: "Me" }], cc_recipients: [], subject: "Hello", received_at: "2026-11-06T12:00:00Z", source_url: "https://mail.google.com/mail/u/x/#all/1", thread_id: "18c2f0a1b2c3d4e5" };
  const coverage = [{ stream: "mail", account: "robert@pubk.test", connection_id: ref.connection_id, provider: "google", status: "ok", configured: true, last_sync_at: "2026-11-06T12:00:00Z" }];
  /** Answers the message ref and the Coverage read (which names the mailbox). */
  const both = (cov: unknown = coverage) => client((fn) => (fn === "briefing_coverage" ? { data: cov, error: null } : { data: [ref], error: null }));

  it("a malformed id never reaches the database or Google", async () => {
    const calls: unknown[] = [];
    const read = vi.fn();
    expect(await openMessage(client(() => ({ data: [ref], error: null }), calls) as never, "PKG", "../x", read)).toEqual({ state: "not_found" });
    expect(calls).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it("a message the user may not see (no row under RLS) is not_found and Google is never called", async () => {
    const read = vi.fn();
    expect(await openMessage(client(() => ({ data: [], error: null })) as never, "PKG", "m1", read)).toEqual({ state: "not_found" });
    expect(read).not.toHaveBeenCalled();
  });

  it("reads the body live for the connection the visible row names", async () => {
    const read = vi.fn(async () => ({ text: "Body text", truncated: false }));
    const view = await openMessage(client(() => ({ data: [ref], error: null })) as never, "PKG", "m1", read);
    expect(read).toHaveBeenCalledWith("PKG", ref.connection_id, "m1");
    expect(view).toMatchObject({ state: "ok", text: "Body text", meta: { subject: "Hello", to: ["Me <me@example.test>"] } });
  });

  it("Open in Gmail is built from the mailbox and the thread id (authuser, encoded), never from the stored URL", async () => {
    const read = vi.fn(async () => ({ text: "x", truncated: false }));
    const view = await openMessage(both() as never, "PKG", "m1", read);
    expect(view).toMatchObject({ meta: { mailbox: "robert@pubk.test", gmailUrl: "https://mail.google.com/mail/?authuser=robert%40pubk.test#all/18c2f0a1b2c3d4e5" } });
  });

  it("no Gmail link without a usable thread id, or when the mailbox cannot be told; the message still opens", async () => {
    const read = vi.fn(async () => ({ text: "x", truncated: false }));
    const odd = client((fn) => (fn === "briefing_coverage" ? { data: coverage, error: null } : { data: [{ ...ref, thread_id: "../#x" }], error: null }));
    expect(await openMessage(odd as never, "PKG", "m1", read)).toMatchObject({ state: "ok", meta: { gmailUrl: null, mailbox: "robert@pubk.test" } });
    expect(await openMessage(both([]) as never, "PKG", "m1", read)).toMatchObject({ state: "ok", meta: { gmailUrl: null, mailbox: null } });
    const down = client((fn) => (fn === "briefing_coverage" ? { data: null, error: { message: "x" } } : { data: [ref], error: null }));
    expect(await openMessage(down as never, "PKG", "m1", read)).toMatchObject({ state: "ok", meta: { gmailUrl: null } });
  });

  it("another connection's mailbox is never used", async () => {
    const read = vi.fn(async () => ({ text: "x", truncated: false }));
    const other = [{ ...coverage[0], connection_id: "00000000-0000-4000-8000-000000000002" }];
    expect(await openMessage(both(other) as never, "PKG", "m1", read)).toMatchObject({ meta: { mailbox: null, gmailUrl: null } });
  });

  it("a row from another provider is not_found", async () => {
    const read = vi.fn();
    expect(await openMessage(client(() => ({ data: [{ ...ref, provider: "microsoft" }], error: null })) as never, "PKG", "m1", read)).toEqual({ state: "not_found" });
    expect(read).not.toHaveBeenCalled();
  });

  it("spoofing characters are removed from subject and text", async () => {
    const read = vi.fn(async () => ({ text: "Pay \u202Etxt.exe\u202C now\u0007\n\tok", truncated: false }));
    const view = await openMessage(client(() => ({ data: [{ ...ref, subject: "Re\u2066: hi", source_url: "https://evil.example.test/x" }], error: null })) as never, "PKG", "m1", read);
    expect(view).toMatchObject({ state: "ok", text: "Pay txt.exe now\n\tok", meta: { subject: "Re: hi" } });
    expect(displayText("a\u200Fb")).toBe("ab");
  });

  it("a Google failure keeps the header, says why, and logs only the error kind", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fail = (kind: string) => vi.fn(async () => { throw Object.assign(new Error("secret body text"), { info: { kind } }); });
    const c = client(() => ({ data: [ref], error: null }));
    expect(await openMessage(c as never, "PKG", "m1", fail("reconnect_required"))).toMatchObject({ state: "body_unavailable", reason: "reconnect", meta: { subject: "Hello" } });
    expect(await openMessage(c as never, "PKG", "m1", fail("not_found"))).toMatchObject({ state: "body_unavailable", reason: "gone" });
    expect(await openMessage(c as never, "PKG", "m1", fail("transient"))).toMatchObject({ state: "body_unavailable", reason: "error" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret body text");
  });
});

describe("T-240: ?view=waiting (Still waiting)", () => {
  const g = (laneCalls: string[] = []) => ({ requireLane: async (l: string) => (laneCalls.push(l), { client: {} as never }) }) as never;
  const thread = (id: string, over: Record<string, unknown> = {}) => ({ key: `c:${id}`, kind: "waiting", flags: {}, reason: "r", thread: { connectionId: "c", threadKey: id, messageId: id, fromAddress: "a@x.test", fromName: "Ann", subject: `S ${id}`, receivedAt: "2026-11-01T12:00:00.000Z", isImportant: false, unreadCount: 0, ...over } });
  const view = (over: Record<string, unknown>) => (async () => ({ config: { attention: { fresh_hours: 48 } }, ...over })) as never;
  it("is on only for view=waiting", () => {
    expect(isWaitingView({ view: "waiting" })).toBe(true);
    expect(isWaitingView({ view: "other" })).toBe(false);
    expect(isWaitingView({ view: ["waiting"] })).toBe(false);
    expect(isWaitingView({ filter: "unread" })).toBe(false);
  });
  it("lists the still-waiting threads of the lane as rows (metadata only), skipping unusable ids", async () => {
    const lanes: string[] = [];
    const out = await waitingFor(g(lanes), "PKG", new Date("2026-11-13T12:00:00Z"), view({ mail: { access: true, stillWaiting: [thread("m1"), thread("../bad"), thread("m2", { unreadCount: 2 })] } }));
    expect(lanes).toEqual(["PKG"]);
    expect(out.freshHours).toBe(48);
    expect(out.rows.map((r) => [r.messageId, r.isRead, r.subject])).toEqual([["m1", true, "S m1"], ["m2", false, "S m2"]]);
    expect(Object.keys(out.rows[0] ?? {}).sort()).toEqual(["fromAddress", "fromName", "hasAttachments", "isImportant", "isRead", "isStarred", "messageId", "receivedAt", "subject"]);
  });
  it("no mail access: no rows; an outage says unavailable", async () => {
    expect((await waitingFor(g(), "PKG", new Date(), view({ mail: { access: false } }))).rows).toEqual([]);
    expect((await waitingFor(g(), "PKG", new Date(), view({ mail: { access: false, unavailable: true } }))).unavailable).toBe(true);
  });
});
