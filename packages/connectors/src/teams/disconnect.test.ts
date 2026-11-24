// Local Disconnect of a Teams account (T-279, spec 5): tokens deleted, the row `disconnected`, subscriptions marked removed, later tasks' purgers run, nothing sent to Microsoft; only the
// owner, only a Teams row, never another lane's. A failing side step never blocks the disconnect.
import { describe, expect, it, vi } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import { createTeamsDisconnect } from "./disconnect";

const OWNER = "00000000-0000-4000-8000-00000000d279";
const OTHER = "00000000-0000-4000-8000-00000000e279";
const ROW = { id: "00000000-0000-4000-8000-00000000f279", lane_id: "PKG", provider: "microsoft_teams", external_account_id: "person@teams.example.test", status: "active", features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null, owner_user_id: OWNER } as const;
const conn = (patch: Record<string, unknown> = {}) => mintLaneBoundConnection({ ...ROW, ...patch } as never);

function setup(c = conn()) {
  const revoke = vi.fn(async () => true);
  const removeConnection = vi.fn(async () => 1);
  const purge = vi.fn(async () => undefined);
  const warn = vi.fn();
  const logger = { child: () => logger, warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  const d = createTeamsDisconnect({
    loader: { loadConnection: async (lane, id) => { if (lane !== c.lane_id || id !== c.id) throw new ConnectorError({ kind: "not_found", message: "Connection not found" }); return c; } },
    vault: { revokeToken: revoke },
    subscriptions: { removeConnection },
    purgers: [{ name: "reads", purge }],
    logger,
  });
  return { d, revoke, removeConnection, purge, warn };
}

describe("disconnectTeams", () => {
  it("deletes the tokens, removes the subscriptions and runs the purgers, for the owner", async () => {
    const { d, revoke, removeConnection, purge } = setup();
    expect(await d("PKG", ROW.id, OWNER)).toBe(true);
    expect(revoke).toHaveBeenCalledWith("PKG", expect.objectContaining({ id: ROW.id }), OWNER);
    expect(removeConnection).toHaveBeenCalledWith("PKG", ROW.id);
    expect(purge).toHaveBeenCalledWith("PKG", ROW.id);
  });

  it("another person's connection, another lane's id, a mailbox row and a bad user id are refused with not_found / invalid_input and delete nothing", async () => {
    const a = setup();
    await expect(a.d("PKG", ROW.id, OTHER)).rejects.toMatchObject({ info: { kind: "not_found" } });
    await expect(a.d("OTH", ROW.id, OWNER)).rejects.toMatchObject({ info: { kind: "not_found" } });
    await expect(a.d("PKG", ROW.id, "not-a-uuid")).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    const mail = setup(conn({ provider: "microsoft" }));
    await expect(mail.d("PKG", ROW.id, OWNER)).rejects.toMatchObject({ info: { kind: "not_found" } });
    for (const s of [a, mail]) {
      expect(s.revoke).not.toHaveBeenCalled();
      expect(s.removeConnection).not.toHaveBeenCalled();
    }
  });

  it("a failing subscription mark or purger is logged by ids and an enum only and never blocks the disconnect", async () => {
    const s = setup();
    s.removeConnection.mockRejectedValueOnce(new Error("secret-ish text"));
    s.purge.mockRejectedValueOnce(new Error("more secret-ish text"));
    expect(await s.d("PKG", ROW.id, OWNER)).toBe(true);
    expect(s.revoke).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(s.warn.mock.calls)).not.toContain("secret-ish");
    expect(s.warn.mock.calls.map((c) => c[0])).toEqual(["teams.disconnect.subscriptions_unconfirmed", "teams.disconnect.purge_unconfirmed"]);
  });

  it("works whether or not Teams is enabled for the lane (no config is read: the module takes none)", async () => {
    const { d } = setup();
    expect(d.length).toBe(3);
    expect(await d("PKG", ROW.id, OWNER)).toBe(true);
  });
});

describe("the wiring (T-282)", () => {
  it("the Teams disconnect is wired with the read-marker purger; later tasks add theirs beside it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    // T-286: the open Teams send actions of the connection are closed (text purged) beside the read markers; T-289: the notice times (comms.teams_activity) go with them
    expect(src).toMatch(/purgers:\s*\[\s*\{ name: "chat_reads", purge: \(laneId, connectionId\) => teamsChatReadsStore\.purgeConnection\(laneId, connectionId\) \},\s*\{ name: "send_actions", purge: \(laneId, connectionId\) => teamsActionsStore\.purgeConnection\(laneId, connectionId\) \},\s*(\/\/[^\n]*\n\s*)?\{ name: "activity", purge: \(laneId, connectionId\) => teamsNoticesStore\.purgeConnection\(laneId, connectionId\) \},?\s*\]/);
    // and the subscriptions are marked removed (their Vault secrets deleted) by the same disconnect, before the purgers
    expect(src).toMatch(/subscriptions: microsoftSubscriptionStore,/);
  });

  it("a purger that fails is logged by class only and the disconnect still completes (the markers are also removed by the retention purge)", async () => {
    const { d, purge, warn } = setup();
    purge.mockRejectedValue(new Error("secret"));
    expect(await d("PKG", ROW.id, OWNER)).toBe(true);
    expect(warn).toHaveBeenCalledWith("teams.disconnect.purge_unconfirmed", expect.objectContaining({ purger: "reads" }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
  });
});

describe("two accounts of one person (T-294)", () => {
  const ROW_B = { ...ROW, id: "00000000-0000-4000-8000-00000000f280", external_account_id: "person@second.example.test" };
  const A = mintLaneBoundConnection({ ...ROW } as never);
  const B = mintLaneBoundConnection({ ...ROW_B } as never);

  it("disconnecting one account touches ONLY that connection: its tokens, subscriptions and purgers; the other account's are never named", async () => {
    const revoke = vi.fn(async () => true);
    const removeConnection = vi.fn(async () => 1);
    const purge = vi.fn(async () => undefined);
    const logger = { child: () => logger, warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
    const d = createTeamsDisconnect({
      loader: { loadConnection: async (lane, id) => { const c = [A, B].find((x) => x.id === id); if (lane !== "PKG" || !c) throw new ConnectorError({ kind: "not_found", message: "Connection not found" }); return c; } },
      vault: { revokeToken: revoke },
      subscriptions: { removeConnection },
      purgers: [{ name: "reads", purge }, { name: "activity", purge }],
      logger,
    });
    expect(await d("PKG", ROW_B.id, OWNER)).toBe(true);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("PKG", expect.objectContaining({ id: ROW_B.id }), OWNER);
    expect(removeConnection).toHaveBeenCalledTimes(1);
    expect(removeConnection).toHaveBeenCalledWith("PKG", ROW_B.id);
    for (const call of purge.mock.calls) expect(call).toEqual(["PKG", ROW_B.id]);
    // nothing names the first account anywhere
    expect(JSON.stringify([revoke.mock.calls, removeConnection.mock.calls, purge.mock.calls])).not.toContain(ROW.id);
  });
});
