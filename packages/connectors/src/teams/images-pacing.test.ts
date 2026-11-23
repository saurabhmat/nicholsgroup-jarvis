// Pictures never starve or block the person's other Teams reads and never wait unbounded (T-285 review M3): their own two slots, their own 1-per-second buckets (chat and channel), a bounded wait
// that ends as `rate_limited`, cancellation that frees the slot and the place in the bucket, and no error row for a picture that is gone. MSW fake, synthetic data, real timers.
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { useMockServer } from "../testing/msw/index";
import { createFakeTeams } from "../testing/msw/teams/handlers";
import { createTeamsHarness, TEAMS_OWNER } from "../testing/teams-harness";
import { createTeamsApi, resetPictureForbiddenForTests } from "./api";
import { createTeamsImageReader } from "./images";
import { createTeamsReader } from "./reader";

const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
  resetPictureForbiddenForTests();
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const chatId = (n: number) => `19:chat${String(n).padStart(3, "0")}@thread.v2`;
const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1";
const CH = "19:general111@thread.tacv2";

function setup(imageMaxWaitMs?: number) {
  const fake = createFakeTeams();
  server.use(...fake.handlers);
  const h = createTeamsHarness({ fake, lanes: { PKG: { teams: { features: ["chat_read", "channels_read"] }, mailProviders: ["google"] } }, ...(imageMaxWaitMs ? { imageMaxWaitMs } : {}) });
  const c = h.connect("PKG", "person@teams.example.test", { features: ["chat_read", "channels_read"] });
  // the harness runs the rate limiter on a virtual clock (a pause costs no real time); the bound on waiting is real time, so the pacing tests use the same guard and tokens with the REAL clock
  const realApi = createTeamsApi({ guard: h.guard, tokens: h.tokens, errors: h.errors, ...(imageMaxWaitMs ? { imageMaxWaitMs } : {}) });
  return { fake, h, conn: c.conn, images: createTeamsImageReader({ api: realApi }), reader: createTeamsReader({ api: realApi }) };
}
const target = (n: number, hosted = "h1") => ({ kind: "chat" as const, chatId: chatId(n), messageId: "1700000000001", hostedId: hosted });
const key = (n: number, hosted = "h1") => `chats/${chatId(n)}/messages/1700000000001/${hosted}`;

describe("their own slots", () => {
  it("a message list with 30 pictures does not delay a concurrent chat-list read or a read of older messages (the shared slots stay free)", async () => {
    const { fake, images, reader, conn } = setup();
    for (let n = 0; n < 30; n++) fake.state.hosted.set(key(n), { body: PNG, delayMs: 150 });
    fake.state.chatPages = [[]];
    const pics = Promise.allSettled(Array.from({ length: 30 }, (_, n) => images.fetchHostedImage("PKG", conn, TEAMS_OWNER, target(n))));
    await new Promise((r) => setTimeout(r, 50)); // the pictures are queued and running
    const t0 = Date.now();
    await reader.listChats("PKG", conn, TEAMS_OWNER);
    await reader.listMessages("PKG", conn, TEAMS_OWNER, chatId(900), {}).catch(() => undefined);
    expect(Date.now() - t0).toBeLessThan(700); // picture 1 of 15 rounds of 150 ms would be ~2 s behind
    const done = await pics;
    expect(done.every((d) => d.status === "fulfilled")).toBe(true);
    // never more than two pictures in flight at once: 30 pictures of 150 ms need at least 15 rounds
    expect(Date.now() - t0).toBeGreaterThan(1500);
  }, 20_000);

  it("a channel's pictures have their own bucket, apart from its posts: a picture does not delay the posts of the same channel", async () => {
    const { fake, h, reader: _r, conn } = setup();
    void _r;
    fake.state.hosted.set(`teams/${T1}/channels/${CH}/messages/1700000000001/h1`, { body: PNG });
    fake.state.channelMessages.set(`${T1}/${CH}`, []);
    const images = createTeamsImageReader({ api: h.api });
    await images.fetchHostedImage("PKG", conn, TEAMS_OWNER, { kind: "channel", teamId: T1, channelId: CH, messageId: "1700000000001", hostedId: "h1" });
    const t0 = Date.now();
    await h.api.get("PKG", conn, { path: "/teams/{teamId}/channels/{channelId}/messages", params: { teamId: T1, channelId: CH }, query: { $top: 20 }, actor: { kind: "user", userId: TEAMS_OWNER }, retry: false });
    expect(Date.now() - t0).toBeLessThan(500); // the posts bucket was not used by the picture
  });
});

