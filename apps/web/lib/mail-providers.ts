// Which mail and calendar providers a company has enabled, for Settings (T-257, D-57). ONE `mailProviderSettings` read per page render
// (inside the connectors, `mailProvidersOf`), shared by the Google and the Microsoft section: never `isMailProviderEnabled` plus a second read.
//   - `null`: the caller may not connect their own mail here (not owner, admin_technical or viewer, or not at AAL2): no provider section, no read.
//   - `unknown`: the read failed. Google is then drawn exactly as before (it is never hidden or paused on a guess); Microsoft says its status is unavailable.
//   - `known`: `google` is whether Google is enabled; `microsoft` is the enabled Microsoft settings (cloud and tenant ids, for the admin consent link) or null.
// Read-only; no external call; fixed shapes only (no config text reaches the page).
import { AuthError, type Guards } from "@nichols/core/auth";
import type { LaneId } from "@nichols/core";
import { MAIL_CONNECT_ROLES } from "@nichols/connectors/oauth";
import { mailProvidersOf, type MailProvidersOfLane } from "@nichols/connectors/microsoft-settings";

export type MailProvidersView = ({ state: "known" } & MailProvidersOfLane) | { state: "unknown" };

export async function mailProvidersFor(g: Pick<Guards, "requireRole">, laneId: string, read: (laneId: LaneId) => Promise<MailProvidersOfLane> = mailProvidersOf): Promise<MailProvidersView | null> {
  try {
    await g.requireRole(laneId, [...MAIL_CONNECT_ROLES]);
  } catch (e) {
    if (e instanceof AuthError) return null;
    throw e;
  }
  try {
    return { state: "known", ...(await read(laneId as LaneId)) };
  } catch {
    return { state: "unknown" };
  }
}
