// T-198 / T-233: the QuickBooks "Check connection" route (the action of the QuickBooks row in Settings -> Connections). The
// route is guarded by requireRole(owner | admin_technical) at AAL2 (other roles 403, other lanes 404), calls one read-only
// check and returns only a status, a time and Intuit's request id. Mocks only (rule 10).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { createConnectionCheckHandler } from "../lib/connection-test";
import { CHECK_STATUSES, describeCheck, parseCheckResult } from "../lib/connection-check-view";

const ORIGIN = "http://localhost:3000";
const CLIENT = { marker: "lane-client" } as never;
const request = (lane = "PKG", headers: Record<string, string> = { origin: ORIGIN }) =>
  new Request(`${ORIGIN}/api/connection-test/qbo/check?lane=${lane}`, { method: "POST", headers });

type Behaviour = { lane?: AuthError | null; role?: AuthError | null };
function setup(b: Behaviour = {}) {
  const calls = { requireLane: [] as string[], requireRole: [] as { lane: string; roles: readonly string[] }[], check: [] as string[] };
  const check = vi.fn(async (lane: string) => {
    calls.check.push(lane);
    // A careless implementation might return more than it should; the route must not pass it on.
    return { status: "ok", checked_at: "2026-11-12T10:00:00.000Z", intuit_tid: "synthetic-tid-0001", realm_id: "9341450000000001", access_token: "synthetic-token-leak" } as never;
  });
  const handler = createConnectionCheckHandler({
    guards: async () => ({
      requireLane: async (lane: string) => {
        calls.requireLane.push(lane);
        if (b.lane) throw b.lane;
        return { session: {}, laneId: lane, client: CLIENT } as never;
      },
      requireRole: async (lane: string, roles: readonly string[]) => {
        calls.requireRole.push({ lane, roles });
        if (b.role) throw b.role;
        return { session: {}, laneId: lane, client: CLIENT } as never;
      },
    }),
    check,
  });
  return { handler, calls, check };
}

