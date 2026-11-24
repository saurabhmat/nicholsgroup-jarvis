// The Messages page's connect states (T-280; spec docs/specs/messages.md 11, "States"). Pure: decided from the Settings section view (one read of the company's Teams settings and the
// caller's own Teams rows), so the page and Settings can never disagree. No chat list yet (T-283): a connected person sees who they are connected as and a placeholder.
import type { TeamsFeature } from "@nichols/core/lane-config";
import type { TeamsSectionView } from "./teams-connection";
import { accountLabels, isConnId } from "./teams-accounts";

/**
 * One of the person's own Teams accounts as the page needs it (T-295; spec 22.5). `usable`: connected or degraded (can be read); otherwise its sign-in expired (`reconnect_required`).
 * `label` is the short text drawn on its rows when the person has two or more usable accounts (lib/teams-accounts.ts). `missing`: the company's features this account lacks.
 */
export type MessagesAccount = { connectionId: string; account: string; label: string; usable: boolean; degraded: boolean; missing: TeamsFeature[]; has: TeamsFeature[] };

export type MessagesState =
  | { kind: "no_access" } // the caller cannot connect their own account here (no own_mail): nothing to draw but a plain line
  | { kind: "unavailable" } // settings or rows could not be read: never an empty list, never "not connected"
  | { kind: "not_enabled" }
  | { kind: "paused"; unsupportedCloud?: true }
  | { kind: "not_connected" }
  | { kind: "reconnect"; connectionId: string; account: string; /** Every own account that has to be reconnected (T-295), first one first. */ accounts: MessagesAccount[] }
  | {
      kind: "connected";
      /** The FIRST usable account (the Channels tab and the single-account page use it until T-296; `accounts` lists every one). */
      connectionId: string;
      account: string;
      degraded: boolean;
      missing: TeamsFeature[];
      adminConsent: boolean;
      /** The features the company lists (what the page may offer). */
      laneFeatures: TeamsFeature[];
      /** Every own account that is not disconnected, in the order they were connected (T-295). */
      accounts: MessagesAccount[];
      /** Two or more usable accounts: rows and the conversation header carry the account label. With one the page looks as it always did. */
      multi: boolean;
      /** The person has fewer accounts than the company allows: the card offers "Connect another Teams account". */
      canAddAnother: boolean;
    };

/**
 * The person's own accounts that are not disconnected, in the order they were connected (the rows arrive ordered by `created_at`), with their labels. One definition for the page and the routes.
 * `usable`: connected or degraded. `ord` (the index) is the merge's last tie-break.
 */
export function ownAccounts(connections: readonly TeamsSectionView["connections"][number][], laneFeatures: readonly TeamsFeature[]): MessagesAccount[] {
  // only the states that mean "an account the person has": anything else (disconnected, a connect in progress) is not one, so no route and no page ever names it
  const counted = connections.filter((c) => c.mine && (c.state === "connected" || c.state === "degraded" || c.state === "reconnect_required"));
  const labels = accountLabels(counted.map((c) => c.account));
  return counted.map((c, i) => ({
    connectionId: c.id,
    account: c.account,
    label: labels[i] ?? c.account,
    usable: c.state === "connected" || c.state === "degraded",
    degraded: c.state === "degraded",
    missing: laneFeatures.filter((f) => !c.has.includes(f)),
    has: [...c.has],
  }));
}

export function messagesStateOf(view: TeamsSectionView | null): MessagesState {
  if (view === null) return { kind: "no_access" };
  if (view.settingsUnknown || view.unavailable) return { kind: "unavailable" };
  const mine = view.connections.filter((c) => c.mine);
  const accounts = ownAccounts(view.connections, view.laneFeatures);
  const usable = mine.find((c) => c.state === "connected" || c.state === "degraded");
  if (view.paused) return usable || mine.some((c) => c.state === "reconnect_required") || view.unsupportedCloud ? { kind: "paused", ...(view.unsupportedCloud ? { unsupportedCloud: true as const } : {}) } : { kind: "not_enabled" };
  const needs = mine.find((c) => c.state === "reconnect_required");
  if (needs && !usable) return { kind: "reconnect", connectionId: needs.id, account: needs.account, accounts: accounts.filter((a) => !a.usable) };
  if (!usable) return { kind: "not_connected" };
  const missing = view.laneFeatures.filter((f) => !usable.has.includes(f));
  // Channels need a tenant administrator's approval once: when the company lists them and this connection lacks them, say so (chats keep working).
  return {
    kind: "connected",
    connectionId: usable.id,
    account: usable.account,
    degraded: usable.state === "degraded",
    missing,
    laneFeatures: [...view.laneFeatures],
    adminConsent: view.needsAdminConsent && missing.includes("channels_read"),
    accounts,
    multi: accounts.filter((a) => a.usable).length >= 2,
    canAddAnother: accounts.length < view.maxAccounts,
  };
}

/**
 * What the Channels tab shows before any read (T-291, spec 11 "States"), decided from the connect state alone, so nothing is requested from Microsoft unless it can work:
 *   off        the company does not list `channels_read`: "Channels are not switched on for this company"
 *   reconnect  the company lists it and this connection does not have it (connected before channels were switched on, or the administrator's approval was not given when it connected):
 *              "Reconnect Teams to add channels" (and, since `ChannelMessage.Read.All` always needs a tenant administrator, the administrator's approval text)
 *   ready      channels may be read (a read can still be refused by Microsoft: that is the tab's own "needs approval" / "could not load" state)
 */
export type ChannelsAvailability = { kind: "off" } | { kind: "reconnect"; adminConsent: boolean } | { kind: "ready" };

export function channelsAvailability(state: Extract<MessagesState, { kind: "connected" }>): ChannelsAvailability {
  if (!state.laneFeatures.includes("channels_read")) return { kind: "off" };
  if (state.missing.includes("channels_read")) return { kind: "reconnect", adminConsent: state.adminConsent };
  return { kind: "ready" };
}

/**
 * The account the address opens a chat as (T-295; spec 22.4): `?conn=<id>&chat=<key>`. The id must be a lower-case uuid of one of the person's own USABLE accounts (the state was read under RLS, so another
 * person's, another lane's, an unknown, a disconnected, a pending and an expired account's id are all simply not here: the same "nothing opens"). A `chat` with no `conn` opens only when the person has exactly
 * one usable account (old links keep working); with several it opens nothing (no guess). A `conn` that fails never falls back to another account. Undefined = no conversation.
 */
export function openAccountOf(state: Extract<MessagesState, { kind: "connected" }>, query: Record<string, string | string[] | undefined>): MessagesAccount | undefined {
  const chat = query.chat;
  if (typeof chat !== "string") return undefined;
  const usable = state.accounts.filter((a) => a.usable);
  const conn = query.conn;
  if (conn === undefined) return usable.length === 1 ? usable[0] : undefined;
  if (!isConnId(conn)) return undefined;
  return usable.find((a) => a.connectionId === conn);
}
