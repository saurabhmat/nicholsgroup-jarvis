// Microsoft header flags (T-259, spec §8.4) over the fake Graph (MSW) and in-memory twins. Synthetic data only (rule 10).
// What is proved: for the INBOX messages of a sync page one single-message read each (`$select=internetMessageHeaders`), classified by the shared
// `mail-flags` rules; only booleans are stored and a header name or value is in no write, row, log line, error or cursor; the per-page and per-window
// bounds; a failed read for one message does not fail the page, a refusal of ours does; `is_auth_pass` is false whatever the headers say;
// `is_calendar` also comes from `eventMessage`. Time moves by a variable the test sets, never by a sleep.
import { afterEach, describe, expect, it } from "vitest";
import { isConnectorError } from "../contract/errors";
import { RateLimiter } from "../http/rate-limit";
import { createMicrosoftMailHarness, MAIL_DOMAIN, type MicrosoftMailHarnessOptions } from "../testing/microsoft-mail-harness";
import { TENANT_A } from "../testing/microsoft-harness";
import { FAKE_NOW } from "../testing/msw/microsoft/mail";
import { HttpResponse, http, useMockServer } from "../testing/msw/index";
import { createFakeMicrosoft, GRAPH_V1, MICROSOFT_ERROR_TEXT_CANARY } from "../testing/msw/microsoft/handlers";
import { createFakeMail, MAIL_BODY_CANARY, type FakeMailOptions } from "../testing/msw/microsoft/mail";
import { createHeaderBudget, EVENT_MESSAGE_TYPE, flagsFromAnswer, HEADER_PAGE_DEADLINE_MS, HEADER_READ_TIMEOUT_MS, HEADER_READS_PER_WINDOW } from "./mail-headers";

const HEADER_CANARY = "synthetic-header-canary-77e1-not-real";
const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
});

function setup(harness: Partial<MicrosoftMailHarnessOptions> = {}, mailOptions: FakeMailOptions = {}) {
  const fake = createFakeMicrosoft();
  const mail = createFakeMail(fake, mailOptions);
  server.use(...fake.handlers, ...mail.handlers);
  const clock = { now: FAKE_NOW };
  const m = createMicrosoftMailHarness({ fake, mail, headerFlags: {}, providerNow: () => clock.now, ...harness });
  const made = m.connect("PKG");
  return { fake, mail, m, clock, ...made };
}
type Env = ReturnType<typeof setup>;
const answer = (headers: { name: string; value: string }[]) => ({ internetMessageHeaders: headers });
const surfaces = (env: Env) => JSON.stringify([env.m.twin.writes, [...env.m.twin.rows.values()], [...env.m.twin.cursors.values()], env.m.h.logs, env.m.h.apiErrors, env.m.h.reconnects]);
const rowOf = (env: Env, id: string) => env.m.twin.rowsOf(env.conn.id).find((r) => r.message_id === id);
const PERFECT_AUTH = "spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=sender.example.test; dkim=pass (signature was verified) header.d=sender.example.test;dmarc=pass action=none header.from=sender.example.test;compauth=pass reason=100";

