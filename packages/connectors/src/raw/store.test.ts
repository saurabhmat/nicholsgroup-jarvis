import { describe, expect, it } from "vitest";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import type { RawRecord } from "../contract/index";
import { readFileSync, readdirSync } from "node:fs";
import { RAW_BATCH_BYTES, RAW_BATCH_SIZE, RAW_RECORD_MAX_BYTES, RAW_TIMESTAMP_RE, createRawRecordStore, payloadJsonBytes } from "./store";

const CONN_ID = "00000000-0000-4000-8000-0000000003a1";
const row = (provider: string, lane = "PKG") => ({
  id: CONN_ID, lane_id: lane, provider, external_account_id: "acct-synthetic", status: "active", features: {},
  features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null,
});
const qbo = () => mintLaneBoundConnection(row("quickbooks") as never);
const google = () => mintLaneBoundConnection(row("google") as never);

const rec = (over: Partial<RawRecord<string>> = {}): RawRecord<string> => ({
  lane_id: "PKG", provider: "quickbooks", connection_id: CONN_ID, object_type: "Invoice", external_id: "inv-1",
  payload: { Id: "inv-1", TotalAmt: "100.00" }, source_updated_at: null, deleted: false, synced_at: "2026-11-02T10:00:00Z", ...over,
});

/** A fake job client: lane policy read + the upsert RPC. */
function fake(opts: { storeBodies?: boolean | null; policyError?: boolean; rpcError?: { code?: string }; clientError?: boolean } = {}) {
  const calls = { lanes: [] as string[], rpc: [] as { fn: string; args: Record<string, unknown> }[], policyLane: [] as unknown[] };
  const policyQuery = {
    select: () => policyQuery,
    eq: (_c: string, v: unknown) => (calls.policyLane.push(v), policyQuery),
    maybeSingle: async () =>
      opts.policyError
        ? { data: null, error: { code: "XX000" } }
        : { data: opts.storeBodies === null ? null : { store_content_bodies: opts.storeBodies ?? false }, error: null },
  };
  const schema = {
    from: (t: string) => (expect(t).toBe("lane_policies"), policyQuery),
    rpc: async (fn: string, args: Record<string, unknown>) => (calls.rpc.push({ fn, args }), { data: (args.p_records as unknown[]).length, error: opts.rpcError ?? null }),
  };
  const client = { schema: (s: string) => (expect(s).toBe("core"), schema) };
  const clientFor = async (lane: string) => {
    calls.lanes.push(lane);
    if (opts.clientError) throw new Error("lane off");
    return client as never;
  };
  return { calls, store: createRawRecordStore(clientFor as never) };
}

const kind = async (p: Promise<unknown>) => p.then(() => "ok", (e: { info?: { kind: string } }) => e.info?.kind);

