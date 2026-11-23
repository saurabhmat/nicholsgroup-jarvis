// The inline-image reader (T-285): the type comes from the bytes, never from Microsoft's header; the cap stops the read; ids are checked before any request; the owner, lane and feature rules of
// the guard apply; failures keep their kind and are never retried; nothing (bytes, ids, canary) reaches a log, a stored write or an error. MSW fake of Graph, synthetic data.
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { useMockServer } from "../testing/msw/index";
import { createFakeTeams } from "../testing/msw/teams/handlers";
import { createTeamsHarness, TEAMS_OWNER } from "../testing/teams-harness";
import { HOSTED_IMAGE_MAX_BYTES } from "./hosted-content";
import { createTeamsImageReader } from "./images";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const CHAT = "19:abc123def456@thread.v2";
const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1";
const CH = "19:general111@thread.tacv2";
const MSG = "1700000000123";
const HID = "aWQ9eF8wLXdldS1kMS0x";
const CANARY = "canary-image-bytes-71c0e5-not-real";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(CANARY)]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]);
const GIF = Uint8Array.from([...Buffer.from("GIF89a"), 1, 0, 1, 0]);
const WEBP = Uint8Array.from([...Buffer.from("RIFF"), 4, 0, 0, 0, ...Buffer.from("WEBPVP8 ")]);
const chatKey = `chats/${CHAT}/messages/${MSG}/${HID}`;
const chanKey = `teams/${T1}/channels/${CH}/messages/${MSG}/${HID}`;
const CHAT_T = { kind: "chat" as const, chatId: CHAT, messageId: MSG, hostedId: HID };
const CHAN_T = { kind: "channel" as const, teamId: T1, channelId: CH, messageId: MSG, hostedId: HID };

function setup(opts: { features?: ("chat_read" | "channels_read")[]; laneFeatures?: ("chat_read" | "channels_read")[]; timeoutMs?: number } = {}) {
  const fake = createFakeTeams();
  server.use(...fake.handlers);
  const h = createTeamsHarness({ fake, lanes: { PKG: { teams: { features: opts.laneFeatures ?? ["chat_read", "channels_read"] }, mailProviders: ["google"] } } });
  const c = h.connect("PKG", "person@teams.example.test", { features: opts.features ?? ["chat_read", "channels_read"] });
  const api = opts.timeoutMs ? { get: (l: never, cn: never, req: object) => h.api.get(l, cn, { ...req, timeoutMs: opts.timeoutMs } as never) } : h.api;
  return { fake, h, conn: c.conn, reader: createTeamsImageReader({ api: api as never }) };
}

