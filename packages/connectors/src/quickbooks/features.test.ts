/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index into synthetic data they just built */
// T-051: the edition-flag store over a recording fake of the job client, the diff, and the production wiring of the
// QuickBooks sync runner. (The database side is the existing core.connections table: features is a boolean-only jsonb.)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import type { Connection } from "../contract/schemas";
import { createQboFeatureStore, diffFeatures } from "./features";
import type { QboConnection } from "./guard";

const conn = mintLaneBoundConnection({
  id: "00000000-0000-4000-8000-000000000511", lane_id: "PKG", provider: "quickbooks", external_account_id: "9341450000000001", status: "active",
  features: { class_tracking: true, other_flag: true }, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null,
} as Connection) as unknown as QboConnection;

function fakeClient(result: { data: unknown; error: { code?: string } | null }) {
  const calls: { table: string; values?: unknown; filters: [string, unknown][] }[] = [];
  const client = {
    schema: (s: string) => ({
      from: (table: string) => ({
        update: (values: unknown) => {
          const call = { table: `${s}.${table}`, values, filters: [] as [string, unknown][] };
          calls.push(call);
          const b: Record<string, unknown> = {};
          b.eq = (c: string, v: unknown) => { call.filters.push([c, v]); return b; };
          b.select = () => Promise.resolve(result);
          return b;
        },
      }),
    }),
  };
  return { calls, clientFor: async (lane: string) => { calls.push({ table: `lane:${lane}`, filters: [] }); return client as never; } };
}

describe("diffFeatures", () => {
  it("reports flips and first detections only", () => {
    expect(diffFeatures({ class_tracking: true }, { class_tracking: true, location_tracking: false, multicurrency: true })).toEqual({
      location_tracking: { from: null, to: false },
      multicurrency: { from: null, to: true },
    });
    expect(diffFeatures({ class_tracking: true, location_tracking: false, multicurrency: false }, { class_tracking: false, location_tracking: false, multicurrency: false })).toEqual({ class_tracking: { from: true, to: false } });
  });
});

describe("feature store", () => {
  it("updates core.connections for this lane, connection and provider only, merging into the stored flags", async () => {
    const f = fakeClient({ data: [{ id: conn.id }], error: null });
    await createQboFeatureStore(f.clientFor)
      .save("PKG", conn, { class_tracking: false, location_tracking: true, multicurrency: false }, "2026-11-05T12:00:00.000Z");
    const update = f.calls.find((c) => c.table === "core.connections")!;
    expect(update.values).toEqual({ features: { class_tracking: false, other_flag: true, location_tracking: true, multicurrency: false }, features_checked_at: "2026-11-05T12:00:00.000Z" });
    expect(update.filters).toEqual([["lane_id", "PKG"], ["id", conn.id], ["provider", "quickbooks"]]);
  });

  it("a row that was not updated, or a database error, is a transient ConnectorError without database text", async () => {
    for (const result of [{ data: [], error: null }, { data: null, error: { code: "XX000", message: "secret db text" } }]) {
      const f = fakeClient(result as never);
      const err = await createQboFeatureStore(f.clientFor).save("PKG", conn, { class_tracking: true, location_tracking: true, multicurrency: true }, "2026-11-05T12:00:00.000Z").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).info.kind).toBe("transient");
      expect(JSON.stringify(err)).not.toContain("secret db text");
    }
  });

  it("refuses a connection of another lane before touching the database", async () => {
    const f = fakeClient({ data: [{ id: conn.id }], error: null });
    await expect(createQboFeatureStore(f.clientFor).save("APK", conn, { class_tracking: true, location_tracking: true, multicurrency: true }, "2026-11-05T12:00:00.000Z")).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
    expect(f.calls).toEqual([]);
  });
});

describe("wiring", () => {
  it("conn.sync registers a quickbooks runner built on the generic cursor (stream 'default') and the raw record sink", () => {
    const src = readFileSync(new URL("../sync/index.ts", import.meta.url), "utf8");
    expect(src).toMatch(/quickbooks:\s*createConnectorSyncRunner\(\{ connector: quickbooksConnector, cursors: syncCursorStore, sinkFor: rawRecords\.sinkFor \}\)/);
  });

  it("the production connector is built with the feature recorder over the vault module's job-client store and the audit", () => {
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(src).toMatch(/createQboFeatureRecorder\(\{ store: qboFeatureStore, audit: getAudit\(\) \}\)/);
    expect(src).toMatch(/createQuickBooksConnector\(\{ connections, api, features, payroll: \(laneId\) => laneConfigReader\.payrollSettings\(laneId\) \}\)/);
  });
});
