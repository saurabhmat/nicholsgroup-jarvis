// retention.purge job, registry, default tables and store (T-042). In-memory parts; the SQL is covered by pgTAP 200.
import { describe, expect, it, vi } from "vitest";
import { createRetentionPurgeJob } from "./job";
import { createRetentionRegistry } from "./registry";
import { createRetentionStore, RetentionStoreError } from "./store";
import { retentionSettingsFrom } from "./settings";
import { defaultRetentionTables } from "./tables";
import type { RetentionDays, RetentionTable } from "./types";
import type { ConnectorLogger } from "../log/index";

const DAYS: RetentionDays = { comms: 90, calendar: 180, conversations: 180, webhooks: 30 };
const silent = (): ConnectorLogger & { events: { event: string; fields: Record<string, unknown> }[] } => {
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const l: ConnectorLogger & { events: typeof events } = {
    events,
    debug: () => undefined,
    info: (event, fields = {}) => void events.push({ event, fields }),
    warn: () => undefined,
    error: (event, fields = {}) => void events.push({ event, fields }),
    child: () => l,
  };
  return l;
};
const table = (id: string, cls: RetentionTable["class"], purge: RetentionTable["purge"]): RetentionTable => ({ id, class: cls, purge });

describe("registry", () => {
  it("registers tables, groups them by class, refuses duplicates, bad ids and unknown classes", () => {
    const r = createRetentionRegistry();
    r.register(table("ai.messages", "conversations", async () => 0));
    expect(r.byClass("conversations").map((t) => t.id)).toEqual(["ai.messages"]);
    expect(r.byClass("comms")).toEqual([]);
    expect(() => r.register(table("ai.messages", "conversations", async () => 0))).toThrow();
    expect(() => r.register(table("messages", "comms", async () => 0))).toThrow();
    expect(() => r.register(table("x.y;drop", "comms", async () => 0))).toThrow();
    expect(() => r.register(table("x.y", "nope" as never, async () => 0))).toThrow();
  });
  it("declares tables that are not purged (catalog only), idempotently, and refuses clashes and incomplete entries", () => {
    const r = createRetentionRegistry([table("comms.message_index", "comms", async () => 0)]);
    const keep = { id: "notes.pages", rule: "until_deleted", reason: "Owner-authored." } as const;
    r.declare(keep);
    r.declare({ ...keep }); // identical re-declaration (dev module re-evaluation) is a no-op
    r.declare({ id: "notes.drafts", rule: "own_job", job: "notes-purge", reason: "Own hourly job." });
    expect(r.declarations().map((d) => d.id)).toEqual(["notes.pages", "notes.drafts"]);
    expect(r.list().map((t) => t.id)).toEqual(["comms.message_index"]); // the purge job never sees a declaration
    expect(() => r.declare({ ...keep, reason: "Different." })).toThrow();
    expect(() => r.declare({ id: "comms.message_index", rule: "until_deleted", reason: "x" })).toThrow();
    expect(() => r.register(table("notes.pages", "comms", async () => 0))).toThrow();
    expect(() => r.declare({ id: "bad", rule: "until_deleted", reason: "x" })).toThrow();
    expect(() => r.declare({ id: "a.b", rule: "until_deleted", reason: " " })).toThrow();
    expect(() => r.declare({ id: "a.b", rule: "own_job", reason: "x" })).toThrow();
    expect(() => r.declare({ id: "a.b", rule: "forever" as never, reason: "x" })).toThrow();
  });
});

