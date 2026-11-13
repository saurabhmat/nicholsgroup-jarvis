// T-238 part C: reconnect a Google connection. The start binds the connection id into the state; the callback accepts only that
// connection's account, replaces its tokens, and never creates a second row. In-memory twins of the state store and the connection store.
import type { Audit } from "@nichols/core/audit";
import { AuthError } from "@nichols/core/auth";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import { createConnectorLogger } from "../log/index";
import { RateLimiter } from "../http/rate-limit";
import { createHttpClient } from "../http/client";
import { http, HttpResponse, useMockServer } from "../testing/msw/index";
import { forgetSecretsForTests, SecretValue } from "../vault/secret";
import { createOAuthFlow, type OAuthProvider } from "./flow";
import { createConnectHandlers } from "./handlers";
import { connectionOfState, hashState, laneOfState, newState } from "./pkce";
import type { StateStore } from "./state";

const OAUTH = "https://oauth.mock.test";
const REDIRECT = "http://localhost:3000/api/connect/google/callback";
const ORIGIN = "https://portal.example.test";
const USER = "00000000-0000-4000-8000-0000000000a1";
const ROW_A = "00000000-0000-4000-8000-0000000000c1";
const ROW_B = "00000000-0000-4000-8000-0000000000c2";
const FOREIGN = "00000000-0000-4000-8000-0000000000f1"; // a connection of another lane
const server = useMockServer();

type Row = { id: string; lane: string; provider: string; account: string; status: string; token: string | null };

function setup(rows: Row[], chosenAccount = { current: "ann@pubk.test" }) {
  const states = new Map<string, { laneId: string; provider: string; verifier: string; redirectUri: string }>();
  const stateStore: StateStore = {
    async create(_c, laneId, provider, hash, verifier, redirectUri) {
      states.set(hash, { laneId, provider, verifier, redirectUri });
    },
    async consume(_c, laneId, hash) {
      const s = states.get(hash);
      if (!s || s.laneId !== laneId) return null;
      states.delete(hash);
      return { provider: s.provider, codeVerifier: s.verifier, redirectUri: s.redirectUri };
    },
  };
  const ensured: string[] = [];
  const asLane = (r: Row): LaneBoundConnection =>
    mintLaneBoundConnection({ id: r.id, lane_id: r.lane, provider: r.provider, external_account_id: r.account, status: r.status as "active", features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null }) as LaneBoundConnection;
  const provider: OAuthProvider = {
    provider: "google",
    slug: "google",
    scopes: ["scope-a"],
    endpoints: async () => ({ authorization: `${OAUTH}/authorize`, token: `${OAUTH}/token` }),
    client: () => ({ clientId: "synthetic-client-id", clientSecret: new SecretValue("synthetic-client-secret"), redirectUri: REDIRECT, tokenAuth: "post" }),
    identify: async () => ({ externalAccountId: chosenAccount.current, expiresAt: null }),
  };
  const audits: string[] = [];
  const audit: Audit = { async log(e) { audits.push(`${e.action}:${e.target ?? ""}`); } };
  const flow = createOAuthFlow({
    providers: [provider],
    states: stateStore,
    connections: {
      async findById(laneId, prov, id) {
        const r = rows.find((x) => x.id === id && x.lane === laneId && x.provider === prov);
        return r ? { id: r.id, externalAccountId: r.account, status: r.status } : null;
      },
      async ensureConnection(laneId, prov, account) {
        ensured.push(account);
        let r = rows.find((x) => x.lane === laneId && x.provider === prov && x.account === account);
        if (!r) {
          r = { id: `00000000-0000-4000-8000-00000000099${String(rows.length)}`, lane: laneId, provider: prov, account, status: "pending", token: null };
          rows.push(r);
        }
        return asLane(r);
      },
    },
    async storeToken(laneId, conn, secret) {
      const r = rows.find((x) => x.id === conn.id && x.lane === laneId);
      if (!r) throw new Error("no row");
      r.token = secret.reveal();
      r.status = "active";
    },
    audit,
    logger: createConnectorLogger({ sink: () => undefined }),
    httpFor: (p, laneId, baseUrl) => createHttpClient({ provider: p.provider, laneId, baseUrl }),
  });
  const as = async () => ({ userId: USER, client: {} as never });
  return { flow, states, rows, ensured, audits, as, handlers: createConnectHandlers(flow, async () => as as never) };
}

const tokenEndpoint = (access: string) =>
  server.use(http.post(`${OAUTH}/token`, () => HttpResponse.json({ access_token: access, refresh_token: `${access}-refresh`, token_type: "bearer", expires_in: 3600 })));
const back = (url: string) => new URLSearchParams({ state: new URL(url).searchParams.get("state") ?? "", code: "synthetic-code" });
const rowsOf = (): Row[] => [
  { id: ROW_A, lane: "PKG", provider: "google", account: "ann@pubk.test", status: "reconnect_required", token: "old-token-a" },
  { id: ROW_B, lane: "PKG", provider: "google", account: "bob@pubk.test", status: "active", token: "token-b" },
];

