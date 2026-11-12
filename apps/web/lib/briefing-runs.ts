// The run-claim side of the automatic AI summary (T-235 part 1): shared constants, the poll's shape and the pure helpers the Home
// card uses. No server-only code: the client component imports this.
export const STALE_AFTER_MS = 3 * 3_600_000;
export const REGENERATE_EVERY_MS = 30 * 60_000;
export const DAILY_RUN_CAP = 6;

export type BriefingGate = "not_stale" | "running" | "cap_reached" | "cooldown" | "rate_limited";

/** What the card needs from core.briefing_run_state. Times are ISO strings or null. */
export type BriefingRunStateView = { running: boolean; lastRegenerateAt: string | null; runsToday: number; latestPreparedAt: string | null; lastAttemptAt: string | null };

const iso = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

/** Parses the RPC result (a one-row table); anything else is null. */
export function briefingRunStateFrom(data: unknown): BriefingRunStateView | null {
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (!row || typeof row.running !== "boolean") return null;
  return {
    running: row.running,
    lastRegenerateAt: iso(row.last_regenerate_at),
    runsToday: typeof row.runs_today === "number" ? row.runs_today : 0,
    latestPreparedAt: iso(row.latest_prepared_at),
    lastAttemptAt: iso(row.last_attempt_at),
  };
}

/** True when there is no briefing, or the newest good one is older than 3 hours. */
export function isStale(preparedAt: string | null, nowMs: number): boolean {
  if (!preparedAt) return true;
  const t = Date.parse(preparedAt);
  return Number.isNaN(t) || nowMs - t > STALE_AFTER_MS;
}

/** When Regenerate is available again (ms), or null when it is available now. */
export function regenerateAvailableAt(lastRegenerateAt: string | null, nowMs: number): number | null {
  if (!lastRegenerateAt) return null;
  const t = Date.parse(lastRegenerateAt) + REGENERATE_EVERY_MS;
  return t > nowMs ? t : null;
}
