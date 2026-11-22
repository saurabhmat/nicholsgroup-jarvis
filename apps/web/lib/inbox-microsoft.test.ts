// T-260: the Inbox list and one message for a person with a Microsoft mailbox, alone or beside a Google one. Synthetic rows shaped like what core.inbox_messages,
// core.inbox_message_ref and core.briefing_coverage return (SQL and RLS: pgTAP 319 and 322 own the "each user sees only their own" rows; here the readers are
// handed what the database would answer for one user). Google-only output must not change.
import { describe, expect, it, vi } from "vitest";
import { isMessageId, loadInbox, openMessage, toRows, waitingFor } from "./inbox";

type Result = { data: unknown; error: unknown };
const client = (handler: (fn: string) => Result, calls: string[] = []) => ({ schema: () => ({ rpc: (fn: string) => (calls.push(fn), Promise.resolve(handler(fn))) }) });

const G = "00000000-0000-4000-8000-0000000c2601"; // the person's Google mailbox
const M = "00000000-0000-4000-8000-0000000c2602"; // the same person's Microsoft mailbox
const GRAPH_ID = `AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A${"x".repeat(110)}=`; // a Graph immutable id: long, with a trailing '='
const GMAIL_URL = "https://mail.google.com/mail/?authuser=robert%40pubk.example.test#all/18c2f0a1b2c3d4e5";
const OUTLOOK_URL = "https://outlook.office365.com/owa/?ItemID=synthetic-1&exvsurl=1&viewmodel=ReadMessageItem";

const row = (id: string, connection: string, over: Record<string, unknown> = {}) => ({
  message_id: id, connection_id: connection, thread_id: `t-${id.slice(0, 8)}`, from_name: "Ann", from_address: "ann@acme.example.test", subject: "Quarterly plan",
  received_at: "2026-11-20T12:00:00Z", is_read: false, is_important: false, is_starred: false, has_attachments: false, source_url: null, ...over,
});
const cov = (provider: string, connection: string, account: string) => ({ stream: "mail", account, connection_id: connection, provider, status: "active", configured: true, last_sync_at: "2026-11-20T12:00:00Z", error_kind: null });
const covBoth = [cov("google", G, "robert@pubk.example.test"), cov("microsoft", M, "robert@pubkgroup.example.test")];

describe("message ids (T-260)", () => {
  it("accept a Graph immutable id (long, with '='), and still refuse anything that could change a path or a query", () => {
    expect(isMessageId(GRAPH_ID)).toBe(true);
    expect(isMessageId("18f0a1b2c3")).toBe(true);
    for (const bad of ["a/b", "a\\b", "a%2Fb", "a?b", "a#b", "..", ".", "", " x", "x".repeat(513), "a b", "a\nb"]) expect(isMessageId(bad)).toBe(false);
  });
});

describe("Inbox list for one person with a Google and a Microsoft mailbox", () => {
  const data = [
    row("gmail-1", G, { source_url: GMAIL_URL, subject: "Same message" }),
    row(GRAPH_ID, M, { source_url: OUTLOOK_URL, subject: "Same message", received_at: "2026-11-20T11:00:00Z" }),
    row("gmail-2", G, { source_url: GMAIL_URL, subject: "Only in Gmail", received_at: "2026-11-20T10:00:00Z" }),
  ];
  const view = async (coverage: unknown = covBoth) => loadInbox(client((fn) => (fn === "briefing_coverage" ? { data: coverage, error: null } : { data, error: null })) as never, "PKG", "all", null);

  it("shows both mailboxes in one list, each row with its provider and account and its own 'Open in' link; the same message in both is two rows", async () => {
    const v = await view();
    expect(v.rows.map((r) => r.messageId)).toEqual(["gmail-1", GRAPH_ID, "gmail-2"]);
    expect(v.rows.map((r) => r.source)).toEqual([
      { provider: "google", label: "Gmail · robert@pubk.example.test", openLabel: "Open in Gmail", openUrl: GMAIL_URL },
      { provider: "microsoft", label: "Outlook · robert@pubkgroup.example.test", openLabel: "Open in Outlook", openUrl: OUTLOOK_URL },
      { provider: "google", label: "Gmail · robert@pubk.example.test", openLabel: "Open in Gmail", openUrl: GMAIL_URL },
    ]);
    expect(v.rows.filter((r) => r.subject === "Same message")).toHaveLength(2); // no de-duplication across providers (D-58 default)
  });

  it("a link that is not https, or has credentials, is never rendered; the label stays", async () => {
    const v = await loadInbox(client((fn) => (fn === "briefing_coverage" ? { data: covBoth, error: null } : { data: [row("m-1", M, { source_url: "javascript:alert(1)" }), row("m-2", M, { source_url: "https://user:pw@outlook.office365.com/x" })], error: null })) as never, "PKG", "all", null);
    expect(v.rows.map((r) => r.source?.openUrl)).toEqual([null, null]);
    expect(v.rows.every((r) => r.source?.label.startsWith("Outlook"))).toBe(true);
  });

  it("a connection Coverage does not list (not this person's, or unknown) gets no label and no link: another person's address never appears", async () => {
    const other = "00000000-0000-4000-8000-0000000c2699";
    const v = await view([cov("microsoft", other, "someone.else@pubkgroup.example.test")]);
    for (const r of v.rows) expect(r.source).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain("someone.else");
  });

  it("a Coverage outage leaves the rows (unlabelled) rather than failing the list", async () => {
    const v = await loadInbox(client((fn) => (fn === "briefing_coverage" ? { data: null, error: { message: "x" } } : { data, error: null })) as never, "PKG", "all", null);
    expect(v.rows).toHaveLength(3);
    for (const r of v.rows) expect(r.source).toBeUndefined();
  });
});

