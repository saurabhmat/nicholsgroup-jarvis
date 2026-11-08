// Reading the account address out of a Composio tool result (T-219). The shape of `GMAIL_GET_PROFILE` and
// `GOOGLECALENDAR_GET_CURRENT_USER` results is not documented precisely (the live check, H-039, confirms it), so the
// extractor looks only at a short fixed list of keys, at most two levels down, and accepts nothing that is not a plain
// email address. Anything else is "no identity" and the connect is refused (fail closed).
import { z } from "zod";

const EMAIL = z.email().max(320);
const KEYS = ["emailAddress", "email", "email_address", "id"] as const;
const WRAPPERS = ["response_data", "data", "details", "user", "profile"] as const;

function pick(obj: unknown): string | null {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  for (const key of KEYS) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === "string") {
      const parsed = EMAIL.safeParse(v.trim());
      if (parsed.success) return parsed.data.toLowerCase();
    }
  }
  return null;
}

/** The lower-cased address in a tool result's `data`, or null. */
export function extractIdentity(data: unknown): string | null {
  const top = pick(data);
  if (top) return top;
  if (typeof data !== "object" || data === null) return null;
  for (const w of WRAPPERS) {
    const inner = (data as Record<string, unknown>)[w];
    const found = pick(inner);
    if (found) return found;
    if (typeof inner === "object" && inner !== null) {
      for (const w2 of WRAPPERS) {
        const f2 = pick((inner as Record<string, unknown>)[w2]);
        if (f2) return f2;
      }
    }
  }
  return null;
}
