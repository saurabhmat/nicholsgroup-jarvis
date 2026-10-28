// Lane-bound connections (security review H1).
//
// Connectors never accept a plain `Connection`: only a frozen `LaneBoundConnection` minted by a `ConnectionLoader`
// (or by a connector's own `connect` / `disconnect`) after reading the authoritative row. Minted objects are tracked in
// a module-private WeakSet, so a copy such as `{ ...conn, lane_id: "other" }` (or even an exact copy) is rejected at
// runtime by `assertLaneBound`, whatever its fields say.
//
// The mint function is exported only from `@nichols/connectors/internal`, never from the package root.
import type { LaneId } from "@nichols/core";
import type { z } from "zod";
import { ConnectorError } from "./errors";
import { ConnectionSchema, LaneIdSchema, type Connection, type Provider } from "./schemas";

declare const laneBoundBrand: unique symbol;

/** A connection row read from the store for one lane. Frozen; only minted objects pass `assertLaneBound`. */
export type LaneBoundConnection<P extends string = Provider> = Readonly<Connection<P>> & { readonly [laneBoundBrand]: true };

/**
 * Loads a connection for a lane from the authoritative store (`core.connections`, via the lane router).
 * Real implementation: T-031 (table) + T-016 (lane router) + T-033 (connector access). It must select by
 * `(lane_id, id)` and throw `ConnectorError` `not_found` when the row is missing or belongs to another lane (never
 * revealing which).
 */
export interface ConnectionLoader<P extends string = Provider> {
  loadConnection(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection<P>>;
}

const minted = new WeakSet<object>();

/**
 * Internal: freeze a validated connection row and mark it lane-bound. Call only with a row just read from (or written
 * to) the authoritative store for `row.lane_id`.
 */
export function mintLaneBoundConnection<P extends string = Provider>(
  row: Connection<P>,
  schema: z.ZodType<Connection<P>> = ConnectionSchema as unknown as z.ZodType<Connection<P>>,
): LaneBoundConnection<P> {
  const parsed = schema.parse(row);
  Object.freeze(parsed.features);
  if (parsed.last_error) Object.freeze(parsed.last_error);
  const frozen = Object.freeze(parsed) as LaneBoundConnection<P>;
  minted.add(frozen);
  return frozen;
}

export function isLaneBound(value: unknown): boolean {
  return typeof value === "object" && value !== null && minted.has(value);
}

/**
 * First line of every connector method: `laneId` is valid, `conn` was minted by a loader (not forged or copied), and
 * it belongs to `laneId`. Connectors then re-read the authoritative row (status, lane) and their token by
 * `(laneId, conn.id)`; this guard alone is not enough.
 */
export function assertLaneBound(laneId: LaneId, conn: unknown): asserts conn is LaneBoundConnection<string> {
  if (!LaneIdSchema.safeParse(laneId).success) {
    throw new ConnectorError({ kind: "invalid_input", message: "laneId is required" });
  }
  if (!isLaneBound(conn)) {
    throw new ConnectorError({ kind: "lane_mismatch", message: "Connection was not loaded for this lane" });
  }
  if ((conn as LaneBoundConnection<string>).lane_id !== laneId) {
    throw new ConnectorError({ kind: "lane_mismatch", message: "Connection does not belong to this lane" });
  }
}
