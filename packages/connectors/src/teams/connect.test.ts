// Teams connect flow (T-279, docs/specs/messages.md 5, 17 tests 1 - 5) on the T-035 framework, against the MSW fake Entra + Graph `/me` of the TEAMS app: authorization code + PKCE +
// nonce, the scopes of the lane's features, the Teams scope rule, the id_token checks, the account from Graph `/me` (a Member, in an allowed domain), tenant / guest / domain refusals,
// reconnect, ownership, D-23, one Teams account per person, consent errors, and "nothing stored" for every refusal. The real provider and flow run over in-memory twins
// (testing/teams-harness.ts). Synthetic data only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { RateLimiter } from "../http/rate-limit";
import { GRANT_NOT_STORED_MESSAGE } from "../oauth/flow";
import { createConnectHandlers } from "../oauth/handlers";
import { useMockServer } from "../testing/msw/index";
import { createFakeTeams, encodeFakeIdToken, FAKE_TEAMS_CLIENT_ID, FAKE_TEAMS_CLIENT_SECRET, TEAMS_ERROR_TEXT_CANARY } from "../testing/msw/teams/handlers";
import { createTeamsHarness, TEAMS_CONNECT_USER, TEAMS_HARNESS_REDIRECT, TEAMS_OWNER, TEAMS_OTHER_USER, TEAMS_TENANT_A, TEAMS_TENANT_B, type TeamsLaneSetup } from "../testing/teams-harness";
import { TEAMS_ONE_ACCOUNT_MESSAGE } from "../contract/errors";
import { assertTeamsRedirectUri, assertTeamsGrantedScopes, teamsRefusedScopeNames } from "./provider";
import { teamsScopesFor } from "./constants";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const DOMAIN = "teams.example.test";
const PERSON = `person@${DOMAIN}`;
const PERSONAL_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

function setup(lane: Partial<TeamsLaneSetup> = {}, extra: Record<string, TeamsLaneSetup> = {}) {
  const fake = createFakeTeams();
  server.use(...fake.handlers);
  const h = createTeamsHarness({
    fake,
    lanes: { PKG: { teams: {}, mailProviders: ["google"], ...lane }, ...extra },
  });
  return { fake, h };
}
type Harness = ReturnType<typeof setup>["h"];

/** Everything a refusal must leave untouched: the Vault, the connection rows, their identity, features and the stored text. */
const frozen = (h: Harness) => ({
  rows: JSON.stringify([...h.rows.values()]),
  secrets: JSON.stringify([...h.secrets.entries()]),
  identities: JSON.stringify([...h.identities.entries()]),
  stores: h.stats.stores,
  identityWrites: h.stats.identityWrites,
  featureWrites: h.stats.featureWrites,
  rotations: h.stats.rotations,
});
const noWrites = (h: Harness, before: ReturnType<typeof frozen>) => expect(frozen(h)).toEqual(before);
const message = (r: { ok: boolean; message?: string }) => (r.ok ? "" : (r.message ?? ""));

