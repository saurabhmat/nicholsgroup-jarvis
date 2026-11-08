// T-219: the Composio connect flow and the Test check with in-memory fakes (no network, no database; rule 10).
// Covered: start (role by the caller, not configured, mailbox list required, link bound to user + lane + toolkit,
// consent host allow-list, audit), callback (state single use + binding, forged account id, denied, not ACTIVE, wrong
// toolkit, identity not in lane_config.mailboxes fail closed, address in use by another lane, success), the message
// that the Composio account must be removed by hand after a refusal, and the Test check (health mapping, mailbox
// re-check, read-only allow-listed calls only, no content returned).
import type { Audit, AuditEntry } from "@nichols/core/audit";
import { describe, expect, it } from "vitest";
import { ACCOUNT_IN_USE_MESSAGE, ConnectorError } from "../contract/errors";
import { createConnectorLogger } from "../log/index";
import type { StateStore, StoredState } from "../oauth/state";
import { createComposioCheck } from "./check";
import { createComposioConnect, COMPOSIO_GRANT_NOT_STORED_MESSAGE } from "./connect";
import { guardComposio, type ComposioAccount, type ComposioPort } from "./port";
import type { ComposioConnection, ComposioConnectionStore } from "./store";

const USER = "11111111-1111-4111-8111-111111111111";
const LANE = "PKG";
const BOSS = "boss@pkg.example.test";

function harness(opts: { mailboxes?: string[]; authConfig?: string | null } = {}) {
  const calls: string[] = [];
  const accounts = new Map<string, ComposioAccount>();
  const tools = new Map<string, { successful: boolean; data: Record<string, unknown> }>();
  let redirectUrl = "https://connect.composio.dev/link/lk1";
  let linkCount = 0;
  const notMine = new Set<string>();
  const flags = { getAccountError: null as ConnectorError | null };
  const seen: { callbackUrl: string } = { callbackUrl: "" };
  const port: ComposioPort = {
    async link(input) {
      calls.push(`link ${input.userId} ${input.authConfigId}`);
      seen.callbackUrl = input.callbackUrl;
      linkCount += 1;
      return { accountId: `ca_${String(linkCount)}`, redirectUrl };
    },
    async listAccountIds({ authConfigId }) {
      calls.push(`list ${authConfigId}`);
      return [...accounts.values()].filter((a) => !notMine.has(a.id) && a.authConfigId === authConfigId).map((a) => a.id);
    },
    async getAccount(id) {
      calls.push(`get ${id}`);
      if (flags.getAccountError) throw flags.getAccountError;
      const a = accounts.get(id);
      if (!a) throw new ConnectorError({ kind: "not_found", message: "x" });
      return a;
    },
    async execute(i) {
      calls.push(`execute ${i.slug}`);
      const r = tools.get(i.slug);
      if (!r) throw new ConnectorError({ kind: "not_found", message: "x" });
      return r;
    },
  };
  const states = new Map<string, StoredState & { lane: string; user: string }>();
  const stateStore: StateStore = {
    async create(_client, laneId, provider, hash, verifier, redirectUri) {
      calls.push("state");
      states.set(hash, { provider, codeVerifier: verifier, redirectUri, toolkit: null, accountRef: null, lane: laneId, user: USER });
    },
    async consume(_client, laneId, hash) {
      const s = states.get(hash);
      states.delete(hash);
      return s && s.lane === laneId ? s : null;
    },
  };
  const rows = new Map<string, ComposioConnection>();
  const otherLaneIdentities = new Set<string>();
  const connections: ComposioConnectionStore = {
    async ensurePending(laneId, toolkit, accountId, createdBy) {
      const found = [...rows.values()].find((r) => r.accountId === accountId && r.laneId === laneId);
      if (found) return found;
      const row: ComposioConnection = { id: `00000000-0000-4000-8000-00000000000${String(rows.size + 1)}`, laneId, toolkit, accountId, identity: null, status: "pending", createdBy, lastSyncAt: null };
      rows.set(row.id, row);
      return row;
    },
    async bindState(_laneId, _userId, hash, toolkit, accountId) {
      const st = states.get(hash);
      if (!st || st.toolkit) throw new ConnectorError({ kind: "transient", message: "x" });
      st.toolkit = toolkit;
      st.accountRef = accountId;
    },
    async discardPending(_laneId, id) {
      calls.push("discard");
      if (rows.get(id)?.status === "pending") rows.delete(id);
    },
    async activate(laneId, id, identity) {
      if (otherLaneIdentities.has(identity)) throw new ConnectorError({ kind: "forbidden", message: ACCOUNT_IN_USE_MESSAGE });
      const r = rows.get(id);
      if (!r || r.laneId !== laneId) throw new ConnectorError({ kind: "not_found", message: "x" });
      for (const o of rows.values()) if (o.laneId === laneId && o.toolkit === r.toolkit && o.id !== id && o.status !== "pending") rows.set(o.id, { ...o, status: "disconnected" });
      rows.set(id, { ...r, status: "active", identity });
    },
    async find(laneId, toolkit) {
      return [...rows.values()].reverse().find((r) => r.laneId === laneId && r.toolkit === toolkit && r.status !== "disconnected") ?? null;
    },
    async setHealth(_laneId, conn, to) {
      calls.push(`health ${to}`);
      rows.set(conn.id, { ...conn, status: to });
      return true;
    },
  };
  const audits: AuditEntry[] = [];
  const audit: Audit = { async log(e) { audits.push(e); } };
  const laneMailboxes = opts.mailboxes ?? [BOSS];
  const laneConfig = { async mailboxes() { return laneMailboxes; } };
  const composio = guardComposio(port);
  const authorize = async (laneId: string) => ({ userId: USER, client: { laneId } as never });
  const flow = createComposioConnect({
    composio,
    states: stateStore,
    connections,
    laneConfig,
    authConfigId: (t) => (opts.authConfig === null ? null : t === "gmail" ? "ac_gmail_synthetic" : "ac_cal_synthetic"),
    appOrigin: () => "https://app.example.test",
    audit,
    logger: createConnectorLogger({ sink: () => undefined }),
  });
  const check = createComposioCheck({ composio, connections, laneConfig, now: () => Date.UTC(2026, 10, 8, 12) });
  return { notMine, flags, seen, flow, check, calls, accounts, tools, states, rows, audits, authorize, otherLaneIdentities, setRedirect: (u: string) => (redirectUrl = u) };
}


