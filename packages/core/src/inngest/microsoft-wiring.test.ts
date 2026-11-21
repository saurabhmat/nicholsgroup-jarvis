// T-260 / T-261: the scheduled mail and calendar jobs run Google AND Microsoft connections of every lane in one tick, through conn.sync, with the per-tenant
// concurrency key for Microsoft rows on top of the per-connection key; Google's key and event shape are unchanged.
import { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { handleCalIngest, calIngestEventId, type CalIngestDeps, type SyncTargetRef } from "./cal-ingest";
import { CONN_SYNC_CONCURRENCY, CONN_SYNC_TENANT_CONCURRENCY, connSyncFunction, handleConnSync, type ConnSyncDeps, type ConnSyncResult } from "./conn-sync";
import { connSyncRequested } from "./events";
import { handleMailIngest, mailIngestEventId, shouldRefreshBriefingAfterSync, type MailIngestDeps } from "./mail-ingest";

const G_PKG = "00000000-0000-4000-8000-000000026001"; // Google connection of lane PKG
const M_PKG = "00000000-0000-4000-8000-000000026002"; // Microsoft connection of lane PKG (same user as G_PKG, or another)
const M_PKG_2 = "00000000-0000-4000-8000-000000026003"; // Microsoft connection of a second user of PKG, in the same tenant
const G_APK = "00000000-0000-4000-8000-000000026004"; // Google-only lane
const TENANT_1 = "11111111-1111-4111-8111-111111111111";
const TENANT_2 = "22222222-2222-4222-8222-222222222222";
const TS = Date.parse("2026-11-21T12:22:00Z");

type Sent = ReturnType<typeof connSyncRequested.create>[];
const stepFor = (sent: Sent[]) => ({
  run: async <T>(_id: string, fn: () => T | Promise<T>) => fn(),
  sendEvent: async (_id: string, events: Sent) => {
    sent.push(events);
  },
});

/** Lane PKG has Google and Microsoft connections (two Microsoft users in one tenant, one Microsoft user in another); lane APK has only Google. */
const targets: Record<string, SyncTargetRef[]> = {
  PKG: [G_PKG, { connectionId: M_PKG, tenantId: TENANT_1 }, { connectionId: M_PKG_2, tenantId: TENANT_1 }, { connectionId: "00000000-0000-4000-8000-000000026005", tenantId: TENANT_2 }],
  APK: [G_APK],
};
const lanes = { enabledLanes: () => ["PKG", "APK"], listConnections: async (lane: string) => targets[lane] ?? [] };

describe("one tick runs every usable connection of both providers, across lanes (T-260, T-261)", () => {
  it("mail: a Google-only lane and a lane with both providers go out in the same tick, one event per connection, the stream asked is mail only", async () => {
    const sent: Sent[] = [];
    const deps: MailIngestDeps = lanes;
    const out = await handleMailIngest(deps, TS, stepFor(sent));
    const events = sent.flat();
    expect(out).toMatchObject({ lanes: 2, connections: 5 });
    expect(events.map((e) => [e.data.laneId, e.data.connectionId])).toEqual([["PKG", G_PKG], ["PKG", M_PKG], ["PKG", M_PKG_2], ["PKG", "00000000-0000-4000-8000-000000026005"], ["APK", G_APK]]);
    for (const e of events) expect(e.data).toMatchObject({ trigger: "schedule", streams: ["mail"] });
    expect(events.map((e) => e.id)).toEqual(events.map((e) => mailIngestEventId(e.data.connectionId, out.slot)));
  });

  it("calendar: the same, with the calendar stream", async () => {
    const sent: Sent[] = [];
    const deps: CalIngestDeps = lanes;
    const out = await handleCalIngest(deps, TS, stepFor(sent));
    const events = sent.flat();
    expect(out).toMatchObject({ lanes: 2, connections: 5 });
    for (const e of events) expect(e.data).toMatchObject({ trigger: "schedule", streams: ["calendar"] });
    expect(events.map((e) => e.id)).toEqual(events.map((e) => calIngestEventId(e.data.connectionId, out.slot)));
  });

  it("a Microsoft row's event carries its tenant id; a Google row's event is exactly the shape it had before (no tenant key at all)", async () => {
    const sent: Sent[] = [];
    await handleMailIngest(lanes, TS, stepFor(sent));
    const byConn = new Map(sent.flat().map((e) => [e.data.connectionId, e.data]));
    expect(byConn.get(G_PKG)).toStrictEqual({ laneId: "PKG", connectionId: G_PKG, trigger: "schedule", streams: ["mail"] });
    expect(byConn.get(G_APK)).toStrictEqual({ laneId: "APK", connectionId: G_APK, trigger: "schedule", streams: ["mail"] });
    expect(byConn.get(M_PKG)).toStrictEqual({ laneId: "PKG", connectionId: M_PKG, trigger: "schedule", streams: ["mail"], tenantId: TENANT_1 });
    expect(byConn.get(M_PKG_2)).toMatchObject({ tenantId: TENANT_1 });
  });

  it("a tenant id that is not a UUID is dropped (the run is then keyed by its connection alone); a list of bare ids still works", async () => {
    const sent: Sent[] = [];
    const deps: MailIngestDeps = { enabledLanes: () => ["PKG"], listConnections: async () => [{ connectionId: M_PKG, tenantId: "not-a-uuid" }, { connectionId: G_PKG, tenantId: null }, M_PKG_2] };
    await handleMailIngest(deps, TS, stepFor(sent));
    for (const e of sent.flat()) expect(Object.keys(e.data)).not.toContain("tenantId");
  });

  it("one lane that cannot be listed does not stop the other lane's connections, and the tick still reports it", async () => {
    const sent: Sent[] = [];
    const deps: MailIngestDeps = { enabledLanes: () => ["PKG", "APK"], listConnections: async (lane) => (lane === "PKG" ? Promise.reject(new Error("x")) : [G_APK]) };
    await expect(handleMailIngest(deps, TS, stepFor(sent))).rejects.toThrow("1 lane(s) could not be listed");
    expect(sent.flat().map((e) => e.data.connectionId)).toEqual([G_APK]);
  });
});

describe("conn.sync concurrency (T-260)", () => {
  it("Google's per-connection key is byte for byte what it was, and stays the first key", () => {
    expect(JSON.stringify(CONN_SYNC_CONCURRENCY)).toBe('{"key":"event.data.connectionId","limit":1}');
    const fn = connSyncFunction(new Inngest({ id: "test-app", isDev: true }), { runSync: vi.fn(), enabledLanes: () => ["PKG"] } as unknown as ConnSyncDeps) as unknown as { opts: Record<string, unknown> };
    const concurrency = (JSON.parse(JSON.stringify(fn.opts)) as { concurrency: unknown[] }).concurrency;
    expect(concurrency).toHaveLength(2);
    expect(JSON.stringify(concurrency[0])).toBe('{"key":"event.data.connectionId","limit":1}');
  });

  it("the second key is per Microsoft tenant, and falls back to the connection id when the event has no tenant (a no-op for Google)", () => {
    expect(CONN_SYNC_TENANT_CONCURRENCY.key).toBe("has(event.data.tenantId) ? event.data.tenantId : event.data.connectionId");
    expect(CONN_SYNC_TENANT_CONCURRENCY.limit).toBeGreaterThanOrEqual(CONN_SYNC_CONCURRENCY.limit);
    expect(CONN_SYNC_TENANT_CONCURRENCY.key).toContain("event.data.tenantId");
  });

  it("the event accepts a tenant id (a UUID) and refuses anything else there", async () => {
    const check = (tenantId: unknown) => connSyncRequested.schema["~standard"].validate({ laneId: "PKG", connectionId: M_PKG, trigger: "schedule", tenantId });
    expect((await check(TENANT_1)).issues).toBeUndefined();
    expect((await check("Contoso Ltd")).issues).toBeDefined();
    expect((await check({ id: TENANT_1 })).issues).toBeDefined();
  });

  it("a Microsoft event is run through the same runSync by connection id; the tenant id only picks a queue and is not passed on", async () => {
    const result: ConnSyncResult = { ok: true, skipped: null, runId: "r", provider: "microsoft", kind: "incremental", received: 2, written: 2 };
    const d = { runSync: vi.fn(async () => result), enabledLanes: () => ["PKG"] } as unknown as ConnSyncDeps & { runSync: ReturnType<typeof vi.fn> };
    await handleConnSync(d, { laneId: "PKG", connectionId: M_PKG, trigger: "schedule", streams: ["mail"], tenantId: TENANT_1 } as never, null);
    expect(d.runSync).toHaveBeenCalledWith("PKG", M_PKG, { trigger: "schedule", jobRunId: null, streams: ["mail"] });
  });
});

describe("the briefing refresh after a scheduled mail sync (T-260)", () => {
  it("follows a Microsoft mail run that wrote messages exactly as it follows Google's", () => {
    const base = { trigger: "schedule", streams: ["mail"] as const, written: 1 };
    expect(shouldRefreshBriefingAfterSync({ ...base, provider: "google" })).toBe(true);
    expect(shouldRefreshBriefingAfterSync({ ...base, provider: "microsoft" })).toBe(true);
    expect(shouldRefreshBriefingAfterSync({ ...base, provider: "microsoft", streams: ["calendar"] })).toBe(false);
    expect(shouldRefreshBriefingAfterSync({ ...base, provider: "microsoft", written: 0 })).toBe(false);
    expect(shouldRefreshBriefingAfterSync({ ...base, provider: "microsoft", trigger: "manual" })).toBe(false);
  });
});
