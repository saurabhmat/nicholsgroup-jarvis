// The Teams channel reader (T-291; spec 8, 8.2, 14; vendor facts B): the signed-in person's joined teams, the channels of one team, the root posts of one channel and the replies of one post.
// Same rules as the chat reader (./reader.ts), which it builds on:
//   - every call is a GET through the guarded, read-only Teams client (fixed templates in ./constants.ts, ids validated BEFORE any request, the actor is the signed-in owner, the guard checks the lane,
//     the owner, the lane's `channels_read` AND the connection's: a token without the channel scopes never reaches a channel endpoint, because the connection's feature is only set when they were granted);
//   - paths are built from validated ids only, never from an address Graph returns (the cross-tenant shared-channel known issue [B] cannot bite: no tenant segment is ever sent);
//   - a page of posts is `$top=20`; the next page needs the person's click and an opaque cursor that holds only a `$skiptoken` (validated, bound to this one channel); no `$expand=replies` (replies
//     are read when one post is opened, `$top=50`); no polling, no retry (a 429 reaches the page as `rate_limited` with its Retry-After);
//   - there is NO read state for channels [B]: nothing here says "unread";
//   - a SHARED channel is listed but never read: reading it needs the host team and, across tenants, a path the fact sheet marks as failing [B]; the page offers "Open in Teams" for it instead.
// Rule 6: names, subjects and text are fetched live and returned to the one request that asked; nothing is stored, cached or logged here (no log call in this file). Rule 9: bodies go through the
// converter (typed nodes, https links only); a name is drawn as text. Pictures in a root post may name a hosted content of that same post (T-285); in a reply they are placeholders.
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import type { TeamsApi, TeamsSelf } from "./api";
import { cursorFromNextLink, fixed, lowerUuid, messageOf, NAME_CHARS, NO_NAME, PAGE_TIMEOUT_MS, PageSchema, skipTokenFrom, text, type ChatMessage } from "./reader";
import { safeHttpsUrl } from "./message-html";

export const POSTS_PAGE = 20;
export const REPLIES_PAGE = 50;
/** Teams listed at most (`GET /me/joinedTeams` takes no OData option [B]); a longer answer is cut and says so. */
export const TEAMS_LISTED_MAX = 100;
const SUBJECT_CHARS = 200;
const TEAMS_WEB_HOST = "teams.microsoft.com";

export type TeamSummary = { teamId: string; name: string; /** `isArchived: true` in the answer (only when Graph includes it; no second request is made to find out). */ archived: boolean };
/** `other`: a membership type this build does not know (Microsoft adds values): listed, never read (fail closed). */
export type ChannelKind = "standard" | "private" | "shared" | "other";
export type ChannelSummary = {
  channelId: string;
  name: string;
  kind: ChannelKind;
  /** `https://teams.microsoft.com/...` only (anything else is dropped), for Open in Teams. */
  webUrl: string | null;
};
export type TeamList = { teams: TeamSummary[]; /** More teams exist than are listed. */ more: boolean; self: TeamsSelf };
export type ChannelList = { channels: ChannelSummary[]; self: TeamsSelf };
export type ChannelPost = ChatMessage & {
  /** A post's own title (plain text), or null. */
  subject: string | null;
  /** The post's own `webUrl` when it is an https link on teams.microsoft.com, for Open in Teams. */
  webUrl: string | null;
};
export type PostPage = { posts: ChannelPost[]; nextCursor: string | null; self: TeamsSelf };
export type ReplyPage = { replies: ChatMessage[]; more: boolean; self: TeamsSelf };

const TeamSchema = z.looseObject({ id: z.string().max(64), displayName: z.string().max(512).nullish(), isArchived: z.boolean().nullish() });
const ChannelSchema = z.looseObject({ id: z.string().max(256), displayName: z.string().max(512).nullish(), membershipType: z.string().max(32).nullish(), webUrl: z.string().max(4096).nullish() });
const PostExtraSchema = z.looseObject({ subject: z.string().max(2048).nullish(), webUrl: z.string().max(4096).nullish() });

const teamsHostUrl = (v: string | null | undefined): string | null => {
  const u = typeof v === "string" ? safeHttpsUrl(v) : null;
  return u && u.host === TEAMS_WEB_HOST ? u.href : null;
};

export type TeamsChannelReaderDeps = { api: TeamsApi };