describe("flagsFromAnswer: the existing mail-flags rules over a single-message answer", () => {
  it("bulk, auto-reply, generated and calendar from the standard headers", () => {
    expect(flagsFromAnswer(answer([{ name: "List-Unsubscribe", value: "<mailto:x@example.test>" }]))).toMatchObject({ is_bulk: true, is_auto: false, is_generated: false, is_calendar: false });
    expect(flagsFromAnswer(answer([{ name: "Precedence", value: "bulk" }]))).toMatchObject({ is_bulk: true });
    expect(flagsFromAnswer(answer([{ name: "Auto-Submitted", value: "auto-replied" }]))).toMatchObject({ is_auto: true, is_generated: false });
    expect(flagsFromAnswer(answer([{ name: "auto-submitted", value: "auto-generated" }]))).toMatchObject({ is_auto: false, is_generated: true });
    expect(flagsFromAnswer(answer([{ name: "Content-Type", value: 'text/calendar; method="REQUEST"' }]))).toMatchObject({ is_calendar: true });
    expect(flagsFromAnswer(answer([{ name: "Content-Class", value: "urn:content-classes:calendarmessage" }]))).toMatchObject({ is_calendar: true });
    expect(flagsFromAnswer(answer([{ name: "Subject", value: "hello" }]))).toEqual({ is_bulk: false, is_calendar: false, is_auto: false, is_generated: false, is_auth_pass: false });
  });
  it("an unusable answer gives no flags (null), never a guess; odd entries are skipped", () => {
    for (const a of [null, {}, { internetMessageHeaders: null }, { internetMessageHeaders: "x" }, "x", { internetMessageHeaders: new Array(1001).fill({ name: "a", value: "b" }) }]) expect(flagsFromAnswer(a)).toBeNull();
    expect(flagsFromAnswer({ internetMessageHeaders: [null, 3, { name: 5 }, { value: "x" }, { name: "List-Id", value: null }] })).toMatchObject({ is_bulk: true });
  });
  it("is_auth_pass is false for a perfect-looking Authentication-Results in every shape, because the header is never used for a pass", () => {
    const shapes = [PERFECT_AUTH, `mx.google.com; ${PERFECT_AUTH}`, `mail.protection.outlook.com; ${PERFECT_AUTH}`, `spf=pass; dkim=pass header.d=example.test; dmarc=pass header.from=example.test; compauth=pass`];
    for (const v of shapes) expect(flagsFromAnswer(answer([{ name: "Authentication-Results", value: v }]))?.is_auth_pass).toBe(false);
    expect(flagsFromAnswer(answer([{ name: "Authentication-Results", value: shapes[1] as string }, { name: "From", value: "a@sender.example.test" }]))?.is_auth_pass).toBe(false);
  });
});

