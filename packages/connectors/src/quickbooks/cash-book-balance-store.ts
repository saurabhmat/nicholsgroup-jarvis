// The fin.cash_book_balances reader and writer (T-302) over core.fin_cash_account_ids and core.fin_cash_book_balances_put with the lane's job client. PostgREST
// exposes core, not fin, and the functions re-check lane, provider and connection status themselves. Database messages are never passed on (a refusal
// can name table data): every failure becomes a fixed ConnectorError. Account ids and balances are never logged.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { assertLaneBound } from "../contract/lane-bound";
import type { JobClientFor } from "../vault/tokens";
import { assertQuickbooksConnection, type QboConnection } from "./guard";
import type { CashBookBalance } from "./cash-book-balances";

/** A database call is abandoned after this long (the run then fails as transient and is retried). */
export const CASH_BOOK_BALANCE_STORE_TIMEOUT_MS = 30_000;

export type CashBookBalanceEntry = {
  /** The date (YYYY-MM-DD, New York) the balances are at the end of. */
  date: string;
  /** When QuickBooks produced the figures (never later than the fetch). */
  asOf: string;
  balances: readonly CashBookBalance[];
};

export interface CashBookBalanceStore {
  /** QuickBooks ids of the connection's bank accounts that the normalizer kept (fin.accounts: is_bank, active, not deleted). */
  accountIds(laneId: LaneId, conn: QboConnection): Promise<string[]>;
  /** Writes ALL accounts of one date in one call; the database refuses the whole call when any account is not a bank account of the connection. */
  put(laneId: LaneId, conn: QboConnection, entry: CashBookBalanceEntry): Promise<void>;
  /**
   * Retention (26 weeks), rows of disconnected connections and, with `all` (the history switch is off), every stored row of the connection. Called at the
   * start of each reports run, on its own.
   */
  purge(laneId: LaneId, conn: QboConnection, all: boolean): Promise<void>;
}

export function createCashBookBalanceStore(clientFor: JobClientFor): CashBookBalanceStore {
  const clientOf = async (laneId: LaneId): Promise<Awaited<ReturnType<JobClientFor>>> => {
    try {
      return await clientFor(laneId);
    } catch {
      throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for cash book balance storage" });
    }
  };
  const fail = (code: string | undefined): ConnectorError => {
    if (code === "22023" || code === "23514") return new ConnectorError({ kind: "provider_error", message: "The cash book balances were refused by the database" });
    if (code === "42501") return new ConnectorError({ kind: "connection_unavailable", message: "The connection is not usable for cash book balance storage" });
    return new ConnectorError({ kind: "transient", message: "Cash book balance store unavailable" });
  };
  return {
    async accountIds(laneId, conn) {
      assertLaneBound(laneId, conn);
      assertQuickbooksConnection(conn);
      const client = await clientOf(laneId);
      let data: unknown;
      let code: string | undefined;
      try {
        const res = await client.schema("core").rpc("fin_cash_account_ids", { p_lane: laneId, p_connection_id: conn.id }).abortSignal(AbortSignal.timeout(CASH_BOOK_BALANCE_STORE_TIMEOUT_MS));
        if (res.error) code = res.error.code;
        else data = res.data;
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Cash book balance store unavailable" });
      }
      if (code !== undefined) throw fail(code);
      if (!Array.isArray(data) || data.some((x) => typeof x !== "string")) throw new ConnectorError({ kind: "provider_error", message: "The cash account list is not valid" });
      return data as string[];
    },
    async purge(laneId, conn, all) {
      assertLaneBound(laneId, conn);
      assertQuickbooksConnection(conn);
      const client = await clientOf(laneId);
      let code: string | undefined;
      try {
        const { error } = await client.schema("core").rpc("fin_cash_book_balances_purge", { p_lane: laneId, p_connection_id: conn.id, p_all: all }).abortSignal(AbortSignal.timeout(CASH_BOOK_BALANCE_STORE_TIMEOUT_MS));
        if (!error) return;
        code = error.code;
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Cash book balance store unavailable" });
      }
      throw fail(code);
    },
    async put(laneId, conn, entry) {
      assertLaneBound(laneId, conn);
      assertQuickbooksConnection(conn);
      const client = await clientOf(laneId);
      let code: string | undefined;
      try {
        const { error } = await client.schema("core").rpc("fin_cash_book_balances_put", {
          p_lane: laneId,
          p_connection_id: conn.id,
          p_date: entry.date,
          p_as_of: entry.asOf,
          p_balances: entry.balances.map((b) => ({ account_id: b.accountId, book_balance: b.balance })),
        }).abortSignal(AbortSignal.timeout(CASH_BOOK_BALANCE_STORE_TIMEOUT_MS));
        if (!error) return;
        code = error.code;
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Cash book balance store unavailable" });
      }
      throw fail(code);
    },
  };
}
