// Google connect flow (T-063) on the T-035 framework, against the fake Google: authorization code + PKCE with offline
// access, the three read-only scopes verified on the callback (a write scope or a missing one refuses), the verified
// primary address from Gmail's profile checked against the lane's mailboxes (fail closed), state bound to lane and
// user, cross-lane refusal, and tokens entering the Vault only from the callback. Mocks only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { RateLimiter } from "../http/rate-limit";
import { createGoogleHarness } from "../testing/google-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeGoogle, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, READ_SCOPES } from "../testing/msw/google/handlers";
import { SecretValue } from "../vault/secret";
import { CALENDAR_READONLY, DRIVE_READONLY, GMAIL_READONLY, GOOGLE_SCOPES } from "./constants";
import { assertGrantedScopes, assertRedirectUri, createGoogleOAuthProvider } from "./provider";

const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
});

const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const REDIRECT = "http://localhost:3000/api/connect/google/callback";
const EXEC = "exec@pubkgroup.example.test";
const EXEC_ORG = "exec@pub-k.example.test";

function setup(mailboxes: Record<string, string[]> = { PKG: [EXEC, EXEC_ORG], APK: ["apk@apk.example.test"] }) {
  const fake = createFakeGoogle();
  server.use(...fake.handlers);
  return { fake, h: createGoogleHarness({ fake, mailboxes }) };
}
const query = (url: string, extra: Record<string, string>) => new URLSearchParams({ state: new URL(url).searchParams.get("state") ?? "", ...extra });

describe("start", () => {
  it("builds the consent URL: code + PKCE, offline access, consent prompt, no merged scopes, exactly the three read-only scopes", async () => {
    const { h } = setup();
    const url = new URL(await h.flow.start("google", "PKG", h.as(ADMIN)));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = Object.fromEntries(url.searchParams);
    expect(p).toMatchObject({
      response_type: "code",
      client_id: FAKE_CLIENT_ID,
      redirect_uri: REDIRECT,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      code_challenge_method: "S256",
    });
    expect(p.scope?.split(" ")).toEqual([GMAIL_READONLY, CALENDAR_READONLY, DRIVE_READONLY]);
    expect(p.scope).not.toMatch(/openid|email|profile|\.modify|\.send|\.compose|\.full|mail\.google\.com|auth\/drive(?!\.readonly)|auth\/calendar(?!\.readonly)/);
    expect(p.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.state).toMatch(/^PKG\.[A-Za-z0-9_-]{43}$/);
    expect(h.audits.map((a) => a.action)).toEqual(["connection.connect_started"]);
    expect(h.secrets.size).toBe(0);
  });

  it("refuses a redirect URI that is not this app's Google callback", () => {
    expect(() => assertRedirectUri(REDIRECT)).not.toThrow();
    expect(() => assertRedirectUri("https://portal.example.test/api/connect/google/callback")).not.toThrow();
    for (const bad of ["http://localhost:3000/api/connect/qbo/callback", "http://localhost:3000/", "not a url"]) {
      expect(() => assertRedirectUri(bad), bad).toThrow(ConnectorError);
    }
  });
});

