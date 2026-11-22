// The facade's Microsoft entry with the REAL mail sync behind it (T-258): the facade's provider gate decides first (one settings read), the entry runs the
// Microsoft runner for a Microsoft row only, a Google row of the same user goes to the Google entry, and every other Microsoft operation still answers
// unsupported_op. Over the fake Graph and the in-memory index; synthetic data only. T-067: the calendar stream is real too (the facade runs both streams).
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import { RateLimiter } from "../http/rate-limit";
import { attachMicrosoftCalendar } from "../testing/microsoft-calendar-harness";
import { createMicrosoftMailHarness, MAIL_DOMAIN } from "../testing/microsoft-mail-harness";
import { TENANT_A } from "../testing/microsoft-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeCalendar } from "../testing/msw/microsoft/calendar";
import { createFakeMicrosoft } from "../testing/msw/microsoft/handlers";
import { createFakeMail, MAIL_BODY_CANARY } from "../testing/msw/microsoft/mail";
import { createMicrosoftEntry, MICROSOFT_UNSUPPORTED_MESSAGE } from "./entries";
import { createCommsFacade, type CommsEntry } from "./facade";
import { createProviderGate, PROVIDER_DISABLED_MESSAGE } from "./gate";
import { createConnSyncJob } from "../sync/job";
import type { SyncRunStore } from "../sync/types";

const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
});
const OWNER = "00000000-0000-4000-8000-0000000b2581";

