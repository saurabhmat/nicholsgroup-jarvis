/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-dynamic-delete -- tests index into synthetic data they just built */
// T-051 QuickBooks entity sync (CDC): QB-10 (detection), QB-12 (cursor), QB-13. Over the fake Intuit (MSW) with synthetic
// fixtures and the in-memory harness twins. Each describe block names the acceptance clause it proves.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { RawRecord } from "../contract/schemas";
import { RateLimiter } from "../http/rate-limit";
import { assertContentAllowed, assertNoForbiddenFields } from "../raw/guard";
import { createConnectorSyncRunner } from "../sync/runners";
import type { SyncCursorStore } from "../sync/types";
import { useMockServer } from "../testing/msw/index";
import { createFakeIntuit, FAKE_REALM, type FakeIntuit } from "../testing/msw/quickbooks/handlers";
import { type FakeData, type FakeObject, SYNTHETIC_BANK_NUMBER, SYNTHETIC_EMAIL, SYNTHETIC_ROUTING, syntheticData, syntheticPreferences, type FakePreferences } from "../testing/msw/quickbooks/fixtures";
import { createQboHarness, type QboHarness } from "../testing/quickbooks-harness";
import type { QboConnection } from "./guard";
import { CDC_LOOKBACK_MS, CURSOR_OVERLAP_MS, usableCursor } from "./sync";
import { QBO_SYNC_ENTITIES } from "./entities";

const server = useMockServer();
const LANE = "PKG";
const DAY = 86_400_000;
const ACCOUNT_QUERY = "select * from Account where Active in (true, false) ORDERBY Id STARTPOSITION 1 MAXRESULTS 1000";
afterEach(() => RateLimiter.resetForTests());

type Setup = { intuit: FakeIntuit; h: QboHarness; conn: QboConnection };
async function setup(opts: { data?: FakeData; preferences?: FakePreferences } = {}): Promise<Setup> {
  const intuit = createFakeIntuit({ data: opts.data ?? syntheticData(2), preferences: syntheticPreferences(opts.preferences) });
  server.use(...intuit.handlers);
  const h = createQboHarness({ intuit });
  const conn = await h.connectViaCallback(LANE);
  intuit.state.apiRequests.length = 0;
  h.audits.length = 0;
  return { intuit, h, conn };
}

async function run(h: QboHarness, conn: QboConnection, cursor: string | null, options?: Parameters<NonNullable<QboHarness["connector"]["sync"]>>[4]) {
  const records: RawRecord<"quickbooks">[] = [];
  const summary = await h.connector.sync!(LANE, conn, cursor === null ? null : { value: cursor }, async (b) => void records.push(...b), options);
  return { records, summary };
}
const byType = (records: RawRecord<"quickbooks">[]) => {
  const out: Record<string, RawRecord<"quickbooks">[]> = {};
  for (const r of records) (out[r.object_type] ??= []).push(r);
  return out;
};
const iso = (ms: number) => new Date(ms).toISOString();
const touch = (o: FakeObject, ms: number) => void (o.MetaData = { CreateTime: iso(ms), LastUpdatedTime: iso(ms) });

describe("initial load (acceptance: initial load for every entity, CompanyInfo and Preferences into raw records)", () => {
  it("a sync without a cursor is a full load of all 11 entities plus CompanyInfo and Preferences", async () => {
    const { intuit, h, conn } = await setup();
    const { records, summary } = await run(h, conn, null);
    expect(summary.mode).toBe("full");
    expect(summary.records).toBe(records.length);
    const types = byType(records);
    expect(Object.keys(types).sort()).toEqual([...QBO_SYNC_ENTITIES, "CompanyInfo", "Preferences"].sort());
    for (const e of QBO_SYNC_ENTITIES) expect(types[e]).toHaveLength(2);
    expect(types.CompanyInfo?.[0]?.external_id).toBe(FAKE_REALM);
    expect(types.Preferences?.[0]?.external_id).toBe(FAKE_REALM);
    for (const r of records) {
      expect(r).toMatchObject({ lane_id: LANE, provider: "quickbooks", connection_id: conn.id, deleted: false });
    }
    expect(intuit.state.cdcRequests).toHaveLength(0);
    expect(summary.provider_tid).toMatch(/^synthetic-tid-/);
  });

  it("pages each entity with STARTPOSITION / MAXRESULTS 1000, and asks for inactive Account, Class, Customer and Vendor too", async () => {
    const data = syntheticData(2);
    data.Invoice = Array.from({ length: 2500 }, (_v, i) => ({ ...(data.Invoice![0] as FakeObject), Id: String(i + 1) }));
    const { intuit, h, conn } = await setup({ data });
    const { records } = await run(h, conn, null);
    expect(byType(records).Invoice).toHaveLength(2500);
    const invoiceQueries = intuit.state.queries.filter((q) => q.includes("from Invoice"));
    expect(invoiceQueries).toEqual([
      "select * from Invoice ORDERBY Id STARTPOSITION 1 MAXRESULTS 1000",
      "select * from Invoice ORDERBY Id STARTPOSITION 1001 MAXRESULTS 1000",
      "select * from Invoice ORDERBY Id STARTPOSITION 2001 MAXRESULTS 1000",
    ]);
    for (const e of ["Account", "Class", "Customer", "Vendor"]) expect(intuit.state.queries).toContain(`select * from ${e} where Active in (true, false) ORDERBY Id STARTPOSITION 1 MAXRESULTS 1000`);
    expect(intuit.state.queries.some((q) => /from (Invoice|Bill|Payment) where/.test(q))).toBe(false);
  });

  it("an exact multiple of the page size ends on the empty page", async () => {
    const data = syntheticData(1);
    data.Bill = Array.from({ length: 1000 }, (_v, i) => ({ ...(data.Bill![0] as FakeObject), Id: String(i + 1) }));
    const { intuit, h, conn } = await setup({ data });
    const { records } = await run(h, conn, null);
    expect(byType(records).Bill).toHaveLength(1000);
    expect(intuit.state.queries.filter((q) => q.includes("from Bill ORDERBY Id STARTPOSITION"))).toHaveLength(2);
  });

  it("records carry Intuit's last-updated time as source_updated_at", async () => {
    const { h, conn } = await setup();
    const { records } = await run(h, conn, null);
    const inv = byType(records).Invoice?.[0];
    expect(inv?.source_updated_at).toBe("2026-10-01T10:01:00-04:00");
    expect(inv?.synced_at).toBe(iso(h.clock.t));
  });
});