export function createTeamsChannelReader(deps: TeamsChannelReaderDeps) {
  const get = <T>(laneId: LaneId, conn: unknown, userId: string, req: { path: string; params?: Record<string, string>; query?: Record<string, string | number> }) =>
    deps.api.get<T>(laneId, conn, { ...req, actor: { kind: "user", userId }, retry: false, timeoutMs: PAGE_TIMEOUT_MS });
  const pageOf = (data: unknown) => {
    const p = PageSchema.safeParse(data);
    if (!p.success) throw fixed("provider_error", "Teams returned an answer the portal does not understand");
    return p.data;
  };

  return {
    /** The teams the person has joined (one request, no option). */
    async listTeams(laneId: LaneId, conn: unknown, userId: string): Promise<TeamList> {
      const res = await get<unknown>(laneId, conn, userId, { path: "/me/joinedTeams" });
      const page = pageOf(res.data);
      const all = page.value.flatMap((raw) => {
        const r = TeamSchema.safeParse(raw);
        const id = r.success ? lowerUuid(r.data.id) : null;
        return r.success && id !== null ? [{ teamId: id, name: text(r.data.displayName, NAME_CHARS) || NO_NAME, archived: r.data.isArchived === true }] : [];
      });
      const seen = new Set<string>();
      const teams = all.filter((t) => (seen.has(t.teamId) ? false : (seen.add(t.teamId), true))).sort((a, b) => a.name.localeCompare(b.name));
      return { teams: teams.slice(0, TEAMS_LISTED_MAX), more: teams.length > TEAMS_LISTED_MAX || typeof page["@odata.nextLink"] === "string", self: res.self };
    },

    /** The channels of one team the person can see: standard ones, and the private and shared ones they belong to [B] (Graph hides the others). */
    async listChannels(laneId: LaneId, conn: unknown, userId: string, teamId: string): Promise<ChannelList> {
      const res = await get<unknown>(laneId, conn, userId, { path: "/teams/{teamId}/channels", params: { teamId }, query: { $select: "id,displayName,membershipType,webUrl" } });
      const page = pageOf(res.data);
      const channels = page.value.flatMap((raw): ChannelSummary[] => {
        const r = ChannelSchema.safeParse(raw);
        // the id is checked against the same format the client checks before any request: a made-up one is not listed
        if (!r.success || !/^19:[A-Za-z0-9._@:-]{1,197}$/.test(r.data.id)) return [];
        const t = (r.data.membershipType ?? "standard").toLowerCase();
        return [{ channelId: r.data.id, name: text(r.data.displayName, NAME_CHARS) || NO_NAME, kind: t === "private" ? "private" : t === "shared" ? "shared" : t === "standard" ? "standard" : "other", webUrl: teamsHostUrl(r.data.webUrl) }];
      });
      return { channels, self: res.self };
    },

    /** One page of a channel's root posts, as Graph orders them (the thread changed last first [B]). `cursor` (from the previous page, by an explicit "More posts") continues it. */
    async listChannelPosts(laneId: LaneId, conn: unknown, userId: string, teamId: string, channelId: string, opts: { cursor?: string } = {}): Promise<PostPage> {
      const path = `/teams/${teamId}/channels/${channelId}/messages`;
      const skip = opts.cursor !== undefined ? skipTokenFrom(opts.cursor, path) : undefined;
      const res = await get<unknown>(laneId, conn, userId, {
        path: "/teams/{teamId}/channels/{channelId}/messages",
        params: { teamId, channelId },
        query: { $top: POSTS_PAGE, ...(skip !== undefined ? { $skiptoken: skip } : {}) },
      });
      const page = pageOf(res.data);
      const posts = page.value.flatMap((raw): ChannelPost[] => {
        const m = messageOf(raw, res.self, { kind: "channel", teamId, channelId });
        if (!m) return [];
        const extra = PostExtraSchema.safeParse(raw);
        const subject = extra.success && !m.deleted && !m.system ? text(extra.data.subject, SUBJECT_CHARS) || null : null;
        return [{ ...m, subject, webUrl: extra.success ? teamsHostUrl(extra.data.webUrl) : null }];
      });
      return { posts, nextCursor: cursorFromNextLink(page["@odata.nextLink"], path), self: res.self };
    },

    /** The replies of one post, oldest first (`$top=50`; `more` when Graph says there are more). Pictures in a reply stay placeholders. */
    async listReplies(laneId: LaneId, conn: unknown, userId: string, teamId: string, channelId: string, messageId: string): Promise<ReplyPage> {
      const res = await get<unknown>(laneId, conn, userId, {
        path: "/teams/{teamId}/channels/{channelId}/messages/{messageId}/replies",
        params: { teamId, channelId, messageId },
        query: { $top: REPLIES_PAGE },
      });
      const page = pageOf(res.data);
      const replies = page.value.flatMap((raw) => messageOf(raw, res.self) ?? []).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      // "more" is Graph's own next link; exactly one full page without one is not "more" (a count over the page size only if Graph ignored `$top`)
      return { replies, more: typeof page["@odata.nextLink"] === "string" || page.value.length > REPLIES_PAGE, self: res.self };
    },
  };
}

export type TeamsChannelReader = ReturnType<typeof createTeamsChannelReader>;
