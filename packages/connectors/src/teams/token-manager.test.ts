// The Teams token manager (T-279, spec 5 "Tokens"): the Microsoft manager's rotation, compare-and-swap, single flight and reconnect mapping over the TEAMS app's credentials, accepting
// only a connection the TEAMS guard approved (a mail-guarded connection is refused, and a Teams-guarded one is refused by the mail manager).
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { createMicrosoftTokenManager } from "../microsoft/token-manager";
import { useMockServer } from "../testing/msw/index";
import { createFakeTeams, FAKE_TEAMS_CLIENT_ID } from "../testing/msw/teams/handlers";
import { createTeamsHarness } from "../testing/teams-harness";
import { SecretValue } from "../vault/secret";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const PERSON = "person@teams.example.test";

function setup() {
  const fake = createFakeTeams();
  server.use(...fake.handlers);
  const h = createTeamsHarness({ fake, lanes: { PKG: { teams: {}, mailProviders: ["google"] } } });
  return { fake, h };
}

describe("the Teams token manager", () => {
  it("hands out the stored access token while it is fresh, with no request to Microsoft", async () => {
    const { h, fake } = setup();
    const { conn, account } = h.connect("PKG", PERSON);
    const g = await h.guard("PKG", conn);
    const t = await h.tokens.accessToken("PKG", g);
    expect([...account.accessTokens]).toContain(t.reveal());
    expect(fake.state.tokenRequests).toHaveLength(0);
  });

  it("refreshes an expired access token at the lane's tenant with the Teams client id and secret and stores the rotated set (compare-and-swap)", async () => {
    const { h, fake } = setup();
    const { conn, row } = h.connect("PKG", PERSON, { storedAccessExpired: true });
    const g = await h.guard("PKG", conn);
    const before = h.secrets.get(row.id) as string;
    await h.tokens.accessToken("PKG", g);
    expect(fake.state.tokenRequests).toHaveLength(1);
    expect(fake.state.tokenRequests[0]).toMatchObject({ tenant: g.tenantId, fields: { client_id: FAKE_TEAMS_CLIENT_ID, grant_type: "refresh_token" } });
    expect(h.secrets.get(row.id)).not.toBe(before);
    expect(h.stats.rotations).toBe(1);
  });

  it("single flight: concurrent callers share one refresh", async () => {
    const { h, fake } = setup();
    const { conn } = h.connect("PKG", PERSON, { storedAccessExpired: true });
    const g = await h.guard("PKG", conn);
    const all = await Promise.all([1, 2, 3, 4].map(() => h.tokens.accessToken("PKG", g)));
    expect(new Set(all.map((s) => s.reveal())).size).toBe(1);
    expect(fake.state.refreshes).toBe(1);
  });

  it("a refused refresh token (invalid_grant) is reconnect_required, recorded once, and never retried", async () => {
    const { h, fake } = setup();
    const { conn, account } = h.connect("PKG", PERSON, { storedAccessExpired: true });
    account.revoked = true;
    const g = await h.guard("PKG", conn);
    await expect(h.tokens.accessToken("PKG", g)).rejects.toMatchObject({ info: { kind: "reconnect_required" } });
    expect(fake.state.tokenRequests).toHaveLength(1);
    expect(h.reconnects).toHaveLength(1);
    expect(JSON.stringify(h.reconnects)).not.toContain(account.refreshToken);
  });

  it("an invalid_client answer (our own Teams app credentials) is NOT a dead grant", async () => {
    const { h, fake } = setup();
    const { conn } = h.connect("PKG", PERSON, { storedAccessExpired: true });
    fake.state.failRefresh = { status: 401, error: "invalid_client", codes: [7000215] };
    const g = await h.guard("PKG", conn);
    const e = await h.tokens.accessToken("PKG", g).then(() => null, (x: unknown) => x as { info: { kind: string } });
    expect(e?.info.kind).not.toBe("reconnect_required");
    expect(h.reconnects).toHaveLength(0);
  });

  it("accepts only a connection the TEAMS guard approved: an unguarded value, a copy, and a connection approved by the mail guard are refused before any Vault read", async () => {
    const { h } = setup();
    const { conn } = h.connect("PKG", PERSON);
    const g = await h.guard("PKG", conn);
    await expect(h.tokens.accessToken("PKG", { ...g })).rejects.toMatchObject({ info: { kind: "forbidden" } });
    await expect(h.tokens.accessToken("PKG", { conn, tenantId: g.tenantId, cloud: "commercial" })).rejects.toMatchObject({ info: { kind: "forbidden" } });
    // and the mail manager refuses a Teams-approved connection
    const mailManager = createMicrosoftTokenManager({ vault: h.vault, client: () => ({ clientId: "x", clientSecret: new SecretValue("y") }) });
    await expect(mailManager.accessToken("PKG", g)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(h.stats.tokenReads).toBe(0);
  });
});
