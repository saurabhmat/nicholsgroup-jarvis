// The shared connector contract (T-030 kit) run against the real QuickBooks connector, over the fake Intuit (MSW) and
// in-memory twins of the Vault, connection rows and lane config. Mocks only (rule 10).
import { afterEach } from "vitest";
import type { ConnectionLoader } from "../contract/lane-bound";
import { RateLimiter } from "../http/rate-limit";
import { describeConnectorContract, type ContractHarness } from "../testing/index";
import { useMockServer } from "../testing/msw/index";
import { createFakeIntuit, FAKE_CLIENT_SECRET, FAKE_CODE, FAKE_REALM } from "../testing/msw/quickbooks/handlers";
import { createQboHarness, HARNESS_REDIRECT } from "../testing/quickbooks-harness";

const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
});

describeConnectorContract({
  name: "quickbooks",
  setup: () => {
    const intuit = createFakeIntuit();
    server.use(...intuit.handlers);
    const h = createQboHarness({ intuit });
    const harness: ContractHarness = {
      connector: h.connector as never,
      loader: { loadConnection: (laneId: string, id: string) => h.connections.load(laneId, id) } as unknown as ConnectionLoader<never>,
      laneId: "PKG",
      otherLaneId: "APK",
      connectInput: { kind: "oauth_code", code: FAKE_CODE, redirect_uri: HARNESS_REDIRECT, external_account_id: FAKE_REALM },
      readOps: [{ op: "company_info" }],
      // Nothing is written to QuickBooks: only token revocation (disconnect) is a POST the fake sees.
      externalWriteCount: () => intuit.state.revokeRequests.length + intuit.state.apiRequests.filter((r) => r.method !== "GET").length,
      markReconnectRequired: (conn) => {
        const row = h.rows.get(conn.id);
        if (row) row.status = "reconnect_required";
      },
      simulateInvalidGrant: (conn) => {
        intuit.state.failRefresh = { status: 400, error: "invalid_grant", always: true };
        h.expireStoredAccess(conn.id);
      },
      secrets: [FAKE_CLIENT_SECRET, ...Array.from({ length: 12 }, (_v, i) => [`synthetic-access-token-${String(i + 1).padStart(4, "0")}`, `synthetic-refresh-token-${String(i + 1).padStart(4, "0")}`]).flat()],
    };
    return harness;
  },
});