describe("CDC (acceptance: CDC for the entities; deleted entities recorded)", () => {
  it("with a current cursor, one /cdc call asks for all 11 entities changedSince the cursor and delivers only what changed", async () => {
    const { intuit, h, conn } = await setup();
    const first = await run(h, conn, null);
    intuit.state.queries.length = 0;
    // One invoice changes after the cursor, one customer is deleted, the rest is older.
    const changedAt = h.clock.t + 60_000;
    touch(intuit.state.data.Invoice![1]!, changedAt);
    intuit.state.data.Invoice![1]!.TotalAmt = 999;
    intuit.state.deleted.push({ entity: "Customer", Id: "2", at: iso(changedAt) });
    for (const e of Object.keys(intuit.state.data)) for (const o of intuit.state.data[e]!) if (o !== intuit.state.data.Invoice![1]) touch(o, h.clock.t - 3 * DAY);
    h.clock.t += 120_000;
    const second = await run(h, conn, first.summary.cursor.value);
    expect(second.summary.mode).toBe("incremental");
    expect(intuit.state.queries).toEqual([ACCOUNT_QUERY]); // CDC for the data; one Account query to classify payroll accounts
    expect(intuit.state.cdcRequests).toEqual([{ entities: QBO_SYNC_ENTITIES.join(","), changedSince: first.summary.cursor.value }]);
    const types = byType(second.records);
    expect(types.Invoice).toHaveLength(1);
    expect(types.Invoice?.[0]).toMatchObject({ external_id: "2", deleted: false, payload: expect.objectContaining({ TotalAmt: 999 }) });
    // Deleted objects: a record flagged deleted that carries only the Id.
    expect(types.Customer).toEqual([expect.objectContaining({ external_id: "2", deleted: true, payload: { Id: "2" }, source_updated_at: iso(changedAt) })]);
    // Preferences and CompanyInfo are read on every run.
    expect(types.Preferences).toHaveLength(1);
    expect(types.CompanyInfo).toHaveLength(1);
    expect(Object.keys(types).sort()).toEqual(["CompanyInfo", "Customer", "Invoice", "Preferences"]);
  });

  it("a CDC answer cut off at Intuit's per-entity cap is not trusted: the run reloads everything instead", async () => {
    const data = syntheticData(2);
    data.Bill = Array.from({ length: 1000 }, (_v, i) => ({ ...(data.Bill![0] as FakeObject), Id: String(i + 1) }));
    const { intuit, h, conn } = await setup({ data });
    const first = await run(h, conn, null);
    intuit.state.queries.length = 0;
    // Intuit returns at most 1000 objects per entity: 1000 changed bills may be a truncated answer.
    for (const o of intuit.state.data.Bill!) touch(o, h.clock.t + 1000);
    h.clock.t += 5000;
    const second = await run(h, conn, first.summary.cursor.value);
    expect(second.summary.mode).toBe("full");
    expect(intuit.state.queries.length).toBeGreaterThanOrEqual(QBO_SYNC_ENTITIES.length);
    expect(byType(second.records).Bill).toHaveLength(1000);
  });
});

describe("last-changed timestamp (acceptance: advanced only after a successful run)", () => {
  function memoryCursors(initial: string | null = null) {
    const state = { value: initial, puts: 0 };
    const store: SyncCursorStore = {
      get: async () => state.value,
      put: async (_l, _c, expected, next) => {
        if (state.value !== expected) return false;
        state.value = next;
        state.puts += 1;
        return true;
      },
    };
    return { state, store };
  }
  const runner = (h: QboHarness, cursors: SyncCursorStore, seen: RawRecord<"quickbooks">[] = []) =>
    createConnectorSyncRunner({ connector: h.connector, cursors, sinkFor: () => async (batch) => void seen.push(...batch) });

  it("the stored cursor is the run's start minus the overlap, written after the run", async () => {
    const { h, conn } = await setup();
    const { state, store } = memoryCursors();
    const start = h.clock.t;
    const result = await runner(h, store)(LANE, conn);
    expect(result.kind).toBe("full");
    expect(state.value).toBe(iso(start - CURSOR_OVERLAP_MS));
    expect(state.puts).toBe(1);
  });

  it("a failing run (Intuit 500 on a query) leaves the cursor where it was", async () => {
    const { intuit, h, conn } = await setup();
    const old = iso(h.clock.t - 2 * DAY);
    const { state, store } = memoryCursors(old);
    intuit.state.failRead = { status: 500, times: 100 };
    await expect(runner(h, store)(LANE, conn)).rejects.toMatchObject({ info: { disposition: "retry" } });
    expect(state.value).toBe(old);
    expect(state.puts).toBe(0);
  });

  it("a failure half-way through the load (sink fails after the first page) leaves the cursor where it was", async () => {
    const { h, conn } = await setup();
    const old = iso(h.clock.t - 40 * DAY); // too old to resume: a full load with many sink calls
    const { state, store } = memoryCursors(old);
    let calls = 0;
    const failing = createConnectorSyncRunner({
      connector: h.connector,
      cursors: store,
      sinkFor: () => async () => {
        calls += 1;
        if (calls === 3) throw new Error("sink failed");
      },
    });
    await expect(failing(LANE, conn)).rejects.toThrow();
    expect(state.value).toBe(old);
  });

  it("a CDC response that does not match (a Customer with a non-numeric balance) fails closed and the cursor stays", async () => {
    const { intuit, h, conn } = await setup();
    const old = iso(h.clock.t - 2 * DAY);
    const { state, store } = memoryCursors(old);
    (intuit.state.data.Customer![0] as FakeObject).Balance = "not a number";
    touch(intuit.state.data.Customer![0]!, h.clock.t);
    await expect(runner(h, store)(LANE, conn)).rejects.toMatchObject({ info: { kind: "provider_error" } });
    expect(state.value).toBe(old);
  });

  it("two successful runs advance the cursor each time; the second is incremental", async () => {
    const { intuit, h, conn } = await setup();
    const { state, store } = memoryCursors();
    await runner(h, store)(LANE, conn);
    const afterFirst = state.value;
    h.clock.t += 3_600_000;
    const second = await runner(h, store)(LANE, conn);
    expect(second.kind).toBe("incremental");
    expect(state.value).toBe(iso(h.clock.t - CURSOR_OVERLAP_MS));
    expect(state.value).not.toBe(afterFirst);
    expect(intuit.state.cdcRequests).toHaveLength(1);
  });
});

