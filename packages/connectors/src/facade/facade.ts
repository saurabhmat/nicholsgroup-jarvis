// The provider-agnostic comms facade (T-255, spec docs/specs/microsoft.md §4, §8.3, §8.6). Pure: every store and provider is
// injected, so it is tested without the Vault or the lane router; `./index.ts` wires the real ones.
//
// Dispatch is ALWAYS by the authoritative connection row's provider (the row loaded by (lane, id)), never by a lane-level value:
// a lane may hold Google and Microsoft connections at the same time (D-57), and a lane with `mail_transport = "composio"` still
// sends a Microsoft connection to the Microsoft entry (Microsoft is always native). Order for every call:
//   1. load the authoritative row (lane-bound; not_found for another lane's id)
//   2. the T-247 owner check, when the caller names the user it reads for
//   3. the lane's enabled-provider check (one config read), BEFORE any token read or request
//   4. the entry registered for row.provider
// Entries for a provider whose tasks have not landed answer `unsupported_op` (see ./entries.ts).
import type { LaneId } from "@nichols/core";
import type { CommsProviderId } from "../comms/provider";
import type { CalendarSyncRunResult } from "../comms/cal-sync";
import type { MailSyncRunResult } from "../comms/mail-sync";
import type { MailWriteIntent, MessageMeta, SearchQuery } from "../comms/schemas";
import { ConnectorError } from "../contract/errors";
import type { ConnectionLoader, LaneBoundConnection } from "../contract/lane-bound";
import type { ProposedPayload, SourceResult } from "../contract/schemas";
import type { SyncRunner } from "../sync/types";
import { createCommsSyncRunner } from "../sync/runners";
import { isCommsProvider, type ProviderGate } from "./gate";

export type FacadeConn = LaneBoundConnection<CommsProviderId>;

/** What one provider contributes for the read and sync side. The connection passed in is always a row of this entry's provider. */
export interface CommsEntry {
  readonly provider: CommsProviderId;
  readBody(laneId: LaneId, conn: FacadeConn, messageId: string): Promise<{ text: string; truncated: boolean }>;
  search(laneId: LaneId, conn: FacadeConn, query: SearchQuery): Promise<SourceResult<MessageMeta[], CommsProviderId>>;
  /** No external call, no token read. */
  prepareWrite(laneId: LaneId, conn: FacadeConn, intent: MailWriteIntent): Promise<ProposedPayload<CommsProviderId>>;
  mailSync: { run(laneId: LaneId, conn: FacadeConn): Promise<MailSyncRunResult> };
  calendarSync: { run(laneId: LaneId, conn: FacadeConn): Promise<CalendarSyncRunResult> };
}

export type CommsFacadeDeps = {
  loader: Pick<ConnectionLoader<string>, "loadConnection">;
  gate: ProviderGate;
  entries: Readonly<Record<CommsProviderId, CommsEntry>>;
};

export function createCommsFacade(deps: CommsFacadeDeps) {
  /** The authoritative row, its provider checked against the registered entries (a row of any other provider is not a comms connection). */
  async function load(laneId: LaneId, connectionId: string, expectedOwnerId?: string): Promise<{ conn: FacadeConn; entry: CommsEntry }> {
    const conn = await deps.loader.loadConnection(laneId, connectionId);
    // T-247: when the caller names the user it reads for (the scheduled briefing, the reply and message pages), the connection must be
    // that user's own: a mailbox is read only on behalf of its owner.
    if (expectedOwnerId !== undefined && conn.owner_user_id !== expectedOwnerId) throw new ConnectorError({ kind: "forbidden", message: "This mailbox belongs to another user" });
    if (!isCommsProvider(conn.provider)) throw new ConnectorError({ kind: "unsupported_op", message: "This connection has no mail or calendar" });
    await deps.gate.assertEnabled(laneId, conn.provider);
    const entry = deps.entries[conn.provider];
    return { conn: conn as FacadeConn, entry };
  }

  return {
    /**
     * Inbox / reply / briefing: one message's text, read live from the connection's own provider and never stored (rule 6), as plain
     * text for the caller to render and never store or log. The caller must first have proved, under RLS with the user's own lane client,
     * that the user may see this message in this lane.
     */
    async readBody(laneId: LaneId, connectionId: string, messageId: string, expectedOwnerId?: string): Promise<{ text: string; truncated: boolean }> {
      const { conn, entry } = await load(laneId, connectionId, expectedOwnerId);
      return entry.readBody(laneId, conn, messageId);
    },

    /** Live provider-side search of one connection's mailbox; metadata only. */
    async search(laneId: LaneId, connectionId: string, query: SearchQuery, expectedOwnerId?: string): Promise<SourceResult<MessageMeta[], CommsProviderId>> {
      const { conn, entry } = await load(laneId, connectionId, expectedOwnerId);
      return entry.search(laneId, conn, query);
    },

    /** Email proposals (T-232): the proposed payload for an email action; no external effect, no token read. The caller is the approvals module. */
    async prepareEmailWrite(laneId: LaneId, connectionId: string, intent: MailWriteIntent): Promise<{ connection: FacadeConn; proposed: ProposedPayload<CommsProviderId> }> {
      const { conn, entry } = await load(laneId, connectionId);
      return { connection: conn, proposed: await entry.prepareWrite(laneId, conn, intent) };
    },

    /** Runs one connection's mail metadata sync, or null when its provider is not enabled for the lane (nothing was called). */
    async syncMail(laneId: LaneId, connectionId: string): Promise<MailSyncRunResult | null> {
      const conn = await deps.loader.loadConnection(laneId, connectionId);
      if (!isCommsProvider(conn.provider)) throw new ConnectorError({ kind: "unsupported_op", message: "This connection has no mail or calendar" });
      if (!(await deps.gate.enabled(laneId, conn.provider))) return null;
      return deps.entries[conn.provider].mailSync.run(laneId, conn as FacadeConn);
    },

    /** Same for the calendar stream. */
    async syncCalendar(laneId: LaneId, connectionId: string): Promise<CalendarSyncRunResult | null> {
      const conn = await deps.loader.loadConnection(laneId, connectionId);
      if (!isCommsProvider(conn.provider)) throw new ConnectorError({ kind: "unsupported_op", message: "This connection has no mail or calendar" });
      if (!(await deps.gate.enabled(laneId, conn.provider))) return null;
      return deps.entries[conn.provider].calendarSync.run(laneId, conn as FacadeConn);
    },

    /**
     * The conn.sync runners, one per provider slug (the job picks one by the loaded row's provider). Each re-checks the gate before
     * its first stream, so a runner reached any other way still never calls out for a provider the lane has not enabled.
     */
    syncRunners(): Record<CommsProviderId, SyncRunner> {
      const runnerFor = (entry: CommsEntry): SyncRunner => {
        const inner = createCommsSyncRunner<CommsProviderId>({ mail: entry.mailSync, calendar: entry.calendarSync });
        return async (laneId, conn, options) => {
          await deps.gate.assertEnabled(laneId, conn.provider);
          if (conn.provider !== entry.provider) throw new ConnectorError({ kind: "forbidden", message: "This connection belongs to another provider" });
          return inner(laneId, conn, options);
        };
      };
      return { google: runnerFor(deps.entries.google), microsoft: runnerFor(deps.entries.microsoft) };
    },
  };
}

export type CommsFacade = ReturnType<typeof createCommsFacade>;
