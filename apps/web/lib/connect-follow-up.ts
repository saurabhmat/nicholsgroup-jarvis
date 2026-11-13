// After a connect or reconnect (T-241): QuickBooks starts its full initial load at once (conn/sync.requested, trigger "connect",
// which always reloads everything; see conn.sync). Before this, nothing ran until the backup poll or a webhook, and a reconnect
// resumed from the old cursor (incremental), so a company whose first load never completed got no accounts, invoices or bills.
// Ids only. The event id is per connection and minute, so a repeated callback does not start two loads.
import type { OnConnected } from "@nichols/connectors/oauth";
import { connSyncRequested } from "@nichols/core/inngest";

/** Providers whose connect starts a full load right away. Google's first sync comes from the 15-minute mail and calendar ticks. */
export const FULL_LOAD_ON_CONNECT: ReadonlySet<string> = new Set(["quickbooks"]);

export function connectSyncEventId(connectionId: string, nowMs: number): string {
  return `connect:${connectionId}:${String(Math.floor(nowMs / 60_000))}`;
}

type Send = (event: ReturnType<typeof connSyncRequested.create>) => Promise<unknown>;
/** Drops the connection's stored sync cursor (lane-checked), so ANY next sync is a full load even if the connect sync is skipped. */
type ResetCursor = (laneId: string, connectionId: string) => Promise<void>;

export function connectFollowUp(send: Send, resetCursor: ResetCursor, now: () => number = Date.now): OnConnected {
  return async ({ provider, laneId, connectionId }) => {
    if (!FULL_LOAD_ON_CONNECT.has(provider)) return;
    // Review M2: the connect sync can be skipped (another run of the connection is in progress) and a reconnect keeps the old
    // cursor; without a cursor the next sync of any trigger reloads everything. A failed reset is logged; the event still goes.
    try {
      await resetCursor(laneId, connectionId);
    } catch (e) {
      console.error("[connect] sync cursor not reset:", e instanceof Error ? e.name : typeof e);
    }
    await send(connSyncRequested.create({ laneId, connectionId, trigger: "connect" }, { id: connectSyncEventId(connectionId, now()) }));
  };
}
