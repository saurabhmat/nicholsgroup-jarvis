// The QuickBooks normalizer job (T-056): lane and provider checks, skip of unusable connections, counts-only results and logs.
import { describe, expect, it, vi } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import type { ConnectorLogger } from "../log/index";
import { createQboNormalizeJob } from "./normalize-job";
import type { NormalizeResult, NormalizeStore } from "./normalize-store";

const ID = "00000000-0000-4000-8000-0000000000c1";
const mint = (over: Record<string, unknown> = {}) => mintLaneBoundConnection<string>({
  id: ID, lane_id: "PKG", provider: "quickbooks", external_account_id: "9341450000000001", status: "active",
  features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null, ...over,
} as never);
const t = { inserted: 1, updated: 1, tombstoned: 1, invalid: 0 };
const RESULT: NormalizeResult = {
  class_tracking: false, class_fallback: true, class_fallback_rows: 7, unmapped_rows: 2, null_account_lines: 0, invalid_records: 3, dead_deleted: 0, dead_unseen: 1, dead_payroll: 0, dead_entity: 0, dead_linked: 0,
  accounts: t, invoices: t, bills: t, payments: { ...t, reallocated: 2 }, transactions: t,
};
function logger() {
  const lines: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const l: ConnectorLogger = {
    debug: () => undefined, error: () => undefined,
    info: (event, fields) => void lines.push({ level: "info", event, fields: fields ?? {} }),
    warn: (event, fields) => void lines.push({ level: "warn", event, fields: fields ?? {} }),
    child: () => l,
  };
  return { lines, logger: l };
}
function job(conn = mint(), normalize: NormalizeStore["normalize"] = async () => RESULT) {
  const store = { normalize: vi.fn(normalize) };
  const loader = { loadConnection: vi.fn(async () => conn) };
  const log = logger();
  return { store, loader, log, job: createQboNormalizeJob({ loader: loader as never, store, logger: log.logger }) };
}

describe("createQboNormalizeJob", () => {
  it("normalizes the connection and returns counts only, warning when the class fallback was used", async () => {
    const j = job();
    const out = await j.job.run("PKG", ID);
    expect(out).toEqual({ ok: true, skipped: null, classFallback: true, written: 10, tombstoned: 5, unmappedRows: 2, reallocated: 2 });
    expect(j.store.normalize).toHaveBeenCalledWith("PKG", expect.objectContaining({ id: ID }));
    expect(j.log.lines.map((l) => l.event)).toEqual(["qbo.normalize.invalid_records", "qbo.normalize.class_fallback", "qbo.normalize.done"]);
    expect(j.log.lines[0]?.level).toBe("warn");
  });

  it("no fallback warning when the fallback was not used", async () => {
    const j = job(mint(), async () => ({ ...RESULT, class_fallback: false, class_fallback_rows: 0, invalid_records: 0 }));
    await j.job.run("PKG", ID);
    expect(j.log.lines.map((l) => l.event)).toEqual(["qbo.normalize.done"]);
  });

  it("skips a connection that is not usable, without calling the database", async () => {
    const j = job(mint({ status: "reconnect_required" }));
    expect(await j.job.run("PKG", ID)).toEqual({ ok: true, skipped: "connection_not_usable" });
    expect(j.store.normalize).not.toHaveBeenCalled();
  });

  it("refuses bad ids, another lane's connection and another provider's connection", async () => {
    const j = job();
    for (const [lane, id] of [["PKG", "x"], ["", ID]] as const) {
      expect(await j.job.run(lane as never, id)).toMatchObject({ ok: false, errorKind: "invalid_input", retryable: false });
    }
    expect(await j.job.run("pkg" as never, ID)).toMatchObject({ ok: false, retryable: false });
    const other = job(mint({ lane_id: "APK" }));
    expect(await other.job.run("PKG", ID)).toMatchObject({ ok: false, errorKind: "lane_mismatch" });
    const stripe = job(mint({ provider: "stripe" }));
    expect(await stripe.job.run("PKG", ID)).toMatchObject({ ok: false, errorKind: "lane_mismatch" });
    expect(j.store.normalize).not.toHaveBeenCalled();
    expect(other.store.normalize).not.toHaveBeenCalled();
    expect(stripe.store.normalize).not.toHaveBeenCalled();
  });

  it("reports store failures with their retry disposition and never the database text", async () => {
    const transient = job(mint(), async () => { throw new ConnectorError({ kind: "transient", message: "Normalizer unavailable" }); });
    expect(await transient.job.run("PKG", ID)).toMatchObject({ ok: false, retryable: true, errorKind: "transient" });
    const refused = job(mint(), async () => { throw new ConnectorError({ kind: "provider_error", message: "The normalizer refused the synced data" }); });
    expect(await refused.job.run("PKG", ID)).toMatchObject({ ok: false, retryable: false, errorKind: "provider_error" });
    const raw = job(mint(), async () => { throw new Error("Failing row contains (SECRET)"); });
    const out = await raw.job.run("PKG", ID);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(JSON.stringify(raw.log.lines)).not.toContain("SECRET");
  });
});
