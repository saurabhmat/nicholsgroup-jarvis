// mail.ingest_delta (T-238): cron offset from the calendar's, fan-out per enabled lane and mailbox, ids only, deterministic event
// ids, lane isolation, streams ["mail"], and when a briefing refresh is asked for (only a scheduled mail-only run that wrote).
import { Inngest, NonRetriableError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { CAL_INGEST_CRON } from "./cal-ingest";
import { briefingRefreshRequested, connSyncRequested } from "./events";
import {
  MAIL_INGEST_CRON,
  MAIL_INGEST_RETRIES,
  briefingRefreshEventId,
  handleMailIngest,
  mailIngestEventId,
  mailIngestFunction,
  mailIngestSlot,
  shouldRefreshBriefingAfterSync,
  type MailIngestDeps,
} from "./mail-ingest";

const A = "00000000-0000-4000-8000-000000000b01";
const B = "00000000-0000-4000-8000-000000000b02";
const C = "00000000-0000-4000-8000-000000000b03";
const TS = Date.parse("2026-11-05T12:22:00Z");

const deps = (over: Partial<MailIngestDeps> = {}): MailIngestDeps & { listConnections: ReturnType<typeof vi.fn> } => ({
  enabledLanes: () => ["PKG"],
  ...over,
  listConnections: vi.fn(over.listConnections ?? (async () => [A, B])),
});

const fakeStep = () => {
  const sent: { id: string; events: { name: string; id?: string; data: unknown }[] }[] = [];
  const step = {
    run: async <T,>(_id: string, fn: () => T | Promise<T>) => fn(),
    sendEvent: async (id: string, events: { name: string; id?: string; data: unknown }[]) => { sent.push({ id, events }); },
  };
  return { step: step as never, sent };
};

describe("config", () => {
  it("is the mail-ingest-delta function, every 15 minutes, offset from the calendar's ticks", () => {
    expect(MAIL_INGEST_CRON).toBe("7-59/15 * * * *");
    expect(MAIL_INGEST_CRON).not.toBe(CAL_INGEST_CRON);
    const fn = mailIngestFunction(new Inngest({ id: "test-app", isDev: true }), deps()) as unknown as { opts: Record<string, unknown> };
    const opts = JSON.parse(JSON.stringify(fn.opts)) as Record<string, unknown>;
    expect(opts.id).toBe("mail-ingest-delta");
    expect(opts.triggers).toEqual([{ cron: MAIL_INGEST_CRON }]);
    expect(opts.retries).toBe(MAIL_INGEST_RETRIES);
  });
});

describe("slot and event ids", () => {
  it("are deterministic per connection and tick", () => {
    expect(mailIngestSlot(Date.parse("2026-11-05T12:07:00Z"))).toBe(mailIngestSlot(Date.parse("2026-11-05T12:14:59Z")));
    expect(mailIngestSlot(Date.parse("2026-11-05T12:15:00Z"))).toBe(mailIngestSlot(TS));
    expect(mailIngestSlot(Date.parse("2026-11-05T12:30:00Z"))).toBe(mailIngestSlot(TS) + 1);
    expect(mailIngestEventId(A, 7)).toBe(`mail-ingest:${A}:7`);
    expect(mailIngestEventId(A, 1)).not.toBe(mailIngestEventId(A, 2));
    expect(mailIngestEventId(A, 1)).not.toBe(mailIngestEventId(B, 1));
    expect(briefingRefreshEventId("PKG", 7)).toBe("briefing-refresh:PKG:7");
    expect(briefingRefreshEventId("PKG", 7)).not.toBe(briefingRefreshEventId("APK", 7));
  });
  it("refuse an unusable schedule time", () => {
    for (const bad of [Number.NaN, -1, Infinity]) expect(() => mailIngestSlot(bad)).toThrow(NonRetriableError);
  });
});

describe("handleMailIngest", () => {
  it("sends one scheduled mail-only conn/sync.requested per connected mailbox with the tick id, ids only", async () => {
    const { step, sent } = fakeStep();
    const out = await handleMailIngest(deps(), TS, step);
    const slot = mailIngestSlot(TS);
    expect(out).toEqual({ lanes: 1, connections: 2, slot });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events.map((e) => [e.name, e.id, e.data])).toEqual([
      ["conn/sync.requested", mailIngestEventId(A, slot), { laneId: "PKG", connectionId: A, trigger: "schedule", streams: ["mail"] }],
      ["conn/sync.requested", mailIngestEventId(B, slot), { laneId: "PKG", connectionId: B, trigger: "schedule", streams: ["mail"] }],
    ]);
    for (const e of sent[0]?.events ?? []) await expect(connSyncRequested.create(e.data as never).validate()).resolves.toBeUndefined();
  });

  it("lists only enabled lanes, keeps lanes apart, and ignores ids that are not uuids", async () => {
    const d = deps({ enabledLanes: () => ["PKG", "PKG", "APK"], listConnections: async (lane) => (lane === "PKG" ? [A, "not-a-uuid"] : [C]) });
    const { step, sent } = fakeStep();
    await handleMailIngest(d, TS, step);
    expect(d.listConnections.mock.calls.map((c) => c[0])).toEqual(["PKG", "APK"]);
    expect((sent[0]?.events ?? []).map((e) => e.data)).toEqual([
      { laneId: "PKG", connectionId: A, trigger: "schedule", streams: ["mail"] },
      { laneId: "APK", connectionId: C, trigger: "schedule", streams: ["mail"] },
    ]);
  });

  it("sends nothing for a lane that is not enabled or has no mailbox", async () => {
    const none = fakeStep();
    const d = deps({ enabledLanes: () => [] });
    await handleMailIngest(d, TS, none.step);
    expect(d.listConnections).not.toHaveBeenCalled();
    const empty = fakeStep();
    await handleMailIngest(deps({ listConnections: async () => [] }), TS, empty.step);
    expect(none.sent).toHaveLength(0);
    expect(empty.sent).toHaveLength(0);
  });

  it("a lane that cannot be listed does not block the others; the run then fails with a count only", async () => {
    const d = deps({
      enabledLanes: () => ["PKG", "APK"],
      listConnections: async (lane) => {
        if (lane === "PKG") throw new Error("secret detail postgres://user:pw@host");
        return [C];
      },
    });
    const { step, sent } = fakeStep();
    const err = (await handleMailIngest(d, TS, step).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(NonRetriableError);
    expect(err.message).not.toContain("secret");
    expect(sent[0]?.events.map((e) => (e.data as { laneId: string }).laneId)).toEqual(["APK"]);
  });

  it("refuses an invalid schedule time", async () => {
    await expect(handleMailIngest(deps(), "now", fakeStep().step)).rejects.toBeInstanceOf(NonRetriableError);
  });
});

describe("shouldRefreshBriefingAfterSync", () => {
  const base = { provider: "google", trigger: "schedule", streams: ["mail"] as const, written: 1 };
  it("is true only for a scheduled Google mail-only run that wrote at least one message", () => {
    expect(shouldRefreshBriefingAfterSync(base)).toBe(true);
    expect(shouldRefreshBriefingAfterSync({ ...base, written: 0 })).toBe(false);
    expect(shouldRefreshBriefingAfterSync({ ...base, written: Number.NaN })).toBe(false);
    expect(shouldRefreshBriefingAfterSync({ ...base, streams: ["calendar"] })).toBe(false);
    expect(shouldRefreshBriefingAfterSync({ ...base, streams: ["mail", "calendar"] })).toBe(false);
    expect(shouldRefreshBriefingAfterSync({ ...base, streams: undefined })).toBe(false);
    for (const trigger of ["manual", "webhook", "connect"]) expect(shouldRefreshBriefingAfterSync({ ...base, trigger })).toBe(false);
    expect(shouldRefreshBriefingAfterSync({ ...base, provider: "quickbooks" })).toBe(false);
  });
  it("the event it leads to carries a lane id only, with one id per lane and slot", async () => {
    const e = briefingRefreshRequested.create({ laneId: "PKG" }, { id: briefingRefreshEventId("PKG", 9) });
    await expect(e.validate()).resolves.toBeUndefined();
    expect(e.data).toEqual({ laneId: "PKG" });
    await expect((briefingRefreshRequested.create as (d: unknown) => { validate(): Promise<unknown> })({ laneId: "PKG", owner: "x" }).validate()).rejects.toThrow();
  });
});
