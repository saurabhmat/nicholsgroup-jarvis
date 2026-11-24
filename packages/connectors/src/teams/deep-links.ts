// Links that open Microsoft Teams (T-284, spec 13; vendor facts D7). Built server-side from VALIDATED values only, as https links, and never opened by the portal itself: the person's click
// opens them in a new tab. No message text, topic or member name is ever part of a link; the only variable parts are sign-in names that passed `upnOf` and a chat id that passed its format.
//   call:    https://teams.microsoft.com/l/call/0/0?users=<upn>[,<upn>...]          video: the same plus `&withVideo=true`
//   chat:    https://teams.microsoft.com/l/chat/<chatId>/conversations               (or the chat's own `webUrl` when it is on teams.microsoft.com)
//   channel: the channel's own `webUrl` (Graph returns it) when it is on teams.microsoft.com, otherwise Teams' front page (the fact sheet documents no link for a channel without it)
//   post:    the post's `webUrl` when it is on teams.microsoft.com, otherwise the documented channel-message link (vendor facts D7):
//            https://teams.microsoft.com/l/message/<channelId>/<messageId>?tenantId=<tenantId>&groupId=<teamId>&parentMessageId=<messageId>   (teamName, channelName and createdTime, which the page
//            also lists, are names or times the portal does not put in a link; H-084 shows whether Teams needs them)
import { ConnectorError } from "../contract/errors";
import { TEAMS_PARAM_FORMATS } from "./constants";
import { safeHttpsUrl } from "./message-html";
import { CALL_MAX_OTHERS, upnOf } from "./reader";

export const TEAMS_WEB_ORIGIN = "https://teams.microsoft.com";
const refused = (message: string) => new ConnectorError({ kind: "invalid_input", message });

/** The call (or video call) link for these sign-in names. Every name is validated again here; one to CALL_MAX_OTHERS names, no duplicates. */
export function callUrl(upns: readonly string[], video: boolean): string {
  if (upns.length === 0 || upns.length > CALL_MAX_OTHERS) throw refused("A call needs between one and ten people");
  const names = upns.map((u) => {
    const clean = typeof u === "string" ? upnOf(u) : null;
    if (clean === null || clean !== u) throw refused("A sign-in name is not valid for a call link");
    return clean;
  });
  if (new Set(names).size !== names.length) throw refused("A sign-in name is listed twice");
  // `@` stays readable (it is allowed in a query); every other reserved character in a name is percent-encoded, and the names are joined by a literal comma.
  const users = names.map((n) => encodeURIComponent(n).replace(/%40/g, "@")).join(",");
  return `${TEAMS_WEB_ORIGIN}/l/call/0/0?users=${users}${video ? "&withVideo=true" : ""}`;
}

/** Opens one chat in Teams: the chat's `webUrl` when it is an https link on teams.microsoft.com (checked again here), otherwise the documented link built from the chat id. */
export function openChatUrl(chatId: string, webUrl?: string | null): string {
  if (typeof webUrl === "string") {
    const u = safeHttpsUrl(webUrl);
    if (u && u.host === "teams.microsoft.com") return u.href;
  }
  const format = TEAMS_PARAM_FORMATS.chatId as RegExp;
  if (typeof chatId !== "string" || !format.test(chatId)) throw refused("The chat id is not valid");
  return `${TEAMS_WEB_ORIGIN}/l/chat/${chatId}/conversations`;
}

/** Opens one channel in Teams: its own `webUrl` when it is an https link on teams.microsoft.com (checked again here), otherwise Teams itself. No name or id is put in a link. */
export function openChannelUrl(webUrl?: string | null): string {
  if (typeof webUrl === "string") {
    const u = safeHttpsUrl(webUrl);
    if (u && u.host === "teams.microsoft.com") return u.href;
  }
  return TEAMS_WEB_ORIGIN;
}

/**
 * Opens one root post in Teams: the post's `webUrl` on teams.microsoft.com, otherwise the documented channel-message link built from VALIDATED ids only (channel id, post id, team id and the
 * account's tenant id); a reply opens its post (`parentMessageId` is the root post).
 */
export function openPostUrl(p: { webUrl?: string | null; channelId: string; messageId: string; teamId: string; tenantId: string }): string {
  if (typeof p.webUrl === "string") {
    const u = safeHttpsUrl(p.webUrl);
    if (u && u.host === "teams.microsoft.com") return u.href;
  }
  const ok = (name: string, v: unknown) => {
    const format = TEAMS_PARAM_FORMATS[name] as RegExp;
    if (typeof v !== "string" || !format.test(v)) throw refused("An id is not valid for a Teams link");
  };
  ok("channelId", p.channelId);
  ok("messageId", p.messageId);
  ok("teamId", p.teamId);
  ok("teamId", p.tenantId); // a tenant id is a lower-case UUID like a team id
  return `${TEAMS_WEB_ORIGIN}/l/message/${p.channelId}/${p.messageId}?tenantId=${p.tenantId}&groupId=${p.teamId}&parentMessageId=${p.messageId}`;
}
