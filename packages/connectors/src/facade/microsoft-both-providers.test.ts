// T-260, T-261: the scheduled mail and calendar ticks run EVERY usable Google and Microsoft connection of every lane through the facade's runners, in the same tick.
// Over the fake Graph, the real Microsoft runners and the in-memory index twins; Google is a counting entry (its own sync is tested in google/*). Synthetic data only.
// What it proves: two users' Microsoft mailboxes stay apart; one user's Google and Microsoft mailbox (and calendar) both sync in one tick, each by its own provider, with
// the same message shown twice in the index (no de-duplication, D-58); a Google-only lane and a lane with both run together; a paused Microsoft connection is not synced and
// keeps its rows; the calendar rows of all-day, cancelled-occurrence and removed events are what the readers expect.
import { afterEach, describe, expect, it } from "vitest";
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import { RateLimiter } from "../http/rate-limit";
import { attachMicrosoftCalendar } from "../testing/microsoft-calendar-harness";
import { createMicrosoftMailHarness, MAIL_DOMAIN } from "../testing/microsoft-mail-harness";
import { TENANT_A } from "../testing/microsoft-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeCalendar } from "../testing/msw/microsoft/calendar";
import { createFakeMicrosoft } from "../testing/msw/microsoft/handlers";
import { createFakeMail } from "../testing/msw/microsoft/mail";
import { createMicrosoftEntry } from "./entries";
import { createCommsFacade, type CommsEntry } from "./facade";
import { createProviderGate } from "./gate";
import { createConnSyncJob } from "../sync/job";
import { createSyncTargetLister } from "../sync/targets";
import type { SyncRunStore } from "../sync/types";

const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
});
const USER_1 = "00000000-0000-4000-8000-0000000c2601";
const USER_2 = "00000000-0000-4000-8000-0000000c2602";
const TENANT_UUID = "33333333-3333-4333-8333-333333333333";

