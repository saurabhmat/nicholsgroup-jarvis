import { describe, expect, it } from "vitest";
import { createConnectionStore } from "./connections";
import { CONNECTION_COLUMNS } from "./loader";

const ROW = {
  id: "00000000-0000-4000-8000-0000000000c1",
  lane_id: "PKG",
  provider: "quickbooks",
  external_account_id: "realm-synthetic-1",
  status: "active",
  features: {},
  features_checked_at: null,
  token_expires_at: null,
  last_sync_at: null,
  last_error: null,
};

/** A fake job client recording the upsert and the select. */
function fake(opts: { upsertError?: unknown; row?: unknown; selectError?: unknown } = {}) {
  const calls: { upsert?: [unknown, unknown]; selected?: string; filters: [string, unknown][] } = { filters: [] };
  const q = {
    select: (cols: string) => ((calls.selected = cols), q),
    eq: (col: string, v: unknown) => (calls.filters.push([col, v]), q),
    maybeSingle: async () => ({ data: opts.row === undefined ? ROW : opts.row, error: opts.selectError ?? null }),
  };
  const table = {
    upsert: async (values: unknown, options: unknown) => ((calls.upsert = [values, options]), { error: opts.upsertError ?? null }),
    ...q,
  };
  const client = { schema: (s: string) => (expect(s).toBe("core"), { from: (t: string) => (expect(t).toBe("connections"), table) }) };
  return { calls, clientFor: async () => client as never };
}

const kind = async (p: Promise<unknown>) => p.then(() => "ok", (e: { info?: { kind: string } }) => e.info?.kind);

describe("createConnectionStore", () => {
  it("records who started the connect as created_by", async () => {
    const f = fake();
    await createConnectionStore(f.clientFor).ensureConnection("PKG", "quickbooks", "realm-synthetic-1", "00000000-0000-4000-8000-0000000000a1");
    expect(f.calls.upsert?.[0]).toMatchObject({ created_by: "00000000-0000-4000-8000-0000000000a1" });
  });

  it("creates the row pending without touching an existing one, then reads it back by lane, provider and account", async () => {
    const f = fake();
    const conn = await createConnectionStore(f.clientFor).ensureConnection("PKG", "quickbooks", "realm-synthetic-1");
    expect(conn.id).toBe(ROW.id);
    expect(f.calls.upsert).toEqual([
      { lane_id: "PKG", provider: "quickbooks", external_account_id: "realm-synthetic-1", status: "pending" },
      { onConflict: "lane_id,provider,external_account_id", ignoreDuplicates: true },
    ]);
    expect(f.calls.selected).toBe(CONNECTION_COLUMNS);
    expect(f.calls.filters).toEqual([["lane_id", "PKG"], ["provider", "quickbooks"], ["external_account_id", "realm-synthetic-1"]]);
  });

  it("maps the one-lane-per-account violation (D-23) to a fixed refusal without database text", async () => {
    const err = await createConnectionStore(
      fake({ upsertError: { code: "23505", message: 'duplicate key value violates unique constraint "connections_one_lane_per_account" Key (provider, external_account_id)=(quickbooks, 9341450000000001)' } }).clientFor,
    )
      .ensureConnection("APK", "quickbooks", "9341450000000001")
      .then(() => null, (e: { info: { kind: string; message: string } }) => e);
    expect(err?.info.kind).toBe("forbidden");
    expect(err?.info.message).toBe("This provider account is already connected to another company");
    expect(JSON.stringify(err)).not.toMatch(/9341450000000001|connections_one_lane/);
  });

  it("maps refusals and outages without database text", async () => {
    expect(await kind(createConnectionStore(fake({ upsertError: { code: "23514", message: "violates check sk_live_x" } }).clientFor).ensureConnection("PKG", "quickbooks", "sk_live_x"))).toBe("invalid_input");
    expect(await kind(createConnectionStore(fake({ upsertError: { code: "XX000" } }).clientFor).ensureConnection("PKG", "quickbooks", "r"))).toBe("transient");
    expect(await kind(createConnectionStore(fake({ row: null }).clientFor).ensureConnection("PKG", "quickbooks", "r"))).toBe("transient");
    expect(await kind(createConnectionStore(fake({ row: { ...ROW, extra: 1 } }).clientFor).ensureConnection("PKG", "quickbooks", "r"))).toBe("provider_error");
    const noLane = createConnectionStore(async () => {
      throw new Error("Unknown lane");
    });
    expect(await kind(noLane.ensureConnection("PKG", "quickbooks", "r"))).toBe("connection_unavailable");
    expect(await kind(createConnectionStore(fake().clientFor).ensureConnection("pkg" as never, "quickbooks", "r"))).toBe("invalid_input");
    expect(await kind(createConnectionStore(fake().clientFor).ensureConnection("PKG", "quickbooks", ""))).toBe("invalid_input");
  });
});
