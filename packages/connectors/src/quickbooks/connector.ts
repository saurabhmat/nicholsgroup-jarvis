// The QuickBooks Online connector (T-050), read-only. It implements the shared connector contract:
//  - connect: always refused. QuickBooks tokens enter the Vault only from the OAuth callback (`oauthFlow.callback`),
//    which checks state, user, AAL2 and PKCE and that the token is for the realm named (QB-7, T-050 security M2). A
//    second entry here would skip all of that, so there is none; the contract kit connects through the flow instead.
//  - health: reads CompanyInfo (one cheap authenticated call) and reports; it does not throw for connection problems.
//  - read: `company_info` for now (T-051 and T-052 add entities and reports).
//  - no disconnect: revoking the grant at Intuit is an external write (D-24), so it exists only as an approvals-only
//    `ConnectorWriter` action (./writer.ts, `@nichols/connectors/writer`), not on this object.
//  - sync (T-051): initial load + Change Data Capture of the finance entities, CompanyInfo and Preferences (./sync.ts).
// Every method refuses a connection whose provider is not "quickbooks" before any network call or Vault change.
// No subscribe or prepareWrite: QuickBooks is read-only in the pilot (webhooks arrive at T-036/T-053, not as a subscription).
import type { LaneId } from "@nichols/core";
import type { Connector } from "../contract/connector";
import { ConnectorError, toConnectorError } from "../contract/errors";
import { assertStatusUsable } from "../contract/guards";
import { assertLaneBound } from "../contract/lane-bound";
import { LaneIdSchema, ReadOpSchema, type HealthStatus } from "../contract/schemas";
import type { LaneBoundConnection } from "../contract/lane-bound";
import type { ConnectorLogger } from "../log/index";
import type { QboApi } from "./api";
import { fetchCompanyInfo } from "./company-info";
import type { QboFeatureRecorder } from "./features";
import { assertQuickbooksConnection, type QboConnection } from "./guard";
import { createQboSync, type PayrollSettings } from "./sync";

type QboProvider = "quickbooks";
export type { QboConnection } from "./guard";

export const QBO_READ_OPS = ["company_info"] as const;
/** Edition features T-051 detects from Preferences; declared here so the contract knows them. */
export const QBO_FEATURE_KEYS = ["class_tracking", "location_tracking", "multicurrency"] as const;

export type QboConnectorDeps = {
  connections: {
    /** The authoritative row by (lane, id): `not_found` for a missing row or another lane's. Any provider's row. */
    load(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection<string>>;
  };
  api: QboApi;
  /** Stores the edition flags Preferences report (and audits a change). Required for `sync`. */
  features: QboFeatureRecorder;
  /** `lane_config.finance.payroll` (D-25); a throw fails the sync before any call. */
  payroll: (laneId: LaneId) => Promise<PayrollSettings>;
  now?: () => number;
  logger?: ConnectorLogger;
};

export function createQuickBooksConnector(deps: QboConnectorDeps): Connector<QboProvider> {
  const now = deps.now ?? Date.now;
  const runSync = createQboSync({ api: deps.api, features: deps.features, payroll: deps.payroll, now, ...(deps.logger ? { logger: deps.logger } : {}) });

  /** Brand, lane and provider checks, then the authoritative row (which must also be a QuickBooks row). */
  async function loadRow(laneId: LaneId, conn: unknown): Promise<QboConnection> {
    assertLaneBound(laneId, conn);
    assertQuickbooksConnection(conn);
    const row = await deps.connections.load(laneId, conn.id);
    assertQuickbooksConnection(row);
    return row;
  }

  /** Authoritative status must be usable (active or degraded); `reconnect_required` is never retried. */
  async function useConnection(laneId: LaneId, conn: unknown): Promise<QboConnection> {
    const row = await loadRow(laneId, conn);
    assertStatusUsable(row.status);
    return row;
  }

  return {
    provider: "quickbooks",
    capabilities: { sync: true, subscribe: false, prepareWrite: false },
    readOps: QBO_READ_OPS,
    featureKeys: QBO_FEATURE_KEYS,

    async connect(laneId) {
      if (!LaneIdSchema.safeParse(laneId).success) throw new ConnectorError({ kind: "invalid_input", message: "laneId is required" });
      // QB-7 and security M2: no code, no secret reference, no Playground or offline token is accepted here. Tokens
      // enter the Vault only from oauthFlow.callback (state, user, AAL2, PKCE, realm check).
      throw new ConnectorError({ kind: "invalid_input", message: "QuickBooks connects only through the in-app authorization flow" });
    },

    async health(laneId, conn): Promise<HealthStatus> {
      const row = await loadRow(laneId, conn);
      const checked_at = new Date(now()).toISOString();
      const problem = (e: unknown, status: HealthStatus["status"]): HealthStatus => {
        const error = toConnectorError(e);
        return { ok: false, status, checked_at, provider_tid: error.info.provider_tid, error: error.toJSON() };
      };
      try {
        assertStatusUsable(row.status);
      } catch (e) {
        return problem(e, row.status);
      }
      try {
        const { providerTid } = await fetchCompanyInfo(deps.api, laneId, row);
        // The reported status is the check's outcome. The row is not updated here (T-195/T-196 persist status), so a
        // `degraded` row reports `active` after a good check without the stored status changing.
        return { ok: true, status: "active", checked_at, provider_tid: providerTid, error: null };
      } catch (e) {
        const err = toConnectorError(e);
        return problem(err, err.info.kind === "reconnect_required" ? "reconnect_required" : "degraded");
      }
    },

    async sync(laneId, conn, cursor, sink, options) {
      const row = await useConnection(laneId, conn);
      return runSync(laneId, row, cursor, sink, options);
    },

    async read<T = unknown>(laneId: LaneId, conn: QboConnection, op: Parameters<Connector["read"]>[2]) {
      const row = await useConnection(laneId, conn);
      const parsed = ReadOpSchema.safeParse(op);
      if (!parsed.success) throw new ConnectorError({ kind: "invalid_input", message: "Invalid read op" });
      if (!(QBO_READ_OPS as readonly string[]).includes(parsed.data.op)) {
        throw new ConnectorError({ kind: "unsupported_op", message: `Unsupported read op ${parsed.data.op}` });
      }
      const fetched_at = new Date(now()).toISOString();
      const { info, asOf, providerTid } = await fetchCompanyInfo(deps.api, laneId, row);
      return {
        lane_id: laneId,
        provider: "quickbooks" as const,
        connection_id: row.id,
        op: parsed.data.op,
        data: info as T,
        // The data cannot reflect a moment after we fetched it: clamp a provider clock that runs ahead of ours.
        as_of: asOf !== null && asOf < fetched_at ? asOf : fetched_at,
        fetched_at,
        freshness: "live" as const,
        provider_tid: providerTid,
        source_refs: [{ kind: "qbo_company", ref: row.external_account_id }],
        notes: [],
      };
    },
  };
}
