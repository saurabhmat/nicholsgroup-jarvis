// QuickBooks entity sync (T-051; QB-10 detection, QB-12 CDC cursor, QB-13): read-only. Initial load by paged query,
// then Intuit's Change Data Capture (`/cdc?entities=...&changedSince=`), into raw.source_records through the `sink`.
//  - The cursor is the `changedSince` instant: the START of the last fully successful run minus a small overlap (so a
//    change made while the run was reading is fetched again next time; upserts are idempotent). The caller stores it only
//    after this function resolves (T-038 runner), so a failed run leaves it where it was.
//  - No cursor, an unreadable one, or one older than Intuit's 30-day CDC look-back (less a safety margin) means a FULL
//    reload, never a gap. A CDC answer that hit Intuit's 1000-objects-per-entity cap is treated the same way.
//  - Deleted objects arrive from CDC as `status: "Deleted"` and are stored as `deleted: true` records (Id only). A full
//    reload cannot see deletions that happened while the cursor was stale; the tie-out (T-172) covers that gap.
//  - Preferences are read on every run (before any data): the flags go to the connection (changes audited) and the
//    object itself is stored. CompanyInfo is stored too. Nothing reads multicurrency or sales-tax fields.
//  - Only GET calls through `QboApi` (which exposes nothing else); the approvals-only writer is not imported here.
// Records never appear in logs or errors; counts only.
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { ConnectorError } from "../contract/errors";
import { assertLaneBound } from "../contract/lane-bound";
import type { RawRecord, SyncCursor, SyncOptions, SyncSummary } from "../contract/schemas";
import { connectorLog, type ConnectorLogger } from "../log/index";
import type { QboApi } from "./api";
import { projectCompanyInfo, projectDeleted, projectEntity, projectPreferences, projectTombstone, classifyPayrollAccounts, exclusionReason, QBO_HAS_ACTIVE_FLAG, QBO_OBJECT_TYPES, QBO_SYNC_ENTITIES, type ProjectedRecord, type QboEntity } from "./entities";
import type { QboFeatureRecorder } from "./features";
import type { QboConnection } from "./guard";

/** Intuit keeps 30 days of change data. */
export const CDC_LOOKBACK_MS = 30 * 24 * 3_600_000;
/** A cursor this close to the limit is already treated as too old (clock skew, a run that starts just inside the window). */
export const CDC_SAFETY_MS = 3_600_000;
/** The next cursor trails the run's start by this much. */
export const CURSOR_OVERLAP_MS = 5 * 60_000;
/** Intuit's page size for queries and the per-entity cap of a CDC answer. */
export const PAGE_SIZE = 1000;
const MAX_PAGES = 2000;

// ORDERBY Id: a stable order, so a deletion during the load cannot shift a record from one page to another.
const Q = (entity: string, start: number) =>
  `select * from ${entity}${QBO_HAS_ACTIVE_FLAG.has(entity) ? " where Active in (true, false)" : ""} ORDERBY Id STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`;

const ISO_Z = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const QueryResponse = z.looseObject({ QueryResponse: z.record(z.string(), z.unknown()).optional() });
const SingletonResponse = (key: string) => z.looseObject({ [key]: z.record(z.string(), z.unknown()) });
const CdcResponse = z.looseObject({ CDCResponse: z.array(z.looseObject({ QueryResponse: z.array(z.record(z.string(), z.unknown())).optional() })).min(1) });

/** `lane_config.finance.payroll` (D-25). Must be readable: if it throws, the run fails before any call (fail closed). */
export type PayrollSettings = { accountIds: string[]; accountSubtypes: string[]; excludedEntityIds: string[] };

export type QboSyncDeps = { api: QboApi; features: QboFeatureRecorder; payroll: (laneId: LaneId) => Promise<PayrollSettings>; now: () => number; logger?: ConnectorLogger };

const providerError = (message: string, tid: string | null = null) => new ConnectorError({ kind: "provider_error", message, provider_tid: tid });

