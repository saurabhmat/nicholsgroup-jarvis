// The Teams guard (T-279, spec 6): the order of the checks, one `teamsSettings` read, fail closed on everything, the explicit owner = session user check, and the brand that makes it
// the only way to a token. In-memory twins (testing/teams-harness.ts); nothing is sent to Microsoft (the fake is wired but every refusal must leave its request log empty).
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { useMockServer } from "../testing/msw/index";
import { createFakeTeams } from "../testing/msw/teams/handlers";
import { createTeamsHarness, TEAMS_OTHER_USER, TEAMS_OWNER, TEAMS_TENANT_A, TEAMS_TENANT_B, type TeamsLaneSetup } from "../testing/teams-harness";
import { isGuardedTeams, TEAMS_CLOUD_CHANGED_MESSAGE, TEAMS_CLOUD_UNSUPPORTED_MESSAGE, TEAMS_DOMAIN_NOT_ALLOWED_MESSAGE, TEAMS_FEATURE_OFF_CONNECTION_MESSAGE, TEAMS_FEATURE_OFF_LANE_MESSAGE, TEAMS_IDENTITY_MISSING_MESSAGE, TEAMS_NOT_ENABLED_MESSAGE, TEAMS_TENANT_NOT_ALLOWED_MESSAGE } from "./guard";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const DOMAIN = "teams.example.test";
const PERSON = `person@${DOMAIN}`;

function setup(lane: Partial<TeamsLaneSetup> = {}) {
  const fake = createFakeTeams();
  server.use(...fake.handlers);
  const h = createTeamsHarness({ fake, lanes: { PKG: { teams: {}, mailProviders: ["google"], ...lane } } });
  return { fake, h };
}
const refused = async (p: Promise<unknown>, kind: string, message?: string) => {
  const e = await p.then(() => null, (x: unknown) => x as { info: { kind: string; message: string } });
  expect(e, "expected a refusal").not.toBeNull();
  expect(e?.info.kind).toBe(kind);
  if (message) expect(e?.info.message).toBe(message);
};

