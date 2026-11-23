// The Messages page's connect states (T-280; spec docs/specs/messages.md 11, "States"). Pure: decided from the Settings section view (one read of the company's Teams settings and the
// caller's own Teams rows), so the page and Settings can never disagree. No chat list yet (T-283): a connected person sees who they are connected as and a placeholder.
import type { TeamsFeature } from "@nichols/core/lane-config";
import type { TeamsSectionView } from "./teams-connection";

export type MessagesState =
  | { kind: "no_access" } // the caller cannot connect their own account here (no own_mail): nothing to draw but a plain line
  | { kind: "unavailable" } // settings or rows could not be read: never an empty list, never "not connected"
  | { kind: "not_enabled" }
  | { kind: "paused" }
  | { kind: "not_connected" }
  | { kind: "reconnect"; connectionId: string; account: string }
  | { kind: "connected"; connectionId: string; account: string; degraded: boolean; missing: TeamsFeature[]; adminConsent: boolean };

export function messagesStateOf(view: TeamsSectionView | null): MessagesState {
  if (view === null) return { kind: "no_access" };
  if (view.settingsUnknown || view.unavailable) return { kind: "unavailable" };
  const mine = view.connections.filter((c) => c.mine);
  const usable = mine.find((c) => c.state === "connected" || c.state === "degraded");
  if (view.paused) return usable || mine.some((c) => c.state === "reconnect_required") ? { kind: "paused" } : { kind: "not_enabled" };
  const needs = mine.find((c) => c.state === "reconnect_required");
  if (needs && !usable) return { kind: "reconnect", connectionId: needs.id, account: needs.account };
  if (!usable) return { kind: "not_connected" };
  const missing = view.laneFeatures.filter((f) => !usable.has.includes(f));
  // Channels need a tenant administrator's approval once: when the company lists them and this connection lacks them, say so (chats keep working).
  return { kind: "connected", connectionId: usable.id, account: usable.account, degraded: usable.state === "degraded", missing, adminConsent: view.needsAdminConsent && missing.includes("channels_read") };
}
