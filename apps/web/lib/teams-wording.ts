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

// ---- several accounts per person (T-294, spec 22.3, 22.10). Fixed text; an address in a sentence is the person's own row read from the database, never text from a query or a provider.
export const TEAMS_ONE_ACCOUNT_TEXT = "You have connected as many Teams accounts as this company allows. Disconnect one to connect another.";
export const TEAMS_ALREADY_CONNECTED_TEXT = "That Teams account was already connected; its sign-in was refreshed. To add a different account, choose it on Microsoft's page (\"Use another account\"). If Microsoft did not let you choose, sign out of the other account at Microsoft or use a private browser window, then try again.";
export const teamsWrongAccountText = (upn: string | null): string =>
  upn === null
    ? "Microsoft signed in a different Teams account than the one you were reconnecting. Nothing was saved and the connection was not changed. Try again and choose the account you are reconnecting."
    : `Microsoft signed in a different Teams account. Nothing was saved and the connection was not changed. Try again and choose ${upn}.`;
export const TEAMS_DISCONNECTED_FIRST_TEXT = "Disconnect another Teams account first to use this one again.";
export const TEAMS_CONNECT_ANOTHER_TEXT = "Connect another Teams account";
export const teamsAtLimitText = (n: number): string => `You have connected ${String(n)} Teams ${n === 1 ? "account" : "accounts"}, the most this company allows.`;

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
export const MESSAGES_IMAGE_TEXT = "Image: open in Teams to see it";
export const MESSAGES_IMAGE_TAP_TEXT = "Image: tap to load";
export const MESSAGES_NOT_ENABLED_TEXT = "Teams is not switched on for this account or company right now. Check Settings, then Connections.";
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
export const CHANNELS_APPROVAL_TEXT = "Channels need your Microsoft administrator's approval. Ask them to approve the portal's Teams app, then reconnect Teams. It can also mean this account cannot use Teams channels right now: try Reconnect Teams or Try again.";
export const CHANNELS_LOAD_ERROR_TEXT = "The portal could not read your teams just now. Nothing was changed. Try again.";
export const CHANNELS_LIST_FORBIDDEN_TEXT = "Teams did not let the portal list the channels of this team. Try again, or reconnect Teams.";
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
export const CHANNELS_POSTS_ORDER_TEXT = "Posts with the newest replies come first.";
export const CHANNELS_SHARED_OPEN_TEXT = "This is a shared channel. The portal does not read shared channels: open it in Teams.";

// ---- live updates (T-290, spec 9.4)
export const MESSAGES_LIVE_OFF_TEXT = "Live updates unavailable";
export const MESSAGES_NEW_DOT_LABEL = "New messages";
export const messagesLiveUntilText = (when: string): string => `Live updates until ${when}`;
export const messagesRefreshWaitText = (seconds: number): string => `Already up to date. You can refresh again in ${String(Math.max(1, Math.ceil(seconds)))} seconds.`;
export const MESSAGES_REFRESH_FAILED_TEXT = "Could not refresh just now. What you see is as of your last refresh.";

// ---- several accounts on Messages (T-295, spec 22.5). One plain line per account that did not answer; the label is the account's own (its domain or the part before the @), computed from the person's
// own sign-in names, never from chat content.
export const MESSAGES_ACCOUNT_CHANGED_TEXT = "One of your Teams accounts changed; showing the others.";
export const messagesAccountExpiredText = (label: string): string => `${label}: Your Teams sign-in expired.`;
export const messagesAccountBusyText = (label: string, seconds: number | null): string =>
  seconds === null ? `${label}: Teams is busy; try again in a moment.` : `${label}: Teams is busy; try again in ${String(seconds)} ${seconds === 1 ? "second" : "seconds"}.`;
export const messagesAccountUnreachableText = (label: string): string => `${label}: Teams could not be reached.`;
export const messagesReconnectAccountLabel = (label: string): string => `Reconnect ${label}`;
/** "pub-k.org: Reconnect Teams to add call buttons." (a missing feature said for that account only). */
export const messagesAccountFeatureText = (label: string, text: string): string => `${label}: ${text}`;
export const messagesAccountBadgeName = (upn: string): string => `Account: ${upn}`;
export const MESSAGES_CONNECTED_AS_SEVERAL = "Your Teams accounts are connected.";
export const MESSAGES_ACCOUNT_STATE_OK = "Connected";
export const MESSAGES_ACCOUNT_STATE_DEGRADED = "Connected, with problems";
export const MESSAGES_ACCOUNT_STATE_RECONNECT = "Sign-in expired";
export const messagesRefreshWaitSecondsText = (seconds: number): string => `Teams asked to wait. You can try again in ${String(Math.max(1, Math.ceil(seconds)))} seconds.`;
export const MESSAGES_PICK_ACCOUNT_TEXT = "This link does not say which Teams account the chat belongs to. Pick the chat from the list.";
/** T-296: the same for a team in the address that no account of the person opens. */
export const CHANNELS_PICK_ACCOUNT_TEXT = "This link does not say which Teams account the team belongs to. Pick the channel from the list.";
/** T-296: the heading of one account's teams when the person has two or more accounts that can read channels. */
export const channelsGroupLabel = (upn: string): string => `Teams of ${upn}`;
