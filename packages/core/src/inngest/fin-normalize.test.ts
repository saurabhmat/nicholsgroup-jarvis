// fin.qbo_normalize (T-056): per-connection worker, lane checks, retries, ids only; and the afterSync hook of conn.sync.
import { Inngest, NonRetriableError, RetryAfterError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { handleConnSync, type ConnSyncResult } from "./conn-sync";
import { finQboNormalizeRequested, LANE_EVENTS } from "./events";
import {
  FIN_NORMALIZE_CONCURRENCY,
  FIN_NORMALIZE_RETRIES,
  finNormalizeEventId,
  finQboNormalizeFunctions,
  handleFinNormalize,
  type FinQboNormalizeDeps,
  type FinQboNormalizeResult,
} from "./fin-normalize";

const A = "00000000-0000-4000-8000-000000000a01";
const B = "00000000-0000-4000-8000-000000000a02";
const OK: FinQboNormalizeResult = { ok: true, skipped: null, classFallback: false, written: 3, tombstoned: 0, unmappedRows: 0, reallocated: 0 };
const deps = (over: Partial<FinQboNormalizeDeps> = {}) => ({
  enabledLanes: () => ["PKG"] as readonly string[],
  ...over,
  runNormalize: vi.fn(over.runNormalize ?? (async (): Promise<FinQboNormalizeResult> => OK)),
});

describe("config", () => {
  it("is a per-connection worker with concurrency 1 per connection, triggered by the typed event", () => {
    expect(FIN_NORMALIZE_CONCURRENCY).toEqual({ key: "event.data.connectionId", limit: 1 });
    const fns = finQboNormalizeFunctions(new Inngest({ id: "test-app", isDev: true }), deps()) as unknown as { opts: Record<string, unknown> }[];
    expect(fns).toHaveLength(1);
    const worker = JSON.parse(JSON.stringify(fns[0]?.opts)) as Record<string, unknown>;
    expect(worker.id).toBe("fin-qbo-normalize-connection");
    expect(worker.retries).toBe(FIN_NORMALIZE_RETRIES);
    expect(worker.concurrency).toEqual(FIN_NORMALIZE_CONCURRENCY);
    expect(JSON.stringify(worker.triggers)).toContain("fin/qbo-normalize.requested");
  });

  it("the event requires a lane id, a connection uuid and a known trigger, and takes nothing else", async () => {
    expect(LANE_EVENTS).toContain(finQboNormalizeRequested);
    const make = (d: unknown) => (finQboNormalizeRequested.create as (d: unknown) => { validate(): Promise<unknown> })(d);
    await expect(make({ laneId: "PKG", connectionId: A, trigger: "sync" }).validate()).resolves.toBeUndefined();
    for (const bad of [{ connectionId: A, trigger: "sync" }, { laneId: "PKG", connectionId: "x", trigger: "sync" }, { laneId: "PKG", connectionId: A, trigger: "cron" }, { laneId: "PKG", connectionId: A, trigger: "sync", extra: 1 }]) {
      await expect(make(bad).validate(), JSON.stringify(bad)).rejects.toThrow();
    }
  });

  it("the deterministic event id is per connection and sync run", () => {
    expect(finNormalizeEventId(A, "run-1")).toBe(`fin-normalize:${A}:run-1`);
    expect(finNormalizeEventId(A, "run-1")).not.toBe(finNormalizeEventId(B, "run-1"));
    expect(() => finNormalizeEventId("x", "run-1")).toThrow();
    expect(() => finNormalizeEventId(A, "bad run!")).toThrow();
  });
});

describe("worker", () => {
  const data = { laneId: "PKG", connectionId: A, trigger: "sync" };

  it("runs the normalizer for the event's lane and connection", async () => {
    const d = deps();
    expect(await handleFinNormalize(d, data)).toEqual(OK);
    expect(d.runNormalize).toHaveBeenCalledWith("PKG", A);
  });

  it("validates the event again and refuses a lane this deployment does not serve (nothing runs)", async () => {
    const d = deps({ enabledLanes: () => ["PKG"] });
    expect(await handleFinNormalize(d, { ...data, laneId: "APK" })).toEqual({ ok: true, skipped: "lane_not_served" });
    for (const bad of [{}, { laneId: "PKG" }, { ...data, connectionId: "x" }, { ...data, extra: 1 }, { ...data, trigger: "other" }]) {
      await expect(handleFinNormalize(d, bad as never), JSON.stringify(bad)).rejects.toThrow(NonRetriableError);
    }
    expect(d.runNormalize).not.toHaveBeenCalled();
  });

  it("passes a skip through; permanent failures stop at once; transient ones are retried (honouring retry-after)", async () => {
    const skip: FinQboNormalizeResult = { ok: true, skipped: "connection_not_usable" };
    expect(await handleFinNormalize(deps({ runNormalize: async () => skip }), data)).toEqual(skip);
    const fail = (retryable: boolean, retryAfterSeconds: number | null): FinQboNormalizeResult => ({ ok: false, retryable, retryAfterSeconds, errorKind: "x_kind", message: "m SECRET" });
    const permanent = (await handleFinNormalize(deps({ runNormalize: async () => fail(false, null) }), data).catch((e: unknown) => e)) as Error;
    expect(permanent).toBeInstanceOf(NonRetriableError);
    expect(permanent.message).toBe("fin.qbo_normalize failed: x_kind");
    expect(await handleFinNormalize(deps({ runNormalize: async () => fail(true, 7200) }), data).catch((e: unknown) => e)).toBeInstanceOf(RetryAfterError);
    const plain = await handleFinNormalize(deps({ runNormalize: async () => fail(true, null) }), data).catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(Error);
    expect(plain).not.toBeInstanceOf(NonRetriableError);
    expect((plain as Error).message).not.toContain("SECRET");
  });
});

describe("conn.sync afterSync hook", () => {
  const CONN = "00000000-0000-4000-8000-000000000381";
  const synced: ConnSyncResult = { ok: true, skipped: null, runId: "run-9", provider: "quickbooks", kind: "full", received: 1, written: 1 };
  const base = (result: ConnSyncResult, afterSync?: never) => ({ runSync: vi.fn(async () => result), enabledLanes: () => ["PKG"], ...(afterSync ? { afterSync } : {}) });

  it("is called with ids only after a sync that ran, and marks the result", async () => {
    const afterSync = vi.fn(async () => undefined);
    const out = await handleConnSync({ ...base(synced), afterSync }, { laneId: "PKG", connectionId: CONN, trigger: "schedule" }, "r1");
    expect(afterSync).toHaveBeenCalledWith({ laneId: "PKG", connectionId: CONN, provider: "quickbooks", runId: "run-9" });
    expect(out).toMatchObject({ ok: true, followUp: "sent" });
  });

  it("is not called for a skipped sync, a failed one or a lane this deployment does not serve", async () => {
    const afterSync = vi.fn(async () => undefined);
    await handleConnSync({ ...base({ ok: true, skipped: "already_running" }), afterSync }, { laneId: "PKG", connectionId: CONN, trigger: "schedule" }, null);
    await handleConnSync({ ...base(synced), afterSync }, { laneId: "APK", connectionId: CONN, trigger: "schedule" }, null);
    await expect(handleConnSync({ ...base({ ok: false, retryable: false, retryAfterSeconds: null, errorKind: "forbidden", message: "m" }), afterSync }, { laneId: "PKG", connectionId: CONN, trigger: "schedule" }, null)).rejects.toThrow(NonRetriableError);
    expect(afterSync).not.toHaveBeenCalled();
  });

  it("its failure never fails or repeats the sync (the result says so)", async () => {
    const d = { ...base(synced), afterSync: vi.fn(async () => { throw new Error("queue SECRET"); }) };
    const out = await handleConnSync(d, { laneId: "PKG", connectionId: CONN, trigger: "schedule" }, null);
    expect(out).toMatchObject({ ok: true, followUp: "failed" });
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(d.runSync).toHaveBeenCalledTimes(1);
  });

  it("a result without a provider (older runner) triggers nothing", async () => {
    const noProvider = { ok: true, skipped: null, runId: "run-9", kind: "full", received: 1, written: 1 } as const;
    const afterSync = vi.fn(async () => undefined);
    await handleConnSync({ ...base(noProvider), afterSync }, { laneId: "PKG", connectionId: CONN, trigger: "schedule" }, null);
    expect(afterSync).not.toHaveBeenCalled();
  });
});
