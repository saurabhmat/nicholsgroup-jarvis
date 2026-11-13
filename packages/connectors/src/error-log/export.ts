// Export encoders for the connector error log (T-196): a date range of core.connector_api_errors (and core.sync_runs) as CSV or
// JSON for the provider's support (Intuit). Pure: the route reads the rows with the signed-in user's client (RLS) and calls these.
// CSV is injection-safe: a cell that starts with = + - @ (or a tab / carriage return) gets a leading apostrophe, so a spreadsheet
// never evaluates it. Cells with a comma, quote or newline are quoted.

/** The longest range one export covers. */
export const EXPORT_MAX_DAYS = 90;
const DAY_MS = 86_400_000;

export const EXPORT_FORMATS = ["csv", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_DATASETS = ["errors", "runs"] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

export type ExportRange = { from: string; to: string };
export type RangeResult = { ok: true; range: ExportRange } | { ok: false; reason: "invalid_range" | "range_too_long" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseBoundary(value: string | null, endOfDay: boolean): number | null {
  if (value === null) return null;
  if (DATE.test(value)) {
    const t = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value) return null;
    return endOfDay ? t + DAY_MS : t;
  }
  const t = Date.parse(value);
  return Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}T/.test(value) ? null : t;
}

/**
 * `from` and `to` are dates (YYYY-MM-DD, whole UTC days, `to` inclusive) or full ISO timestamps (`to` exclusive). The range is
 * [from, to), must be positive and at most 90 days.
 */
export function parseExportRange(from: string | null, to: string | null): RangeResult {
  const a = parseBoundary(from, false);
  const b = parseBoundary(to, true);
  if (a === null || b === null || b <= a) return { ok: false, reason: "invalid_range" };
  if (b - a > EXPORT_MAX_DAYS * DAY_MS) return { ok: false, reason: "range_too_long" };
  return { ok: true, range: { from: new Date(a).toISOString(), to: new Date(b).toISOString() } };
}

/** One CSV cell: formula-safe, then quoted if needed. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

export const ERROR_COLUMNS = [
  "at", "connection_id", "provider", "endpoint", "http_status", "provider_error_code", "provider_message", "provider_tid", "kind", "disposition", "retry_after_seconds",
] as const;
export const RUN_COLUMNS = [
  "started_at", "finished_at", "connection_id", "job", "kind", "trigger", "status", "records_received", "records_written", "error_kind", "error_http_status", "error_code", "error_tid", "error_endpoint",
] as const;

/** A sync_runs row flattened for export: counts and the error's safe fields; the error message is not exported. */
export function flattenRun(run: Record<string, unknown>): Record<string, unknown> {
  const e = (run.error ?? null) as Record<string, unknown> | null;
  const pick = (k: string) => (e && typeof e === "object" ? (e[k] ?? null) : null);
  const rest = Object.fromEntries(Object.entries(run).filter(([k]) => k !== "error"));
  return { ...rest, error_kind: pick("kind"), error_http_status: pick("http_status"), error_code: pick("provider_error_code"), error_tid: pick("provider_tid"), error_endpoint: pick("endpoint") };
}

export function pick(rows: readonly Record<string, unknown>[], columns: readonly string[]): Record<string, unknown>[] {
  return rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null])));
}
