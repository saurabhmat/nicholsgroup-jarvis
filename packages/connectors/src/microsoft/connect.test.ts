// Microsoft connect flow (T-066, spec §5, §7, §17 tests 4 - 9) on the T-035 framework, against the MSW fake Entra + Graph `/me`:
// authorization code + PKCE + nonce, scopes, the id_token checks (V-6: no signature, `tid`/`iss`/`aud`/`exp`/`nonce` instead), the
// mailbox from Graph `/me`, tenant and guest refusals, reconnect, ownership, D-23, consent errors, and "nothing stored" for every
// refusal. The real provider and flow run over in-memory twins (testing/microsoft-harness.ts). Synthetic data only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { RateLimiter } from "../http/rate-limit";
import { createConnectHandlers } from "../oauth/handlers";
import { nonceOf } from "../oauth/pkce";
import { createGoogleHarness } from "../testing/google-harness";
import { createMicrosoftHarness, CONNECT_USER, HARNESS_OWNER, HARNESS_REDIRECT, TENANT_A, TENANT_B, TENANT_C, type LaneSetup } from "../testing/microsoft-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeGoogle } from "../testing/msw/google/handlers";
import { createFakeMicrosoft, FAKE_GRAPH_CLIENT_ID, FAKE_GRAPH_CLIENT_SECRET, MICROSOFT_ERROR_TEXT_CANARY, encodeFakeIdToken } from "../testing/msw/microsoft/handlers";
import { PROVIDER_DISABLED_MESSAGE, providerEnabledIn } from "../facade/gate";
import { GRAPH_SCOPE_PREFIX } from "./constants";
import { assertGrantedScopes, assertRedirectUri, microsoftCallbackErrorReason } from "./provider";
import { parseStored } from "./token-manager";
import { REDACTED, SecretValue } from "../vault/secret";
import { GRANT_NOT_STORED_MESSAGE } from "../oauth/flow";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const DOMAIN = "corp.example.test";
const EXEC = `exec@${DOMAIN}`;
const PERSONAL_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const READ_SHORT = ["User.Read", "Mail.Read", "Calendars.Read"];

