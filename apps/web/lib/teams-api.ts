// The small routes behind the Messages page (T-283, T-284, T-285), each for the SIGNED-IN person's OWN Teams connection in the lane:
//   GET  /api/lanes/<lane>/messages/image?chat=<key>&message=<id>&hosted=<id>      an inline picture of a chat message, streamed by the server (T-285)
//   GET  /api/lanes/<lane>/messages/image?team=<id>&channel=<key>&message=<id>&hosted=<id>   the same for a root post of a channel (T-291)
//   GET  /api/lanes/<lane>/messages/older?chat=<key>&before=<iso>   "Load older messages": one more page of a chat, by the person's click
//   POST /api/lanes/<lane>/messages/read      {chat, readThrough}    opening a chat records the portal's own read marker (never a write at Microsoft)
//   POST /api/lanes/<lane>/messages/call-link {chat, video}          the Call / Video call link for a chat: validated values only, returned, never opened here
// Order: same site (Origin / Sec-Fetch-Site) -> lane id shape -> AAL2 session in the lane with own_mail -> the `messages` module is shown for the company -> the person's own usable Teams
// connection (read under RLS: another person's is never visible) -> the chat key decodes to a valid chat id -> the call. The Teams reader's guard checks the owner again before a token is read, and
// the lane's Teams settings and the connection's features. Answers are fixed JSON codes; Microsoft's text and anything from a chat never appear in an error, a log line or an audit row.
// `cache-control: no-store` on every answer: what these return is content of the person's chats (older messages), for this one request.
import { AuthError, authErrorResponse, type Guards } from "@nichols/core/auth";
import type { LaneId } from "@nichols/core";
import type { LaneClient } from "@nichols/core/lane-router";
import { MAIL_CONNECT_ROLES } from "@nichols/connectors/oauth";
import { fetchHostedImage, resolveCallTargets } from "@nichols/connectors/teams-reader";
import { callUrl, normalizeTime } from "@nichols/connectors/teams-pure";
import type { TeamsFeature } from "@nichols/core/lane-config";
import { loadLaneGate, type LaneGate } from "./lane-modules";
import { loadTeamsRows, type TeamsConnectionView } from "./teams-connection";
import { decodeChatKey } from "./teams-chat-key";
import { isMessageId, isTeamId } from "./teams-channel-key";
import { teamsFailure, type TeamsFailure } from "./teams-errors";
import { loadOlder } from "./teams-chats";
import { markRead } from "./teams-reads";

const NO_STORE = { "cache-control": "no-store" } as const;
/**
 * What the image route sends with the bytes (T-285). The type is the one the server decided from the bytes; `nosniff` and a sandbox policy keep a browser from treating the body as anything else
 * if someone opens the address; nothing is cached anywhere (an image in a chat is message content, rule 6); the file name is fixed.
 */
