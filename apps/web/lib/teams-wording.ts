// Fixed Teams wording (T-280). No text from a config, a query or a provider is ever rendered (rule 9): everything the person reads is written here. Plain constants and functions, in a
// file without a directive, so a server component and a client component can both import them.
import type { TeamsFeature } from "@nichols/core/lane-config";

export const TEAMS_PROVIDER = "microsoft_teams";
export const TEAMS_PAUSED_TEXT = "Paused: Teams is not enabled for this company";
export const TEAMS_NOT_SET_UP_TEXT = "Teams is not set up for this company.";
export const TEAMS_CLOUD_UNSUPPORTED_TEXT = "Paused: this Microsoft cloud is not supported for Teams yet";
export const TEAMS_CLOUD_UNSUPPORTED_PAGE_TEXT = "Teams is not available yet on this company's Microsoft cloud.";
export const TEAMS_PAUSED_PAGE_TEXT = "Teams is paused for this company.";
export const TEAMS_CONNECTS_TEXT = "This connects your Microsoft Teams account to this company. It is not your portal sign-in. The portal shows your own chats when you open them and stores no message text.";
export const TEAMS_ADMIN_CONSENT_TEXT = "Your organisation's Microsoft admin must approve the portal's Teams app once (Entra admin centre → Enterprise applications → the app → Permissions → Grant admin consent).";
/** Where a person removes the portal's access, since Disconnect only deletes what the portal stored. */
export const TEAMS_REMOVE_AT_MICROSOFT_TEXT = "remove it in your Microsoft account (My Apps) or ask your Microsoft 365 administrator to remove it in the Entra admin center (Enterprise apps → the app → Permissions).";
export const TEAMS_REMOVE_ACCESS_TEXT = `Disconnect deletes the access the portal stored and does not contact Microsoft, so Microsoft may still list the app: ${TEAMS_REMOVE_AT_MICROSOFT_TEXT}`;

/** What a missing feature is called in "Reconnect Teams to add …". */
const FEATURE_WORDS: Record<TeamsFeature, string> = {
  chat_read: "chats",
  chat_send: "sending",
  call_links: "call buttons",
  channels_read: "channels",
  channels_send: "channel posts",
};

export function reconnectToAddText(missing: readonly TeamsFeature[]): string {
  const words = [...new Set(missing.map((f) => FEATURE_WORDS[f]))];
  if (words.length === 0) return "";
  return `Reconnect Teams to add ${words.length === 1 ? (words[0] as string) : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1] as string}`}. What you already have keeps working.`;
}

// ---- Messages page: the chat list and conversation (T-283, T-284). Fixed text only; a chat's own words are never part of a sentence here.
export const MESSAGES_LOAD_ERROR_TITLE = "Teams could not be reached";
export const MESSAGES_LOAD_ERROR_TEXT = "The portal could not read your chats just now. Nothing was changed. Try again.";
export const MESSAGES_RECONNECT_TITLE = "Your Teams sign-in expired";
export const MESSAGES_FORBIDDEN_TEXT = "Teams did not allow the portal to read this. If it keeps happening, reconnect Teams in Settings.";
export const MESSAGES_EMPTY_LIST_TEXT = "You have no chats in Teams yet, or none the portal can show.";
export const MESSAGES_NO_CHAT_SELECTED_TEXT = "Choose a chat to read it. Messages are read from Teams when you open them; the portal stores none of them.";
export const MESSAGES_CHAT_NOT_FOUND_TEXT = "This chat could not be opened. It may have been removed, or it is not one of your chats.";
export const MESSAGES_TIMES_NOTE = "Times are Eastern Time (ET).";
export const MESSAGES_FILE_OPENS_IN_MICROSOFT = "Opens in Microsoft";
export const MESSAGES_IMAGE_TEXT = "Image: open the chat in Teams to see it";
export const MESSAGES_TRUNCATED_TEXT = "This message is long; open the chat in Teams to read the rest.";
export const MESSAGES_NO_OLDER_TEXT = "This is the start of the chat.";

/** "Teams is busy, try again in 7 seconds" (Microsoft's Retry-After, shown as is: never retried by the portal on its own). */
export function messagesBusyText(seconds: number | null): string {
  if (seconds === null) return "Teams is busy. Try again in a moment.";
  return `Teams is busy. Try again in ${String(seconds)} ${seconds === 1 ? "second" : "seconds"}.`;
}

/** Why a chat has no Call buttons, in words (Open in Teams is always there). */
export function callUnavailableText(reason: "external" | "too_many" | "no_one" | "off_lane" | "needs_reconnect"): string | null {
  switch (reason) {
    case "external":
      return "Calls from here are for chats with people in your own organisation. Use Open in Teams for this chat.";
    case "too_many":
      return "Calls from here are limited to ten people. Use Open in Teams for this chat.";
    case "needs_reconnect":
      return "Reconnect Teams to add call buttons.";
    case "no_one":
    case "off_lane":
      return null;
  }
}

// ---- Channels (T-291, spec 11 "States"). Fixed text only; a team's or channel's own words are never part of a sentence here.
export const CHANNELS_NOT_ON_TEXT = "Channels are not switched on for this company.";
export const CHANNELS_APPROVAL_TITLE = "Channels need your Microsoft administrator's approval";
export const CHANNELS_APPROVAL_TEXT = "Channels need your Microsoft administrator's approval. Ask them to approve the portal's Teams app, then reconnect Teams.";
export const CHANNELS_LOAD_ERROR_TEXT = "The portal could not read your teams just now. Nothing was changed. Try again.";
export const CHANNELS_FORBIDDEN_TEXT = "Teams did not let the portal read this. A private channel can be read only by its members.";
export const CHANNELS_NO_TEAMS_TEXT = "You have not joined any team, or none the portal can show.";
export const CHANNELS_NO_CHANNELS_TEXT = "This team has no channels you can see.";
export const CHANNELS_NO_TEAM_SELECTED_TEXT = "Choose a team, then a channel, to read its posts. Posts are read from Teams when you open them; the portal stores none of them. Teams offers no unread marker for channels.";
export const CHANNELS_NO_CHANNEL_SELECTED_TEXT = "Choose a channel to read its posts.";
export const CHANNELS_NOT_FOUND_TEXT = "This channel could not be opened. It may have been removed, or you are not a member of it.";
export const CHANNELS_NO_POSTS_TEXT = "No posts in this channel yet.";
export const CHANNELS_SHARED_TEXT = "Shared channel: open it in Teams.";
export const CHANNELS_MORE_TEAMS_TEXT = "More teams exist than are listed here.";
export const CHANNELS_REPLIES_MORE_TEXT = "There are more replies; open the post in Teams to read the rest.";
export const CHANNELS_REPLIES_ERROR_TEXT = "The replies could not be read just now. Try again.";
export const CHANNELS_NO_REPLIES_TEXT = "No replies.";