describe("header flags through the mail sync", () => {
  it("one single-message read per INBOX message with $select=internetMessageHeaders and ImmutableId; sent items are not read", async () => {
    const env = setup();
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run).toMatchObject({ written: 5 });
    const reads = env.mail.messageRequests();
    expect(reads).toHaveLength(3); // the seed: 3 inbox, 2 sent
    for (const r of reads) {
      expect(r.method).toBe("GET");
      expect(r.search).toBe("?$select=internetMessageHeaders");
      expect(r.prefer).toBe('IdType="ImmutableId"');
    }
    const inboxIds = env.mail.messages(env.account, "inbox").map((x) => x.id).sort();
    expect(env.mail.messageReads.map((r) => r.id).sort()).toEqual(inboxIds);
  });

  it("the flags land on the rows (bulk, auto-reply, generated, calendar); the headers do not: only booleans are stored, and a header canary is in no write, row, log, error or cursor", async () => {
    const env = setup();
    const bulk = env.mail.add(env.account, "inbox", { id: "synthetic-bulk-1", headers: [{ name: "List-Unsubscribe", value: `<https://x.example.test/u?${HEADER_CANARY}>` }, { name: "X-Canary", value: HEADER_CANARY }] });
    const auto = env.mail.add(env.account, "inbox", { id: "synthetic-auto-1", headers: [{ name: "Auto-Submitted", value: `auto-replied; ${HEADER_CANARY}` }] });
    const gen = env.mail.add(env.account, "inbox", { id: "synthetic-gen-1", headers: [{ name: "Auto-Submitted", value: "auto-generated" }] });
    const cal = env.mail.add(env.account, "inbox", { id: "synthetic-cal-1", headers: [{ name: "Content-Type", value: `text/calendar; ${HEADER_CANARY}` }] });
    const plain = env.mail.add(env.account, "inbox", { id: "synthetic-plain-1", headers: [{ name: "Subject", value: HEADER_CANARY }] });
    await env.m.sync.run("PKG", env.conn);
    expect(rowOf(env, bulk)).toMatchObject({ is_bulk: true, is_auto: false, is_generated: false, is_calendar: false, is_auth_pass: false });
    expect(rowOf(env, auto)).toMatchObject({ is_bulk: false, is_auto: true, is_generated: false });
    expect(rowOf(env, gen)).toMatchObject({ is_bulk: false, is_auto: false, is_generated: true });
    expect(rowOf(env, cal)).toMatchObject({ is_calendar: true });
    expect(rowOf(env, plain)).toMatchObject({ is_bulk: false, is_auto: false, is_generated: false, is_calendar: false, is_auth_pass: false });
    expect(surfaces(env)).not.toContain(HEADER_CANARY);
    expect(surfaces(env)).not.toMatch(/internetMessageHeaders|List-Unsubscribe|Auto-Submitted/i);
    for (const row of env.m.twin.rowsOf(env.conn.id)) {
      for (const f of ["is_bulk", "is_calendar", "is_auto", "is_generated", "is_auth_pass"] as const) expect(typeof row[f]).toBe("boolean");
      expect("internetMessageHeaders" in row).toBe(false);
    }
    // what the provider handed to the store carries booleans for the flags and nothing else new
    for (const w of env.m.twin.writes) if (w.store === "message_index") for (const u of (w.value as { upserts: Record<string, unknown>[] }).upserts) expect(Object.keys(u).filter((k) => /header/i.test(k))).toEqual([]);
  });

  it("is_auth_pass is FALSE for a message carrying a perfect-looking Authentication-Results (SPF, DKIM, DMARC and compauth all pass, aligned with the From domain)", async () => {
    const env = setup();
    const from = { address: "boss@sender.example.test", name: "Boss" };
    const ids = [PERFECT_AUTH, `mx.google.com; ${PERFECT_AUTH}`, `mail.protection.outlook.com; ${PERFECT_AUTH}`].map((value, i) =>
      env.mail.add(env.account, "inbox", { id: `synthetic-auth-${String(i)}`, from, headers: [{ name: "Authentication-Results", value }, { name: "From", value: "Boss <boss@sender.example.test>" }] }),
    );
    await env.m.sync.run("PKG", env.conn);
    for (const id of ids) expect(rowOf(env, id)?.is_auth_pass).toBe(false);
    for (const r of env.m.twin.rowsOf(env.conn.id)) expect(r.is_auth_pass).toBe(false);
    for (const w of env.m.twin.writes) if (w.store === "message_index") for (const u of (w.value as { upserts: { is_auth_pass?: boolean }[] }).upserts) expect(u.is_auth_pass === undefined || u.is_auth_pass === false).toBe(true);
  });

  it("is_calendar is true for an item whose @odata.type is eventMessage, even with no header read and no calendar header", async () => {
    const off = setup({ headerFlags: false });
    const ev = off.mail.add(off.account, "inbox", { id: "synthetic-event-1", odataType: EVENT_MESSAGE_TYPE });
    await off.m.sync.run("PKG", off.conn);
    expect(rowOf(off, ev)?.is_calendar).toBe(true);
    expect(off.mail.messageRequests()).toHaveLength(0);
    expect(off.m.twin.rowsOf(off.conn.id).filter((r) => r.is_calendar)).toHaveLength(1);
    // the same with the header read on: the header says nothing, the type still counts; a plain message stays false
    const on = setup();
    const ev2 = on.mail.add(on.account, "inbox", { id: "synthetic-event-2", odataType: EVENT_MESSAGE_TYPE, headers: [{ name: "Subject", value: "x" }] });
    await on.m.sync.run("PKG", on.conn);
    expect(rowOf(on, ev2)?.is_calendar).toBe(true);
    expect(on.m.twin.rowsOf(on.conn.id).filter((r) => r.is_calendar)).toHaveLength(1);
    // an eventMessage in the sent folder is marked too (no request is needed for that)
    const sent = on.mail.add(on.account, "sentitems", { id: "synthetic-event-sent", odataType: EVENT_MESSAGE_TYPE });
    await on.m.sync.run("PKG", on.conn);
    expect(rowOf(on, sent)?.is_calendar).toBe(true);
  });

  it("a page of 100 inbox messages gets 100 header reads when the budget allows: the per-page cap is the page size, so a first load flags the whole page", async () => {
    const env = setup();
    for (let i = 0; i < 97; i++) env.mail.add(env.account, "inbox", { id: `synthetic-page-${String(i)}`, ageDays: 0.1 + i / 100, headers: [{ name: "List-Id", value: "<l.example.test>" }] });
    expect(env.mail.messages(env.account, "inbox")).toHaveLength(100);
    await env.m.sync.run("PKG", env.conn);
    expect(env.mail.messageReads).toHaveLength(100);
    expect(env.m.twin.rowsOf(env.conn.id).filter((r) => r.folder === "INBOX" && r.is_bulk)).toHaveLength(97); // the 3 seeded ones carry no List-Id
  });

  it("the cap follows the page size: with a page size of 10 every one of 28 inbox messages is read, page by page, and the oldest are not left out", async () => {
    const env = setup({ pageSize: 10 });
    for (let i = 0; i < 25; i++) env.mail.add(env.account, "inbox", { id: `synthetic-small-${String(i)}`, ageDays: 0.1 + i / 100 });
    await env.m.sync.run("PKG", env.conn);
    expect(env.mail.messageReads).toHaveLength(28);
    expect(new Set(env.mail.messageReads.map((r) => r.id)).size).toBe(28);
  });

  it("over the window budget the NEWEST are read; the others are indexed without flags (false), never guessed", async () => {
    const env = setup({ headerFlags: { perWindow: 2 } });
    const list = { name: "List-Id", value: "<list.example.test>" };
    const newest = env.mail.add(env.account, "inbox", { id: "synthetic-new-1", ageDays: 0, headers: [list] });
    const second = env.mail.add(env.account, "inbox", { id: "synthetic-new-2", ageDays: 0.5, headers: [list] });
    const older = env.mail.add(env.account, "inbox", { id: "synthetic-old-1", ageDays: 6, headers: [list] });
    await env.m.sync.run("PKG", env.conn);
    const reads = env.mail.messageReads.map((r) => r.id);
    expect(reads).toHaveLength(2);
    expect(reads.sort()).toEqual([newest, second].sort());
    expect(rowOf(env, older)?.is_bulk).toBe(false);
    expect(rowOf(env, newest)?.is_bulk).toBe(true);
  });

  it("the per-window bound: a large first load cannot multiply requests; the budget is per connection and opens again when the window has passed", async () => {
    const env = setup({ headerFlags: { perWindow: 4 }, pageSize: 100 });
    for (let i = 0; i < 12; i++) env.mail.add(env.account, "inbox", { id: `synthetic-bulkload-${String(i)}`, ageDays: i / 100, headers: [{ name: "List-Id", value: "<l.example.test>" }] });
    await env.m.sync.run("PKG", env.conn);
    expect(env.mail.messageReads).toHaveLength(4);
    expect(env.m.twin.rowsOf(env.conn.id).filter((r) => r.is_bulk)).toHaveLength(4);
    // a second connection has its own budget
    const other = env.m.connect("PKG");
    await env.m.sync.run("PKG", other.conn);
    expect(env.mail.messageReads).toHaveLength(4 + 3);
    // a change to an over-bound message in the SAME window is not read again; its stored flags stay as they were
    const flagged = env.m.twin.rowsOf(env.conn.id).find((r) => r.is_bulk)?.message_id as string;
    env.mail.change(env.account, "inbox", flagged, { isRead: true });
    await env.m.sync.run("PKG", env.conn);
    expect(env.mail.messageReads).toHaveLength(7);
    expect(rowOf(env, flagged)).toMatchObject({ is_read: true, is_bulk: true }); // absent flags keep the stored value on update
    // the window passes: the next change is read
    env.clock.now += 10 * 60_000;
    env.mail.change(env.account, "inbox", flagged, { isRead: false });
    await env.m.sync.run("PKG", env.conn);
    expect(env.mail.messageReads).toHaveLength(8);
    expect(rowOf(env, flagged)).toMatchObject({ is_read: false, is_bulk: true });
  });

  it("a header read that fails for one message does not fail the page: 404 leaves that message without flags and the others are read", async () => {
    const env = setup();
    const gone = env.mail.add(env.account, "inbox", { id: "synthetic-gone-1", headers: [{ name: "List-Id", value: "<l.example.test>" }] });
    const fine = env.mail.add(env.account, "inbox", { id: "synthetic-fine-1", headers: [{ name: "List-Id", value: "<l.example.test>" }] });
    env.mail.failMessage(gone, 404);
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run).toMatchObject({ written: 7 }); // the 5 of the seed and the 2 added
    expect(rowOf(env, gone)).toMatchObject({ is_bulk: false });
    expect(rowOf(env, fine)).toMatchObject({ is_bulk: true });
    expect(env.m.twin.cursorOf("PKG", env.conn.id)).toBeDefined();
  });

  it("Graph unavailable (5xx) or throttled on a header read: the rest of that page is left without flags and the page is still applied", async () => {
    for (const status of [500, 503, 429, 403]) {
      const env = setup();
      const bad = env.mail.add(env.account, "inbox", { id: `synthetic-bad-${String(status)}`, ageDays: 0, headers: [{ name: "List-Id", value: "<l.example.test>" }] });
      env.mail.failMessage(bad, status);
      const run = await env.m.sync.run("PKG", env.conn);
      expect(run, String(status)).toMatchObject({ written: 6, conflict: false });
      expect(rowOf(env, bad)?.is_bulk, String(status)).toBe(false);
      expect(env.m.twin.cursorOf("PKG", env.conn.id)).toBeDefined();
      expect(surfaces(env)).not.toContain(MICROSOFT_ERROR_TEXT_CANARY);
    }
  });

  it("an answer that is not a header list leaves the message without flags", async () => {
    const env = setup();
    const odd = env.mail.add(env.account, "inbox", { id: "synthetic-odd-1", headers: "nope" as never });
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run).toMatchObject({ written: 6 });
    expect(rowOf(env, odd)).toMatchObject({ is_bulk: false, is_auth_pass: false });
  });

  it.each([
    ["reconnect required", (env: Env) => {
      (env.m.h.rows.get(env.conn.id) as { status: string }).status = "reconnect_required";
    }, "reconnect_required"],
    ["Microsoft switched off for the lane", (env: Env) => env.m.h.setLane("PKG", { providers: ["google"] }), "connection_unavailable"],
  ])("a refusal the sync must stop on (%s) fails the page: nothing is applied and the cursor does not advance", async (_name, act, kind) => {
    const env = setup({ pageSize: 100 });
    for (let i = 0; i < 12; i++) env.mail.add(env.account, "inbox", { id: `synthetic-many-${String(i)}` }); // more reads than the 4 in flight at once
    let first = true;
    env.mail.onMessageRead = () => {
      if (first) {
        first = false;
        act(env); // after the first header read the world changes: the guard refuses the next one
      }
    };
    let error: unknown;
    try {
      await env.m.sync.run("PKG", env.conn);
    } catch (e) {
      error = e;
    }
    expect(isConnectorError(error) && error.info.kind).toBe(kind);
    expect(env.m.twin.writes).toHaveLength(0);
    expect(env.m.twin.cursorOf("PKG", env.conn.id)).toBeUndefined();
    expect(env.m.twin.rowsOf(env.conn.id)).toHaveLength(0);
  });

  it("the token canary: no token in a log, error, row, cursor or write through header reads, a failed read and a refresh", async () => {
    const env = setup();
    const bad = env.mail.add(env.account, "inbox", { id: "synthetic-tok-1" });
    env.mail.failMessage(bad, 500);
    env.m.h.expireStoredAccess(env.conn.id);
    await env.m.sync.run("PKG", env.conn);
    const tokens = new Set<string>();
    for (const a of env.fake.accounts.values()) for (const t of [...a.accessTokens, ...a.refreshTokens]) tokens.add(t);
    const stored = env.m.h.storedSet(env.conn.id);
    for (const k of ["access_token", "refresh_token"]) if (typeof stored?.[k] === "string") tokens.add(stored[k] as string);
    expect(tokens.size).toBeGreaterThan(2);
    for (const t of tokens) expect(surfaces(env), "a token reached a surface").not.toContain(t);
    expect(surfaces(env)).not.toContain(MAIL_BODY_CANARY);
    expect(env.m.contentWriteCount()).toBe(0);
  });
});

