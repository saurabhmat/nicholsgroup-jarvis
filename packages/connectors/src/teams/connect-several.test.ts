// T-294 (docs/specs/messages.md 22.3, 22.11, 22.12 tests 27 and 28): several Teams accounts of ONE person in one lane, on the real provider and flow over the in-memory twins and the MSW fake of Entra and Graph
// (two fake accounts of one fake tenant, on two sign-in domains). The limit is the lane setting `teams.max_accounts_per_person` (default 1). Synthetic data only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { TEAMS_ONE_ACCOUNT_MESSAGE } from "../contract/errors";
import { RateLimiter } from "../http/rate-limit";
import { createConnectHandlers } from "../oauth/handlers";
import { useMockServer } from "../testing/msw/index";
import { createFakeTeams } from "../testing/msw/teams/handlers";
import { createTeamsHarness, TEAMS_CONNECT_USER, TEAMS_OTHER_USER, TEAMS_TENANT_A, type TeamsLaneSetup } from "../testing/teams-harness";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const DOMAIN_A = "teams.example.test";
const DOMAIN_B = "second.example.test";
const FIRST = `person@${DOMAIN_A}`;
const SECOND = `person@${DOMAIN_B}`;
const THIRD = `person@third.example.test`;

function setup(limit: number, lane: Partial<TeamsLaneSetup> = {}) {
  const fake = createFakeTeams();
  server.use(...fake.handlers);
  const h = createTeamsHarness({
    fake,
    lanes: { PKG: { teams: { allowedDomains: [DOMAIN_A, DOMAIN_B, "third.example.test"], maxAccountsPerPerson: limit }, mailProviders: ["google"], ...lane }, APK: { teams: { allowedDomains: [DOMAIN_A, DOMAIN_B], maxAccountsPerPerson: 1 } } },
  });
  return { fake, h };
}
type Harness = ReturnType<typeof setup>["h"];
const message = (r: { ok: boolean; message?: string }) => (r.ok ? "" : (r.message ?? ""));
const mine = (h: Harness, laneId = "PKG") => [...h.rows.values()].filter((r) => r.lane_id === laneId && r.owner_user_id === TEAMS_CONNECT_USER);
const frozen = (h: Harness) => JSON.stringify({ rows: [...h.rows.values()], secrets: [...h.secrets.entries()], identities: [...h.identities.entries()], stores: h.stats.stores });

