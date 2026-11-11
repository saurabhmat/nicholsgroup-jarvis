// Google wiring (T-063): the OAuth provider, token manager, Gmail API client, mail provider and sync over the real
// Vault, lane router (through the vault module) and connector env. Server-only. Credentials are read from the connector
// env at call time (`requireConnectorEnv("google")` fails closed naming missing variables, never printing values).
import type { LaneId } from "@nichols/core";
import { requireConnectorEnv } from "@nichols/core/env/server";
import type { LaneBoundConnection } from "../contract/lane-bound";
import { calendarIndexStore, connectionLoader, getToken, laneConfigReader, mailIndexStore, revokeToken, rotateToken, storeToken, writePolicyReader } from "../vault/index";
import { SecretValue } from "../vault/secret";
import { createGoogleApi } from "./api";
import { createCalendarSync } from "./cal-sync";
import { createGoogleCalendarProvider } from "./calendar";
import { createGmailProvider } from "./mail";
import { createMailSync } from "./mail-sync";
import { createGoogleOAuthProvider, type GoogleClientConfig } from "./provider";
import { createGoogleTokenManager } from "./token-manager";
import { createGoogleEmailWriter } from "./email-writer";
import { createGoogleWriter } from "./writer";

function client(): GoogleClientConfig {
  const env = requireConnectorEnv("google");
  return { clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: new SecretValue(env.GOOGLE_OAUTH_CLIENT_SECRET), redirectUri: env.GOOGLE_REDIRECT_URI };
}

export const googleOAuthProvider = createGoogleOAuthProvider({ client, laneConfig: laneConfigReader, composeAllowed: (laneId) => writePolicyReader.emailWritesAllowed(laneId) });

const vault = { getToken, rotateToken, storeToken, revokeToken };
const tokens = createGoogleTokenManager({ vault, client });
const api = createGoogleApi({ tokens });
const connections = { load: (laneId: string, id: string) => connectionLoader.loadConnection(laneId, id) };

/** Gmail metadata sync, live body, live search. Polling until T-065 adds push. */
export const gmailProvider = createGmailProvider({ api, connections, laneConfig: laneConfigReader });
/** Runs one connection's mail metadata sync into comms.message_index (the sync job calls this; Inngest wiring: T-038/T-065). */
export const mailSync = createMailSync({ mail: gmailProvider, store: mailIndexStore });

/**
 * Inbox (T-202): one message's text, read live from Gmail and never stored (rule 6), wrapped as untrusted data (rule 9).
 * The caller must first have proved, under RLS with the user's own lane client, that the user may see this message in
 * this lane (core.inbox_message_ref); the provider's guard then re-checks lane, provider, connection status and the
 * lane's mailbox list before any call to Google. Read-only (gmail.readonly).
 */
export async function readGmailBody(laneId: LaneId, connectionId: string, messageId: string): Promise<{ text: string; truncated: boolean }> {
  const conn = await connectionLoader.loadConnection(laneId, connectionId);
  const res = await gmailProvider.readBody(laneId, conn as LaneBoundConnection<"google">, messageId);
  // Revealed here, for display to the signed-in user only: the caller renders it as plain text and must not store or log it.
  return { text: res.data.reveal(), truncated: res.data.truncated };
}

/** Google Calendar event metadata sync, live description. Polling (calendar push is not built). */
export const googleCalendarProvider = createGoogleCalendarProvider({ api, connections, laneConfig: laneConfigReader });
/** Runs one connection's calendar metadata sync into cal.event_index (the sync job calls this; Inngest wiring: T-038). */
export const calSync = createCalendarSync({ calendar: googleCalendarProvider, store: calendarIndexStore });

/** Revoke-at-Google and delete-Vault-tokens (D-24: approvals only). No route, job or connector method calls it. */
export const googleWriter = createGoogleWriter({ vault, connections, tokens });

/** Send or save-as-draft an approved email (T-232; approvals only, via the write subpath). Never called by a route, job or tool. */
export const googleEmailWriter = createGoogleEmailWriter({ connections, tokens, api, laneConfig: laneConfigReader });

export { mailIndexStore, calendarIndexStore };
export { GOOGLE_SLUG, GOOGLE_SCOPES } from "./constants";
