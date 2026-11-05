import { describe, expect, it } from "vitest";
import { assertLaneBound, isLaneBound, mintLaneBoundConnection } from "./lane-bound";
import { ConnectorError } from "./errors";
import type { Connection } from "./schemas";

const row: Connection = {
  id: "00000000-0000-4000-8000-000000000001",
  lane_id: "lane-synthetic-a",
  provider: "quickbooks",
  external_account_id: "synthetic-realm-1",
  status: "active",
  features: { class_tracking: true },
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

describe("mintLaneBoundConnection", () => {
  it("returns a frozen, lane-bound copy and leaves the source row untouched", () => {
    const conn = mintLaneBoundConnection(row);
    expect(isLaneBound(conn)).toBe(true);
    expect(Object.isFrozen(conn)).toBe(true);
    expect(Object.isFrozen(conn.features)).toBe(true);
    expect(Object.isFrozen(row)).toBe(false);
    expect(isLaneBound(row)).toBe(false);
  });

  it("validates the row (no token fields)", () => {
    expect(() => mintLaneBoundConnection({ ...row, access_token: "x" } as Connection)).toThrow();
  });
});

describe("assertLaneBound", () => {
  const conn = mintLaneBoundConnection(row);

  it("passes a minted connection in its own lane", () => {
    expect(kindOf(() => assertLaneBound("lane-synthetic-a", conn))).toBeUndefined();
  });

  it("rejects a minted connection used from another lane", () => {
    expect(kindOf(() => assertLaneBound("lane-synthetic-b", conn))).toBe("lane_mismatch");
  });

  it("rejects a forged copy whose lane_id was changed to match", () => {
    expect(kindOf(() => assertLaneBound("lane-synthetic-b", { ...conn, lane_id: "lane-synthetic-b" }))).toBe("lane_mismatch");
  });

  it("rejects an exact unminted copy", () => {
    expect(kindOf(() => assertLaneBound("lane-synthetic-a", { ...conn }))).toBe("lane_mismatch");
  });

  it("rejects an empty laneId and non-objects", () => {
    expect(kindOf(() => assertLaneBound("", conn))).toBe("invalid_input");
    expect(kindOf(() => assertLaneBound("lane-synthetic-a", null))).toBe("lane_mismatch");
  });
});
