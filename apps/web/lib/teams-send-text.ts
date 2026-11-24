// The text of a Teams message as the browser prepares it (T-288, spec 10.1, 10.3). Plain functions, no directive and no server import: the composer (client) and the tests share them. The rules are the
// server's, written again here ONLY to tell the person early; the server (`normalizeTeamsText`, the connector's Zod schema and the database) decides, and a hash that differs refuses the send.
// Canonical text: line breaks as `\n`, NFC, trimmed. The browser hashes that text (SHA-256, lower-case hex of its UTF-8) and sends the hash with the text; the server normalises the same way and compares.
export const SEND_MAX_CHARS = 10_000;
export const SEND_MAX_BYTES = 80 * 1024;
// No control character except newline and tab (C1 controls too): the same set as the connector's.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

export const normalizeSendText = (raw: string): string => raw.replace(/\r\n?/g, "\n").normalize("NFC").trim();

export type SendTextProblem = "empty" | "too_long" | "too_big" | "control";
/** Why the (raw) text cannot be sent, or null. After normalising, as the server does. */
export function sendTextProblem(raw: string): SendTextProblem | null {
  const t = normalizeSendText(raw);
  if (t === "") return "empty";
  if (CONTROL.test(t)) return "control";
  if (Array.from(t).length > SEND_MAX_CHARS) return "too_long";
  if (new TextEncoder().encode(t).length > SEND_MAX_BYTES) return "too_big";
  return null;
}

/** Characters (code points) of the canonical text, for the counter. */
export const sendCharCount = (raw: string): number => Array.from(normalizeSendText(raw)).length;

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
