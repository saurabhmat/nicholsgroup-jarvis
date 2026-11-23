// Fixed Teams wording (T-280). No text from a config, a query or a provider is ever rendered (rule 9): everything the person reads is written here. Plain constants and functions, in a
// file without a directive, so a server component and a client component can both import them.
import type { TeamsFeature } from "@nichols/core/lane-config";

export const TEAMS_PROVIDER = "microsoft_teams";
export const TEAMS_PAUSED_TEXT = "Paused: Teams is not enabled for this company";
export const TEAMS_NOT_SET_UP_TEXT = "Teams is not set up for this company.";
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