afterEach(() => {
  forgetSecretsForTests();
  RateLimiter.resetForTests();
});

describe("state binding (pkce)", () => {
  it("carries the connection id as a third part, parsed back; an ordinary state has none; junk is refused", () => {
    const s = newState("PKG", undefined, ROW_A);
    expect(s).toMatch(/^PKG\.[A-Za-z0-9_-]{43}\.[0-9a-f-]{36}$/);
    expect(laneOfState(s)).toBe("PKG");
    expect(connectionOfState(s)).toBe(ROW_A);
    expect(connectionOfState(newState("PKG"))).toBeNull();
    expect(() => newState("PKG", undefined, "not-a-uuid")).toThrow();
    expect(connectionOfState(`PKG.${"a".repeat(43)}.${ROW_A}.extra`)).toBeNull();
    expect(laneOfState(`PKG.${"a".repeat(43)}.${ROW_A}.extra`)).toBeNull();
    expect(connectionOfState(undefined)).toBeNull();
  });
});

describe("start (reconnect)", () => {
  it("binds the connection into the stored state and gives Google the stored address as a login hint only", async () => {
    const t = setup(rowsOf());
    const url = new URL(await t.flow.start("google", "PKG", t.as, { connectionId: ROW_A }));
    const state = url.searchParams.get("state") as string;
    expect(connectionOfState(state)).toBe(ROW_A);
    expect(url.searchParams.get("login_hint")).toBe("ann@pubk.test");
    expect([...t.states.keys()]).toEqual([hashState(state)]);
    expect(t.audits).toContain(`connection.reconnect_started:connection:${ROW_A}`);
    // an ordinary connect has neither
    const plain = new URL(await t.flow.start("google", "PKG", t.as));
    expect(connectionOfState(plain.searchParams.get("state"))).toBeNull();
    expect(plain.searchParams.has("login_hint")).toBe(false);
  });

  it("a connection that is not this lane's (foreign, unknown, another provider) is refused as not_found with nothing stored", async () => {
    const rows = [...rowsOf(), { id: FOREIGN, lane: "APK", provider: "google", account: "zed@apk.test", status: "active", token: "t" }, { id: "00000000-0000-4000-8000-0000000000d1", lane: "PKG", provider: "quickbooks", account: "realm", status: "active", token: "t" }];
    const t = setup(rows);
    for (const id of [FOREIGN, "00000000-0000-4000-8000-0000000000d9", "00000000-0000-4000-8000-0000000000d1"]) {
      await expect(t.flow.start("google", "PKG", t.as, { connectionId: id })).rejects.toMatchObject({ info: { kind: "not_found" } });
    }
    expect(t.states.size).toBe(0);
  });

  it("role gating stays with authorize: a user who may not connect gets the AuthError and nothing is stored", async () => {
    const t = setup(rowsOf());
    await expect(t.flow.start("google", "PKG", async () => { throw new AuthError("forbidden"); }, { connectionId: ROW_A })).rejects.toBeInstanceOf(AuthError);
    expect(t.states.size).toBe(0);
  });

  it("the route: a connection that is not a UUID is 404; another lane's id is 404; a good one is 303", async () => {
    const t = setup([...rowsOf(), { id: FOREIGN, lane: "APK", provider: "google", account: "zed@apk.test", status: "active", token: "t" }]);
    const post = (connection: string) => t.handlers.start(new Request(`${ORIGIN}/api/connect/google/start?lane=PKG&connection=${connection}`, { method: "POST", headers: { origin: ORIGIN } }), "google");
    expect((await post("not-a-uuid")).status).toBe(404);
    expect((await post(FOREIGN)).status).toBe(404);
    const ok = await post(ROW_A);
    expect(ok.status).toBe(303);
    expect(new URL(ok.headers.get("location") as string).searchParams.get("login_hint")).toBe("ann@pubk.test");
    expect(t.states.size).toBe(1);
  });
});