describe("cursor older than the 30-day CDC look-back (acceptance: full reload instead of a gap)", () => {
  it.each([
    ["31 days old", 31 * DAY],
    ["exactly 30 days old", 30 * DAY],
    ["29 days 23.5 hours old (inside the safety margin)", 30 * DAY - 30 * 60_000],
  ])("a cursor %s triggers a full reload and no CDC call", async (_name, age) => {
    const { intuit, h, conn } = await setup();
    const { records, summary } = await run(h, conn, iso(h.clock.t - age));
    expect(summary.mode).toBe("full");
    expect(intuit.state.cdcRequests).toHaveLength(0);
    expect(intuit.state.queries.length).toBeGreaterThanOrEqual(QBO_SYNC_ENTITIES.length);
    for (const e of QBO_SYNC_ENTITIES) expect(byType(records)[e]).toHaveLength(2);
    // The new cursor is fresh, so the run after it is incremental again.
    expect(summary.cursor.value).toBe(iso(h.clock.t - CURSOR_OVERLAP_MS));
  });

  it("a cursor inside the window resumes with CDC", async () => {
    const { intuit, h, conn } = await setup();
    const { summary } = await run(h, conn, iso(h.clock.t - 10 * DAY));
    expect(summary.mode).toBe("incremental");
    expect(intuit.state.cdcRequests).toHaveLength(1);
    expect(intuit.state.queries).toEqual([ACCOUNT_QUERY]);
  });

  it("a missing, malformed or future cursor is a full reload too (never a guess)", () => {
    const now = Date.parse("2026-11-05T12:00:00.000Z");
    expect(usableCursor(null, now)).toBeNull();
    expect(usableCursor({ value: "yesterday" }, now)).toBeNull();
    expect(usableCursor({ value: "2026-11-05T12:00:00Z" }, now)).toBeNull();
    expect(usableCursor({ value: "2026-12-05T12:00:00.000Z" }, now)).toBeNull();
    expect(usableCursor({ value: "2026-11-04T12:00:00.000Z" }, now)).toBe(Date.parse("2026-11-04T12:00:00.000Z"));
    expect(CDC_LOOKBACK_MS).toBe(30 * DAY);
  });
});

