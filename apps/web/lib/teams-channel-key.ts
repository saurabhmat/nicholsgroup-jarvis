// The team, channel, post and picture identifiers in the page and route addresses (T-291, T-285; spec 6 "Id formats", 11). Plain functions (no directive): server and client components use them.
//   ?tab=channels&team=<team id>&channel=<base64url of the channel id>&post=<post id>
// A channel id has the same `19:...@thread.tacv2` shape as a chat id and is encoded the same way (`encodeChatKey`): awkward characters out of the address, and decoding VALIDATES it, so a made-up key
// is "nothing selected" and never reaches Graph. A team id is a lower-case UUID; a post and a hosted-content id use the connector's own bound (the fact sheet gives no format). The connector
// checks every id again before any request.
import { decodeChatKey, encodeChatKey, isChatId } from "./teams-chat-key";

export const encodeChannelKey = encodeChatKey;
export const decodeChannelKey = decodeChatKey;
export const isChannelId = isChatId;

const TEAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MESSAGE_ID = /^[A-Za-z0-9._:=@-]{1,256}$/;

export const isTeamId = (v: unknown): v is string => typeof v === "string" && TEAM_ID.test(v);
/** A post, message or hosted-content id (the connector's own bound). */
export const isMessageId = (v: unknown): v is string => typeof v === "string" && MESSAGE_ID.test(v) && v !== "." && v !== ".."; // a dot segment is no id (the connector refuses it too)

/** `?tab=channels...` for the Messages page; `team`, `channel`, `post` and `more` only when given and valid. */
export function channelsHref(base: string, p: { team?: string | null; channel?: string | null; post?: string | null; more?: string | null }): string {
  const q = new URLSearchParams({ tab: "channels" });
  if (p.team) q.set("team", p.team);
  if (p.team && p.channel) q.set("channel", p.channel);
  if (p.team && p.channel && p.post) q.set("post", p.post);
  if (p.team && p.channel && p.more) q.set("more", p.more);
  return `${base}?${q.toString()}`;
}
