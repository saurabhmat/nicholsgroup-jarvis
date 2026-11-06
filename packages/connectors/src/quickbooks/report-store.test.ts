// The fin.report_cache writer (T-052): core.fin_report_cache_put with the lane's job client, fixed errors only.
import { describe, expect, it, vi } from "vitest";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import { createReportCacheStore } from "./report-store";
import type { ReportCacheEntry } from "./reports-job";

const conn = mintLaneBoundConnection<"quickbooks">({
  id: "00000000-0000-4000-8000-0000000000c1", lane_id: "PKG", provider: "quickbooks", external_account_id: "9341450000000001", status: "active",
  features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null,
} as never);
const entry: ReportCacheEntry = {
  report: "pnl", params: { method: "accrual" }, asOf: "2026-11-06T10:00:00.000Z", fetchedAt: "2026-11-06T11:00:00.000Z",
  payload: { Header: { ReportName: "ProfitAndLoss", TotalsWithheld: "false" }, Columns: { Column: [] }, Rows: { Row: [] } },
};

function client(result: { error?: { code?: string; message?: string } | null } | (() => never)) {
  const calls: { schema: string; fn: string; args: Record<string, unknown> }[] = [];
  const signals: AbortSignal[] = [];
  const c = { schema: (schema: string) => ({ rpc: (fn: string, args: Record<string, unknown>) => { calls.push({ schema, fn, args }); return { abortSignal: async (signal: AbortSignal) => { signals.push(signal); return typeof result === "function" ? result() : { data: null, error: result.error ?? null }; } }; } }) };
  return { calls, signals, clientFor: vi.fn(async () => c as never) };
}
const kindOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return (e as { info?: { kind?: string } }).info?.kind; }
  return "no error";
};

describe("createReportCacheStore", () => {
  it("calls core.fin_report_cache_put for the connection's lane with the report, params, payload and times", async () => {
    const { calls, signals, clientFor } = client({});
    await createReportCacheStore(clientFor).put("PKG", conn, entry);
    expect(signals).toHaveLength(1); // the call carries a timeout signal
    expect(signals[0]?.aborted).toBe(false);
    expect(clientFor).toHaveBeenCalledWith("PKG");
    expect(calls).toEqual([{ schema: "core", fn: "fin_report_cache_put", args: { p_lane: "PKG", p_connection_id: conn.id, p_report: "pnl", p_params: { method: "accrual" }, p_payload: entry.payload, p_as_of: entry.asOf, p_fetched_at: entry.fetchedAt } }]);
  });

  it("refuses another lane's or provider's connection before any database call", async () => {
    const { calls, clientFor } = client({});
    const store = createReportCacheStore(clientFor);
    expect(await kindOf(store.put("APK", conn, entry))).toBe("lane_mismatch");
    expect(await kindOf(store.put("PKG", { ...conn } as never, entry))).toBe("lane_mismatch");
    const stripe = mintLaneBoundConnection<"stripe">({ ...conn, provider: "stripe" } as never);
    expect(await kindOf(store.put("PKG", stripe as never, entry))).toBe("lane_mismatch");
    expect(calls).toEqual([]);
  });

  it("maps database refusals to fixed messages (no database text, no payload)", async () => {
    const leak = "Failing row contains (SECRET-REPORT-TEXT)";
    for (const [code, kind] of [["22023", "provider_error"], ["23514", "provider_error"], ["42501", "connection_unavailable"], ["57014", "transient"], [undefined, "transient"]] as const) {
      const store = createReportCacheStore(client({ error: { ...(code ? { code } : {}), message: leak } }).clientFor);
      const err = (await store.put("PKG", conn, entry).catch((e: unknown) => e)) as { info?: { kind?: string }; message: string };
      expect(err.info?.kind, String(code)).toBe(kind);
      expect(err.message).not.toContain("SECRET");
    }
    const thrown = createReportCacheStore(client(() => { throw new Error(leak); }).clientFor);
    expect(await kindOf(thrown.put("PKG", conn, entry))).toBe("transient");
    expect(await kindOf(createReportCacheStore(async () => { throw new Error("no lane"); }).put("PKG", conn, entry))).toBe("connection_unavailable");
  });
});