describe("Preferences (acceptance: read on connect and every sync; flags stored on the connection; change recorded and audited)", () => {
  it("every sync reads Preferences first, before any entity data", async () => {
    const { intuit, h, conn } = await setup();
    const order: string[] = [];
    server.events.on("request:start", ({ request }) => {
      const p = new URL(request.url).pathname;
      if (p.includes("/preferences")) order.push("preferences");
      else if (p.includes("/query") || p.includes("/cdc")) order.push("data");
    });
    const first = await run(h, conn, null);
    await run(h, conn, first.summary.cursor.value);
    server.events.removeAllListeners();
    expect(intuit.state.preferencesRequests).toBe(2);
    expect(order[0]).toBe("preferences");
    expect(order.indexOf("preferences", 1)).toBeGreaterThan(order.indexOf("data"));
    expect(order.filter((x) => x === "preferences")).toHaveLength(2);
  });

  it("class tracking, location tracking and multicurrency are stored on the connection with the check time", async () => {
    const { h, conn } = await setup({ preferences: { classPerLine: true, departments: true, multicurrency: true } });
    await run(h, conn, null);
    const row = h.rows.get(conn.id)!;
    expect(row.features).toEqual({ class_tracking: true, location_tracking: true, multicurrency: true });
    expect(row.features_checked_at).toBe(iso(h.clock.t));
  });

  it("class tracking per transaction alone counts as class tracking; off everywhere is false for all three", async () => {
    const a = await setup({ preferences: { classTracking: true } });
    await run(a.h, a.conn, null);
    expect(a.h.rows.get(a.conn.id)?.features).toEqual({ class_tracking: true, location_tracking: false, multicurrency: false });
    RateLimiter.resetForTests();
    const b = await setup();
    await run(b.h, b.conn, null);
    expect(b.h.rows.get(b.conn.id)?.features).toEqual({ class_tracking: false, location_tracking: false, multicurrency: false });
  });

  it("the first detection is audited, an unchanged re-read is not, a flip is audited with old and new values", async () => {
    const { intuit, h, conn } = await setup({ preferences: { classPerLine: true } });
    const first = await run(h, conn, null);
    const actions = () => h.audits.map((a) => a.action);
    expect(actions()).toEqual(["connection.features_update.requested", "connection.features_update.succeeded"]);
    expect(h.audits[1]).toMatchObject({
      laneId: LANE,
      actor: { kind: "service" },
      target: `connection:${conn.id}`,
      metadata: { provider: "quickbooks", changes: { class_tracking: { from: null, to: true }, location_tracking: { from: null, to: false }, multicurrency: { from: null, to: false } } },
    });
    // Re-read, nothing changed: the check time moves, no audit.
    h.audits.length = 0;
    h.clock.t += 1000;
    const conn2 = await h.connections.load(LANE, conn.id);
    await run(h, conn2, first.summary.cursor.value);
    expect(h.audits).toEqual([]);
    expect(h.rows.get(conn.id)?.features_checked_at).toBe(iso(h.clock.t));
    // The owner turns class tracking off in QuickBooks.
    intuit.state.preferences = syntheticPreferences({ classPerLine: false });
    h.clock.t += 1000;
    await run(h, await h.connections.load(LANE, conn.id), first.summary.cursor.value);
    expect(h.audits[1]?.metadata).toEqual({ provider: "quickbooks", changes: { class_tracking: { from: true, to: false } } });
    expect(h.rows.get(conn.id)?.features.class_tracking).toBe(false);
  });

  it("the audit is written before the change: if the audit write fails, the flags are not stored and the run fails", async () => {
    const { h, conn } = await setup({ preferences: { classPerLine: true } });
    const { createQboFeatureRecorder } = await import("./features");
    const saved: unknown[] = [];
    const recorder = createQboFeatureRecorder({ store: { save: async (...a) => void saved.push(a) }, audit: { log: async () => { throw new Error("audit down"); } } });
    await expect(recorder.record(LANE, conn, { class_tracking: true, location_tracking: false, multicurrency: false }, iso(h.clock.t))).rejects.toThrow();
    expect(saved).toEqual([]);
  });

  it("the Preferences object is stored as a raw record limited to the flags, report basis and fiscal-year start", async () => {
    const { h, conn } = await setup({ preferences: { classPerLine: true } });
    const { records } = await run(h, conn, null);
    const prefs = byType(records).Preferences![0]!;
    expect(prefs.payload).toEqual({
      Id: FAKE_REALM,
      MetaData: { CreateTime: "2026-08-01T09:00:00-04:00", LastUpdatedTime: "2026-08-01T09:00:00-04:00" },
      AccountingInfoPrefs: { FirstMonthOfFiscalYear: "January", TrackDepartments: false, ClassTrackingPerTxn: false, ClassTrackingPerTxnLine: true },
      CurrencyPrefs: { MultiCurrencyEnabled: false, HomeCurrency: { value: "USD" } },
      ReportPrefs: { ReportBasis: "Accrual" },
    });
  });
});

describe("nothing depends on multicurrency or sales tax (acceptance: test with both off, and on)", () => {
  const strip = (data: FakeData) => {
    for (const list of Object.values(data)) for (const o of list) for (const k of ["CurrencyRef", "ExchangeRate", "TxnTaxDetail", "HomeBalance", "TaxExemptionReasonId"]) delete o[k];
    return data;
  };

  it("with multicurrency and sales tax off (no currency, exchange-rate or tax fields anywhere) the sync is complete and valid", async () => {
    const { h, conn } = await setup({ data: strip(syntheticData(2)), preferences: { multicurrency: false } });
    const { records, summary } = await run(h, conn, null);
    expect(summary.mode).toBe("full");
    expect(byType(records).Invoice).toHaveLength(2);
    expect(JSON.stringify(records)).not.toMatch(/CurrencyRef|ExchangeRate|Tax/);
    expect(h.rows.get(conn.id)?.features.multicurrency).toBe(false);
  });

  it("with both on, currency refs may appear but tax detail never does and the run does not change shape", async () => {
    const data = syntheticData(2);
    for (const o of data.Invoice!) Object.assign(o, { CurrencyRef: { value: "EUR" }, ExchangeRate: 1.08, HomeTotalAmt: 121.5, TxnTaxDetail: { TotalTax: 9, TaxLine: [{ Amount: 9 }] }, GlobalTaxCalculation: "TaxExcluded" });
    const { h, conn } = await setup({ data, preferences: { multicurrency: true } });
    const { records } = await run(h, conn, null);
    const inv = byType(records).Invoice![0]!;
    expect(inv.payload.CurrencyRef).toEqual({ value: "EUR" });
    expect(inv.payload.ExchangeRate).toBe(1.08);
    expect(JSON.stringify(records)).not.toMatch(/Tax|HomeTotalAmt/);
  });
});

