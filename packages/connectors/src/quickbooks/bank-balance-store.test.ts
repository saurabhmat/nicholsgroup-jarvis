// The fin.bank_balances reader and writer (T-302): core.fin_bank_account_ids and core.fin_bank_balances_put with the lane's job client, fixed errors only.
import { describe, expect, it, vi } from "vitest";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import { createBankBalanceStore, type BankBalanceEntry } from "./bank-balance-store";

const conn = mintLaneBoundConnection<"quickbooks">({
  id: "00000000-0000-4000-8000-0000000000c1", lane_id: "PKG", provider: "quickbooks", external_account_id: "9341450000000001", status: "active",
  features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null,
} as never);
const entry: BankBalanceEntry = { date: "2026-11-20", asOf: "2026-11-27T10:00:00.000Z", balances: [{ accountId: "11", balance: "900.00" }, { accountId: "12", balance: "-1.50" }] };

type Result = { data?: unknown; error?: { code?: string; message?: string } | null };
function client(result: Result | (() => never)) {
  const calls: { schema: string; fn: string; args: Record<string, unknown> }[] = [];
  const signals: AbortSignal[] = [];
  const c = { schema: (schema: string) => ({ rpc: (fn: string, args: Record<string, unknown>) => { calls.push({ schema, fn, args }); return { abortSignal: async (signal: AbortSignal) => { signals.push(signal); return typeof result === "function" ? result() : { data: result.data ?? null, error: result.error ?? null }; } }; } }) };
  return { calls, signals, clientFor: vi.fn(async () => c as never) };
}
const kindOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return (e as { info?: { kind?: string } }).info?.kind; }
  return "no error";
};

describe("createBankBalanceStore.put", () => {
  it("calls core.fin_bank_balances_put with the lane, connection, date, read time and only {account_id, book_balance} items", async () => {
    const { calls, signals, clientFor } = client({});
    await createBankBalanceStore(clientFor).put("PKG", conn, entry);
    expect(signals).toHaveLength(1);
    expect(clientFor).toHaveBeenCalledWith("PKG");
    expect(calls).toEqual([{ schema: "core", fn: "fin_bank_balances_put", args: { p_lane: "PKG", p_connection_id: conn.id, p_date: "2026-11-20", p_as_of: entry.asOf,
      p_balances: [{ account_id: "11", book_balance: "900.00" }, { account_id: "12", book_balance: "-1.50" }] } }]);
  });
  it("refuses another lane's or provider's connection before any database call", async () => {
    const { calls, clientFor } = client({});
    const store = createBankBalanceStore(clientFor);
    expect(await kindOf(store.put("APK", conn, entry))).toBe("lane_mismatch");
    const stripe = mintLaneBoundConnection<"stripe">({ ...conn, provider: "stripe" } as never);
    expect(await kindOf(store.put("PKG", stripe as never, entry))).toBe("lane_mismatch");
    expect(calls).toEqual([]);
  });
  it("maps database refusals to fixed messages (no database text)", async () => {
    const leak = "Failing row contains (SECRET-BALANCE-TEXT)";
    for (const [code, kind] of [["22023", "provider_error"], ["23514", "provider_error"], ["42501", "connection_unavailable"], ["57014", "transient"], [undefined, "transient"]] as const) {
      const store = createBankBalanceStore(client({ error: { ...(code ? { code } : {}), message: leak } }).clientFor);
      const err = (await store.put("PKG", conn, entry).catch((e: unknown) => e)) as { info?: { kind?: string }; message: string };
      expect(err.info?.kind, String(code)).toBe(kind);
      expect(err.message).not.toContain("SECRET");
    }
    expect(await kindOf(createBankBalanceStore(client(() => { throw new Error(leak); }).clientFor).put("PKG", conn, entry))).toBe("transient");
    expect(await kindOf(createBankBalanceStore(async () => { throw new Error("no lane"); }).put("PKG", conn, entry))).toBe("connection_unavailable");
  });
});

describe("createBankBalanceStore.accountIds", () => {
  it("returns the ids the database lists, asked for this lane and connection", async () => {
    const { calls, clientFor } = client({ data: ["11", "12"] });
    expect(await createBankBalanceStore(clientFor).accountIds("PKG", conn)).toEqual(["11", "12"]);
    expect(calls).toEqual([{ schema: "core", fn: "fin_bank_account_ids", args: { p_lane: "PKG", p_connection_id: conn.id } }]);
  });
  it("an answer that is not a list of strings is refused; database errors become fixed errors", async () => {
    expect(await kindOf(createBankBalanceStore(client({ data: [1, 2] }).clientFor).accountIds("PKG", conn))).toBe("provider_error");
    expect(await kindOf(createBankBalanceStore(client({ data: { a: 1 } }).clientFor).accountIds("PKG", conn))).toBe("provider_error");
    expect(await kindOf(createBankBalanceStore(client({ error: { code: "42501", message: "x" } }).clientFor).accountIds("PKG", conn))).toBe("connection_unavailable");
    expect(await kindOf(createBankBalanceStore(client(() => { throw new Error("boom"); }).clientFor).accountIds("PKG", conn))).toBe("transient");
    expect(await kindOf(createBankBalanceStore(client({}).clientFor).accountIds("APK", conn))).toBe("lane_mismatch");
  });
});
