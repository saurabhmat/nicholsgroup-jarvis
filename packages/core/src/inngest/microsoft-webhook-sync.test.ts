// microsoft.webhook_sync (T-068, T-264): accepted Microsoft change notifications -> one debounced conn/sync.requested per connection and stream.
import { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { connSyncRequested } from "./events";
import { MICROSOFT_WEBHOOK_BATCH, handleMicrosoftWebhookSync, microsoftWebhookSyncEventId, microsoftWebhookSyncFunctions, type MicrosoftWebhookSyncDeps } from "./microsoft-webhook-sync";

const CONN = "00000000-0000-4000-8000-000000006801";
const CONN_B = "00000000-0000-4000-8000-000000006802";
const ev = (eventId: string, eventType: string, over: Record<string, unknown> = {}) => ({ laneId: "PKG", provider: "microsoft", connectionId: CONN, eventId, eventType, refs: [], ...over });

function setup(over: Partial<MicrosoftWebhookSyncDeps> = {}) {
  const sent: { id: string; events: ReturnType<typeof connSyncRequested.create>[] }[] = [];
  const deps: MicrosoftWebhookSyncDeps = { isUsable: vi.fn(async () => true), enabledLanes: () => ["PKG", "APK"], ...over };
  const step = {
    run: async <T>(_id: string, fn: () => T | Promise<T>) => fn(),
    sendEvent: async (id: string, events: ReturnType<typeof connSyncRequested.create>[]) => void sent.push({ id, events }),
  };
  return { deps, step, sent, run: (events: unknown[]) => handleMicrosoftWebhookSync(deps, events, step) };
}

describe("microsoft.webhook_sync", () => {
  it("batches by lane and connection for up to 10 seconds from the first event, at most 5 per batch, and is triggered by the typed webhook/received event", () => {
    expect(MICROSOFT_WEBHOOK_BATCH.key).toContain("event.data.laneId");
    expect(MICROSOFT_WEBHOOK_BATCH.key).toContain("event.data.connectionId");
    expect(MICROSOFT_WEBHOOK_BATCH.maxSize).toBeLessThanOrEqual(5);
    expect(MICROSOFT_WEBHOOK_BATCH.timeout).toBe("10s");
    const fn = microsoftWebhookSyncFunctions(new Inngest({ id: "test-app", isDev: true }), setup().deps)[0] as unknown as { opts: Record<string, unknown> };
    const opts = JSON.parse(JSON.stringify(fn.opts)) as { id: string; batchEvents: unknown };
    expect(opts.id).toBe("microsoft-webhook-sync");
    expect(opts.batchEvents).toEqual(MICROSOFT_WEBHOOK_BATCH);
  });

  it("a burst of mail notifications is ONE sync request of the mail stream only (trigger webhook, lane in the event, deterministic id)", async () => {
    const { run, sent } = setup();
    const out = await run([ev("e1", "mail.changed"), ev("e2", "mail.changed"), ev("e3", "mail.missed")]);
    expect(out.requested).toBe(1);
    expect(sent).toHaveLength(1);
    const e = sent[0]?.events[0];
    expect(e?.name).toBe("conn/sync.requested");
    expect(e?.data).toEqual({ laneId: "PKG", connectionId: CONN, trigger: "webhook", streams: ["mail"] });
    expect(e?.id).toBe(microsoftWebhookSyncEventId("PKG", CONN, "mail", ["e1", "e2", "e3"]));
    expect((await connSyncRequested.schema["~standard"].validate(e?.data)).issues).toBeUndefined();
  });

  it("mail and calendar notifications of one connection are two requests, one per stream", async () => {
    const { run, sent } = setup();
    const out = await run([ev("e1", "mail.changed"), ev("e2", "calendar.changed")]);
    expect(out.requested).toBe(2);
    expect(sent.flatMap((s) => s.events).map((e) => e.data.streams)).toEqual([["mail"], ["calendar"]]);
  });

  it("the event id is stable for a replayed batch and differs by connection, stream, lane and content", () => {
    expect(microsoftWebhookSyncEventId("PKG", CONN, "mail", ["a", "b"])).toBe(microsoftWebhookSyncEventId("PKG", CONN, "mail", ["b", "a", "a"]));
    expect(microsoftWebhookSyncEventId("PKG", CONN, "mail", ["a"])).not.toBe(microsoftWebhookSyncEventId("PKG", CONN, "calendar", ["a"]));
    expect(microsoftWebhookSyncEventId("PKG", CONN, "mail", ["a"])).not.toBe(microsoftWebhookSyncEventId("PKG", CONN_B, "mail", ["a"]));
    expect(microsoftWebhookSyncEventId("PKG", CONN, "mail", ["a"])).not.toBe(microsoftWebhookSyncEventId("APK", CONN, "mail", ["a"]));
    expect(microsoftWebhookSyncEventId("PKG", CONN, "mail", ["a"])).not.toBe(microsoftWebhookSyncEventId("PKG", CONN, "mail", ["a", "c"]));
  });

  it("sends nothing for a connection that is not usable, and checks the right lane and connection", async () => {
    const isUsable = vi.fn(async (_lane: string, connectionId: string) => connectionId === CONN_B);
    const { run, sent } = setup({ isUsable });
    const out = await run([ev("e1", "mail.changed"), ev("e2", "mail.changed", { connectionId: CONN_B })]);
    expect(isUsable).toHaveBeenCalledWith("PKG", CONN);
    expect(out).toMatchObject({ requested: 1, skipped: { not_usable: 1 } });
    expect(sent[0]?.events[0]?.data.connectionId).toBe(CONN_B);
  });

  it("keeps lanes apart: the same connection id in two lanes is two groups, each checked against its own lane", async () => {
    const isUsable = vi.fn(async () => true);
    const { run, sent } = setup({ isUsable });
    await run([ev("e1", "mail.changed"), ev("e1", "mail.changed", { laneId: "APK" })]);
    expect(isUsable.mock.calls.map((c) => c.join("/")).sort()).toEqual([`APK/${CONN}`, `PKG/${CONN}`]);
    expect(sent.flatMap((s) => s.events).map((e) => e.data.laneId).sort()).toEqual(["APK", "PKG"]);
  });

  it("ignores other providers (QuickBooks has its own function), lanes this deployment does not serve, lifecycle or unknown event types and malformed events, without a connection check", async () => {
    const isUsable = vi.fn(async () => true);
    const { run, sent } = setup({ isUsable, enabledLanes: () => ["PKG"] });
    const out = await run([
      ev("e1", "mail.changed", { provider: "quickbooks" }),
      ev("e2", "mail.changed", { laneId: "NC" }),
      ev("e3", "mail.reauthorizationRequired"),
      ev("e4", "Invoice.update"),
      ev("e5", "mail.changed", { connectionId: "not-a-uuid" }),
      { nope: true },
    ]);
    expect(out).toEqual({ requested: 0, skipped: { not_microsoft: 1, invalid: 2, lane_not_served: 1, not_usable: 0, not_a_change: 2 } });
    expect(isUsable).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("an infrastructure failure of the check is rethrown so the job retries instead of dropping the change", async () => {
    const { run } = setup({ isUsable: async () => { throw new Error("db down"); } });
    await expect(run([ev("e1", "mail.changed")])).rejects.toThrow("db down");
  });
});