describe("read and query calls only (acceptance: a test fails on any create, update, delete or batch call)", () => {
  it("every request a full sync and a CDC sync make is a GET on preferences, companyinfo, query or cdc", async () => {
    const { intuit, h, conn } = await setup();
    const seen: { method: string; path: string }[] = [];
    server.events.on("request:start", ({ request }) => {
      const u = new URL(request.url);
      if (u.hostname.endsWith("intuit.com")) seen.push({ method: request.method, path: u.pathname.replace(`/v3/company/${FAKE_REALM}`, "") });
    });
    const first = await run(h, conn, null);
    h.clock.t += 60_000;
    await run(h, conn, first.summary.cursor.value);
    server.events.removeAllListeners();
    expect(seen.length).toBeGreaterThan(10);
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(["GET"]));
    const kinds = new Set(seen.map((s) => s.path.replace(/\/\d+$/, "")));
    expect([...kinds].sort()).toEqual(["/companyinfo", "/cdc", "/preferences", "/query"].sort());
    // The fake answers 500 to anything else under the company path and records it.
    expect(intuit.state.unexpected).toEqual([]);
  });

  it("the client object exposes only get, and the sync code has no write verb, batch, delete or writer import", () => {
    for (const f of ["api.ts", "sync.ts", "entities.ts", "features.ts"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
      expect(src, f).not.toMatch(/\/batch|operation=|\/void|\/send|\bwriter\b|revoke|createQuickBooksWriter|connectors\/write/i);
      expect(src, f).not.toMatch(/\.(post|put|patch|delete)\s*\(/);
    }
    const api = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
    expect([...api.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1])).toEqual(["GET"]);
  });

  it("the sync reaches Intuit only through QboApi.get (the API object has nothing else to call)", async () => {
    const { h } = await setup();
    expect(Object.keys(h.api)).toEqual(["get"]);
  });
});

