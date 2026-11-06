// qbo.webhook_sync (T-053): accepted QuickBooks webhook events -> one targeted conn/sync.requested per connection.
import { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { connSyncRequested } from "./events";
import { QBO_WEBHOOK_BATCH, handleQboWebhookSync, qboWebhookSyncEventId, qboWebhookSyncFunctions, type QboWebhookSyncDeps } from "./qbo-webhook-sync";

const CONN = "00000000-0000-4000-8000-000000000531";
const CONN_B = "00000000-0000-4000-8000-000000000532";
const ENTITIES = ["Account", "Class", "Customer", "Vendor", "Invoice", "Payment", "Bill", "BillPayment", "Purchase", "Deposit", "JournalEntry"];
const ev = (eventId: string, refs: { type: string; id: string }[], over: Record<string, unknown> = {}) => ({
  laneId: "PKG", provider: "quickbooks", connectionId: CONN, eventId, eventType: "Invoice.update", refs, ...over,
});

function setup(over: Partial<QboWebhookSyncDeps> = {}) {
  const sent: { id: string; events: ReturnType<typeof connSyncRequested.create>[] }[] = [];
  const deps: QboWebhookSyncDeps = { isUsable: vi.fn(async () => true), enabledLanes: () => ["PKG"], allowedEntities: ENTITIES, ...over };
  const step = {
    run: async <T>(_id: string, fn: () => T | Promise<T>) => fn(),
    sendEvent: async (id: string, events: ReturnType<typeof connSyncRequested.create>[]) => void sent.push({ id, events }),
  };
  return { deps, step, sent, run: (events: unknown[]) => handleQboWebhookSync(deps, events, step) };
}

describe("qbo.webhook_sync", () => {
  it("batches by connection and is triggered by the typed webhook/received event", () => {
    expect(QBO_WEBHOOK_BATCH.key).toContain("event.data.laneId");
    expect(QBO_WEBHOOK_BATCH.key).toContain("event.data.connectionId");
    // the Inngest plan in use refuses a batch larger than 5 at app sync (Nov 6, 2026)
    expect(QBO_WEBHOOK_BATCH.maxSize).toBeLessThanOrEqual(5);
    const fn = qboWebhookSyncFunctions(new Inngest({ id: "test-app", isDev: true }), setup().deps)[0] as unknown as { opts: Record<string, unknown> };
    const opts = JSON.parse(JSON.stringify(fn.opts)) as { id: string; batchEvents: unknown };
    expect(opts.id).toBe("qbo-webhook-sync");
    expect(opts.batchEvents).toEqual(QBO_WEBHOOK_BATCH);
  });

  it("requests one targeted sync (trigger webhook, sorted entity names, lane in the event, deterministic id) for a batch", async () => {
    const { run, sent } = setup();
    const out = await run([ev("e1", [{ type: "Invoice", id: "1" }]), ev("e2", [{ type: "Bill", id: "2" }]), ev("e3", [{ type: "Invoice", id: "3" }])]);
    expect(out.requested).toBe(1);
    expect(sent).toHaveLength(1);
    const e = sent[0]?.events[0];
    expect(e?.name).toBe("conn/sync.requested");
    expect(e?.data).toEqual({ laneId: "PKG", connectionId: CONN, trigger: "webhook", objectTypes: ["Bill", "Invoice"] });
    expect(e?.id).toBe(qboWebhookSyncEventId("PKG", CONN, ["e1", "e2", "e3"]));
    expect((await connSyncRequested.schema["~standard"].validate(e?.data)).issues).toBeUndefined();
  });

  it("the event id is stable for a replayed batch (any order, duplicates) and differs by connection and content", () => {
    expect(qboWebhookSyncEventId("PKG", CONN, ["a", "b"])).toBe(qboWebhookSyncEventId("PKG", CONN, ["b", "a", "a"]));
    expect(qboWebhookSyncEventId("PKG", CONN, ["a", "b"])).not.toBe(qboWebhookSyncEventId("PKG", CONN, ["a", "c"]));
    expect(qboWebhookSyncEventId("PKG", CONN, ["a"])).not.toBe(qboWebhookSyncEventId("PKG", CONN_B, ["a"]));
    expect(qboWebhookSyncEventId("PKG", CONN, ["a"])).not.toBe(qboWebhookSyncEventId("APK", CONN, ["a"]));
  });

  it("sends nothing for a connection that is not usable (reconnect_required, disconnected, unknown), and checks the right lane and connection", async () => {
    const isUsable = vi.fn(async (_lane: string, connectionId: string) => connectionId === CONN_B);
    const { run, sent } = setup({ isUsable });
    const out = await run([ev("e1", [{ type: "Invoice", id: "1" }]), ev("e2", [{ type: "Bill", id: "2" }], { connectionId: CONN_B })]);
    expect(isUsable).toHaveBeenCalledWith("PKG", CONN);
    expect(out).toMatchObject({ requested: 1, skipped: { not_usable: 1 } });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events[0]?.data.connectionId).toBe(CONN_B);
  });

  it("keeps lanes apart: the same connection id in two lanes is two groups, each checked against its own lane", async () => {
    const isUsable = vi.fn(async () => true);
    const { run, sent } = setup({ isUsable, enabledLanes: () => ["PKG", "APK"] });
    await run([ev("e1", [{ type: "Invoice", id: "1" }]), ev("e1", [{ type: "Invoice", id: "1" }], { laneId: "APK" })]);
    expect(isUsable.mock.calls.map((c) => c.join("/"))).toEqual([`PKG/${CONN}`, `APK/${CONN}`]);
    expect(sent.map((s) => s.events[0]?.data.laneId)).toEqual(["PKG", "APK"]);
    expect(new Set(sent.map((s) => s.id)).size).toBe(2); // step ids differ by lane
    expect(new Set(sent.map((s) => s.events[0]?.id)).size).toBe(2);
  });

  it("drops entity names outside the allowlist (retrieved data is untrusted) and sends nothing when none are left", async () => {
    const { run, sent } = setup();
    const out = await run([ev("e1", [{ type: "Employee", id: "1" }, { type: "constructor", id: "2" }]), ev("e2", [{ type: "Employee", id: "1" }, { type: "Customer", id: "9" }])]);
    expect(out).toMatchObject({ requested: 1, skipped: { no_entities: 1 } });
    expect(sent[0]?.events[0]?.data).toMatchObject({ objectTypes: ["Customer"] });
    const none = setup();
    expect((await none.run([ev("e1", [{ type: "Employee", id: "1" }])])).requested).toBe(0);
    expect(none.sent).toHaveLength(0);
  });

  it("ignores other providers, lanes this deployment does not serve and malformed events, without calling the connection check", async () => {
    const { run, sent, deps } = setup();
    const out = await run([
      ev("e1", [{ type: "Invoice", id: "1" }], { provider: "stripe" }),
      ev("e2", [{ type: "Invoice", id: "1" }], { laneId: "NL" }),
      { laneId: "PKG", provider: "quickbooks" },
      "junk",
      null,
      ev("e3", [{ type: "Invoice", id: "1" }], { extra: 1 }),
    ]);
    expect(out).toEqual({ requested: 0, skipped: { not_quickbooks: 1, invalid: 4, lane_not_served: 1, not_usable: 0, no_entities: 0 } });
    expect(deps.isUsable).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});
