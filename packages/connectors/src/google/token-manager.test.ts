// Google token refresh and revocation (T-063): proactive and on-demand refresh, single flight, compare-and-swap with
// another instance, invalid_grant -> reconnect_required, secrets never logged, and the approvals-only revoke.
import { afterEach, describe, expect, it } from "vitest";
import { isConnectorError } from "../contract/errors";
import { RateLimiter } from "../http/rate-limit";
import { createGoogleHarness, type GoogleHarness } from "../testing/google-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeGoogle, FAKE_CLIENT_SECRET } from "../testing/msw/google/handlers";
import { GOOGLE_REVOKE_ACTION, createGoogleWriter } from "./writer";

const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
});

const EXEC = "exec@pubkgroup.example.test";

function setup() {
  const fake = createFakeGoogle();
  server.use(...fake.handlers);
  const h = createGoogleHarness({ fake, mailboxes: { PKG: [EXEC] } });
  const { row } = h.connectGoogle("PKG", EXEC);
  return { fake, h, conn: h.bind(row), row };
}
async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isConnectorError(e) ? e.info.kind : "other";
  }
  return "no error";
}

describe("access tokens", () => {
  it("uses the stored access token while it is fresh, with no request to Google", async () => {
    const { fake, h, conn } = setup();
    const t = await h.tokens.accessToken("PKG", conn);
    expect(t.reveal()).toBe(h.storedSet(conn.id)?.access_token);
    expect(fake.state.tokenRequests).toEqual([]);
  });

  it("refreshes an expired one with the client secret in the body, keeps the refresh token, and stores the new set", async () => {
    const { fake, h, conn } = setup();
    const before = h.storedSet(conn.id);
    h.expireStoredAccess(conn.id);
    const t = await h.tokens.accessToken("PKG", conn);
    expect(fake.state.tokenRequests).toHaveLength(1);
    expect(fake.state.tokenRequests[0]?.fields).toMatchObject({ grant_type: "refresh_token", client_secret: FAKE_CLIENT_SECRET });
    const after = h.storedSet(conn.id);
    expect(after?.refresh_token).toBe(before?.refresh_token);
    expect(after?.access_token).not.toBe(before?.access_token);
    expect(t.reveal()).toBe(after?.access_token);
    expect(h.stats.rotations).toBe(1);
  });

  it("is single flight within a process", async () => {
    const { fake, h, conn } = setup();
    h.expireStoredAccess(conn.id);
    const all = await Promise.all([1, 2, 3, 4].map(() => h.tokens.accessToken("PKG", conn)));
    expect(new Set(all.map((t) => t.reveal())).size).toBe(1);
    expect(fake.state.refreshes).toBe(1);
  });

  it("two instances racing: the compare-and-swap loser uses the winner's stored token", async () => {
    const { fake, h, conn } = setup();
    h.expireStoredAccess(conn.id);
    const other = h.newTokenManager();
    const [a, b] = await Promise.all([h.tokens.accessToken("PKG", conn), other.accessToken("PKG", conn)]);
    expect(a.reveal()).toBe(b.reveal());
    expect(a.reveal()).toBe(h.storedSet(conn.id)?.access_token);
    expect(h.stats.rotations).toBe(1);
    expect(fake.state.refreshes).toBe(2);
  });

  it("a 401 for the token in use refreshes once and the call is retried once", async () => {
    const { fake, h, conn } = setup();
    const a = h.accountOf(conn);
    // Google invalidates the current access token (not the grant): the next call is 401 once, then works.
    const stored = h.storedSet(conn.id)?.access_token as string;
    a.accessTokens.delete(stored);
    const res = await h.mail.search("PKG", conn, { query: "budget" });
    expect(res.data.length).toBe(1);
    expect(fake.state.refreshes).toBe(1);
  });

  it("invalid_grant (revoked at Google) is reconnect_required, never retried, and keeps the stored set for T-195 to handle", async () => {
    const { fake, h, conn } = setup();
    h.accountOf(conn).revoked = true;
    h.expireStoredAccess(conn.id);
    expect(await kindOf(h.tokens.accessToken("PKG", conn))).toBe("reconnect_required");
    expect(fake.state.tokenRequests).toHaveLength(1);
    expect(h.secrets.has(conn.id)).toBe(true);
  });

  it("a wrong client (invalid_client) is not reconnect_required: it is a configuration fault", async () => {
    const { fake, h, conn } = setup();
    fake.state.failRefresh = { status: 401, error: "invalid_client" };
    h.expireStoredAccess(conn.id);
    expect(await kindOf(h.tokens.accessToken("PKG", conn))).toBe("forbidden");
  });

  it("refuses another provider's connection before reading any token", async () => {
    const { h } = setup();
    const foreign = await h.contractHarness().connectForeignProvider();
    const reads = h.stats.tokenReads;
    expect(await kindOf(h.tokens.accessToken("PKG", foreign as never))).toBe("forbidden");
    expect(await kindOf(h.tokens.refreshToken("PKG", foreign as never))).toBe("forbidden");
    expect(h.stats.tokenReads).toBe(reads);
  });

  it("a stored value that is not a token set is a provider_error that does not echo it", async () => {
    const { h, conn } = setup();
    h.secrets.set(conn.id, "not-json-secret-material-123");
    let message = "";
    try {
      await h.tokens.accessToken("PKG", conn);
    } catch (e) {
      message = e instanceof Error ? e.message : "";
    }
    expect(message).toMatch(/not a Google token set/);
    expect(message).not.toContain("secret-material");
  });

  it("never logs tokens or the client secret", async () => {
    const { h, conn } = setup();
    h.expireStoredAccess(conn.id);
    await h.tokens.accessToken("PKG", conn);
    const set = h.storedSet(conn.id);
    const text = JSON.stringify(h.logs);
    for (const s of [FAKE_CLIENT_SECRET, String(set?.access_token), String(set?.refresh_token)]) expect(text).not.toContain(s);
  });
});

