// Gmail `format=full` payload -> readable text (T-063). Walks the MIME tree with hard limits, prefers text/plain,
// falls back to HTML converted to text, skips attachments entirely, and honours `maxChars`. Pure and synchronous: the
// result goes straight into an UntrustedBody and is never stored or logged (rules 6 and 9).
import type { BodyContentType } from "../comms/ephemeral";
import { cut, htmlToText } from "../comms/html-text";

export type GmailPart = {
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};

const MAX_DEPTH = 12;
const MAX_PARTS = 200;

function header(part: GmailPart, name: string): string {
  const h = part.headers?.find((x) => x.name?.toLowerCase() === name);
  return h?.value ?? "";
}

/** Total decoded bytes read across all parts of one message, and the most any single part may add (hostile input). */
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

type Budget = { left: number };

function decodePart(part: GmailPart, budget: Budget, capChars: number): string | null {
  const data = part.body?.data;
  if (typeof data !== "string" || data === "" || budget.left <= 0) return null;
  const maxBytes = Math.min(budget.left, capChars * 4);
  // base64 carries 3 bytes in 4 characters: never decode more than the budget allows.
  const bytes = Buffer.from(data.slice(0, Math.ceil((maxBytes * 4) / 3) + 4), "base64url").subarray(0, maxBytes);
  budget.left -= bytes.length;
  const charset = /charset="?([A-Za-z0-9_.:-]{1,40})"?/i.exec(header(part, "content-type"))?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(bytes).slice(0, capChars);
  } catch {
    return bytes.toString("utf8").slice(0, capChars);
  }
}

export { cut, htmlToText };

/**
 * The message text. Attachments (a filename or attachmentId) and non-text parts are never read. text/plain parts are
 * joined in order; with none, text/html parts are converted. Returns the content type of what was produced.
 */
export function extractText(payload: GmailPart, maxChars: number): { text: string; contentType: BodyContentType; truncated: boolean } {
  const plain: string[] = [];
  const html: string[] = [];
  const budget: Budget = { left: MAX_TOTAL_BYTES };
  // An HTML part is cut before conversion: the text we return is at most maxChars, markup rarely outweighs it 4:1.
  const capChars = Math.min(maxChars * 4, 1_000_000);
  let seen = 0;
  const walk = (part: GmailPart, depth: number): void => {
    if (depth > MAX_DEPTH || ++seen > MAX_PARTS) return;
    const isAttachment = (part.filename ?? "") !== "" || part.body?.attachmentId !== undefined;
    const type = (part.mimeType ?? "").toLowerCase();
    if (!isAttachment && part.parts === undefined) {
      if (type === "text/plain" || (type === "" && depth === 0)) {
        const t = decodePart(part, budget, capChars);
        if (t !== null) plain.push(t);
      } else if (type === "text/html") {
        const t = decodePart(part, budget, capChars);
        if (t !== null) html.push(t);
      }
    }
    for (const child of part.parts ?? []) walk(child, depth + 1);
  };
  walk(payload, 0);
  const useHtml = plain.every((p) => p.trim() === "") && html.length > 0;
  const raw = useHtml ? html.map(htmlToText).join("\n\n") : plain.join("\n\n");
  const normalised = raw.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  const { text, truncated } = cut(normalised, maxChars);
  return { text, contentType: "text/plain", truncated };
}
