// T-260: Sync now runs every usable Google AND Microsoft connection of the lane (one event per connection, a Microsoft one with its tenant id for the per-tenant queue).
// Google-only: the event call is exactly what it was (three arguments). Mocks only.
import { describe, expect, it, vi } from "vitest";
import { createSyncNowHandler } from "../lib/sync-now";

const ORIGIN = "http://localhost:3000";
const USER = "00000000-0000-4000-8000-0000000000aa";
const G = "00000000-0000-4000-8000-0000000c2601";
const M = "00000000-0000-4000-8000-0000000c2602";
const TENANT = "11111111-1111-4111-8111-111111111111";
const post = () => new Request(`${ORIGIN}/api/lanes/PKG/sync-now`, { method: "POST", headers: { origin: ORIGIN } });

function handlerFor(list: (string | { connectionId: string; tenantId?: string | null })[]) {
  const sends: unknown[][] = [];
  const audits: unknown[] = [];
  const client = { schema: () => ({ rpc: async () => ({ data: { ok: true, retry_after_seconds: 0 }, error: null }) }) };
  const handler = createSyncNowHandler({
    guards: async () => ({ requireLane: async () => ({ session: { userId: USER }, client }) as never, requireRole: async () => ({ session: { userId: USER }, client }) as never }),
    audit: () => ({ log: vi.fn(async (e: unknown) => { audits.push(e); }) }) as never,
    listConnections: async () => list,
    send: async (...a: unknown[]) => { sends.push(a); },
    now: () => new Date("2026-11-21T15:00:30.000Z"),
  });
  return { handler, sends, audits };
}

describe("Sync now with both providers", () => {
  it("sends one event per connection, a Microsoft one with its tenant id and a Google one exactly as before; the audit counts both", async () => {
    const { handler, sends, audits } = handlerFor([G, { connectionId: M, tenantId: TENANT }]);
    const res = await handler(post(), "PKG");
    expect(await res.json()).toEqual({ status: "started", connections: 2 });
    expect(sends.map((s) => s.slice(0, 2))).toEqual([["PKG", G], ["PKG", M]]);
    expect(sends[0]).toHaveLength(3); // Google: (lane, connection, event id), no fourth argument
    expect(sends[1]?.[3]).toBe(TENANT);
    expect(audits).toMatchObject([{ action: "connection.sync_now", metadata: { connections: 2 } }]);
  });
  it("a bare id list (what it was) still works, and a repeated connection is sent once", async () => {
    const { handler, sends } = handlerFor([G, G, { connectionId: G, tenantId: null }]);
    expect((await handler(post(), "PKG")).status).toBe(200);
    expect(sends).toHaveLength(1);
  });
});