describe("bounded waiting and cancellation", () => {
  it("past the bounded wait a picture ends as rate_limited at once (no sleeping on): the 1-per-second bucket of one chat with a 1.5 s bound", async () => {
    const { fake, images, conn } = setup(1500);
    fake.state.hosted.set(key(1, "a"), { body: PNG });
    fake.state.hosted.set(key(1, "b"), { body: PNG });
    fake.state.hosted.set(key(1, "c"), { body: PNG });
    const t0 = Date.now();
    const out = await Promise.allSettled([images.fetchHostedImage("PKG", conn, TEAMS_OWNER, target(1, "a")), images.fetchHostedImage("PKG", conn, TEAMS_OWNER, target(1, "b")), images.fetchHostedImage("PKG", conn, TEAMS_OWNER, target(1, "c"))]);
    // the first starts at once, the second after ~1 s; the third would start at ~2 s, past the bound
    expect(out.map((o) => o.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    expect((out[2] as PromiseRejectedResult).reason).toMatchObject({ info: { kind: "rate_limited", retry_after_seconds: 2 } });
    expect(Date.now() - t0).toBeLessThan(2400);
    expect(fake.state.graphRequests).toHaveLength(2); // the refused one sent nothing
  }, 10_000);

  it("a picture waiting for one of the two slots is bounded too", async () => {
    const { fake, images, conn } = setup(600);
    for (let n = 0; n < 3; n++) fake.state.hosted.set(key(n), { body: PNG, delayMs: 1200 });
    const out = await Promise.allSettled([0, 1, 2].map((n) => images.fetchHostedImage("PKG", conn, TEAMS_OWNER, target(n))));
    expect(out.map((o) => o.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    expect((out[2] as PromiseRejectedResult).reason).toMatchObject({ info: { kind: "rate_limited" } });
  }, 10_000);

  it("an aborted picture frees its place in the bucket and its slot: the next one is not made to wait for it", async () => {
    const { fake, images, conn } = setup(10_000);
    for (const id of ["a", "b", "c"]) fake.state.hosted.set(key(1, id), { body: PNG });
    await images.fetchHostedImage("PKG", conn, TEAMS_OWNER, target(1, "a")); // uses this second of the bucket
    const ctl = new AbortController();
    const waiting = images.fetchHostedImage("PKG", conn, TEAMS_OWNER, target(1, "b"), ctl.signal);
    await new Promise((r) => setTimeout(r, 100));
    ctl.abort();
    await expect(waiting).rejects.toBeTruthy();
    const before = fake.state.graphRequests.length;
    const t0 = Date.now();
    await images.fetchHostedImage("PKG", conn, TEAMS_OWNER, target(1, "c"));
    expect(Date.now() - t0).toBeLessThan(1500); // one bucket interval after "a", not two
    expect(fake.state.graphRequests.length - before).toBe(1); // "b" was never sent
  }, 10_000);

  it("an aborted slot wait frees the slot: both slots busy, a waiter aborted, then a new picture takes the freed slot", async () => {
    const { fake, images, conn } = setup(10_000);
    for (let n = 0; n < 4; n++) fake.state.hosted.set(key(n), { body: PNG, delayMs: 300 });
    const ctl = new AbortController();
    const a = images.fetchHostedImage("PKG", conn, TEAMS_OWNER, target(0));
    const b = images.fetchHostedImage("PKG", conn, TEAMS_OWNER, target(1));
    const gone = images.fetchHostedImage("PKG", conn, TEAMS_OWNER, target(2), ctl.signal);
    await new Promise((r) => setTimeout(r, 50));
    ctl.abort();
    await expect(gone).rejects.toBeTruthy();
    await Promise.all([a, b]);
    expect(await images.fetchHostedImage("PKG", conn, TEAMS_OWNER, target(3))).toMatchObject({ ok: true });
    expect(fake.state.graphRequests.map((r) => r.path).filter((p) => p.includes(encodeURIComponent(chatId(2))))).toEqual([]);
  }, 10_000);

  it("a caller that aborts is an abort, not a rate_limited answer", async () => {
    const { fake, images, conn } = setup(10_000);
    fake.state.hosted.set(key(1, "a"), { body: PNG });
    fake.state.hosted.set(key(1, "b"), { body: PNG });
    await images.fetchHostedImage("PKG", conn, TEAMS_OWNER, target(1, "a"));
    const ctl = new AbortController();
    const p = images.fetchHostedImage("PKG", conn, TEAMS_OWNER, target(1, "b"), ctl.signal);
    setTimeout(() => ctl.abort(), 50);
    const e = (await p.catch((x: unknown) => x)) as { info?: { kind?: string } };
    expect(e?.info?.kind).not.toBe("rate_limited");
  });
});

describe("only the wait cap is relabelled rate_limited", () => {
  it("a guard or database error thrown AFTER the cap has expired keeps its own kind", async () => {
    const fake = createFakeTeams();
    server.use(...fake.handlers);
    const h = createTeamsHarness({ fake, lanes: { PKG: { teams: { features: ["chat_read"] }, mailProviders: ["google"] } } });
    const c = h.connect("PKG", "person@teams.example.test", { features: ["chat_read"] });
    const boom = new Error("database went away");
    const slowGuard = async (...a: Parameters<typeof h.guard>) => {
      await new Promise((r) => setTimeout(r, 120)); // the 50 ms cap expires while the guard runs
      if (a.length) throw boom;
      return h.guard(...a);
    };
    const api = createTeamsApi({ guard: slowGuard as never, tokens: h.tokens, imageMaxWaitMs: 50 });
    const e = await createTeamsImageReader({ api }).fetchHostedImage("PKG", c.conn, TEAMS_OWNER, target(1)).catch((x: unknown) => x);
    expect(e).toBe(boom);
  });
});

describe("no error rows for content someone else wrote (L5)", () => {
  it("a 404 or 403 of a picture adds no row to the API error store; a 404 of any other template still does", async () => {
    const { fake, h, images, reader, conn } = setup();
    await expect(images.fetchHostedImage("PKG", conn, TEAMS_OWNER, target(1, "gone"))).rejects.toMatchObject({ info: { kind: "not_found" } });
    expect(h.apiErrors).toHaveLength(0); // a 404 is never recorded
    // a 403 is recorded at most once per connection per hour: a signal for a tenant-wide problem, not a row per view
    for (const id of ["no1", "no2", "no3"]) fake.state.hosted.set(key(1, id), { status: 403 });
    for (const id of ["no1", "no2", "no3"]) await expect(images.fetchHostedImage("PKG", conn, TEAMS_OWNER, target(1, id))).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(h.apiErrors).toHaveLength(1);
    h.apiErrors.length = 0;
    fake.state.hosted.set(key(1, "boom"), { status: 500 });
    await expect(images.fetchHostedImage("PKG", conn, TEAMS_OWNER, target(1, "boom"))).rejects.toBeTruthy();
    const afterServerError = h.apiErrors.length;
    await expect(reader.getChat("PKG", conn, TEAMS_OWNER, chatId(7))).rejects.toMatchObject({ info: { kind: "not_found" } });
    expect(h.apiErrors.length).toBeGreaterThan(afterServerError); // other templates keep recording
  });
});
