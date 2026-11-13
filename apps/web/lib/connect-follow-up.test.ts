import { describe, expect, it } from "vitest";
import { connectFollowUp, connectSyncEventId } from "./connect-follow-up";

const CONN = "7f98598e-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-11-13T15:00:30Z");

describe("connect follow-up (T-241)", () => {
  it("a QuickBooks connect or reconnect starts one full load: conn/sync.requested with trigger connect, ids only", async () => {
    const sent: unknown[] = [];
    await connectFollowUp(async (e) => { sent.push(e); }, () => NOW)({ provider: "quickbooks", laneId: "PKG", connectionId: CONN });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ name: "conn/sync.requested", data: { laneId: "PKG", connectionId: CONN, trigger: "connect" }, id: connectSyncEventId(CONN, NOW) });
    expect(Object.keys((sent[0] as { data: object }).data).sort()).toEqual(["connectionId", "laneId", "trigger"]);
  });
  it("other providers start nothing here", async () => {
    const sent: unknown[] = [];
    await connectFollowUp(async (e) => { sent.push(e); }, () => NOW)({ provider: "google", laneId: "PKG", connectionId: CONN });
    expect(sent).toEqual([]);
  });
  it("the event id is per connection and minute (a repeated callback is dropped by Inngest)", () => {
    expect(connectSyncEventId(CONN, NOW)).toBe(connectSyncEventId(CONN, NOW + 20_000));
    expect(connectSyncEventId(CONN, NOW)).not.toBe(connectSyncEventId(CONN, NOW + 60_000));
  });
});
