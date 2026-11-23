// teams.activity (T-289, spec 9.2): an accepted `teams_chats.changed` event is ONE database write ("a notice arrived") and nothing else: no Graph call, no content. Everything else is skipped.
import { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { handleMicrosoftWebhookSync } from "./microsoft-webhook-sync";
import { TEAMS_ACTIVITY_EVENT_TYPE, handleTeamsActivity, teamsActivityFunctions, type TeamsActivityDeps } from "./teams-activity";

const CONN = "00000000-0000-4000-8000-000000028901";
const ev = (eventType: string, over: Record<string, unknown> = {}) => ({ laneId: "PKG", provider: "microsoft", connectionId: CONN, eventId: "ms:change:abc", eventType, refs: [], ...over });

function setup(over: Partial<TeamsActivityDeps> = {}) {
  const steps: string[] = [];
  const deps: TeamsActivityDeps = { recordNotice: vi.fn(async () => true), enabledLanes: () => ["PKG", "APK"], ...over };
  const step = {
    run: async <T>(id: string, fn: () => T | Promise<T>) => {
      steps.push(id);
      return fn();
    },
  };
  return { deps, steps, run: (raw: unknown) => handleTeamsActivity(deps, raw, step) };
}

describe("teams.activity", () => {
  it("is triggered by the typed webhook/received event, with a few retries and no batching or Graph client", () => {
    const fn = teamsActivityFunctions(new Inngest({ id: "test-app", isDev: true }), setup().deps)[0] as unknown as { opts: Record<string, unknown> };
    const opts = JSON.parse(JSON.stringify(fn.opts)) as { id: string; retries: number; batchEvents?: unknown };
    expect(opts.id).toBe("teams-activity");
    expect(opts.retries).toBe(3);
    expect(opts.batchEvents).toBeUndefined();
    expect(TEAMS_ACTIVITY_EVENT_TYPE).toBe("teams_chats.changed");
  });

  it("a teams_chats.changed event records ONE notice for its lane and connection, in a step; no other dependency exists (no Graph, no token, no content)", async () => {
    const s = setup();
    expect(await s.run(ev("teams_chats.changed"))).toEqual({ recorded: true, skipped: null });
    expect(s.deps.recordNotice).toHaveBeenCalledTimes(1);
    expect(s.deps.recordNotice).toHaveBeenCalledWith("PKG", CONN);
    expect(s.steps).toEqual([`notice:PKG:${CONN}`]);
    expect(Object.keys(s.deps).sort()).toEqual(["enabledLanes", "recordNotice"]);
  });

  it("a connection that is no longer a usable Teams connection (the database says so) is dropped, not a failure", async () => {
    const s = setup({ recordNotice: vi.fn(async () => false) });
    expect(await s.run(ev("teams_chats.changed"))).toEqual({ recorded: false, skipped: "not_usable" });
  });

  it("a database failure is thrown, so Inngest retries the step", async () => {
    const s = setup({ recordNotice: vi.fn(async () => { throw new Error("db down"); }) });
    await expect(s.run(ev("teams_chats.changed"))).rejects.toThrow("db down");
  });

  it("everything else is skipped without touching the database: mail and calendar events, lifecycle events, other providers, lanes this deployment does not serve, malformed events", async () => {
    const s = setup({ enabledLanes: () => ["PKG"] });
    const cases: [unknown, string][] = [
      [ev("mail.changed"), "not_teams_notice"],
      [ev("calendar.changed"), "not_teams_notice"],
      [ev("teams_chats.reauthorizationRequired"), "not_teams_notice"],
      [ev("teams_chats.subscriptionRemoved"), "not_teams_notice"],
      [ev("teams_chats.missed"), "not_teams_notice"],
      [ev("teams_chats.changed ", {}), "not_teams_notice"],
      [ev("teams_chats.changed", { provider: "quickbooks" }), "not_microsoft"],
      [ev("teams_chats.changed", { provider: "microsoft_teams" }), "not_microsoft"],
      [ev("teams_chats.changed", { laneId: "APK" }), "lane_not_served"],
      [{ laneId: "PKG" }, "invalid"],
      [ev("teams_chats.changed", { connectionId: "not-a-uuid" }), "invalid"],
      [ev("teams_chats.changed", { extra: "field" }), "invalid"],
      [null, "invalid"],
    ];
    for (const [raw, why] of cases) expect((await s.run(raw)).skipped, JSON.stringify(raw)).toBe(why);
    expect(s.deps.recordNotice).not.toHaveBeenCalled();
    expect(s.steps).toHaveLength(0);
  });
});

describe("microsoft.webhook_sync skips Teams notices (the mail and calendar sync never sees them)", () => {
  it("a teams_chats.changed event requests no sync, checks no connection and is counted as not a change", async () => {
    const isUsable = vi.fn(async () => true);
    const sent: unknown[] = [];
    const step = { run: async <T>(_id: string, fn: () => T | Promise<T>) => fn(), sendEvent: async (_id: string, events: unknown[]) => void sent.push(...events) };
    const out = await handleMicrosoftWebhookSync({ isUsable, enabledLanes: () => ["PKG"] }, [ev("teams_chats.changed"), ev("teams_chats.changed", { eventId: "ms:change:def" })], step as never);
    expect(out).toMatchObject({ requested: 0, skipped: { not_a_change: 2 } });
    expect(isUsable).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});
