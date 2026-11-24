// The Teams health check and its skip (T-279): `GET /me` through the guarded client; it reports, never throws for connection problems, keeps nothing from the answer; the skip is a
// configuration choice, read once, with no Vault read and no request.
import { afterEach, describe, expect, it } from "vitest";
import { createTokenHealthJob } from "../health/job";
import { RateLimiter } from "../http/rate-limit";
import { useMockServer } from "../testing/msw/index";
import { createFakeTeams } from "../testing/msw/teams/handlers";
import { createTeamsHarness } from "../testing/teams-harness";
import { createTeamsHealthSkip } from "./health";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const PERSON = "person@teams.example.test";
function setup(teams: Record<string, unknown> | null = {}) {
  const fake = createFakeTeams();
  server.use(...fake.handlers);
  const h = createTeamsHarness({ fake, lanes: { PKG: { teams: teams as never, mailProviders: ["google"] } } });
  return { fake, h };
}

describe("health", () => {
  it("a healthy connection answers ok with `$select=id` only, and nothing of the answer is kept", async () => {
    const { h, fake } = setup();
    const { conn } = h.connect("PKG", PERSON);
    const res = await h.health("PKG", conn);
    expect(res).toMatchObject({ ok: true, status: "active", error: null });
    expect(fake.state.graphRequests).toHaveLength(1);
    expect(fake.state.graphRequests[0]).toMatchObject({ method: "GET", path: "/v1.0/me", search: "?%24select=id" });
    expect(JSON.stringify(res)).not.toContain("Synthetic Person");
  });

  it("a revoked grant is reconnect_required; a refusal by the lane (Teams switched off) is degraded with a fixed error and sends nothing", async () => {
    const { h, fake } = setup();
    const { conn, account } = h.connect("PKG", PERSON, { storedAccessExpired: true });
    account.revoked = true;
    expect(await h.health("PKG", conn)).toMatchObject({ ok: false, status: "reconnect_required" });
    const off = setup({ enabled: false });
    const c = off.h.connect("PKG", PERSON);
    expect(await off.h.health("PKG", c.conn)).toMatchObject({ ok: false, status: "degraded" });
    expect(off.fake.state.graphRequests).toHaveLength(0);
    void fake;
  });

  it("the skip: Teams off for the lane (no block, enabled false, an unserved cloud) is skipped; an enabled lane is not; a failed read throws", async () => {
    const mk = (settings: unknown) => createTeamsHealthSkip({ laneConfig: { teamsSettings: async () => settings as never } });
    expect(await mk(null)("PKG")).toBe(true);
    expect(await mk({ enabled: false, cloud: "commercial" })("PKG")).toBe(true);
    expect(await mk({ enabled: true, cloud: "gcc_high" })("PKG")).toBe(true);
    expect(await mk({ enabled: true, cloud: "commercial" })("PKG")).toBe(false);
    await expect(createTeamsHealthSkip({ laneConfig: { teamsSettings: async () => { throw new Error("x"); } } })("PKG")).rejects.toBeDefined();
  });

  it("registered with the daily job: a paused lane's Teams connection is skipped (nothing checked, changed or raised); an enabled one is checked", async () => {
    const off = setup({ enabled: false });
    const c = off.h.connect("PKG", PERSON);
    const job = (h: typeof off.h) =>
      createTokenHealthJob({
        loader: { loadConnection: async () => c.conn } as never,
        store: { applyHealth: async () => true, clearHealthError: async () => true, reconnectNoticePending: async () => false, markReconnectNotified: async () => undefined, listUsableConnectionIds: async () => [] } as never,
        checkers: { microsoft_teams: h.health as never },
        skips: { microsoft_teams: createTeamsHealthSkip({ laneConfig: h.laneConfig }) },
      });
    expect(await job(off.h).run("PKG", c.conn.id)).toMatchObject({ ok: true, skipped: "connection_not_usable", alerts: [] });
    expect(off.fake.state.graphRequests).toHaveLength(0);
  });
});