describe("purge job", () => {
  it("gives each class the lane's days (policy-class tables get null) and counts deletions", async () => {
    const seen: [string, string, number | null][] = [];
    const rec = (id: string, n: number): RetentionTable["purge"] => async (lane, keep) => (seen.push([id, lane, keep]), n);
    const registry = createRetentionRegistry([
      table("comms.message_index", "comms", rec("comms", 3)),
      table("cal.event_index", "calendar", rec("cal", 2)),
      table("core.webhook_events", "webhooks", rec("wh", 1)),
      table("raw.source_records", "policy", rec("raw", 4)),
    ]);
    const log = silent();
    const r = await createRetentionPurgeJob({ registry, settings: async () => DAYS, logger: log }).run("PKG");
    expect(seen).toEqual([["comms", "PKG", 90], ["cal", "PKG", 180], ["wh", "PKG", 30], ["raw", "PKG", null]]);
    expect(r.ok).toBe(true);
    expect(r.results.map((x) => ("deleted" in x ? x.deleted : -1))).toEqual([3, 2, 1, 4]);
    expect(r.emptyClasses).toEqual(["conversations"]); // no conversations table yet: reported, not an error
  });

  it("uses lane-specific settings (policy honoured per lane)", async () => {
    const keeps: Record<string, number | null> = {};
    const registry = createRetentionRegistry([table("comms.message_index", "comms", async (lane, keep) => ((keeps[lane] = keep), 0))]);
    const settings = async (lane: string): Promise<RetentionDays> => ({ ...DAYS, comms: lane === "PKG" ? 90 : 30 });
    const job = createRetentionPurgeJob({ registry, settings, logger: silent() });
    await job.run("PKG");
    await job.run("APK");
    expect(keeps).toEqual({ PKG: 90, APK: 30 });
  });

  it("a failing table does not stop the others; the result is not ok and holds no error detail", async () => {
    const ran: string[] = [];
    const registry = createRetentionRegistry([
      table("comms.message_index", "comms", async () => {
        throw new Error("row 42 subject: secret text");
      }),
      table("cal.event_index", "calendar", async () => (ran.push("cal"), 5)),
    ]);
    const log = silent();
    const r = await createRetentionPurgeJob({ registry, settings: async () => DAYS, logger: log }).run("PKG");
    expect(ran).toEqual(["cal"]);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(JSON.stringify(log.events)).not.toContain("secret");
    expect(r.results[1]).toEqual({ table: "cal.event_index", class: "calendar", deleted: 5 });
  });

  it("logs counts only", async () => {
    const log = silent();
    await createRetentionPurgeJob({ registry: createRetentionRegistry([table("comms.message_index", "comms", async () => 7)]), settings: async () => DAYS, logger: log }).run("PKG");
    const first = log.events[0];
    expect(first?.fields).toEqual({ table: "comms.message_index", class: "comms", keepDays: 90, deleted: 7 });
  });

  it("a class whose days cannot be read is skipped and reported; the other classes and the policy-driven purge still run", async () => {
    const calls: string[] = [];
    const rec = (id: string): RetentionTable["purge"] => async () => (calls.push(id), 1);
    const registry = createRetentionRegistry([
      table("comms.message_index", "comms", rec("comms")),
      table("cal.event_index", "calendar", rec("cal")),
      table("raw.source_records", "policy", rec("raw")),
    ]);
    const log = silent();
    // lane_config.retention unreadable: only comms days (from the lane policy) are known
    const r = await createRetentionPurgeJob({ registry, settings: async () => ({ comms: 90 }), logger: log }).run("PKG");
    expect(calls).toEqual(["comms", "raw"]);
    expect(r.ok).toBe(false);
    expect(r.results[1]).toEqual({ table: "cal.event_index", class: "calendar", error: "settings_unavailable" });
    // nothing readable at all: the body purge still runs, everything else is reported
    calls.length = 0;
    const none = await createRetentionPurgeJob({ registry, settings: async () => Promise.reject(new Error("db")), logger: silent() }).run("PKG");
    expect(calls).toEqual(["raw"]);
    expect(none.ok).toBe(false);
  });

  it("a bad lane is refused without purging", async () => {
    const purge = vi.fn(async () => 0);
    const job = createRetentionPurgeJob({ registry: createRetentionRegistry([table("comms.message_index", "comms", purge)]), settings: async () => DAYS, logger: silent() });
    await expect(job.run("pkg")).rejects.toThrow();
    expect(purge).not.toHaveBeenCalled();
  });
});

describe("default tables", () => {
  const mk = () => {
    const store = {
      purgeMessageIndex: vi.fn(async () => 1),
      purgeEventIndex: vi.fn(async () => 2),
      purgeSourceRecordBodies: vi.fn(async () => 3),
      purgeConnectorApiErrors: vi.fn(async () => 5),
    };
    const webhooks = { purge: vi.fn(async () => 4) };
    return { store, webhooks, registry: createRetentionRegistry(defaultRetentionTables({ store, webhooks })) };
  };

  it("registers comms, calendar, webhooks and raw bodies; each calls its SQL purge with the lane's days", async () => {
    const { store, webhooks, registry } = mk();
    expect(registry.list().map((t) => `${t.id}:${t.class}`)).toEqual([
      "comms.message_index:comms",
      "cal.event_index:calendar",
      "core.webhook_events:webhooks",
      "raw.source_records:policy",
      "core.connector_api_errors:policy",
    ]);
    const r = await createRetentionPurgeJob({ registry, settings: async () => ({ comms: 90, calendar: 120, conversations: 180, webhooks: 14 }), logger: silent() }).run("PKG");
    expect(store.purgeMessageIndex).toHaveBeenCalledWith("PKG", 90);
    expect(store.purgeEventIndex).toHaveBeenCalledWith("PKG", 120);
    expect(webhooks.purge).toHaveBeenCalledWith("PKG", 14);
    expect(store.purgeSourceRecordBodies).toHaveBeenCalledWith("PKG");
    // T-196: the connector error log has a fixed 90-day window in SQL; the job passes the lane only (no days to widen it).
    expect(store.purgeConnectorApiErrors).toHaveBeenCalledWith("PKG");
    expect(r.ok).toBe(true);
  });

  it("a day-based table refuses to run without days", async () => {
    const { registry } = mk();
    const comms = registry.byClass("comms")[0];
    await expect(comms?.purge("PKG", null)).rejects.toThrow();
  });

  it("a lane with store_content_bodies off purges raw bodies: the body purge runs for every lane (the database decides)", async () => {
    const { store, registry } = mk();
    const job = createRetentionPurgeJob({ registry, settings: async () => DAYS, logger: silent() });
    await job.run("PKG");
    await job.run("APK");
    expect(store.purgeSourceRecordBodies.mock.calls).toEqual([["PKG"], ["APK"]]);
  });
});

