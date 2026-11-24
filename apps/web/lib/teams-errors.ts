// What a failed Teams read means for the page (T-283, spec 11 "Could not load"; Microsoft's throttling rules). Decided from the connector error's KIND and Retry-After only: Microsoft's text
// (which can echo content) is never read, shown or logged. Plain function, no directive.
export type TeamsFailure =
  | { kind: "busy"; seconds: number | null } // 429: "Teams is busy, try again in N seconds"; never retried automatically
  | { kind: "reconnect" }
  | { kind: "not_found" } // the chat is gone, or not this person's
  | { kind: "forbidden" } // Microsoft said no (403): not allowed for this person or not approved by the administrator
  | { kind: "not_enabled" } // the portal itself refused before asking Microsoft: Teams (or this feature) is off for the company or the connection
  | { kind: "unavailable" };

const SECONDS = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.ceil(v), 300) : null);

export function teamsFailure(e: unknown): TeamsFailure {
  const info = typeof e === "object" && e !== null && "info" in e ? ((e as { info?: { kind?: unknown; retry_after_seconds?: unknown; http_status?: unknown } }).info ?? {}) : {};
  switch (info.kind) {
    case "rate_limited":
      return { kind: "busy", seconds: SECONDS(info.retry_after_seconds) };
    case "reconnect_required":
      return { kind: "reconnect" };
    case "not_found":
      return { kind: "not_found" };
    case "forbidden":
      return { kind: "forbidden" };
    case "connection_unavailable":
    case "unsupported_op":
      return { kind: "not_enabled" };
    default:
      return { kind: "unavailable" };
  }
}
