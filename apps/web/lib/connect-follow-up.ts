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

export function connectFollowUp(send: Send, now: () => number = Date.now): OnConnected {
  return async ({ provider, laneId, connectionId }) => {
    if (!FULL_LOAD_ON_CONNECT.has(provider)) return;
    await send(connSyncRequested.create({ laneId, connectionId, trigger: "connect" }, { id: connectSyncEventId(connectionId, now()) }));
  };
}
