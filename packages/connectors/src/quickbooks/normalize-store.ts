// The QuickBooks normalizer call (T-056): core.fin_qbo_normalize with the lane's job client. The function reads the private
// raw.source_records of ONE connection and writes fin.*; it re-checks lane, provider and connection status itself. PostgREST
// exposes core, not fin or raw. Database messages are never passed on (a refusal can name table data): every failure becomes
// a fixed ConnectorError, and the result is parsed with a strict schema that keeps only counts and two flags.
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { ConnectorError } from "../contract/errors";
import { assertLaneBound } from "../contract/lane-bound";
import type { JobClientFor } from "../vault/tokens";
import { assertQuickbooksConnection, type QboConnection } from "./guard";

/**
 * The normalizer may touch many rows; the call is abandoned after this long (the run then fails as transient, reason "timeout",
 * and is retried). T-241: under the Inngest route's maxDuration (120 s), so the run can still record its outcome before Vercel stops it.
 */
export const NORMALIZE_TIMEOUT_MS = 100_000;

/**
 * Why a call failed (T-241), from the error CODE only (a SQLSTATE or a PostgREST code: schema-level, never row data). Before this
 * every non-refusal became "Normalizer unavailable" (kind transient), so the run log could not tell a timeout from a missing function.
 */
export function failureReason(code: string | null, aborted: boolean): { kind: "transient" | "provider_error"; message: string } {
  const t = (why: string) => ({ kind: "transient" as const, message: `Normalizer unavailable: ${why}` });
  if (aborted) return t(`timed out after ${String(NORMALIZE_TIMEOUT_MS / 1000)} s`);
  if (code === null) return t("no answer from the database (network)");
  // The function is not there: the production SQL that adds it was not run. Retrying cannot help.
  if (code === "PGRST202" || code === "42883") return { kind: "provider_error", message: `Normalizer function not found (${code}): run the production SQL for the normalizer` };
  if (code === "57014") return t("statement timeout (SQLSTATE 57014)");
  if (code === "40P01" || code === "40001" || code === "55P03") return t(`lock or serialization conflict (SQLSTATE ${code})`);
  if (/^(08|53|57P)/.test(code)) return t(`database connection or resources (SQLSTATE ${code})`);
  if (/^PGRST\d{3}$/.test(code)) return t(`database API error (${code})`);
  if (/^[0-9A-Z]{5}$/.test(code)) return t(`SQLSTATE ${code}`);
  return t("unknown database error");
}

const isAbort = (e: unknown): boolean => e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");

const Count = z.int().min(0);
const TableCounts = z.object({ inserted: Count, updated: Count, tombstoned: Count, invalid: Count.optional() });
/** What the database returns: counts and the two class-tracking flags (QB-10). Unknown keys are dropped, never forwarded. */
export const NormalizeResultSchema = z.object({
  class_tracking: z.boolean(),
  class_fallback: z.boolean(),
  class_fallback_rows: Count,
  unmapped_rows: Count,
  null_account_lines: Count,
  invalid_records: Count,
  dead_deleted: Count,
  dead_unseen: Count,
  dead_payroll: Count,
  dead_entity: Count,
  dead_linked: Count,
  accounts: TableCounts,
  invoices: TableCounts,
  bills: TableCounts,
  payments: TableCounts.extend({ reallocated: Count }),
  transactions: TableCounts,
});
export type NormalizeResult = z.infer<typeof NormalizeResultSchema>;

/** Runs the normalizer for one QuickBooks connection with the lane's job client. Idempotent. */
export interface NormalizeStore {
  normalize(laneId: LaneId, conn: QboConnection): Promise<NormalizeResult>;
}

/**
 * The function re-raises every failure as `fin.qbo_normalize failed: SQLSTATE <code>, table <name>, constraint <name>` (schema
 * object names, never row data). Only a message of exactly that shape is passed on, so an operator can see which constraint
 * refused a record without any database text of another kind reaching a log.
 */
const REFUSAL = /^fin\.qbo_normalize failed: SQLSTATE ([0-9A-Z]{5}), table ([a-z_]{1,63}|-), constraint ([a-z0-9_]{1,63}|-)(?:, step ([a-z_]{1,20}))?$/;
function refusalMessage(message: string): string {
  const m = REFUSAL.exec(message);
  // T-242: the function also names the section that was running (a fixed word such as "payments" or "transaction_keys").
  const step = m?.[4] ? `, step ${m[4]}` : "";
  return m ? `The normalizer refused the synced data (SQLSTATE ${m[1] ?? ""}, table ${m[2] ?? ""}, constraint ${m[3] ?? ""}${step})` : "The normalizer refused the synced data";
}
/** The step named in the function's constant failure message ("payments"), or null. */
function stepOf(message: string): string | null {
  return REFUSAL.exec(message)?.[4] ?? null;
}

export function createNormalizeStore(clientFor: JobClientFor): NormalizeStore {
  return {
    async normalize(laneId: LaneId, conn: QboConnection): Promise<NormalizeResult> {
      assertLaneBound(laneId, conn);
      assertQuickbooksConnection(conn);
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Lane client is not available for normalization" });
      }
      let data: unknown;
      let code: string | undefined;
      let message = "";
      const signal = AbortSignal.timeout(NORMALIZE_TIMEOUT_MS);
      try {
        const res = await client.schema("core").rpc("fin_qbo_normalize", { p_lane: laneId, p_connection_id: conn.id }).abortSignal(signal);
        if (res.error) {
          code = res.error.code || "unknown";
          message = typeof res.error.message === "string" ? res.error.message : "";
        }
        else data = res.data;
      } catch (e) {
        throw new ConnectorError(failureReason(null, signal.aborted || isAbort(e)));
      }
      if (code !== undefined) {
        // 22xxx / 23xxx: the database refused a value (constant message from the function). Retrying repeats it.
        if (code === "22023" && message === "fin.qbo_normalize: lane_config has no QuickBooks entity mapping") {
          throw new ConnectorError({ kind: "invalid_input", message: "The lane has no QuickBooks entity mapping in lane_config" });
        }
        if (/^2[23]/.test(code)) throw new ConnectorError({ kind: "provider_error", message: refusalMessage(message) });
        // T-242: 21000 (cardinality violation: two input rows for one target row, or a subquery with more than one row) comes from
        // the data and repeats on every attempt: permanent, not "transient" (production retried it for minutes).
        if (code === "21000") {
          const step = stepOf(message);
          throw new ConnectorError({ kind: "provider_error", message: `The normalizer found two rows for one record (SQLSTATE 21000${step ? `, step ${step}` : ""})` });
        }
        if (code === "42501") throw new ConnectorError({ kind: "connection_unavailable", message: "The connection is not usable for normalization" });
        // supabase-js reports an aborted fetch as an error object without a code; the signal says it was our timeout.
        throw new ConnectorError(failureReason(code === "unknown" ? (signal.aborted ? null : "unknown") : code, signal.aborted));
      }
      const parsed = NormalizeResultSchema.safeParse(data);
      if (!parsed.success) throw new ConnectorError({ kind: "provider_error", message: "The normalizer returned an unexpected result" });
      return parsed.data;
    },
  };
}
