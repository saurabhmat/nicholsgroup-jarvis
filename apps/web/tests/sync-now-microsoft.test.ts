// T-260: Sync now runs every usable Google AND Microsoft connection of the lane. A Google connection gets the one event it always had (both streams); a Microsoft
// connection gets two events, one per stream, so a first load does not run both inside one 300-second invocation. Mocks only.
import { describe, expect, it, vi } from "vitest";
import { createSyncNowHandler, syncNowEventId, syncNowStreamEventId } from "../lib/sync-now";

const ORIGIN = "http://localhost:3000";
const USER = "00000000-0000-4000-8000-0000000000aa";
const G = "00000000-0000-4000-8000-0000000c2601";
const M = "00000000-0000-4000-8000-0000000c2602";
const post = () => new Request(`${ORIGIN}/api/lanes/PKG/sync-now`, { method: "POST", headers: { origin: ORIGIN } });

function handlerFor(list: (string | { connectionId: string; provider: string })[], failFor: (id: string, streams?: readonly string[]) => boolean = () => false) {
  const sends: unknown[][] = [];
  const audits: unknown[] = [];
  const client = { schema: () => ({ rpc: async () => ({ data: { ok: true, retry_after_seconds: 0 }, error: null }) }) };
  const handler = createSyncNowHandler({
    guards: async () => ({ requireLane: async () => ({ session: { userId: USER }, client }) as never, requireRole: async () => ({ session: { userId: USER }, client }) as never }),
    audit: () => ({ log: vi.fn(async (e: unknown) => { audits.push(e); }) }) as never,
    listConnections: async () => list,
    send: async (...a: unknown[]) => { if (failFor(a[1] as string, a[3] as string[] | undefined)) throw new Error("down"); sends.push(a); },
    now: () => NOW,
  });
  return { handler, sends, audits };
}
const NOW = new Date("2026-11-21T15:00:30.000Z");

describe("Sync now with both providers", () => {
  it("a Google connection gets exactly its one event (three arguments, both streams); a Microsoft connection gets two events with the right streams", async () => {
    const { handler, sends, audits } = handlerFor([{ connectionId: G, provider: "google" }, { connectionId: M, provider: "microsoft" }]);
    const res = await handler(post(), "PKG");
    expect(await res.json()).toEqual({ status: "started", connections: 2 }); // connections, not events
    expect(sends.filter((s) => s[1] === G)).toEqual([["PKG", G, syncNowEventId(G, NOW.getTime())]]);
    expect(sends.filter((s) => s[1] === M)).toEqual([
      ["PKG", M, syncNowStreamEventId(M, NOW.getTime(), "mail"), ["mail"]],
      ["PKG", M, syncNowStreamEventId(M, NOW.getTime(), "calendar"), ["calendar"]],
    ]);
    expect(new Set(sends.map((s) => s[2])).size).toBe(3); // three distinct event ids
    expect(audits).toMatchObject([{ action: "connection.sync_now", metadata: { connections: 2 } }]);
  });
  it("a bare id list (what it was) still sends one event per connection, once", async () => {
    const { handler, sends } = handlerFor([G, G]);
    expect((await handler(post(), "PKG")).status).toBe(200);
    expect(sends).toEqual([["PKG", G, syncNowEventId(G, NOW.getTime())]]);
  });
  it("a Microsoft connection counts as started when one of its two events was sent, and fails only when both failed; 503 when nothing started", async () => {
    const half = handlerFor([{ connectionId: M, provider: "microsoft" }], (_id, s) => s?.[0] === "calendar");
    expect(await (await half.handler(post(), "PKG")).json()).toEqual({ status: "started", connections: 1 });
    const none = handlerFor([{ connectionId: M, provider: "microsoft" }], () => true);
    expect((await none.handler(post(), "PKG")).status).toBe(503);
  });
});