describe("the header read budget", () => {
  it("grants up to the window limit per lane and connection and starts a new window when it has passed (an injected clock, no sleeping)", () => {
    let now = 1_000;
    const budget = createHeaderBudget(() => now, 5, 1000);
    expect(budget.take("PKG", "a", 3)).toBe(3);
    expect(budget.take("PKG", "a", 3)).toBe(2);
    expect(budget.take("PKG", "a", 1)).toBe(0);
    expect(budget.take("PKG", "b", 4)).toBe(4);
    expect(budget.take("APK", "a", 4)).toBe(4); // the key is the lane AND the connection
    now += 999;
    expect(budget.take("PKG", "a", 1)).toBe(0);
    now += 1;
    expect(budget.take("PKG", "a", 9)).toBe(5);
    expect(HEADER_READS_PER_WINDOW).toBeGreaterThan(0);
  });
  it("a full table with nothing expired grants zero (it never grows); expired entries make room; a refund gives reads back", () => {
    let now = 0;
    const budget = createHeaderBudget(() => now, 10, 1000, 2);
    expect(budget.take("PKG", "a", 1)).toBe(1);
    expect(budget.take("PKG", "b", 1)).toBe(1);
    expect(budget.take("PKG", "c", 1)).toBe(0);
    expect(budget.take("PKG", "a", 1)).toBe(1); // a known key still works
    now += 1000;
    expect(budget.take("PKG", "c", 1)).toBe(1); // the expired entries made room
    expect(budget.take("PKG", "c", 20)).toBe(9);
    budget.refund("PKG", "c", 4);
    expect(budget.take("PKG", "c", 20)).toBe(4);
    budget.refund("PKG", "unknown", 3); // nothing to give back to: no effect, no growth
    expect(budget.take("PKG", "d", 1)).toBe(1);
    expect(budget.take("PKG", "zzz", 1)).toBe(0); // the table (2 entries) is full again
    expect(budget.take("APK", "c", 1)).toBe(0); // the same connection id in another lane is another key, and there is no room for it
  });
});