describe("no bank account numbers or personal data are stored (acceptance: field allowlist test)", () => {
  async function everything() {
    const { intuit, h, conn } = await setup({ preferences: { classPerLine: true } });
    const full = await run(h, conn, null);
    const changedAt = h.clock.t + 1000;
    for (const list of Object.values(intuit.state.data)) for (const o of list) touch(o, changedAt);
    h.clock.t += 5000;
    const cdc = await run(h, conn, full.summary.cursor.value);
    return { records: [...full.records, ...cdc.records] };
  }

  it("no stored payload contains an account or routing number, an e-mail, a phone, an address, a memo, a tax id, a custom field or a check number", async () => {
    const { records } = await everything();
    expect(records.length).toBeGreaterThan(40);
    const text = JSON.stringify(records);
    for (const needle of [SYNTHETIC_BANK_NUMBER, SYNTHETIC_ROUTING, SYNTHETIC_EMAIL, "555-0100", "Synthetic Way", "synthetic private note", "synthetic memo", "synthetic line description", "XXX-SYNTH", "CHK-998877", "1042", "Bank account"]) {
      expect(text, needle).not.toContain(needle);
    }
    for (const key of ["AcctNum", "BankAccountNum", "RoutingNum", "CustomField", "PrivateNote", "PrimaryEmailAddr", "PrimaryPhone", "BillAddr", "TxnTaxDetail", "TaxCodeRef", "PrimaryTaxIdentifier", "TaxIdentifier", "BillRate", "PaymentRefNum", "CheckNum", "CustomerMemo", "Description", "GivenName", "FamilyName", "SyncToken", "UnitPrice", "TaxPrefs", "EmailMessagesPrefs"]) {
      expect(text, key).not.toContain(`"${key}"`);
    }
  });

  it("every key in every stored payload is on the per-entity allowlist (a new Intuit field is dropped, never stored)", async () => {
    const { records } = await everything();
    const ALLOWED = new Set([
      "Id", "MetaData", "CreateTime", "LastUpdatedTime", "Name", "FullyQualifiedName", "Active", "AccountType", "AccountSubType", "Classification", "SubAccount", "ParentRef", "CurrentBalance",
      "CurrentBalanceWithSubAccounts", "CurrencyRef", "SubClass", "DisplayName", "Job", "Balance", "BalanceWithJobs", "Vendor1099", "DocNumber", "TxnDate", "DueDate", "TotalAmt", "CustomerRef", "ClassRef",
      "DepartmentRef", "ExchangeRate", "Line", "LinkedTxn", "TxnId", "TxnType", "LineNum", "Amount", "DetailType", "SalesItemLineDetail", "AccountBasedExpenseLineDetail", "ItemBasedExpenseLineDetail",
      "DepositLineDetail", "JournalEntryLineDetail", "AccountRef", "ItemRef", "PostingType", "Entity", "Type", "EntityRef", "value", "UnappliedAmt", "DepositToAccountRef", "VendorRef", "APAccountRef",
      "PayType", "CheckPayment", "BankAccountRef", "CreditCardPayment", "CCAccountRef", "PaymentType", "Adjustment", "Voided", "CompanyName", "LegalName", "Country", "FiscalYearStartMonth", "CompanyStartDate",
      "AccountingInfoPrefs", "FirstMonthOfFiscalYear", "TrackDepartments", "ClassTrackingPerTxn", "ClassTrackingPerTxnLine", "CurrencyPrefs", "MultiCurrencyEnabled", "HomeCurrency", "ReportPrefs", "ReportBasis",
    ]);
    const bad = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (!ALLOWED.has(k)) bad.add(k); walk(x); }
    };
    for (const r of records) walk(r.payload);
    expect([...bad]).toEqual([]);
  });

  it("transactions that name an Employee are never stored as live records (per-person pay); they become tombstones", async () => {
    const data = syntheticData(2);
    const je = data.JournalEntry!;
    (je[0]!.Line as FakeObject[])[0]!.JournalEntryLineDetail = { PostingType: "Debit", AccountRef: { value: "60" }, Entity: { Type: "employee", EntityRef: { value: "77", name: "Synthetic Employee", type: "EMPLOYEE" } } };
    data.Purchase![0]!.EntityRef = { value: "88", name: "Synthetic Employee", type: "Employee" };
    data.Deposit![0]!.EntityRef = { value: "99", type: "Other" }; // any person that is not a customer or vendor
    const { h, conn } = await setup({ data });
    const { records } = await run(h, conn, null);
    const types = byType(records);
    for (const [type, ids] of [["JournalEntry", ["1"]], ["Purchase", ["1"]], ["Deposit", ["1"]]] as const) {
      const dead = types[type]!.filter((r) => r.deleted).map((r) => r.external_id);
      expect(dead, type).toEqual(ids);
      expect(types[type]!.find((r) => r.deleted)!.payload).toEqual({ Id: "1" });
      expect(types[type]!.filter((r) => !r.deleted).map((r) => r.external_id)).toEqual(["2"]);
    }
    expect(JSON.stringify(records)).not.toMatch(/Employee|mployee|"77"|"88"|"99"/);
    expect(h.logs.find((l) => l.event === "qbo.sync.done")?.fields).toMatchObject({ excluded_objects: 3 });
  });

  it("an Employee-typed transaction in a CDC answer is excluded too, and a version stored earlier ends up deleted", async () => {
    const { intuit, h, conn } = await setup();
    const first = await run(h, conn, null);
    expect(byType(first.records).Purchase!.every((r) => !r.deleted)).toBe(true);
    h.clock.t += 60_000;
    Object.assign(intuit.state.data.Purchase![1]!, { EntityRef: { value: "88", type: "Employee" } });
    touch(intuit.state.data.Purchase![1]!, h.clock.t);
    const second = await run(h, conn, first.summary.cursor.value);
    expect(byType(second.records).Purchase).toEqual([expect.objectContaining({ external_id: "2", deleted: true, payload: { Id: "2" }, source_updated_at: iso(h.clock.t) })]);
  });

  it("runs of 5+ digits in account, customer, vendor and company names are masked (a bank account named with its number)", async () => {
    const data = syntheticData(1);
    Object.assign(data.Account![0]!, { Name: "Operating Checking 123456789", FullyQualifiedName: "Banks:Operating Checking 1234-5678-9" });
    Object.assign(data.Customer![0]!, { DisplayName: "Synthetic Co 12 345 678" });
    Object.assign(data.Vendor![0]!, { DisplayName: "Synthetic Vendor ８８８８８８" });
    const { h, conn } = await setup({ data });
    const { records } = await run(h, conn, null);
    const types = byType(records);
    expect(types.Account![0]!.payload).toMatchObject({ Name: "Operating Checking [masked]", FullyQualifiedName: "Banks:Operating Checking [masked]" });
    expect(types.Customer![0]!.payload.DisplayName).toBe("Synthetic Co [masked]");
    expect(types.Vendor![0]!.payload.DisplayName).toBe("Synthetic Vendor [masked]");
    expect(JSON.stringify(records)).not.toMatch(/123456789|8888/);
    expect(types.Account![0]!.payload.Name).not.toMatch(/[0-9]{5}/);
  });

  it("an object with an unexpected `status` is refused, not stored as an empty live record", async () => {
    const { intuit, h, conn } = await setup();
    const first = await run(h, conn, null);
    h.clock.t += 60_000;
    intuit.state.data.Customer![0] = { Id: "1", status: "deleted", MetaData: { LastUpdatedTime: iso(h.clock.t) } };
    await expect(run(h, conn, first.summary.cursor.value)).rejects.toMatchObject({ info: { kind: "provider_error" } });
  });

  it("an unknown field with an innocent name (or a bank number in a custom-looking field) is dropped by the projection", async () => {
    const data = syntheticData(1);
    Object.assign(data.Account![0]!, { SomethingNew: "x", FieldFromIntuit2027: SYNTHETIC_BANK_NUMBER, Line: undefined });
    Object.assign(data.Invoice![0]!, { Line: [{ Id: "1", Amount: 5, DetailType: "SalesItemLineDetail", CustomField: [{ Name: "SSN", StringValue: "123" }], SalesItemLineDetail: { ClassRef: { value: "2" }, AnythingElse: SYNTHETIC_BANK_NUMBER } }] });
    const { h, conn } = await setup({ data });
    const { records } = await run(h, conn, null);
    expect(JSON.stringify(records)).not.toMatch(new RegExp(`SomethingNew|FieldFromIntuit2027|SSN|AnythingElse|${SYNTHETIC_BANK_NUMBER}`));
    expect(byType(records).Invoice![0]!.payload.Line).toEqual([{ Id: "1", Amount: 5, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ClassRef: { value: "2" } } }]);
  });

  it("the stored records pass the raw store's own guards (no forbidden field, no content body) and class is kept per line", async () => {
    const { records } = await everything();
    expect(() => assertNoForbiddenFields(records)).not.toThrow();
    expect(() => assertContentAllowed(records, { storeContentBodies: false })).not.toThrow();
    const inv = records.find((r) => r.object_type === "Invoice")!;
    expect((inv.payload.Line as { SalesItemLineDetail: { ClassRef: { value: string } } }[])[0]!.SalesItemLineDetail.ClassRef).toEqual({ value: "2" });
  });

  it("a voided transaction is flagged from the exact marker only", async () => {
    const data = syntheticData(2);
    Object.assign(data.Invoice![0]!, { PrivateNote: "Voided", TotalAmt: 0 });
    const { h, conn } = await setup({ data });
    const { records } = await run(h, conn, null);
    const [a, b] = byType(records).Invoice!;
    expect(a!.payload.Voided).toBe(true);
    expect(b!.payload).not.toHaveProperty("Voided");
  });
});

