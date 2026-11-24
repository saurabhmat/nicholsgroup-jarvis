// The result of a connect (T-035 callback → /{lane}/settings?connect=…&provider=…[&notice=remove_app_access]) as a fixed
// message for Settings. Only allowlisted codes map to text written here; anything else in the URL is ignored, so a crafted
// link can never put its own words on the page. Before this, the callback result was dropped and a refused connect looked
// like nothing happened.

import { AuthError, type Guards } from "@nichols/core/auth";
import { MAIL_CONNECT_ROLES } from "@nichols/connectors/oauth";
import { microsoftConnects, type MicrosoftWrites } from "./microsoft-wording";
import { TEAMS_ADMIN_CONSENT_TEXT, TEAMS_ALREADY_CONNECTED_TEXT, TEAMS_ONE_ACCOUNT_TEXT, TEAMS_PROVIDER, TEAMS_REMOVE_AT_MICROSOFT_TEXT, teamsWrongAccountText } from "./teams-wording";

export type ConnectResultMessage = { tone: "success" | "alert"; title: string; description: string };

const PROVIDERS: Record<string, string | undefined> = { google: "Google", quickbooks: "QuickBooks", composio: "Composio", microsoft: "Microsoft", [TEAMS_PROVIDER]: "Teams" };
const TOOLKITS: Record<string, string | undefined> = { gmail: "Gmail", googlecalendar: "Google Calendar" };

const REMOVE_ACCESS: Record<string, string> = {
  Google: "Google still lists the portal as having access: remove it at Google Account → Security → Third-party connections, then try again.",
  Composio: "The account may still exist in the Composio project: remove it in the Composio dashboard (Connected accounts), and, if you want, the app's access in your Google Account → Security → Third-party connections, then try again.",
  Microsoft: "Microsoft may still list the portal as having access: remove it in your Microsoft account's app permissions page (My Account → Apps and services, or ask your administrator), then try again.",
  Teams: `Microsoft may still list the portal as having access: ${TEAMS_REMOVE_AT_MICROSOFT_TEXT} Then try again.`,
  QuickBooks: "QuickBooks still lists the portal as having access: remove it under the company's connected apps in QuickBooks, then try again.",
};

type SearchParams = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/**
 * Banners for a connect that could not start because the server is not configured (`?error=<code>`, set by the start route).
 * Fixed text chosen by an allowlisted code; the variable names in it are written here, not read from the request or the error.
 */
const SERVER_NOT_CONFIGURED: Record<string, ConnectResultMessage | undefined> = {
  google_env: {
    tone: "alert",
    title: "Google isn't configured on this server.",
    description: "Check GOOGLE_REDIRECT_URI and NEXT_PUBLIC_APP_URL (same https domain) and redeploy.",
  },
  connect_env: {
    tone: "alert",
    title: "This connection isn't configured on this server.",
    description: "Ask your administrator to check the server's connection settings and redeploy.",
  },
};

/** What the page knows about Microsoft for this lane (T-257 review): whether it is enabled, and whether the connect asks for write scopes (null = not known). */
export type MicrosoftContext = { enabled: boolean; writes: MicrosoftWrites };

/** What the page knows about Teams for this lane: whether the Messages page is switched on for the company (a limited company must list the module; T-278 review C4). */
export type TeamsContext = {
  messagesShown: boolean;
  /** T-294: the sign-in name of the person's OWN Teams row that a reconnect named (`?conn=<id>`, looked up in the database by the page); null = not known. Never taken from the address. */
  reconnectAccount?: string | null;
};

/**
 * The one short sentence for a refused Teams account, by a coarse FIXED sub-code from the connector (`detail` in the redirect; T-278 review C1). Only these keys are ever used: an
 * unknown or missing value (or anything crafted into the address) falls back to a neutral sentence. Nothing from Microsoft is in any of them.
 */