describe("the guard", () => {
  it("approves a usable connection of an enabled lane and returns the branded value with the identity", async () => {
    const { h, fake } = setup();
    const { conn, account } = h.connect("PKG", PERSON);
    const g = await h.guard("PKG", conn, { feature: "chat_read" });
    expect(isGuardedTeams(g)).toBe(true);
    expect(g).toMatchObject({ tenantId: TEAMS_TENANT_A, cloud: "commercial", entraObjectId: account.objectId });
    expect(isGuardedTeams({ ...g })).toBe(false); // a copy is not approved
    expect(fake.state.tokenRequests.length + fake.state.graphRequests.length).toBe(0);
    expect(h.stats.tokenReads).toBe(0);
  });

  it("reads the lane's Teams settings ONCE per call and never the mail settings", async () => {
    const { h } = setup({ mailProviders: ["google"] });
    const { conn } = h.connect("PKG", PERSON);
    await h.guard("PKG", conn, { feature: "chat_read" });
    expect(h.stats.teamsSettingsReads).toBe(1);
    expect(h.stats.otherConfigReads).toBe(0);
  });

  it("refuses everything that is not a Teams connection of this lane, before any config read", async () => {
    const { h } = setup();
    const { conn } = h.connect("PKG", PERSON);
    await refused(h.guard("OTH", conn), "lane_mismatch");
    await refused(h.guard("PKG", { ...conn }), "lane_mismatch"); // a forged copy
    const mail = { id: "00000000-0000-4000-8000-0000000000b1", provider: "microsoft" };
    await refused(h.guard("PKG", mail), "lane_mismatch");
    expect(h.stats.teamsSettingsReads).toBe(0);
  });

  it("refuses a connection that is not usable (reconnect_required, disconnected, pending) and does not read the lane config", async () => {
    const { h } = setup();
    for (const [status, kind] of [["reconnect_required", "reconnect_required"], ["disconnected", "connection_unavailable"], ["pending", "connection_unavailable"]] as const) {
      const { conn } = h.connect("PKG", `${status}@${DOMAIN}`, { status });
      await refused(h.guard("PKG", conn), kind);
    }
    expect(h.stats.teamsSettingsReads).toBe(0);
  });

  it("refuses when Teams is not enabled for the lane (no block, enabled false), whatever the mail providers say", async () => {
    for (const teams of [null, { enabled: false }]) {
      const { h } = setup({ teams, mailProviders: ["google", "microsoft"] });
      const { conn } = h.connect("PKG", PERSON);
      await refused(h.guard("PKG", conn), "connection_unavailable", TEAMS_NOT_ENABLED_MESSAGE);
      expect(h.stats.identityReads).toBe(0);
    }
  });

  it("refuses a cloud this build does not serve, a changed cloud, a missing identity, a tenant the lane no longer lists", async () => {
    const gcc = setup({ teams: { cloud: "gcc_high" } });
    await refused(gcc.h.guard("PKG", gcc.h.connect("PKG", PERSON).conn), "unsupported_op", TEAMS_CLOUD_UNSUPPORTED_MESSAGE);
    const changed = setup();
    const c = changed.h.connect("PKG", PERSON, { cloud: "gcc_high" });
    await refused(changed.h.guard("PKG", c.conn), "connection_unavailable", TEAMS_CLOUD_CHANGED_MESSAGE);
    const none = setup();
    const n = none.h.connect("PKG", PERSON);
    none.h.setIdentity(n.row.id, { tenantId: null, cloud: null, entraObjectId: null });
    await refused(none.h.guard("PKG", n.conn), "connection_unavailable", TEAMS_IDENTITY_MISSING_MESSAGE);
    const noObject = setup();
    await refused(noObject.h.guard("PKG", noObject.h.connect("PKG", PERSON, { noObjectId: true }).conn), "connection_unavailable", TEAMS_IDENTITY_MISSING_MESSAGE);
    const removed = setup({ teams: { tenantIds: [TEAMS_TENANT_B] } });
    await refused(removed.h.guard("PKG", removed.h.connect("PKG", PERSON).conn), "forbidden", TEAMS_TENANT_NOT_ALLOWED_MESSAGE);
  });

  it("refuses an account whose domain the lane does not list (fail closed on an empty or unrelated list)", async () => {
    const { h } = setup({ teams: { allowedDomains: ["other.example.test"] } });
    await refused(h.guard("PKG", h.connect("PKG", PERSON).conn), "forbidden", TEAMS_DOMAIN_NOT_ALLOWED_MESSAGE);
    const empty = setup({ teams: { allowedDomains: [] } });
    await refused(empty.h.guard("PKG", empty.h.connect("PKG", PERSON).conn), "forbidden", TEAMS_DOMAIN_NOT_ALLOWED_MESSAGE);
    const noAt = setup();
    await refused(noAt.h.guard("PKG", noAt.h.connect("PKG", "no-at-sign").conn), "forbidden", TEAMS_DOMAIN_NOT_ALLOWED_MESSAGE);
  });

  it("a feature must be on in the lane AND on the connection", async () => {
    const { h } = setup({ teams: { features: ["chat_read"] } });
    const { conn } = h.connect("PKG", PERSON, { features: ["chat_read", "channels_read"] });
    await h.guard("PKG", conn, { feature: "chat_read" });
    await refused(h.guard("PKG", conn, { feature: "channels_read" }), "forbidden", TEAMS_FEATURE_OFF_LANE_MESSAGE); // the lane does not list it
    const lanes = setup({ teams: { features: ["chat_read", "channels_read"] } });
    const noConn = lanes.h.connect("PKG", PERSON, { features: ["chat_read"] });
    await refused(lanes.h.guard("PKG", noConn.conn, { feature: "channels_read" }), "forbidden", TEAMS_FEATURE_OFF_CONNECTION_MESSAGE); // the connection lacks it: reconnect
    await lanes.h.guard("PKG", noConn.conn, { feature: "chat_read" }); // what it has keeps working
  });

  it("a request made for a person needs the row's owner to be that person: another person's id (an admin who can see the row's health) is not_found", async () => {
    const { h } = setup();
    const { conn } = h.connect("PKG", PERSON, { owner: TEAMS_OWNER });
    await h.guard("PKG", conn, { feature: "chat_read", actorUserId: TEAMS_OWNER });
    await refused(h.guard("PKG", conn, { feature: "chat_read", actorUserId: TEAMS_OTHER_USER }), "not_found");
    await refused(h.guard("PKG", conn, { actorUserId: "" }), "not_found");
  });

  it("a malformed lane config fails closed", async () => {
    const { h } = setup();
    const { conn } = h.connect("PKG", PERSON);
    h.laneConfig.teamsSettings = async () => {
      throw Object.assign(new Error("x"), { info: { kind: "provider_error" } });
    };
    await expect(h.guard("PKG", conn)).rejects.toBeDefined();
  });
});
