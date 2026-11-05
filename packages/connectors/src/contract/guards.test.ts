import { describe, expect, it } from "vitest";
import { assertStatusUsable, freshnessOf, isSyncAllowed } from "./guards";
import { ConnectorError } from "./errors";
import type { ConnectionStatus } from "./schemas";

function kindOf(status: ConnectionStatus): string | undefined {
  try {
    assertStatusUsable(status);
  } catch (e) {
    return e instanceof ConnectorError ? `${e.info.kind}/${e.info.disposition}` : "other";
  }
  return undefined;
}

describe("assertStatusUsable", () => {
  it("passes active and degraded", () => {
    expect(kindOf("active")).toBeUndefined();
    expect(kindOf("degraded")).toBeUndefined();
  });

  it("refuses reconnect_required with a never-retry error", () => {
    expect(kindOf("reconnect_required")).toBe("reconnect_required/reconnect_required");
  });

  it("refuses disconnected and pending connections", () => {
    expect(kindOf("disconnected")).toBe("connection_unavailable/fail");
    expect(kindOf("pending")).toBe("connection_unavailable/fail");
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
