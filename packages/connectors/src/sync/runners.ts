// Provider runners for conn.sync (T-038). The generic runner drives `Connector.sync` (records to a sink, cursor stored
// only after the whole run succeeded). The Google runner calls the mail and calendar runs, which store their own
// cursors atomically with each page.
import type { LaneId } from "@nichols/core";
import type { Connector } from "../contract/connector";
import { ConnectorError, isConnectorError } from "../contract/errors";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import type { RawRecord } from "../contract/schemas";
import { connectorLog, type ConnectorLogger } from "../log/index";
import type { SyncCursorStore, SyncRunner } from "./types";

export type SinkFor<P extends string> = (laneId: LaneId, conn: LaneBoundConnection<P>) => (batch: RawRecord<P>[]) => Promise<void>;

/**
 * Runs `connector.sync` from the stored cursor. The cursor advances only after the connector resolves (a failed run
 * leaves it where it was, so the next run repeats the same window). The compare-and-swap keeps a slower duplicate run
 * from moving it backwards; a lost swap is logged, not an error (the records were written by idempotent upserts).
 */
export function createConnectorSyncRunner<P extends string>(deps: { connector: Connector<P>; cursors: SyncCursorStore; sinkFor: SinkFor<P>; logger?: ConnectorLogger }): SyncRunner {
  const log = deps.logger ?? connectorLog;
  const { connector } = deps;
  return async (laneId, conn, runOptions) => {
    assertLaneBound(laneId, conn);
    if (!connector.sync) throw new ConnectorError({ kind: "unsupported_op", message: "This connector does not sync" });
    const typed = conn as LaneBoundConnection<P>;
    const stored = await deps.cursors.get(laneId, conn);
    const inner = deps.sinkFor(laneId, typed);
    let received = 0;
    const sink = async (batch: RawRecord<P>[]) => {
      await inner(batch);
      received += batch.length;
    };
    // A targeted run (a webhook named the changed entities) needs a stored cursor to be safe: it never moves the cursor. With none
    // yet, the connection has not had its first full sync, so do that instead of refusing.
    const objectTypes = runOptions?.objectTypes && stored !== null ? [...runOptions.objectTypes] : undefined;
    const cursor = stored === null ? null : { value: stored };
    let summary;
    try {
      summary = await connector.sync(laneId, typed, cursor, sink, objectTypes ? { objectTypes } : undefined);
    } catch (e) {
      // A targeted run is refused before any call when the stored cursor is no longer usable (older than Intuit's CDC window, or
      // in the future): nothing was read or written, so do the whole-connection run instead of leaving the connection in error.
      if (!objectTypes || !isConnectorError(e) || e.info.kind !== "invalid_input") throw e;
      summary = await connector.sync(laneId, typed, cursor, sink);
    }
    const stuck = !(await deps.cursors.put(laneId, conn, stored, summary.cursor.value));
    if (stuck) log.child({ laneId, provider: connector.provider, connectionId: conn.id }).warn("conn.sync.cursor_conflict", {});
    return { kind: summary.mode, received, written: summary.records };
  };
}

/** `received` for Google = written + skipped + removed items, `written` = items written. */
type GoogleRun = { written: number; skipped: number; removed: number; mode: "full" | "incremental" };

/** Mail then calendar; one failing never stops the other. The first failure is rethrown so the job retries both (cheap: their cursors are kept). */
export function createGoogleSyncRunner(deps: { mail: { run(laneId: LaneId, conn: LaneBoundConnection<"google">): Promise<GoogleRun> }; calendar: { run(laneId: LaneId, conn: LaneBoundConnection<"google">): Promise<GoogleRun> } }): SyncRunner {
  return async (laneId, conn) => {
    assertLaneBound(laneId, conn);
    const g = conn as LaneBoundConnection<"google">;
    // Sequential: both share one token manager, and a rate-limited account should not be hit twice at once.
    const runs: GoogleRun[] = [];
    let failure: unknown;
    let retryable: unknown;
    for (const stream of [deps.mail, deps.calendar]) {
      try {
        runs.push(await stream.run(laneId, g));
      } catch (e) {
        failure ??= e;
        if (isConnectorError(e) && e.info.disposition === "retry") retryable ??= e;
      }
    }
    // Prefer a retryable failure: a permanent one on the other stream must not stop this stream from being retried.
    if (failure !== undefined) failure = retryable ?? failure;
    if (failure !== undefined) throw isConnectorError(failure) ? failure : new ConnectorError({ kind: "provider_error", message: "Unexpected connector failure" });
    return {
      kind: runs.some((r) => r.mode === "full") ? "full" : "incremental",
      received: runs.reduce((n, r) => n + r.written + r.skipped + r.removed, 0),
      written: runs.reduce((n, r) => n + r.written, 0),
    };
  };
}
