// QuickBooks connector behaviour beyond the shared contract (T-050): the CompanyInfo health check, the read-only API
// surface, intuit_tid in the redacted log (QB-9), and the minimal disconnect the contract needs. Mocks only (rule 10).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { canonicalJson, computePayloadSha256 } from "../contract/writer";
import { HealthStatusSchema } from "../contract/schemas";
import { RateLimiter } from "../http/rate-limit";
import { http, HttpResponse, useMockServer } from "../testing/msw/index";
import { API_SANDBOX, createFakeIntuit, FAKE_REALM, REVOKE_URL } from "../testing/msw/quickbooks/handlers";
import { createQboHarness } from "../testing/quickbooks-harness";

const server = useMockServer();
const LANE = "PKG";

afterEach(() => {
  RateLimiter.resetForTests();
});

async function setup(realms: Record<string, string | null> = {}) {
  const intuit = createFakeIntuit();
  server.use(...intuit.handlers);
  const h = createQboHarness({ intuit, realms });
  const conn = await h.connectViaCallback(LANE);
  intuit.state.apiRequests.length = 0; // the connect callback's own CompanyInfo check is not under test here
  return { intuit, h, conn };
}

describe("health reads CompanyInfo", () => {
  it("calls GET /v3/company/{realm}/companyinfo/{realm} with the bearer token and reports ok with the intuit_tid", async () => {
    const { intuit, h, conn } = await setup();
    const health = HealthStatusSchema.parse(await h.connector.health(LANE, conn));
    expect(health).toMatchObject({ ok: true, status: "active", error: null });
    expect(health.provider_tid).toMatch(/^synthetic-tid-\d{4}$/);
    expect(intuit.state.apiRequests).toEqual([
      { realm: FAKE_REALM, authorization: `Bearer ${intuit.state.issued[0]?.access}`, minorversion: "75", method: "GET" },
    ]);
  });

  it("an expired access token is refreshed on the way, then the check passes", async () => {
    const { intuit, h, conn } = await setup();
    h.clock.t += 58 * 60_000;
    expect(await h.connector.health(LANE, conn)).toMatchObject({ ok: true });
    expect(intuit.state.tokenRequests.filter((r) => r.grant === "refresh_token")).toHaveLength(1);
  });

  it("reports reconnect_required (not a throw) when Intuit rejects the refresh token", async () => {
    const { intuit, h, conn } = await setup();
    intuit.state.failRefresh = { status: 400, error: "invalid_grant", always: true };
    h.clock.t += 59 * 60_000;
    const health = HealthStatusSchema.parse(await h.connector.health(LANE, conn));
    expect(health).toMatchObject({ ok: false, status: "reconnect_required" });
    expect(health.error).toMatchObject({ kind: "reconnect_required", disposition: "reconnect_required", provider_error_code: "invalid_grant" });
  });

  it("reports degraded when QuickBooks keeps failing (5xx), with the intuit_tid and no body text", async () => {
    const { intuit, h, conn } = await setup();
    intuit.state.failApi = { status: 503, times: 10 };
    const health = HealthStatusSchema.parse(await h.connector.health(LANE, conn));
    expect(health).toMatchObject({ ok: false, status: "degraded" });
    expect(health.error).toMatchObject({ kind: "transient", http_status: 503 });
    expect(health.provider_tid).toMatch(/^synthetic-tid-/);
    expect(JSON.stringify(health)).not.toContain("synthetic failure");
  });

  it("a token not authorized for the realm (403) is never trusted", async () => {
    const { h, conn } = await setup();
    server.use(
      http.get(`${API_SANDBOX}/v3/company/:realm/companyinfo/:id`, () =>
        HttpResponse.json({ Fault: { Error: [{ Message: "ApplicationAuthorizationFailed", code: "003100" }], type: "AUTHENTICATION" } }, { status: 403, headers: { intuit_tid: "synthetic-tid-x" } }),
      ),
    );
    const health = await h.connector.health(LANE, conn);
    // T-195 error map: Intuit saying the app is not authorized for the company means the connection must be reconnected.
    expect(health).toMatchObject({ ok: false, status: "reconnect_required" });
    expect(health.error?.kind).toBe("reconnect_required");
    expect(health.error?.http_status).toBe(403);
  });

  it("a connection that is not usable is reported without calling Intuit", async () => {
    const { intuit, h, conn } = await setup();
    const row = h.rows.get(conn.id);
    if (row) row.status = "reconnect_required";
    const health = await h.connector.health(LANE, conn);
    expect(health).toMatchObject({ ok: false, status: "reconnect_required" });
    expect(intuit.state.apiRequests).toHaveLength(0);
  });
});

