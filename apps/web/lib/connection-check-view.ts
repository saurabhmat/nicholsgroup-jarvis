// What the Settings "Temporary: connection test" section says about a check result (T-198). Pure and browser-safe: the
// route returns only a status, a time and Intuit's request id, and this is all the page ever renders of it.
export const CHECK_STATUSES = ["ok", "reconnect_required", "not_connected", "error"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
export type CheckResult = { status: CheckStatus; checked_at: string; intuit_tid: string | null };

/** Parses the route's JSON; anything that is not exactly the three fields is refused, so nothing else can be rendered. */
export function parseCheckResult(value: unknown): CheckResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (keys !== "checked_at,intuit_tid,status") return null;
  if (typeof v.status !== "string" || !(CHECK_STATUSES as readonly string[]).includes(v.status)) return null;
  if (typeof v.checked_at !== "string" || Number.isNaN(Date.parse(v.checked_at))) return null;
  if (v.intuit_tid !== null && (typeof v.intuit_tid !== "string" || v.intuit_tid.length > 256)) return null;
  return { status: v.status as CheckStatus, checked_at: v.checked_at, intuit_tid: v.intuit_tid };
}

export type CheckView = { variant: "success" | "alert" | "default"; title: string; description: string };

export function describeCheck(status: CheckStatus): CheckView {
  switch (status) {
    case "ok":
      return { variant: "success", title: "Connected", description: "QuickBooks answered the health check." };
    case "reconnect_required":
      return { variant: "alert", title: "Reconnect needed", description: "QuickBooks no longer accepts this connection. Use Connect QuickBooks again." };
    case "not_connected":
      return { variant: "default", title: "Not connected", description: "No QuickBooks company is connected to this company yet." };
    case "error":
      return { variant: "alert", title: "Could not check", description: "QuickBooks did not answer as expected. Try again, and send the request id to support if it keeps failing." };
  }
}
