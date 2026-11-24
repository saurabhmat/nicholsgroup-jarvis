// GET /api/lanes/<lane>/messages/image (T-285, T-291): who may call it (same site, lane, AAL2 + own_mail, the Messages module, the person's OWN usable Teams connection, never an admin's view of
// someone else's), the strict address (each parameter once, only the five known, every id valid), the feature per kind, the answer's headers, and fixed failure codes. The image reader is
// faked here (its type sniffing, size cap, id checks and Graph behaviour are tested in packages/connectors); a hand-written Response proves what the route sends.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";

const reader = vi.hoisted(() => ({ fetchHostedImage: vi.fn(), resolveCallTargets: vi.fn(), listMessages: vi.fn() }));
vi.mock("@nichols/connectors/teams-reader", () => ({ fetchHostedImage: reader.fetchHostedImage, resolveCallTargets: reader.resolveCallTargets, listMessages: reader.listMessages, listChats: vi.fn(), openChat: vi.fn() }));

import { createTeamsRoutes, type TeamsRouteDeps } from "@/lib/teams-api";
import { encodeChatKey } from "@/lib/teams-chat-key";

const ME = "00000000-0000-4000-8000-0000000000aa";
const CONN = "00000000-0000-4000-8000-0000000000c1";
const OTHER_CONN = "00000000-0000-4000-8000-0000000000c2";
const CHAT = "19:abc123def456@thread.v2";
const KEY = encodeChatKey(CHAT);
const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1";
const CHANNEL = "19:general111@thread.tacv2";
const CKEY = encodeChatKey(CHANNEL);
const MSG = "1700000000123";
const HID = "aWQ9eF8wLXdl";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const row = (over: Record<string, unknown> = {}) => ({ id: CONN, account: "me@teams.example.test", state: "connected", mine: true, has: ["chat_read", "call_links", "channels_read"], ...over });

function setup(opts: { rows?: unknown[]; gateVisible?: boolean; laneError?: unknown; roleError?: unknown } = {}) {
  const roles: unknown[] = [];
  const client = { schema: () => ({ rpc: async () => ({ data: null, error: null }) }) };
  const deps: TeamsRouteDeps = {
    guards: async () => ({
      requireLane: async () => {
        if (opts.laneError) throw opts.laneError;
        return { client, session: { userId: ME } } as never;
      },
      requireRole: async (_l: unknown, r: unknown) => {
        roles.push(r);
        if (opts.roleError) throw opts.roleError;
        return { client, session: { userId: ME } } as never;
      },
    }),
    gate: async () => ({ limited: false, newsShown: true, visible: () => opts.gateVisible !== false }),
    rows: async () => (opts.rows ?? [row()]) as never,
  };
  return { routes: createTeamsRoutes(deps), roles };
}
const SAME = { "sec-fetch-site": "same-origin" };
const get = (qs: string, headers: Record<string, string> = SAME, method = "GET") => new Request(`http://localhost:3000/api/lanes/PKG/messages/image?${qs}`, { method, headers });
const chatQ = `conn=${CONN}&chat=${KEY}&message=${MSG}&hosted=${HID}`;
const chanQ = `conn=${CONN}&team=${TEAM}&channel=${CKEY}&message=${MSG}&hosted=${HID}`;

beforeEach(() => {
  reader.fetchHostedImage.mockReset();
  reader.fetchHostedImage.mockResolvedValue({ ok: true, bytes: PNG, contentType: "image/png" });
});