describe("check route", () => {
  it("returns only status, checked_at and the intuit request id", async () => {
    const { handler, calls } = setup();
    const res = await handler(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ status: "ok", checked_at: "2026-11-12T10:00:00.000Z", intuit_tid: "synthetic-tid-0001" });
    expect(JSON.stringify(body)).not.toMatch(/9341450000000001|synthetic-token-leak/);
    expect(calls.check).toEqual(["PKG"]);
  });

  it("asks the guard for exactly owner or admin_technical of the requested lane", async () => {
    const { handler, calls } = setup();
    await handler(request("PKG"));
    expect(calls.requireRole).toHaveLength(1);
    expect(calls.requireRole[0]?.lane).toBe("PKG");
    expect([...(calls.requireRole[0]?.roles ?? [])].sort()).toEqual(["admin_technical", "owner"]);
  });

  it("another role (viewer, finance_operator) gets 403 and no check runs", async () => {
    const { handler, check } = setup({ role: new AuthError("forbidden") });
    const res = await handler(request());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(check).not.toHaveBeenCalled();
  });

  it("AAL1 gets 403 and no session gets 401, with no check", async () => {
    const aal1 = setup({ lane: new AuthError("mfa_required") });
    expect((await aal1.handler(request())).status).toBe(403);
    const none = setup({ lane: new AuthError("no_session") });
    expect((await none.handler(request())).status).toBe(401);
    expect(aal1.check).not.toHaveBeenCalled();
    expect(none.check).not.toHaveBeenCalled();
  });

  it("another lane (not a member, or no such lane) gets 404, the same as an unknown lane, and no role check or call", async () => {
    const { handler, calls, check } = setup({ lane: new AuthError("forbidden") });
    for (const lane of ["APK", "NL", "XX", ""]) {
      const res = await handler(request(lane));
      expect(res.status, lane).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(calls.requireRole).toHaveLength(0);
    expect(check).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin or origin-less request before touching the session", async () => {
    const { handler, calls } = setup();
    expect((await handler(request("PKG", { origin: "https://evil.example.test" }))).status).toBe(403);
    expect((await handler(request("PKG", {}))).status).toBe(403);
    expect(calls.requireLane).toHaveLength(0);
  });

  it("an outage is 503 with no detail", async () => {
    const handler = createConnectionCheckHandler({
      guards: async () => ({ requireLane: async () => ({ client: CLIENT }) as never, requireRole: async () => ({ client: CLIENT }) as never }),
      check: async () => {
        throw new Error("database password=synthetic");
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await handler(request());
    errors.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("password");
  });

  it("the route file wires the production check and does no work of its own", () => {
    const src = readFileSync(new URL("../app/api/connection-test/qbo/check/route.ts", import.meta.url), "utf8");
    expect(src).toContain("checkQuickBooksConnection");
    expect(src).not.toMatch(/fetch\(|process\.env|storeToken|getToken|revoke/i);
  });
});

describe("what the page can render", () => {
  it("accepts exactly the three fields and nothing else", () => {
    expect(parseCheckResult({ status: "ok", checked_at: "2026-11-12T10:00:00.000Z", intuit_tid: "t" })).toEqual({ status: "ok", checked_at: "2026-11-12T10:00:00.000Z", intuit_tid: "t" });
    expect(parseCheckResult({ status: "error", checked_at: "2026-11-12T10:00:00.000Z", intuit_tid: null })?.intuit_tid).toBeNull();
    expect(parseCheckResult({ status: "ok", checked_at: "2026-11-12T10:00:00.000Z", intuit_tid: "t", realm_id: "1" })).toBeNull();
    expect(parseCheckResult({ status: "ok", checked_at: "2026-11-12T10:00:00.000Z" })).toBeNull();
    expect(parseCheckResult({ status: "fine", checked_at: "2026-11-12T10:00:00.000Z", intuit_tid: null })).toBeNull();
    expect(parseCheckResult({ status: "ok", checked_at: "yesterday", intuit_tid: null })).toBeNull();
    expect(parseCheckResult(null)).toBeNull();
    expect(parseCheckResult([])).toBeNull();
  });

  it("has a message for every status, and only ok is a success", () => {
    for (const s of CHECK_STATUSES) expect(describeCheck(s).title.length).toBeGreaterThan(0);
    expect(CHECK_STATUSES.filter((s) => describeCheck(s).variant === "success")).toEqual(["ok"]);
  });
});

describe("the Settings page", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const files = ["../components/quickbooks-connection-section.tsx", "../components/connection-check-button.tsx", "../components/settings-page.tsx", "../lib/connection-check-view.ts"];

  it("calls loadLane (the page-level lane gate) before anything else", () => {
    const src = read("../components/settings-page.tsx");
    expect(src).toMatch(/await loadLane\(/);
    expect(src.indexOf("loadLane(")).toBeLessThan(src.indexOf("quickbooksSectionFor("));
  });

  it("uses design tokens only: no hard-coded colours, no palette utilities, no arbitrary values", () => {
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src, f).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch)\(/);
      expect(src, f).not.toMatch(/\b(?:bg|text|border|ring|fill|stroke)-(?:red|green|blue|yellow|orange|gray|grey|slate|zinc|neutral|stone|amber|emerald|white|black)\b/);
      expect(src, f).not.toMatch(/\[#|\[rgb|style=\{\{/);
    }
  });

  it("the QuickBooks row has Connect / Reconnect QuickBooks and Check connection, and no disconnect control; the temporary section is gone", () => {
    const section = read("../components/quickbooks-connection-section.tsx") + read("../components/connection-check-button.tsx");
    expect(section).toContain("Connect QuickBooks");
    expect(section).toContain("Reconnect QuickBooks");
    expect(section).toContain("Check connection");
    expect(section).toMatch(/\/api\/connect\/qbo\/start\?lane=/);
    expect(section.toLowerCase()).not.toMatch(/disconnect|revoke|temporary/);
    expect(existsSync(new URL("../components/connection-test-section.tsx", import.meta.url))).toBe(false);
    expect(read("../components/settings-page.tsx")).not.toMatch(/Temporary|connectionTest|ConnectionTestSection|developer-tools/);
  });

  it("the client component never renders anything but the parsed three fields", () => {
    const src = read("../components/connection-check-button.tsx");
    expect(src).toContain("parseCheckResult");
    expect(src).not.toMatch(/realm|token_|access_token|refresh_token/i);
  });
});
