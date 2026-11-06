import { afterEach, describe, expect, it, vi } from "vitest";
import { displayText, inboxFor, loadInbox, openMessage, parseInboxQuery, PAGE_SIZE, toRows } from "./inbox";

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
  const ref = { connection_id: "00000000-0000-4000-8000-000000000001", provider: "google", from_name: "Ann", from_address: "ann@example.test", to_recipients: [{ address: "me@example.test", name: "Me" }], cc_recipients: [], subject: "Hello", received_at: "2026-11-06T12:00:00Z", source_url: "https://mail.google.com/mail/u/x/#all/1" };

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
    expect(view).toMatchObject({ state: "ok", text: "Body text", meta: { subject: "Hello", to: ["Me <me@example.test>"], sourceUrl: ref.source_url } });
  });

  it("a row from another provider is not_found", async () => {
    const read = vi.fn();
    expect(await openMessage(client(() => ({ data: [{ ...ref, provider: "microsoft" }], error: null })) as never, "PKG", "m1", read)).toEqual({ state: "not_found" });
    expect(read).not.toHaveBeenCalled();
  });

  it("'Open in Gmail' only links to Gmail; spoofing characters are removed from subject and text", async () => {
    const read = vi.fn(async () => ({ text: "Pay \u202Etxt.exe\u202C now\u0007\n\tok", truncated: false }));
    const view = await openMessage(client(() => ({ data: [{ ...ref, subject: "Re\u2066: hi", source_url: "https://evil.example.test/x" }], error: null })) as never, "PKG", "m1", read);
    expect(view).toMatchObject({ state: "ok", text: "Pay txt.exe now\n\tok", meta: { subject: "Re: hi", sourceUrl: null } });
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
