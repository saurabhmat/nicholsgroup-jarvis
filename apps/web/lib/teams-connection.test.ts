// T-280: who sees the Teams section on Settings and what it holds (`teamsSectionFor`, `loadTeamsRows`). Synthetic rows; the lane and role guards are fakes. Nothing is read from Microsoft.
import { describe, expect, it } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { loadTeamsRows, teamsSectionFor, type TeamsConnectionView } from "./teams-connection";

const ME = "00000000-0000-4000-8000-0000000000aa";
const guard = (userId: string | "denied" = ME) =>
  ({
    requireRole: async () => {
      if (userId === "denied") throw new AuthError("forbidden");
      return { client: {} as never, session: { userId } as never, laneId: "PKG" };
    },
  }) as Parameters<typeof teamsSectionFor>[0];
const row = (over: Partial<TeamsConnectionView> = {}): TeamsConnectionView => ({ id: "00000000-0000-4000-8000-0000000000c1", account: "me@teams.example.test", state: "connected", mine: true, has: ["chat_read", "call_links"], ...over });
const enabled = { enabled: true, cloudSupported: true, features: ["chat_read", "call_links"] as never, needsAdminConsent: false };
const section = (rows: TeamsConnectionView[] | Error, lane: unknown, opts?: { keepEmpty?: boolean }, who: string = ME) =>
  teamsSectionFor(guard(who), "PKG", async () => { if (rows instanceof Error) throw rows; return rows; }, async () => { if (lane instanceof Error) throw lane; return lane as never; }, opts);

describe("teamsSectionFor", () => {
  it("a member who may not connect their own account (no own_mail) gets no section and no read", async () => {
    let reads = 0;
    const r = await teamsSectionFor(guard("denied"), "PKG", async () => (reads++, []), async () => (reads++, enabled));
    expect(r).toBeNull();
    expect(reads).toBe(0);
  });

  it("enabled: the section with the person's rows and the lane's features; the mail providers are never asked (the loader has no way to)", async () => {
    const r = await section([row()], enabled);
    expect(r).toEqual({ connections: [row()], laneFeatures: ["chat_read", "call_links"], needsAdminConsent: false });
  });

  it("enabled with no rows: a section with no connections (Sign in is drawn)", async () => {
    expect(await section([], enabled)).toMatchObject({ connections: [] });
  });

  it("not enabled (no block, enabled false, an unserved cloud): no rows = no section; rows are kept and marked paused", async () => {
    for (const lane of [null, { ...enabled, enabled: false }, { ...enabled, cloudSupported: false }]) {
      expect(await section([], lane)).toBeNull();
      expect(await section([row()], lane)).toMatchObject({ paused: true, connections: [row()] });
    }
    // the Messages page keeps the empty view
    expect(await section([], null, { keepEmpty: true })).toMatchObject({ paused: true, connections: [] });
  });

  it("settings that cannot be read fail closed: no Sign in (settingsUnknown) for a person with rows, nothing for a person without", async () => {
    expect(await section([row()], new Error("x"))).toMatchObject({ settingsUnknown: true });
    expect(await section([], new Error("x"))).toBeNull();
    expect(await section([], new Error("x"), { keepEmpty: true })).toMatchObject({ settingsUnknown: true });
  });

  it("rows that cannot be read: an `unavailable` view when Teams is enabled (never 'not connected'), nothing otherwise", async () => {
    expect(await section(new Error("db"), enabled)).toMatchObject({ unavailable: true, connections: [] });
    expect(await section(new Error("db"), null)).toBeNull();
    expect(await section(new Error("db"), null, { keepEmpty: true })).toMatchObject({ unavailable: true });
  });

  it("an outage in the role check rethrows", async () => {
    await expect(teamsSectionFor({ requireRole: async () => { throw new Error("outage"); } } as never, "PKG", async () => [], async () => enabled)).rejects.toThrow("outage");
  });
});

describe("loadTeamsRows", () => {
  const client = (data: unknown, error: unknown = null) => {
    const seen: [string, unknown][] = [];
    const b: Record<string, unknown> = {};
    b.select = (c: string) => (seen.push(["select", c]), b);
    b.eq = (c: string, v: unknown) => (seen.push([c, v]), b);
    b.order = async () => ({ data, error });
    return { client: { schema: () => ({ from: () => b }) } as never, seen };
  };

  it("selects only the health columns of Teams rows of this lane (never the object id or a token column) and marks which are the caller's", async () => {
    const { client: c, seen } = client([
      { id: "a", external_account_id: "me@x.test", status: "active", owner_user_id: ME, features: { teams_chat_read: true, teams_channels_read: false } },
      { id: "b", external_account_id: "other@x.test", status: "reconnect_required", owner_user_id: "someone-else", features: {} },
      { id: "c", external_account_id: "bad@x.test", status: "weird", owner_user_id: ME, features: {} },
    ]);
    const rows = await loadTeamsRows(c, "PKG", ME);
    expect(seen).toEqual([["select", "id, external_account_id, status, owner_user_id, features"], ["lane_id", "PKG"], ["provider", "microsoft_teams"]]);
    expect(rows).toEqual([
      { id: "a", account: "me@x.test", state: "connected", mine: true, has: ["chat_read"] },
      { id: "b", account: "other@x.test", state: "reconnect_required", mine: false, has: [] },
    ]);
  });

  it("a database error throws (the page must not show 'not connected' for an outage)", async () => {
    await expect(loadTeamsRows(client(null, { message: "x" }).client, "PKG", ME)).rejects.toThrow();
  });
});
