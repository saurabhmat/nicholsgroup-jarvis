// The one RPC path every sync index store uses (T-063 mail, T-064 calendar): the lane router's job client for the lane,
// the `core` schema, database messages never passed on, and the cursor compare-and-swap conflict as its own outcome.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import type { JobClientFor } from "../vault/tokens";

/** The SQLSTATE the apply functions raise when the stored cursor is not the expected one. */
export const CONFLICT_CODE = "D0409";
/** The database accepts 1000 removals and 1000 upserts per call; a page is cut into chunks of this size. */
export const APPLY_CHUNK = 500;
/** A page larger than this is refused outright (a provider bug, not a page). */
export const APPLY_MAX = 20_000;

/** `conflict`: the stored cursor is no longer the one the run started from (another run applied first); nothing was written by the last chunk. */
export type ApplyCounts = { removed: number; written: number; skipped: number; conflict: boolean };

/** Data errors (class 22, 23) and refusals are permanent: retrying the same page cannot succeed, so they are not `transient`. */
function storeError(what: string, code: string | undefined): ConnectorError {
  if (code === "42501") return new ConnectorError({ kind: "forbidden", message: `${what} index access refused` });
  if (code && /^2[23]/.test(code)) return new ConnectorError({ kind: "invalid_input", message: `A ${what.toLowerCase()} sync page or record was refused by the index` });
  return new ConnectorError({ kind: "transient", message: `${what} index unavailable` });
}

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string } | null }>;

/** `what` is "Mail" or "Calendar" (error text only). Returns the result, or "conflict" for the cursor compare-and-swap. */
export function createIndexRpc(clientFor: JobClientFor, what: string): (laneId: LaneId, fn: string, args: Record<string, unknown>) => Promise<unknown> {
  return async function call(laneId, fn, args) {
    let client: Awaited<ReturnType<JobClientFor>>;
    try {
      client = await clientFor(laneId);
    } catch {
      throw new ConnectorError({ kind: "connection_unavailable", message: `Lane is not available for ${what.toLowerCase()} index access` });
    }
    let result: Awaited<ReturnType<Rpc>>;
    try {
      const rpc = client.schema("core").rpc.bind(client.schema("core")) as unknown as Rpc;
      result = await rpc(fn, args);
    } catch {
      throw new ConnectorError({ kind: "transient", message: `${what} index unavailable` });
    }
    if (result.error) {
      if (result.error.code === CONFLICT_CODE) return "conflict";
      throw storeError(what, result.error.code);
    }
    return result.data;
  };
}
