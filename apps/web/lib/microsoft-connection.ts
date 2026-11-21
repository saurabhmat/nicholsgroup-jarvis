// Settings -> Connections, "Your Microsoft accounts" (T-257, D-57; spec docs/specs/microsoft.md §5.5, §7). Same shape and the same read as the Google
// section (`loadMailSection`), next to it, never instead of it. Read-only SQL through the signed-in user's own lane client (RLS); no external call,
// no write. A member with `own_mail` (owner, admin_technical, viewer) sees their own accounts and, with the connections view, the HEALTH of the
// others'. The output type holds the address, the status and two sync times; tokens, tenant ids, cursors and content never reach it.
//   - Microsoft enabled for the company: the section with Connect / Reconnect per row, the admin consent link (public values) and Disconnect.
//   - Microsoft NOT enabled (never, or switched off after a connect): rows that exist are kept and listed as paused (no Connect, no Reconnect, data
//     kept, Disconnect still possible for the owner); with no rows there is no section at all.
//   - The company list could not be read: the section is replaced by "status unavailable"; Google is not affected.
import { AuthError, type Guards } from "@nichols/core/auth";
import type { LaneId } from "@nichols/core";
import { MAIL_CONNECT_ROLES } from "@nichols/connectors/oauth";
import { microsoftAdminConsentLink } from "@nichols/connectors/microsoft-settings";
import { loadMailSection, type GoogleSectionView } from "./google-connection";
import type { MailProvidersView } from "./mail-providers";

export type MicrosoftSectionView = GoogleSectionView & {
  /** The tenant admin consent link (public values, nothing stored), only while Microsoft is enabled and the cloud is supported; otherwise null. */
  adminConsentUrl: string | null;
};

type Db = Parameters<typeof loadMailSection>[0];
type RoleGuards = Pick<Guards, "requireRole">;
type Consent = (laneId: LaneId, settings: { cloud: string; tenantIds: readonly string[] }) => Promise<string | null>;

export const loadMicrosoftSection = (client: Db, laneId: string, userId?: string): Promise<GoogleSectionView> => loadMailSection(client, laneId, userId, "microsoft");

export async function microsoftSectionFor(
  g: RoleGuards,
  laneId: string,
  providers: MailProvidersView | null,
  load: (client: Db, laneId: string, userId?: string) => Promise<GoogleSectionView> = loadMicrosoftSection,
  consentLink: Consent = microsoftAdminConsentLink,
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
  if (providers.state === "unknown") return { connections: [], unavailable: true, adminConsentUrl: null };
  const settings = providers.microsoft;
  try {
    const view = await load(client, laneId, userId);
    if (settings === null) return view.connections.length === 0 ? null : { ...view, paused: true, adminConsentUrl: null };
    return { ...view, adminConsentUrl: await consentLink(laneId as LaneId, settings).catch(() => null) };
  } catch {
    return { connections: [], unavailable: true, adminConsentUrl: null };
  }
}