export const TEAMS_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  domain: "The Teams account you chose is not on a sign-in domain this company allows. Sign in with your company's Teams account, or ask your administrator to add the domain.",
  guest: "Guest accounts cannot be connected. Sign in with a member account of your organisation.",
  scope_missing: "Microsoft did not grant a permission that Teams needs. Ask your Microsoft administrator to approve the portal's Teams app, with all of its permissions, then try again.",
  scope_extra: "Microsoft listed a permission that the Teams connection may not hold. Ask your Microsoft administrator to remove it from the portal's Teams app, then try again.",
  not_enabled: "Teams is not enabled for this company. Ask your administrator.",
  other_company: "This Teams account is already connected elsewhere in Jarvis: in another company, or under another sign-in name. Each Teams account belongs to one company.",
  one_account: TEAMS_ONE_ACCOUNT_TEXT,
  already_connected: TEAMS_ALREADY_CONNECTED_TEXT,
  other_person: "This Teams account is already connected by another person. Each Teams account belongs to the person who connected it.",
  not_set_up: "Teams isn't fully set up for this company: the Teams app lacks a permission the company asked for. Ask your administrator.",
});
const TEAMS_NEUTRAL = "The Teams account was not accepted. Try again, or ask your administrator.";
const teamsDetail = (params: SearchParams): string | undefined => {
  const d = one(params.detail);
  return d !== undefined && Object.hasOwn(TEAMS_REFUSALS, d) ? d : undefined;
};

