import { afterEach, describe, expect, it, vi } from "vitest";
import { coverageFor, loadCoverage, needsAttention } from "./coverage";

afterEach(() => vi.restoreAllMocks());
const now = new Date("2026-11-12T13:00:00Z");

const client = (rows: unknown, covError: unknown = null) =>
  ({
    schema: () => ({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { config: { briefing: { coverage_stale_minutes: 60 } } }, error: null }) }) }) }),
      rpc: async () => ({ data: rows, error: covError }),
    }),
  }) as never;

describe("loadCoverage / coverageFor", () => {
  it("maps rows to states with the lane's stale threshold (names only, fixed reasons)", async () => {
    const v = await loadCoverage(
      client([
        { stream: "mail", account: "a@pubk.test", connection_id: "c", provider: "google", status: "active", configured: true, last_sync_at: "2026-11-12T12:30:00Z" },
        { stream: "calendar", account: "a@pubk.test", connection_id: "c", provider: "google", status: "active", configured: true, last_sync_at: "2026-11-12T10:00:00Z" },
      ]),
      "PKG",
      now,
    );
    expect(v.items.map((i) => i.state)).toEqual(["ok", "stale"]);
    expect(needsAttention(v.items)).toBe(true);
  });
  it("not connected alone is not a fault", async () => {
    const v = await loadCoverage(client([{ stream: "mail", account: "a@pubk.test", connection_id: null, provider: null, status: "not_connected", configured: true, last_sync_at: null }]), "PKG", now);
    expect(needsAttention(v.items)).toBe(false);
  });
  it("an outage is 'unavailable', never an empty (healthy-looking) list, and logs no detail", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const v = await coverageFor({ requireLane: async () => ({ client: client(null, { message: "secret detail" }) }) } as never, "PKG", now);
    expect(v).toEqual({ items: [], unavailable: true });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret detail");
  });
});
