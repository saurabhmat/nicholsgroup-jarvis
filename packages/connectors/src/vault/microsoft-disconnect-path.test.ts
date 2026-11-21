// T-257 (D-55): the local Disconnect of a Microsoft mailbox through the REAL `createTokenVault` over an RPC twin of the SQL revoke function
// (which never looks at the provider). The pgTAP side is not run here. Synthetic data only (rule 10).
import { describe, expect, it } from "vitest";
import { mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import { createMicrosoftDisconnect } from "../microsoft/disconnect";
import { createTokenVault } from "./tokens";

const OWNER = "00000000-0000-4000-8000-0000000b0257";
const CID = "00000000-0000-4000-8000-0000000c0257";
const conn = () =>
  mintLaneBoundConnection({ id: CID, lane_id: "PKG", provider: "microsoft", external_account_id: "exec@corp.example.test", status: "active", features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null, owner_user_id: OWNER } as never) as LaneBoundConnection<string>;

describe("Microsoft disconnect through the real token vault", () => {
  it("calls the revoke function with the lane, the row and the owner, and nothing else", async () => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const client = {
      schema: () => ({
        rpc: async (fn: string, args: Record<string, unknown>) => {
          calls.push({ fn, args });
          return { data: true, error: null };
        },
      }),
    };
    const vault = createTokenVault((async () => client) as never);
    const d = createMicrosoftDisconnect({ loader: { loadConnection: async () => conn() }, vault });
    expect(await d("PKG", CID, OWNER)).toBe(true);
    expect(calls).toEqual([{ fn: "connection_token_revoke", args: { p_lane_id: "PKG", p_connection_id: CID, p_actor_id: OWNER } }]);
  });
});
