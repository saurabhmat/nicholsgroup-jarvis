// The Microsoft guard (T-256): every call is checked before any Vault token read and before any request, from ONE
// mailProviderSettings read, and a lane that also has Google enabled is no reason to refuse.
import { afterEach, describe, expect, it } from "vitest";
import { isConnectorError } from "../contract/errors";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import { PROVIDER_DISABLED_MESSAGE } from "../facade/gate";
import { RateLimiter } from "../http/rate-limit";
import { createMicrosoftHarness, TENANT_A, TENANT_B, TENANT_C, type LaneSetup } from "../testing/microsoft-harness";
import { createFakeMicrosoft } from "../testing/msw/microsoft/handlers";
import { useMockServer } from "../testing/msw/index";
import { CLOUD_CHANGED_MESSAGE, CLOUD_UNSUPPORTED_MESSAGE, IDENTITY_MISSING_MESSAGE, TENANT_NOT_ALLOWED_MESSAGE, isGuarded } from "./guard";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const EXEC = "exec@pubkgroup.example.test";
const lane = (over: Partial<LaneSetup> = {}): LaneSetup => ({ providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A, TENANT_B] }, domains: ["pubkgroup.example.test"], ...over });

function setup(lanes: Record<string, LaneSetup> = { PKG: lane() }) {
  const fake = createFakeMicrosoft();
  server.use(...fake.handlers);
  const h = createMicrosoftHarness({ fake, lanes });
  return { fake, h };
}
async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (isConnectorError(e)) return e.info;
    throw e;
  }
  throw new Error("expected a ConnectorError");
}
/** Nothing was read from the Vault and nothing was sent to Microsoft. */
function expectNothingHappened(h: ReturnType<typeof setup>["h"]) {
  expect(h.stats.tokenReads).toBe(0);
  expect(h.everyRequest()).toBe(0);
}

describe("the guard approves", () => {
  it("a usable connection of an enabled lane, from exactly one mailProviderSettings read", async () => {
    const { h } = setup();
    const { conn, row } = h.connect("PKG", EXEC);
    const g = await h.guard("PKG", conn);
    expect(isGuarded(g)).toBe(true);
    expect(g.conn.id).toBe(row.id);
    expect(g).toMatchObject({ tenantId: TENANT_A, cloud: "commercial" });
    expect(h.stats.settingsReads).toBe(1);
    expect(h.stats.tokenReads).toBe(0);
  });

  it("a lane with [\"google\",\"microsoft\"] enabled: the Microsoft call works end to end and no Google data is consulted", async () => {
    const { h, fake } = setup({ PKG: lane({ providers: ["google", "microsoft"] }) });
    const { conn } = h.connect("PKG", EXEC);
    const res = await h.api.get<{ mail: string }>("PKG", conn, "/me");
    expect(res.data.mail).toBe(EXEC);
    expect(h.stats.settingsReads).toBe(1);
    expect(fake.state.graphRequests).toHaveLength(1);
  });

  it("is not changed by the order of the providers", async () => {
    const { h } = setup({ PKG: lane({ providers: ["microsoft", "google"] }) });
    const { conn } = h.connect("PKG", EXEC);
    await expect(h.guard("PKG", conn)).resolves.toBeDefined();
  });

  it("returns an object that cannot be forged: a look-alike is not guarded", async () => {
    const { h } = setup();
    const { conn } = h.connect("PKG", EXEC);
    const g = await h.guard("PKG", conn);
    expect(isGuarded({ ...g })).toBe(false);
  });
});