const IMAGE_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-disposition": 'inline; filename="image"',
  "cache-control": "private, no-store",
  "content-security-policy": "default-src 'none'; sandbox",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
} as const;
/** The headers every answer of the image route carries, errors included (an error body is never to be sniffed into anything else or embedded cross-origin). */
const IMAGE_ALWAYS = { "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" } as const;
const IMAGE_PARAMS = new Set(["chat", "team", "channel", "message", "hosted"]);
const json = (body: unknown, status: number, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
const LANE = /^[A-Z]{1,8}$/;
const MAX_BODY = 2_000;

type Db = Pick<LaneClient, "schema">;
export type TeamsRouteDeps = {
  guards: () => Promise<Pick<Guards, "requireLane" | "requireRole">>;
  gate?: (client: Db, laneId: string) => Promise<LaneGate>;
  rows?: (client: Db, laneId: string, userId: string) => Promise<TeamsConnectionView[]>;
};

type Who = { client: Db; userId: string; laneId: string; connectionId: string; has: readonly TeamsFeature[] };

function sameSite(request: Request, method: "GET" | "POST"): boolean {
  const url = new URL(request.url);
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  return method === "GET" ? true : request.headers.get("origin") === url.origin;
}

/** The JSON body, read with a HARD cap (SL3): a declared length over the cap is refused at once, and the stream is cut as soon as it passes the cap, so a large body is never held in memory. */
async function body(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY) return null;
  let text = "";
  try {
    const reader = request.body?.getReader();
    if (!reader) return null;
    const dec = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += dec.decode(value, { stream: true });
    }
    text += dec.decode();
  } catch {
    return null;
  }
  if (text.length === 0 || text.length > MAX_BODY) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createTeamsRoutes(deps: TeamsRouteDeps) {
  const gate = deps.gate ?? loadLaneGate;
  const rows = deps.rows ?? loadTeamsRows;

  /** The person, their lane client and their own usable Teams connection; or the Response to send instead. */
  async function who(laneId: string): Promise<Who | Response> {
    if (!LANE.test(laneId)) return json({ error: "not_found" }, 404);
    const g = await deps.guards();
    try {
      await g.requireLane(laneId as LaneId);
    } catch (e) {
      if (e instanceof AuthError && e.reason === "forbidden") return json({ error: "not_found" }, 404);
      throw e;
    }
    const { session, client } = await g.requireRole(laneId as LaneId, [...MAIL_CONNECT_ROLES]); // own_mail; AAL2 enforced by the guard
    if (!(await gate(client, laneId)).visible("messages")) return json({ error: "not_found" }, 404);
    const mine = (await rows(client, laneId, session.userId)).find((r) => r.mine && (r.state === "connected" || r.state === "degraded"));
    if (!mine) return json({ error: "not_found" }, 404);
    return { client, userId: session.userId, laneId, connectionId: mine.id, has: mine.has };
  }

  const failure = (f: TeamsFailure): Response => {
    if (f.kind === "busy") return json({ error: "busy", seconds: f.seconds }, 429, f.seconds ? { "retry-after": String(f.seconds) } : {});
    if (f.kind === "reconnect") return json({ error: "reconnect" }, 409);
    if (f.kind === "not_found") return json({ error: "not_found" }, 404);
    if (f.kind === "forbidden") return json({ error: "forbidden" }, 403);
    if (f.kind === "not_enabled") return json({ error: "not_enabled" }, 409);
    return json({ error: "unavailable" }, 503);
  };

  const guarded = async (run: () => Promise<Response>): Promise<Response> => {
    try {
      return await run();
    } catch (e) {
      const res = authErrorResponse(e);
      if (res) return res;
      console.error("[api/teams-messages] unavailable:", e instanceof Error ? e.name : typeof e); // the class only, never a message (it could carry content)
      return json({ error: "unavailable" }, 503);
    }
  };

  /** The picture an address names: exactly one of `chat` or `team` + `channel`, plus `message` and `hosted`, each once, each valid; no other parameter. Null for anything else. */
  function imageTarget(q: URLSearchParams): import("@nichols/connectors/teams-pure").HostedTarget | null {
    for (const k of new Set(q.keys())) if (!IMAGE_PARAMS.has(k) || q.getAll(k).length !== 1) return null;
    const message = q.get("message");
    const hostedId = q.get("hosted");
    if (!isMessageId(message) || !isMessageId(hostedId)) return null;
    if (q.has("chat")) {
      if (q.has("team") || q.has("channel")) return null;
      const chatId = decodeChatKey(q.get("chat"));
      return chatId === null ? null : { kind: "chat", chatId, messageId: message, hostedId };
    }
    const teamId = q.get("team");
    const channelId = decodeChatKey(q.get("channel"));
    return isTeamId(teamId) && channelId !== null ? { kind: "channel", teamId, channelId, messageId: message, hostedId } : null;
  }

  const imageInner = (request: Request, laneId: string): Promise<Response> =>
    guarded(async () => {
      if (!sameSite(request, "GET")) return json({ error: "forbidden" }, 403);
      const w = await who(laneId);
      if (w instanceof Response) return w;
      const target = imageTarget(new URL(request.url).searchParams);
      if (target === null) return json({ error: "bad_request" }, 400);
      if (!w.has.includes(target.kind === "chat" ? "chat_read" : "channels_read")) return json({ error: "feature_missing" }, 409);
      try {
        const r = await fetchHostedImage(laneId as LaneId, w.connectionId, w.userId, target, request.signal); // a closed tab cancels a waiting or running picture read
        if (!r.ok) return json({ error: r.reason }, r.reason === "too_large" ? 413 : 415);
        // the reader's one buffer goes out as it is (no second copy)
        return new Response(r.bytes as unknown as BodyInit, { status: 200, headers: { ...IMAGE_HEADERS, "content-type": r.contentType, "content-length": String(r.bytes.byteLength) } });
      } catch (e) {
        return failure(teamsFailure(e));
      }
    });

  return {
    /** One inline picture (T-285): the bytes of a hosted content of a message the person's own connection can read. GET only (the route file answers HEAD with a 405); the server decides the type; nothing is stored. */
    image: async (request: Request, laneId: string): Promise<Response> => {
      const res = await imageInner(request, laneId);
      for (const [k, v] of Object.entries(IMAGE_ALWAYS)) res.headers.set(k, v);
      return res;
    },

    /** "Load older messages". */
    older: (request: Request, laneId: string): Promise<Response> =>
      guarded(async () => {
        if (!sameSite(request, "GET")) return json({ error: "forbidden" }, 403);
        const w = await who(laneId);
        if (w instanceof Response) return w;
        const q = new URL(request.url).searchParams;
        const chatId = decodeChatKey(q.get("chat"));
        const before = normalizeTime(q.get("before"));
        if (chatId === null || before === null) return json({ error: "bad_request" }, 400);
        const r = await loadOlder(w, chatId, before);
        if (r.kind !== "ok") return failure(r);
        return json({ messages: r.messages, nextBefore: r.nextBefore }, 200);
      }),

    /** Opening a chat: the portal's own marker. */
    read: (request: Request, laneId: string): Promise<Response> =>
      guarded(async () => {
        if (!sameSite(request, "POST")) return json({ error: "forbidden" }, 403);
        const w = await who(laneId);
        if (w instanceof Response) return w;
        const b = await body(request);
        const chatId = decodeChatKey(b?.chat);
        const at = normalizeTime(b?.readThrough);
        if (chatId === null || at === null) return json({ error: "bad_request" }, 400);
        return (await markRead(w.client, laneId, w.connectionId, chatId, at)) ? new Response(null, { status: 204, headers: NO_STORE }) : json({ error: "not_recorded" }, 409);
      }),

    /** Call / Video call. */
    callLink: (request: Request, laneId: string): Promise<Response> =>
      guarded(async () => {
        if (!sameSite(request, "POST")) return json({ error: "forbidden" }, 403);
        const w = await who(laneId);
        if (w instanceof Response) return w;
        const b = await body(request);
        const chatId = decodeChatKey(b?.chat);
        if (chatId === null || typeof b?.video !== "boolean") return json({ error: "bad_request" }, 400);
        if (!w.has.includes("call_links")) return json({ error: "feature_missing" }, 409); // "Reconnect Teams to add call buttons"
        try {
          const t = await resolveCallTargets(laneId as LaneId, w.connectionId, w.userId, chatId);
          if (!t.ok) return json({ error: "not_allowed", reason: t.reason }, 409);
          return json({ url: callUrl(t.upns, b.video) }, 200);
        } catch (e) {
          return failure(teamsFailure(e));
        }
      }),
  };
}