describe("revoke (approvals-only writer)", () => {
  const run = (h: GoogleHarness, row: { id: string; external_account_id: string }, action = h.approvedRevoke("PKG", row)) => h.revoker.run("PKG", h.bind(row as never), action);

  it("revokes the refresh token at Google, deletes the Vault tokens and names the approver", async () => {
    const { fake, h, row } = setup();
    const refresh = h.storedSet(row.id)?.refresh_token;
    const res = await run(h, row);
    expect(res.outcome).toBe("accepted");
    expect(fake.state.revokeRequests).toEqual([{ token: refresh }]);
    expect(h.secrets.has(row.id)).toBe(false);
    expect(h.rows.get(row.id)?.status).toBe("disconnected");
    expect(h.stats.revokeActors).toEqual(["00000000-0000-4000-8000-0000000000b1"]);
  });

  it("is idempotent: a second run on a disconnected connection does nothing", async () => {
    const { fake, h, row } = setup();
    await run(h, row);
    expect((await run(h, row)).outcome).toBe("already_applied");
    expect(fake.state.revokeRequests).toHaveLength(1);
  });

  it("a token Google no longer knows (400 invalid_token) still disconnects", async () => {
    const { fake, h, row } = setup();
    fake.state.failRevoke = { status: 400, error: "invalid_token" };
    expect((await run(h, row)).outcome).toBe("already_applied");
    expect(h.rows.get(row.id)?.status).toBe("disconnected");
  });

  it("an unconfirmed revocation (5xx, 401) keeps the tokens and fails", async () => {
    for (const status of [500, 401]) {
      const { fake, h, row } = setup();
      fake.state.failRevoke = { status, error: "backend" };
      expect(await kindOf(run(h, row))).not.toBe("no error");
      expect(h.secrets.has(row.id)).toBe(true);
      expect(h.rows.get(row.id)?.status).toBe("active");
    }
  });

  it("refuses a tampered payload, another mailbox, another lane or connection, a wrong action and a missing approver, before any call", async () => {
    const { fake, h, row } = setup();
    const ok = h.approvedRevoke("PKG", row);
    const cases = [
      { ...ok, payload: { x: 1 } },
      { ...ok, payload_sha256: "0".repeat(64) },
      { ...ok, target: { mailbox: "someone@else.example.test" } },
      { ...ok, lane_id: "APK" },
      { ...ok, connection_id: "00000000-0000-4000-8000-000000000999" },
      { ...ok, action_type: "google.send" },
      { ...ok, approved_by: "not-a-uuid" },
    ];
    for (const action of cases) expect(await kindOf(h.revoker.run("PKG", h.bind(row), action as never))).not.toBe("no error");
    expect(fake.state.revokeRequests).toEqual([]);
    expect(h.secrets.has(row.id)).toBe(true);
  });

  it("refuses another provider's connection", async () => {
    const { h } = setup();
    const foreign = await h.contractHarness().connectForeignProvider();
    expect(await kindOf(h.revoker.run("PKG", foreign as never, h.approvedRevoke("PKG", foreign) as never))).toBe("forbidden");
  });

  it("the writer is a ConnectorWriter for exactly the revoke action", () => {
    const { h } = setup();
    const w = createGoogleWriter({ vault: h.vault, connections: h.connections, tokens: h.tokens });
    expect(w.provider).toBe("google");
    expect(w.actionTypes).toEqual([GOOGLE_REVOKE_ACTION]);
  });
});
