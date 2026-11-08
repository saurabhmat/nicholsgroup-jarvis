// What Settings → Connections says about a Composio "Test" (T-219). Pure and browser-safe: the route returns only a status
// and a time, and this is all the page renders of it.
export const COMPOSIO_CHECK_STATUSES = ["ok", "reconnect_required", "not_connected", "mailbox_not_allowed", "error"] as const;
export type ComposioCheckStatus = (typeof COMPOSIO_CHECK_STATUSES)[number];
export type ComposioCheckResult = { status: ComposioCheckStatus; checked_at: string };

/** Parses the route's JSON; anything that is not exactly `{ status, checked_at }` is refused. */
export function parseComposioCheck(value: unknown): ComposioCheckResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "checked_at,status") return null;
  if (typeof v.status !== "string" || !(COMPOSIO_CHECK_STATUSES as readonly string[]).includes(v.status)) return null;
  if (typeof v.checked_at !== "string" || Number.isNaN(Date.parse(v.checked_at))) return null;
  return { status: v.status as ComposioCheckStatus, checked_at: v.checked_at };
}

export type ComposioCheckView = { variant: "success" | "alert" | "default"; title: string; description: string };

export function describeComposioCheck(status: ComposioCheckStatus): ComposioCheckView {
  switch (status) {
    case "ok":
      return { variant: "success", title: "Connected", description: "The account answered: its address matches and one page was read. Nothing was saved." };
    case "reconnect_required":
      return { variant: "alert", title: "Reconnect needed", description: "Composio reports this account as expired or revoked. Use Reconnect via Composio." };
    case "not_connected":
      return { variant: "default", title: "Not connected", description: "This account has not finished connecting." };
    case "mailbox_not_allowed":
      return { variant: "alert", title: "Mailbox not allowed", description: "This address is not in the company's mailbox list, so nothing was read. Ask your administrator to add it." };
    case "error":
      return { variant: "alert", title: "Could not check", description: "Composio did not answer as expected. Try again in a minute." };
  }
}