describe("payroll and compensation are never stored (D-25 default: excluded; spec finance.md section 2)", () => {
  const payrollData = () => {
    const data = syntheticData(3);
    // Account 3 is a payroll account by subtype; account 2 is one by configured id; account 1 is an ordinary bank account.
    Object.assign(data.Account![2]!, { AccountSubType: "PayrollExpenses", Name: "Synthetic Wages Expense", AccountType: "Expense", CurrentBalance: 98765.43 });
    Object.assign(data.Account![1]!, { Name: "Synthetic Other Expense", AccountSubType: "Utilities", CurrentBalance: 4321.09 });
    // A lump-sum payroll journal entry: one line on the payroll account, no Entity at all.
    (data.JournalEntry![0] as FakeObject).TotalAmt = 123456.78;
    (data.JournalEntry![0] as FakeObject).Line = [
      { Id: "0", Amount: 123456.78, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "3" } } },
      { Id: "1", Amount: 123456.78, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "1" } } },
    ];
    // A purchase whose header account is a payroll-subtype account.
    Object.assign(data.Purchase![0]!, { AccountRef: { value: "3" }, TotalAmt: 7777.77 });
    // A bill with one line on the configured-id payroll account.
    (data.Bill![0] as FakeObject).TotalAmt = 5555.55;
    (data.Bill![0] as FakeObject).Line = [{ Id: "1", Amount: 5555.55, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "2" } } }];
    return data;
  };
  const SECRET_AMOUNTS = /123456\.78|7777\.77|5555\.55|98765\.43/;

  it("a full load excludes the whole transaction (not just the line) and the payroll account itself; ordinary records stay", async () => {
    const { h, conn } = await setup({ data: payrollData() });
    h.payrollState.settings.accountIds = ["2"];
    const { records } = await run(h, conn, null);
    const types = byType(records);
    const live = (t: string) => types[t]!.filter((r) => !r.deleted).map((r) => r.external_id);
    expect(live("JournalEntry")).toEqual(["2", "3"]);
    expect(live("Purchase")).toEqual(["2", "3"]);
    expect(live("Bill")).toEqual(["2", "3"]);
    expect(live("Account")).toEqual(["1"]); // 2 by id, 3 by subtype
    expect(types.Account!.filter((r) => r.deleted).map((r) => [r.external_id, r.payload])).toEqual([["2", { Id: "2" }], ["3", { Id: "3" }]]);
    expect(JSON.stringify(records)).not.toMatch(SECRET_AMOUNTS);
    expect(h.logs.find((l) => l.event === "qbo.sync.done")?.fields).toMatchObject({ excluded_objects: 5 });
  });

  it("a CDC run classifies against a fresh Account query and excludes the changed transactions; a stored version ends up deleted", async () => {
    const { intuit, h, conn } = await setup({ data: payrollData() });
    h.payrollState.settings.accountIds = ["2"];
    const first = await run(h, conn, null);
    expect(first.records.length).toBeGreaterThan(0);
    intuit.state.queries.length = 0;
    h.clock.t += 60_000;
    // An ordinary journal entry is edited to post to the payroll account.
    const je = intuit.state.data.JournalEntry![1]!;
    (je.Line as FakeObject[])[0]!.JournalEntryLineDetail = { PostingType: "Debit", AccountRef: { value: "3" } };
    je.TotalAmt = 31337.31;
    touch(je, h.clock.t);
    const second = await run(h, conn, first.summary.cursor.value);
    expect(second.summary.mode).toBe("incremental");
    expect(intuit.state.queries).toEqual([ACCOUNT_QUERY]);
    expect(byType(second.records).JournalEntry).toEqual([expect.objectContaining({ external_id: "2", deleted: true, payload: { Id: "2" } })]);
    expect(JSON.stringify(second.records)).not.toMatch(/31337|SECRET/);
  });

  it("a payroll account named generically is still caught by the name safety net, and its sub-accounts follow it", async () => {
    const data = syntheticData(3);
    Object.assign(data.Account![0]!, { Name: "Payroll Liabilities", AccountSubType: "OtherCurrentLiabilities" });
    Object.assign(data.Account![1]!, { Name: "Federal Taxes", ParentRef: { value: "1" } });
    const { h, conn } = await setup({ data });
    const { records } = await run(h, conn, null);
    expect(byType(records).Account!.filter((r) => !r.deleted).map((r) => r.external_id)).toEqual(["3"]);
  });

  it("customers and vendors listed in excluded_entity_ids (people paid as vendors) are treated like employees", async () => {
    const data = syntheticData(2);
    Object.assign(data.Bill![0]!, { VendorRef: { value: "2" } });
    const { h, conn } = await setup({ data });
    h.payrollState.settings.excludedEntityIds = ["2"];
    const { records } = await run(h, conn, null);
    const types = byType(records);
    expect(types.Vendor!.find((r) => r.external_id === "2")).toMatchObject({ deleted: true, payload: { Id: "2" } });
    expect(types.Bill!.find((r) => r.external_id === "1")).toMatchObject({ deleted: true, payload: { Id: "1" } });
    expect(types.Bill!.find((r) => r.external_id === "2")).toMatchObject({ deleted: false });
  });

  it("FAIL CLOSED: if the payroll setting cannot be read the run fails before any Intuit call, audit row or write", async () => {
    const { intuit, h, conn } = await setup({ data: payrollData() });
    h.payrollState.fail = true;
    const records: unknown[] = [];
    await expect(h.connector.sync!(LANE, conn, null, async (b) => void records.push(...b))).rejects.toMatchObject({ info: { kind: "transient", message: "Lane configuration unavailable" } });
    expect(records).toEqual([]);
    expect(intuit.state.apiRequests).toHaveLength(0);
    expect(h.audits).toEqual([]);
    // and through the runner the cursor does not move
    let cursor: string | null = iso(h.clock.t - DAY);
    const old = cursor;
    const failing = createConnectorSyncRunner({
      connector: h.connector,
      cursors: { get: async () => cursor, put: async (_l, _c, _e, next) => { cursor = next; return true; } },
      sinkFor: () => async () => {},
    });
    await expect(failing(LANE, conn)).rejects.toBeTruthy();
    expect(cursor).toBe(old);
  });

  it("a malformed payroll setting fails closed too (reader level)", async () => {
    const { createLaneConfigReader } = await import("../vault/lane-config");
    const reader = (finance: unknown) =>
      createLaneConfigReader((async () => ({ schema: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { config: { finance } }, error: null }) }) }) }) }) })) as never);
    await expect(reader({ payroll: { account_ids: ["not-a-number"] } }).payrollSettings("PKG")).rejects.toMatchObject({ info: { kind: "provider_error" } });
    const ok = await reader(undefined).payrollSettings("PKG");
    expect(ok).toMatchObject({ accountIds: [], excludedEntityIds: [] });
    expect(ok.accountSubtypes).toContain("PayrollExpenses");
    await expect(reader({ payroll: { account_ids: ["12"], excluded_entity_ids: ["5"] } }).payrollSettings("PKG")).resolves.toMatchObject({ accountIds: ["12"], excludedEntityIds: ["5"] });
  });
});