describe("a Google-only person: the list is exactly what it was (no label key, no extra request beyond Coverage)", () => {
  it("rows carry no `source`, with Coverage showing only Google", async () => {
    const calls: string[] = [];
    const v = await loadInbox(client((fn) => (fn === "briefing_coverage" ? { data: [cov("google", G, "robert@pubk.example.test")], error: null } : { data: [row("gmail-1", G, { source_url: GMAIL_URL })], error: null }), calls) as never, "PKG", "all", null);
    expect(Object.keys(v.rows[0] ?? {}).sort()).toEqual(["fromAddress", "fromName", "hasAttachments", "isImportant", "isRead", "isStarred", "messageId", "receivedAt", "subject"]);
    expect(calls).toEqual(["inbox_messages", "briefing_coverage"]);
  });
  it("toRows without tags is unchanged", () => {
    expect(Object.keys(toRows([row("gmail-1", G)])[0] ?? {})).not.toContain("source");
  });
});

describe("opening a Microsoft message (T-260)", () => {
  const ref = { message_id: GRAPH_ID, connection_id: M, provider: "microsoft", from_name: "Ann", from_address: "ann@acme.example.test", to_recipients: [{ address: "robert@pubkgroup.example.test", name: "Robert" }], cc_recipients: [], subject: "Quarterly plan", received_at: "2026-11-20T12:00:00Z", source_url: OUTLOOK_URL, thread_id: "conv-1" };
  const both = (data: unknown[] = [ref]) => client((fn) => (fn === "briefing_coverage" ? { data: covBoth, error: null } : { data, error: null }));

  it("reads the body through the injected reader (the facade, with the owner) using the row's own connection, and offers 'Open in Outlook' from the row's link, never a Gmail link", async () => {
    const read = vi.fn(async () => ({ text: "Plain body", truncated: false }));
    const v = await openMessage(both() as never, "PKG", GRAPH_ID, read);
    expect(read).toHaveBeenCalledWith("PKG", M, GRAPH_ID);
    expect(v).toMatchObject({ state: "ok", text: "Plain body", meta: { provider: "microsoft", mailbox: "robert@pubkgroup.example.test", gmailUrl: null, openUrl: OUTLOOK_URL, openLabel: "Open in Outlook" } });
  });

  it("a message the person may not see (the database returns no row: another user's mailbox, another lane) is not_found and nothing is read", async () => {
    const read = vi.fn();
    expect(await openMessage(both([]) as never, "PKG", GRAPH_ID, read)).toEqual({ state: "not_found" });
    expect(read).not.toHaveBeenCalled();
  });

  it("a reader that refuses (another owner, a paused provider) gives a body_unavailable state, never an error page; only the error kind is logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refuse = (kind: string) => async () => { throw Object.assign(new Error("The mailbox text SECRET-BODY"), { info: { kind } }); };
    expect(await openMessage(both() as never, "PKG", GRAPH_ID, refuse("forbidden"))).toMatchObject({ state: "body_unavailable", reason: "reconnect" });
    expect(await openMessage(both() as never, "PKG", GRAPH_ID, refuse("connection_unavailable"))).toMatchObject({ state: "body_unavailable", reason: "error" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET-BODY");
    log.mockRestore();
  });

  it("a Google row opens exactly as before (authuser link from the mailbox and thread id; label 'Open in Gmail')", async () => {
    const g = { ...ref, message_id: "gmail-1", connection_id: G, provider: "google", thread_id: "18c2f0a1b2c3d4e5", source_url: "https://mail.google.com/mail/u/0/#all/x" };
    const v = await openMessage(both([g]) as never, "PKG", "gmail-1", vi.fn(async () => ({ text: "x", truncated: false })));
    expect(v).toMatchObject({ meta: { provider: "google", gmailUrl: GMAIL_URL, openUrl: GMAIL_URL, openLabel: "Open in Gmail" } });
  });
});

describe("the still-waiting list (T-260)", () => {
  const thread = (id: string, connectionId: string, url: string | null) => ({ thread: { messageId: id, connectionId, fromName: "A", fromAddress: "a@x.example.test", subject: "S", receivedAt: "2026-11-10T12:00:00Z", unreadCount: 1, isImportant: false, sourceUrl: url } });
  const g = { requireLane: async () => ({ client: {} as never }) } as never;
  it("labels its rows from the briefing view's tags, only when the viewer has a non-Google mailbox", async () => {
    const mail = (sourceOf?: Record<string, { provider: string; account: string }>) => ({ config: { attention: { fresh_hours: 48 } }, mail: { access: true, stillWaiting: [thread("g-1", G, GMAIL_URL), thread(GRAPH_ID, M, OUTLOOK_URL)], ...(sourceOf ? { sourceOf } : {}) } }) as never;
    const labelled = await waitingFor(g, "PKG", new Date(), async () => mail({ [G]: { provider: "google", account: "a@pubk.example.test" }, [M]: { provider: "microsoft", account: "b@pubkgroup.example.test" } }));
    expect(labelled.rows.map((r) => r.source?.openLabel)).toEqual(["Open in Gmail", "Open in Outlook"]);
    const plain = await waitingFor(g, "PKG", new Date(), async () => mail());
    expect(plain.rows.every((r) => r.source === undefined)).toBe(true);
  });
});
