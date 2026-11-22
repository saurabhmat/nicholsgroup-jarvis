// Settings -> Connections, "Your Microsoft accounts" (T-257, D-57; spec docs/specs/microsoft.md §5.5, §7). Same shape and the same read as the Google
// section (`loadMailSection`), next to it, never instead of it. Read-only SQL through the signed-in user's own lane client (RLS); no external call,
// no write. A member with `own_mail` (owner, admin_technical, viewer) sees their own accounts and, with the connections view, the HEALTH of the
// others'. The output type holds the address, the status and two sync times; tokens, tenant ids, cursors and content never reach it.
//   - Microsoft enabled for the company: the section with Connect / Reconnect per row, the admin consent link (public values) and Disconnect.
//   - Microsoft NOT enabled (never, or switched off after a connect): rows that exist are kept and listed as paused (no Connect, no Reconnect, data
//     kept, Disconnect still possible for the owner); with no rows there is no section at all.
//   - The company list could not be read: fail closed (no Connect, no Reconnect). Only a user who has Microsoft rows sees anything: their rows (their own
//     with Disconnect) and a neutral notice; with no Microsoft rows nothing about Microsoft is drawn. Google is not affected.
import { AuthError, type Guards } from "@nichols/core/auth";
import type { LaneId } from "@nichols/core";
import { CONNECT_ROLES, MAIL_CONNECT_ROLES } from "@nichols/connectors/oauth";
import { microsoftConnectInfo } from "@nichols/connectors/microsoft-settings";
import { loadMailSection, type GoogleSectionView } from "./google-connection";
import type { MailProvidersView } from "./mail-providers";
import type { MicrosoftWrites } from "./microsoft-wording";

export type MicrosoftSectionView = GoogleSectionView & {
  /** The tenant admin consent link (public values, nothing stored), only while Microsoft is enabled and the cloud is supported; otherwise null. */
  adminConsentUrl: string | null;
  /** From the same scope list as the link and the connect: true = write scopes are requested (the wording must not say "read-only"); false = read scopes only; null = not known (paused, status unread). */
  writes: MicrosoftWrites;
  /** The company's provider settings could not be read: rows are listed (own rows keep Disconnect) with no Connect or Reconnect, and a neutral notice. */
  settingsUnknown?: true;
};

type Db = Parameters<typeof loadMailSection>[0];
type RoleGuards = Pick<Guards, "requireRole">;
type Consent = (laneId: LaneId, settings: { cloud: string; tenantIds: readonly string[] }) => Promise<{ url: string | null; writes: boolean }>;

export const loadMicrosoftSection = (client: Db, laneId: string, userId?: string): Promise<GoogleSectionView> => loadMailSection(client, laneId, userId, "microsoft");

export async function microsoftSectionFor(
  g: RoleGuards,
  laneId: string,
  providers: MailProvidersView | null,
  load: (client: Db, laneId: string, userId?: string) => Promise<GoogleSectionView> = loadMicrosoftSection,
  consentLink: Consent = microsoftConnectInfo,
): Promise<MicrosoftSectionView | null> {
  if (providers === null) return null; // the caller may not connect their own mail here
  let client: Db;
  let userId: string;
  try {
    const r = await g.requireRole(laneId, [...MAIL_CONNECT_ROLES]);
    client = r.client;
    userId = r.session.userId;
  } catch (e) {
    if (e instanceof AuthError) return null;
    throw e;
  }
  // T-270: whether this person may use "Sync now" (owner, admin_technical), the same rule as the Google section; the one Sync now button on Settings reads it from either view.
  const canSync = await g.requireRole(laneId, [...CONNECT_ROLES]).then(
    () => true,
    // Any refusal or outage of this optional check only hides Sync now; it must never fail the Settings render.
    () => false,
  );
  const sync = canSync ? { canSync: true as const } : {};
  const settings = providers.state === "unknown" ? null : providers.microsoft;
  try {
    const view = await load(client, laneId, userId);
    if (providers.state === "unknown") return view.connections.length === 0 ? null : { ...view, ...sync, adminConsentUrl: null, writes: null, settingsUnknown: true };
    if (settings === null) return view.connections.length === 0 ? null : { ...view, ...sync, paused: true, adminConsentUrl: null, writes: null };
    const info = await consentLink(laneId as LaneId, settings).catch(() => ({ url: null, writes: true }));
    return { ...view, ...sync, adminConsentUrl: info.url, writes: info.writes };
  } catch {
    // The rows could not be read. Where Microsoft is enabled this says so; otherwise (not enabled, or not known) nothing about Microsoft is drawn.
    return settings === null ? null : { connections: [], unavailable: true, ...sync, adminConsentUrl: null, writes: null };
  }
}
