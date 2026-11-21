// Google wiring (T-063): the OAuth provider, token manager, Gmail API client, mail provider and sync over the real
// Vault, lane router (through the vault module) and connector env. Server-only. Credentials are read from the connector
// env at call time (`requireConnectorEnv("google")` fails closed naming missing variables, never printing values).
import type { LaneId } from "@nichols/core";
import { requireConnectorEnv } from "@nichols/core/env/server";
import type { LaneBoundConnection } from "../contract/lane-bound";
import { createProviderGate } from "../facade/gate";
import { mailAccountAllowed, readMailPolicy } from "../mail-policy";
import { actionClaimReader, calendarIndexStore, connectionLoader, connectionStore, getToken, laneConfigReader, mailIndexStore, revokeToken, rotateToken, storeToken, writePolicyReader } from "../vault/index";
import { SecretValue } from "../vault/secret";
import { createGoogleApi } from "./api";
import { createCalendarSync } from "../comms/cal-sync";
import { createGoogleCalendarProvider } from "./calendar";
import { createGmailProvider } from "./mail";
import { createMailSync } from "../comms/mail-sync";
import { createGoogleOAuthProvider, type GoogleClientConfig } from "./provider";
import { createGoogleTokenManager } from "./token-manager";
import { createGoogleEmailWriter, type GoogleEmailReconciler } from "./email-writer";
import { createGoogleWriter } from "./writer";

function client(): GoogleClientConfig {
  const env = requireConnectorEnv("google");
  return { clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: new SecretValue(env.GOOGLE_OAUTH_CLIENT_SECRET), redirectUri: env.GOOGLE_REDIRECT_URI };
}

const providerGate = createProviderGate({ laneConfig: laneConfigReader });

export const googleOAuthProvider = createGoogleOAuthProvider({ client, laneConfig: laneConfigReader, googleEnabled: (laneId) => providerGate.enabled(laneId, "google"), composeAllowed: (laneId) => writePolicyReader.emailWritesAllowed(laneId) });

const vault = { getToken, rotateToken, storeToken, revokeToken };
const tokens = createGoogleTokenManager({ vault, client });
const api = createGoogleApi({ tokens });
const connections = { load: (laneId: string, id: string) => connectionLoader.loadConnection(laneId, id) };

/** Gmail metadata sync, live body, live search. Polling until T-065 adds push. */
export const gmailProvider = createGmailProvider({ api, connections, laneConfig: laneConfigReader });
/** Runs one connection's mail metadata sync into comms.message_index (the sync job calls this; Inngest wiring: T-038/T-065). */
export const mailSync = createMailSync({ mail: gmailProvider, store: mailIndexStore });

/**
 * The lane's mail addresses, lower-cased: the configured exact list plus every connected mail account (whoever owns it). Used to
 * recognise "our own" addresses (never reply to ourselves). It does NOT decide whether a sender is allowed: that is `mailAccountAllowed`.
 */
export async function laneMailboxes(laneId: LaneId): Promise<string[]> {
  const [configured, connected] = await Promise.all([laneConfigReader.mailboxes(laneId), connectionStore.listMailAccounts(laneId)]);
  return [...new Set([...configured, ...connected])];
}

/** Whether `address` may be a sender in this lane: allowed domain (and on the exact list when the lane keeps one). Fails closed when the config cannot be read. */
export async function mailboxAllowed(laneId: LaneId, address: string): Promise<boolean> {
  return mailAccountAllowed(await readMailPolicy(laneConfigReader, laneId), address);
}

/** Google Calendar event metadata sync, live description. Polling (calendar push is not built). */
export const googleCalendarProvider = createGoogleCalendarProvider({ api, connections, laneConfig: laneConfigReader });
/** Runs one connection's calendar metadata sync into cal.event_index (the sync job calls this; Inngest wiring: T-038). */
export const calSync = createCalendarSync({ calendar: googleCalendarProvider, store: calendarIndexStore });

/** Revoke-at-Google and delete-Vault-tokens (D-24: approvals only). No route, job or connector method calls it. */
export const googleWriter = createGoogleWriter({ vault, connections, tokens });

/** Send or save-as-draft an approved email (T-232; approvals only, via the write subpath). Never called by a route, job or tool. */
export const googleEmailWriter = createGoogleEmailWriter({ connections, tokens, api, laneConfig: laneConfigReader, claims: actionClaimReader });

/** Recovery (T-192): the writer's read side only (marker lookup and read-back). It has no `executeWrite`, so a reconciler cannot send. */
export const googleEmailReconciler: GoogleEmailReconciler = Object.freeze({ findWrite: googleEmailWriter.findWrite, verifyWrite: googleEmailWriter.verifyWrite });

/** The authoritative, lane-bound Google connection row the email writer runs on (write subpath only). */
export async function loadGoogleWriteConnection(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection<"google">> {
  return (await connectionLoader.loadConnection(laneId, connectionId)) as LaneBoundConnection<"google">;
}

export { mailIndexStore, calendarIndexStore };
export { GOOGLE_SLUG, GOOGLE_SCOPES } from "./constants";