describe("read company_info", () => {
  it("returns an allowlisted projection with provenance, and keeps no address or email", async () => {
    const { h, conn } = await setup();
    const res = await h.connector.read<Record<string, unknown>>(LANE, conn, { op: "company_info" });
    // Real QuickBooks (and the fake) answer CompanyInfo.Id "1": the projection's id is the connection's realm.
    expect(res.data).toMatchObject({ id: conn.external_account_id });
    expect(res.data).toEqual({
      id: FAKE_REALM,
      company_name: "Synthetic Test Company",
      legal_name: "Synthetic Test Company LLC",
      country: "US",
      fiscal_year_start_month: "January",
      company_start_date: "2020-01-01",
    });
    expect(JSON.stringify(res)).not.toMatch(/synthetic\.person|Synthetic Way|Testville/);
    expect(res).toMatchObject({ lane_id: LANE, provider: "quickbooks", freshness: "live", connection_id: conn.id });
    expect(res.source_refs).toEqual([{ kind: "qbo_company", ref: FAKE_REALM }]);
  });
});

describe("intuit_tid is captured from every response into the redacted log (QB-9)", () => {
  it("logs the tid for successes, a 401, the refresh and a failure; never a token", async () => {
    const { intuit, h, conn } = await setup();
    h.logs.length = 0;
    intuit.state.reject401 = 1;
    await h.connector.health(LANE, conn); // 401 -> refresh -> retry -> ok
    intuit.state.failApi = { status: 400, times: 1 };
    await h.connector.health(LANE, conn); // 400 failure
    const http = h.logs.filter((l) => l.event === "connector.http");
    // company-info 401, token refresh, company-info ok, company-info 400
    expect(http.map((l) => [l.fields.endpoint, l.fields.status])).toEqual([
      ["/v3/company/{realm}/companyinfo/{realm}", 401],
      ["/oauth2/v1/tokens/bearer", 200],
      ["/v3/company/{realm}/companyinfo/{realm}", 200],
      ["/v3/company/{realm}/companyinfo/{realm}", 400],
    ]);
    for (const line of http) expect(String(line.fields.provider_tid)).toMatch(/^synthetic-tid-\d{4}$/);
    expect(http.every((l) => l.provider === "quickbooks" && l.lane_id === LANE)).toBe(true);
    // Intuit's fault code is kept; the realm id is not in the endpoint (template) and no token is anywhere.
    expect(http[0]?.fields.provider_error_code).toBe("003200");
    const text = JSON.stringify(h.logs);
    for (const pair of intuit.state.issued) expect(text).not.toMatch(new RegExp(`${pair.access}|${pair.refresh}`));
    expect(text).not.toContain(FAKE_REALM);
  });
});

describe("the QuickBooks client is read-only", () => {
  it("the API object exposes get and nothing else", async () => {
    const { h } = await setup();
    expect(Object.keys(h.api)).toEqual(["get"]);
  });

  it("api.ts only ever issues GET requests", () => {
    const src = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
    expect([...src.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1])).toEqual(["GET"]);
  });

  it("the connector declares sync (T-051) but no subscribe or write capability", async () => {
    const { h } = await setup();
    expect(h.connector.capabilities).toEqual({ sync: true, subscribe: false, prepareWrite: false });
    expect("prepareWrite" in h.connector).toBe(false);
    expect("executeWrite" in h.connector).toBe(false);
  });
});

describe("lanes", () => {
  it("the same Intuit app serves each lane with its own realm, tokens and Vault entry", async () => {
    const intuit = createFakeIntuit({ extraRealms: ["2222222222222222"] });
    server.use(...intuit.handlers);
    const h = createQboHarness({ intuit });
    const a = await h.connectViaCallback("PKG");
    // One provider account connects to one lane only (D-23), so the other lane connects another company.
    const b = await h.connectViaCallback("APK", undefined, "2222222222222222");
    expect(a.id).not.toBe(b.id);
    expect(h.secrets.get(a.id)).not.toBe(h.secrets.get(b.id));
    // A connection cannot be used from the other lane.
    await expect(h.connector.health("APK", a)).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
    await expect(h.tokens.accessToken("APK", a)).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
  });
});