describe("header reads are bounded in time (a slow read, the page deadline)", () => {
  it("a slow read hits the per-read timeout with no retry; the page is still applied and that message has no flags", async () => {
    const env = setup({ headerReadTimeoutMs: 30 });
    const slow = env.mail.add(env.account, "inbox", { id: "synthetic-slow-1", headers: [{ name: "List-Id", value: "<l.example.test>" }] });
    env.mail.slowMessage(slow, 1500);
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run).toMatchObject({ written: 6, conflict: false });
    expect(env.mail.messageReads.filter((r) => r.id === slow)).toHaveLength(1); // one attempt: no retry
    expect(rowOf(env, slow)).toMatchObject({ is_bulk: false });
    expect(env.m.twin.cursorOf("PKG", env.conn.id)).toBeDefined();
    expect(HEADER_READ_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("the page deadline (injected clock) skips the remaining reads like a stop: the page is applied, the skipped ones are indexed without flags, and their budget is given back", async () => {
    const env = setup({ headerFlags: { perWindow: 13 } });
    for (let i = 0; i < 10; i++) env.mail.add(env.account, "inbox", { id: `synthetic-late-${String(i)}`, ageDays: 0.1 + i / 100, headers: [{ name: "List-Id", value: "<l.example.test>" }] });
    env.mail.onMessageRead = () => {
      env.clock.now += HEADER_PAGE_DEADLINE_MS; // the first read "takes" the whole deadline on the injected clock
    };
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run).toMatchObject({ written: 15, conflict: false });
    expect(env.mail.messageReads).toHaveLength(4); // the four in flight at once; the deadline passed before any other started
    expect(env.m.twin.rowsOf(env.conn.id).filter((r) => r.is_bulk)).toHaveLength(4);
    // 13 were granted, 4 started: the other 9 went back, so a later change is read (without the refund the budget would be empty)
    env.mail.onMessageRead = null;
    const unflagged = env.m.twin.rowsOf(env.conn.id).find((r) => r.folder === "INBOX" && !r.is_bulk && r.message_id.startsWith("synthetic-late-"))?.message_id as string;
    env.mail.change(env.account, "inbox", unflagged, { isRead: true });
    await env.m.sync.run("PKG", env.conn);
    expect(env.mail.messageReads).toHaveLength(5);
    expect(rowOf(env, unflagged)).toMatchObject({ is_read: true, is_bulk: true });
    expect(HEADER_PAGE_DEADLINE_MS).toBeGreaterThan(0);
  });

  it("the Graph client takes a per-call timeout and no-retry option, and refuses a timeout that is not allowed before any token read", async () => {
    const env = setup();
    const tokens = env.m.h.stats.tokenReads;
    for (const timeoutMs of [0, -1, 1.5, 60_001]) await expect(env.m.api.get("PKG", env.conn, "/me/messages/{id}", { id: "x" }, undefined, { timeoutMs })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(env.m.h.stats.tokenReads).toBe(tokens);
  });
});

describe("a header read that fails in another way", () => {
  it("an answer that is not JSON (a 200) for ONE message is a soft failure: that message has no flags, the others are read, the page is applied, and the next run does not meet it again as an error", async () => {
    const env = setup();
    const odd = env.mail.add(env.account, "inbox", { id: "synthetic-nonjson-1", ageDays: 0, headers: [{ name: "List-Id", value: "<l.example.test>" }] });
    const fine = env.mail.add(env.account, "inbox", { id: "synthetic-nonjson-2", ageDays: 0.2, headers: [{ name: "List-Id", value: "<l.example.test>" }] });
    server.use(http.get(`${GRAPH_V1}/me/messages/:id`, ({ params }) => (params.id === odd ? new HttpResponse("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }) : undefined)));
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run).toMatchObject({ written: 7, conflict: false });
    expect(rowOf(env, odd)).toMatchObject({ is_bulk: false });
    expect(rowOf(env, fine)).toMatchObject({ is_bulk: true });
    env.mail.change(env.account, "inbox", odd, { isRead: true });
    await expect(env.m.sync.run("PKG", env.conn)).resolves.toMatchObject({ conflict: false });
    expect(rowOf(env, odd)).toMatchObject({ is_read: true });
  });
});

describe("a refused page costs no header read", () => {
  it("a link Graph returns that cannot be used (another host), and one too long for the cursor: the page is refused and no single-message read was made", async () => {
    const evil = setup({}, { rewriteLink: () => "https://evil.example.test/x?$deltatoken=1" });
    await expect(evil.m.sync.run("PKG", evil.conn)).rejects.toMatchObject({ info: { kind: "provider_error" } });
    expect(evil.mail.messageReads).toHaveLength(0);
    expect(evil.m.twin.writes).toHaveLength(0);
    const long = setup({}, { tokenPad: 3000 });
    await expect(long.m.sync.run("PKG", long.conn)).rejects.toMatchObject({ info: { kind: "provider_error" } });
    expect(long.mail.messageReads).toHaveLength(0);
    expect(long.m.twin.writes).toHaveLength(0);
  });
});

/** The same story run with header reads off and on must end in the same index: only the five flags may differ. */
describe("the T-258 sync behaviours with header reads ON end in the same state as with them off", () => {
  type Row = { message_id: string; folder: string | null; deleted: boolean; labels: string[]; is_read: boolean };
  async function story(headerFlags: false | object, folders: ("inbox" | "sentitems")[] | undefined, act: (env: Env) => Promise<unknown>) {
    const lanes = folders ? { PKG: { providers: ["microsoft"] as "microsoft"[], microsoft: { tenantIds: [TENANT_A], mailFolders: folders }, domains: [MAIL_DOMAIN] } } : undefined;
    const env = setup({ headerFlags, ...(lanes ? { lanes } : {}) });
    await env.m.sync.run("PKG", env.conn);
    const result = await act(env);
    const rows: Row[] = env.m.twin.rowsOf(env.conn.id).map((r) => ({ message_id: r.message_id, folder: r.folder, deleted: r.deleted, labels: r.labels, is_read: r.is_read })).sort((a, b) => (a.message_id < b.message_id ? -1 : 1));
    return { env, summary: { rows, result, cursor: env.m.twin.cursorOf("PKG", env.conn.id)?.replace(/[A-Za-z0-9_-]{20,}/g, "T") } };
  }
  async function same(folders: ("inbox" | "sentitems")[] | undefined, act: (env: Env) => Promise<unknown>) {
    const off = await story(false, folders, act);
    const on = await story({}, folders, act);
    expect(on.summary.rows.length).toBeGreaterThan(0);
    expect(on.summary.rows).toEqual(off.summary.rows);
    expect(on.summary.result).toEqual(off.summary.result);
    expect(on.env.mail.messageReads.length).toBeGreaterThan(0);
    expect(off.env.mail.messageReads).toHaveLength(0);
    return on;
  }

  it("a removal: the message is flagged deleted in its folder, nothing else", async () => {
    const on = await same(undefined, async (env) => {
      env.mail.remove(env.account, "inbox", env.mail.messages(env.account, "inbox")[0]?.id as string);
      const run = await env.m.sync.run("PKG", env.conn);
      return { removed: run.removed, written: run.written };
    });
    expect(on.summary.rows.filter((r) => r.deleted)).toHaveLength(1);
  });

  it("a move between synced folders, Sent's upsert applied before Inbox's @removed: the row stays present with folder SENT", async () => {
    const on = await same(["sentitems", "inbox"], async (env) => {
      const id = env.mail.messages(env.account, "inbox")[0]?.id as string;
      env.mail.move(env.account, id, "inbox", "sentitems");
      const run = await env.m.sync.run("PKG", env.conn);
      return { id: "moved", removed: run.removed };
    });
    expect(on.summary.rows.filter((r) => r.folder === "SENT" && !r.deleted)).toHaveLength(3);
  });

  it("the other order (Inbox's @removed first, then Sent's upsert) also ends present with folder SENT", async () => {
    const on = await same(undefined, async (env) => {
      const id = env.mail.messages(env.account, "inbox")[0]?.id as string;
      env.mail.move(env.account, id, "inbox", "sentitems");
      const run = await env.m.sync.run("PKG", env.conn);
      return { removed: run.removed };
    });
    expect(on.summary.rows.filter((r) => r.folder === "SENT" && !r.deleted)).toHaveLength(3);
    expect(on.summary.result).toMatchObject({ removed: 1 });
  });

  it("a 410 for the stored link: the cursor is reset, one full load follows, and the rows are the same", async () => {
    const on = await same(undefined, async (env) => {
      env.mail.expireDeltaState(env.account);
      const run = await env.m.sync.run("PKG", env.conn);
      return { resynced: run.resynced, mode: run.mode, written: run.written, resets: env.m.twin.stats.resets };
    });
    expect(on.summary.result).toMatchObject({ resynced: true, mode: "full", written: 5, resets: 1 });
    expect(on.summary.rows).toHaveLength(5);
  });

  it("a Microsoft sync beside a Google connection of the same user: the Google rows, cursor and connection row are untouched, every write and every header read is the Microsoft mailbox's", async () => {
    const OWNER = "00000000-0000-4000-8000-0000000b2591";
    const lanes = { PKG: { providers: ["google", "microsoft"] as ("google" | "microsoft")[], microsoft: { tenantIds: [TENANT_A] }, domains: [MAIL_DOMAIN] } };
    const env = setup({ lanes });
    const g = env.m.seedGoogle("PKG", { ownerId: OWNER });
    const ms = env.m.connect("PKG", { ownerId: OWNER });
    const googleRows = structuredClone(env.m.twin.rowsOf(g.row.id));
    const googleConn = structuredClone(env.m.h.rows.get(g.row.id));
    const run = await env.m.sync.run("PKG", ms.conn);
    expect(run).toMatchObject({ mode: "full", written: 5 });
    expect(env.m.twin.rowsOf(g.row.id)).toEqual(googleRows);
    expect(env.m.twin.cursorOf("PKG", g.row.id)).toBe(g.cursor);
    expect(env.m.h.rows.get(g.row.id)).toEqual(googleConn);
    expect(env.m.twin.writes.every((w) => w.connectionId === ms.conn.id)).toBe(true);
    expect(env.mail.messageReads).toHaveLength(3);
    expect(env.mail.messageRequests().every((r) => r.address === ms.address)).toBe(true);
    // the Microsoft runner still refuses the Google connection with no request or token read
    const requests = env.m.externalRequestCount();
    await expect(env.m.sync.run("PKG", g.conn as never)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(env.m.externalRequestCount()).toBe(requests);
  });
});