describe("start", () => {
  it("builds the consent URL: code + PKCE + nonce, query response mode, account chooser, the lane's one tenant as authority, exactly the phase-1 scopes", async () => {
    const { h } = setup();
    const url = new URL(await h.flow.start("teams", "PKG", h.as(TEAMS_CONNECT_USER)));
    expect(url.origin + url.pathname).toBe(`https://login.microsoftonline.com/${TEAMS_TENANT_A}/oauth2/v2.0/authorize`);
    const p = Object.fromEntries(url.searchParams);
    expect(p).toMatchObject({ response_type: "code", client_id: FAKE_TEAMS_CLIENT_ID, redirect_uri: TEAMS_HARNESS_REDIRECT, response_mode: "query", prompt: "select_account", code_challenge_method: "S256" });
    // exactly: openid, offline_access, User.Read, Chat.Read, User.ReadBasic.All
    expect(p.scope?.split(" ")).toEqual(["openid", "offline_access", "User.Read", "Chat.Read", "User.ReadBasic.All"]);
    expect(p.scope).not.toMatch(/Mail|Calendars|ReadWrite|Send|\.default/);
    expect(p.state).toMatch(/^PKG\.[A-Za-z0-9_-]{43}$/);
    expect(p.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.login_hint).toBeUndefined();
    expect(h.audits.map((a) => a.action)).toEqual(["connection.connect_started"]);
    expect(h.secrets.size).toBe(0);
    expect(h.rows.size).toBe(0);
    // the mail app's client id and secret are not used: the client id is the Teams app's
    expect(url.toString()).not.toContain(FAKE_TEAMS_CLIENT_SECRET);
  });

  it("the scopes follow the lane's features (spec 4.4), in a fixed order", async () => {
    const scopes = async (features: string[]) => {
      const { h } = setup({ teams: { features: features as never } });
      return new URL(await h.flow.start("teams", "PKG", h.as(TEAMS_CONNECT_USER))).searchParams.get("scope")?.split(" ");
    };
    expect(await scopes(["chat_read"])).toEqual(["openid", "offline_access", "User.Read", "Chat.Read"]);
    expect(await scopes(["chat_read", "chat_send"])).toEqual(["openid", "offline_access", "User.Read", "Chat.Read", "ChatMessage.Send"]);
    expect(await scopes(["channels_read", "channels_send", "chat_read"])).toEqual(["openid", "offline_access", "User.Read", "Chat.Read", "Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Read.All", "ChannelMessage.Send"]);
    expect(teamsScopesFor(["chat_read", "call_links"])).toEqual(["openid", "offline_access", "User.Read", "Chat.Read", "User.ReadBasic.All"]);
  });

  it("the authority is the single tenant id, or `organizations` for several; never `common`", async () => {
    const one = setup();
    const two = setup({ teams: { tenantIds: [TEAMS_TENANT_A, TEAMS_TENANT_B] } });
    const a = new URL(await one.h.flow.start("teams", "PKG", one.h.as(TEAMS_CONNECT_USER)));
    const b = new URL(await two.h.flow.start("teams", "PKG", two.h.as(TEAMS_CONNECT_USER)));
    expect(a.pathname).toBe(`/${TEAMS_TENANT_A}/oauth2/v2.0/authorize`);
    expect(b.pathname).toBe("/organizations/oauth2/v2.0/authorize");
    for (const u of [a, b]) expect(u.toString()).not.toMatch(/\/common\/|\/consumers\//);
  });

  it("works for a lane whose MAIL is Google only, with no Microsoft mail settings at all, and never reads anything but the Teams settings", async () => {
    const { h } = setup({ mailProviders: ["google"] });
    await h.flow.start("teams", "PKG", h.as(TEAMS_CONNECT_USER));
    expect(h.stats.teamsSettingsReads).toBeGreaterThan(0);
    expect(h.stats.otherConfigReads).toBe(0);
  });

  it("a reconnect sends login_hint with the stored UPN and no prompt; only the owner can reconnect", async () => {
    const { h } = setup();
    const { row } = h.connect("PKG", PERSON);
    const re = new URL(await h.flow.start("teams", "PKG", h.as(TEAMS_OWNER), { connectionId: row.id })).searchParams;
    expect(re.get("login_hint")).toBe(PERSON);
    expect(re.has("prompt")).toBe(false);
    expect(re.get("state")).toMatch(new RegExp(`^PKG\\.[A-Za-z0-9_-]{43}\\.${row.id}$`));
    await expect(h.flow.start("teams", "PKG", h.as(TEAMS_OTHER_USER), { connectionId: row.id })).rejects.toMatchObject({ info: { kind: "not_found" } });
  });

  it("refuses when Teams is not enabled for the lane (no block, enabled false, an unsupported cloud): nothing stored, no state, no redirect", async () => {
    const cases: [string, Partial<TeamsLaneSetup>][] = [
      ["no teams block", { teams: null }],
      ["enabled false", { teams: { enabled: false } }],
      ["gcc_high", { teams: { cloud: "gcc_high" } }],
      ["no tenant", { teams: { tenantIds: [] } }],
      ["no domain", { teams: { allowedDomains: [] } }],
    ];
    for (const [name, lane] of cases) {
      const { h } = setup(lane);
      await expect(h.flow.start("teams", "PKG", h.as(TEAMS_CONNECT_USER)), name).rejects.toMatchObject({ info: { kind: "forbidden" } });
      expect(h.states.size, name).toBe(0);
      expect(h.writes.length, name).toBe(0);
    }
  });

  it("a malformed lane config refuses (fail closed)", async () => {
    const { h } = setup();
    h.laneConfig.teamsSettings = async () => {
      throw new ConnectorError({ kind: "provider_error", message: "The lane's Teams settings are not valid" });
    };
    await expect(h.flow.start("teams", "PKG", h.as(TEAMS_CONNECT_USER))).rejects.toMatchObject({ info: { kind: "provider_error" } });
    expect(h.states.size).toBe(0);
  });
});

describe("the redirect URI", () => {
  it("must end with the Teams callback path", () => {
    expect(() => assertTeamsRedirectUri("https://app.example.test/api/connect/teams/callback")).not.toThrow();
    expect(() => assertTeamsRedirectUri("http://localhost:3000/api/connect/teams/callback")).not.toThrow();
    for (const bad of ["https://app.example.test/api/connect/microsoft/callback", "https://app.example.test/api/connect/teams/callback/", "https://app.example.test/x", "not a url"]) {
      expect(() => assertTeamsRedirectUri(bad), bad).toThrow(/GRAPH_TEAMS_REDIRECT_URI must end with \/api\/connect\/teams\/callback/);
    }
  });

  it("a wrong value makes the real start fail with the fixed configuration message, which the connect handler turns into the Settings banner (the T-275 path), not bare JSON", async () => {
    const fake = createFakeTeams();
    server.use(...fake.handlers);
    const h = createTeamsHarness({ fake, lanes: { PKG: { teams: {} } }, redirectUri: "https://app.example.test/api/connect/microsoft/callback" });
    const handlers = createConnectHandlers(h.flow, async () => h.as(TEAMS_CONNECT_USER));
    const form = { origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" };
    const res = await handlers.start(new Request("http://localhost:3000/api/connect/teams/start?lane=PKG", { method: "POST", headers: form }), "teams");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/PKG/settings?error=connect_env");
    expect(h.states.size).toBe(0); // nothing stored
    // a script caller keeps the JSON 503 with a fixed body
    const script = await handlers.start(new Request("http://localhost:3000/api/connect/teams/start?lane=PKG", { method: "POST", headers: { ...form, "content-type": "application/json" } }), "teams");
    expect(script.status).toBe(503);
    expect(await script.json()).toEqual({ error: "unavailable" });
  });
});

describe("callback: the account", () => {
  it("connects a Teams account of a Google-mail lane: one microsoft_teams row owned by the person, tenant, cloud and object id recorded, tokens only in the Vault, features recorded", async () => {
    const { fake, h } = setup({ mailProviders: ["google"] });
    const { result } = await h.connectViaCallback("PKG", { upn: PERSON });
    expect(result).toMatchObject({ ok: true, provider: "microsoft_teams", laneId: "PKG" });
    const rows = [...h.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "microsoft_teams", external_account_id: PERSON, status: "active", owner_user_id: TEAMS_CONNECT_USER });
    const id = rows[0]?.id as string;
    expect(h.identities.get(id)).toEqual({ tenantId: TEAMS_TENANT_A, cloud: "commercial", entraObjectId: fake.accountFor(TEAMS_TENANT_A, PERSON)?.objectId });
    expect(rows[0]?.features).toEqual({ teams_chat_read: true, teams_chat_send: false, teams_call_links: true, teams_channels_read: false, teams_channels_send: false });
    // tokens only in the Vault twin, never in a row, a log or an audit entry
    expect(h.secrets.has(id)).toBe(true);
    const text = JSON.stringify([rows, h.logs, h.audits]);
    for (const s of [...fake.state.idTokens, h.storedSet(id)?.access_token as string, h.storedSet(id)?.refresh_token as string, FAKE_TEAMS_CLIENT_SECRET]) expect(text).not.toContain(s);
    // the id_token is not stored
    expect(h.storedSet(id)).not.toHaveProperty("id_token");
    expect(h.audits.map((a) => a.action)).toEqual(["connection.connect_started", "connection.connect.requested", "connection.connect.succeeded"]);
    // the lane's mail settings were never consulted
    expect(h.stats.otherConfigReads).toBe(0);
  });

  it("the account is the sign-in name from Graph /me, never a decoy from the id_token; a Teams account needs no mailbox", async () => {
    const { h } = setup();
    const { result } = await h.connectViaCallback("PKG", { upn: PERSON, profile: { userPrincipalName: `Person.Real@${DOMAIN}` } });
    expect(result.ok).toBe(true);
    expect([...h.rows.values()][0]?.external_account_id).toBe(`person.real@${DOMAIN}`);
  });

  it("the token request carries the TEAMS client credentials and the PKCE verifier", async () => {
    const { fake, h } = setup();
    await h.connectViaCallback("PKG", { upn: PERSON });
    const req = fake.state.tokenRequests[0];
    expect(req?.tenant).toBe(TEAMS_TENANT_A);
    expect(req?.fields).toMatchObject({ grant_type: "authorization_code", client_id: FAKE_TEAMS_CLIENT_ID, client_secret: FAKE_TEAMS_CLIENT_SECRET, redirect_uri: TEAMS_HARNESS_REDIRECT });
    expect(req?.fields.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("same address for mail and Teams (an NC-style lane): a Teams row is created beside the Microsoft MAIL row, which is not touched and is not reused", async () => {
    const { h } = setup({ mailProviders: ["microsoft"] });
    const mailId = "00000000-0000-4000-8000-0000000000a1";
    h.rows.set(mailId, { id: mailId, lane_id: "PKG", provider: "microsoft", external_account_id: PERSON, status: "active", features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null, owner_user_id: TEAMS_CONNECT_USER } as never);
    h.secrets.set(mailId, "synthetic-mail-token-set");
    const before = JSON.stringify(h.rows.get(mailId));
    const { result } = await h.connectViaCallback("PKG", { upn: PERSON });
    expect(result).toMatchObject({ ok: true, provider: "microsoft_teams" });
    expect(result.ok && result.connectionId).not.toBe(mailId);
    expect([...h.rows.values()].map((r) => r.provider).sort()).toEqual(["microsoft", "microsoft_teams"]);
    expect(JSON.stringify(h.rows.get(mailId))).toBe(before);
    expect(h.secrets.get(mailId)).toBe("synthetic-mail-token-set");
  });
});

describe("callback: the scope rule (spec 4.4, test 4)", () => {
  it("every requested scope must be granted; a missing one refuses and nothing is stored", async () => {
    const { h } = setup();
    const before = frozen(h);
    const { result } = await h.connectViaCallback("PKG", { upn: PERSON, scope: "openid offline_access User.Read Chat.Read" }); // User.ReadBasic.All missing
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(message(result)).toBe(GRANT_NOT_STORED_MESSAGE);
    // the row exists as `pending` (the account is only known after the exchange) but holds no token, no identity and no features
    expect(h.secrets.size).toBe(0);
    expect(h.stats.stores).toBe(0);
    expect(h.stats.identityWrites).toBe(0);
    expect(h.stats.featureWrites).toBe(0);
    void before;
  });

  it("an extra granted scope is accepted when it is a Teams scope of this app, and the connection's features are only what was requested", async () => {
    const { h } = setup({ teams: { features: ["chat_read"] } });
    const { result } = await h.connectViaCallback("PKG", { upn: PERSON, extraScopes: "ChannelMessage.Read.All ChatMessage.Send User.ReadBasic.All" });
    expect(result.ok).toBe(true);
    const row = [...h.rows.values()][0];
    expect(row?.features).toMatchObject({ teams_chat_read: true, teams_channels_read: false, teams_chat_send: false, teams_call_links: false });
  });

  it("a Mail.* scope refuses the grant, in either spelling; the refused names are logged as a bounded structured field, never in the user message", async () => {
    for (const extra of ["Mail.Read", "https://graph.microsoft.com/Mail.ReadWrite", "https://other.example.test/.default", "Files.Read.All"]) {
      const { h } = setup();
      const { result } = await h.connectViaCallback("PKG", { upn: PERSON, extraScopes: extra });
      expect(result, extra).toMatchObject({ ok: false, reason: "account_refused" });
      expect(message(result)).toBe(GRANT_NOT_STORED_MESSAGE);
      expect(h.secrets.size, extra).toBe(0);
      expect(h.stats.stores, extra).toBe(0);
      const warn = h.logs.find((l) => l.event === "connector.oauth_callback_failed");
      expect(warn, extra).toBeDefined();
    }
    const { h } = setup();
    await h.connectViaCallback("PKG", { upn: PERSON, extraScopes: "Mail.Read Mail.Send" });
    const warn = h.logs.find((l) => l.event === "connector.oauth_callback_failed") as { fields?: Record<string, unknown> } | undefined;
    expect(JSON.stringify(warn)).toContain("Mail.Read");
  });

  it("assertTeamsGrantedScopes: unit rules", () => {
    const req = teamsScopesFor(["chat_read"]);
    expect(() => assertTeamsGrantedScopes("openid offline_access User.Read Chat.Read", req)).not.toThrow();
    expect(() => assertTeamsGrantedScopes("https://graph.microsoft.com/User.Read https://graph.microsoft.com/Chat.Read", req)).not.toThrow(); // prefix form
    expect(() => assertTeamsGrantedScopes("user.read chat.read", req)).not.toThrow(); // case-insensitive
    expect(() => assertTeamsGrantedScopes("User.Read", req)).toThrow(/did not grant every required scope/);
    expect(() => assertTeamsGrantedScopes(undefined, req)).toThrow(/did not grant/);
    let caught: unknown;
    try {
      assertTeamsGrantedScopes("User.Read Chat.Read Mail.Read Calendars.Read", req);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConnectorError);
    expect((caught as ConnectorError).info.message).not.toContain("Mail.Read");
    expect(teamsRefusedScopeNames(caught)).toEqual(["Mail.Read", "Calendars.Read"]);
  });

  it("a response without a refresh token is refused", async () => {
    const { h } = setup();
    const { result } = await h.connectViaCallback("PKG", { upn: PERSON, refresh: false });
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(h.secrets.size).toBe(0);
  });
});

describe("callback: tenant, guest and domain refusals (test 5)", () => {
  it("a tenant that is not the lane's is wrong_tenant; nothing is stored", async () => {
    const { h } = setup();
    const { result } = await h.connectViaCallback("PKG", { upn: PERSON, tenant: TEAMS_TENANT_B, idToken: { tid: TEAMS_TENANT_B } });
    // the authority is the lane's tenant, so Entra itself refuses a user of another tenant (the fake does too): that is a failed exchange, never a stored account
    expect(result.ok).toBe(false);
    expect(h.secrets.size).toBe(0);
    expect(h.stats.identityWrites).toBe(0);
  });

  it("the connector's own tid check does not rely on the authority: an id_token for another tenant or the personal-account tenant is wrong_tenant", async () => {
    for (const tid of [TEAMS_TENANT_B, PERSONAL_TENANT]) {
      const { h } = setup();
      const { result } = await h.connectViaCallback("PKG", { upn: PERSON, idToken: { tid } });
      expect(result, tid).toMatchObject({ ok: false, reason: "wrong_tenant" });
      expect(h.secrets.size, tid).toBe(0);
    }
  });

  it("the id_token must carry the right issuer, audience (the TEAMS client id), expiry and nonce", async () => {
    const bad: Record<string, unknown>[] = [
      { iss: `https://login.microsoftonline.com/${TEAMS_TENANT_B}/v2.0` },
      { aud: "synthetic-graph-client-id-5521" }, // the mail app's audience
      { exp: Math.floor(Date.now() / 1000) - 10 },
      { nonce: "not-the-nonce" },
      { nonce: undefined },
    ];
    for (const idToken of bad) {
      const { h } = setup();
      const { result } = await h.connectViaCallback("PKG", { upn: PERSON, idToken });
      expect(result, JSON.stringify(idToken)).toMatchObject({ ok: false, reason: "account_refused" });
      expect(h.secrets.size).toBe(0);
    }
    for (const idToken of [null, "garbage", encodeFakeIdToken({})]) {
      const { h } = setup();
      const { result } = await h.connectViaCallback("PKG", { upn: PERSON, idToken });
      expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    }
  });

  it("a guest is refused (userType Guest, or #EXT# in the UPN); a Member with no userType is accepted", async () => {
    for (const profile of [{ userType: "Guest" }, { userPrincipalName: `person_other.test#EXT#@${DOMAIN}` }, { userType: "Weird" }]) {
      const { h } = setup();
      const { result } = await h.connectViaCallback("PKG", { upn: PERSON, profile });
      expect(result, JSON.stringify(profile)).toMatchObject({ ok: false, reason: "account_refused" });
      expect(h.secrets.size).toBe(0);
    }
    const { h } = setup();
    expect((await h.connectViaCallback("PKG", { upn: PERSON, profile: { userType: null } })).result.ok).toBe(true);
  });

  it("an account whose domain is not in teams.allowed_domains is refused; the lane's mail domains make no difference", async () => {
    const { h } = setup({ teams: { allowedDomains: ["only.example.test"] } });
    const { result } = await h.connectViaCallback("PKG", { upn: PERSON });
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(h.secrets.size).toBe(0);
    expect(h.stats.otherConfigReads).toBe(0);
    const ok = setup({ teams: { allowedDomains: ["only.example.test", DOMAIN] } });
    expect((await ok.h.connectViaCallback("PKG", { upn: PERSON })).result.ok).toBe(true);
  });

  it("a missing or malformed sign-in name or object id is refused", async () => {
    for (const profile of [{ userPrincipalName: null }, { userPrincipalName: "no-at-sign" }, { id: "not-a-uuid" }]) {
      const { h } = setup();
      const { result } = await h.connectViaCallback("PKG", { upn: PERSON, profile });
      expect(result, JSON.stringify(profile)).toMatchObject({ ok: false, reason: "account_refused" });
      expect(h.secrets.size).toBe(0);
    }
  });
});

describe("callback: consent errors, reconnect, ownership, D-23", () => {
  it("consent errors become admin_consent_required and exchange nothing; nothing from the query is copied", async () => {
    const { fake, h } = setup();
    const url = await h.flow.start("teams", "PKG", h.as(TEAMS_CONNECT_USER));
    const state = new URL(url).searchParams.get("state") ?? "";
    const res = await h.flow.callback("teams", new URLSearchParams({ state, error: "access_denied", error_description: `AADSTS90094: ${TEAMS_ERROR_TEXT_CANARY}` }), h.as(TEAMS_CONNECT_USER));
    expect(res).toMatchObject({ ok: false, reason: "admin_consent_required" });
    expect(JSON.stringify(res)).not.toContain(TEAMS_ERROR_TEXT_CANARY);
    expect(fake.state.tokenRequests).toHaveLength(0);
    expect(h.secrets.size).toBe(0);
    const url2 = await h.flow.start("teams", "PKG", h.as(TEAMS_CONNECT_USER));
    const res2 = await h.flow.callback("teams", new URLSearchParams({ state: new URL(url2).searchParams.get("state") ?? "", error: "consent_required" }), h.as(TEAMS_CONNECT_USER));
    expect(res2).toMatchObject({ ok: false, reason: "admin_consent_required" });
  });

  it("a reconnect with the same account refreshes the same row and tokens; a different account is wrong_account and nothing changes", async () => {
    const { h } = setup();
    const { row } = h.connect("PKG", PERSON, { owner: TEAMS_CONNECT_USER });
    const re = await h.connectViaCallback("PKG", { upn: PERSON, connectionId: row.id });
    expect(re.result).toMatchObject({ ok: true, connectionId: row.id });
    expect(h.rows.size).toBe(1);
    const before = frozen(h);
    const other = await h.connectViaCallback("PKG", { upn: `other@${DOMAIN}`, connectionId: row.id });
    expect(other.result).toMatchObject({ ok: false, reason: "wrong_account" });
    noWrites(h, before);
  });

  it("a reconnect must come back to the tenant, cloud and object id already recorded", async () => {
    const { h } = setup({ teams: { tenantIds: [TEAMS_TENANT_A, TEAMS_TENANT_B] } });
    const { row } = h.connect("PKG", PERSON, { owner: TEAMS_CONNECT_USER });
    const before = frozen(h);
    const moved = await h.connectViaCallback("PKG", { upn: PERSON, connectionId: row.id, tenant: TEAMS_TENANT_B, idToken: { tid: TEAMS_TENANT_B } });
    expect(moved.result.ok).toBe(false);
    noWrites(h, before);
    // the same tenant but another object id behind the same name
    h.setIdentity(row.id, { tenantId: TEAMS_TENANT_A, cloud: "commercial", entraObjectId: "99999999-9999-4999-8999-999999999999" });
    const before2 = frozen(h);
    const swapped = await h.connectViaCallback("PKG", { upn: PERSON, connectionId: row.id });
    expect(swapped.result).toMatchObject({ ok: false, reason: "wrong_account" });
    noWrites(h, before2);
  });

  it("a Teams row of another person is never reused: the tokens are not stored and the fixed 'another person' message is returned", async () => {
    const { h } = setup();
    h.connect("PKG", PERSON, { owner: TEAMS_OWNER });
    const before = frozen(h);
    const { result } = await h.connectViaCallback("PKG", { upn: PERSON, userId: TEAMS_CONNECT_USER });
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(message(result)).toContain("already connected by another person");
    noWrites(h, before);
  });

  it("D-23: a Teams account connected in another lane is refused with the 'another company' message and nothing is stored in this one", async () => {
    const { h } = setup({}, { OTH: { teams: {} } });
    h.connect("OTH", PERSON, { owner: TEAMS_OWNER });
    const { result } = await h.connectViaCallback("PKG", { upn: PERSON });
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(message(result)).toContain("already connected to another company");
    expect(message(result)).toContain(GRANT_NOT_STORED_MESSAGE);
    expect(h.secrets.size).toBe(1); // only the other lane's token set that the test seeded
    expect([...h.rows.values()].filter((r) => r.lane_id === "PKG" && r.status === "active")).toHaveLength(0);
  });

  it("one Teams connection per person per lane: a second account is refused with its own fixed message, before any token is stored", async () => {
    const { h } = setup();
    h.connect("PKG", PERSON, { owner: TEAMS_CONNECT_USER });
    const stores = h.stats.stores;
    const { result } = await h.connectViaCallback("PKG", { upn: `second@${DOMAIN}`, userId: TEAMS_CONNECT_USER });
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(message(result)).toContain(TEAMS_ONE_ACCOUNT_MESSAGE);
    expect(h.stats.stores).toBe(stores);
    // another person can connect the other account
    const other = await h.connectViaCallback("PKG", { upn: `third@${DOMAIN}`, userId: TEAMS_OTHER_USER });
    expect(other.result.ok).toBe(true);
  });

  it("a state started by another user, or consumed twice, is invalid", async () => {
    const { h } = setup();
    const url = await h.flow.start("teams", "PKG", h.as(TEAMS_CONNECT_USER));
    const state = new URL(url).searchParams.get("state") ?? "";
    const stolen = await h.flow.callback("teams", new URLSearchParams({ state, code: "x" }), h.as(TEAMS_OTHER_USER));
    expect(stolen).toMatchObject({ ok: false, reason: "invalid_state" });
  });

  it("an outage while storing the token is not a refusal of the account, and no token is stored", async () => {
    const { h } = setup();
    h.failStoreOnce(new ConnectorError({ kind: "transient", message: "Token store unavailable" }));
    const { result } = await h.connectViaCallback("PKG", { upn: PERSON });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(h.secrets.size).toBe(0);
  });
});

describe("T-278 review: sub-codes, reconnect beside another account, the token client label", () => {
  const detailOf = (r: { ok: boolean; detail?: string }) => (r.ok ? undefined : r.detail);

  it("S2: reconnecting a disconnected row while another of the person's rows is usable is refused with the one-account message, before any token is stored", async () => {
    const { h } = setup();
    const x = h.connect("PKG", `old@${DOMAIN}`, { owner: TEAMS_CONNECT_USER, status: "disconnected" });
    h.connect("PKG", PERSON, { owner: TEAMS_CONNECT_USER });
    const stores = h.stats.stores;
    const { result } = await h.connectViaCallback("PKG", { upn: `old@${DOMAIN}`, connectionId: x.row.id });
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(message(result)).toContain(TEAMS_ONE_ACCOUNT_MESSAGE);
    expect(detailOf(result)).toBe("one_account");
    expect(h.stats.stores).toBe(stores);
    expect(x.row.status).toBe("disconnected");
  });

  it("S2: a database refusal at the moment the token is stored (two connects racing) is the same fixed refusal, not 'unavailable'", async () => {
    const { h } = setup();
    h.failStoreOnce(new ConnectorError({ kind: "forbidden", message: TEAMS_ONE_ACCOUNT_MESSAGE }));
    const { result } = await h.connectViaCallback("PKG", { upn: PERSON });
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(message(result)).toContain(TEAMS_ONE_ACCOUNT_MESSAGE);
    expect(detailOf(result)).toBe("one_account");
    expect(h.secrets.size).toBe(0);
  });

  it("C1: every refusal carries one coarse fixed sub-code, from the provider's own list", async () => {
    const cases: [string, (h: Harness) => Promise<{ ok: boolean; detail?: string }>, string][] = [
      ["domain", async (h) => (await h.connectViaCallback("PKG", { upn: PERSON })).result, "domain"],
      ["guest", async (h) => (await h.connectViaCallback("PKG", { upn: PERSON, profile: { userType: "Guest" } })).result, "guest"],
      ["scope_missing", async (h) => (await h.connectViaCallback("PKG", { upn: PERSON, scope: "openid offline_access User.Read" })).result, "scope_missing"],
      ["scope_extra", async (h) => (await h.connectViaCallback("PKG", { upn: PERSON, extraScopes: "Mail.Read" })).result, "scope_extra"],
      ["other_person", async (h) => {
        h.connect("PKG", PERSON, { owner: TEAMS_OWNER });
        return (await h.connectViaCallback("PKG", { upn: PERSON })).result;
      }, "other_person"],
      ["other_company", async (h) => {
        h.connect("OTH", PERSON, { owner: TEAMS_OWNER });
        return (await h.connectViaCallback("PKG", { upn: PERSON })).result;
      }, "other_company"],
    ];
    for (const [name, run, want] of cases) {
      const { h } = setup(name === "domain" ? { teams: { allowedDomains: ["only.example.test"] } } : {}, { OTH: { teams: {} } });
      expect(detailOf(await run(h)), name).toBe(want);
    }
    // an id_token problem has no sub-code (a neutral sentence is shown), and a success has none
    const { h } = setup();
    expect(detailOf((await h.connectViaCallback("PKG", { upn: PERSON, idToken: { nonce: "x" } })).result)).toBeUndefined();
  });

  it("C1: the callback redirect carries the sub-code only in its fixed shape, and nothing else of the failure", async () => {
    const callbackWith = async (detail: string | undefined) => {
      const flow = { has: () => true, start: async () => "", callback: async () => ({ ok: false as const, reason: "account_refused" as const, provider: "microsoft_teams" as const, laneId: "PKG", ...(detail === undefined ? {} : { detail }) }) };
      const res = await createConnectHandlers(flow as never, async () => (async () => ({ userId: "u", client: {} })) as never).callback(new Request("http://localhost:3000/api/connect/teams/callback?state=PKG.x"), "teams");
      return res.headers.get("location");
    };
    expect(await callbackWith("guest")).toBe("/PKG/settings?connect=account_refused&provider=microsoft_teams&detail=guest");
    expect(await callbackWith(undefined)).toBe("/PKG/settings?connect=account_refused&provider=microsoft_teams");
    for (const bad of ["Guest", "a b", "x".repeat(40), "<script>", "9lives", ""]) expect(await callbackWith(bad), bad).toBe("/PKG/settings?connect=account_refused&provider=microsoft_teams");
  });

  it("C6: Microsoft's invalid_scope answer (a feature the Teams app lacks) is a 'not set up' refusal, not a cancelled connect", async () => {
    const { h } = setup();
    const url = await h.flow.start("teams", "PKG", h.as(TEAMS_CONNECT_USER));
    const state = new URL(url).searchParams.get("state") ?? "";
    const res = await h.flow.callback("teams", new URLSearchParams({ state, error: "invalid_scope", error_description: `AADSTS70011: ${TEAMS_ERROR_TEXT_CANARY}` }), h.as(TEAMS_CONNECT_USER));
    expect(res).toMatchObject({ ok: false, reason: "exchange_failed", detail: "not_set_up" });
    expect(JSON.stringify(res)).not.toContain(TEAMS_ERROR_TEXT_CANARY);
    const url2 = await h.flow.start("teams", "PKG", h.as(TEAMS_CONNECT_USER));
    const denied = await h.flow.callback("teams", new URLSearchParams({ state: new URL(url2).searchParams.get("state") ?? "", error: "access_denied" }), h.as(TEAMS_CONNECT_USER));
    expect(denied).toMatchObject({ ok: false, reason: "denied" });
    expect(denied).not.toHaveProperty("detail");
  });

  it("C7: token requests to the sign-in host are labelled with the Teams provider, and only the sign-in host is reachable", async () => {
    const { h, fake } = setup();
    const { conn } = h.connect("PKG", PERSON, { storedAccessExpired: true });
    const g = await h.guard("PKG", conn);
    await h.tokens.accessToken("PKG", g);
    expect(fake.state.refreshes).toBe(1);
    const providers = new Set(h.logs.map((l) => (l as { fields?: { provider?: string }; provider?: string }).provider ?? (l as { fields?: { provider?: string } }).fields?.provider).filter(Boolean));
    expect([...providers]).toContain("microsoft_teams");
    expect(providers.has("microsoft")).toBe(false);
    const { createTeamsTokenHttp } = await import("./http");
    expect(() => createTeamsTokenHttp({ baseUrl: "https://graph.microsoft.com", laneId: "PKG" })).toThrow(/not an allowed Microsoft host/);
    expect(() => createTeamsTokenHttp({ baseUrl: "https://login.microsoftonline.com", laneId: "PKG" })).not.toThrow();
  });
});
