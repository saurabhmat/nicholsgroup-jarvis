// Coverage (T-231a): what the briefing could read. Every mail and calendar stream the caller may see appears, with a
// FIXED reason when it is not OK, so missing access is never shown as "nothing". Reasons never carry provider text.
import { ago } from "./time";

export type CoverageRow = {
  stream: "mail" | "calendar";
  account: string;
  connectionId: string | null;
  provider: string | null;
  status: string;
  configured: boolean;
  lastSyncAt: string | null;
  errorKind: string | null;
};

export type CoverageState = "ok" | "stale" | "error" | "not_connected";

export type CoverageItem = CoverageRow & { state: CoverageState; reason: string | null };

const ERROR_REASONS: Record<string, string> = {
  reconnect_required: "Access expired. Reconnect in Settings.",
  forbidden: "Access was refused. Reconnect in Settings.",
  rate_limited: "The provider is limiting requests; retrying.",
  transient: "The provider had a temporary problem; retrying.",
  timeout: "The provider did not answer in time; retrying.",
  connection_unavailable: "The connection is unavailable. Check Settings.",
  not_found: "The mailbox or calendar was not found. Check Settings.",
};

const STATUS_REASONS: Record<string, string> = {
  reconnect_required: "Access expired. Reconnect in Settings.",
  degraded: "Sync is failing. Check Settings.",
  pending: "Connection not finished. Finish it in Settings.",
  not_connected: "Not connected. Connect it in Settings.",
};

/** Turns coverage rows into states with fixed reasons. `staleMinutes` from lane_config.briefing.coverage_stale_minutes. */
export function toCoverage(rows: CoverageRow[], now: Date, staleMinutes: number): CoverageItem[] {
  return rows.map((r) => {
    if (r.status === "not_connected" || r.connectionId === null) return { ...r, state: "not_connected", reason: STATUS_REASONS.not_connected ?? null };
    if (r.status !== "active") {
      const reason = (r.errorKind ? ERROR_REASONS[r.errorKind] : undefined) ?? STATUS_REASONS[r.status] ?? "The connection has a problem. Check Settings.";
      return { ...r, state: "error", reason };
    }
    if (r.lastSyncAt === null) return { ...r, state: "stale", reason: "Not synced yet." };
    if (now.getTime() - Date.parse(r.lastSyncAt) > staleMinutes * 60_000) return { ...r, state: "stale", reason: `Last synced ${ago(r.lastSyncAt, now)}.` };
    return { ...r, state: "ok", reason: null };
  });
}

/** Parses the rows of core.briefing_coverage; anything malformed is dropped. */
export function parseCoverageRows(data: unknown): CoverageRow[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw: Record<string, unknown>) => {
    const stream = raw.stream;
    if ((stream !== "mail" && stream !== "calendar") || typeof raw.account !== "string" || typeof raw.status !== "string") return [];
    const at = typeof raw.last_sync_at === "string" && !Number.isNaN(Date.parse(raw.last_sync_at)) ? new Date(raw.last_sync_at).toISOString() : null;
    return [
      {
        stream,
        account: raw.account,
        connectionId: typeof raw.connection_id === "string" ? raw.connection_id : null,
        provider: typeof raw.provider === "string" ? raw.provider : null,
        status: raw.status,
        configured: raw.configured === true,
        lastSyncAt: at,
        errorKind: typeof raw.error_kind === "string" ? raw.error_kind : null,
      },
    ];
  });
}

const label = (s: CoverageItem["stream"]) => (s === "mail" ? "Mail" : "Calendar");

/**
 * The one-line Coverage sentence, always present. With no rows at all it says so (the caller may not see mail or
 * calendar, or nothing is configured), never "nothing to report".
 */
export function coverageLine(items: CoverageItem[], hasAccess: boolean): string {
  if (!hasAccess) return "Coverage: your role in this company does not include mail or calendar.";
  if (items.length === 0) return "Coverage: no mailbox or calendar is set up for this company yet. Connect one in Settings.";
  const ok = items.filter((i) => i.state === "ok");
  const bad = items.filter((i) => i.state !== "ok");
  const okText = ok.length > 0 ? `${ok.map((i) => `${label(i.stream)} ${i.account}`).join(", ")} up to date` : "";
  const badText = bad.map((i) => `${label(i.stream)} ${i.account}: ${i.state === "not_connected" ? "not connected" : i.state === "stale" ? "stale" : "error"}`).join("; ");
  return `Coverage: ${[okText, badText].filter((t) => t !== "").join("; ")}.`;
}