export function connectResultMessage(params: SearchParams, microsoft: MicrosoftContext = { enabled: false, writes: null }, teams: TeamsContext = { messagesShown: true }): ConnectResultMessage | null {
  const code = one(params.connect);
  if (!code) {
    const err = one(params.error);
    return err !== undefined && Object.hasOwn(SERVER_NOT_CONFIGURED, err) ? (SERVER_NOT_CONFIGURED[err] ?? null) : null;
  }
  const baseName = PROVIDERS[one(params.provider) ?? ""] ?? "The provider";
  const toolkit = baseName === "Composio" ? TOOLKITS[one(params.toolkit) ?? ""] : undefined;
  // A Composio connect is named by its toolkit ("Gmail via Composio"); the notice text still keys on "Composio".
  const name = baseName === "Composio" && toolkit ? `${toolkit} via Composio` : baseName;
  // The server sets the notice only when a grant was obtained but not stored (flow.ts: account_refused or unavailable).
  const removeAccess = one(params.notice) === "remove_app_access" && (code === "account_refused" || code === "wrong_account" || code === "wrong_tenant" || code === "unavailable") ? ` ${REMOVE_ACCESS[baseName] ?? "Remove the portal's access at the provider, then try again."}` : "";
  const ms = baseName === "Microsoft" ? ` ${microsoftConnects(microsoft.writes)}` : "";
  switch (code) {
    // T-257: the return from the tenant admin consent link (the callback sends only these two codes, nothing from Microsoft) and a local Disconnect.
    case "consent_ok":
    case "consent_failed":
    case "disconnected":
      if (baseName === "Teams") {
        // Neutral, driven by the URL: it does not assert that anything was deleted. (A crafted link can show it; it grants nothing.)
        if (code !== "disconnected") return null;
        return { tone: "success", title: "Teams disconnect", description: `If you disconnected a Teams account, the access the portal stored for it was deleted here. Nothing is sent to Microsoft, so Microsoft may still list the app: ${TEAMS_REMOVE_AT_MICROSOFT_TEXT}` };
      }
      if (baseName !== "Microsoft") return null;
      // The consent return is shown only where Microsoft is enabled: a crafted link cannot put it on a lane that does not use Microsoft.
      if (code !== "disconnected" && !microsoft.enabled) return null;
      if (code === "consent_ok") return { tone: "success", title: "Microsoft sent the administrator back", description: "If they approved the app, you can now use Connect Microsoft. Nothing was saved in the portal." };
      if (code === "consent_failed") return { tone: "alert", title: "Administrator approval was not completed", description: "Nothing was saved. Ask your Microsoft 365 administrator to try the approval link again." };
      return {
        tone: "success",
        title: "Microsoft disconnect",
        // Neutral: this banner is driven by the URL, so it does not assert that anything was deleted; the Disconnect button's own success is what led here.
        description:
          "If you disconnected a Microsoft account, the access the portal stored for it was deleted here. Nothing is sent to Microsoft, so Microsoft may still list the app: you or your Microsoft 365 administrator can remove the app's access in your Microsoft account or in the Entra admin center (Enterprise apps → the app → Permissions).",
      };
    case "ok":
      if (baseName === "Teams") {
        return {
          tone: "success",
          title: teamsDetail(params) === "already_connected" ? "That Teams account was already connected" : "Teams connected",
          description: teamsDetail(params) === "already_connected" ? TEAMS_ALREADY_CONNECTED_TEXT : `Your Teams account is connected. ${teams.messagesShown ? "Open Messages to use it." : "Messages is not switched on for this company yet: ask your administrator."} The portal stores no message text.`,
        };
      }
      if (baseName === "Composio") return { tone: "success", title: `${name} connected`, description: "The account was checked and saved. If it replaced an earlier account, the earlier one stays in Composio until it is removed by hand. Mail and calendar keep syncing through the Google connection until this company is switched to Composio." };
      return { tone: "success", title: `${name} connected`, description: "Data syncs in the background. The sync times below update after the first sync." };
    case "account_refused":
      return {
        tone: "alert",
        title: `${name} account not accepted`,
        description:
          (baseName === "Composio"
            ? `The ${toolkit ?? "account"} you chose is not in this company's mailbox list, is for a different service, or is already connected to another company. Nothing was saved in Jarvis. Ask your administrator to add the address to the mailbox list.`
            : name === "Teams"
            ? `${TEAMS_REFUSALS[teamsDetail(params) ?? ""] ?? TEAMS_NEUTRAL} Nothing was saved.`
            : name === "Google"
            ? "The Google account you chose is not on a domain this company allows, or is already connected to another company or to another person. Nothing was saved. Ask your administrator if you think it should be allowed."
            : `The ${name} account you chose is not the one set up for this company, or is already connected to another company. Nothing was saved.`) + ms + removeAccess,
      };
    case "wrong_account":
      if (baseName === "Teams") return { tone: "alert", title: "Teams account does not match", description: `${teamsWrongAccountText(teams.reconnectAccount ?? null)}${removeAccess}` };
      return {
        tone: "alert",
        title: `${name} account does not match`,
        description: `You chose a different ${name} account than the one being reconnected. Nothing was saved and the connection was not changed. Reconnect again with the same account${name === "Google" ? ', or use "Connect another Google account" to add a new one' : ""}.${ms}${removeAccess}`,
      };
    case "wrong_tenant":
      return {
        tone: "alert",
        title: `${name} organisation not accepted`,
        description: `The ${name} account you chose belongs to an organisation that is not set up for this company. Nothing was saved. Sign in with your work account for this company, or ask your administrator.${ms}${removeAccess}`,
      };
    case "admin_consent_required":
      if (baseName === "Teams") return { tone: "alert", title: "Teams needs administrator approval", description: `Nothing was saved. ${TEAMS_ADMIN_CONSENT_TEXT} Then sign in to Teams again.` };
      return {
        tone: "alert",
        title: `${name} needs administrator approval`,
        description: `Your organisation requires an administrator to approve this app before you can connect it. Nothing was saved. Ask your ${name} administrator to approve it, then try again.${baseName === "Microsoft" ? " If Settings shows an administrator approval link, you can send it to them." : ""}${ms}`,
      };
    case "denied":
      if (baseName === "Teams" && teamsDetail(params) === "not_set_up") return { tone: "alert", title: "Teams isn't fully set up", description: `${TEAMS_REFUSALS.not_set_up} Nothing was saved.` };
      return { tone: "alert", title: "Connection cancelled", description: `Access was not granted at ${name}. Nothing was saved.` };
    case "invalid_state":
      return { tone: "alert", title: "Connection link expired", description: "This connect attempt expired or was already used. Nothing was saved. Start again with the Connect button." };
    case "exchange_failed":
      if (baseName === "Teams" && teamsDetail(params) === "not_set_up") return { tone: "alert", title: "Teams isn't fully set up", description: `${TEAMS_REFUSALS.not_set_up} Nothing was saved.` };
      return { tone: "alert", title: "Connection not completed", description: `${name} did not complete the connection. Nothing was saved. Try again.` };
    case "unavailable":
      return { tone: "alert", title: "Connection not completed", description: `The connection could not be completed just now. Try again in a minute.${removeAccess}` };
    default:
      return null;
  }
}

/**
 * The message for the Settings page, shown only to users who could have started a connect in this lane (owner or
 * admin_technical at AAL2, as the Connect buttons): a crafted link cannot show a connect result to anyone else.
 */
export async function connectResultFor(g: Pick<Guards, "requireRole">, laneId: string, params: SearchParams, microsoft?: MicrosoftContext, teams?: TeamsContext): Promise<ConnectResultMessage | null> {
  const message = connectResultMessage(params, microsoft, teams);
  if (!message) return null;
  try {
    await g.requireRole(laneId, [...MAIL_CONNECT_ROLES]); // T-247: anyone who may connect their own Google account sees the result
  } catch (e) {
    if (e instanceof AuthError) return null;
    throw e;
  }
  return message;
}
