// The small routes behind the Messages page (T-283, T-284, T-285), each for the SIGNED-IN person's OWN Teams connection in the lane:
//   GET  /api/lanes/<lane>/messages/image?chat=<key>&message=<id>&hosted=<id>      an inline picture of a chat message, streamed by the server (T-285)
//   GET  /api/lanes/<lane>/messages/image?team=<id>&channel=<key>&message=<id>&hosted=<id>   the same for a root post of a channel (T-291)
//   GET  /api/lanes/<lane>/messages/older?chat=<key>&before=<iso>   "Load older messages": one more page of a chat, by the person's click
//   POST /api/lanes/<lane>/messages/read      {chat, readThrough}    opening a chat records the portal's own read marker (never a write at Microsoft)
//   POST /api/lanes/<lane>/messages/call-link {chat, video}          the Call / Video call link for a chat: validated values only, returned, never opened here
//   GET  /api/lanes/<lane>/messages/activity  (T-290) the notice state of the person's own connection: DATABASE ONLY, never Microsoft; `{ live, liveUntil, dot, lastNoticeAt }`
//   POST /api/lanes/<lane>/messages/activity  (T-290) the person opened the chat list: `teams_activity_seen`; answers the same state
//   GET  /api/lanes/<lane>/messages/chats?chat=<key>&more=<cursor>   (T-290) the chat list again, after a notice or a Refresh: the same read the page makes
//   GET  /api/lanes/<lane>/messages/newer?chat=<key>&since=<iso>      (T-290) what changed in the open chat since a message time (a lastModifiedDateTime date range)
// T-295 (spec 22.4): the browser names the connection by `conn`, the person's OWN connection id. It is a name, never a permission: every request re-checks it.
// Order: same site (Origin / Sec-Fetch-Site) -> lane id shape -> AAL2 session in the lane with own_mail -> the `messages` module is shown for the company -> `conn` is a lower-case uuid (else 400) ->
// `conn` is one of the caller's OWN Teams rows in THIS lane (read under RLS, `mine`; else 404: another person's, another lane's, an unknown id, a disconnected and a pending one all give the SAME
// 404) -> its state is usable (a sign-in that expired is 409 reconnect) -> the chat key decodes to a valid chat id -> the feature the route needs is on the connection (409 feature_missing) -> the call. The Teams reader's guard checks the owner again before a token is read, and
// the lane's Teams settings and the connection's features. Answers are fixed JSON codes; Microsoft's text and anything from a chat never appear in an error, a log line or an audit row.
// `cache-control: no-store` on every answer: what these return is content of the person's chats (older messages), for this one request.
import { AuthError, authErrorResponse, type Guards } from "@nichols/core/auth";
import type { LaneId } from "@nichols/core";
import type { LaneClient } from "@nichols/core/lane-router";
import { MAIL_CONNECT_ROLES } from "@nichols/connectors/oauth";
import { fetchHostedImage, resolveCallTargets } from "@nichols/connectors/teams-reader";
import { callUrl, normalizeTime } from "@nichols/connectors/teams-pure";
import type { TeamsFeature } from "@nichols/core/lane-config";
import { ACTIVITY_LIMIT_MAX, ACTIVITY_LIMIT_WINDOW_MS, READ_LIMIT_MAX, READ_LIMIT_WINDOW_MS } from "./messages-live-config";
import { loadLaneGate, type LaneGate } from "./lane-modules";
import { loadTeamsRows, type TeamsConnectionView } from "./teams-connection";
import { decodeChatKey } from "./teams-chat-key";
import { isMessageId, isTeamId } from "./teams-channel-key";
import { teamsFailure, type TeamsFailure } from "./teams-errors";
import { loadChatLists, loadNewer, loadOlder, type ChatSource } from "./teams-chats";
import { combineActivity, createWindowLimiter, markSeen, readActivity, type AccountActivity } from "./teams-activity";
import { isConnId } from "./teams-accounts";
import { decodeCursor, looksLikeCursor, SOURCE_TOKEN } from "./teams-cursor";
import { ownAccounts, type MessagesAccount } from "./teams-messages";
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
const IMAGE_PARAMS = new Set(["chat", "team", "channel", "conn", "message", "hosted"]);
const json = (body: unknown, status: number, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
const LANE = /^[A-Z]{1,8}$/;
const MAX_BODY = 2_000;

type Db = Pick<LaneClient, "schema">;
export type TeamsRouteDeps = {
  guards: () => Promise<Pick<Guards, "requireLane" | "requireRole">>;
  gate?: (client: Db, laneId: string) => Promise<LaneGate>;
  rows?: (client: Db, laneId: string, userId: string) => Promise<TeamsConnectionView[]>;
  /** Test hook: the per-person limiters of the activity route and of the two re-read routes (default: this process's own, in memory). */
  limiters?: { activity: { take(key: string): number }; reads: { take(key: string): number } };
};

// One pair per process: a per-person sliding window. The activity route reads one database row; the re-read routes read Microsoft, so they get the smaller allowance.
const SHARED_LIMITERS = { activity: createWindowLimiter(ACTIVITY_LIMIT_MAX, ACTIVITY_LIMIT_WINDOW_MS), reads: createWindowLimiter(READ_LIMIT_MAX, READ_LIMIT_WINDOW_MS) };

type Ctx = { client: Db; userId: string; laneId: string };
type Who = Ctx & { connectionId: string; has: readonly TeamsFeature[]; account: MessagesAccount };

function sameSite(request: Request, method: "GET" | "POST"): boolean {
  const url = new URL(request.url);
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  return method === "GET" ? true : request.headers.get("origin") === url.origin;
}

/** The request body as text, read with a HARD cap (SL3): a declared length over the cap is refused at once, and the stream is cut as soon as it passes the cap, so a large body is never held in memory. `null` = too large or unreadable; "" = none. */
async function bodyText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY) return null;
  let text = "";
  try {
    const reader = request.body?.getReader();
    if (!reader) return "";
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
  return text.length > MAX_BODY ? null : text;
}