describe("connect another account (limit 2)", () => {
  it("two accounts of one person become two rows with their own identity, features and tokens; the first row is not touched by the second connect", async () => {
    const { fake, h } = setup(2);
    const one = await h.connectViaCallback("PKG", { upn: FIRST });
    expect(one.result.ok).toBe(true);
    const firstRow = mine(h)[0];
    expect(firstRow).toBeDefined();
    const firstId = firstRow?.id as string;
    const firstTokens = h.secrets.get(firstId);
    const firstIdentity = JSON.stringify(h.identities.get(firstId));
    const two = await h.connectViaCallback("PKG", { upn: SECOND });
    expect(two.result).toMatchObject({ ok: true, provider: "microsoft_teams" });
    expect(two.result.ok && two.result.detail).toBeFalsy();
    const rows = mine(h);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.external_account_id).sort()).toEqual([FIRST, SECOND].sort());
    expect(rows.every((r) => r.status === "active")).toBe(true);
    const secondId = rows.find((r) => r.external_account_id === SECOND)?.id as string;
    expect(secondId).not.toBe(firstId);
    expect(h.identities.get(secondId)).toEqual({ tenantId: TEAMS_TENANT_A, cloud: "commercial", entraObjectId: fake.accountFor(TEAMS_TENANT_A, SECOND)?.objectId });
    expect(h.identities.get(secondId)?.entraObjectId).not.toBe(h.identities.get(firstId)?.entraObjectId);
    expect(rows.every((r) => (r.features as Record<string, boolean>).teams_chat_read === true)).toBe(true);
    // the first row: tokens and identity byte for byte as they were
    expect(h.secrets.get(firstId)).toBe(firstTokens);
    expect(JSON.stringify(h.identities.get(firstId))).toBe(firstIdentity);
    expect(h.secrets.get(secondId)).not.toBe(firstTokens);
  });

  it("limit 3 with two accounts: choosing an account already connected refreshes it (already_connected), creates no row and leaves the other row alone", async () => {
    const { h } = setup(3);
    await h.connectViaCallback("PKG", { upn: FIRST });
    await h.connectViaCallback("PKG", { upn: SECOND });
    const firstId = mine(h).find((r) => r.external_account_id === FIRST)?.id as string;
    const secondId = mine(h).find((r) => r.external_account_id === SECOND)?.id as string;
    const firstTokens = h.secrets.get(firstId);
    const secondTokens = h.secrets.get(secondId);
    const again = await h.connectViaCallback("PKG", { upn: FIRST });
    expect(again.result).toMatchObject({ ok: true, connectionId: firstId, detail: "already_connected" });
    expect(mine(h)).toHaveLength(2);
    expect(h.secrets.get(firstId)).not.toBe(firstTokens); // refreshed
    expect(h.secrets.get(secondId)).toBe(secondTokens); // untouched
    // a genuinely new account is not "already connected"
    const third = await h.connectViaCallback("PKG", { upn: THIRD });
    expect(third.result.ok && third.result.detail).toBeFalsy();
    expect(mine(h)).toHaveLength(3);
  });

  it("a first connect of a disconnected account is a reconnect of its row, not 'already connected'", async () => {
    const { h } = setup(2);
    h.connect("PKG", FIRST, { owner: TEAMS_CONNECT_USER, status: "disconnected" });
    const r = await h.connectViaCallback("PKG", { upn: FIRST });
    expect(r.result.ok).toBe(true);
    expect(r.result.ok && r.result.detail).toBeFalsy();
  });
});