describe("upsertRawRecords", () => {
  it("writes through core.source_records_upsert with the lane's client and no lane/provider fields in the rows", async () => {
    const f = fake();
    expect(await f.store.upsertRawRecords("PKG", qbo(), [rec()])).toBe(1);
    expect(f.calls.lanes).toEqual(["PKG"]);
    expect(f.calls.rpc).toHaveLength(1);
    const call = f.calls.rpc[0] as (typeof f.calls.rpc)[number];
    expect(call.fn).toBe("source_records_upsert");
    expect(call.args).toMatchObject({ p_lane: "PKG", p_connection_id: CONN_ID });
    expect((call.args.p_records as Record<string, unknown>[])[0]).toEqual({
      object_type: "Invoice", external_id: "inv-1", payload: { Id: "inv-1", TotalAmt: "100.00" },
      source_updated_at: null, deleted: false, synced_at: "2026-11-02T10:00:00Z",
    });
  });

  it("does nothing for an empty batch", async () => {
    const f = fake();
    expect(await f.store.upsertRawRecords("PKG", qbo(), [])).toBe(0);
    expect(f.calls.lanes).toEqual([]);
  });

  it("splits large batches", async () => {
    const f = fake();
    const many = Array.from({ length: RAW_BATCH_SIZE + 1 }, (_, i) => rec({ external_id: `inv-${i}` }));
    expect(await f.store.upsertRawRecords("PKG", qbo(), many)).toBe(RAW_BATCH_SIZE + 1);
    expect(f.calls.rpc).toHaveLength(2);
  });

  it("rejects a connection that is not lane-bound for this lane before touching the database", async () => {
    const f = fake();
    expect(await kind(f.store.upsertRawRecords("APK", qbo(), [rec()]))).toBe("lane_mismatch");
    expect(await kind(f.store.upsertRawRecords("PKG", { ...qbo() } as never, [rec()]))).toBe("lane_mismatch");
    expect(f.calls.lanes).toEqual([]);
  });

  it("cross-lane: a record carrying another lane, connection or provider fails the whole call", async () => {
    const f = fake();
    for (const bad of [rec({ lane_id: "APK" }), rec({ connection_id: "00000000-0000-4000-8000-0000000003a2" }), rec({ provider: "stripe" })]) {
      expect(await kind(f.store.upsertRawRecords("PKG", qbo(), [rec(), bad]))).toBe("lane_mismatch");
    }
    expect(f.calls.rpc).toEqual([]);
  });

  it("splits by total bytes as well as count", async () => {
    const f = fake();
    const big = "x".repeat(600 * 1024);
    const recs = Array.from({ length: 10 }, (_, i) => rec({ external_id: `inv-${i}`, payload: { v: big } }));
    expect(await f.store.upsertRawRecords("PKG", qbo(), recs)).toBe(10);
    expect(f.calls.rpc.length).toBeGreaterThan(1);
    for (const c of f.calls.rpc) expect(Buffer.byteLength(JSON.stringify(c.args.p_records))).toBeLessThan(RAW_BATCH_BYTES + 4096);
  });

  it("refuses a payload over 1 MB as invalid_input without writing", async () => {
    const f = fake();
    expect(await kind(f.store.upsertRawRecords("PKG", qbo(), [rec({ payload: { v: "x".repeat(1100000) } })]))).toBe("invalid_input");
    expect(f.calls.rpc).toEqual([]);
  });

  it("caps a payload at 680000 bytes of JSON (jsonb text is longer than the 1 MB database limit allows beyond that)", async () => {
    const f = fake();
    const overhead = Buffer.byteLength(JSON.stringify({ v: "" }));
    expect(await f.store.upsertRawRecords("PKG", qbo(), [rec({ payload: { v: "x".repeat(RAW_RECORD_MAX_BYTES - overhead) } })])).toBe(1);
    expect(await kind(f.store.upsertRawRecords("PKG", qbo(), [rec({ payload: { v: "x".repeat(RAW_RECORD_MAX_BYTES - overhead + 1) } })]))).toBe("invalid_input");
  });

  it("refuses an over-long key before any guard runs, fast, without writing", async () => {
    const f = fake();
    const t = performance.now();
    expect(await kind(f.store.upsertRawRecords("PKG", qbo(), [rec({ payload: { ["A".repeat(80_000)]: 1 } })]))).toBe("invalid_input");
    expect(await kind(f.store.upsertRawRecords("PKG", qbo(), [rec({ payload: { a: [{ ["k".repeat(257)]: 1 }] } })]))).toBe("invalid_input");
    expect(performance.now() - t).toBeLessThan(100);
    expect(await f.store.upsertRawRecords("PKG", qbo(), [rec({ payload: { ["k".repeat(256)]: 1 } })])).toBe(1);
    expect(f.calls.rpc).toHaveLength(1);
  });

  it("measures large and tiny numbers by what jsonb prints, so the size cap stays conservative", () => {
    expect(payloadJsonBytes({ v: 1e300 })).toBeGreaterThan(300);
    expect(payloadJsonBytes({ v: 1e-9 })).toBeGreaterThan(300);
    expect(payloadJsonBytes({ v: 12.5 })).toBe(Buffer.byteLength('{"v":12.5}'));
  });

  it("timestamps follow the database rule: at most 9 fractional digits, seconds and an offset", async () => {
    const f = fake();
    expect(RAW_TIMESTAMP_RE.test("2026-11-02T10:00:00.123456789Z")).toBe(true);
    for (const bad of ["2026-11-02T10:00:00.1234567890Z", "2026-11-02T10:00Z", "2026-11-02T10:00:00"]) {
      expect(await kind(f.store.upsertRawRecords("PKG", qbo(), [rec({ synced_at: bad })]))).toBe("invalid_input");
      expect(await kind(f.store.upsertRawRecords("PKG", qbo(), [rec({ source_updated_at: bad })]))).toBe("invalid_input");
    }
    expect(f.calls.rpc).toEqual([]);
    expect(await f.store.upsertRawRecords("PKG", qbo(), [rec({ synced_at: "2026-11-02T10:00:00.123456789+05:30", source_updated_at: "2026-11-02T10:00:00Z" })])).toBe(1);
  });

  it("the timestamp regex is the one in the migration", () => {
    const dir = new URL("../../../../supabase/core/supabase/migrations/", import.meta.url);
    const file = readdirSync(dir).find((n) => n.endsWith("_raw_source_records.sql")) as string;
    const sql = readFileSync(new URL(file, dir), "utf8");
    const m = /v_ts_re constant text := '([^']+)'/.exec(sql);
    expect(m?.[1]).toBe(RAW_TIMESTAMP_RE.source);
  });

  it("reports skipped (stale or superseded) records without breaking the number-returning call", async () => {
    const f = fake();
    // the fake echoes the batch length; make the database write one fewer
    const schemaRpc = { data: 1, error: null };
    const store = createRawRecordStore((async () => ({
      schema: () => ({
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { store_content_bodies: false }, error: null }) }) }) }),
        rpc: async () => schemaRpc,
      }),
    })) as never);
    const two = [rec({ external_id: "a" }), rec({ external_id: "b" })];
    expect(await store.upsertRawRecordsDetailed("PKG", qbo(), two)).toEqual({ written: 1, skipped: 1 });
    expect(await store.upsertRawRecords("PKG", qbo(), two)).toBe(1);
    expect(await f.store.upsertRawRecordsDetailed("PKG", qbo(), two)).toEqual({ written: 2, skipped: 0 });
  });

  it("refuses U+0000 in a string or key as invalid_input without writing", async () => {
    const f = fake();
    expect(await kind(f.store.upsertRawRecords("PKG", qbo(), [rec({ payload: { a: { b: ["x\u0000y"] } } })]))).toBe("invalid_input");
    expect(await kind(f.store.upsertRawRecords("PKG", qbo(), [rec({ payload: { ["k\u0000"]: 1 } })]))).toBe("invalid_input");
    expect(f.calls.rpc).toEqual([]);
  });

  it("refuses the provider-specific forbidden rule (timesolv bare rate) and words like employeeSsn", async () => {
    const f = fake({ storeBodies: true });
    const ts = mintLaneBoundConnection(row("timesolv") as never);
    expect(await kind(f.store.upsertRawRecords("PKG", ts, [rec({ provider: "timesolv", payload: { id: "t", Rate: 1 } })]))).toBe("invalid_input");
    expect(await kind(f.store.upsertRawRecords("PKG", qbo(), [rec({ payload: { employeeSsn: "x" } })]))).toBe("invalid_input");
    expect(await kind(f.store.upsertRawRecords("PKG", qbo(), [rec({ payload: { SyncToken: "0" } })]))).toBe("ok");
    expect(f.calls.rpc).toHaveLength(1);
  });

  it("refuses forbidden fields for every provider, without writing or echoing", async () => {
    const f = fake({ storeBodies: true });
    for (const [conn, provider] of [[qbo(), "quickbooks"], [google(), "google"]] as const) {
      const e = await f.store.upsertRawRecords("PKG", conn, [rec({ provider, payload: { Id: "1", SSN: "000-00-0000" } })]).catch((x: Error) => x);
      expect((e as unknown as { info: { kind: string } }).info.kind).toBe("invalid_input");
      expect(String((e as Error).message)).not.toMatch(/ssn|000/i);
    }
    expect(f.calls.rpc).toEqual([]);
  });

  it("is idempotent: the same call twice sends identical rows", async () => {
    const f = fake();
    expect(await f.store.upsertRawRecords("PKG", qbo(), [rec()])).toBe(1);
    expect(await f.store.upsertRawRecords("PKG", qbo(), [rec()])).toBe(1);
    expect(f.calls.rpc[1]?.args).toEqual(f.calls.rpc[0]?.args);
  });

  it("rejects malformed records without writing", async () => {
    const f = fake();
    expect(await kind(f.store.upsertRawRecords("PKG", qbo(), [rec({ external_id: "" })]))).toBe("invalid_input");
    expect(await kind(f.store.upsertRawRecords("PKG", qbo(), [{ ...rec(), extra: 1 } as never]))).toBe("invalid_input");
    expect(f.calls.rpc).toEqual([]);
  });

  it("content guard: refuses a mail record with a body when the lane policy is false (or missing), writes nothing", async () => {
    const mail = rec({ provider: "google", object_type: "message", external_id: "m1", payload: { id: "m1", body: { content: "synthetic" } } });
    for (const storeBodies of [false, null]) {
      const f = fake({ storeBodies });
      expect(await kind(f.store.upsertRawRecords("PKG", google(), [mail]))).toBe("forbidden");
      expect(f.calls.rpc).toEqual([]);
      expect(f.calls.policyLane).toEqual(["PKG"]);
    }
  });

  it("content guard: allows the body when the lane policy is true, and metadata-only mail always", async () => {
    const mail = rec({ provider: "google", object_type: "message", external_id: "m1", payload: { id: "m1", body: { content: "synthetic" } } });
    const meta = rec({ provider: "google", object_type: "message", external_id: "m2", payload: { id: "m2", subject: "Hi" } });
    const on = fake({ storeBodies: true });
    expect(await on.store.upsertRawRecords("PKG", google(), [mail])).toBe(1);
    const off = fake({ storeBodies: false });
    expect(await off.store.upsertRawRecords("PKG", google(), [meta])).toBe(1);
  });

  it("content guard: finance records are not subject to it", async () => {
    const f = fake({ storeBodies: false });
    expect(await f.store.upsertRawRecords("PKG", qbo(), [rec({ payload: { Id: "1", text: "memo" } })])).toBe(1);
  });

  it("fails closed when the policy cannot be read", async () => {
    const f = fake({ policyError: true });
    expect(await kind(f.store.upsertRawRecords("PKG", qbo(), [rec()]))).toBe("transient");
    expect(f.calls.rpc).toEqual([]);
  });

  it("maps database errors to fixed messages that never carry data", async () => {
    const f = fake({ rpcError: { code: "42501" } });
    const e = await f.store.upsertRawRecords("PKG", qbo(), [rec()]).catch((x: Error) => x);
    expect((e as unknown as { info: { kind: string } }).info.kind).toBe("forbidden");
    expect(String((e as Error).message)).not.toMatch(/inv-1|100\.00/);
    expect(await kind(fake({ rpcError: { code: "XX000" } }).store.upsertRawRecords("PKG", qbo(), [rec()]))).toBe("transient");
    for (const code of ["22023", "23514", "23502", "54000", "57014"]) {
      const r = await fake({ rpcError: { code } }).store.upsertRawRecords("PKG", qbo(), [rec()]).catch((x: Error) => x);
      expect((r as unknown as { info: { kind: string } }).info.kind).toBe("invalid_input");
      expect(String((r as Error).message)).not.toMatch(/inv-1|100\.00/);
    }
  });

  it("reports an unavailable lane", async () => {
    expect(await kind(fake({ clientError: true }).store.upsertRawRecords("PKG", qbo(), [rec()]))).toBe("connection_unavailable");
  });
});

describe("sinkFor", () => {
  it("stores each batch the connector delivers", async () => {
    const f = fake();
    const sink = f.store.sinkFor("PKG", qbo());
    await sink([rec(), rec({ external_id: "inv-2" })]);
    expect(f.calls.rpc).toHaveLength(1);
    expect((f.calls.rpc[0]?.args.p_records as unknown[]).length).toBe(2);
  });
  it("a refused batch aborts the sync run", async () => {
    const f = fake();
    const sink = f.store.sinkFor("PKG", qbo());
    expect(await kind(sink([rec({ lane_id: "APK" })]))).toBe("lane_mismatch");
  });
});
