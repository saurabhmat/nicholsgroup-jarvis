// The QuickBooks normalizer call (T-056): core.fin_qbo_normalize with the lane's job client, fixed errors only.
import { describe, expect, it, vi } from "vitest";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import { createNormalizeStore, NormalizeResultSchema, NORMALIZE_TIMEOUT_MS } from "./normalize-store";

const conn = mintLaneBoundConnection<"quickbooks">({
  id: "00000000-0000-4000-8000-0000000000c1", lane_id: "PKG", provider: "quickbooks", external_account_id: "9341450000000001", status: "active",
  features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null,
} as never);
const table = { inserted: 1, updated: 2, tombstoned: 3, invalid: 0 };
const RESULT = {
  class_tracking: true, class_fallback: false, class_fallback_rows: 0, unmapped_rows: 4, null_account_lines: 1, invalid_records: 2, dead_deleted: 1, dead_unseen: 2, dead_payroll: 3, dead_entity: 0, dead_linked: 1,
  accounts: table, invoices: table, bills: table, payments: { ...table, reallocated: 1, extra_key: 9 }, transactions: table,
  some_unknown_key: "SECRET-ROW-TEXT",
};

function client(result: { data?: unknown; error?: { code?: string; message?: string } | null } | (() => never)) {
  const calls: { schema: string; fn: string; args: Record<string, unknown> }[] = [];
  const signals: AbortSignal[] = [];
  const c = { schema: (schema: string) => ({ rpc: (fn: string, args: Record<string, unknown>) => { calls.push({ schema, fn, args }); return { abortSignal: async (signal: AbortSignal) => { signals.push(signal); if (typeof result === "function") return result(); return { data: result.data ?? null, error: result.error ?? null }; } }; } }) };
  return { calls, signals, clientFor: vi.fn(async () => c as never) };
}
const kindOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return (e as { info?: { kind?: string } }).info?.kind; }
  return "no error";
};

describe("createNormalizeStore", () => {
  it("calls core.fin_qbo_normalize for the connection's lane with a timeout, and returns only the counts and flags", async () => {
    const { calls, signals, clientFor } = client({ data: RESULT });
    const out = await createNormalizeStore(clientFor).normalize("PKG", conn);
    expect(clientFor).toHaveBeenCalledWith("PKG");
    expect(calls).toEqual([{ schema: "core", fn: "fin_qbo_normalize", args: { p_lane: "PKG", p_connection_id: conn.id } }]);
    expect(signals).toHaveLength(1);
    expect(NORMALIZE_TIMEOUT_MS).toBeGreaterThan(30_000);
    expect(out.class_fallback).toBe(false);
    expect(out.payments.reallocated).toBe(1);
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect((out.payments as Record<string, unknown>).extra_key).toBeUndefined();
  });

  it("refuses another lane's or provider's connection before any database call", async () => {
    const { calls, clientFor } = client({ data: RESULT });
    const store = createNormalizeStore(clientFor);
    expect(await kindOf(store.normalize("APK", conn))).toBe("lane_mismatch");
    const stripe = mintLaneBoundConnection<"stripe">({ ...conn, provider: "stripe" } as never);
    expect(await kindOf(store.normalize("PKG", stripe as never))).toBe("lane_mismatch");
    expect(calls).toEqual([]);
  });

  it("maps database refusals to fixed messages (no database text, no row data)", async () => {
    const leak = "Failing row contains (SECRET-ROW-TEXT)";
    for (const [code, kind] of [["22023", "provider_error"], ["23514", "provider_error"], ["42501", "connection_unavailable"], ["57014", "transient"], [undefined, "transient"]] as const) {
      const store = createNormalizeStore(client({ error: { ...(code ? { code } : {}), message: leak } }).clientFor);
      const err = (await store.normalize("PKG", conn).catch((e: unknown) => e)) as { info?: { kind?: string }; message: string };
      expect(err.info?.kind, String(code)).toBe(kind);
      expect(err.message).not.toContain("SECRET");
    }
    const thrown = createNormalizeStore(client(() => { throw new Error(leak); }).clientFor);
    expect(await kindOf(thrown.normalize("PKG", conn))).toBe("transient");
    expect(await kindOf(createNormalizeStore(async () => { throw new Error("no lane"); }).normalize("PKG", conn))).toBe("transient");
  });

  it("passes on only the exact constant refusal shape (SQLSTATE, table, constraint names), nothing else", async () => {
    const msg = "fin.qbo_normalize failed: SQLSTATE 23514, table invoices, constraint invoices_class_id_check";
    const ok = (await createNormalizeStore(client({ error: { code: "23514", message: msg } }).clientFor).normalize("PKG", conn).catch((e: unknown) => e)) as { message: string };
    expect(ok.message).toBe("The normalizer refused the synced data (SQLSTATE 23514, table invoices, constraint invoices_class_id_check)");
    for (const bad of [`${msg} SECRET`, "fin.qbo_normalize failed: SQLSTATE 23514, table invoices, constraint x (SECRET-ROW)", "Failing row contains (SECRET)", ""]) {
      const e = (await createNormalizeStore(client({ error: { code: "23514", message: bad } }).clientFor).normalize("PKG", conn).catch((x: unknown) => x)) as { message: string };
      expect(e.message).toBe("The normalizer refused the synced data");
    }
  });

  it("a missing entity mapping is its own configuration error", async () => {
    const e = (await createNormalizeStore(client({ error: { code: "22023", message: "fin.qbo_normalize: lane_config has no QuickBooks entity mapping" } }).clientFor).normalize("PKG", conn).catch((x: unknown) => x)) as { info?: { kind?: string }; message: string };
    expect(e.info?.kind).toBe("invalid_input");
    expect(e.message).toBe("The lane has no QuickBooks entity mapping in lane_config");
  });

  it("an unexpected result shape is a fixed provider error", async () => {
    for (const data of [null, {}, { ...RESULT, class_fallback: "yes" }, { ...RESULT, accounts: { inserted: -1, updated: 0, tombstoned: 0 } }]) {
      const err = (await createNormalizeStore(client({ data }).clientFor).normalize("PKG", conn).catch((e: unknown) => e)) as { info?: { kind?: string }; message: string };
      expect(err.info?.kind).toBe("provider_error");
    }
  });

  it("the result schema keeps counts only", () => {
    const parsed = NormalizeResultSchema.parse(RESULT) as Record<string, unknown>;
    expect(parsed.some_unknown_key).toBeUndefined();
  });
});
