// The connect state store (T-035) over core.oauth_state_create / core.oauth_state_consume. Both run with the signed-in
// user's own lane client, so the database checks the role, aal2, the user binding, single use and expiry itself.
import type { LaneId } from "@nichols/core";
import type { LaneClient } from "@nichols/core/lane-router";
import { ConnectorError } from "../contract/errors";
import type { Provider } from "../contract/schemas";

/** `toolkit` and `accountRef` are set only for a Composio connect (T-219): the toolkit and the connected account id bound server-side at start. */
export type StoredState = { provider: string; codeVerifier: string; redirectUri: string; toolkit?: string | null; accountRef?: string | null };
export type StateBinding = { toolkit: string; accountRef: string };

export interface StateStore {
  create(client: LaneClient, laneId: LaneId, provider: Provider, stateHash: string, codeVerifier: string, redirectUri: string, binding?: StateBinding): Promise<void>;
  /** The caller's own unexpired state for the lane, deleted on read; null for anything else. */
  consume(client: LaneClient, laneId: LaneId, stateHash: string): Promise<StoredState | null>;
}

export const dbStateStore: StateStore = {
  async create(client, laneId, provider, stateHash, codeVerifier, redirectUri, binding) {
    const { error } = await client.schema("core").rpc("oauth_state_create", {
      p_lane: laneId,
      p_provider: provider,
      p_state_hash: stateHash,
      p_code_verifier: codeVerifier,
      p_redirect_uri: redirectUri,
      ...(binding ? { p_toolkit: binding.toolkit, p_account_ref: binding.accountRef } : {}),
    });
    if (!error) return;
    if (error.code === "42501") throw new ConnectorError({ kind: "forbidden", message: "Connect not allowed" });
    if (error.code === "54000") throw new ConnectorError({ kind: "rate_limited", message: "Too many connects in progress" });
    throw new ConnectorError({ kind: "transient", message: "Connect state store unavailable" });
  },
  async consume(client, laneId, stateHash) {
    const { data, error } = await client.schema("core").rpc("oauth_state_consume", { p_lane: laneId, p_state_hash: stateHash });
    if (error) throw new ConnectorError({ kind: "transient", message: "Connect state store unavailable" });
    const row = Array.isArray(data) ? (data[0] as { provider?: unknown; code_verifier?: unknown; redirect_uri?: unknown; toolkit?: unknown; account_ref?: unknown } | undefined) : undefined;
    if (!row || typeof row.provider !== "string" || typeof row.code_verifier !== "string" || typeof row.redirect_uri !== "string") return null;
    return {
      provider: row.provider,
      codeVerifier: row.code_verifier,
      redirectUri: row.redirect_uri,
      toolkit: typeof row.toolkit === "string" ? row.toolkit : null,
      accountRef: typeof row.account_ref === "string" ? row.account_ref : null,
    };
  },
};