describe("the guard refuses before any token read or request", () => {
  it("a tenant removed from lane_config", async () => {
    const { h } = setup();
    const { conn } = h.connect("PKG", EXEC, { tenant: TENANT_A });
    h.setLane("PKG", { microsoft: { tenantIds: [TENANT_B, TENANT_C] } });
    const info = await failure(h.api.get("PKG", conn, "/me"));
    expect(info.kind).toBe("forbidden");
    expect(info.message).toBe(TENANT_NOT_ALLOWED_MESSAGE);
    expectNothingHappened(h);
  });

  it("`microsoft` removed from mail.providers while the microsoft block is kept", async () => {
    const { h } = setup();
    const { conn } = h.connect("PKG", EXEC);
    h.setLane("PKG", { providers: ["google"] }); // the `microsoft` block stays in the lane's config
    expect(h.lanes.PKG?.microsoft).not.toBeNull();
    const info = await failure(h.api.get("PKG", conn, "/me"));
    expect(info).toMatchObject({ kind: "connection_unavailable", message: PROVIDER_DISABLED_MESSAGE });
    expectNothingHappened(h);
  });

  it("a lane with `microsoft` in mail.providers but no microsoft settings", async () => {
    const { h } = setup();
    const { conn } = h.connect("PKG", EXEC);
    h.setLane("PKG", { microsoft: null, providers: ["google", "microsoft"] });
    const info = await failure(h.api.get("PKG", conn, "/me"));
    expect(info.message).toBe(PROVIDER_DISABLED_MESSAGE);
    expectNothingHappened(h);
  });

  it("a lane whose cloud is gcc_high (its hosts are refused until T-267)", async () => {
    const { h } = setup({ PKG: lane({ microsoft: { tenantIds: [TENANT_A], cloud: "gcc_high" } }) });
    const { conn } = h.connect("PKG", EXEC, { cloud: "gcc_high" });
    const info = await failure(h.api.get("PKG", conn, "/me"));
    expect(info).toMatchObject({ kind: "unsupported_op", message: CLOUD_UNSUPPORTED_MESSAGE });
    expectNothingHappened(h);
  });

  it("a row whose cloud differs from the lane's cloud (Reconnect needed)", async () => {
    const { h } = setup();
    const { conn, row } = h.connect("PKG", EXEC);
    h.setIdentity(row.id, { tenantId: TENANT_A, cloud: "gcc_high" });
    const info = await failure(h.api.get("PKG", conn, "/me"));
    expect(info.message).toBe(CLOUD_CHANGED_MESSAGE);
    expectNothingHappened(h);
  });

  it("a row with no recorded tenant", async () => {
    const { h } = setup();
    const { conn, row } = h.connect("PKG", EXEC);
    h.setIdentity(row.id, { tenantId: null, cloud: null });
    const info = await failure(h.api.get("PKG", conn, "/me"));
    expect(info.message).toBe(IDENTITY_MISSING_MESSAGE);
    expectNothingHappened(h);
  });

  it("an upper-case stored tenant id is matched case-insensitively, a different tenant is refused", async () => {
    const { h } = setup();
    const { conn, row } = h.connect("PKG", EXEC);
    h.setIdentity(row.id, { tenantId: TENANT_A.toUpperCase(), cloud: "commercial" });
    await expect(h.guard("PKG", conn)).resolves.toMatchObject({ tenantId: TENANT_A });
    h.setIdentity(row.id, { tenantId: TENANT_C, cloud: "commercial" });
    expect((await failure(h.guard("PKG", conn))).kind).toBe("forbidden");
  });

  it("an account whose domain is no longer allowed, or that left the exact mailbox list", async () => {
    const { h } = setup();
    const { conn } = h.connect("PKG", EXEC);
    h.setLane("PKG", { domains: ["other.example.test"] });
    expect((await failure(h.api.get("PKG", conn, "/me"))).kind).toBe("forbidden");
    h.setLane("PKG", { domains: ["pubkgroup.example.test"], mailboxes: ["someone-else@pubkgroup.example.test"] });
    expect((await failure(h.api.get("PKG", conn, "/me"))).kind).toBe("forbidden");
    expectNothingHappened(h);
  });

  it("a connection that is not usable (reconnect_required, disconnected)", async () => {
    const { h } = setup();
    const a = h.connect("PKG", EXEC, { status: "reconnect_required" });
    expect((await failure(h.api.get("PKG", a.conn, "/me"))).kind).toBe("reconnect_required");
    const b = h.connect("PKG", "two@pubkgroup.example.test", { status: "disconnected" });
    expect((await failure(h.api.get("PKG", b.conn, "/me"))).kind).toBe("connection_unavailable");
    expectNothingHappened(h);
  });

  it("another provider's connection and another lane's connection", async () => {
    const { h } = setup({ PKG: lane(), NC: lane() });
    const { conn } = h.connect("PKG", EXEC);
    expect((await failure(h.api.get("NC", conn, "/me"))).kind).toBe("lane_mismatch");
    const google = { ...conn, provider: "google" };
    expect((await failure(h.api.get("PKG", google, "/me"))).kind).toBe("lane_mismatch"); // not lane-bound: a copy is refused outright
    expectNothingHappened(h);
  });

  it("a minted connection row of another provider (forbidden, before the row is loaded)", async () => {
    const { h } = setup();
    const google = mintLaneBoundConnection<"google">({ id: crypto.randomUUID(), lane_id: "PKG", provider: "google", external_account_id: EXEC, status: "active", features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null });
    expect((await failure(h.guard("PKG", google))).kind).toBe("forbidden");
    expect(h.stats.loads).toBe(0);
    expect(h.stats.settingsReads).toBe(0);
    expectNothingHappened(h);
  });

  it("never reads the settings of a lane twice for one call", async () => {
    const { h } = setup();
    const { conn } = h.connect("PKG", EXEC);
    await h.api.get("PKG", conn, "/me");
    expect(h.stats.settingsReads).toBe(1);
  });
});
