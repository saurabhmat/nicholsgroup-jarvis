// conn.token_health / conn.subscriptions_renew Inngest functions (T-040): cron and concurrency config, lane fan-out,
// failure translation, lane check, attention event shape. Synthetic data only.
import { Inngest, NonRetriableError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import {
  CONN_HEALTH_CONCURRENCY, CONN_HEALTH_CRON, CONN_HEALTH_RETRIES, CONN_RENEW_CONCURRENCY, CONN_RENEW_CRON,
  attentionEvents, connHealthFunctions, handleConnHealthCheck, handleConnRenew, planFanOut,
  type ConnHealthDeps, type ConnHealthResult, type ConnRenewDeps, type ConnRenewResult,
} from "./conn-health";
import { CONN_ATTENTION_REASONS, connAttentionNeeded, connHealthCheckRequested, connSubscriptionRenewRequested, LANE_EVENTS } from "./events";

const A = "00000000-0000-4000-8000-000000000401";
const B = "00000000-0000-4000-8000-000000000402";
const ok: ConnHealthResult = { ok: true, skipped: null, alerts: [] };

const healthDeps = (result: ConnHealthResult = ok, lanes = ["PKG"]): ConnHealthDeps & { check: ReturnType<typeof vi.fn> } => ({
  enabledLanes: () => lanes,
  listConnectionIds: async (l) => (l === "PKG" ? [A] : [B]),
  check: vi.fn(async () => result),
});
const renewDeps = (result: ConnRenewResult = ok, lanes = ["PKG"]): ConnRenewDeps & { renew: ReturnType<typeof vi.fn> } => ({
  enabledLanes: () => lanes,
  listConnectionIds: async () => [A],
  renew: vi.fn(async () => result),
});

type Fn = { opts: Record<string, unknown> };
const fns = () => connHealthFunctions(new Inngest({ id: "test-app", isDev: true }), healthDeps(), renewDeps()) as unknown as Fn[];
const byId = (id: string) => fns().find((f) => (f.opts as { id: string }).id === id) as Fn;
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Record<string, unknown>;

describe("function config", () => {
  it("registers the four functions with unique ids", () => {
    expect(fns().map((f) => (f.opts as { id: string }).id).sort()).toEqual([
      "conn-subscriptions-renew", "conn-subscriptions-renew-scan", "conn-token-health", "conn-token-health-scan",
    ]);
  });

  it("the scans are cron-triggered, daily and twice daily", () => {
    expect(CONN_HEALTH_CRON).toBe("0 11 * * *");
    expect(CONN_RENEW_CRON).toBe("15 */12 * * *");
    expect(json(byId("conn-token-health-scan").opts).triggers).toEqual([{ cron: CONN_HEALTH_CRON }]);
    expect(json(byId("conn-subscriptions-renew-scan").opts).triggers).toEqual([{ cron: CONN_RENEW_CRON }]);
    // Scans are not retried (the listing is saved in a step, so a retry would only replay it).
    expect(json(byId("conn-token-health-scan").opts).retries).toBe(0);
    expect(json(byId("conn-subscriptions-renew-scan").opts).retries).toBe(0);
  });

  it("the workers are keyed by connection id with one run at a time, and retried", () => {
    expect(CONN_HEALTH_CONCURRENCY).toEqual({ key: 'event.data.laneId + ":" + event.data.connectionId', limit: 1 });
    expect(CONN_RENEW_CONCURRENCY).toEqual({ key: 'event.data.laneId + ":" + event.data.connectionId', limit: 1 });
    for (const id of ["conn-token-health", "conn-subscriptions-renew"]) {
      const o = json(byId(id).opts);
      expect(o.concurrency).toEqual({ key: 'event.data.laneId + ":" + event.data.connectionId', limit: 1 });
      expect(o.rateLimit).toEqual({ key: 'event.data.laneId + ":" + event.data.connectionId', limit: 1, period: "1h" });
      expect(o.retries).toBe(CONN_HEALTH_RETRIES);
      expect(CONN_HEALTH_RETRIES).toBeGreaterThanOrEqual(1);
    }
    const names = (id: string) => (json(byId(id).opts).triggers as { event?: string }[]).map((t) => t.event);
    expect(names("conn-token-health")).toEqual(["conn/health.check.requested"]);
    expect(names("conn-subscriptions-renew")).toEqual(["conn/subscription.renew.requested"]);
  });
});

describe("events", () => {
  it("require a lane and carry ids and enums only", async () => {
    const v = (e: unknown, d: unknown) => (e as { schema: { "~standard": { validate(x: unknown): { issues?: unknown } | Promise<{ issues?: unknown }> } } }).schema["~standard"].validate(d);
    expect((await v(connHealthCheckRequested, { connectionId: A })).issues).toBeDefined();
    expect((await v(connHealthCheckRequested, { laneId: "PKG", connectionId: A })).issues).toBeUndefined();
    expect((await v(connSubscriptionRenewRequested, { laneId: "PKG", connectionId: A, x: 1 })).issues).toBeDefined();
    const attn = { laneId: "PKG", connectionId: A, provider: "quickbooks", reason: "token_expiring", daysLeft: 3 };
    expect((await v(connAttentionNeeded, attn)).issues).toBeUndefined();
    expect((await v(connAttentionNeeded, { ...attn, message: "free text" })).issues).toBeDefined();
    expect((await v(connAttentionNeeded, { ...attn, reason: "other" })).issues).toBeDefined();
    expect((await v(connAttentionNeeded, { ...attn, laneId: undefined })).issues).toBeDefined();
    expect(CONN_ATTENTION_REASONS).toContain("health_check_failed");
    for (const e of [connHealthCheckRequested, connSubscriptionRenewRequested, connAttentionNeeded]) expect(LANE_EVENTS).toContain(e);
  });
});

describe("planFanOut", () => {
  it("lists per enabled lane and tags every target with its lane", async () => {
    const plan = await planFanOut(healthDeps(ok, ["PKG", "APK"]));
    expect(plan.targets).toEqual([{ laneId: "PKG", connectionId: A }, { laneId: "APK", connectionId: B }]);
  });

  it("a lane whose listing fails does not block the others and echoes no database text", async () => {
    const plan = await planFanOut({
      enabledLanes: () => ["PKG", "APK"],
      listConnectionIds: async (l) => { if (l === "PKG") throw new Error("password=hunter2 relation x"); return [B]; },
    });
    expect(plan.targets).toEqual([{ laneId: "APK", connectionId: B }]);
    expect(plan.failedLanes).toEqual(["PKG"]);
    expect(JSON.stringify(plan)).not.toContain("hunter2");
  });

  it("sends nothing when no lane is enabled", async () => {
    expect((await planFanOut(healthDeps(ok, []))).targets).toEqual([]);
  });
});

describe("handleConnHealthCheck / handleConnRenew", () => {
  it("passes lane and connection to the job and returns its alerts", async () => {
    const alerts = [{ provider: "quickbooks", reason: "token_expiring" as const, daysLeft: 2 }];
    const d = healthDeps({ ok: true, skipped: null, alerts });
    await expect(handleConnHealthCheck(d, { laneId: "PKG", connectionId: A })).resolves.toMatchObject({ alerts });
    expect(d.check).toHaveBeenCalledWith("PKG", A);
    const r = renewDeps();
    await handleConnRenew(r, { laneId: "PKG", connectionId: A });
    expect(r.renew).toHaveBeenCalledWith("PKG", A);
  });

  it("refuses malformed events without calling the job", async () => {
    const d = healthDeps();
    for (const bad of [{ connectionId: A }, { laneId: "PKG", connectionId: "x" }, { laneId: "pkg", connectionId: A }, { laneId: "PKG", connectionId: A, extra: 1 }]) {
      await expect(handleConnHealthCheck(d, bad as never)).rejects.toBeInstanceOf(NonRetriableError);
      await expect(handleConnRenew(renewDeps(), bad as never)).rejects.toBeInstanceOf(NonRetriableError);
    }
    expect(d.check).not.toHaveBeenCalled();
  });

  it("does nothing for a lane this deployment does not serve", async () => {
    const d = healthDeps(ok, ["PKG"]);
    await expect(handleConnHealthCheck(d, { laneId: "APK", connectionId: A })).resolves.toEqual({ ok: true, skipped: "lane_not_served", alerts: [] });
    expect(d.check).not.toHaveBeenCalled();
  });

  it("retries transient failures and stops on permanent ones", async () => {
    const transient = healthDeps({ ok: false, retryable: true, errorKind: "transient" });
    const e1 = await handleConnHealthCheck(transient, { laneId: "PKG", connectionId: A }).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(Error);
    expect(e1).not.toBeInstanceOf(NonRetriableError);
    const perm = healthDeps({ ok: false, retryable: false, errorKind: "not_found" });
    await expect(handleConnHealthCheck(perm, { laneId: "PKG", connectionId: A })).rejects.toBeInstanceOf(NonRetriableError);
    await expect(handleConnRenew(renewDeps({ ok: false, retryable: false, errorKind: "forbidden" }), { laneId: "PKG", connectionId: A })).rejects.toBeInstanceOf(NonRetriableError);
  });

  it("one connection failing does not affect another (independent calls)", async () => {
    const d = healthDeps();
    d.check = vi.fn(async (_l: string, id: string): Promise<ConnHealthResult> => (id === A ? { ok: false, retryable: true, errorKind: "transient" } : ok));
    const [x, y] = await Promise.allSettled([handleConnHealthCheck(d, { laneId: "PKG", connectionId: A }), handleConnHealthCheck(d, { laneId: "PKG", connectionId: B })]);
    expect(x.status).toBe("rejected");
    expect(y.status).toBe("fulfilled");
  });
});

describe("attentionEvents", () => {
  it("builds lane-scoped events with a per-day id, and drops an alert that fails the schema", async () => {
    const now = new Date("2026-11-05T12:00:00Z");
    const events = await attentionEvents("PKG", A, [
      { provider: "quickbooks", reason: "token_expiring", daysLeft: 3 },
      { provider: "Bad Provider!", reason: "health_check_failed", errorKind: "forbidden" },
      { provider: "quickbooks", reason: "health_check_failed", errorKind: "free text with spaces" },
    ], now);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: "conn/attention.needed", id: `attn:PKG:${A}:token_expiring:2026-11-05`, data: { laneId: "PKG", connectionId: A, daysLeft: 3 } });
  });
});