describe("who may ask", () => {
  it("cross-site and a bad lane are refused before anything is read; no session is 401, a missing lane membership 404, AAL1 or a role without own_mail 403", async () => {
    const { routes, roles } = setup();
    expect((await routes.image(get(chatQ, { "sec-fetch-site": "cross-site" }), "PKG")).status).toBe(403);
    expect((await routes.image(get(chatQ, { "sec-fetch-site": "same-site" }), "PKG")).status).toBe(403);
    expect((await routes.image(get(chatQ), "pkg")).status).toBe(404);
    expect((await routes.image(get(chatQ), "../x")).status).toBe(404);
    expect(roles).toEqual([]);
    expect(reader.fetchHostedImage).not.toHaveBeenCalled();
    expect((await setup({ roleError: new AuthError("no_session") }).routes.image(get(chatQ), "PKG")).status).toBe(401);
    expect((await setup({ roleError: new AuthError("mfa_required") }).routes.image(get(chatQ), "PKG")).status).toBe(403);
    expect((await setup({ roleError: new AuthError("forbidden") }).routes.image(get(chatQ), "PKG")).status).toBe(403);
    expect((await setup({ laneError: new AuthError("forbidden") }).routes.image(get(chatQ), "PKG")).status).toBe(404); // another lane
    expect((await setup({ gateVisible: false }).routes.image(get(chatQ), "PKG")).status).toBe(404);
    expect(reader.fetchHostedImage).not.toHaveBeenCalled();
  });

  it("the own_mail roles are asked for; only the person's OWN usable connection is used (another person's row, a paused or reconnect row, none: 404 and no Graph call); a connection id in the address is ignored", async () => {
    const a = setup();
    await a.routes.image(get(chatQ), "PKG");
    expect(a.roles).toEqual([["owner", "admin_technical", "viewer"]]);
    for (const rows of [[], [row({ id: OTHER_CONN, mine: false })], [row({ state: "paused" })]]) {
      expect((await setup({ rows }).routes.image(get(chatQ), "PKG")).status).toBe(404);
    }
    expect((await setup({ rows: [row({ state: "reconnect_required" })] }).routes.image(get(chatQ), "PKG")).status).toBe(409); // the person's own expired sign-in is said, nothing else
    expect((await setup().routes.image(get(chatQ.replace(/conn=[^&]*&/, "")), "PKG")).status).toBe(400); // conn is required
    expect(reader.fetchHostedImage).toHaveBeenCalledTimes(1);
    reader.fetchHostedImage.mockClear();
    await setup({ rows: [row({ id: OTHER_CONN, mine: false }), row()] }).routes.image(get(`${chatQ}`), "PKG");
    expect(reader.fetchHostedImage).toHaveBeenCalledWith("PKG", CONN, ME, { kind: "chat", chatId: CHAT, messageId: MSG, hostedId: HID }, expect.any(AbortSignal));
    // any other connection parameter is not a known parameter at all
    expect((await setup().routes.image(get(`${chatQ}&connection=${OTHER_CONN}`), "PKG")).status).toBe(400);
  });

  it("a POST, PUT or DELETE style request is not served by this handler: only GET is exported by the route file", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../app/api/lanes/[laneId]/messages/image/route.ts", import.meta.url), "utf8");
    expect([...src.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1])).toEqual(["GET", "HEAD"]);
  });

  it("HEAD is a fixed 405 with Allow: GET and runs no Graph fetch", async () => {
    const mod = await import("../app/api/lanes/[laneId]/messages/image/route");
    const r = mod.HEAD();
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET");
    expect(reader.fetchHostedImage).not.toHaveBeenCalled();
  });

  it("the request's own cancellation signal reaches the reader, so a closed tab frees its place", async () => {
    const ctl = new AbortController();
    const req = new Request(`http://localhost:3000/api/lanes/PKG/messages/image?${chatQ}`, { headers: SAME, signal: ctl.signal });
    await setup().routes.image(req, "PKG");
    expect(reader.fetchHostedImage.mock.calls[0]?.[4]).toBe(req.signal);
  });
});

describe("the address", () => {
  it("a chat picture and a channel picture name exactly the ids the reader is called with", async () => {
    const { routes } = setup();
    expect((await routes.image(get(chatQ), "PKG")).status).toBe(200);
    expect(reader.fetchHostedImage).toHaveBeenLastCalledWith("PKG", CONN, ME, { kind: "chat", chatId: CHAT, messageId: MSG, hostedId: HID }, expect.any(AbortSignal));
    expect((await routes.image(get(chanQ), "PKG")).status).toBe(200);
    expect(reader.fetchHostedImage).toHaveBeenLastCalledWith("PKG", CONN, ME, { kind: "channel", teamId: TEAM, channelId: CHANNEL, messageId: MSG, hostedId: HID }, expect.any(AbortSignal));
  });

  it("anything else is a 400 and no reader call: a missing or repeated parameter, an unknown one, a made-up key, an id that is not valid, a path or URL where an id belongs, both a chat and a channel", async () => {
    const { routes } = setup();
    const bad = [
      "", `chat=${KEY}`, `chat=${KEY}&message=${MSG}`, `chat=${KEY}&hosted=${HID}`, `message=${MSG}&hosted=${HID}`,
      `${chatQ}&chat=${KEY}`, `${chatQ}&hosted=other`, `${chatQ}&x=1`, `${chatQ}&url=https://evil.example.test/a.png`, `${chatQ}&src=https://evil.example.test/a.png`,
      `chat=nope&message=${MSG}&hosted=${HID}`, `chat=${encodeURIComponent(CHAT)}&message=${MSG}&hosted=${HID}`, `chat=${KEY}&message=${encodeURIComponent("../x")}&hosted=${HID}`,
      `chat=${KEY}&message=${MSG}&hosted=${encodeURIComponent("a/b")}`, `chat=${KEY}&message=${MSG}&hosted=${encodeURIComponent("https://graph.microsoft.com/x")}`,
      `chat=${KEY}&message=${MSG}&hosted=${encodeURIComponent("..")}`, `chat=${KEY}&message=${MSG}&hosted=${"x".repeat(300)}`, `chat=${KEY}&message=&hosted=${HID}`,
      `${chatQ}&team=${TEAM}`, `${chatQ}&channel=${CKEY}`, `team=${TEAM}&message=${MSG}&hosted=${HID}`, `channel=${CKEY}&message=${MSG}&hosted=${HID}`,
      `team=not-a-guid&channel=${CKEY}&message=${MSG}&hosted=${HID}`, `team=${TEAM.toUpperCase()}&channel=${CKEY}&message=${MSG}&hosted=${HID}`, `team=${TEAM}&channel=${CHANNEL}&message=${MSG}&hosted=${HID}`,
    ];
    for (const qs of bad) expect((await routes.image(get(qs), "PKG")).status, qs).toBe(400);
    expect(reader.fetchHostedImage).not.toHaveBeenCalled();
  });

  it("the feature the picture needs is checked: a connection without chat_read gets none for a chat, one without channels_read none for a channel (409, no Graph call)", async () => {
    expect((await setup({ rows: [row({ has: ["channels_read"] })] }).routes.image(get(chatQ), "PKG")).status).toBe(409);
    expect((await setup({ rows: [row({ has: ["chat_read"] })] }).routes.image(get(chanQ), "PKG")).status).toBe(409);
    expect(reader.fetchHostedImage).not.toHaveBeenCalled();
    expect((await setup({ rows: [row({ has: ["chat_read"] })] }).routes.image(get(chatQ), "PKG")).status).toBe(200);
  });
});