describe("store", () => {
  const mkClient = (result: { data?: unknown; error?: unknown } | (() => never)) => {
    const calls: { schema: string; fn: string; args: Record<string, unknown> }[] = [];
    const client = {
      schema: (schema: string) => ({
        rpc: async (fn: string, args: Record<string, unknown>) => {
          calls.push({ schema, fn, args });
          return typeof result === "function" ? result() : { data: result.data ?? null, error: result.error ?? null };
        },
      }),
    };
    return { calls, clientFor: vi.fn(async () => client as never) };
  };

  it("calls the core purge functions with the lane and an interval, via the lane's client", async () => {
    const { calls, clientFor } = mkClient({ data: 5 });
    const store = createRetentionStore(clientFor);
    expect(await store.purgeMessageIndex("PKG", 90)).toBe(5);
    await store.purgeEventIndex("PKG", 180);
    await store.purgeSourceRecordBodies("PKG");
    await store.purgeConnectorApiErrors("PKG");
    expect(clientFor).toHaveBeenCalledWith("PKG");
    expect(calls).toEqual([
      { schema: "core", fn: "retention_comms_purge", args: { p_lane: "PKG", p_keep: "90 days" } },
      { schema: "core", fn: "retention_cal_purge", args: { p_lane: "PKG", p_keep: "180 days" } },
      { schema: "core", fn: "source_records_purge_bodies", args: { p_lane: "PKG" } },
      { schema: "core", fn: "connector_api_errors_purge", args: { p_lane: "PKG" } },
    ]);
  });

  it("an unexpected return value is an error, not a zero", async () => {
    for (const data of [null, "3", 1.5, -1]) await expect(createRetentionStore(mkClient({ data }).clientFor).purgeSourceRecordBodies("PKG")).rejects.toBeInstanceOf(RetentionStoreError);
  });

  it("fails with a fixed message and no database text; refuses bad day counts without calling", async () => {
    const { clientFor, calls } = mkClient({ error: { message: "secret db text", code: "42501" } });
    const store = createRetentionStore(clientFor);
    const err = await store.purgeMessageIndex("PKG", 90).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetentionStoreError);
    expect(String((err as Error).message)).not.toContain("secret");
    expect(calls).toHaveLength(1);
    for (const d of [0, -1, 1.5, Number.NaN]) await expect(store.purgeEventIndex("PKG", d)).rejects.toBeInstanceOf(RetentionStoreError);
    expect(calls).toHaveLength(1);
    await expect(createRetentionStore(vi.fn(async () => Promise.reject(new Error("no lane")))).purgeSourceRecordBodies("PKG")).rejects.toBeInstanceOf(RetentionStoreError);
  });
});

describe("retentionSettingsFrom (T-042 review L1)", () => {
  const cfg = { calendarDays: 180, conversationsDays: 180, webhookDays: 30 };
  it("a bad lane_config still gives the comms days, so the comms and body purges run", async () => {
    const s = retentionSettingsFrom({ retentionDays: async () => 90, retentionConfig: async () => { throw new Error("invalid lane_config"); } });
    expect(await s("PKG")).toEqual({ comms: 90 });
  });
  it("an unreadable policy still gives the lane_config classes", async () => {
    const s = retentionSettingsFrom({ retentionDays: async () => { throw new Error("no policy"); }, retentionConfig: async () => cfg });
    expect(await s("PKG")).toEqual({ calendar: 180, conversations: 180, webhooks: 30 });
  });
  it("both readable: every class, read for the asked lane", async () => {
    const lanes: string[] = [];
    const s = retentionSettingsFrom({ retentionDays: async (l) => (lanes.push(l), 90), retentionConfig: async (l) => (lanes.push(l), cfg) });
    expect(await s("APK")).toEqual({ comms: 90, calendar: 180, conversations: 180, webhooks: 30 });
    expect(lanes).toEqual(["APK", "APK"]);
  });
});