describe("revoke-and-delete is an approvals-only write (D-24), not a connector method", () => {
  const ASSERT = (h: Awaited<ReturnType<typeof setup>>["h"], conn: { id: string; external_account_id: string }) => h.approvedRevoke(LANE, conn);

  it("the connector object has no disconnect and no write", async () => {
    const { h } = await setup();
    expect("disconnect" in h.connector).toBe(false);
    expect("executeWrite" in h.connector).toBe(false);
    expect(Object.keys(h.connector).sort()).toEqual(["capabilities", "connect", "featureKeys", "health", "provider", "read", "readOps", "sync"]);
  });

  it("the revoke operation revokes the refresh token at Intuit's discovered endpoint, deletes the Vault tokens and records the approver", async () => {
    const { intuit, h, conn } = await setup();
    const refresh = h.storedSet(conn.id)?.refresh_token;
    const action = ASSERT(h, conn);
    const res = await h.revoker.run(LANE, conn, action);
    expect(res).toMatchObject({ outcome: "accepted", provider_tid: expect.stringMatching(/^synthetic-tid-/) });
    expect(intuit.state.revokeRequests).toHaveLength(1);
    expect(intuit.state.revokeRequests[0]).toMatchObject({ body: { token: refresh } });
    expect(intuit.state.revokeRequests[0]?.auth).toMatch(/^Basic /);
    expect(h.secrets.has(conn.id)).toBe(false);
    expect(h.rows.get(conn.id)?.status).toBe("disconnected");
    // The approving user goes to the audit row.
    expect(h.stats.revokeActors).toEqual([action.approved_by]);
  });

  it("is idempotent and does not call Intuit again for a disconnected connection", async () => {
    const { intuit, h, conn } = await setup();
    await h.revoker.run(LANE, conn, ASSERT(h, conn));
    expect(await h.revoker.run(LANE, conn, ASSERT(h, conn))).toMatchObject({ outcome: "already_applied" });
    expect(intuit.state.revokeRequests).toHaveLength(1);
  });

  it("only a 400 invalid_token / invalid_grant counts as already revoked and then deletes our copy", async () => {
    for (const error of ["invalid_token", "invalid_grant"]) {
      const { h, conn } = await setup();
      server.use(http.post(REVOKE_URL, () => HttpResponse.json({ error }, { status: 400 })));
      expect(await h.revoker.run(LANE, conn, ASSERT(h, conn))).toMatchObject({ outcome: "already_applied" });
      expect(h.rows.get(conn.id)?.status).toBe("disconnected");
      expect(h.secrets.has(conn.id)).toBe(false);
    }
  });

  it.each([
    ["401 (maybe our own wrong client secret)", () => HttpResponse.json({ error: "invalid_client" }, { status: 401 }), "connection_unavailable"],
    ["403", () => HttpResponse.json({ error: "access_denied" }, { status: 403 }), "connection_unavailable"],
    ["400 with another error", () => HttpResponse.json({ error: "invalid_request" }, { status: 400 }), "connection_unavailable"],
    ["503", () => new HttpResponse(null, { status: 503 }), "transient"],
  ])("a %s from the revoke call fails and keeps the Vault tokens", async (_name, respond, kind) => {
    const { h, conn } = await setup();
    const before = h.secrets.get(conn.id);
    server.use(http.post(REVOKE_URL, respond));
    const err = (await h.revoker.run(LANE, conn, ASSERT(h, conn)).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.info.kind).toBe(kind);
    expect(h.secrets.get(conn.id)).toBe(before);
    expect(h.rows.get(conn.id)?.status).toBe("active");
    expect(h.stats.revokes).toBe(0);
  });

  it("a timeout fails and keeps the Vault tokens", async () => {
    const { h, conn } = await setup();
    const before = h.secrets.get(conn.id);
    server.use(http.post(REVOKE_URL, () => HttpResponse.error()));
    await expect(h.revoker.run(LANE, conn, ASSERT(h, conn))).rejects.toBeInstanceOf(ConnectorError);
    expect(h.secrets.get(conn.id)).toBe(before);
    expect(h.stats.revokes).toBe(0);
  });

  it("refuses an action for another lane or connection, another type, or without a valid approver, before any request", async () => {
    const { intuit, h, conn } = await setup();
    const good = ASSERT(h, conn);
    const bad = [
      { ...good, lane_id: "APK" },
      { ...good, connection_id: "00000000-0000-4000-8000-00000000dead" },
      { ...good, action_type: "qbo.create_invoice" },
      { ...good, approved_by: "not-a-uuid" },
    ];
    for (const action of bad) await expect(h.revoker.run(LANE, conn, action)).rejects.toBeInstanceOf(ConnectorError);
    expect(intuit.state.revokeRequests).toHaveLength(0);
    expect(h.secrets.has(conn.id)).toBe(true);
  });

  describe("the approved payload is verified before anything is sent or changed (security W1)", () => {
    type H = Awaited<ReturnType<typeof setup>>["h"];
    // Each refusal: invalid_input, no request to Intuit (not even a token refresh), Vault and row untouched.
    const expectRefused = async (action: unknown, kind = "invalid_input") => {
      const { intuit, h, conn } = await setup();
      const before = { secret: h.secrets.get(conn.id), status: h.rows.get(conn.id)?.status, stores: h.stats.stores, rotations: h.stats.rotations };
      const requests = intuit.state.revokeRequests.length;
      const act = typeof action === "function" ? (action as (h: H, c: typeof conn) => unknown)(h, conn) : action;
      await expect(h.revoker.run(LANE, conn, act as never)).rejects.toMatchObject({ info: { kind } });
      expect(intuit.state.revokeRequests).toHaveLength(requests);
      expect(h.secrets.get(conn.id)).toBe(before.secret);
      expect(h.rows.get(conn.id)?.status).toBe(before.status);
      expect([h.stats.revokes, h.stats.stores, h.stats.rotations]).toEqual([0, before.stores, before.rotations]);
      expect(h.stats.revokeActors).toEqual([]);
    };
    const good = (h: H, conn: { id: string; external_account_id: string }) => ASSERT(h, conn);

    it("a tampered payload (the hash no longer matches) is refused", async () => {
      await expectRefused((h: H, c: { id: string; external_account_id: string }) => ({ ...good(h, c), payload: { also: "revoke everything" } }));
    });

    it("a tampered schema version (hash not recomputed) is refused", async () => {
      await expectRefused((h: H, c: { id: string; external_account_id: string }) => ({ ...good(h, c), payload_schema_version: 2 }));
    });

    it("a tampered hash is refused", async () => {
      await expectRefused((h: H, c: { id: string; external_account_id: string }) => ({ ...good(h, c), payload_sha256: "0".repeat(64) }));
      await expectRefused((h: H, c: { id: string; external_account_id: string }) => ({ ...good(h, c), payload_sha256: good(h, c).payload_sha256.toUpperCase() }));
      await expectRefused((h: H, c: { id: string; external_account_id: string }) => ({ ...good(h, c), payload_sha256: undefined }));
    });

    it("a target naming another company is refused even with a hash that matches it", async () => {
      await expectRefused((h: H, c: { id: string; external_account_id: string }) => {
        const action = { ...good(h, c), target: { realm_id: "9999999999999999" } };
        return { ...action, payload_sha256: computePayloadSha256(action) };
      });
    });

    it("a target with extra keys, or none, is refused even with a matching hash", async () => {
      for (const target of [{} as Record<string, string | number>, { realm_id: FAKE_REALM, other: 1 }]) {
        await expectRefused((h: H, c: { id: string; external_account_id: string }) => {
          const action = { ...good(h, c), target };
          return { ...action, payload_sha256: computePayloadSha256(action) };
        });
      }
    });

    it("a non-UUID approver is refused", async () => {
      for (const approved_by of ["not-a-uuid", "", undefined, 7]) {
        await expectRefused((h: H, c: { id: string; external_account_id: string }) => ({ ...good(h, c), approved_by }));
      }
    });

    it("an unhashable payload is refused, not thrown as a raw error", async () => {
      await expectRefused((h: H, c: { id: string; external_account_id: string }) => ({ ...good(h, c), payload: { n: Number.NaN } }));
    });

    it("the hash is the JCS one: key order does not matter, the value does (known vector)", () => {
      const a = { lane_id: "PKG", action_type: "x", connection_id: "c", target: { b: 1, a: 2 }, payload: { z: [1, "é"], y: null }, payload_schema_version: 1 };
      const b = { ...a, target: { a: 2, b: 1 }, payload: { y: null, z: [1, "é"] } };
      expect(computePayloadSha256(a)).toBe(computePayloadSha256(b));
      expect(canonicalJson(a.target)).toBe('{"a":2,"b":1}');
      expect(canonicalJson({ n: [1.5, -0, 1e21, "\u2028"] })).toBe('{"n":[1.5,0,1e+21,"\u2028"]}');
      expect(computePayloadSha256({ ...a, payload_schema_version: 2 })).not.toBe(computePayloadSha256(a));
    });

    it("an action built from the real hash still revokes (positive control)", async () => {
      const { h, conn } = await setup();
      expect(await h.revoker.run(LANE, conn, good(h, conn))).toMatchObject({ outcome: "accepted" });
    });
  });

  it("nothing in production code reaches the writer: only the writer module, the wiring and the writer-side subpath import it", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const root = new URL("../../../../", import.meta.url).pathname;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", "dist", ".next", ".next-canary", ".turbo", ".git"].includes(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.(test|spec)\./.test(name)) files.push(full);
      }
    };
    walk(join(root, "apps"));
    walk(join(root, "packages"));
    const offenders = files
      .filter((f) => /quickbooksWriter|createQuickBooksWriter|createQuickBooksRevoker|@nichols\/connectors\/write\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f))
      // The approvals module is the allowed caller; the lint plugin spells the names out to forbid them.
      .filter((f) => !f.startsWith("packages/modules/approvals/") && !f.startsWith("packages/eslint-plugin/src/"))
      .sort();
    expect(offenders).toEqual([
      "packages/connectors/src/quickbooks/index.ts",
      "packages/connectors/src/quickbooks/writer.ts",
      "packages/connectors/src/testing/quickbooks-harness.ts",
      "packages/connectors/src/write/index.ts",
    ]);
  });
});