describe("the bytes of a hosted content", () => {
  it("a chat message's picture: the exact fixed template, the type from the bytes (PNG, JPEG, GIF, WebP)", async () => {
    const { fake, reader, conn } = setup();
    for (const [bytes, type] of [[PNG, "image/png"], [JPEG, "image/jpeg"], [GIF, "image/gif"], [WEBP, "image/webp"]] as const) {
      fake.state.hosted.set(chatKey, { body: bytes, contentType: "application/octet-stream" }); // Microsoft's header is not looked at
      const r = await reader.fetchHostedImage("PKG", conn, TEAMS_OWNER, CHAT_T);
      expect(r).toMatchObject({ ok: true, contentType: type });
      if (r.ok) expect([...r.bytes]).toEqual([...bytes]);
    }
    const last = fake.state.graphRequests.at(-1);
    expect([last?.method, last?.path, last?.search]).toEqual(["GET", `/v1.0/chats/${encodeURIComponent(CHAT)}/messages/${MSG}/hostedContents/${HID}/$value`, ""]);
  });

  it("a channel post's picture uses the channel template; the feature is channels_read", async () => {
    const { fake, reader, conn } = setup();
    fake.state.hosted.set(chanKey, { body: PNG });
    expect(await reader.fetchHostedImage("PKG", conn, TEAMS_OWNER, CHAN_T)).toMatchObject({ ok: true, contentType: "image/png" });
    expect(fake.state.graphRequests.at(-1)?.path).toBe(`/v1.0/teams/${T1}/channels/${encodeURIComponent(CH)}/messages/${MSG}/hostedContents/${HID}/$value`);
    const chatOnly = setup({ features: ["chat_read"] });
    chatOnly.fake.state.hosted.set(chanKey, { body: PNG });
    await expect(chatOnly.reader.fetchHostedImage("PKG", chatOnly.conn, TEAMS_OWNER, CHAN_T)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(chatOnly.fake.state.graphRequests).toHaveLength(0);
    expect(chatOnly.h.stats.tokenReads).toBe(0);
    // and a chat picture needs chat_read: a channels-only company/connection is refused
    const channelsOnly = setup({ features: ["channels_read"], laneFeatures: ["channels_read"] });
    channelsOnly.fake.state.hosted.set(chatKey, { body: PNG });
    await expect(channelsOnly.reader.fetchHostedImage("PKG", channelsOnly.conn, TEAMS_OWNER, CHAT_T)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(channelsOnly.fake.state.graphRequests).toHaveLength(0);
  });

  it("a lying or missing content type changes nothing: bytes that are not an image are refused whatever the header says (SVG, HTML, script, PDF, text, empty)", async () => {
    const { fake, reader, conn } = setup();
    const cases: [string, string | Uint8Array, string | null][] = [
      ["svg with image header", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "image/png"],
      ["svg with its own header", '<svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml"],
      ["html with png header", "<!doctype html><script>alert(1)</script>", "image/png"],
      ["js with jpeg header", "alert(1)", "image/jpeg"],
      ["pdf", "%PDF-1.7 ....", "application/pdf"],
      ["no header", "plain text", null],
      ["png magic cut short", Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), "image/png"],
      ["empty", new Uint8Array(0), "image/png"],
    ];
    for (const [name, body, contentType] of cases) {
      fake.state.hosted.set(chatKey, { body, contentType });
      expect(await reader.fetchHostedImage("PKG", conn, TEAMS_OWNER, CHAT_T), name).toEqual({ ok: false, reason: "not_image" });
    }
  });

  it("an image whose header says text/html is still a PNG by its bytes, and is served as image/png (the type is decided here)", async () => {
    const { fake, reader, conn } = setup();
    fake.state.hosted.set(chatKey, { body: PNG, contentType: "text/html" });
    expect(await reader.fetchHostedImage("PKG", conn, TEAMS_OWNER, CHAT_T)).toMatchObject({ ok: true, contentType: "image/png" });
  });

  it("too large: a declared length over the cap and an endless body without one are both refused, and the read is stopped", async () => {
    const { fake, reader, conn } = setup();
    fake.state.hosted.set(chatKey, { body: new Uint8Array(HOSTED_IMAGE_MAX_BYTES + 1) });
    expect(await reader.fetchHostedImage("PKG", conn, TEAMS_OWNER, CHAT_T)).toEqual({ ok: false, reason: "too_large" });
    fake.state.hosted.set(chatKey, { endless: true });
    expect(await reader.fetchHostedImage("PKG", conn, TEAMS_OWNER, CHAT_T)).toEqual({ ok: false, reason: "too_large" });
    // exactly at the cap with a valid header is accepted
    const at = new Uint8Array(HOSTED_IMAGE_MAX_BYTES);
    at.set(PNG);
    fake.state.hosted.set(chatKey, { body: at });
    expect(await reader.fetchHostedImage("PKG", conn, TEAMS_OWNER, CHAT_T)).toMatchObject({ ok: true });
  });

  it("an id that is not in that message is Microsoft's 404 (not_found); 403, 429, 5xx and a timeout keep their kind, each with ONE request (no retry)", async () => {
    const { fake, reader, conn } = setup();
    await expect(reader.fetchHostedImage("PKG", conn, TEAMS_OWNER, { ...CHAT_T, hostedId: "someOtherId" })).rejects.toMatchObject({ info: { kind: "not_found" } });
    for (const [status, kind] of [[403, "forbidden"], [429, "rate_limited"], [500, "transient"], [503, "transient"]] as const) {
      fake.state.hosted.set(chatKey, { status, headers: status === 429 ? { "retry-after": "9" } : {} });
      const before = fake.state.graphRequests.length;
      await expect(reader.fetchHostedImage("PKG", conn, TEAMS_OWNER, CHAT_T), String(status)).rejects.toMatchObject({ info: { kind, ...(status === 429 ? { retry_after_seconds: 9 } : {}) } });
      expect(fake.state.graphRequests.length - before, String(status)).toBe(1);
    }
    const slow = setup({ timeoutMs: 1000 });
    slow.fake.state.hosted.set(chatKey, { body: PNG, delayMs: 1600 });
    await expect(slow.reader.fetchHostedImage("PKG", slow.conn, TEAMS_OWNER, CHAT_T)).rejects.toMatchObject({ info: { kind: "timeout" } });
    expect(slow.fake.state.graphRequests).toHaveLength(1);
  });

  it("ids are validated before any request: path injection in the chat, team, channel, message or hosted id makes no request and reads no token", async () => {
    const { fake, h, reader, conn } = setup();
    const bad: object[] = [
      { ...CHAT_T, chatId: "19:a/../../b@thread.v2" },
      { ...CHAT_T, chatId: "19:a%2Fb@thread.v2" },
      { ...CHAT_T, chatId: "../x" },
      { ...CHAT_T, messageId: "../hostedContents" },
      { ...CHAT_T, messageId: "1/2" },
      { ...CHAT_T, hostedId: ".." },
      { ...CHAT_T, hostedId: "a/b" },
      { ...CHAT_T, hostedId: "a?x=1" },
      { ...CHAT_T, hostedId: "a#b" },
      { ...CHAT_T, hostedId: "a\\b" },
      { ...CHAT_T, hostedId: "" },
      { ...CHAT_T, hostedId: "x".repeat(300) },
      { ...CHAN_T, teamId: "../x" },
      { ...CHAN_T, teamId: T1.toUpperCase() },
      { ...CHAN_T, channelId: "19:a/b@thread.tacv2" },
      { ...CHAN_T, hostedId: "%2e%2e" },
    ];
    for (const t of bad) await expect(reader.fetchHostedImage("PKG", conn, TEAMS_OWNER, t as never), JSON.stringify(t)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(fake.state.graphRequests).toHaveLength(0);
    expect(h.stats.tokenReads).toBe(0);
  });

  it("owner, lane and sign-in: another person (an admin) and another lane are refused before a token is read", async () => {
    const { fake, h, reader, conn } = setup();
    fake.state.hosted.set(chatKey, { body: PNG });
    await expect(reader.fetchHostedImage("PKG", conn, "00000000-0000-4000-8000-0000000b0279", CHAT_T)).rejects.toMatchObject({ info: { kind: "not_found" } });
    await expect(reader.fetchHostedImage("NC" as never, conn, TEAMS_OWNER, CHAT_T)).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
    expect(fake.state.graphRequests).toHaveLength(0);
    expect(h.stats.tokenReads).toBe(0);
  });

  it("canary: the bytes, the chat, message and hosted ids never reach a log line, an audit row, a stored write or an error", async () => {
    const { fake, h, reader, conn } = setup();
    fake.state.hosted.set(chatKey, { body: PNG });
    const writes = h.writeCount();
    await reader.fetchHostedImage("PKG", conn, TEAMS_OWNER, CHAT_T);
    fake.state.hosted.set(chatKey, { status: 500 });
    const e = await reader.fetchHostedImage("PKG", conn, TEAMS_OWNER, CHAT_T).catch((x: unknown) => x);
    fake.state.hosted.set(chatKey, { body: new Uint8Array(HOSTED_IMAGE_MAX_BYTES + 1) });
    await reader.fetchHostedImage("PKG", conn, TEAMS_OWNER, CHAT_T);
    expect(h.writeCount()).toBe(writes);
    const all = JSON.stringify([h.logs, h.audits, h.apiErrors, e]);
    for (const secret of [CANARY, "abc123def456", MSG, HID]) expect(all, secret).not.toContain(secret);
  });
});
