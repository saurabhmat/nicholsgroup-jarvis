// Raw source records (T-039): the upsert helper over core.source_records_upsert. Lane-aware: the client comes from the
// lane router's job client for the record's lane, the connection must be lane-bound for that lane, and every record
// must carry the same lane, connection and provider. The lane policy is read here for the content guard, and the
// database trigger enforces it again. Rows hold provider payloads: never log a record or put one in an error.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import { RawRecordSchema, type RawRecord, type SyncSink } from "../contract/index";
import type { JobClientFor } from "../vault/tokens";
import { assertContentAllowed, assertNoForbiddenFields, payloadProblem } from "./guard";

/**
 * Per-call limits. The database accepts up to 1000 records and 8 MB per call; the store stays under that with 500
 * records and ~5 MB per call. One payload may be at most 680000 bytes of JSON text: the database measures the jsonb text
 * (`: ` and `, ` separators, escapes), which is longer, against 1 MB, so this keeps a payload accepted here from being
 * refused there. A refusal in the database is still mapped to invalid_input.
 */
export const RAW_BATCH_SIZE = 500;
export const RAW_BATCH_BYTES = 5 * 1024 * 1024;
export const RAW_RECORD_MAX_BYTES = 680_000;

/**
 * The database's timestamp rule (core.source_records_upsert): ISO-8601 with seconds and an explicit offset, at most 9
 * fractional digits. Pinned to the migration by a test; the zod instant is looser (any number of fractional digits).
 */
export const RAW_TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$/;

/**
 * Bytes of the payload's JSON text, rounded up for what jsonb prints longer: numbers JSON prints in exponent form
 * (1e+21, 1e-7) are written out in full by jsonb (up to ~330 characters), so each counts as 330 extra.
 */
export function payloadJsonBytes(payload: unknown): number {
  let extra = 0;
  const text = JSON.stringify(payload, (_k, v: unknown) => {
    if (typeof v === "number" && v !== 0 && (Math.abs(v) >= 1e21 || Math.abs(v) < 1e-6)) extra += 330;
    return v;
  });
  return Buffer.byteLength(text, "utf8") + extra;
}

export interface RawRecordStore {
  /** Upserts the records of one connection; returns the number of rows written. All-or-nothing per call batch (500 records / ~5 MB). */
  upsertRawRecords(laneId: LaneId, conn: LaneBoundConnection<string>, records: readonly RawRecord<string>[]): Promise<number>;
  /**
   * Same, but also reports `skipped`: records not written because the stored version is newer (stale or replayed) or a
   * later record for the same object in the same call superseded them.
   */
  upsertRawRecordsDetailed(laneId: LaneId, conn: LaneBoundConnection<string>, records: readonly RawRecord<string>[]): Promise<{ written: number; skipped: number }>;
  /** A `SyncSink` that stores each batch it receives (what `Connector.sync` writes to). */
  sinkFor(laneId: LaneId, conn: LaneBoundConnection<string>): SyncSink<string>;
}

const invalid = (message: string) => new ConnectorError({ kind: "invalid_input", message });

/** Internal: the store over a job-client source (injected in tests). */
export function createRawRecordStore(clientFor: JobClientFor): RawRecordStore {
  type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string } | null }>;

  async function upsertDetailed(
    laneId: LaneId, conn: LaneBoundConnection<string>, records: readonly RawRecord<string>[],
  ): Promise<{ written: number; skipped: number }> {
    assertLaneBound(laneId, conn);
    if (records.length === 0) return { written: 0, skipped: 0 };

    // Validate everything before anything is written: one bad record fails the call, with no partial store.
    const validated: RawRecord<string>[] = [];
    for (const r of records) {
      const parsed = RawRecordSchema.safeParse(r);
      if (!parsed.success) throw invalid("A raw record is malformed");
      const rec = parsed.data as RawRecord<string>;
      if (rec.lane_id !== laneId || rec.connection_id !== conn.id || rec.provider !== conn.provider) {
        throw new ConnectorError({ kind: "lane_mismatch", message: "A raw record does not belong to this lane and connection" });
      }
      if (!RAW_TIMESTAMP_RE.test(rec.synced_at) || (rec.source_updated_at !== null && !RAW_TIMESTAMP_RE.test(rec.source_updated_at))) {
        throw invalid("A raw record timestamp is malformed");
      }
      validated.push(rec);
    }
    // Cheap checks first, before any guard runs: size, then NUL (jsonb cannot hold U+0000) and over-long keys.
    const sizes = validated.map((r) => payloadJsonBytes(r.payload));
    if (sizes.some((n) => n > RAW_RECORD_MAX_BYTES)) throw invalid("A raw record payload is too large");
    for (const r of validated) {
      const problem = payloadProblem(r.payload);
      if (problem === "nul") throw invalid("A raw record payload contains a NUL character");
      if (problem === "long_key") throw invalid("A raw record payload has a key that is too long");
    }
    assertNoForbiddenFields(validated);

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
    let skipped = 0;
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
        // Data exceptions (22xxx), constraint violations (23xxx), limit exceeded (54000) and a statement timeout (57014,
        // which a payload that is too expensive to scan produces) will not succeed on retry.
        if (/^(22|23)/.test(code) || code === "54000" || code === "57014") throw invalid("Raw record write rejected as invalid");
        throw new ConnectorError({ kind: "transient", message: "Raw record store unavailable" });
      }
      const n = typeof result.data === "number" ? result.data : 0;
      written += n;
      skipped += Math.max(0, group.length - n);
    }
    return { written, skipped };
  }

  return {
    upsertRawRecords: async (laneId, conn, records) => (await upsertDetailed(laneId, conn, records)).written,
    upsertRawRecordsDetailed: upsertDetailed,
    sinkFor: (laneId, conn) => async (batch) => {
      await upsertDetailed(laneId, conn, batch);
    },
  };
}
