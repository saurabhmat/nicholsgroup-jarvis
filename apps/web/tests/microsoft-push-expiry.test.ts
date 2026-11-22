// T-068: Settings -> Connections health shows when a Microsoft connection's change-notification subscription expires (H-073 expects it). Read through the signed-in user's own lane client (RLS
// "health" view of core.push_subscriptions); ids and times only; any failure or an empty read just leaves the line out (polling is then the only way mail arrives). Mocks only.
import { describe, expect, it } from "vitest";
import { loadMicrosoftSection } from "../lib/microsoft-connection";

const C1 = "00000000-0000-4000-8000-000000006801";
const C2 = "00000000-0000-4000-8000-000000006802";
const ME = "00000000-0000-4000-8000-0000000000a1";

type Seen = { table: string; select: string; filters: string[] };
function fakeClient(push: { data: unknown; error: unknown } | "throws", seen: Seen[] = []) {
  const base: Record<string, { data: unknown; error: unknown }> = {
    connections: { data: [{ id: C1, external_account_id: "a@corp.example.test", status: "active", owner_user_id: ME }, { id: C2, external_account_id: "b@corp.example.test", status: "active", owner_user_id: ME }], error: null },
    sync_cursors: { data: [], error: null },
    lane_config_current: { data: { mailboxes: [], mail: { allowed_domains: ["corp.example.test"] } }, error: null },
  };
  return {
    schema: () => ({
      from: (table: string) => {
        if (table === "push_subscriptions" && push === "throws") throw new Error("boom");
        const res = table === "push_subscriptions" ? (push as { data: unknown; error: unknown }) : (base[table] ?? { data: [], error: null });
        const call: Seen = { table, select: "", filters: [] };
        seen.push(call);
        const chain: Record<string, unknown> = {
          select: (s: string) => ((call.select = s), chain),
          eq: (c: string, v: unknown) => (call.filters.push(`${c}=${String(v)}`), chain),
          neq: (c: string, v: unknown) => (call.filters.push(`${c}!=${String(v)}`), chain),
          in: (c: string, v: unknown[]) => (call.filters.push(`${c} in ${v.join(",")}`), chain),
          order: () => Promise.resolve(res),
          maybeSingle: () => Promise.resolve(res),
          then: (f: (v: unknown) => unknown) => Promise.resolve(res).then(f),
        };
        return chain;
      },
    }),
  } as never;
}

describe("the subscription expiry on the Microsoft rows", () => {
  it("shows the earliest live expiry per connection, read for this lane and these connections only, never the secret id, provider id or resource path", async () => {
    const seen: Seen[] = [];
    const view = await loadMicrosoftSection(
      fakeClient({ data: [{ connection_id: C1, expires_at: "2026-11-29T12:00:00+00:00" }, { connection_id: C1, expires_at: "2026-11-28T09:00:00+00:00" }], error: null }, seen),
      "PKG",
      ME,
    );
    expect(view.connections.find((c) => c.id === C1)?.pushExpiresAt).toBe("2026-11-28T09:00:00.000Z");
    expect(view.connections.find((c) => c.id === C2)).not.toHaveProperty("pushExpiresAt");
    const q = seen.find((s) => s.table === "push_subscriptions");
    expect(q?.select).toBe("connection_id, expires_at");
    expect(q?.filters).toEqual(["lane_id=PKG", `connection_id in ${C1},${C2}`, "status!=removed"]);
    expect(JSON.stringify(view)).not.toMatch(/vault|subscription_id|resource_path|clientState/i);
  });

  it("a reader who may not see the health view (empty read), a database error and a thrown error all leave the line out and never fail the section", async () => {
    for (const push of [{ data: [], error: null }, { data: null, error: { code: "42501" } }, "throws" as const]) {
      const view = await loadMicrosoftSection(fakeClient(push), "PKG", ME);
      expect(view.connections).toHaveLength(2);
      for (const c of view.connections) expect(c).not.toHaveProperty("pushExpiresAt");
    }
  });

  it("a malformed time is ignored", async () => {
    const view = await loadMicrosoftSection(fakeClient({ data: [{ connection_id: C1, expires_at: "soon" }], error: null }), "PKG", ME);
    expect(view.connections[0]).not.toHaveProperty("pushExpiresAt");
  });
});
