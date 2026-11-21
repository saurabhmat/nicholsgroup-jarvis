// T-260 / T-261: the scheduled mail and calendar jobs list Google AND Microsoft connections of every lane in one tick and send ONE event per connection through
// conn.sync, with the event shape and the job options exactly as they are for Google today (no per-tenant key: logged as a follow-up).
import { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { handleCalIngest, calIngestEventId, type CalIngestDeps } from "./cal-ingest";
import { CONN_SYNC_CONCURRENCY, connSyncFunction, handleConnSync, type ConnSyncDeps, type ConnSyncResult } from "./conn-sync";
import { connSyncRequested } from "./events";
import { handleMailIngest, mailIngestEventId, shouldRefreshBriefingAfterSync, type MailIngestDeps } from "./mail-ingest";

const G_PKG = "00000000-0000-4000-8000-000000026001"; // Google connection of lane PKG
const M_PKG = "00000000-0000-4000-8000-000000026002"; // Microsoft connection of PKG
const M_PKG_2 = "00000000-0000-4000-8000-000000026003"; // Microsoft connection of a second user of PKG
const G_APK = "00000000-0000-4000-8000-000000026004"; // Google-only lane
const TS = Date.parse("2026-11-21T12:22:00Z");

type Sent = ReturnType<typeof connSyncRequested.create>[];
const stepFor = (sent: Sent[]) => ({
  run: async <T>(_id: string, fn: () => T | Promise<T>) => fn(),
  sendEvent: async (_id: string, events: Sent) => {
    sent.push(events);
  },
});

const targets: Record<string, string[]> = { PKG: [G_PKG, M_PKG, M_PKG_2], APK: [G_APK] };
const lanes = { enabledLanes: () => ["PKG", "APK"], listConnections: async (lane: string) => targets[lane] ?? [] };

describe("one tick runs every usable connection of both providers, across lanes (T-260, T-261)", () => {
  it("mail: a Google-only lane and a lane with both providers go out in the same tick, one event per connection, the stream asked is mail only", async () => {
    const sent: Sent[] = [];
    const deps: MailIngestDeps = lanes;
    const out = await handleMailIngest(deps, TS, stepFor(sent));
    const events = sent.flat();
    expect(out).toMatchObject({ lanes: 2, connections: 4 });
    expect(events.map((e) => [e.data.laneId, e.data.connectionId])).toEqual([["PKG", G_PKG], ["PKG", M_PKG], ["PKG", M_PKG_2], ["APK", G_APK]]);
    for (const e of events) expect(e.data).toStrictEqual({ laneId: e.data.laneId, connectionId: e.data.connectionId, trigger: "schedule", streams: ["mail"] });
    expect(events.map((e) => e.id)).toEqual(events.map((e) => mailIngestEventId(e.data.connectionId, out.slot)));
  });

  it("calendar: the same, with the calendar stream", async () => {
    const sent: Sent[] = [];
    const deps: CalIngestDeps = lanes;
    const out = await handleCalIngest(deps, TS, stepFor(sent));
    const events = sent.flat();
    expect(out).toMatchObject({ lanes: 2, connections: 4 });
    for (const e of events) expect(e.data).toStrictEqual({ laneId: e.data.laneId, connectionId: e.data.connectionId, trigger: "schedule", streams: ["calendar"] });
    expect(events.map((e) => e.id)).toEqual(events.map((e) => calIngestEventId(e.data.connectionId, out.slot)));
  });

  it("one lane that cannot be listed does not stop the other lane's connections, and the tick still reports it", async () => {
    const sent: Sent[] = [];
    const deps: MailIngestDeps = { enabledLanes: () => ["PKG", "APK"], listConnections: async (lane) => (lane === "PKG" ? Promise.reject(new Error("x")) : [G_APK]) };
    await expect(handleMailIngest(deps, TS, stepFor(sent))).rejects.toThrow("1 lane(s) could not be listed");
    expect(sent.flat().map((e) => e.data.connectionId)).toEqual([G_APK]);
  });
});

describe("conn.sync options and event are what they are for Google today (T-260)", () => {
  it("the job keeps its single per-connection key, byte for byte", () => {
    expect(JSON.stringify(CONN_SYNC_CONCURRENCY)).toBe('{"key":"event.data.connectionId","limit":1}');
    const fn = connSyncFunction(new Inngest({ id: "test-app", isDev: true }), { runSync: vi.fn(), enabledLanes: () => ["PKG"] } as unknown as ConnSyncDeps) as unknown as { opts: Record<string, unknown> };
    expect(JSON.stringify((JSON.parse(JSON.stringify(fn.opts)) as { concurrency: unknown }).concurrency)).toBe('{"key":"event.data.connectionId","limit":1}');
  });

  it("the event has no tenant field: an unknown key is refused (strict), so nothing can pick a queue from the event", async () => {
    const check = (extra: Record<string, unknown>) => connSyncRequested.schema["~standard"].validate({ laneId: "PKG", connectionId: M_PKG, trigger: "schedule", ...extra });
    expect((await check({})).issues).toBeUndefined();
    expect((await check({ tenantId: "11111111-1111-4111-8111-111111111111" })).issues).toBeDefined();
  });

  it("a Microsoft event is run through the same runSync by connection id", async () => {
    const result: ConnSyncResult = { ok: true, skipped: null, runId: "r", provider: "microsoft", kind: "incremental", received: 2, written: 2 };
    const d = { runSync: vi.fn(async () => result), enabledLanes: () => ["PKG"] } as unknown as ConnSyncDeps & { runSync: ReturnType<typeof vi.fn> };
    await handleConnSync(d, { laneId: "PKG", connectionId: M_PKG, trigger: "schedule", streams: ["mail"] }, null);
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
