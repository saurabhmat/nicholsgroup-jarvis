// `@nichols/connectors/connection-test`: the temporary QuickBooks connection test (T-198). Production wiring of the
// read-only health check; apps/web's route calls `checkQuickBooksConnection(laneId)` after its own role and lane guard.
// Exposes nothing else of the QuickBooks wiring (no connector, no writer).
import { createConnectionCheck } from "./quickbooks/connection-check";
import { quickbooksConnector } from "./quickbooks/index";
import { connectionStore } from "./vault/index";

export type { ConnectionCheck, ConnectionCheckStatus } from "./quickbooks/connection-check";

export const checkQuickBooksConnection = createConnectionCheck({
  find: (laneId) => connectionStore.findConnection(laneId, "quickbooks"),
  connector: quickbooksConnector,
});
