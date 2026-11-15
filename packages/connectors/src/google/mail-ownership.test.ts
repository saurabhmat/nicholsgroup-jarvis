// T-247: Google accounts by domain (connect and every call), the exact mailbox list as an extra narrowing, and mailbox ownership at connect.
// Mocks only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { createGoogleHarness } from "../testing/google-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeGoogle } from "../testing/msw/google/handlers";
import { createGmailProvider } from "./mail";

const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
});

const ROBERT = "00000000-0000-4000-8000-00000000b001";
const SAURABH = "00000000-0000-4000-8000-00000000b002";

function setup(opts: { mailboxes?: Record<string, string[]>; mailDomains?: Record<string, string[]> } = {}) {
  const fake = createFakeGoogle();
  server.use(...fake.handlers);
  return { fake, h: createGoogleHarness({ fake, mailboxes: opts.mailboxes ?? { PKG: [] }, mailDomains: opts.mailDomains ?? { PKG: ["example.test", "mail.example.test"] } }) };
}

describe("connect by domain", () => {
  it("accepts accounts on any allowed domain with no exact list (the domain list alone decides)", async () => {
    const { h } = setup();
    expect((await h.connectViaCallback("PKG", { email: "ann@example.test", userId: ROBERT })).result.ok).toBe(true);
    expect((await h.connectViaCallback("PKG", { email: "bob@mail.example.test", userId: ROBERT })).result.ok).toBe(true);
  });
  it("refuses a domain that is not allowed (a gmail.com style account included), stores nothing", async () => {
    const { h } = setup();
    const { result } = await h.connectViaCallback("PKG", { email: "someone@gmail.example.test", userId: ROBERT });
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(h.secrets.size).toBe(0);
    expect(h.rows.size).toBe(0);
  });
  it("fails closed with no allowed domain: no code is exchanged at all, even when the exact list names the address", async () => {
    const { fake, h } = setup({ mailboxes: { PKG: ["ann@example.test"] }, mailDomains: { PKG: [] } });
    const { result } = await h.connectViaCallback("PKG", { email: "ann@example.test", userId: ROBERT });
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(fake.state.tokenRequests).toEqual([]);
  });
  it("narrows with the exact list when the lane keeps one: the address must be on an allowed domain AND on the list", async () => {
    const { h } = setup({ mailboxes: { PKG: ["ann@example.test"] } });
    expect((await h.connectViaCallback("PKG", { email: "ann@example.test", userId: ROBERT })).result.ok).toBe(true);
    expect((await h.connectViaCallback("PKG", { email: "bob@example.test", userId: ROBERT })).result).toMatchObject({ ok: false, reason: "account_refused" });
  });
});

describe("every Google call re-checks the domain (in addition to D-23)", () => {
  it("a domain removed from the lane stops a mailbox working before any request; an empty list stops everything", async () => {
    const { fake, h } = setup();
    const { result } = await h.connectViaCallback("PKG", { email: "ann@example.test", userId: ROBERT });
    expect(result.ok).toBe(true);
    const conn = h.bind([...h.rows.values()][0] as never);
    const mail = createGmailProvider({ api: h.api, connections: h.connections, laneConfig: h.laneConfig });
    const before = fake.state.tokenRequests.length;
    h.mailDomains.PKG = ["mail.example.test"];
    await expect(mail.search("PKG", conn, { query: "budget" })).rejects.toMatchObject({ info: { kind: "forbidden" } });
    h.mailDomains.PKG = [];
    await expect(mail.search("PKG", conn, { query: "budget" })).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(fake.state.tokenRequests.length).toBe(before);
  });
});

describe("a mailbox has one owner", () => {
  it("sets the owner to the signed-in user who connected it", async () => {
    const { h } = setup();
    await h.connectViaCallback("PKG", { email: "ann@example.test", userId: ROBERT });
    expect([...h.rows.values()][0]?.owner_user_id).toBe(ROBERT);
  });
  it("refuses another user connecting an account that already has an owner here: nothing is stored for them", async () => {
    const { h } = setup();
    await h.connectViaCallback("PKG", { email: "ann@example.test", userId: ROBERT });
    const tokensBefore = h.stats.stores;
    const { result } = await h.connectViaCallback("PKG", { email: "ann@example.test", userId: SAURABH });
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(result.ok ? "" : result.message).toMatch(/another person/i);
    expect(h.stats.stores).toBe(tokensBefore);
    expect([...h.rows.values()][0]?.owner_user_id).toBe(ROBERT);
  });
  it("lets one user connect several accounts, each owned by them", async () => {
    const { h } = setup();
    await h.connectViaCallback("PKG", { email: "ann@example.test", userId: SAURABH });
    await h.connectViaCallback("PKG", { email: "ann2@mail.example.test", userId: SAURABH });
    expect([...h.rows.values()].map((r) => r.owner_user_id)).toEqual([SAURABH, SAURABH]);
  });
});
