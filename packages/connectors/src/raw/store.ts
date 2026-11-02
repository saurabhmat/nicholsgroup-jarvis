// Raw source records (T-039): the upsert helper over core.source_records_upsert. Lane-aware: the client comes from the
// lane router's job client for the record's lane, the connection must be lane-bound for that lane, and every record
// must carry the same lane, connection and provider. The lane policy is read here for the content guard, and the
// database trigger enforces it again. Rows hold provider payloads: never log a record or put one in an error.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import { RawRecordSchema, type RawRecord, type SyncSink } from "../contract/index";
import type { JobClientFor } from "../vault/tokens";
import { assertContentAllowed, assertNoForbiddenFields } from "./guard";

/**
 * Per-call limits. The database accepts up to 1000 records and 8 MB per call; the store stays under that with 500
 * records and ~5 MB per call. One payload may be at most 1 MB (measured on its JSON text; the database measures the
 * slightly longer jsonb text, so a borderline payload can still be refused there, as invalid_input).
 */
export const RAW_BATCH_SIZE = 500;
export const RAW_BATCH_BYTES = 5 * 1024 * 1024;
export const RAW_RECORD_MAX_BYTES = 1024 * 1024;

export interface RawRecordStore {
  /** Upserts the records of one connection; returns the number of rows written. All-or-nothing per call batch (500 records / ~5 MB). */
  upsertRawRecords(laneId: LaneId, conn: LaneBoundConnection<string>, records: readonly RawRecord<string>[]): Promise<number>;
  /** A `SyncSink` that stores each batch it receives (what `Connector.sync` writes to). */
  sinkFor(laneId: LaneId, conn: LaneBoundConnection<string>): SyncSink<string>;
}

const invalid = (message: string) => new ConnectorError({ kind: "invalid_input", message });

/** Internal: the store over a job-client source (injected in tests). */
export function createRawRecordStore(clientFor: JobClientFor): RawRecordStore {
  type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string } | null }>;

  async function upsertRawRecords(laneId: LaneId, conn: LaneBoundConnection<string>, records: readonly RawRecord<string>[]): Promise<number> {
    assertLaneBound(laneId, conn);
    if (records.length === 0) return 0;

    // Validate everything before anything is written: one bad record fails the call, with no partial store.
    const validated: RawRecord<string>[] = [];
    for (const r of records) {
      const parsed = RawRecordSchema.safeParse(r);
      if (!parsed.success) throw invalid("A raw record is malformed");
      const rec = parsed.data as RawRecord<string>;
      if (rec.lane_id !== laneId || rec.connection_id !== conn.id || rec.provider !== conn.provider) {
        throw new ConnectorError({ kind: "lane_mismatch", message: "A raw record does not belong to this lane and connection" });
      }
      validated.push(rec);
    }
    assertNoForbiddenFields(validated);
    const sizes = validated.map((r) => Buffer.byteLength(JSON.stringify(r.payload), "utf8"));
    if (sizes.some((n) => n > RAW_RECORD_MAX_BYTES)) throw invalid("A raw record payload is over 1 MB");

    let client: Awaited<ReturnType<JobClientFor>>;
    try {
      client = await clientFor(laneId);
    } catch {
      throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for raw record access" });
    }

    // Lane policy (rule 6). A missing policy row counts as "do not store bodies".
    let storeContentBodies = false;
    try {
      const { data, error } = await client.schema("core").from("lane_policies").select("store_content_bodies").eq("lane_id", laneId).maybeSingle();
      if (error) throw error;
      storeContentBodies = data?.store_content_bodies === true;
    } catch {
      throw new ConnectorError({ kind: "transient", message: "Lane policy unavailable" });
    }
    assertContentAllowed(validated, { storeContentBodies });

    const rpc = client.schema("core").rpc.bind(client.schema("core")) as unknown as Rpc;
    // Batches are cut by record count and by total payload bytes.
    const batches: RawRecord<string>[][] = [];
    let current: RawRecord<string>[] = [];
    let currentBytes = 0;
    validated.forEach((r, i) => {
      const n = sizes[i] as number;
      if (current.length > 0 && (current.length >= RAW_BATCH_SIZE || currentBytes + n > RAW_BATCH_BYTES)) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(r);
      currentBytes += n;
    });
    if (current.length > 0) batches.push(current);

    let written = 0;
    for (const group of batches) {
      const batch = group.map((r) => ({
        object_type: r.object_type,
        external_id: r.external_id,
        payload: r.payload,
        source_updated_at: r.source_updated_at,
        deleted: r.deleted,
        synced_at: r.synced_at,
      }));
      let result: Awaited<ReturnType<Rpc>>;
      try {
        result = await rpc("source_records_upsert", { p_lane: laneId, p_connection_id: conn.id, p_records: batch });
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Raw record store unavailable" });
      }
      if (result.error) {
        // Database text can echo values; only a fixed message leaves this function.
        const code = result.error.code ?? "";
        if (code === "42501") throw new ConnectorError({ kind: "forbidden", message: "Raw record write refused" });
        // Data exceptions (22xxx), constraint violations (23xxx) and limit exceeded (54000) will not succeed on retry.
        if (/^(22|23)/.test(code) || code === "54000") throw invalid("Raw record write rejected as invalid");
        throw new ConnectorError({ kind: "transient", message: "Raw record store unavailable" });
      }
      written += typeof result.data === "number" ? result.data : 0;
    }
    return written;
  }

  return {
    upsertRawRecords,
    sinkFor: (laneId, conn) => async (batch) => {
      await upsertRawRecords(laneId, conn, batch);
    },
  };
}
