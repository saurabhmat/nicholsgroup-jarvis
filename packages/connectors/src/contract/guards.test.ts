import { describe, expect, it } from "vitest";
import { assertConnectionUsable, freshnessOf, isSyncAllowed } from "./guards";
import { ConnectorError } from "./errors";
import type { Connection } from "./schemas";

const conn: Connection = {
  id: "00000000-0000-4000-8000-000000000001",
  lane_id: "lane-synthetic-a",
  provider: "mock",
  external_account_id: "synthetic-account",
  status: "active",
  features: {},
  features_checked_at: null,
  token_expires_at: null,
  last_sync_at: null,
  last_error: null,
};

function kindOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof ConnectorError ? e.info.kind : "other";
  }
  return undefined;
}

describe("assertConnectionUsable", () => {
  it("passes for an active connection in the same lane", () => {
    expect(kindOf(() => assertConnectionUsable("lane-synthetic-a", conn))).toBeUndefined();
  });

  it("rejects a connection from another lane", () => {
    expect(kindOf(() => assertConnectionUsable("lane-synthetic-b", conn))).toBe("lane_mismatch");
  });

  it("rejects an empty laneId", () => {
    expect(kindOf(() => assertConnectionUsable("", conn))).toBe("invalid_input");
  });

  it("refuses reconnect_required with a never-retry error", () => {
    expect(kindOf(() => assertConnectionUsable("lane-synthetic-a", { ...conn, status: "reconnect_required" }))).toBe("reconnect_required");
  });

  it("refuses disconnected and pending connections", () => {
    expect(kindOf(() => assertConnectionUsable("lane-synthetic-a", { ...conn, status: "disconnected" }))).toBe("connection_unavailable");
    expect(kindOf(() => assertConnectionUsable("lane-synthetic-a", { ...conn, status: "pending" }))).toBe("connection_unavailable");
  });
});

describe("isSyncAllowed", () => {
  it("allows active and degraded only", () => {
    expect(isSyncAllowed("active")).toBe(true);
    expect(isSyncAllowed("degraded")).toBe(true);
    expect(isSyncAllowed("reconnect_required")).toBe(false);
    expect(isSyncAllowed("disconnected")).toBe(false);
    expect(isSyncAllowed("pending")).toBe(false);
  });
});

describe("freshnessOf", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  it("labels a provider fetch live", () => {
    expect(freshnessOf({ asOf: "2026-10-28T11:59:59Z", servedFromCache: false, now, staleAfterSeconds: 3600 })).toBe("live");
  });
  it("labels a recent cache hit cached", () => {
    expect(freshnessOf({ asOf: "2026-10-28T11:30:00Z", servedFromCache: true, now, staleAfterSeconds: 3600 })).toBe("cached");
  });
  it("labels anything older than the threshold stale, cached or not", () => {
    expect(freshnessOf({ asOf: "2026-10-28T10:00:00Z", servedFromCache: true, now, staleAfterSeconds: 3600 })).toBe("stale");
    expect(freshnessOf({ asOf: "2026-10-28T10:00:00Z", servedFromCache: false, now, staleAfterSeconds: 3600 })).toBe("stale");
  });
  it("treats an unparseable as_of as stale", () => {
    expect(freshnessOf({ asOf: "not-a-date", servedFromCache: false, now, staleAfterSeconds: 3600 })).toBe("stale");
  });
});