/** Runs start and returns what Composio's redirect to our callback would carry. */
async function started(h: ReturnType<typeof harness>, toolkit = "gmail") {
  const location = await h.flow.start(toolkit, LANE, h.authorize);
  const state = new URL(h.seen.callbackUrl).searchParams.get("state") ?? "";
  const accountId = `ca_${String(h.calls.filter((c) => c.startsWith("link")).length)}`;
  return { location, state, accountId, query: (extra: Record<string, string> = {}) => new URLSearchParams({ state, ...extra }) };
}
const activeAccount = (id: string, toolkit = "gmail"): ComposioAccount => ({ id, status: "ACTIVE", toolkitSlug: toolkit, authConfigId: toolkit === "gmail" ? "ac_gmail_synthetic" : "ac_cal_synthetic", isDisabled: false });
const profile = (email: string) => ({ successful: true, data: { emailAddress: email } });

describe("start", () => {
  it("links with the Jarvis user UUID and the configured auth config, binds the state to the toolkit and the new account, and audits", async () => {
    const h = harness();
    const s = await started(h);
    expect(s.location).toBe("https://connect.composio.dev/link/lk1");
    expect(h.calls).toEqual(["state", `link ${USER} ac_gmail_synthetic`]); // the state (role + cap checked by the database) comes before the Composio call
    const callback = new URL(h.seen.callbackUrl);
    expect(callback.origin + callback.pathname).toBe("https://app.example.test/api/connect/composio/callback");
    expect(callback.searchParams.get("state")).toMatch(/^PKG\.[A-Za-z0-9_-]{43}$/);
    const [stored] = [...h.states.values()];
    expect(stored).toMatchObject({ provider: "google", toolkit: "gmail", accountRef: "ca_1", lane: LANE });
    expect(h.audits.map((a) => a.action)).toEqual(["connection.connect_started"]);
    expect(h.audits[0]?.metadata).toEqual({ transport: "composio", toolkit: "gmail" });
  });

  it("uses the calendar auth config for the calendar toolkit", async () => {
    const h = harness();
    await started(h, "googlecalendar");
    expect(h.calls[1]).toBe(`link ${USER} ac_cal_synthetic`);
  });

  it("when the auth config id is not configured: refuses without any Composio call", async () => {
    const h = harness({ authConfig: null });
    await expect(h.flow.start("gmail", LANE, h.authorize)).rejects.toMatchObject({ info: { kind: "connection_unavailable" } });
    expect(h.calls).toEqual([]);
  });

  it("a lane with no mailbox list never starts a connect (fail closed)", async () => {
    const h = harness({ mailboxes: [] });
    await expect(h.flow.start("gmail", LANE, h.authorize)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(h.calls).toEqual([]);
  });

  it("a failing state create (role, aal2 or in-flight cap) means Composio is never called: no orphan account", async () => {
    const h = harness();
    const flow = createComposioConnect({ composio: guardComposio({ link: async () => { throw new Error("must not be called"); }, getAccount: async () => { throw new Error("no"); }, listAccountIds: async () => [], execute: async () => { throw new Error("no"); } }), states: { create: async () => { throw new ConnectorError({ kind: "rate_limited", message: "Too many connects in progress" }); }, consume: async () => null }, connections: {} as never, laneConfig: { async mailboxes() { return [BOSS]; } }, authConfigId: () => "ac", appOrigin: () => "https://app.example.test", audit: { async log() {} } });
    await expect(flow.start("gmail", LANE, h.authorize)).rejects.toMatchObject({ info: { kind: "rate_limited" } });
  });

  it("an unknown toolkit is refused before authorize or Composio", async () => {
    const h = harness();
    let authorized = false;
    await expect(h.flow.start("notion", LANE, async (l) => ((authorized = true), h.authorize(l)))).rejects.toMatchObject({ info: { kind: "not_found" } });
    expect(authorized).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("an authorization error (wrong role, no aal2) stops everything: no link, no state", async () => {
    const h = harness();
    await expect(h.flow.start("gmail", LANE, async () => { throw new Error("AuthError"); })).rejects.toThrow("AuthError");
    expect(h.calls).toEqual([]);
    expect(h.states.size).toBe(0);
  });

  it("refuses a consent link that is not a Composio https address", async () => {
    for (const url of ["http://connect.composio.dev/x", "https://evil.example.test/composio.dev", "https://composio.dev.evil.test/x", "javascript:alert(1)", "not a url"]) {
      const h = harness();
      h.setRedirect(url);
      await expect(h.flow.start("gmail", LANE, h.authorize), url).rejects.toMatchObject({ info: { kind: "provider_error" } });
      expect([...h.states.values()].every((st) => st.toolkit === null && st.accountRef === null), url).toBe(true); // never bound: the callback refuses it
    }
  });
});

describe("callback", () => {
  it("connects: ACTIVE account, allow-listed identity read, address in lane_config.mailboxes, activation without a token", async () => {
    const h = harness();
    const s = await started(h);
    h.accounts.set(s.accountId, activeAccount(s.accountId));
    h.tools.set("GMAIL_GET_PROFILE", profile("Boss@PKG.example.test"));
    const res = await h.flow.callback(s.query({ status: "success", connected_account_id: s.accountId }), h.authorize);
    expect(res).toMatchObject({ ok: true, laneId: LANE, toolkit: "gmail" });
    const row = [...h.rows.values()][0];
    expect(row).toMatchObject({ status: "active", identity: BOSS, accountId: s.accountId, toolkit: "gmail", createdBy: USER });
    expect(h.calls.filter((c) => c.startsWith("execute"))).toEqual(["execute GMAIL_GET_PROFILE"]);
    expect(h.audits.map((a) => a.action)).toEqual(["connection.connect_started", "connection.connect.requested", "connection.connect.succeeded"]);
  });

  it("the state works once (replay) and a missing or garbage state is invalid_state", async () => {
    const h = harness();
    const s = await started(h);
    h.accounts.set(s.accountId, activeAccount(s.accountId));
    h.tools.set("GMAIL_GET_PROFILE", profile(BOSS));
    expect((await h.flow.callback(s.query(), h.authorize)).ok).toBe(true);
    expect(await h.flow.callback(s.query(), h.authorize)).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(await h.flow.callback(new URLSearchParams(), h.authorize)).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(await h.flow.callback(new URLSearchParams({ state: "garbage" }), h.authorize)).toMatchObject({ ok: false, reason: "invalid_state" });
  });

  it("a state started for another lane does not complete under this one", async () => {
    const h = harness();
    const s = await started(h);
    const forged = new URLSearchParams({ state: s.state.replace("PKG.", "APK.") });
    expect(await h.flow.callback(forged, h.authorize)).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(h.rows.size).toBe(0);
  });

  it("a native state (no toolkit binding) is not accepted by the Composio callback", async () => {
    const h = harness();
    const s = await started(h);
    const [hash] = [...h.states.keys()];
    const stored = h.states.get(hash as string) as StoredState;
    stored.toolkit = null;
    stored.accountRef = null;
    expect(await h.flow.callback(s.query(), h.authorize)).toMatchObject({ ok: false, reason: "invalid_state" });
  });

  it("a connected_account_id in the URL that differs from the one created at start is refused (forged redirect), before any Composio read", async () => {
    const h = harness();
    const s = await started(h);
    h.accounts.set("ca_attacker", activeAccount("ca_attacker"));
    h.tools.set("GMAIL_GET_PROFILE", profile(BOSS));
    const res = await h.flow.callback(s.query({ connected_account_id: "ca_attacker" }), h.authorize);
    expect(res).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(h.calls.filter((c) => c.startsWith("get") || c.startsWith("execute"))).toEqual([]);
    expect(h.rows.size).toBe(0);
  });

  it("the account used is the one stored at start, whatever the URL carries", async () => {
    const h = harness();
    const s = await started(h);
    h.accounts.set(s.accountId, activeAccount(s.accountId));
    h.tools.set("GMAIL_GET_PROFILE", profile(BOSS));
    await h.flow.callback(s.query(), h.authorize); // no connected_account_id in the URL at all
    expect([...h.rows.values()][0]?.accountId).toBe(s.accountId);
  });

  it("an account that is not this user's (a state carrying a foreign ca_ id) is refused; the pending row is not left behind", async () => {
    const h = harness();
    const s = await started(h);
    h.accounts.set(s.accountId, activeAccount(s.accountId));
    h.notMine.add(s.accountId);
    h.tools.set("GMAIL_GET_PROFILE", profile(BOSS));
    expect(await h.flow.callback(s.query(), h.authorize)).toMatchObject({ ok: false, reason: "account_refused" });
    expect(h.rows.size).toBe(0);
    expect(h.calls.filter((c) => c.startsWith("execute"))).toEqual([]);
  });

  it("an account from another auth config than the one configured for the toolkit is refused", async () => {
    const h = harness();
    const s = await started(h);
    h.accounts.set(s.accountId, { ...activeAccount(s.accountId), authConfigId: "ac_someone_elses" });
    h.tools.set("GMAIL_GET_PROFILE", profile(BOSS));
    expect(await h.flow.callback(s.query(), h.authorize)).toMatchObject({ ok: false, reason: "account_refused" });
    expect(h.rows.size).toBe(0);
  });

  it("a refused or in-use account leaves no pending row", async () => {
    const h = harness();
    h.otherLaneIdentities.add(BOSS);
    const s = await started(h);
    h.accounts.set(s.accountId, activeAccount(s.accountId));
    h.tools.set("GMAIL_GET_PROFILE", profile(BOSS));
    await h.flow.callback(s.query(), h.authorize);
    expect(h.calls).toContain("discard");
    expect(h.rows.size).toBe(0);
  });

  it("denied at the consent screen: nothing is read or stored", async () => {
    const h = harness();
    const s = await started(h);
    expect(await h.flow.callback(s.query({ status: "failed" }), h.authorize)).toMatchObject({ ok: false, reason: "denied" });
    expect(h.calls.filter((c) => c.startsWith("get") || c.startsWith("execute"))).toEqual([]);
    expect(h.rows.size).toBe(0);
  });

  it("an account that is not ACTIVE (consent not finished) is exchange_failed; nothing stored, no removal notice", async () => {
    const h = harness();
    const s = await started(h);
    h.accounts.set(s.accountId, { ...activeAccount(s.accountId), status: "INITIATED" });
    const res = await h.flow.callback(s.query(), h.authorize);
    expect(res).toMatchObject({ ok: false, reason: "exchange_failed" });
    expect((res as { message?: string }).message).toBeUndefined();
    expect(h.rows.size).toBe(0);
  });

  it("an account of another toolkit is refused", async () => {
    const h = harness();
    const s = await started(h);
    h.accounts.set(s.accountId, activeAccount(s.accountId, "googlecalendar"));
    h.tools.set("GMAIL_GET_PROFILE", profile(BOSS));
    expect(await h.flow.callback(s.query(), h.authorize)).toMatchObject({ ok: false, reason: "account_refused" });
    expect(h.rows.size).toBe(0);
  });

  it("an address that is not in lane_config.mailboxes is refused (fail closed) and the user is told to remove the account in Composio", async () => {
    const h = harness();
    const s = await started(h);
    h.accounts.set(s.accountId, activeAccount(s.accountId));
    h.tools.set("GMAIL_GET_PROFILE", profile("someone-else@example.test"));
    const res = await h.flow.callback(s.query(), h.authorize);
    expect(res).toMatchObject({ ok: false, reason: "account_refused", message: COMPOSIO_GRANT_NOT_STORED_MESSAGE });
    expect(h.rows.size).toBe(0);
    expect(h.audits.map((a) => a.action)).toContain("connection.connect.grant_not_stored");
  });

  it("an unreadable identity is refused", async () => {
    const h = harness();
    const s = await started(h);
    h.accounts.set(s.accountId, activeAccount(s.accountId));
    h.tools.set("GMAIL_GET_PROFILE", { successful: true, data: { note: "no address here" } });
    expect(await h.flow.callback(s.query(), h.authorize)).toMatchObject({ ok: false, reason: "account_refused" });
  });

  it("an address already connected in another lane is refused with the in-use message", async () => {
    const h = harness();
    h.otherLaneIdentities.add(BOSS);
    const s = await started(h);
    h.accounts.set(s.accountId, activeAccount(s.accountId));
    h.tools.set("GMAIL_GET_PROFILE", profile(BOSS));
    const res = await h.flow.callback(s.query(), h.authorize);
    expect(res).toMatchObject({ ok: false, reason: "account_refused" });
    expect((res as { message: string }).message).toContain("already connected to another company");
  });

  it("a Composio outage while reading is `unavailable`, not a refusal of the account, and nothing is stored", async () => {
    const h = harness();
    const s = await started(h);
    h.flags.getAccountError = new ConnectorError({ kind: "transient", message: "Composio is unavailable" });
    const res = await h.flow.callback(s.query(), h.authorize);
    expect(res).toMatchObject({ ok: false, reason: "unavailable" });
    expect(h.rows.size).toBe(0);
  });

  it("a reconnect supersedes the lane's earlier account for the toolkit (fake store: the SQL itself is proven in pgTAP 270)", async () => {
    const h = harness();
    for (let i = 0; i < 2; i += 1) {
      const s = await started(h);
      h.accounts.set(s.accountId, activeAccount(s.accountId));
      h.tools.set("GMAIL_GET_PROFILE", profile(BOSS));
      expect((await h.flow.callback(s.query(), h.authorize)).ok).toBe(true);
    }
    expect([...h.rows.values()].map((r) => r.status).sort()).toEqual(["active", "disconnected"]);
  });
});

describe("Test check", () => {
  async function connected(h: ReturnType<typeof harness>) {
    const s = await started(h);
    h.accounts.set(s.accountId, activeAccount(s.accountId));
    h.tools.set("GMAIL_GET_PROFILE", profile(BOSS));
    await h.flow.callback(s.query(), h.authorize);
    h.tools.set("GMAIL_LIST_LABELS", { successful: true, data: { labels: [{ name: "board salaries" }] } });
    h.calls.length = 0;
    return s;
  }

  it("not connected without a row", async () => {
    const h = harness();
    expect(await h.check(LANE, "gmail")).toEqual({ status: "not_connected", checked_at: "2026-11-08T12:00:00.000Z" });
    expect(h.calls).toEqual([]);
  });

  it("ok: reads identity and one page through allow-listed read tools only, and returns nothing about the content", async () => {
    const h = harness();
    await connected(h);
    const res = await h.check(LANE, "gmail");
    expect(res).toEqual({ status: "ok", checked_at: "2026-11-08T12:00:00.000Z" });
    expect(h.calls.filter((c) => c.startsWith("execute"))).toEqual(["execute GMAIL_GET_PROFILE", "execute GMAIL_LIST_LABELS"]);
    expect(JSON.stringify(res)).not.toContain("board salaries");
    expect(JSON.stringify(res)).not.toContain(BOSS);
  });

  it.each(["EXPIRED", "REVOKED", "FAILED", "INACTIVE"] as const)("account status %s -> the connection becomes reconnect_required, nothing is read", async (status) => {
    const h = harness();
    const s = await connected(h);
    h.accounts.set(s.accountId, { ...activeAccount(s.accountId), status });
    expect((await h.check(LANE, "gmail")).status).toBe("reconnect_required");
    expect(h.calls).toContain("health reconnect_required");
    expect(h.calls.filter((c) => c.startsWith("execute"))).toEqual([]);
    expect([...h.rows.values()][0]?.status).toBe("reconnect_required");
  });

  it("a disabled account is reconnect_required too", async () => {
    const h = harness();
    const s = await connected(h);
    h.accounts.set(s.accountId, { ...activeAccount(s.accountId), isDisabled: true });
    expect((await h.check(LANE, "gmail")).status).toBe("reconnect_required");
  });

  it("recovers: an ACTIVE account brings a reconnect_required connection back to active", async () => {
    const h = harness();
    const s = await connected(h);
    h.accounts.set(s.accountId, { ...activeAccount(s.accountId), status: "EXPIRED" });
    await h.check(LANE, "gmail");
    h.accounts.set(s.accountId, activeAccount(s.accountId));
    expect((await h.check(LANE, "gmail")).status).toBe("ok");
    expect([...h.rows.values()][0]?.status).toBe("active");
  });

  it("the mailbox is re-checked against lane_config on every call (removed from the list -> refused, nothing read)", async () => {
    const h = harness();
    await connected(h);
    const stricter = createComposioCheck({ composio: guardComposio({ link: async () => { throw new Error("no"); }, getAccount: async (id) => activeAccount(id), listAccountIds: async () => [], execute: async () => { throw new Error("must not be called"); } }), connections: { find: async () => [...h.rows.values()][0] ?? null } as never, laneConfig: { async mailboxes() { return ["other@example.test"]; } } });
    expect((await stricter(LANE, "gmail")).status).toBe("mailbox_not_allowed");
  });

  it("an identity that no longer matches the stored one is an error", async () => {
    const h = harness();
    await connected(h);
    h.tools.set("GMAIL_GET_PROFILE", profile("different@example.test"));
    expect((await h.check(LANE, "gmail")).status).toBe("error");
  });

  it("a failing page read is an error, never an exception", async () => {
    const h = harness();
    await connected(h);
    h.tools.set("GMAIL_LIST_LABELS", { successful: false, data: {} });
    expect((await h.check(LANE, "gmail")).status).toBe("error");
  });

  it("another lane's connection is never found (lane-bound lookup)", async () => {
    const h = harness();
    await connected(h);
    expect((await h.check("APK", "gmail")).status).toBe("not_connected");
  });
});