function setup(lane: Partial<LaneSetup> = {}, extra: Record<string, LaneSetup> = {}) {
  const fake = createFakeMicrosoft();
  server.use(...fake.handlers);
  const h = createMicrosoftHarness({
    fake,
    lanes: { PKG: { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: [DOMAIN], ...lane }, ...extra },
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
  it("builds the consent URL: code + PKCE + nonce, query response mode, account chooser, the lane's one tenant as authority, exactly the read scopes", async () => {
    const { h } = setup();
    const url = new URL(await h.flow.start("microsoft", "PKG", h.as(CONNECT_USER)));
    expect(url.origin + url.pathname).toBe(`https://login.microsoftonline.com/${TENANT_A}/oauth2/v2.0/authorize`);
    const p = Object.fromEntries(url.searchParams);
    expect(p).toMatchObject({ response_type: "code", client_id: FAKE_GRAPH_CLIENT_ID, redirect_uri: HARNESS_REDIRECT, response_mode: "query", prompt: "select_account", code_challenge_method: "S256" });
    expect(p.scope?.split(" ")).toEqual(["openid", "offline_access", "User.Read", "Mail.Read", "Calendars.Read"]);
    expect(p.scope).not.toMatch(/ReadWrite|Send|Shared|\.default/);
    expect(p.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.state).toMatch(/^PKG\.[A-Za-z0-9_-]{43}$/);
    expect(p.login_hint).toBeUndefined();
    expect(h.audits.map((a) => a.action)).toEqual(["connection.connect_started"]);
    expect(h.secrets.size).toBe(0);
    expect(h.rows.size).toBe(0);
  });

  it("the authority is the single tenant id, or `organizations` for several; never `common`", async () => {
    const one = setup();
    const two = setup({ microsoft: { tenantIds: [TENANT_A, TENANT_B] } });
    const a = new URL(await one.h.flow.start("microsoft", "PKG", one.h.as(CONNECT_USER)));
    const b = new URL(await two.h.flow.start("microsoft", "PKG", two.h.as(CONNECT_USER)));
    expect(a.pathname).toBe(`/${TENANT_A}/oauth2/v2.0/authorize`);
    expect(b.pathname).toBe("/organizations/oauth2/v2.0/authorize");
    for (const u of [a, b]) expect(u.toString()).not.toMatch(/\/common\/|\/consumers\//);
    expect(await one.h.oauthProvider.endpoints("PKG")).toEqual({ authorization: `https://login.microsoftonline.com/${TENANT_A}/oauth2/v2.0/authorize`, token: `https://login.microsoftonline.com/${TENANT_A}/oauth2/v2.0/token` });
    expect((await two.h.oauthProvider.endpoints("PKG")).token).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/token");
  });

  it("Mail.ReadWrite and Mail.Send are asked for only when the lane policy allows email writes", async () => {
    const off = setup();
    const on = setup();
    on.h.writeLanes.add("PKG");
    const scopesOf = async (h: Harness) => new URL(await h.flow.start("microsoft", "PKG", h.as(CONNECT_USER))).searchParams.get("scope")?.split(" ");
    expect(await scopesOf(off.h)).not.toContain("Mail.Send");
    expect(await scopesOf(on.h)).toEqual(["openid", "offline_access", "User.Read", "Mail.Read", "Calendars.Read", "Mail.ReadWrite", "Mail.Send"]);
  });

  it("a reconnect sends login_hint with the stored address and no prompt (they cannot be combined); a first connect never sends login_hint", async () => {
    const { h } = setup();
    const { row } = h.connect("PKG", EXEC);
    const re = new URL(await h.flow.start("microsoft", "PKG", h.as(HARNESS_OWNER), { connectionId: row.id })).searchParams;
    expect(re.get("login_hint")).toBe(EXEC);
    expect(re.has("prompt")).toBe(false);
    expect(re.get("state")).toMatch(new RegExp(`^PKG\\.[A-Za-z0-9_-]{43}\\.${row.id}$`));
    const first = new URL(await h.flow.start("microsoft", "PKG", h.as(HARNESS_OWNER))).searchParams;
    expect(first.has("login_hint")).toBe(false);
    expect(first.get("prompt")).toBe("select_account");
    // Only the owner reconnects their own mailbox; another user gets not_found.
    await expect(h.flow.start("microsoft", "PKG", h.as(CONNECT_USER), { connectionId: row.id })).rejects.toMatchObject({ info: { kind: "not_found" } });
  });

  it("the PKCE verifier, the nonce's source and the client secret never leave the server: only the challenge and a derived nonce are in the URL", async () => {
    const { h } = setup();
    const url = await h.flow.start("microsoft", "PKG", h.as(CONNECT_USER));
    const [stored] = [...h.states.values()];
    expect(stored?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url).not.toContain(stored?.codeVerifier ?? "x");
    expect(url).not.toContain(FAKE_GRAPH_CLIENT_SECRET);
    const q = new URL(url).searchParams;
    expect(q.get("nonce")).toBe(nonceOf(stored?.codeVerifier ?? ""));
    expect(q.get("nonce")).not.toBe(q.get("code_challenge"));
  });

  it("refuses when Microsoft is not enabled for the lane (no `microsoft` block, or `microsoft` not in mail.providers): nothing stored, no state, no redirect; the lane's Google connect still works", async () => {
    const cases: [string, Partial<LaneSetup>][] = [
      ["no microsoft block", { providers: ["google"], microsoft: null }],
      ["a block but microsoft not in mail.providers", { providers: ["google"], microsoft: { tenantIds: [TENANT_A] } }],
      ["microsoft listed but no block", { providers: ["google", "microsoft"], microsoft: null }],
    ];
    for (const [title, lane] of cases) {
      const { fake, h } = setup(lane);
      await expect(h.flow.start("microsoft", "PKG", h.as(CONNECT_USER)), title).rejects.toMatchObject({ info: { kind: "forbidden", message: PROVIDER_DISABLED_MESSAGE } });
      expect(h.states.size, title).toBe(0);
      expect(h.audits, title).toEqual([]);
      expect(h.writeCount(), title).toBe(0);
      expect(fake.state.tokenRequests.length + fake.state.graphRequests.length, title).toBe(0);
    }
    // The same lane configuration: Microsoft is refused, Google connects. (One config twin decides both.)
    const ms = setup({ providers: ["google"], microsoft: null });
    const g = createFakeGoogle();
    server.use(...g.handlers);
    const gh = createGoogleHarness({
      fake: g,
      mailboxes: { PKG: ["exec@pubkgroup.example.test"] },
      googleEnabled: async (laneId) => providerEnabledIn(await ms.h.laneConfig.mailProviderSettings(laneId), "google"),
    });
    await expect(ms.h.connectViaCallback("PKG", { address: EXEC })).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect((await gh.connectViaCallback("PKG", { email: "exec@pubkgroup.example.test" })).result).toMatchObject({ ok: true, provider: "google" });
  });

  it("Microsoft being disabled after the start refuses the callback before the exchange: nothing stored", async () => {
    const { fake, h } = setup();
    const url = await h.flow.start("microsoft", "PKG", h.as(CONNECT_USER));
    h.setLane("PKG", { providers: ["google"] });
    const before = frozen(h);
    const state = new URL(url).searchParams.get("state") ?? "";
    const result = await h.flow.callback("microsoft", new URLSearchParams({ state, code: "synthetic-code-never-sent" }), h.as(CONNECT_USER));
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(fake.state.tokenRequests).toEqual([]);
    noWrites(h, before);
  });
});

describe("callback: the happy path (spec §17 test 4)", () => {
  it("a viewer with own_mail connects: one active row owned by them, tenant and cloud set, tokens only in the Vault, an audit row", async () => {
    const { fake, h } = setup();
    const { result, url, code } = await h.connectViaCallback("PKG", { address: EXEC });
    expect(result).toMatchObject({ ok: true, provider: "microsoft", laneId: "PKG" });
    const rows = [...h.rows.values()];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({ lane_id: "PKG", provider: "microsoft", external_account_id: EXEC, status: "active", owner_user_id: CONNECT_USER, token_expires_at: null });
    expect(h.identities.get(row?.id ?? "")).toEqual({ tenantId: TENANT_A, cloud: "commercial" });
    expect(row?.features).toEqual({ graph_mail_write: false });
    // The token request: authorization_code, PKCE verifier, secret in the body, at the lane's tenant authority.
    expect(fake.state.tokenRequests).toHaveLength(1);
    const req = fake.state.tokenRequests[0];
    expect(req?.tenant).toBe(TENANT_A);
    expect(req?.fields).toMatchObject({ grant_type: "authorization_code", code, redirect_uri: HARNESS_REDIRECT, client_id: FAKE_GRAPH_CLIENT_ID, client_secret: FAKE_GRAPH_CLIENT_SECRET });
    expect(req?.fields.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url).not.toContain(req?.fields.code_verifier ?? "x");
    // The stored set is what the token manager reads: a refresh token, ISO obtained_at (parseStored accepts it); no id_token.
    const stored = h.storedSet(row?.id ?? "");
    expect(typeof stored?.refresh_token).toBe("string");
    expect(typeof stored?.access_token).toBe("string");
    expect(stored).not.toHaveProperty("id_token");
    expect(() => parseStored(new SecretValue(JSON.stringify(stored)))).not.toThrow();
    expect(Number.isNaN(Date.parse(String(stored?.obtained_at)))).toBe(false);
    expect(h.audits.map((a) => a.action)).toEqual(["connection.connect_started", "connection.connect.requested", "connection.connect.succeeded"]);
    // `/me` was asked for exactly the identity fields.
    expect(fake.state.graphRequests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1.0/me"]);
    expect(new URLSearchParams(fake.state.graphRequests[0]?.search).get("$select")).toBe("id,mail,userPrincipalName,userType");
  });

  it("the mailbox is Graph's `mail`, lower-cased; the id_token's preferred_username and email (decoys) are never used", async () => {
    const { fake, h } = setup();
    const account = fake.addAccount(TENANT_A, "Exec@Corp.Example.Test");
    account.profile = { mail: "Exec@Corp.Example.Test" };
    const { result } = await h.connectViaCallback("PKG", { address: "Exec@Corp.Example.Test" });
    expect(result.ok).toBe(true);
    expect([...h.rows.values()][0]?.external_account_id).toBe(EXEC);
    // A token whose decoy claims are in the allowed domain cannot rescue a mailbox that is not.
    const other = await h.connectViaCallback("PKG", { address: "stranger@elsewhere.example.test", idToken: { preferred_username: EXEC, email: EXEC } });
    expect(other.result).toMatchObject({ ok: false, reason: "account_refused" });
  });

  it("with the lane policy allowing writes, the write scopes are required and graph_mail_write is recorded true", async () => {
    const { h } = setup();
    h.writeLanes.add("PKG");
    const all = `${[...READ_SHORT, "Mail.ReadWrite", "Mail.Send"].map((s) => GRAPH_SCOPE_PREFIX + s.toLowerCase()).join(" ")} openid profile offline_access`;
    expect((await h.connectViaCallback("PKG", { address: EXEC, scope: all })).result.ok).toBe(true);
    expect([...h.rows.values()][0]?.features).toEqual({ graph_mail_write: true });
    // Read scopes only (the user could not or did not accept the write ones): refused, nothing stored.
    const second = setup();
    second.h.writeLanes.add("PKG");
    const before = frozen(second.h);
    expect((await second.h.connectViaCallback("PKG", { address: EXEC })).result).toMatchObject({ ok: false, reason: "account_refused" });
    noWrites(second.h, before);
  });

  it("a user who already has an active Google connection with the same address in the lane connects the Microsoft mailbox; both rows active (different provider)", async () => {
    const { h } = setup({ providers: ["google", "microsoft"] });
    const google = { id: "00000000-0000-4000-8000-00000000f0c1", lane_id: "PKG", provider: "google", external_account_id: EXEC, status: "active", features: { gmail_compose: false }, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null, owner_user_id: CONNECT_USER };
    h.rows.set(google.id, google as never);
    h.secrets.set(google.id, '{"access_token":"synthetic-google-set"}');
    const googleBefore = JSON.stringify(google);
    const reads = { loads: h.stats.loads, tokenReads: h.stats.tokenReads, rotations: h.stats.rotations };
    const { result } = await h.connectViaCallback("PKG", { address: EXEC });
    expect(result).toMatchObject({ ok: true, provider: "microsoft" });
    const rows = [...h.rows.values()];
    expect(rows.map((r) => `${r.provider}:${r.status}`).sort()).toEqual(["google:active", "microsoft:active"]);
    const ms = rows.find((r) => r.provider === "microsoft");
    expect(ms?.id).not.toBe(google.id);
    expect(ms?.owner_user_id).toBe(CONNECT_USER);
    // The Google row and its token were not read, changed or disconnected.
    expect(JSON.stringify(h.rows.get(google.id))).toBe(googleBefore);
    expect(h.secrets.get(google.id)).toBe('{"access_token":"synthetic-google-set"}');
    expect({ loads: h.stats.loads, tokenReads: h.stats.tokenReads, rotations: h.stats.rotations }).toEqual(reads);
  });
});

describe("refusals before the exchange: zero requests reach the fake token endpoint", () => {
  it("no tenant ids configured refuses before the exchange", async () => {
    const { fake, h } = setup();
    const url = await h.flow.start("microsoft", "PKG", h.as(CONNECT_USER));
    h.setLane("PKG", { microsoft: { tenantIds: [] } });
    const before = frozen(h);
    const state = new URL(url).searchParams.get("state") ?? "";
    const result = await h.flow.callback("microsoft", new URLSearchParams({ state, code: "synthetic-code-x" }), h.as(CONNECT_USER));
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(message(result)).toBe(""); // no grant exists: nothing to remove at Microsoft
    expect(fake.state.tokenRequests).toEqual([]);
    expect(fake.state.graphRequests).toEqual([]);
    noWrites(h, before);
    await expect(h.oauthProvider.endpoints("PKG")).rejects.toBeInstanceOf(ConnectorError);
  });

  it("no mail domains configured refuses before the exchange (fail closed, as Google)", async () => {
    const { fake, h } = setup({ domains: [] });
    const before = frozen(h);
    const { result } = await h.connectViaCallback("PKG", { address: EXEC });
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(fake.state.tokenRequests).toEqual([]);
    noWrites(h, before);
  });

  it("an unreadable lane configuration refuses before the exchange", async () => {
    const { fake, h } = setup();
    const url = await h.flow.start("microsoft", "PKG", h.as(CONNECT_USER));
    delete h.lanes.PKG;
    const state = new URL(url).searchParams.get("state") ?? "";
    const result = await h.flow.callback("microsoft", new URLSearchParams({ state, code: "c" }), h.as(CONNECT_USER));
    expect(result.ok).toBe(false);
    expect(fake.state.tokenRequests).toEqual([]);
    expect(h.stats.stores).toBe(0);
  });

  it("the callback's precheck and the start check each decide from ONE mailProviderSettings read", async () => {
    const { h } = setup();
    const reads = () => h.stats.settingsReads;
    const a = reads();
    await h.oauthProvider.startCheck?.({ laneId: "PKG" });
    expect(reads() - a).toBe(1);
    const b = reads();
    await h.oauthProvider.precheck?.({ laneId: "PKG", callback: new URLSearchParams() });
    expect(reads() - b).toBe(1);
  });

  it("a state of another user, another lane, a replay or garbage exchanges nothing (state is bound to user and lane and single use)", async () => {
    const { fake, h } = setup({}, { APK: { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: [DOMAIN] } });
    const account = fake.addAccount(TENANT_A, EXEC);
    const url = await h.flow.start("microsoft", "PKG", h.as(CONNECT_USER));
    const q = new URL(url).searchParams;
    fake.grant("code-a", { account, codeChallenge: q.get("code_challenge") ?? "", nonce: q.get("nonce") ?? "" });
    const back = (extra: Record<string, string>, state = q.get("state") ?? "") => new URLSearchParams({ state, ...extra });
    expect(await h.flow.callback("microsoft", back({ code: "code-a" }), h.as(HARNESS_OWNER))).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(fake.state.tokenRequests).toEqual([]);
    expect(await h.flow.callback("microsoft", back({ code: "code-a" }, (q.get("state") ?? "").replace("PKG.", "APK.")), h.as(CONNECT_USER))).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(await h.flow.callback("microsoft", back({ code: "code-a" }, "garbage"), h.as(CONNECT_USER))).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(fake.state.tokenRequests).toEqual([]);
    expect(await h.flow.callback("microsoft", back({ code: "code-a" }), h.as(CONNECT_USER))).toMatchObject({ ok: true }); // the owner of the state finishes
    expect(await h.flow.callback("microsoft", back({ code: "code-a" }), h.as(CONNECT_USER))).toMatchObject({ ok: false, reason: "invalid_state" }); // replay
    expect(fake.state.tokenRequests).toHaveLength(1);
  });
});

describe("refused after the exchange: the grant is dropped, never stored, and the user is told to remove the app's access (spec §17 tests 5, 6, 8)", () => {
  const refused = async (h: Harness, fake: ReturnType<typeof setup>["fake"], opts: Parameters<Harness["connectViaCallback"]>[1], reason: string, title: string) => {
    const before = frozen(h);
    const { result } = await h.connectViaCallback("PKG", opts);
    expect(result, title).toMatchObject({ ok: false, reason });
    expect(message(result), title).toBe(GRANT_NOT_STORED_MESSAGE);
    expect(fake.state.tokenRequests.length, title).toBeGreaterThan(0);
    noWrites(h, before);
    expect(h.rows.size, title).toBe(0);
    expect(h.audits.map((a) => a.action), title).toContain("connection.connect.grant_not_stored");
    return result;
  };

  it("wrong tenant: a `tid` not in the lane's tenant_ids is `wrong_tenant`; no row, no token", async () => {
    const { fake, h } = setup({ microsoft: { tenantIds: [TENANT_A, TENANT_C] } });
    await refused(h, fake, { address: EXEC, tenant: TENANT_B }, "wrong_tenant", "tenant B");
    expect(fake.state.graphRequests).toEqual([]); // the identity check never used the new token
  });

  it("personal-account tenant refused (even if a lane listed it), as wrong_tenant", async () => {
    const { fake, h } = setup({ microsoft: { tenantIds: [PERSONAL_TENANT, TENANT_A] } });
    await refused(h, fake, { address: EXEC, tenant: PERSONAL_TENANT }, "wrong_tenant", "personal");
    expect(fake.state.graphRequests).toEqual([]);
  });

  it("wrong domain / not on the list: `/me` returns an address on another domain, or one that is not on the exact mailbox list: account_refused", async () => {
    const a = setup();
    await refused(a.h, a.fake, { address: "stranger@elsewhere.example.test" }, "account_refused", "other domain");
    const b = setup({ mailboxes: ["someone.else@corp.example.test"] });
    await refused(b.h, b.fake, { address: EXEC }, "account_refused", "not on the list");
  });

  it("extra scope: a write scope under a read-only lane policy refuses the account, even next to the read ones", async () => {
    const full = (extra: string) => `${READ_SHORT.map((s) => GRAPH_SCOPE_PREFIX + s).join(" ")} ${extra}`;
    for (const extra of ["Mail.Send", "Mail.ReadWrite", `${GRAPH_SCOPE_PREFIX}Mail.Send`, "mail.send", "Calendars.ReadWrite", "Files.Read", "https://other.example.test/Mail.Read"]) {
      const { fake, h } = setup();
      await refused(h, fake, { address: EXEC, scope: full(extra) }, "account_refused", extra);
    }
  });

  it("a missing scope (the user unticked one), no scope field, and no refresh token each refuse", async () => {
    for (const missing of READ_SHORT) {
      const { fake, h } = setup();
      await refused(h, fake, { address: EXEC, scope: READ_SHORT.filter((s) => s !== missing).join(" ") }, "account_refused", missing);
    }
    const none = setup();
    await refused(none.h, none.fake, { address: EXEC, scope: null }, "account_refused", "no scope field");
    const empty = setup();
    await refused(empty.h, empty.fake, { address: EXEC, scope: "" }, "account_refused", "empty scope");
    const noRefresh = setup();
    await refused(noRefresh.h, noRefresh.fake, { address: EXEC, refresh: false }, "account_refused", "no refresh token");
  });

  it("a guest, an account without a mailbox and a malformed profile are refused", async () => {
    const cases: [string, NonNullable<Parameters<Harness["connectViaCallback"]>[1]["profile"]>][] = [
      ["guest userType", { userType: "Guest" }],
      ["guest in another case", { userType: "guest" }],
      ["an unknown userType", { userType: "Visitor" }],
      ["null userType with #EXT# in the UPN", { userType: null, userPrincipalName: "exec_corp.example.test#EXT#@other.example.test" }],
      ["#EXT# in the UPN", { userPrincipalName: "exec_corp.example.test#EXT#@other.example.test" }],
      ["#ext# lower-case", { userPrincipalName: "exec_corp.example.test#ext#@other.example.test" }],
      ["no mail (null)", { mail: null }],
      ["empty mail", { mail: "" }],
      ["mail that is not an address", { mail: "not-an-address" }],
    ];
    for (const [title, profile] of cases) {
      const { fake, h } = setup();
      await refused(h, fake, { address: EXEC, profile }, "account_refused", title);
    }
    for (const body of [{}, "nonsense", { id: "u1", userType: "Member" }]) {
      const { fake, h } = setup();
      fake.state.meBody = body;
      await refused(h, fake, { address: EXEC }, "account_refused", `profile ${JSON.stringify(body)}`); // no userType, no mail, or not an object
    }
  });

  it("userType: null, missing, empty and `member` in any case are accepted when the UPN has no #EXT# (Microsoft documents Member and Guest and does not rule out null)", async () => {
    for (const profile of [{ userType: null }, { userType: "" }, { userType: "member" }, { userType: "MEMBER" }, { userType: "Member" }]) {
      const { h } = setup();
      expect((await h.connectViaCallback("PKG", { address: EXEC, profile })).result, JSON.stringify(profile)).toMatchObject({ ok: true });
    }
    const { fake, h } = setup();
    fake.state.meBody = { id: "u1", mail: EXEC, userPrincipalName: EXEC }; // no userType field at all
    expect((await h.connectViaCallback("PKG", { address: EXEC })).result).toMatchObject({ ok: true });
  });

  it("an outage while reading `/me` is `unavailable`, not a refusal of the account; nothing is stored", async () => {
    const { fake, h } = setup();
    fake.state.meFail = { status: 500, code: "InternalServerError", times: 10 };
    const before = frozen(h);
    const { result } = await h.connectViaCallback("PKG", { address: EXEC });
    expect(result).toMatchObject({ ok: false, reason: "unavailable", message: GRANT_NOT_STORED_MESSAGE });
    noWrites(h, before);
  });

  it("D-23: a mailbox already connected in another lane is refused, with the fixed 'another company' text", async () => {
    const other: LaneSetup = { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: [DOMAIN] };
    const { h } = setup({}, { APK: other });
    expect((await h.connectViaCallback("APK", { address: EXEC })).result.ok).toBe(true);
    const before = frozen(h);
    const { result } = await h.connectViaCallback("PKG", { address: EXEC });
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(message(result)).toMatch(/already connected to another company/);
    expect([...h.rows.values()].filter((r) => r.lane_id === "PKG" && r.status === "active")).toEqual([]);
    expect(h.stats.stores).toBe(before.stores);
  });

  it("ownership: a mailbox row that belongs to someone else is never reused or given tokens (T-247)", async () => {
    const { h } = setup();
    const { row } = h.connect("PKG", EXEC); // owned by HARNESS_OWNER
    const before = frozen(h);
    const { result } = await h.connectViaCallback("PKG", { address: EXEC, userId: CONNECT_USER });
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(message(result)).toMatch(/already connected by another person/);
    noWrites(h, before);
    expect(h.rows.get(row.id)?.owner_user_id).toBe(HARNESS_OWNER);
  });
});

describe("the id_token (V-6): no signature check; tid, iss, aud, exp and nonce each refuse the grant", () => {
  const future = () => Math.floor(Date.now() / 1000) + 3600;
  const cases: [string, Record<string, unknown> | string | null, string][] = [
    ["wrong iss (another tenant's issuer)", { iss: `https://login.microsoftonline.com/${TENANT_B}/v2.0` }, "account_refused"],
    ["wrong iss (the v1 issuer)", { iss: `https://sts.windows.net/${TENANT_A}/` }, "account_refused"],
    ["wrong iss (another host)", { iss: `https://login.example.test/${TENANT_A}/v2.0` }, "account_refused"],
    ["missing iss", { iss: undefined }, "account_refused"],
    ["wrong aud", { aud: "some-other-client-id" }, "account_refused"],
    ["missing aud", { aud: undefined }, "account_refused"],
    ["aud as a list", { aud: [FAKE_GRAPH_CLIENT_ID] }, "account_refused"],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 10 }, "account_refused"],
    ["missing exp", { exp: undefined }, "account_refused"],
    ["exp as text", { exp: String(future()) }, "account_refused"],
    ["wrong nonce", { nonce: "a-nonce-that-was-never-sent" }, "account_refused"],
    ["missing nonce", { nonce: undefined }, "account_refused"],
    ["empty nonce", { nonce: "" }, "account_refused"],
    ["tid not in the lane's list", { tid: TENANT_B, iss: `https://login.microsoftonline.com/${TENANT_B}/v2.0` }, "wrong_tenant"],
    ["tid of a personal account", { tid: PERSONAL_TENANT, iss: `https://login.microsoftonline.com/${PERSONAL_TENANT}/v2.0` }, "wrong_tenant"],
    ["missing tid", { tid: undefined }, "account_refused"],
    ["tid that is not a GUID", { tid: "common" }, "account_refused"],
    ["tid in upper case", { tid: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE" }, "account_refused"],
    ["tid that is a number", { tid: 5 }, "account_refused"],
    ["no id_token at all", null, "account_refused"],
    ["not a token", "abc", "account_refused"],
    ["two parts", "aGVhZGVy.cGF5bG9hZA", "account_refused"],
    ["four parts", "a.b.c.d", "account_refused"],
    ["payload that is not base64url", "aGVhZGVy.@@@@.c2ln", "account_refused"],
    ["payload that is not JSON", `aGVhZGVy.${Buffer.from("not json").toString("base64url")}.c2ln`, "account_refused"],
    ["payload that is a JSON list", `aGVhZGVy.${Buffer.from("[1]").toString("base64url")}.c2ln`, "account_refused"],
    ["empty signature part", `${encodeFakeIdToken({ tid: TENANT_A }).split(".").slice(0, 2).join(".")}.`, "account_refused"],
    ["oversized token", `a.${"b".repeat(20_000)}.c`, "account_refused"],
  ];
  for (const [title, idToken, reason] of cases) {
    it(`${title} refuses the grant (${reason}); the new access token is never used and nothing is stored`, async () => {
      // The lane lists a second, letter-bearing tenant so a lower- vs upper-case `tid` is a real difference.
      const { fake, h } = setup({ microsoft: { tenantIds: [TENANT_A, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"] } });
      const before = frozen(h);
      const { result } = await h.connectViaCallback("PKG", { address: EXEC, idToken });
      expect(result).toMatchObject({ ok: false, reason, message: GRANT_NOT_STORED_MESSAGE });
      expect(fake.state.tokenRequests).toHaveLength(1);
      expect(fake.state.graphRequests).toEqual([]);
      noWrites(h, before);
      expect(h.rows.size).toBe(0);
    });
  }

  it("a token for the right tenant, issuer, audience, expiry and nonce is accepted without any signature check (the signature part is a filler)", async () => {
    const { h } = setup();
    expect((await h.connectViaCallback("PKG", { address: EXEC })).result.ok).toBe(true);
  });

  it("the nonce is bound to its own connect attempt: one from another attempt (a replayed token) is refused", async () => {
    const { h } = setup();
    const first = await h.flow.start("microsoft", "PKG", h.as(CONNECT_USER));
    const stolen = new URL(first).searchParams.get("nonce") ?? "";
    const before = frozen(h);
    const { result } = await h.connectViaCallback("PKG", { address: EXEC, nonce: stolen });
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    noWrites(h, before);
  });

  it("the tenant that is recorded is the id_token's `tid`", async () => {
    const { h } = setup({ microsoft: { tenantIds: [TENANT_A, TENANT_C] } });
    expect((await h.connectViaCallback("PKG", { address: EXEC, tenant: TENANT_C })).result.ok).toBe(true);
    expect([...h.identities.values()]).toEqual([{ tenantId: TENANT_C, cloud: "commercial" }]);
  });
});

describe("reconnect (spec §7 step 8)", () => {
  it("the same mailbox in the same tenant reuses the row, replaces the token and does not write the identity again", async () => {
    const { fake, h } = setup();
    const { row, account } = h.connect("PKG", EXEC);
    const oldSet = h.secrets.get(row.id);
    const { result } = await h.connectViaCallback("PKG", { address: EXEC, userId: HARNESS_OWNER, connectionId: row.id });
    expect(result).toMatchObject({ ok: true, connectionId: row.id });
    expect(h.rows.size).toBe(1);
    expect(h.secrets.get(row.id)).not.toBe(oldSet);
    expect(h.stats.identityWrites).toBe(0);
    expect(fake.state.codeGrants).toBe(1);
    expect(account.address).toBe(EXEC);
  });

  it("wrong account: signing in as another mailbox is `wrong_account`; the row of the first mailbox is unchanged", async () => {
    const { fake, h } = setup();
    const { row } = h.connect("PKG", EXEC);
    const before = frozen(h);
    const { result } = await h.connectViaCallback("PKG", { address: `y@${DOMAIN}`, userId: HARNESS_OWNER, connectionId: row.id });
    expect(result).toMatchObject({ ok: false, reason: "wrong_account", message: GRANT_NOT_STORED_MESSAGE });
    noWrites(h, before);
    expect(h.rows.size).toBe(1);
    expect(fake.state.codeGrants).toBe(1);
  });

  it("the same address in another tenant (also in the lane's list) is `wrong_account`: the recorded tenant is immutable; nothing changes", async () => {
    const { h } = setup({ microsoft: { tenantIds: [TENANT_A, TENANT_C] } });
    const { row } = h.connect("PKG", EXEC, { tenant: TENANT_A });
    const before = frozen(h);
    const { result } = await h.connectViaCallback("PKG", { address: EXEC, tenant: TENANT_C, userId: HARNESS_OWNER, connectionId: row.id });
    expect(result).toMatchObject({ ok: false, reason: "wrong_account" });
    noWrites(h, before);
    expect(h.identities.get(row.id)).toEqual({ tenantId: TENANT_A, cloud: "commercial" });
  });

  it("a reconnect of a row that is not the user's, another lane's or another provider's is refused at the start", async () => {
    const { h } = setup({}, { APK: { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: [DOMAIN] } });
    const apk = h.connect("APK", `a@${DOMAIN}`);
    await expect(h.flow.start("microsoft", "PKG", h.as(HARNESS_OWNER), { connectionId: apk.row.id })).rejects.toMatchObject({ info: { kind: "not_found" } });
    expect(h.states.size).toBe(0);
  });
});

describe("consent errors (spec §17 test 9, V-7)", () => {
  const back = async (h: Harness, extra: Record<string, string>) => {
    const url = await h.flow.start("microsoft", "PKG", h.as(CONNECT_USER));
    return h.flow.callback("microsoft", new URLSearchParams({ state: new URL(url).searchParams.get("state") ?? "", ...extra }), h.as(CONNECT_USER));
  };
  const consent = ["consent_required", "access_denied|AADSTS65001: x", "access_denied|AADSTS90094: x", "interaction_required|AADSTS65001: x", "interaction_required|AADSTS90094: x"];
  for (const c of consent) {
    it(`error ${c} is admin_consent_required: nothing exchanged, nothing stored, an audit row with the fixed reason`, async () => {
      const { fake, h } = setup();
      const [error, description] = c.split("|");
      const before = frozen(h);
      const result = await back(h, { error: error as string, ...(description ? { error_description: `${description} ${MICROSOFT_ERROR_TEXT_CANARY}` } : {}) });
      expect(result).toEqual({ ok: false, reason: "admin_consent_required", provider: "microsoft", laneId: "PKG" });
      expect(fake.state.tokenRequests).toEqual([]);
      noWrites(h, before);
      expect(h.audits.at(-1)).toMatchObject({ action: "connection.connect.failed", metadata: { reason: "admin_consent_required" } });
      expect(JSON.stringify([result, h.audits, h.logs])).not.toContain(MICROSOFT_ERROR_TEXT_CANARY);
    });
  }
  it("every other error stays `denied`: the user cancelled, other AADSTS codes, other OAuth errors, no error and no code", async () => {
    const { fake, h } = setup();
    const others: Record<string, string>[] = [
      { error: "access_denied" },
      { error: "access_denied", error_description: "AADSTS65004: The user declined to consent" },
      { error: "access_denied", error_description: "AADSTS650010: x" },
      { error: "interaction_required", error_description: "AADSTS53003: Blocked by conditional access" },
      { error: "invalid_request", error_description: "AADSTS90094: x" },
      { error: "server_error" },
      { error: "temporarily_unavailable", error_description: "AADSTS65001" },
      {},
    ];
    for (const extra of others) {
      expect(await back(h, extra), JSON.stringify(extra)).toEqual({ ok: false, reason: "denied", provider: "microsoft", laneId: "PKG" });
    }
    expect(fake.state.tokenRequests).toEqual([]);
    expect(h.stats.stores).toBe(0);
  });
  it("the classifier is a pure function of the OAuth error string first and the AADSTS code only as a refinement", () => {
    const q = (o: Record<string, string>) => microsoftCallbackErrorReason(new URLSearchParams(o));
    expect(q({ error: "consent_required" })).toBe("admin_consent_required");
    expect(q({ error: "access_denied" })).toBeNull();
    expect(q({ error: "access_denied", error_description: "AADSTS90094" })).toBe("admin_consent_required");
    expect(q({ error: "server_error", error_description: "AADSTS90094" })).toBeNull(); // the code alone never decides
    expect(q({ error_description: "AADSTS90094" })).toBeNull();
  });
  it("through the route handler: a fixed redirect to the lane's Settings with the result code, and no provider text", async () => {
    const { h } = setup();
    const handlers = createConnectHandlers(h.flow, async () => h.as(CONNECT_USER));
    const url = await h.flow.start("microsoft", "PKG", h.as(CONNECT_USER));
    const state = new URL(url).searchParams.get("state") ?? "";
    const res = await handlers.callback(new Request(`http://localhost:3000/api/connect/microsoft/callback?${new URLSearchParams({ state, error: "consent_required", error_description: `AADSTS90094 ${MICROSOFT_ERROR_TEXT_CANARY}` })}`), "microsoft");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/PKG/settings?connect=admin_consent_required&provider=microsoft");
  });
});

describe("the routes' handlers", () => {
  it("start: 303 to the lane's Microsoft authorize URL; 403 for a lane where Microsoft is not enabled (no redirect, no state); same-origin only", async () => {
    const on = setup();
    const handlers = createConnectHandlers(on.h.flow, async () => on.h.as(CONNECT_USER));
    const start = (lane: string, origin = "http://localhost:3000") => handlers.start(new Request(`http://localhost:3000/api/connect/microsoft/start?lane=${lane}`, { method: "POST", headers: { origin } }), "microsoft");
    const ok = await start("PKG");
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toMatch(new RegExp(`^https://login\\.microsoftonline\\.com/${TENANT_A}/oauth2/v2\\.0/authorize\\?`));
    expect((await start("PKG", "https://evil.example.test")).status).toBe(403);

    const off = setup({ providers: ["google"], microsoft: null });
    const offHandlers = createConnectHandlers(off.h.flow, async () => off.h.as(CONNECT_USER));
    const res = await offHandlers.start(new Request("http://localhost:3000/api/connect/microsoft/start?lane=PKG", { method: "POST", headers: { origin: "http://localhost:3000" } }), "microsoft");
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    expect(off.h.states.size).toBe(0);
  });
});

describe("granted scopes (V-5)", () => {
  const requested = ["openid", "offline_access", ...READ_SHORT];
  const ok = (scope: string, req: readonly string[] = requested) => expect(() => assertGrantedScopes(scope, req), scope).not.toThrow();
  const bad = (scope: string | undefined, req: readonly string[] = requested) => expect(() => assertGrantedScopes(scope, req), String(scope)).toThrow(ConnectorError);

  it("accepts short names, fully qualified names, any case, tab/newline/multi-space separators, with or without the OpenID extras", () => {
    ok("User.Read Mail.Read Calendars.Read");
    ok("user.read mail.read calendars.read");
    ok(READ_SHORT.map((s) => GRAPH_SCOPE_PREFIX + s).join(" "));
    ok(READ_SHORT.map((s) => GRAPH_SCOPE_PREFIX.toUpperCase() + s.toUpperCase()).join(" "));
    ok("https://graph.microsoft.com/mail.read   User.Read\tcalendars.read\n");
    ok(`openid profile email offline_access ${READ_SHORT.join(" ")}`);
    ok(`${READ_SHORT.join(" ")} https://graph.microsoft.com/User.Read`); // a repeat is harmless
  });
  it("refuses: a missing scope, nothing, a Graph scope that was not requested, another resource, a comma separated list", () => {
    bad("User.Read Mail.Read");
    bad("Mail.Read Calendars.Read");
    bad(undefined);
    bad("");
    bad("openid offline_access");
    bad(`${READ_SHORT.join(" ")} Mail.Send`);
    bad(`${READ_SHORT.join(" ")} ${GRAPH_SCOPE_PREFIX}Mail.ReadWrite`);
    bad(`${READ_SHORT.join(" ")} https://outlook.office.com/Mail.Read`);
    bad(`${READ_SHORT.join(" ")} https://graph.microsoft.com.evil.example.test/Mail.Read`);
    bad(`${READ_SHORT.join(" ")} https://graph.microsoft.com/`);
    bad(READ_SHORT.join(","));
    bad("https://graph.microsoft.us/Mail.Read User.Read Calendars.Read");
  });
  it("write scopes are required exactly when they were requested", () => {
    const withWrites = [...requested, "Mail.ReadWrite", "Mail.Send"];
    ok(`${READ_SHORT.join(" ")} Mail.ReadWrite Mail.Send`, withWrites);
    bad(READ_SHORT.join(" "), withWrites);
    bad(`${READ_SHORT.join(" ")} Mail.Send`, withWrites);
  });
});

describe("provider wiring", () => {
  it("client secret in the body, the registered redirect path, the token host allow-list, and only /me on Graph", async () => {
    const { h } = setup();
    expect(h.oauthProvider.client().tokenAuth).toBe("post");
    expect(h.oauthProvider.slug).toBe("microsoft");
    expect(h.oauthProvider.scopes).toEqual(["openid", "offline_access", "User.Read", "Mail.Read", "Calendars.Read"]);
    expect(() => assertRedirectUri("http://localhost:3000/api/connect/microsoft/callback")).not.toThrow();
    expect(() => assertRedirectUri("https://portal.example.test/api/connect/microsoft/callback")).not.toThrow();
    for (const bad of ["http://localhost:3000/api/connect/google/callback", "http://localhost:3000/", "not a url"]) expect(() => assertRedirectUri(bad), bad).toThrow(ConnectorError);
    // The real (production) token client refuses a host that is not the sign-in host, before anything is sent.
    const { createMicrosoftOAuthProvider } = await import("./provider");
    const p = createMicrosoftOAuthProvider({
      client: () => ({ clientId: "id", clientSecret: new SecretValue("synthetic-secret-0001"), redirectUri: HARNESS_REDIRECT }),
      laneConfig: h.laneConfig,
      identity: { read: async () => ({ tenantId: null, cloud: null }) },
      identityWriter: { setOnce: async () => undefined },
    });
    expect(() => p.tokenHttp?.("PKG", "https://login.microsoftonline.com")).not.toThrow();
    for (const bad of ["https://evil.example.test", "https://login.microsoftonline.com.evil.example.test", "http://login.microsoftonline.com", "https://login.microsoftonline.us", "https://login.microsoftonline.com:8443"]) {
      expect(() => p.tokenHttp?.("PKG", bad), bad).toThrow(ConnectorError);
    }
  });

  it("a lane whose cloud is not served yet (gcc_high) is refused at the start", async () => {
    const { h } = setup({ microsoft: { cloud: "gcc_high", tenantIds: [TENANT_A] } });
    await expect(h.flow.start("microsoft", "PKG", h.as(CONNECT_USER))).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(h.states.size).toBe(0);
  });
});

describe("token canary (rule 4)", () => {
  it("no access token, refresh token, id_token, code, verifier or client secret in the logs, audit rows, results, redirects, the stored set (id_token) or the error log", async () => {
    const { fake, h } = setup({ microsoft: { tenantIds: [TENANT_A, TENANT_C] } });
    const handlers = createConnectHandlers(h.flow, async () => h.as(CONNECT_USER));
    const outputs: unknown[] = [];
    const runs: Awaited<ReturnType<Harness["connectViaCallback"]>>[] = [];
    runs.push(await h.connectViaCallback("PKG", { address: EXEC })); // success
    runs.push(await h.connectViaCallback("PKG", { address: "stranger@elsewhere.example.test" })); // refused after the exchange
    runs.push(await h.connectViaCallback("PKG", { address: `g@${DOMAIN}`, tenant: TENANT_B })); // wrong tenant
    runs.push(await h.connectViaCallback("PKG", { address: `h@${DOMAIN}`, idToken: { aud: "x" } })); // bad id_token
    // Through the route handler too: the redirect is fixed.
    const url = await h.flow.start("microsoft", "PKG", h.as(CONNECT_USER));
    const q = new URL(url).searchParams;
    const acct = fake.addAccount(TENANT_A, `route@${DOMAIN}`);
    fake.grant("synthetic-ms-code-route", { account: acct, codeChallenge: q.get("code_challenge") ?? "", nonce: q.get("nonce") ?? "" });
    const res = await handlers.callback(new Request(`http://localhost:3000/api/connect/microsoft/callback?${new URLSearchParams({ state: q.get("state") ?? "", code: "synthetic-ms-code-route" })}`), "microsoft");
    outputs.push(res.headers.get("location"), [...res.headers.entries()]);
    // A failed exchange at Microsoft (the answer carries error text).
    fake.state.failRefresh = { status: 400, error: "invalid_grant", codes: [70000], times: 1 };
    runs.push(await h.connectViaCallback("PKG", { address: `i@${DOMAIN}`, code: "synthetic-ms-code-fail" }));
    fake.state.failRefresh = null;
    outputs.push(runs.map((r) => [r.result, r.url, r.state]));

    const secrets = new Set<string>([FAKE_GRAPH_CLIENT_SECRET, ...fake.state.idTokens, ...runs.map((r) => r.code), "synthetic-ms-code-route"]);
    for (const a of fake.accounts.values()) {
      for (const t of [...a.accessTokens, ...a.refreshTokens]) secrets.add(t);
    }
    for (const r of fake.state.tokenRequests) {
      if (r.fields.code_verifier) secrets.add(r.fields.code_verifier);
    }
    for (const s of h.states.values()) secrets.add(s.codeVerifier);
    expect(secrets.size).toBeGreaterThan(10);
    const surfaces = JSON.stringify({ outputs, logs: h.logs, audits: h.audits, apiErrors: h.apiErrors, reconnects: h.reconnects });
    for (const secret of secrets) {
      if (secret === "") continue;
      // The code and the state appear in the callback URL the TEST built; they are checked in what the code produced instead.
      if (runs.some((r) => r.code === secret) || secret === "synthetic-ms-code-route") {
        const produced = JSON.stringify({ logs: h.logs, audits: h.audits, results: runs.map((r) => r.result), location: res.headers.get("location") });
        expect(produced).not.toContain(secret);
        continue;
      }
      expect(surfaces, secret.slice(0, 12)).not.toContain(secret);
    }
    // The only place the access and refresh tokens are: the Vault set of the one connected mailbox; the id_token is nowhere.
    const stored = [...h.secrets.values()].join("\n");
    for (const t of fake.state.idTokens) expect(stored).not.toContain(t);
    expect(h.secrets.size).toBe(2); // the first run, and the route run
    // The harness logger redacts registered secrets BEFORE its sink, so a logged token would show as the marker: none may be there.
    expect(h.logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.logs)).not.toContain(REDACTED);
    // The text Microsoft returns in `error_description` (the failed exchange carried it) and `AADSTS` appear nowhere we produce.
    expect(fake.state.tokenRequests.length).toBeGreaterThan(0);
    for (const needle of [MICROSOFT_ERROR_TEXT_CANARY, "AADSTS"]) {
      expect(JSON.stringify({ outputs, logs: h.logs, audits: h.audits, apiErrors: h.apiErrors, reconnects: h.reconnects, location: res.headers.get("location") }), needle).not.toContain(needle);
    }
  });
});

describe("the tenant list is decided at callback time", () => {
  it("[A] at start and [B] at callback with a user of A: wrong_tenant, nothing stored; and [A,B] then [B] the same", async () => {
    for (const [atStart, atCallback] of [[[TENANT_A], [TENANT_B, TENANT_C]], [[TENANT_A, TENANT_B], [TENANT_B]]] as const) {
      const { fake, h } = setup({ microsoft: { tenantIds: [...atStart] } });
      const account = fake.addAccount(TENANT_A, EXEC);
      const url = await h.flow.start("microsoft", "PKG", h.as(CONNECT_USER));
      const q = new URL(url).searchParams;
      fake.grant("code-late", { account, codeChallenge: q.get("code_challenge") ?? "", nonce: q.get("nonce") ?? "", redirectUri: q.get("redirect_uri") ?? "", anyAuthority: true });
      h.setLane("PKG", { microsoft: { tenantIds: [...atCallback] } });
      const before = frozen(h);
      const result = await h.flow.callback("microsoft", new URLSearchParams({ state: q.get("state") ?? "", code: "code-late" }), h.as(CONNECT_USER));
      expect(result, JSON.stringify(atStart)).toMatchObject({ ok: false, reason: "wrong_tenant", message: GRANT_NOT_STORED_MESSAGE });
      noWrites(h, before);
      expect(h.rows.size).toBe(0);
    }
  });
});

describe("a tenant-specific authority", () => {
  it("when the list shrinks to one other tenant, Entra itself refuses a user of tenant A at that authority: exchange_failed, nothing stored", async () => {
    const { fake, h } = setup({ microsoft: { tenantIds: [TENANT_A, TENANT_B] } });
    const account = fake.addAccount(TENANT_A, EXEC);
    const url = await h.flow.start("microsoft", "PKG", h.as(CONNECT_USER));
    const q = new URL(url).searchParams;
    fake.grant("code-auth", { account, codeChallenge: q.get("code_challenge") ?? "", nonce: q.get("nonce") ?? "", redirectUri: q.get("redirect_uri") ?? "" });
    h.setLane("PKG", { microsoft: { tenantIds: [TENANT_B] } });
    const before = frozen(h);
    const result = await h.flow.callback("microsoft", new URLSearchParams({ state: q.get("state") ?? "", code: "code-auth" }), h.as(CONNECT_USER));
    expect(result).toMatchObject({ ok: false, reason: "exchange_failed" });
    expect(fake.state.tokenRequests[0]?.tenant).toBe(TENANT_B);
    noWrites(h, before);
  });
});

describe("the leftover pending row (the tenant is recorded before the token is stored)", () => {
  const leftover = (h: Harness) => {
    const rows = [...h.rows.values()];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("no row");
    expect(row.status).toBe("pending");
    expect(h.secrets.has(row.id)).toBe(false);
    return row;
  };

  it("a Vault outage at the token store leaves a pending row with its tenant and no secret; the user sees the not-stored message", async () => {
    const { fake, h } = setup({ microsoft: { tenantIds: [TENANT_A, TENANT_C] } });
    // The Vault write at the end of the connect fails once.
    h.failStoreOnce(new ConnectorError({ kind: "transient", message: "Token store unavailable" }));
    const { result } = await h.connectViaCallback("PKG", { address: EXEC });
    expect(result).toMatchObject({ ok: false, reason: "unavailable", message: GRANT_NOT_STORED_MESSAGE });
    const row = leftover(h);
    expect(h.identities.get(row.id)).toEqual({ tenantId: TENANT_A, cloud: "commercial" });
    expect(h.stats.stores).toBe(0);
    // The same mailbox in the same tenant reuses the row and succeeds; the identity is not written again.
    const writes = h.stats.identityWrites;
    expect((await h.connectViaCallback("PKG", { address: EXEC })).result).toMatchObject({ ok: true, connectionId: row.id });
    expect(h.rows.size).toBe(1);
    expect(h.rows.get(row.id)?.status).toBe("active");
    expect(h.stats.identityWrites).toBe(writes);
    expect(fake.state.codeGrants).toBe(2);
  });

  it("a D-23 refusal leaves a pending row with its tenant; the same mailbox from another listed tenant is wrong_account and changes nothing", async () => {
    const other: LaneSetup = { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A, TENANT_C] }, domains: [DOMAIN] };
    const { h } = setup({ microsoft: { tenantIds: [TENANT_A, TENANT_C] } }, { APK: other });
    expect((await h.connectViaCallback("APK", { address: EXEC })).result.ok).toBe(true);
    const { result } = await h.connectViaCallback("PKG", { address: EXEC });
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(message(result)).toMatch(/already connected to another company/);
    const pkg = [...h.rows.values()].filter((r) => r.lane_id === "PKG");
    expect(pkg).toHaveLength(1);
    const row = pkg[0];
    if (!row) throw new Error("no row");
    expect(row.status).toBe("pending");
    expect(h.secrets.has(row.id)).toBe(false);
    expect(h.identities.get(row.id)).toEqual({ tenantId: TENANT_A, cloud: "commercial" });
    const before = frozen(h);
    expect((await h.connectViaCallback("PKG", { address: EXEC, tenant: TENANT_C })).result).toMatchObject({ ok: false, reason: "wrong_account" });
    noWrites(h, before);
  });
});

describe("the fake's exact redirect_uri match and the OpenID scopes in the answer", () => {
  it("a token request whose redirect_uri differs from the authorize request's is refused by the fake: exchange_failed, nothing stored", async () => {
    const { h } = setup();
    const before = frozen(h);
    const { result } = await h.connectViaCallback("PKG", { address: EXEC, redirectUri: "http://localhost:3000/api/connect/microsoft/other" });
    expect(result).toMatchObject({ ok: false, reason: "exchange_failed" });
    noWrites(h, before);
  });
  it("a connect whose scope also lists `openid offline_access profile` succeeds", async () => {
    const { h } = setup();
    expect((await h.connectViaCallback("PKG", { address: EXEC, oidcScopes: true })).result.ok).toBe(true);
  });
});