const asObject = (text: string): Record<string, unknown> | null => {
  if (text.length === 0) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** The JSON body as an object, or null for anything else (none, too large, not JSON, not an object). */
async function body(request: Request): Promise<Record<string, unknown> | null> {
  const text = await bodyText(request);
  return text === null ? null : asObject(text);
}

export function createTeamsRoutes(deps: TeamsRouteDeps) {
  const gate = deps.gate ?? loadLaneGate;
  const rows = deps.rows ?? loadTeamsRows;
  const limiters = deps.limiters ?? SHARED_LIMITERS;

  /** The session and the lane's gates, in the spec's order; or the Response to send instead. No connection is named yet. */
  async function begin(laneId: string, opts: { limit?: "activity" | "reads" } = {}): Promise<Ctx | Response> {
    if (!LANE.test(laneId)) return json({ error: "not_found" }, 404);
    const g = await deps.guards();
    try {
      await g.requireLane(laneId as LaneId);
    } catch (e) {
      if (e instanceof AuthError && e.reason === "forbidden") return json({ error: "not_found" }, 404);
      throw e;
    }
    const { session, client } = await g.requireRole(laneId as LaneId, [...MAIL_CONNECT_ROLES]); // own_mail; AAL2 enforced by the guard
    if (opts.limit) {
      const wait = limiters[opts.limit].take(`${laneId}:${session.userId}`);
      if (wait > 0) return json({ error: "rate_limited", seconds: wait }, 429, { "retry-after": String(wait) });
    }
    if (!(await gate(client, laneId)).visible("messages")) return json({ error: "not_found" }, 404);
    return { client, userId: session.userId, laneId };
  }
  /** The person's own accounts (not disconnected), with their labels, read under RLS (`mine`: another person's row is never one of them). One read. */
  async function accountsOf(ctx: Ctx): Promise<MessagesAccount[]> {
    return ownAccounts(await rows(ctx.client, ctx.laneId, ctx.userId), []);
  }
  const whoOf = (ctx: Ctx, a: MessagesAccount): Who => ({ ...ctx, connectionId: a.connectionId, has: a.has, account: a });
  /**
   * The connection a request names (spec 22.4): `conn` must be a lower-case uuid (else 400), one of the caller's OWN Teams rows in THIS lane (else 404: the same answer for another person's, another
   * lane's, an unknown, a disconnected and a pending row), and usable (a sign-in that expired is 409 `reconnect`). Nothing has called Microsoft or read a token by now.
   */
  async function pick(ctx: Ctx, conn: unknown): Promise<Who | Response> {
    if (!isConnId(conn)) return json({ error: "bad_request" }, 400);
    const own = (await accountsOf(ctx)).find((a) => a.connectionId === conn);
    if (!own) return json({ error: "not_found" }, 404);
    if (!own.usable) return json({ error: "reconnect" }, 409);
    return whoOf(ctx, own);
  }
  /** `begin`, then `pick` with the `conn` of the query (the routes that name it there). */
  async function whoByQuery(laneId: string, q: URLSearchParams | null, opts: { limit?: "activity" | "reads" } = {}): Promise<Who | Response> {
    const ctx = await begin(laneId, opts);
    if (ctx instanceof Response) return ctx;
    return pick(ctx, q === null ? undefined : q.get("conn") ?? undefined);
  }
  /** The accounts the person may be read as right now: usable ones, each as a `Who` (the notice routes and the combined list). */
  async function usableOf(ctx: Ctx): Promise<{ all: MessagesAccount[]; usable: MessagesAccount[] }> {
    const all = await accountsOf(ctx);
    return { all, usable: all.filter((a) => a.usable) };
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

  /** The picture an address names: exactly one of `chat` or `team` + `channel`, plus `conn`, `message` and `hosted`, each once, each valid; no other parameter. Null for anything else. */
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
      const q = new URL(request.url).searchParams;
      const w = await whoByQuery(laneId, q);
      if (w instanceof Response) return w;
      const target = imageTarget(q);
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

  /** The sources of the combined list: the person's usable accounts that have `chat_read`, labelled only when they have two or more usable accounts (spec 22.5). */
  const sourcesOf = (all: readonly MessagesAccount[]): ChatSource[] => {
    const multi = all.filter((a) => a.usable).length >= 2;
    return all.flatMap((a, ord) => (a.usable && a.has.includes("chat_read") ? [{ connectionId: a.connectionId, label: multi ? a.label : null, account: a.account, ord }] : []));
  };

  return {
    /** One inline picture (T-285): the bytes of a hosted content of a message the person's own connection can read. GET only (the route file answers HEAD with a 405); the server decides the type; nothing is stored. `conn` is required. */
    image: async (request: Request, laneId: string): Promise<Response> => {
      const res = await imageInner(request, laneId);
      for (const [k, v] of Object.entries(IMAGE_ALWAYS)) res.headers.set(k, v);
      return res;
    },

    /** "Load older messages" of the chat of the named connection. */
    older: (request: Request, laneId: string): Promise<Response> =>
      guarded(async () => {
        if (!sameSite(request, "GET")) return json({ error: "forbidden" }, 403);
        const q = new URL(request.url).searchParams;
        const w = await whoByQuery(laneId, q);
        if (w instanceof Response) return w;
        const chatId = decodeChatKey(q.get("chat"));
        const before = normalizeTime(q.get("before"));
        if (chatId === null || before === null) return json({ error: "bad_request" }, 400);
        const r = await loadOlder(w, chatId, before);
        if (r.kind !== "ok") return failure(r);
        return json({ messages: r.messages, nextBefore: r.nextBefore }, 200);
      }),

    /** Opening a chat: the portal's own marker (of the connection named in the body). */
    read: (request: Request, laneId: string): Promise<Response> =>
      guarded(async () => {
        if (!sameSite(request, "POST")) return json({ error: "forbidden" }, 403);
        const ctx = await begin(laneId);
        if (ctx instanceof Response) return ctx;
        const b = await body(request);
        const w = await pick(ctx, b?.conn);
        if (w instanceof Response) return w;
        const chatId = decodeChatKey(b?.chat);
        const at = normalizeTime(b?.readThrough);
        if (chatId === null || at === null) return json({ error: "bad_request" }, 400);
        return (await markRead(w.client, laneId, w.connectionId, chatId, at)) ? new Response(null, { status: 204, headers: NO_STORE }) : json({ error: "not_recorded" }, 409);
      }),

    /**
     * The notice state of the person's own connections (T-290, T-295): DATABASE ONLY. One entry per usable connection (`accounts`), read in parallel, and the whole person's state from them (`live` = any,
     * `liveUntil` = the earliest of the live ones, `dot` = any, `lastNoticeAt` = the latest). No usable connection, or notices that are off, is `live: false` with 200 (a missing dot is not an error);
     * every check of the other Messages routes still applies (same site, AAL2 with own_mail, the `messages` module). Rate limited per person; never cached.
     */
    activity: (request: Request, laneId: string): Promise<Response> =>
      guarded(async () => {
        if (!sameSite(request, "GET")) return json({ error: "forbidden" }, 403);
        const ctx = await begin(laneId, { limit: "activity" });
        if (ctx instanceof Response) return ctx;
        const { usable } = await usableOf(ctx);
        const entries: AccountActivity[] = await Promise.all(usable.map(async (a) => ({ conn: a.connectionId, ...(await readActivity(ctx.client, laneId, a.connectionId)) })));
        return json({ ...combineActivity(entries), serverNow: new Date().toISOString() }, 200);
      }),

    /**
     * The person opened the chat list (T-290, T-295): `teams_activity_seen` per connection, then the state as it is now. An optional body `{ conns: [id, ...] }` (1 - 5 ids) names the connections whose list
     * was read: each is re-checked and an id that fails is DROPPED, not an error (an account whose list failed keeps its dot). Without a body: every usable connection.
     */
    seen: (request: Request, laneId: string): Promise<Response> =>
      guarded(async () => {
        if (!sameSite(request, "POST")) return json({ error: "forbidden" }, 403);
        const ctx = await begin(laneId, { limit: "activity" });
        if (ctx instanceof Response) return ctx;
        const text = await bodyText(request);
        if (text === null) return json({ error: "bad_request" }, 400);
        let named: string[] | null = null;
        if (text.trim() !== "") {
          const b = asObject(text);
          const list = b !== null && Object.keys(b).length === 1 ? b.conns : undefined;
          if (!Array.isArray(list) || list.length < 1 || list.length > 5) return json({ error: "bad_request" }, 400);
          named = list.filter(isConnId);
        }
        const { usable } = await usableOf(ctx);
        const targets = named === null ? usable : usable.filter((a) => named.includes(a.connectionId));
        const marked = await Promise.all(targets.map((a) => markSeen(ctx.client, laneId, a.connectionId)));
        if (marked.some((ok) => !ok)) return json({ error: "not_recorded" }, 409);
        const entries: AccountActivity[] = await Promise.all(usable.map(async (a) => ({ conn: a.connectionId, ...(await readActivity(ctx.client, laneId, a.connectionId)) })));
        return json({ ...combineActivity(entries), serverNow: new Date().toISOString() }, 200);
      }),

    /**
     * The chat list again (T-290, T-295), after a notice or a Refresh: the very read the page makes. `?conn=<id>` reads that ONE account's first page (used after a notice of that account); without it
     * every usable account with chats is read (Refresh). `?more=<cursor>` is the combined cursor (or, for a person with one account, an old single skip token).
     */
    chats: (request: Request, laneId: string): Promise<Response> =>
      guarded(async () => {
        if (!sameSite(request, "GET")) return json({ error: "forbidden" }, 403);
        const ctx = await begin(laneId, { limit: "reads" });
        if (ctx instanceof Response) return ctx;
        const q = new URL(request.url).searchParams;
        for (const k of new Set(q.keys())) if (k !== "chat" && k !== "more" && k !== "conn") return json({ error: "bad_request" }, 400);
        const connParam = q.get("conn");
        let all: MessagesAccount[];
        let sources: ChatSource[];
        if (connParam !== null) {
          const w = await pick(ctx, connParam);
          if (w instanceof Response) return w;
          if (!w.has.includes("chat_read")) return json({ error: "feature_missing" }, 409);
          all = await accountsOf(ctx);
          sources = sourcesOf(all).filter((s) => s.connectionId === w.connectionId);
        } else {
          all = await accountsOf(ctx);
          const usable = all.filter((a) => a.usable);
          if (usable.length === 0) return json({ error: "not_found" }, 404);
          sources = sourcesOf(all);
          if (sources.length === 0) return json({ error: "feature_missing" }, 409);
        }
        const chatParam = q.get("chat");
        const more = q.get("more");
        if (chatParam !== null && decodeChatKey(chatParam) === null) return json({ error: "bad_request" }, 400);
        if (more !== null && !(looksLikeCursor(more) && (decodeCursor(more) !== null || (sources.length === 1 && SOURCE_TOKEN.test(more))))) return json({ error: "bad_request" }, 400);
        const r = await loadChatLists({ laneId, userId: ctx.userId, client: ctx.client }, sources, { ...(more ? { cursor: more } : {}), selectedKey: chatParam });
        if (r.kind !== "ok") return failure(r);
        return json({ rows: r.rows, moreCursor: r.moreCursor, notes: r.notes ?? [], listed: r.listed ?? [], dropped: r.dropped === true }, 200);
      }),

    /** What changed in the open chat of the named connection since a message time (T-290): a `lastModifiedDateTime` date range, one page. */
    newer: (request: Request, laneId: string): Promise<Response> =>
      guarded(async () => {
        if (!sameSite(request, "GET")) return json({ error: "forbidden" }, 403);
        const q = new URL(request.url).searchParams;
        const w = await whoByQuery(laneId, q, { limit: "reads" });
        if (w instanceof Response) return w;
        if (!w.has.includes("chat_read")) return json({ error: "feature_missing" }, 409);
        for (const k of new Set(q.keys())) if (k !== "chat" && k !== "since" && k !== "conn") return json({ error: "bad_request" }, 400);
        const chatId = decodeChatKey(q.get("chat"));
        const since = normalizeTime(q.get("since"));
        if (chatId === null || since === null) return json({ error: "bad_request" }, 400);
        const r = await loadNewer(w, chatId, since);
        if (r.kind !== "ok") return failure(r);
        return json({ messages: r.messages, truncated: r.truncated }, 200);
      }),

    /** Call / Video call for a chat of the connection named in the body. */
    callLink: (request: Request, laneId: string): Promise<Response> =>
      guarded(async () => {
        if (!sameSite(request, "POST")) return json({ error: "forbidden" }, 403);
        const ctx = await begin(laneId);
        if (ctx instanceof Response) return ctx;
        const b = await body(request);
        const w = await pick(ctx, b?.conn);
        if (w instanceof Response) return w;
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