function setup(lanes: Record<string, { providers: ("google" | "microsoft")[] }> = { PKG: { providers: ["google", "microsoft"] } }) {
  const fake = createFakeMicrosoft();
  const mail = createFakeMail(fake);
  const cal = createFakeCalendar(fake);
  server.use(...fake.handlers, ...mail.handlers, ...cal.handlers);
  const setups = Object.fromEntries(Object.entries(lanes).map(([lane, l]) => [lane, { providers: l.providers, microsoft: { tenantIds: [TENANT_A] }, domains: [MAIL_DOMAIN] }]));
  const m = createMicrosoftMailHarness({ fake, mail, lanes: setups });
  const c = attachMicrosoftCalendar(m, cal);
  const googleCalls: { stream: "mail" | "calendar"; id: string }[] = [];
  const googleEntry: CommsEntry = {
    provider: "google",
    readBody: async () => ({ text: "", truncated: false }),
    search: async () => {
      throw new Error("not used");
    },
    prepareWrite: async () => {
      throw new Error("not used");
    },
    mailSync: { run: async (_l, conn) => { googleCalls.push({ stream: "mail", id: conn.id }); return { mode: "incremental", pages: 1, written: 1, skipped: 0, removed: 0, resynced: false, conflict: false }; } },
    calendarSync: { run: async (_l, conn) => { googleCalls.push({ stream: "calendar", id: conn.id }); return { mode: "incremental", pages: 1, written: 1, skipped: 0, removed: 0, resynced: false, conflict: false }; } },
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
  const log: string[] = [];
  const runs: SyncRunStore = {
    async start(_l, conn) { log.push(`start:${conn.id}`); return { runId: `r-${conn.id}` }; },
    async finish(_l, conn, _r, result) { log.push(`finish:${conn.id}:${result.status}`); },
    async recordOutcome(_l, conn, o, stream) { log.push(`outcome:${conn.id}:${o.ok}:${stream ?? "all"}`); },
  };
  const job = createConnSyncJob({ loader, runs, runners: facade.syncRunners(), gate: (laneId, conn) => gate.enabled(laneId, conn.provider) });
  // The scheduled tick's list: the real lister over the harness's rows (it filters like the SQL: lane, native, provider, status).
  const clientFor = async () => {
    const f: Record<string, unknown[]> = {};
    const b: Record<string, unknown> = {};
    for (const op of ["eq", "in"]) b[op] = (col: string, val: unknown) => { f[`${op}:${col}`] = [val]; return b; };
    b.order = () => b;
    b.limit = () => {
      const lane = f["eq:lane_id"]?.[0];
      const providers = (f["in:provider"]?.[0] ?? []) as string[];
      const statuses = (f["in:status"]?.[0] ?? []) as string[];
      const data = [...m.h.rows.values()].filter((r) => r.lane_id === lane && providers.includes(r.provider) && statuses.includes(r.status)).sort((x, y) => x.id.localeCompare(y.id)).map((r) => ({ id: r.id, provider: r.provider, tenant_id: r.provider === "microsoft" ? TENANT_UUID : null }));
      return Promise.resolve({ data, error: null });
    };
    return { schema: () => ({ from: () => ({ select: () => b }) }) } as never;
  };
  const lister = createSyncTargetLister(clientFor);
  /** One scheduled tick of one stream over every lane's list: what mail-ingest-delta / cal-ingest-delta send to conn.sync, run one by one. */
  async function tick(stream: "mail" | "calendar", laneIds: string[]) {
    const out: { laneId: string; id: string; result: Awaited<ReturnType<typeof job.run>> }[] = [];
    for (const laneId of laneIds) {
      const targets = stream === "mail" ? await lister.listMailTargets(laneId as LaneId) : await lister.listCalendarTargets(laneId as LaneId);
      for (const t of targets) out.push({ laneId, id: t.connectionId, result: await job.run(laneId as LaneId, t.connectionId, { trigger: "schedule", streams: [stream] }) });
    }
    return out;
  }
  return { fake, mail, cal, m, c, googleCalls, facade, job, tick, lister, log };
}

describe("a lane with two Microsoft mailboxes of two users (T-260)", () => {
  it("each mailbox is synced into its own rows; one user's message is not readable through the other's identity", async () => {
    const { m, tick, facade, mail } = setup({ PKG: { providers: ["microsoft"] } });
    const a = m.connect("PKG", { ownerId: USER_1 });
    const b = m.connect("PKG", { ownerId: USER_2 });
    const own = mail.add(m.accountOf(a.conn), "inbox", { id: "synthetic-user1-secret-subject-msg", subject: "Only for user one" });
    const results = await tick("mail", ["PKG"]);
    expect(results.map((r) => r.result)).toEqual([expect.objectContaining({ ok: true, skipped: null, provider: "microsoft" }), expect.objectContaining({ ok: true, skipped: null, provider: "microsoft" })]);
    expect(m.twin.rowsOf(a.conn.id).some((r) => r.subject === "Only for user one")).toBe(true);
    expect(m.twin.rowsOf(b.conn.id).some((r) => r.subject === "Only for user one")).toBe(false);
    expect(m.twin.rowsOf(a.conn.id).every((r) => r.connection_id === a.conn.id)).toBe(true);
    expect(m.twin.rowsOf(b.conn.id).every((r) => r.connection_id === b.conn.id)).toBe(true);
    // the owner check: user 1 reads own mailbox; user 2 asking for user 1's connection is refused before any request
    await expect(facade.readBody("PKG", a.conn.id, own, USER_1)).resolves.toMatchObject({ truncated: false });
    const before = mail.messageRequests().length;
    await expect(facade.readBody("PKG", a.conn.id, own, USER_2)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    await expect(facade.readBody("PKG", b.conn.id, own, USER_1)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(mail.messageRequests()).toHaveLength(before);
  });
});

describe("one user with a Google and a Microsoft mailbox in one lane (T-260, T-261)", () => {
  it("one mail tick and one calendar tick sync both, each by its own provider; the same message in both mailboxes is two index rows (D-58: no de-duplication)", async () => {
    const { m, c, tick, googleCalls, mail } = setup();
    const google = m.seedGoogle("PKG", { ownerId: USER_1, address: "robert@pubkgroup.example.test" });
    const ms = m.connect("PKG", { ownerId: USER_1, address: "robert.ms@pubkgroup.example.test" });
    mail.add(m.accountOf(ms.conn), "inbox", { id: "synthetic-same-1", subject: "Synthetic Gmail message" }); // the Google row's subject: the same message in both mailboxes
    const mailTick = await tick("mail", ["PKG"]);
    expect(mailTick).toHaveLength(2);
    expect(mailTick.every((r) => r.result.ok && r.result.skipped === null)).toBe(true);
    expect(mailTick.map((r) => (r.result.ok && r.result.skipped === null ? r.result.provider : null)).sort()).toEqual(["google", "microsoft"]);
    expect(googleCalls).toEqual([{ stream: "mail", id: google.row.id }]); // the Google runner ran only the mail stream, for its own connection
    expect(m.twin.rowsOf(ms.conn.id).length).toBeGreaterThan(0);
    const calTick = await tick("calendar", ["PKG"]);
    expect(calTick).toHaveLength(2);
    expect(calTick.every((r) => r.result.ok && r.result.skipped === null)).toBe(true);
    expect(googleCalls).toEqual([{ stream: "mail", id: google.row.id }, { stream: "calendar", id: google.row.id }]);
    expect(c.twin.rowsOf(ms.conn.id).length).toBeGreaterThan(0);
    // no de-duplication: the same subject exists as a Google row AND a Microsoft row of the same user
    const same = [...m.twin.rowsOf(google.row.id), ...m.twin.rowsOf(ms.conn.id)].filter((r) => r.subject === "Synthetic Gmail message");
    expect(same.map((r) => r.connection_id).sort()).toEqual([google.row.id, ms.conn.id].sort());
    // the Microsoft runner never touched the Google row, and a Microsoft tick wrote only Microsoft rows
    expect(m.twin.rowsOf(google.row.id).every((r) => r.connection_id === google.row.id)).toBe(true);
  });

  it("the same address held by a Google and a Microsoft row of one lane: both usable, both synced (spec §16)", async () => {
    const { m, tick } = setup();
    m.seedGoogle("PKG", { ownerId: USER_1, address: "same@pubkgroup.example.test" });
    m.connect("PKG", { ownerId: USER_1, address: "same@pubkgroup.example.test" });
    const results = await tick("mail", ["PKG"]);
    expect(results.filter((r) => r.result.ok && r.result.skipped === null)).toHaveLength(2);
  });
});

describe("a mixed tick across lanes (T-260)", () => {
  it("a Google-only lane and a lane with both providers run in one tick; a Microsoft connection of the Google-only lane is paused: not synced, no request, no token read, rows kept", async () => {
    const { m, tick, job, googleCalls, mail, log } = setup({ PKG: { providers: ["google", "microsoft"] }, APK: { providers: ["google"] } });
    const gPkg = m.seedGoogle("PKG", { ownerId: USER_1 });
    const mPkg = m.connect("PKG", { ownerId: USER_1 });
    const gApk = m.seedGoogle("APK", { ownerId: USER_1 });
    const mApk = m.connect("APK", { ownerId: USER_1 }); // Microsoft is not enabled for APK
    // The paused row already has indexed mail (synced while the lane had Microsoft on): it must stay.
    m.h.setLane("APK", { providers: ["google", "microsoft"] });
    await tick("mail", ["APK"]);
    const keptRows = structuredClone(m.twin.rowsOf(mApk.conn.id));
    expect(keptRows.length).toBeGreaterThan(0);
    m.h.setLane("APK", { providers: ["google"] });
    googleCalls.length = 0;
    const requests = mail.requests.length;
    const tokens = m.h.stats.tokenReads;
    log.length = 0;
    const results = await tick("mail", ["PKG", "APK"]);
    const by = new Map(results.map((r) => [r.id, r.result]));
    expect(by.get(gPkg.row.id)).toMatchObject({ ok: true, skipped: null, provider: "google" });
    expect(by.get(mPkg.conn.id)).toMatchObject({ ok: true, skipped: null, provider: "microsoft" });
    expect(by.get(gApk.row.id)).toMatchObject({ ok: true, skipped: null, provider: "google" });
    expect(by.get(mApk.conn.id)).toEqual({ ok: true, skipped: "provider_disabled" });
    expect(googleCalls.map((g) => g.id).sort()).toEqual([gPkg.row.id, gApk.row.id].sort());
    // paused: no run logged for it, rows kept, and the only Graph traffic was lane PKG's mailbox
    expect(log.some((e) => e.includes(mApk.conn.id))).toBe(false);
    expect(m.twin.rowsOf(mApk.conn.id)).toEqual(keptRows);
    expect(mail.requests.length).toBeGreaterThan(requests);
    expect(m.h.stats.tokenReads).toBeGreaterThan(tokens);
    // and with Microsoft off for APK a second time nothing at all goes out for that row
    const requests2 = mail.requests.length;
    const tokens2 = m.h.stats.tokenReads;
    await expect(job.run("APK" as LaneId, mApk.conn.id, { trigger: "manual" })).resolves.toEqual({ ok: true, skipped: "provider_disabled" }); // a manual Sync now too
    expect(mail.requests).toHaveLength(requests2);
    expect(m.h.stats.tokenReads).toBe(tokens2);
  });
});

describe("the calendar tick: all-day, a cancelled occurrence and a removed event (T-261)", () => {
  it("a Microsoft calendar's events land as rows; cancelled and removed ones read cancelled (the readers leave them out); all-day events keep their dates", async () => {
    const { m, c, cal, tick } = setup();
    const ms = m.connect("PKG", { ownerId: USER_1 });
    const account = m.accountOf(ms.conn);
    const toRemove = cal.add(account, { subject: "Synthetic to be removed", startInDays: 2 });
    await tick("calendar", ["PKG"]);
    const first = c.twin.rowsOf(ms.conn.id);
    expect(first.filter((e) => e.all_day).length).toBeGreaterThanOrEqual(2);
    for (const e of first.filter((x) => x.all_day)) expect(e.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const cancelledId = cal.bySubject(account, "Synthetic cancelled").id;
    expect(first.find((e) => e.event_id === cancelledId)?.status).toBe("cancelled"); // a cancelled event arrives as a status-only stub
    expect(first.some((e) => e.title === "Synthetic weekly" && e.recurring_event_id !== null)).toBe(true);
    // an occurrence of the series is cancelled by its organizer; another event is deleted: the next tick marks both cancelled
    const occurrence = cal.events(account).find((e) => e.type === "occurrence");
    if (!occurrence) throw new Error("fixture has no occurrence");
    cal.cancel(account, occurrence.id);
    cal.remove(account, toRemove);
    await tick("calendar", ["PKG"]);
    const after = c.twin.rowsOf(ms.conn.id);
    expect(after.find((e) => e.event_id === occurrence.id)?.status).toBe("cancelled");
    expect(after.find((e) => e.event_id === toRemove)?.status).toBe("cancelled");
    // what a reader returns (status is distinct from 'cancelled'): neither of the two, and the live events stay
    const visible = after.filter((e) => e.status !== "cancelled").map((e) => e.event_id);
    expect(visible).not.toContain(occurrence.id);
    expect(visible).not.toContain(toRemove);
    expect(after.filter((e) => e.all_day && e.status !== "cancelled").length).toBeGreaterThanOrEqual(2);
  });
});

describe("the scheduled lister (T-260)", () => {
  it("lists Google and Microsoft connections of the lane together, with the tenant id of a Microsoft row only", async () => {
    const { m, lister } = setup();
    const g = m.seedGoogle("PKG", { ownerId: USER_1 });
    const ms = m.connect("PKG", { ownerId: USER_1 });
    m.connect("PKG", { ownerId: USER_2, tenant: TENANT_A, address: "second@pubkgroup.example.test" });
    const mailTargets = await lister.listMailTargets("PKG" as LaneId);
    expect(mailTargets).toHaveLength(3);
    expect(mailTargets.find((t) => t.connectionId === g.row.id)).toEqual({ connectionId: g.row.id, tenantId: null });
    expect(mailTargets.find((t) => t.connectionId === ms.conn.id)).toEqual({ connectionId: ms.conn.id, tenantId: TENANT_UUID });
    expect(await lister.listCalendarTargets("PKG" as LaneId)).toEqual(mailTargets);
    expect((await lister.listMailConnectionIds("PKG" as LaneId)).sort()).toEqual(mailTargets.map((t) => t.connectionId).sort());
  });
});