/** The stored cursor as epoch ms, or null when it is missing, malformed, in the future or too old to resume from. */
export function usableCursor(cursor: SyncCursor | null, nowMs: number): number | null {
  if (!cursor || !ISO_Z.test(cursor.value)) return null;
  const t = Date.parse(cursor.value);
  if (Number.isNaN(t) || t > nowMs + 60_000) return null;
  return nowMs - t >= CDC_LOOKBACK_MS - CDC_SAFETY_MS ? null : t;
}

export function createQboSync(deps: QboSyncDeps) {
  const log = deps.logger ?? connectorLog;

  return async function sync(
    laneId: LaneId,
    conn: QboConnection,
    cursor: SyncCursor | null,
    sink: (batch: RawRecord<"quickbooks">[]) => Promise<void>,
    options?: SyncOptions,
  ): Promise<SyncSummary> {
    assertLaneBound(laneId, conn);
    const realm = conn.external_account_id;
    // D-25 / spec: payroll and compensation are never stored. The setting is read first and a failure ends the run before
    // any Intuit call, audit row or write: transactions are never stored without knowing what is payroll.
    const payroll = await deps.payroll(laneId);
    const startedMs = deps.now();
    const syncedAt = new Date(startedMs).toISOString();
    let delivered = 0;
    let lastTid: string | null = null;

    const wanted = options?.objectTypes ?? null;
    if (wanted && wanted.some((t) => !QBO_OBJECT_TYPES.includes(t))) throw new ConnectorError({ kind: "invalid_input", message: "Unknown QuickBooks object type" });
    const entities: QboEntity[] = wanted ? QBO_SYNC_ENTITIES.filter((e) => wanted.includes(e)) : [...QBO_SYNC_ENTITIES];
    // A subset run cannot move the cursor of the whole connection: it needs a fresh one and hands the same one back.
    const targeted = entities.length < QBO_SYNC_ENTITIES.length;

    const emit = async (records: ProjectedRecord[]) => {
      for (let i = 0; i < records.length; i += PAGE_SIZE) {
        const batch = records.slice(i, i + PAGE_SIZE).map(
          (r): RawRecord<"quickbooks"> => ({
            lane_id: laneId,
            provider: "quickbooks",
            connection_id: conn.id,
            object_type: r.objectType,
            external_id: r.externalId,
            payload: r.payload as RawRecord<"quickbooks">["payload"],
            source_updated_at: r.sourceUpdatedAt,
            deleted: r.deleted,
            synced_at: syncedAt,
          }),
        );
        await sink(batch);
        delivered += batch.length;
      }
    };

    const singleton = async (key: "Preferences" | "CompanyInfo") => {
      const res = await deps.api.get<unknown>(laneId, conn, `/v3/company/{realm}/${key === "Preferences" ? "preferences" : "companyinfo/{realm}"}`, { realm });
      lastTid = res.providerTid ?? lastTid;
      const parsed = SingletonResponse(key).safeParse(res.data);
      if (!parsed.success) throw providerError(`${key} response is not valid`, res.providerTid);
      return parsed.data[key] as unknown;
    };

    /** All pages of `select * from <entity>`, raw (callers project). */
    const queryAll = async (entity: QboEntity): Promise<unknown[]> => {
      const out: unknown[] = [];
      for (let page = 0, start = 1; ; page += 1, start += PAGE_SIZE) {
        if (page >= MAX_PAGES) throw providerError(`${entity} query did not end`, lastTid);
        const res = await deps.api.get<unknown>(laneId, conn, "/v3/company/{realm}/query", { realm }, { query: Q(entity, start) });
        lastTid = res.providerTid ?? lastTid;
        const parsed = QueryResponse.safeParse(res.data);
        if (!parsed.success) throw providerError("Query response is not valid", res.providerTid);
        const rows = parsed.data.QueryResponse?.[entity];
        if (rows !== undefined && !Array.isArray(rows)) throw providerError("Query response is not valid", res.providerTid);
        const items = (rows ?? []) as unknown[];
        out.push(...items);
        if (items.length < PAGE_SIZE) return out;
      }
    };

    // Refused before any call, audit row or token use.
    const since = usableCursor(cursor, startedMs);
    if (targeted && since === null) throw new ConnectorError({ kind: "invalid_input", message: "A targeted QuickBooks sync needs a current cursor" });

    // 1. Preferences first, every run: the flags are stored and audited before any data is read.
    const prefs = projectPreferences(await singleton("Preferences"), realm);
    if (!prefs) throw providerError("Preferences response is not valid", lastTid);
    const company = projectCompanyInfo(await singleton("CompanyInfo"), realm);
    if (!company) throw providerError("CompanyInfo is not valid or is for a different company than the connection", lastTid);
    await deps.features.record(laneId, conn, prefs.features, syncedAt);

    await emit([prefs.record, company]);

    // 1b. Payroll accounts for this run: one fresh Account query every run (full or CDC), so a CDC run classifies
    // transactions against today's accounts, not a stored copy. In a full load these same rows are the Account records.
    const needsAccounts = entities.some((e) => e !== "Customer" && e !== "Vendor" && e !== "Class");
    const accountItems: unknown[] = needsAccounts ? await queryAll("Account") : [];
    const policy = {
      payrollAccountIds: classifyPayrollAccounts(accountItems, payroll),
      excludedEntityIds: new Set(payroll.excludedEntityIds),
    };

    let excluded = 0;
    /** Projects one live object; an excluded one (employee, payroll, excluded entity) becomes a tombstone. A shape problem throws. */
    const project = (entity: QboEntity, raw: unknown, tid: string | null): ProjectedRecord => {
      if (exclusionReason(entity, raw, policy) !== null) {
        excluded += 1;
        const t = projectTombstone(entity, raw);
        if (!t) throw providerError(`A ${entity} record does not match the expected shape`, tid);
        return t;
      }
      const r = projectEntity(entity, raw);
      if (!r) throw providerError(`A ${entity} record does not match the expected shape`, tid);
      return r;
    };

    const loadAll = async (list: readonly QboEntity[]) => {
      for (const entity of list) {
        const items = entity === "Account" ? accountItems : await queryAll(entity);
        await emit(items.map((raw) => project(entity, raw, lastTid)));
      }
    };

    // 2. Resume from the cursor, or reload.
    let mode: SyncSummary["mode"];
    if (entities.length === 0) {
      mode = "incremental"; // singletons only (Preferences, CompanyInfo): nothing to fetch
    } else if (since === null) {
      mode = "full";
      await loadAll(entities);
    } else {
      mode = "incremental";
      const res = await deps.api.get<unknown>(laneId, conn, "/v3/company/{realm}/cdc", { realm }, { entities: entities.join(","), changedSince: new Date(since).toISOString() });
      lastTid = res.providerTid ?? lastTid;
      const parsed = CdcResponse.safeParse(res.data);
      if (!parsed.success) throw providerError("CDC response is not valid", res.providerTid);
      const records: ProjectedRecord[] = [];
      let capped = false;
      for (const block of parsed.data.CDCResponse) {
        for (const part of block.QueryResponse ?? []) {
          for (const entity of entities) {
            const items = part[entity];
            if (items === undefined) continue;
            if (!Array.isArray(items)) throw providerError("CDC response is not valid", res.providerTid);
            if (items.length >= PAGE_SIZE) capped = true;
            for (const raw of items as unknown[]) {
              const deleted = typeof raw === "object" && raw !== null && (raw as { status?: unknown }).status === "Deleted";
              const r = deleted ? projectDeleted(entity, raw) : project(entity, raw, res.providerTid);
              if (!r) throw providerError(`A ${entity} change does not match the expected shape`, res.providerTid);
              records.push(r);
            }
          }
        }
      }
      if (capped) {
        // Intuit returns at most 1000 objects per entity: more may have changed than we were given. Reload instead.
        log.child({ laneId, provider: "quickbooks", connectionId: conn.id }).info("qbo.sync.cdc_capped", {});
        mode = "full";
        await loadAll(entities);
      } else {
        await emit(records);
      }
    }

    // 3. The next cursor. A subset run hands back the one it was given.
    const next = targeted && cursor ? cursor.value : new Date(startedMs - CURSOR_OVERLAP_MS).toISOString();
    log.child({ laneId, provider: "quickbooks", connectionId: conn.id }).info("qbo.sync.done", { mode, records: delivered, excluded_objects: excluded });
    return { cursor: { value: next }, mode, records: delivered, provider_tid: lastTid };
  };
}