describe("callback", () => {
  it("exchanges the code with the client secret in the body and PKCE, stores the token set only now, and sets external_account_id to the verified mailbox", async () => {
    const { fake, h } = setup();
    const { result } = await h.connectViaCallback("PKG", { email: EXEC });
    expect(result).toMatchObject({ ok: true, provider: "google", laneId: "PKG" });
    const req = fake.state.tokenRequests[0];
    expect(req?.grant_type).toBe("authorization_code");
    expect(req?.fields.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(req?.fields.redirect_uri).toBe(REDIRECT);
    expect(req?.fields.client_secret).toBe(FAKE_CLIENT_SECRET);
    const row = [...h.rows.values()][0];
    expect(row).toMatchObject({ lane_id: "PKG", provider: "google", external_account_id: EXEC, status: "active", token_expires_at: null });
    const stored = h.storedSet(row?.id ?? "");
    expect(stored).toMatchObject({ scope: READ_SCOPES.join(" ") });
    expect(typeof stored?.refresh_token).toBe("string");
    expect(h.audits.map((a) => a.action)).toEqual(["connection.connect_started", "connection.connect.requested", "connection.connect.succeeded"]);
    expect(JSON.stringify(h.audits)).not.toContain(String(stored?.refresh_token));
  });

  it("takes the account from Gmail's profile in the access token's own mailbox, and lower-cases it", async () => {
    const { h } = setup({ PKG: ["Exec@PubKGroup.example.test"] });
    const { result } = await h.connectViaCallback("PKG", { email: "exec@pubkgroup.example.test" });
    expect(result.ok).toBe(true);
    expect([...h.rows.values()][0]?.external_account_id).toBe("exec@pubkgroup.example.test");
  });

  it("accepts every address on the lane's mailbox list (both Workspace domains), nothing hard-coded", async () => {
    const { h } = setup();
    expect((await h.connectViaCallback("PKG", { email: EXEC })).result.ok).toBe(true);
    expect((await h.connectViaCallback("PKG", { email: EXEC_ORG })).result.ok).toBe(true);
  });

  it("refuses a mailbox that is not on the lane's list, storing nothing, and says to remove the app's access", async () => {
    const { h } = setup();
    const { result } = await h.connectViaCallback("PKG", { email: "stranger@elsewhere.example.test" });
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(result.ok ? "" : result.message).toMatch(/remove its access/i);
    expect(h.secrets.size).toBe(0);
    expect([...h.rows.values()]).toEqual([]);
    expect(h.audits.map((a) => a.action)).toContain("connection.connect.grant_not_stored");
  });

  it("fails closed when the lane has no mailboxes configured: no code is exchanged at all", async () => {
    const { fake, h } = setup({ PKG: [] });
    const { result } = await h.connectViaCallback("PKG", { email: EXEC });
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(fake.state.tokenRequests).toEqual([]);
    expect(h.secrets.size).toBe(0);
  });

  it("cross-lane: another lane's mailbox cannot be connected to this lane, and the other lane can connect it", async () => {
    const { h } = setup();
    expect((await h.connectViaCallback("PKG", { email: "apk@apk.example.test" })).result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(h.rows.size).toBe(0);
    const apk = await h.connectViaCallback("APK", { email: "apk@apk.example.test" });
    expect(apk.result).toMatchObject({ ok: true, laneId: "APK" });
    // D-23: once connected in APK the account cannot also be connected in PKG, even if PKG listed it.
    h.mailboxes.PKG = [EXEC, "apk@apk.example.test"];
    expect((await h.connectViaCallback("PKG", { email: "apk@apk.example.test" })).result).toMatchObject({ ok: false, reason: "account_refused" });
    expect([...h.rows.values()].filter((r) => r.lane_id === "PKG" && r.status === "active")).toEqual([]);
  });

  it("refuses a grant with a write scope, even alongside the read-only ones", async () => {
    const { h } = setup();
    for (const extra of ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send", "https://mail.google.com/", "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/drive"]) {
      const { result } = await h.connectViaCallback("PKG", { email: EXEC, scopes: [...READ_SCOPES, extra] });
      expect(result, extra).toMatchObject({ ok: false });
      expect(h.secrets.size).toBe(0);
    }
  });

  it("refuses a grant that misses a required scope (the user unticked one), and one with no scope field", async () => {
    const { fake, h } = setup();
    for (const missing of READ_SCOPES) {
      const { result } = await h.connectViaCallback("PKG", { email: EXEC, scopes: READ_SCOPES.filter((s) => s !== missing) });
      expect(result, missing).toMatchObject({ ok: false, reason: "account_refused" });
    }
    fake.state.scopeOverride = "";
    expect((await h.connectViaCallback("PKG", { email: EXEC })).result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(h.secrets.size).toBe(0);
  });

  it("refuses a grant without a refresh token (cannot stay connected)", async () => {
    const { h } = setup();
    expect((await h.connectViaCallback("PKG", { email: EXEC, refresh: false })).result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(h.secrets.size).toBe(0);
  });

  it("assertGrantedScopes: exact set, OpenID extras tolerated, anything else refused", () => {
    expect(() => assertGrantedScopes(GOOGLE_SCOPES.join(" "))).not.toThrow();
    expect(() => assertGrantedScopes(`openid email ${GOOGLE_SCOPES.join(" ")}`)).not.toThrow();
    expect(() => assertGrantedScopes(undefined)).toThrow(ConnectorError);
    expect(() => assertGrantedScopes(`${GMAIL_READONLY} ${CALENDAR_READONLY}`)).toThrow(ConnectorError);
    expect(() => assertGrantedScopes(`${GOOGLE_SCOPES.join(" ")} https://www.googleapis.com/auth/gmail.compose`)).toThrow(ConnectorError);
  });

  it("is single use and bound to the lane and the user that started it (CSRF)", async () => {
    const { fake, h } = setup();
    fake.grant("code-a", { email: EXEC, scopes: READ_SCOPES, refresh: true });
    const url = await h.flow.start("google", "PKG", h.as(ADMIN));
    expect(await h.flow.callback("google", query(url, { code: "code-a" }), h.as(OTHER))).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(fake.state.tokenRequests).toEqual([]); // another user's attempt exchanged nothing
    expect(await h.flow.callback("google", query(url, { code: "code-a" }), h.as(ADMIN))).toMatchObject({ ok: true }); // the owner of the state can still finish
    fake.grant("code-a", { email: EXEC, scopes: READ_SCOPES, refresh: true });
    expect(await h.flow.callback("google", query(url, { code: "code-a" }), h.as(ADMIN))).toMatchObject({ ok: false, reason: "invalid_state" }); // replay
    const url2 = await h.flow.start("google", "PKG", h.as(ADMIN));
    const swapped = query(url2, { code: "code-a" }).toString().replace("PKG.", "APK.");
    expect(await h.flow.callback("google", new URLSearchParams(swapped), h.as(ADMIN))).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(await h.flow.callback("google", new URLSearchParams({ code: "code-a", state: "garbage" }), h.as(ADMIN))).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(fake.state.tokenRequests).toHaveLength(1); // only the one legitimate exchange
  });

  it("a consent screen the user cancelled exchanges nothing", async () => {
    const { fake, h } = setup();
    const url = await h.flow.start("google", "PKG", h.as(ADMIN));
    expect(await h.flow.callback("google", query(url, { error: "access_denied" }), h.as(ADMIN))).toMatchObject({ ok: false, reason: "denied" });
    expect(fake.state.tokenRequests).toEqual([]);
  });

  it("a code Google rejects is exchange_failed and stores nothing", async () => {
    const { h } = setup();
    const url = await h.flow.start("google", "PKG", h.as(ADMIN));
    expect(await h.flow.callback("google", query(url, { code: "never-granted" }), h.as(ADMIN))).toMatchObject({ ok: false, reason: "exchange_failed" });
    expect(h.secrets.size).toBe(0);
  });

  it("never logs a token or the client secret", async () => {
    const { h } = setup();
    await h.connectViaCallback("PKG", { email: EXEC });
    const stored = h.storedSet([...h.rows.keys()][0] ?? "");
    const text = JSON.stringify([h.logs, h.audits]);
    for (const secret of [FAKE_CLIENT_SECRET, String(stored?.access_token), String(stored?.refresh_token)]) expect(text).not.toContain(secret);
  });
});

describe("provider wiring", () => {
  it("only Gmail's host is called for the profile, and the endpoints are Google's", async () => {
    const p = createGoogleOAuthProvider({ client: () => ({ clientId: "id", clientSecret: new SecretValue("synthetic-secret-0001"), redirectUri: REDIRECT }), laneConfig: { mailboxes: async () => [EXEC] } });
    expect(await p.endpoints("PKG")).toEqual({ authorization: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token" });
    expect(p.client().tokenAuth).toBe("post");
    expect(p.scopes).toEqual(GOOGLE_SCOPES);
  });
});