describe("callback (reconnect)", () => {
  it.each(["reconnect_required", "disconnected", "degraded"])("the same account after %s: tokens replaced, the status is active again, and there is still ONE row", async (status) => {
    tokenEndpoint("new-token");
    const rows = rowsOf();
    (rows[0] as Row).status = status;
    const t = setup(rows);
    const url = await t.flow.start("google", "PKG", t.as, { connectionId: ROW_A });
    const res = await t.flow.callback("google", back(url), t.as);
    expect(res).toMatchObject({ ok: true, connectionId: ROW_A });
    expect(t.rows).toHaveLength(2);
    expect(t.rows.filter((r) => r.account === "ann@pubk.test")).toHaveLength(1);
    expect(JSON.parse((t.rows[0] as Row).token as string)).toMatchObject({ access_token: "new-token" });
    expect((t.rows[0] as Row).status).toBe("active");
    expect(t.rows[1]).toMatchObject({ id: ROW_B, token: "token-b" }); // the other mailbox is untouched
    expect(t.ensured).toEqual(["ann@pubk.test"]);
  });

  it("the same account in another letter case is the same row, stored with its own spelling", async () => {
    tokenEndpoint("new-token");
    const t = setup(rowsOf(), { current: "ANN@pubk.test" });
    const url = await t.flow.start("google", "PKG", t.as, { connectionId: ROW_A });
    await expect(t.flow.callback("google", back(url), t.as)).resolves.toMatchObject({ ok: true, connectionId: ROW_A });
    expect(t.ensured).toEqual(["ann@pubk.test"]);
    expect(t.rows).toHaveLength(2);
  });

  it("a DIFFERENT Google account is refused (wrong_account): no row, no token, the connection is unchanged", async () => {
    tokenEndpoint("new-token");
    const t = setup(rowsOf(), { current: "bob@pubk.test" }); // Google comes back with Bob while Ann's row is being reconnected
    const before = JSON.stringify(t.rows);
    const url = await t.flow.start("google", "PKG", t.as, { connectionId: ROW_A });
    const res = await t.flow.callback("google", back(url), t.as);
    expect(res).toMatchObject({ ok: false, reason: "wrong_account", laneId: "PKG" });
    expect(res.ok ? "" : res.message).toMatch(/Nothing was connected and no access was stored/);
    expect(JSON.stringify(t.rows)).toBe(before);
    expect(t.ensured).toEqual([]);
    // a brand-new account is refused the same way
    const t2 = setup(rowsOf(), { current: "new@pubk.test" });
    const url2 = await t2.flow.start("google", "PKG", t2.as, { connectionId: ROW_A });
    await expect(t2.flow.callback("google", back(url2), t2.as)).resolves.toMatchObject({ ok: false, reason: "wrong_account" });
    expect(t2.rows).toHaveLength(2);
    expect(t2.ensured).toEqual([]);
  });

  it("the route redirects a wrong account with a coarse code and the remove-access notice", async () => {
    tokenEndpoint("new-token");
    const t = setup(rowsOf(), { current: "bob@pubk.test" });
    const start = await t.handlers.start(new Request(`${ORIGIN}/api/connect/google/start?lane=PKG&connection=${ROW_A}`, { method: "POST", headers: { origin: ORIGIN } }), "google");
    const res = await t.handlers.callback(new Request(`${ORIGIN}/api/connect/google/callback?${back(start.headers.get("location") as string)}`), "google");
    expect(res.headers.get("location")).toBe("/PKG/settings?connect=wrong_account&provider=google&notice=remove_app_access");
  });

  it("a tampered state (another connection id appended or swapped) is a state nobody started: invalid_state, nothing written", async () => {
    tokenEndpoint("new-token");
    const t = setup(rowsOf());
    const url = await t.flow.start("google", "PKG", t.as, { connectionId: ROW_A });
    const state = new URL(url).searchParams.get("state") as string;
    const swapped = state.replace(ROW_A, ROW_B);
    const res = await t.flow.callback("google", new URLSearchParams({ state: swapped, code: "c" }), t.as);
    expect(res).toMatchObject({ ok: false, reason: "invalid_state" });
    const stripped = state.slice(0, state.lastIndexOf("."));
    await expect(t.flow.callback("google", new URLSearchParams({ state: stripped, code: "c" }), t.as)).resolves.toMatchObject({ ok: false, reason: "invalid_state" });
    expect(t.rows.map((r) => r.token)).toEqual(["old-token-a", "token-b"]);
  });

  it("a connection that vanished (or moved lane) between start and callback is refused, nothing written", async () => {
    tokenEndpoint("new-token");
    const t = setup(rowsOf());
    const url = await t.flow.start("google", "PKG", t.as, { connectionId: ROW_A });
    t.rows.shift();
    await expect(t.flow.callback("google", back(url), t.as)).resolves.toMatchObject({ ok: false, reason: "account_refused" });
    expect(t.rows).toHaveLength(1);
    expect(t.ensured).toEqual([]);
  });

  it("an ordinary connect (no connection id) still reuses the row of the same account and creates a new row for a new one", async () => {
    tokenEndpoint("new-token");
    const t = setup(rowsOf(), { current: "bob@pubk.test" });
    await t.flow.callback("google", back(await t.flow.start("google", "PKG", t.as)), t.as);
    expect(t.rows).toHaveLength(2);
    t.rows.length = 2;
    const t3 = setup(rowsOf(), { current: "carol@pubk.test" });
    await t3.flow.callback("google", back(await t3.flow.start("google", "PKG", t3.as)), t3.as);
    expect(t3.rows).toHaveLength(3);
  });
});

describe("ConnectorError for the route", () => {
  it("not_found maps to a 404 (not a 503)", async () => {
    const t = setup(rowsOf());
    const res = await t.handlers.start(new Request(`${ORIGIN}/api/connect/google/start?lane=PKG&connection=${FOREIGN}`, { method: "POST", headers: { origin: ORIGIN } }), "google");
    expect(res.status).toBe(404);
    expect(new ConnectorError({ kind: "not_found", message: "x" }).info.kind).toBe("not_found");
  });
});
