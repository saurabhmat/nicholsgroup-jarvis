// Email write dispatch by the connection row's provider (T-255). Lives in the approvals module (rule 5: only approvals executes writes): the
// executor and the reconciler hold these, never a route or a job. A write or a read-back for a connection whose provider is not enabled for the lane is refused before any token read
// (`connection_unavailable`, fixed text); a provider whose write path is not wired answers `unsupported_op`. Pure over injected parts.
import type { LaneId } from "@nichols/core";
import { ConnectorError, assertLaneBound, type ExecResult, type LaneBoundConnection } from "@nichols/connectors";
import type { EmailApprovedAction, EmailConn, EmailProvider, EmailWriteSurface } from "./types";

/** The one thing the dispatch needs from the lane's provider gate (`createProviderGate` in the connectors): throws when the provider is not enabled for the lane. */
export interface EnabledGate {
  assertEnabled(laneId: LaneId, provider: string): Promise<void>;
}
const isCommsProvider = (p: string): p is Provider => p === "google" || p === "microsoft";

type Provider = EmailProvider;
export type { EmailConn, EmailApprovedAction };

/** One provider's write entry: the connector's writer, for rows of that provider only. */
export type EmailWriteEntry = EmailWriteSurface & { readonly sentCopyMayLagDeclared?: boolean };

/** The entry of a provider whose write path is not wired in this build: every call answers `unsupported_op` (kept for tests and builds without the Graph wiring). */
const unsupported = async (): Promise<never> => {
  throw new ConnectorError({ kind: "unsupported_op", message: "Email actions are not available for this provider" });
};
export const unavailableEmailWriteEntry: EmailWriteEntry = Object.freeze({ actionTypes: Object.freeze([] as string[]), executeWrite: unsupported, verifyWrite: unsupported, findWrite: unsupported });

export function createEmailWriteDispatch(deps: { loader: { loadConnection(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection<string>> }; gate: EnabledGate; entries: Readonly<Record<Provider, EmailWriteEntry>> }) {
  async function entryFor(laneId: LaneId, conn: unknown): Promise<{ conn: EmailConn; entry: EmailWriteEntry }> {
    assertLaneBound(laneId, conn);
    if (!isCommsProvider(conn.provider)) throw new ConnectorError({ kind: "unsupported_op", message: "This connection has no email" });
    await deps.gate.assertEnabled(laneId, conn.provider);
    return { conn: conn as EmailConn, entry: deps.entries[conn.provider] };
  }
  return {
    /** The authoritative, lane-bound row the email writer runs on (loaded by lane and id; another lane's id is not_found). */
    async loadWriteConnection(laneId: LaneId, connectionId: string): Promise<EmailConn> {
      const conn = await deps.loader.loadConnection(laneId, connectionId);
      if (!isCommsProvider(conn.provider)) throw new ConnectorError({ kind: "unsupported_op", message: "This connection has no email" });
      return conn as EmailConn;
    },
    /** Execute, read back, find: each by the connection's own provider. Holds executeWrite: approvals only. */
    writer: Object.freeze({
      actionTypes: Object.freeze([...new Set([...deps.entries.google.actionTypes, ...deps.entries.microsoft.actionTypes])]),
      /** Whether the connection's own provider declared that an accepted send's copy may lag (read-only; false for a row that is not an email connection). */
      sentCopyMayLag(conn: unknown): boolean {
        const p = (conn as { provider?: string } | null)?.provider;
        return isCommsProvider(String(p)) && deps.entries[p as Provider].sentCopyMayLagDeclared === true;
      },
      async executeWrite(laneId: LaneId, conn: EmailConn, action: EmailApprovedAction): Promise<ExecResult> {
        const r = await entryFor(laneId, conn);
        return r.entry.executeWrite(laneId, r.conn, action);
      },
      async verifyWrite(laneId: LaneId, conn: EmailConn, action: EmailApprovedAction, externalId: string): Promise<void> {
        const r = await entryFor(laneId, conn);
        return r.entry.verifyWrite(laneId, r.conn, action, externalId);
      },
      async findWrite(laneId: LaneId, conn: EmailConn, action: EmailApprovedAction): Promise<string[]> {
        const r = await entryFor(laneId, conn);
        return r.entry.findWrite(laneId, r.conn, action);
      },
    }),
  };
}