describe("the limit", () => {
  it("at the limit the START refuses before any state or redirect, for a first connect (limit 2, two accounts)", async () => {
    const { h } = setup(2);
    h.connect("PKG", FIRST, { owner: TEAMS_CONNECT_USER });
    h.connect("PKG", SECOND, { owner: TEAMS_CONNECT_USER });
    const before = frozen(h);
    await expect(h.flow.start("teams", "PKG", h.as(TEAMS_CONNECT_USER))).rejects.toMatchObject({ info: { kind: "forbidden", message: TEAMS_ONE_ACCOUNT_MESSAGE } });
    expect(h.states.size).toBe(0);
    expect(frozen(h)).toBe(before);
    expect(h.everyRequest()).toBe(0);
  });

  it("the start counts degraded and reconnect_required rows, not disconnected ones", async () => {
    const { h } = setup(2);
    h.connect("PKG", FIRST, { owner: TEAMS_CONNECT_USER, status: "reconnect_required" });
    h.connect("PKG", SECOND, { owner: TEAMS_CONNECT_USER, status: "degraded" });
    await expect(h.flow.start("teams", "PKG", h.as(TEAMS_CONNECT_USER))).rejects.toMatchObject({ info: { message: TEAMS_ONE_ACCOUNT_MESSAGE } });
    h.connect("PKG", THIRD, { owner: TEAMS_CONNECT_USER, status: "disconnected" });
    expect(mine(h)).toHaveLength(3);
    // another person is not affected by this person's rows (cross-user)
    await expect(h.flow.start("teams", "PKG", h.as(TEAMS_OTHER_USER))).resolves.toContain("prompt=select_account");
  });

  it("a crafted callback past the limit (a second tab connected the last slot after this start) is refused with the same fixed message; nothing is stored", async () => {
    const { h } = setup(2);
    h.connect("PKG", FIRST, { owner: TEAMS_CONNECT_USER });
    const before = frozen(h);
    const { result } = await h.connectViaCallback("PKG", {
      upn: THIRD,
      between: () => void h.connect("PKG", SECOND, { owner: TEAMS_CONNECT_USER }),
    });
    expect(result).toMatchObject({ ok: false, reason: "account_refused", detail: "one_account" });
    expect(message(result)).toContain(TEAMS_ONE_ACCOUNT_MESSAGE);
    const after = JSON.parse(frozen(h)) as { rows: { external_account_id: string; status: string }[]; stores: number };
    expect(after.stores).toBe((JSON.parse(before) as { stores: number }).stores);
    expect(after.rows.filter((r) => r.external_account_id === THIRD).every((r) => r.status === "pending")).toBe(true);
  });

  it("the token store refuses beyond the limit like the connections trigger (D0024 at the moment of activation)", async () => {
    const { h } = setup(2);
    const a = h.connect("PKG", FIRST, { owner: TEAMS_CONNECT_USER });
    h.connect("PKG", SECOND, { owner: TEAMS_CONNECT_USER });
    const pending = h.connect("PKG", THIRD, { owner: TEAMS_CONNECT_USER, status: "pending" });
    expect(a.row.status).toBe("active");
    await expect(h.vault.storeToken("PKG", pending.conn, (await h.vault.getToken("PKG", a.conn)) as never, null)).rejects.toMatchObject({ info: { kind: "forbidden", message: TEAMS_ONE_ACCOUNT_MESSAGE } });
    expect(pending.row.status).toBe("pending");
  });

  it("another lane's rows and another person's rows never count (cross-lane, cross-user)", async () => {
    const { h } = setup(2);
    h.connect("APK", `apk@${DOMAIN_A}`, { owner: TEAMS_CONNECT_USER });
    h.connect("PKG", SECOND, { owner: TEAMS_OTHER_USER });
    h.connect("PKG", THIRD, { owner: TEAMS_OTHER_USER });
    const one = await h.connectViaCallback("PKG", { upn: FIRST });
    expect(one.result.ok).toBe(true);
    const two = await h.connectViaCallback("PKG", { upn: `fourth@${DOMAIN_B}` });
    expect(two.result.ok).toBe(true);
    expect(mine(h)).toHaveLength(2);
    // the third is over the limit although the person's APK row and the other person's two rows are not theirs
    await expect(h.flow.start("teams", "PKG", h.as(TEAMS_CONNECT_USER))).rejects.toMatchObject({ info: { message: TEAMS_ONE_ACCOUNT_MESSAGE } });
  });

  it("limit lowered to 1 while two accounts exist: both keep working; a reconnect of a counted row is allowed; a disconnected row cannot come back; no new account", async () => {
    const { h } = setup(1);
    const a = h.connect("PKG", FIRST, { owner: TEAMS_CONNECT_USER, status: "reconnect_required" });
    const b = h.connect("PKG", SECOND, { owner: TEAMS_CONNECT_USER });
    const d = h.connect("PKG", THIRD, { owner: TEAMS_CONNECT_USER, status: "disconnected" });
    // a reconnect of a row that already counts is never refused by the limit
    const re = await h.connectViaCallback("PKG", { upn: FIRST, connectionId: a.row.id });
    expect(re.result).toMatchObject({ ok: true, connectionId: a.row.id });
    expect(a.row.status).toBe("active");
    expect(b.row.status).toBe("active");
    // the disconnected row cannot come back; a new account cannot be added
    await expect(h.flow.start("teams", "PKG", h.as(TEAMS_CONNECT_USER), { connectionId: d.row.id })).rejects.toMatchObject({ info: { message: TEAMS_ONE_ACCOUNT_MESSAGE } });
    await expect(h.flow.start("teams", "PKG", h.as(TEAMS_CONNECT_USER))).rejects.toMatchObject({ info: { message: TEAMS_ONE_ACCOUNT_MESSAGE } });
    expect(d.row.status).toBe("disconnected");
  });

  it("the start of a person's click lands back on Settings with the fixed one_account refusal (a script gets a plain 403); nothing from the request is copied", async () => {
    const { h } = setup(1);
    h.connect("PKG", FIRST, { owner: TEAMS_CONNECT_USER });
    const handlers = createConnectHandlers(h.flow, async () => h.as(TEAMS_CONNECT_USER));
    const form = { origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" };
    const res = await handlers.start(new Request("http://localhost:3000/api/connect/teams/start?lane=PKG", { method: "POST", headers: form }), "teams");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/PKG/settings?connect=account_refused&provider=microsoft_teams&detail=one_account");
    const script = await handlers.start(new Request("http://localhost:3000/api/connect/teams/start?lane=PKG", { method: "POST", headers: { ...form, "content-type": "application/json" } }), "teams");
    expect(script.status).toBe(403);
    expect(h.states.size).toBe(0);
  });
});

describe("reconnect of one account (two signed in)", () => {
  it("Microsoft answers as the OTHER account: wrong_account, nothing stored on either row, the row is named for the page; as the right account: tokens on that row only", async () => {
    const { h } = setup(2);
    const a = h.connect("PKG", FIRST, { owner: TEAMS_CONNECT_USER, status: "reconnect_required" });
    const b = h.connect("PKG", SECOND, { owner: TEAMS_CONNECT_USER, status: "reconnect_required" });
    const aTokens = h.secrets.get(a.row.id);
    const bTokens = h.secrets.get(b.row.id);
    const before = frozen(h);
    const wrong = await h.connectViaCallback("PKG", { upn: FIRST, connectionId: b.row.id });
    expect(wrong.result).toMatchObject({ ok: false, reason: "wrong_account", connectionId: b.row.id });
    expect(frozen(h)).toBe(before);
    expect(h.secrets.get(a.row.id)).toBe(aTokens);
    expect(h.secrets.get(b.row.id)).toBe(bTokens);
    const right = await h.connectViaCallback("PKG", { upn: SECOND, connectionId: b.row.id });
    expect(right.result).toMatchObject({ ok: true, connectionId: b.row.id });
    expect(right.result.ok && right.result.detail).toBeFalsy();
    expect(b.row.status).toBe("active");
    expect(h.secrets.get(b.row.id)).not.toBe(bTokens);
    expect(a.row.status).toBe("reconnect_required"); // the other account is not touched
    expect(h.secrets.get(a.row.id)).toBe(aTokens);
  });

  it("the redirect names the row (a uuid from the verified state) only for a refused Teams reconnect; never an address", async () => {
    const id = "00000000-0000-4000-8000-0000000000aa";
    const callbackWith = async (result: Record<string, unknown>) => {
      const flow = { has: () => true, start: async () => "", callback: async () => result };
      const res = await createConnectHandlers(flow as never, async () => (async () => ({ userId: "u", client: {} })) as never).callback(new Request("http://localhost:3000/api/connect/teams/callback?state=PKG.x"), "teams");
      return res.headers.get("location");
    };
    expect(await callbackWith({ ok: false, reason: "wrong_account", provider: "microsoft_teams", laneId: "PKG", connectionId: id })).toBe(`/PKG/settings?connect=wrong_account&provider=microsoft_teams&conn=${id}`);
    expect(await callbackWith({ ok: false, reason: "wrong_account", provider: "google", laneId: "PKG", connectionId: id })).toBe("/PKG/settings?connect=wrong_account&provider=google");
    expect(await callbackWith({ ok: false, reason: "wrong_account", provider: "microsoft_teams", laneId: "PKG", connectionId: "person@example.test" })).toBe("/PKG/settings?connect=wrong_account&provider=microsoft_teams");
    expect(await callbackWith({ ok: true, provider: "microsoft_teams", laneId: "PKG", connectionId: id, detail: "already_connected" })).toBe("/PKG/settings?connect=ok&provider=microsoft_teams&detail=already_connected");
    expect(await callbackWith({ ok: true, provider: "microsoft_teams", laneId: "PKG", connectionId: id, detail: "Bad Value" })).toBe("/PKG/settings?connect=ok&provider=microsoft_teams");
  });
});