describe("the answer", () => {
  it("the bytes with ONLY the headers the spec lists: the server's type, nosniff, inline with a fixed name, no store anywhere, a sandbox policy, same-origin resource policy", async () => {
    const r = await setup().routes.image(get(chatQ), "PKG");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-disposition")).toBe('inline; filename="image"');
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(r.headers.get("content-length")).toBe(String(PNG.byteLength));
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([...PNG]);
  });

  it("the type is the reader's (decided from the bytes), whatever the address or Microsoft said", async () => {
    for (const t of ["image/jpeg", "image/gif", "image/webp"]) {
      reader.fetchHostedImage.mockResolvedValueOnce({ ok: true, bytes: PNG, contentType: t });
      expect((await setup().routes.image(get(chatQ), "PKG")).headers.get("content-type")).toBe(t);
    }
  });

  it("every ERROR answer carries nosniff and same-origin resource policy too, and none carries a content type of an image", async () => {
    for (const make of [
      () => setup({ rows: [] }).routes.image(get(chatQ), "PKG"), // 404
      () => setup().routes.image(get("x=1"), "PKG"), // 400
      () => setup().routes.image(get(chatQ, { "sec-fetch-site": "cross-site" }), "PKG"), // 403
      () => setup({ roleError: new AuthError("no_session") }).routes.image(get(chatQ), "PKG"), // 401
    ]) {
      const r = await make();
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    }
    reader.fetchHostedImage.mockResolvedValueOnce({ ok: false, reason: "not_image" });
    const r = await setup().routes.image(get(chatQ), "PKG");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-type")).not.toMatch(/^image\//);
  });

  it("the bytes go out as the reader's own buffer: one body, no second copy of the picture is built", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../lib/teams-api.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/new Uint8Array\(r\.bytes\)/);
  });

  it("too large is 413 and not an image is 415, both fixed JSON with no store and no bytes", async () => {
    for (const [reason, status] of [["too_large", 413], ["not_image", 415]] as const) {
      reader.fetchHostedImage.mockResolvedValueOnce({ ok: false, reason });
      const r = await setup().routes.image(get(chatQ), "PKG");
      expect(r.status).toBe(status);
      expect(await r.json()).toEqual({ error: reason });
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("Microsoft failures are fixed codes: 404, 403, 429 with Retry-After, reconnect 409, anything else 503; nothing from the error (text, ids) is passed on", async () => {
    const run = async (info: Record<string, unknown>) => {
      reader.fetchHostedImage.mockRejectedValueOnce({ info: { ...info, message: `secret ${CHAT} ${HID} canary-xyz` } });
      const r = await setup().routes.image(get(chatQ), "PKG");
      const text = await r.clone().text();
      for (const s of ["canary-xyz", "abc123def456", HID]) expect(text).not.toContain(s);
      expect(r.headers.get("cache-control")).toBe("no-store");
      return r;
    };
    expect((await run({ kind: "not_found" })).status).toBe(404);
    expect((await run({ kind: "forbidden" })).status).toBe(403);
    const busy = await run({ kind: "rate_limited", retry_after_seconds: 7 });
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("7");
    expect((await run({ kind: "reconnect_required" })).status).toBe(409);
    expect((await run({ kind: "timeout" })).status).toBe(503);
    expect((await run({ kind: "provider_error" })).status).toBe(503);
  });

  it("canary: an unexpected error logs only its class, never its message, the ids or the bytes", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    reader.fetchHostedImage.mockRejectedValueOnce(new Error(`boom ${CHAT} ${HID} canary-bytes-xyz`));
    const r = await setup().routes.image(get(chatQ), "PKG");
    expect(r.status).toBe(503);
    expect(JSON.stringify([...spy.mock.calls, ...logs.mock.calls])).not.toMatch(/canary-bytes-xyz|abc123def456|aWQ9/);
    vi.restoreAllMocks();
  });
});