function setup() {
  const fake = createFakeMicrosoft();
  const mail = createFakeMail(fake);
  const cal = createFakeCalendar(fake);
  server.use(...fake.handlers, ...mail.handlers, ...cal.handlers);
  const m = createMicrosoftMailHarness({ fake, mail, lanes: { PKG: { providers: ["google", "microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: [MAIL_DOMAIN] } } });
  const c = attachMicrosoftCalendar(m, cal);
  const google = m.seedGoogle("PKG", { ownerId: OWNER });
  const ms = m.connect("PKG", { ownerId: OWNER });
  const googleCalls: string[] = [];
  const googleEntry: CommsEntry = {
    provider: "google",
    readBody: async () => ({ text: "", truncated: false }),
    search: async () => {
      throw new Error("not used");
    },
    prepareWrite: async () => {
      throw new Error("not used");
    },
    mailSync: { run: async (_l, c) => { googleCalls.push(c.id); return { mode: "incremental", pages: 1, written: 0, skipped: 0, removed: 0, resynced: false, conflict: false }; } },
    calendarSync: { run: async () => { throw new Error("not used"); } },
  };
  const loader = {
    async loadConnection(laneId: string, id: string): Promise<LaneBoundConnection<string>> {
      const row = m.h.rows.get(id);
      if (!row || row.lane_id !== laneId) throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
      return mintLaneBoundConnection({ ...row, features: {} } as never);
    },
  };
  const gate = createProviderGate({ laneConfig: m.h.laneConfig });
  const facade = createCommsFacade({ loader, gate, entries: { google: googleEntry, microsoft: createMicrosoftEntry({ mailSync: m.sync, mail: m.provider, calendarSync: c.sync }) } });
  return { fake, mail, cal, m, c, google, ms, googleCalls, facade, loader, gate };
}

describe("facade.syncMail for a Microsoft row", () => {
  it("runs the Microsoft mail sync into the index; the same user's Google row goes to the Google entry and its rows and cursor are untouched", async () => {
    const { m, facade, ms, google, googleCalls } = setup();
    const googleRows = structuredClone(m.twin.rowsOf(google.row.id));
    const result = await facade.syncMail("PKG", ms.conn.id);
    expect(result).toMatchObject({ mode: "full", written: 5 });
    expect(m.twin.rowsOf(ms.conn.id)).toHaveLength(5);
    expect(m.twin.rowsOf(google.row.id)).toEqual(googleRows);
    expect(m.twin.cursorOf("PKG", google.row.id)).toBe(google.cursor);
    expect(googleCalls).toEqual([]);
    await facade.syncMail("PKG", google.row.id);
    expect(googleCalls).toEqual([google.row.id]); // its own entry, never the Microsoft runner
    expect(m.twin.writes.every((w) => w.connectionId === ms.conn.id)).toBe(true);
  });

  it("Microsoft not enabled for the lane: nothing is called (null), no request, no token read", async () => {
    const { m, facade, ms, mail } = setup();
    m.h.setLane("PKG", { providers: ["google"] });
    expect(await facade.syncMail("PKG", ms.conn.id)).toBeNull();
    expect(mail.requests).toHaveLength(0);
    expect(m.h.stats.tokenReads).toBe(0);
  });

  it("the conn.sync runner of the facade runs the mail stream and the calendar stream of a Microsoft row (T-067: the calendar stream is real)", async () => {
    const { m, c, facade, ms, google } = setup();
    const runner = facade.syncRunners().microsoft;
    await expect(runner("PKG", ms.conn, { streams: ["mail"] })).resolves.toMatchObject({ kind: "full", written: 5 });
    await expect(runner("PKG", ms.conn, { streams: ["calendar"] })).resolves.toMatchObject({ kind: "full", written: 9 });
    expect(m.twin.rowsOf(ms.conn.id)).toHaveLength(5);
    expect(c.twin.rowsOf(ms.conn.id)).toHaveLength(9);
    // a Google row is refused by the Microsoft runner
    await expect(runner("PKG", google.conn as never, { streams: ["mail"] })).rejects.toMatchObject({ info: { kind: "forbidden" } });
    await expect(runner("PKG", google.conn as never, { streams: ["calendar"] })).rejects.toMatchObject({ info: { kind: "forbidden" } });
  });

  it("a conn.sync run WITHOUT streams runs mail and then calendar and succeeds on both (it used to fail on the calendar stream); the second run is incremental on both", async () => {
    const { m, c, facade, ms } = setup();
    const runner = facade.syncRunners().microsoft;
    await expect(runner("PKG", ms.conn)).resolves.toMatchObject({ kind: "full", written: 14 }); // 5 messages + 9 events
    expect(m.twin.rowsOf(ms.conn.id)).toHaveLength(5);
    expect(c.twin.rowsOf(ms.conn.id)).toHaveLength(9);
    expect(m.twin.cursorOf("PKG", ms.conn.id)).toMatch(/^m1\..*\.m:/);
    expect(c.twin.cursorOf("PKG", ms.conn.id)).toMatch(/^m1\..*\.c:/);
    await expect(runner("PKG", ms.conn)).resolves.toMatchObject({ kind: "incremental", written: 0 });
  });

  it("the facade's syncCalendar (the scheduled calendar tick) runs the real Microsoft calendar sync; Microsoft not enabled for the lane: null, no request, no token read", async () => {
    const { m, c, cal, facade, ms } = setup();
    await expect(facade.syncCalendar("PKG", ms.conn.id)).resolves.toMatchObject({ mode: "full", written: 9 });
    expect(c.twin.rowsOf(ms.conn.id)).toHaveLength(9);
    m.h.setLane("PKG", { providers: ["google"] });
    const requests = cal.requests.length;
    const reads = m.h.stats.tokenReads;
    expect(await facade.syncCalendar("PKG", ms.conn.id)).toBeNull();
    expect(cal.requests).toHaveLength(requests);
    expect(m.h.stats.tokenReads).toBe(reads);
  });

  it("the conn.sync JOB over the facade's runners: a scheduled Microsoft run without streams succeeds, and a calendar-only tick succeeds and records its own outcome", async () => {
    const { facade, ms, loader, gate } = setup();
    const log: string[] = [];
    const runs: SyncRunStore = {
      async start(_l, conn) { log.push(`start:${conn.id}`); return { runId: `r-${conn.id}` }; },
      async finish(_l, _c, _r, result) { log.push(`finish:${result.status}`); },
      async recordOutcome(_l, _c, o, stream) { log.push(`outcome:${o.ok}:${stream ?? "all"}`); },
    };
    const job = createConnSyncJob({ loader, runs, runners: facade.syncRunners(), gate: (laneId, conn) => gate.enabled(laneId, conn.provider) });
    const both = await job.run("PKG", ms.conn.id, { trigger: "schedule" });
    expect(both).toMatchObject({ ok: true, skipped: null, provider: "microsoft", kind: "full", written: 14 });
    const calendarOnly = await job.run("PKG", ms.conn.id, { trigger: "schedule", streams: ["calendar"] });
    expect(calendarOnly).toMatchObject({ ok: true, skipped: null, provider: "microsoft" });
    expect(log.filter((e) => e.startsWith("outcome:")).every((e) => e.startsWith("outcome:true"))).toBe(true);
  });
});

describe("prepareWrite through the facade (T-262)", () => {
  it("prepareEmailWrite builds the payload of the row's own provider with no request and no token read; a Google row never reaches the Microsoft entry", async () => {
    const { m, facade, ms, mail, cal } = setup();
    const compose = { fromMailbox: ms.address, to: ["dana@sender.example.test"], cc: [], bcc: [], subject: "Re: Plan", bodyText: "Synthetic.", inReplyTo: { threadId: "conv-1", messageId: "msg-1" } };
    const r = await facade.prepareEmailWrite("PKG", ms.conn.id, { action_type: "email.save_draft", compose } as never);
    expect(r.proposed).toMatchObject({ provider: "microsoft", connection_id: ms.conn.id, action_type: "email.save_draft", target: { mailbox: ms.address, thread_id: "conv-1" } });
    expect(mail.requests).toHaveLength(0);
    expect(cal.requests).toHaveLength(0);
    expect(m.h.stats.tokenReads).toBe(0);
    await expect(facade.prepareEmailWrite("PKG", ms.conn.id, { action_type: "email.send", compose: { ...compose, fromMailbox: "someone-else@pubkgroup.example.test" } } as never)).rejects.toMatchObject({ info: { kind: "forbidden" } });
  });

  it("an entry built without a calendar runner (a build without the Graph calendar wiring) still answers unsupported_op for the calendar stream, with no request", async () => {
    const { m, mail, cal, ms, loader, gate } = setup();
    const facade = createCommsFacade({ loader, gate, entries: { google: { provider: "google" } as never, microsoft: createMicrosoftEntry({ mailSync: m.sync, mail: m.provider }) } });
    await expect(facade.syncCalendar("PKG", ms.conn.id)).rejects.toMatchObject({ info: { kind: "unsupported_op", message: MICROSOFT_UNSUPPORTED_MESSAGE } });
    expect(mail.requests).toHaveLength(0);
    expect(cal.requests).toHaveLength(0);
    expect(m.h.stats.tokenReads).toBe(0);
  });
});

describe("readBody and search of a Microsoft row through the facade (T-259, spec §17 test 16)", () => {
  const STRANGER = "00000000-0000-4000-8000-0000000b2599";

  it("Inbox opens a message and the briefing reads it: the text is shown to the owner only, and the canary is in no table, log line, audit record or error", async () => {
    const { m, facade, ms, mail } = setup();
    const account = m.accountOf(ms.conn);
    const msgId = mail.add(account, "inbox", { id: "synthetic-facade-1", bodyContentType: "text", bodyContent: `Dear Robert, ${MAIL_BODY_CANARY}` });
    await facade.syncMail("PKG", ms.conn.id);
    const writes = m.twin.writes.length;
    const inbox = await facade.readBody("PKG", ms.conn.id, msgId, OWNER); // the Inbox page, for the owner
    const briefing = await facade.readBody("PKG", ms.conn.id, msgId, OWNER); // the briefing's body read, for the owner
    expect(inbox).toEqual({ text: `Dear Robert, ${MAIL_BODY_CANARY}`, truncated: false });
    expect(briefing).toEqual(inbox);
    // another user is refused before any provider call, and so is a lane that has Microsoft switched off
    const requests = mail.messageRequests().length;
    const tokens = m.h.stats.tokenReads;
    const denied = await facade.readBody("PKG", ms.conn.id, msgId, STRANGER).then(() => null, (e: unknown) => e);
    expect(denied).toMatchObject({ info: { kind: "forbidden" } });
    expect(mail.messageRequests()).toHaveLength(requests);
    expect(m.h.stats.tokenReads).toBe(tokens);
    // nothing stored or logged
    expect(m.twin.writes).toHaveLength(writes);
    const everywhere = JSON.stringify([m.twin.writes, [...m.twin.rows.values()], [...m.twin.cursors.values()], m.h.logs, m.h.apiErrors, m.h.reconnects, JSON.stringify(denied)]);
    expect(everywhere).not.toContain(MAIL_BODY_CANARY);
    expect(m.contentWriteCount()).toBe(0);
  });

  it("the provider gate decides first: Microsoft not enabled for the lane means no request, no token read", async () => {
    const { m, facade, ms, mail } = setup();
    m.h.setLane("PKG", { providers: ["google"] });
    await expect(facade.readBody("PKG", ms.conn.id, "synthetic-x", OWNER)).rejects.toMatchObject({ info: { message: PROVIDER_DISABLED_MESSAGE } });
    await expect(facade.search("PKG", ms.conn.id, { query: "synthetic" }, OWNER)).rejects.toMatchObject({ info: { message: PROVIDER_DISABLED_MESSAGE } });
    expect(mail.requests).toHaveLength(0);
    expect(m.h.stats.tokenReads).toBe(0);
  });

  it("search returns the metadata of the connection's own mailbox, labelled live; a stranger is refused; ids that could move a request are refused before any request", async () => {
    const { m, facade, ms, mail } = setup();
    const res = await facade.search("PKG", ms.conn.id, { query: "synthetic", limit: 2 }, OWNER);
    expect(res).toMatchObject({ provider: "microsoft", connection_id: ms.conn.id, freshness: "live", lane_id: "PKG" });
    expect(res.data).toHaveLength(2);
    await expect(facade.search("PKG", ms.conn.id, { query: "synthetic" }, STRANGER)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    const before = m.externalRequestCount();
    await expect(facade.readBody("PKG", ms.conn.id, "a/b", OWNER)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    await expect(facade.readBody("PKG", ms.conn.id, "a%2Fb", OWNER)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(m.externalRequestCount()).toBe(before);
    expect(mail.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });

  it("a Google row of the same user is read by the Google entry, never by the Microsoft provider", async () => {
    const { facade, google, mail } = setup();
    await expect(facade.readBody("PKG", google.row.id, "gmail-id", OWNER)).resolves.toEqual({ text: "", truncated: false }); // the test's Google entry
    expect(mail.messageRequests()).toHaveLength(0);
  });
});