describe("document numbers (M-B)", () => {
  it("a 16-digit bill number is masked, ordinary invoice numbers are kept", async () => {
    const data = syntheticData(2);
    Object.assign(data.Bill![0]!, { DocNumber: "1234567890123456" });
    Object.assign(data.Invoice![0]!, { DocNumber: "INV-100234" });
    Object.assign(data.JournalEntry![0]!, { DocNumber: "JE 1234-5678" });
    const { h, conn } = await setup({ data });
    const { records } = await run(h, conn, null);
    const types = byType(records);
    expect(types.Bill![0]!.payload.DocNumber).toBe("[masked]");
    expect(types.Invoice![0]!.payload.DocNumber).toBe("INV-100234");
    expect(types.JournalEntry![0]!.payload.DocNumber).toBe("JE [masked]");
  });
});

describe("throttling, errors, logs and lanes", () => {
  it("rides out Intuit 429s (Retry-After honoured by the shared HTTP client) and still completes", async () => {
    const { intuit, h, conn } = await setup();
    intuit.state.failRead = { status: 429, times: 2 };
    const { summary } = await run(h, conn, null);
    expect(summary.mode).toBe("full");
  });

  it("a record that does not fit the allowlist schema fails the run (provider_error) instead of being dropped", async () => {
    const data = syntheticData(1);
    (data.Invoice![0] as FakeObject).TotalAmt = "112.50";
    const { h, conn } = await setup({ data });
    await expect(run(h, conn, null)).rejects.toMatchObject({ info: { kind: "provider_error" } });
  });

  it("CompanyInfo for another company than the connection is refused", async () => {
    const { intuit, h, conn } = await setup();
    const { http, HttpResponse } = await import("../testing/msw/index");
    server.use(http.get("https://sandbox-quickbooks.api.intuit.com/v3/company/:realm/companyinfo/:id", () => HttpResponse.json({ CompanyInfo: { Id: "9999" } })));
    void intuit;
    await expect(run(h, conn, null)).rejects.toMatchObject({ info: { kind: "provider_error" } });
  });

  it("a targeted sync (objectTypes) needs a current cursor, hands the same cursor back and does not touch other entities", async () => {
    const { intuit, h, conn } = await setup();
    await expect(run(h, conn, null, { objectTypes: ["Invoice"] })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    const cursor = iso(h.clock.t - DAY);
    for (const e of ["Invoice", "Bill", "Customer"]) for (const o of intuit.state.data[e]!) touch(o, h.clock.t - 1000);
    const { summary, records } = await run(h, conn, cursor, { objectTypes: ["Invoice", "Bill"] });
    expect(summary.cursor.value).toBe(cursor);
    expect(intuit.state.cdcRequests.at(-1)?.entities).toBe("Invoice,Bill");
    expect(new Set(records.map((r) => r.object_type))).toEqual(new Set(["Invoice", "Bill", "Preferences", "CompanyInfo"]));
    await expect(run(h, conn, cursor, { objectTypes: ["Widget"] })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
  });

  it("a refused targeted sync costs no Intuit call and no audit row; a singleton-only run fetches no entities", async () => {
    const { intuit, h, conn } = await setup();
    await expect(run(h, conn, null, { objectTypes: ["Preferences"] })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(intuit.state.apiRequests).toHaveLength(0);
    expect(h.audits).toEqual([]);
    const cursor = iso(h.clock.t - DAY);
    const { records, summary } = await run(h, conn, cursor, { objectTypes: ["Preferences", "CompanyInfo"] });
    expect(new Set(records.map((r) => r.object_type))).toEqual(new Set(["Preferences", "CompanyInfo"]));
    expect(summary.cursor.value).toBe(cursor);
    expect(intuit.state.cdcRequests).toEqual([]);
    expect(intuit.state.queries).toEqual([]);
  });

  it("neither tokens nor record contents reach the log", async () => {
    const { intuit, h, conn } = await setup();
    await run(h, conn, null);
    const text = JSON.stringify(h.logs);
    for (const pair of intuit.state.issued) expect(text).not.toMatch(new RegExp(`${pair.access}|${pair.refresh}`));
    expect(text).not.toContain("Synthetic Customer");
    expect(text).not.toContain(FAKE_REALM);
  });

  it("another lane cannot sync the connection", async () => {
    const { intuit, h, conn } = await setup();
    const before = intuit.state.apiRequests.length;
    await expect(h.connector.sync!("APK", conn, null, async () => {})).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
    expect(intuit.state.apiRequests).toHaveLength(before);
  });
});
