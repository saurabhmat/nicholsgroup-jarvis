// The facade's Microsoft entry with the REAL mail sync behind it (T-258): the facade's provider gate decides first (one settings read), the entry runs the
// Microsoft runner for a Microsoft row only, a Google row of the same user goes to the Google entry, and every other Microsoft operation still answers
// unsupported_op. Over the fake Graph and the in-memory index; synthetic data only.
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import { RateLimiter } from "../http/rate-limit";
import { createMicrosoftMailHarness, MAIL_DOMAIN } from "../testing/microsoft-mail-harness";
import { TENANT_A } from "../testing/microsoft-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeMicrosoft } from "../testing/msw/microsoft/handlers";
import { createFakeMail, MAIL_BODY_CANARY } from "../testing/msw/microsoft/mail";
import { createMicrosoftEntry, MICROSOFT_UNSUPPORTED_MESSAGE } from "./entries";
import { createCommsFacade, type CommsEntry } from "./facade";
import { createProviderGate, PROVIDER_DISABLED_MESSAGE } from "./gate";

const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
});
const OWNER = "00000000-0000-4000-8000-0000000b2581";

function setup() {
  const fake = createFakeMicrosoft();
  const mail = createFakeMail(fake);
  server.use(...fake.handlers, ...mail.handlers);
  const m = createMicrosoftMailHarness({ fake, mail, lanes: { PKG: { providers: ["google", "microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: [MAIL_DOMAIN] } } });
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
  const facade = createCommsFacade({ loader, gate, entries: { google: googleEntry, microsoft: createMicrosoftEntry({ mailSync: m.sync, mail: m.provider }) } });
  return { fake, mail, m, google, ms, googleCalls, facade };
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

  it("the conn.sync runner of the facade runs the mail stream of a Microsoft row; the calendar stream is not built (T-067) and answers unsupported_op", async () => {
    const { m, facade, ms, google } = setup();
    const runner = facade.syncRunners().microsoft;
    await expect(runner("PKG", ms.conn, { streams: ["mail"] })).resolves.toMatchObject({ kind: "full", written: 5 });
    await expect(runner("PKG", ms.conn, { streams: ["calendar"] })).rejects.toMatchObject({ info: { kind: "unsupported_op" } });
    expect(m.twin.rowsOf(ms.conn.id)).toHaveLength(5);
    // a Google row is refused by the Microsoft runner
    await expect(runner("PKG", google.conn as never, { streams: ["mail"] })).rejects.toMatchObject({ info: { kind: "forbidden" } });
  });
});

describe("the other Microsoft operations still answer unsupported_op (T-262, T-067)", () => {
  it("prepareEmailWrite and the calendar sync: refused, no request, no token read", async () => {
    const { m, facade, ms, mail } = setup();
    for (const call of [() => facade.prepareEmailWrite("PKG", ms.conn.id, { action_type: "email.send", compose: {} } as never), () => facade.syncCalendar("PKG", ms.conn.id)]) {
      await expect(call()).rejects.toMatchObject({ info: { kind: "unsupported_op", message: MICROSOFT_UNSUPPORTED_MESSAGE } });
    }
    expect(mail.requests).toHaveLength(0);
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
