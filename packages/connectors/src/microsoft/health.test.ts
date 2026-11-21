// The Microsoft health check (T-256): GET /me through the guarded client, reporting a HealthStatus without throwing and without
// keeping anything from the response.
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { createMicrosoftHarness, TENANT_A } from "../testing/microsoft-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeMicrosoft, MICROSOFT_ERROR_TEXT_CANARY } from "../testing/msw/microsoft/handlers";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());
const EXEC = "exec@pubkgroup.example.test";

function setup() {
  const fake = createFakeMicrosoft();
  server.use(...fake.handlers);
  const h = createMicrosoftHarness({ fake, lanes: { PKG: { providers: ["google", "microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: ["pubkgroup.example.test"] } } });
  return { fake, h, ...h.connect("PKG", EXEC) };
}

describe("health", () => {
  it("is ok after one GET /me, and keeps nothing of the profile", async () => {
    const { h, fake, conn } = setup();
    const res = await h.health("PKG", conn);
    expect(res).toMatchObject({ ok: true, status: "active", error: null });
    expect(fake.state.graphRequests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1.0/me"]);
    expect(JSON.stringify(res)).not.toContain(EXEC);
    expect(JSON.stringify(res)).not.toContain("Synthetic Executive");
  });

  it("a dead grant is reconnect_required (and the token manager's hook ran once)", async () => {
    const { h, conn, account } = setup();
    account.revoked = true;
    h.expireStoredAccess(conn.id);
    const res = await h.health("PKG", conn);
    expect(res).toMatchObject({ ok: false, status: "reconnect_required", error: { kind: "reconnect_required" } });
    expect(h.reconnects).toHaveLength(1);
  });

  it("a Graph failure is degraded with a fixed message, never Microsoft's text", async () => {
    const { h, fake, conn } = setup();
    fake.state.meFail = { status: 403, code: "ErrorAccessDenied", times: 1 };
    const res = await h.health("PKG", conn);
    expect(res).toMatchObject({ ok: false, status: "degraded", error: { kind: "forbidden", http_status: 403 } });
    expect(JSON.stringify(res)).not.toContain(MICROSOFT_ERROR_TEXT_CANARY);
  });

  it("a throttled check is a retry-disposition failure (the daily job treats it as inconclusive)", async () => {
    const { h, conn, account } = setup();
    account.throttle = { status: 429, retryAfter: 1, remaining: Infinity };
    const res = await h.health("PKG", conn);
    expect(res.ok).toBe(false);
    expect(res.error?.disposition).toBe("retry");
  });

  it("is refused by the guard like any call: Microsoft removed from the lane means no token read and no request", async () => {
    const { h, fake, conn } = setup();
    h.setLane("PKG", { providers: ["google"] });
    const res = await h.health("PKG", conn);
    expect(res).toMatchObject({ ok: false, error: { kind: "connection_unavailable" } });
    expect(h.stats.tokenReads).toBe(0);
    expect(fake.state.graphRequests).toHaveLength(0);
  });
});
