// T-196: the connector error export route. Owner or admin_technical of the lane at AAL2 (other roles 403, other lanes 404, no
// session 401), range max 90 days, CSV (formula-injection safe) or JSON, audited before the file leaves, fixed columns, rows capped.
// Mocks only (rule 10).
import { describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { connectorErrorExportUrl, createConnectorErrorExportHandler, EXPORT_MAX_ROWS } from "../lib/connector-error-export";

const ORIGIN = "http://localhost:3000";
const USER = "00000000-0000-4000-8000-0000000000aa";
const req = (qs = "from=2026-11-01&to=2026-11-12") => new Request(`${ORIGIN}/api/lanes/PKG/connector-errors/export?${qs}`);

const ROW = {
  at: "2026-11-05T10:00:00.000Z", connection_id: "c1", provider: "quickbooks", endpoint: "/v3/company/{realm}/query", http_status: 400, provider_error_code: "2500",
  provider_message: "=HYPERLINK(\"http://x\")", provider_tid: "synthetic-tid-0001", kind: "invalid_input", disposition: "fail", retry_after_seconds: null,
  // a careless database layer might return more than the fixed columns; the export must not pass it on
  lane_id: "PKG", id: "row-id-leak",
};
const withIds = (rows: Record<string, unknown>[]) => rows.map((r, i) => ({ ...r, id: `id-${String(i).padStart(6, "0")}` }));

type B = { pageSize?: number; lane?: AuthError | null; role?: AuthError | null; rows?: Record<string, unknown>[]; auditFails?: boolean; queryError?: boolean };
function setup(b: B = {}) {
  const calls = { requireLane: [] as string[], requireRole: [] as { lane: string; roles: readonly string[] }[], audit: [] as unknown[], queries: [] as unknown[][] };
  const all = withIds(b.rows ?? [ROW]);
  const handler = createConnectorErrorExportHandler({
    guards: async () => ({
      requireLane: async (lane: string) => {
        calls.requireLane.push(lane);
        if (b.lane) throw b.lane;
        return { session: { userId: USER }, laneId: lane, client: {} } as never;
      },
      requireRole: async (lane: string, roles: readonly string[]) => {
        calls.requireRole.push({ lane, roles });
        if (b.role) throw b.role;
        return { session: { userId: USER }, laneId: lane, client: {} } as never;
      },
    }),
    audit: () => ({ log: vi.fn(async (e: unknown) => { if (b.auditFails) throw new Error("audit down"); calls.audit.push(e); }) }) as never,
    pageQuery: () => async (...args) => {
      calls.queries.push(args);
      if (b.queryError) return { data: null, error: { message: "db text jane@example.test" } };
      const afterId = args[6] as string | null;
      // the server may cap a response below the requested limit (PostgREST max_rows)
      const limit = Math.min(args[7] as number, b.pageSize ?? Infinity);
      return { data: all.filter((r) => afterId === null || (r.id as string) > afterId).slice(0, limit), error: null };
    },
    now: () => new Date("2026-11-13T09:00:00.000Z"),
  });
  return { handler, calls };
}
const get = (h: ReturnType<typeof setup>["handler"], qs?: string) => h(req(qs), "PKG");

describe("access", () => {
  it("asks the guard for exactly owner or admin_technical of the requested lane", async () => {
    const { handler, calls } = setup();
    await get(handler);
    expect(calls.requireRole[0]?.lane).toBe("PKG");
    expect([...(calls.requireRole[0]?.roles ?? [])].sort()).toEqual(["admin_technical", "owner"]);
  });
  it("another role gets 403 and nothing is read or audited", async () => {
    const { handler, calls } = setup({ role: new AuthError("forbidden") });
    const res = await get(handler);
    expect(res.status).toBe(403);
    expect(calls.queries).toEqual([]);
    expect(calls.audit).toEqual([]);
  });
  it("AAL1 gets 403, no session 401", async () => {
    expect((await get(setup({ lane: new AuthError("mfa_required") }).handler)).status).toBe(403);
    expect((await get(setup({ lane: new AuthError("no_session") }).handler)).status).toBe(401);
  });
  it("another lane (not a member, or no such lane) gets 404 and no role check, read or audit", async () => {
    const { handler, calls } = setup({ lane: new AuthError("forbidden") });
    for (const lane of ["APK", "NL", "XX", ""]) {
      const res = await handler(req(), lane);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(calls.requireRole).toEqual([]);
    expect(calls.queries).toEqual([]);
    expect(calls.audit).toEqual([]);
  });
});

describe("request", () => {
  it.each([
    ["from=2026-11-01&to=2026-11-12&format=xml", 400, "invalid_request"],
    ["from=2026-11-01&to=2026-11-12&dataset=users", 400, "invalid_request"],
    ["from=2026-11-12&to=2026-11-01", 400, "invalid_range"],
    ["from=nope&to=2026-11-01", 400, "invalid_range"],
    ["to=2026-11-01", 400, "invalid_range"],
    ["from=2026-01-01&to=2026-11-01", 400, "range_too_long"],
  ])("%s", async (qs, status, error) => {
    const { handler, calls } = setup();
    const res = await get(handler, qs);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
    expect(calls.audit).toEqual([]);
  });
});

describe("result", () => {
  it("CSV: fixed columns only, formula-safe, attachment, never cached", async () => {
    const { handler, calls } = setup();
    const res = await get(handler);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="connector-errors-PKG-2026-11-13.csv"');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM for Excel
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).replace(/^\uFEFF/, "");
    const [header, line] = text.split("\r\n");
    expect(header).toBe("at,connection_id,provider,endpoint,http_status,provider_error_code,provider_message,provider_tid,kind,disposition,retry_after_seconds");
    expect(line).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(text).not.toContain("row-id-leak");
    // the query is lane scoped and covers [from, to + 1 day)
    expect(calls.queries[0]?.slice(0, 6)).toEqual(["connector_api_errors", expect.not.stringContaining("*"), "at", "PKG", "2026-11-01T04:00:00.000Z", "2026-11-13T05:00:00.000Z"]);
  });
  it("JSON: the same rows with the lane and range", async () => {
    const { handler } = setup();
    const res = await get(handler, "from=2026-11-01&to=2026-11-12&format=json");
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { lane: string; rows: Record<string, unknown>[] };
    expect(body.lane).toBe("PKG");
    expect(body.rows).toHaveLength(1);
    expect(Object.keys(body.rows[0] ?? {})).not.toContain("id");
    expect(Object.keys(body.rows[0] ?? {})).not.toContain("lane_id");
  });
  it("sync runs: flattened, the error message is not exported", async () => {
    const run = { started_at: "2026-11-05T10:00:00.000Z", finished_at: "2026-11-05T10:01:00.000Z", connection_id: "c1", job: "reports", kind: "snapshot", trigger: "schedule", status: "failed", records_received: 0, records_written: 0, error: { kind: "transient", http_status: 503, provider_error_code: "10001", provider_tid: "t", endpoint: "/v3/x", message: "free text" } };
    const { handler, calls } = setup({ rows: [run] });
    const res = await get(handler, "from=2026-11-01&to=2026-11-12&dataset=runs&format=json");
    const text = await res.text();
    expect(text).not.toContain("free text");
    expect(JSON.parse(text).rows[0]).toMatchObject({ job: "reports", status: "failed", error_kind: "transient", error_http_status: 503 });
    expect(calls.queries[0]?.[0]).toBe("sync_runs");
  });
  it("is audited before the file leaves: who, lane, range, format, dataset, row count; no row content", async () => {
    const { handler, calls } = setup({ rows: [ROW, ROW] });
    await get(handler, "from=2026-11-01&to=2026-11-12&format=json");
    expect(calls.audit).toEqual([
      { laneId: "PKG", actor: { kind: "user", userId: USER }, action: "connector_errors.export", target: "lane:PKG", metadata: { from: "2026-11-01T04:00:00.000Z", to: "2026-11-13T05:00:00.000Z", format: "json", dataset: "errors", rows: 2 } },
    ]);
    expect(JSON.stringify(calls.audit)).not.toContain("HYPERLINK");
  });
  it("if the audit write fails nothing is returned", async () => {
    const res = await get(setup({ auditFails: true }).handler);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("quickbooks");
  });
  it("a database error is a 503 with no database text", async () => {
    const res = await get(setup({ queryError: true }).handler);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("jane@");
  });
  it("pages through more than 1000 rows, and over the cap is 413", async () => {
    const many = Array.from({ length: 2500 }, () => ROW);
    const ok = setup({ rows: many });
    const res = await get(ok.handler, "from=2026-11-01&to=2026-11-12&format=json");
    expect(((await res.json()) as { rows: unknown[] }).rows).toHaveLength(2500);
    expect(ok.calls.queries).toHaveLength(4); // 1000 + 1000 + 500 + the empty page that ends it
    const tooMany = setup({ rows: Array.from({ length: EXPORT_MAX_ROWS + 1 }, () => ROW) });
    const tm = await get(tooMany.handler);
    expect(tm.status).toBe(413);
    expect(((await tm.json()) as { message: string }).message).toMatch(/Narrow the date range/);
    expect(tooMany.calls.audit).toEqual([]);
  });
});

describe("paging", () => {
  it("rows with equal timestamps across a page boundary: no duplicates, no gaps", async () => {
    const same = Array.from({ length: 2300 }, () => ({ ...ROW, at: "2026-11-05T10:00:00.000Z" }));
    const { handler } = setup({ rows: same });
    const body = (await (await get(handler, "from=2026-11-01&to=2026-11-12&format=json")).json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(2300);
  });
  it("a server that caps a page below 1000 (max_rows) still returns everything", async () => {
    const { handler, calls } = setup({ rows: Array.from({ length: 450 }, () => ROW), pageSize: 100 });
    const body = (await (await get(handler, "from=2026-11-01&to=2026-11-12&format=json")).json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(450);
    expect(calls.queries).toHaveLength(6);
  });
  it("rows come back in time order", async () => {
    const rows = [{ ...ROW, at: "2026-11-05T12:00:00.000Z" }, { ...ROW, at: "2026-11-05T09:00:00.000Z" }];
    const body = (await (await get(setup({ rows }).handler, "from=2026-11-01&to=2026-11-12&format=json")).json()) as { rows: { at: string }[] };
    expect(body.rows.map((r) => r.at)).toEqual(["2026-11-05T09:00:00.000Z", "2026-11-05T12:00:00.000Z"]);
  });
});

describe("cross-site requests", () => {
  it.each(["cross-site", "same-site"])("Sec-Fetch-Site %s is refused before anything is read or audited", async (site) => {
    const { handler, calls } = setup();
    const res = await handler(new Request(`${ORIGIN}/api/lanes/PKG/connector-errors/export?from=2026-11-01&to=2026-11-12`, { headers: { "sec-fetch-site": site } }), "PKG");
    expect(res.status).toBe(403);
    expect(calls.requireLane).toEqual([]);
    expect(calls.audit).toEqual([]);
  });
  it.each(["same-origin", "none"])("%s is allowed", async (site) => {
    const res = await setup().handler(new Request(`${ORIGIN}/api/lanes/PKG/connector-errors/export?from=2026-11-01&to=2026-11-12`, { headers: { "sec-fetch-site": site } }), "PKG");
    expect(res.status).toBe(200);
  });
});

describe("time zone", () => {
  it("date-only boundaries are America/New_York days; a timestamp without a zone is refused", async () => {
    const { handler, calls } = setup();
    await get(handler, "from=2026-11-04&to=2026-11-04");
    expect(calls.queries[0]?.slice(4, 6)).toEqual(["2026-11-04T05:00:00.000Z", "2026-11-05T05:00:00.000Z"]); // 20:00 ET on Nov 4 = 01:00Z Nov 5 is inside
    const res = await get(handler, "from=2026-11-04T00:00:00&to=2026-11-05T00:00:00Z");
    expect(res.status).toBe(400);
  });
});

describe("url helper", () => {
  it("builds the relative same-origin URL", () => {
    expect(connectorErrorExportUrl("PKG", { from: "2026-11-01", to: "2026-11-12" })).toBe("/api/lanes/PKG/connector-errors/export?from=2026-11-01&to=2026-11-12&format=csv&dataset=errors");
    expect(connectorErrorExportUrl("P/K G", { from: "a", to: "b", format: "json", dataset: "runs" })).toContain("/api/lanes/P%2FK%20G/");
  });
});
