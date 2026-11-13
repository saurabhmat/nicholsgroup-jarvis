// The result of a connect (T-035 callback → /{lane}/settings?connect=…&provider=…[&notice=remove_app_access]) as a fixed
// message for Settings. Only allowlisted codes map to text written here; anything else in the URL is ignored, so a crafted
// link can never put its own words on the page. Before this, the callback result was dropped and a refused connect looked
// like nothing happened.

import { AuthError, type Guards } from "@nichols/core/auth";
import { CONNECT_ROLES } from "@nichols/connectors/oauth";

export type ConnectResultMessage = { tone: "success" | "alert"; title: string; description: string };

const PROVIDERS: Record<string, string | undefined> = { google: "Google", quickbooks: "QuickBooks", composio: "Composio" };
const TOOLKITS: Record<string, string | undefined> = { gmail: "Gmail", googlecalendar: "Google Calendar" };

const REMOVE_ACCESS: Record<string, string> = {
  Google: "Google still lists the portal as having access: remove it at Google Account → Security → Third-party connections, then try again.",
  Composio: "The account may still exist in the Composio project: remove it in the Composio dashboard (Connected accounts), and, if you want, the app's access in your Google Account → Security → Third-party connections, then try again.",
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

export function connectResultMessage(params: SearchParams): ConnectResultMessage | null {
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
  const removeAccess = one(params.notice) === "remove_app_access" && (code === "account_refused" || code === "wrong_account" || code === "unavailable") ? ` ${REMOVE_ACCESS[baseName] ?? "Remove the portal's access at the provider, then try again."}` : "";
  switch (code) {
    case "ok":
      if (baseName === "Composio") return { tone: "success", title: `${name} connected`, description: "The account was checked and saved. If it replaced an earlier account, the earlier one stays in Composio until it is removed by hand. Mail and calendar keep syncing through the Google connection until this company is switched to Composio." };
      return { tone: "success", title: `${name} connected`, description: "Data syncs in the background. The sync times below update after the first sync." };
    case "account_refused":
      return {
        tone: "alert",
        title: `${name} account not accepted`,
        description:
          (baseName === "Composio"
            ? `The ${toolkit ?? "account"} you chose is not in this company's mailbox list, is for a different service, or is already connected to another company. Nothing was saved in Jarvis. Ask your administrator to add the address to the mailbox list.`
            : name === "Google"
            ? "The Google account you chose is not in this company's mailbox list, or is already connected to another company. Nothing was saved. Ask your administrator to add the address to the mailbox list."
            : `The ${name} account you chose is not the one set up for this company, or is already connected to another company. Nothing was saved.`) + removeAccess,
      };
    case "wrong_account":
      return {
        tone: "alert",
        title: `${name} account does not match`,
        description: `You chose a different ${name} account than the one being reconnected. Nothing was saved and the connection was not changed. Reconnect again with the same account, or use "Connect another Google account" to add a new one.${removeAccess}`,
      };
    case "denied":
      return { tone: "alert", title: "Connection cancelled", description: `Access was not granted at ${name}. Nothing was saved.` };
    case "invalid_state":
      return { tone: "alert", title: "Connection link expired", description: "This connect attempt expired or was already used. Nothing was saved. Start again with the Connect button." };
    case "exchange_failed":
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
export async function connectResultFor(g: Pick<Guards, "requireRole">, laneId: string, params: SearchParams): Promise<ConnectResultMessage | null> {
  const message = connectResultMessage(params);
  if (!message) return null;
  try {
    await g.requireRole(laneId, CONNECT_ROLES);
  } catch (e) {
    if (e instanceof AuthError) return null;
    throw e;
  }
  return message;
}