describe("another provider's connection is refused before any network call or Vault change (security H1)", () => {
  it.each(["google", "stripe"] as const)("a %s-shaped connection in the same lane", async (providerName) => {
    const { intuit, h } = await setup();
    const foreign = h.addForeignConnection(LANE, providerName);
    const before = h.secrets.get(foreign.id);
    const requests = () => intuit.state.apiRequests.length + intuit.state.tokenRequests.length + intuit.state.revokeRequests.length;
    const base = requests();
    const refuse = async (call: () => Promise<unknown>) => {
      const err = (await call().catch((e: unknown) => e)) as ConnectorError;
      expect(err).toBeInstanceOf(ConnectorError);
      expect(["lane_mismatch", "not_found"]).toContain(err.info.kind);
    };
    await refuse(() => h.connector.health(LANE, foreign as never));
    await refuse(() => h.connector.read(LANE, foreign as never, { op: "company_info" }));
    await refuse(() => h.revoker.run(LANE, foreign as never, h.approvedRevoke(LANE, foreign)));
    await refuse(() => h.tokens.accessToken(LANE, foreign));
    await refuse(() => h.tokens.refreshToken(LANE, foreign));
    await refuse(() => h.api.get(LANE, foreign, "/v3/company/{realm}/companyinfo/{realm}", { realm: FAKE_REALM }));
    // No request reached Intuit; the other provider's credential is untouched and its row is still active.
    expect(requests()).toBe(base);
    expect(h.secrets.get(foreign.id)).toBe(before);
    expect(h.rows.get(foreign.id)?.status).toBe("active");
    expect(h.stats.revokes).toBe(0);
  });

  it("an authoritative row of another provider behind a quickbooks-shaped object is refused too", async () => {
    const { intuit, h, conn } = await setup();
    const row = h.rows.get(conn.id);
    if (row) (row as { provider: string }).provider = "google"; // the stored row now says google
    const before = intuit.state.apiRequests.length;
    await expect(h.connector.health(LANE, conn)).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
    expect(intuit.state.apiRequests).toHaveLength(before);
  });
});
