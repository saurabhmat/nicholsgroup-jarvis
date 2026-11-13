/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index into data they just built */
// T-195 (QB-8): the disconnect executor's read-back and the end state of an approved revoke. The revoke itself
// (fail-closed table, tamper checks) is covered in connector.test.ts; here: the action type shared with approvals, the
// row ending `disconnected` with its Vault tokens gone, and the verifier that the approvals executor calls afterwards.
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { RateLimiter } from "../http/rate-limit";
import { useMockServer } from "../testing/msw/index";
import { createFakeIntuit } from "../testing/msw/quickbooks/handlers";
import { createQboHarness } from "../testing/quickbooks-harness";
import { SecretValue } from "../vault/secret";
import { createQuickBooksDisconnectVerifier, QBO_REVOKE_ACTION, QBO_VERIFICATION_MISMATCH_MESSAGE } from "./writer";

const server = useMockServer();
const LANE = "PKG";
afterEach(() => RateLimiter.resetForTests());

async function setup() {
  const intuit = createFakeIntuit();
  server.use(...intuit.handlers);
  const h = createQboHarness({ intuit });
  const conn = await h.connectViaCallback(LANE);
  const verifier = createQuickBooksDisconnectVerifier({ connections: h.connections, vault: h.vault });
  return { intuit, h, conn, verifier };
}
const refused = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as ConnectorError;

describe("the action type is the approvals type", () => {
  it("is 'qbo.disconnect' (the string stored in act.proposed_actions and covered by the approval hash)", () => {
    expect(QBO_REVOKE_ACTION).toBe("qbo.disconnect");
  });
});

describe("an approved revoke ends with the row disconnected and the Vault tokens gone (QB-8)", () => {
  it("calls Intuit's revocation endpoint once with the refresh token, then the row is disconnected and no secret is stored", async () => {
    const { intuit, h, conn } = await setup();
    const refresh = (h.storedSet(conn.id) as { refresh_token: string }).refresh_token;
    const after = await h.disconnectForTest(LANE, conn);
    expect(intuit.state.revokeRequests).toHaveLength(1);
    expect((intuit.state.revokeRequests[0]?.body as { token?: string }).token).toBe(refresh);
    expect(after.status).toBe("disconnected");
    expect(h.secrets.has(conn.id)).toBe(false);
    expect(h.stats.revokes).toBe(1);
    expect(h.stats.revokeActors).toEqual(["00000000-0000-4000-8000-0000000000b1"]); // the approver goes to the Vault audit row
  });

  it("a reconnect_required connection can be disconnected too (Intuit says the token is already gone: invalid_grant counts as revoked)", async () => {
    const { intuit, h, conn } = await setup();
    h.rows.get(conn.id)!.status = "reconnect_required";
    intuit.state.revokeRequests.length = 0;
    const after = await h.disconnectForTest(LANE, conn);
    expect(after.status).toBe("disconnected");
    expect(h.secrets.has(conn.id)).toBe(false);
  });
});

describe("the read-back after the executor ran", () => {
  const action = (conn: { id: string; external_account_id: string }, lane = LANE) => ({ lane_id: lane, connection_id: conn.id, target: { realm_id: conn.external_account_id } });

  it("passes once the connection is disconnected and the Vault hands out nothing", async () => {
    const { h, conn, verifier } = await setup();
    await h.disconnectForTest(LANE, conn);
    await expect(verifier.verify(LANE, conn, action(conn))).resolves.toBeUndefined();
  });

  it("fails with the fixed message while the connection is still usable (a revoke that did nothing)", async () => {
    const { conn, verifier } = await setup();
    const err = await refused(verifier.verify(LANE, conn, action(conn)));
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.info.message).toBe(QBO_VERIFICATION_MISMATCH_MESSAGE);
  });

  it("fails when the row says disconnected but the Vault still hands out a token", async () => {
    const { h, conn } = await setup();
    const leaky = createQuickBooksDisconnectVerifier({ connections: h.connections, vault: { getToken: async () => new SecretValue("synthetic-leftover") } });
    await h.disconnectForTest(LANE, conn);
    expect((await refused(leaky.verify(LANE, conn, action(conn)))).info.message).toBe(QBO_VERIFICATION_MISMATCH_MESSAGE);
  });

  it("a store that cannot be read is an error of its own, never 'disconnected'", async () => {
    const { h, conn } = await setup();
    await h.disconnectForTest(LANE, conn);
    const down = createQuickBooksDisconnectVerifier({ connections: h.connections, vault: { getToken: async () => { throw new ConnectorError({ kind: "transient", message: "Token store unavailable" }); } } });
    expect((await refused(down.verify(LANE, conn, action(conn)))).info.kind).toBe("transient");
  });

  it("refuses an action for another company, another lane or another connection", async () => {
    const { h, conn, verifier } = await setup();
    await h.disconnectForTest(LANE, conn);
    expect((await refused(verifier.verify(LANE, conn, { ...action(conn), target: { realm_id: "1111111111111111" } }))).info.kind).toBe("invalid_input");
    expect((await refused(verifier.verify(LANE, conn, action(conn, "APK")))).info.kind).toBe("lane_mismatch");
    expect((await refused(verifier.verify(LANE, conn, { ...action(conn), connection_id: "00000000-0000-4000-8000-000000000999" }))).info.kind).toBe("lane_mismatch");
    expect((await refused(verifier.verify("APK", conn, action(conn)))).info.kind).toBe("lane_mismatch");
  });

  it("refuses another provider's connection", async () => {
    const { h, verifier } = await setup();
    const foreign = h.addForeignConnection(LANE);
    expect((await refused(verifier.verify(LANE, foreign as never, { lane_id: LANE, connection_id: foreign.id, target: { realm_id: "x" } }))).info.kind).toBeDefined();
  });
});
