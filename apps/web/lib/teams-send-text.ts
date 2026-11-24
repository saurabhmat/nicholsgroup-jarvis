// The text of a Teams message as the browser prepares it (T-288, spec 10.1, 10.3). Plain functions, no directive and no server import. T-288 review C4: ONE normalisation and ONE validation: the very
// functions the server and the connector use (`@nichols/connectors/teams-pure`, which has no Buffer, no zod and no I/O), so the browser can never disagree with the server about a byte.
// Canonical text: line breaks as `\n`, NFC, trimmed. The browser hashes that text (SHA-256, lower-case hex of its UTF-8) and sends the hash with the text; the server normalises the same way and compares.
import { TEAMS_TEXT_MAX_CHARS, normalizeTeamsText, teamsCodePoints, teamsTextProblemCode } from "@nichols/connectors/teams-pure";

export const SEND_MAX_CHARS = TEAMS_TEXT_MAX_CHARS;
export const normalizeSendText = normalizeTeamsText;

export type SendTextProblem = "empty" | "too_long" | "too_big" | "control" | "malformed";
/** Why the (raw) text cannot be sent, or null. After normalising, as the server does. */
export function sendTextProblem(raw: string): SendTextProblem | null {
  const c = teamsTextProblemCode(normalizeTeamsText(raw));
  return c === null ? null : c === "not_text" || c === "not_normalised" || c === "spaces" ? "malformed" : c;
}

/** Characters (code points) of the canonical text, for the counter. */
export const sendCharCount = (raw: string): number => teamsCodePoints(normalizeTeamsText(raw));

/** SHA-256 of the canonical text, lower-case hex. Null when this browser cannot hash (no Web Crypto): the send is then not attempted. */
export async function sendTextHash(canonical: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** A new request id for one composed message (a lower-case v4 UUID). Null when the browser has no way to make one. */
export function newRequestId(): string | null {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return null;
}
