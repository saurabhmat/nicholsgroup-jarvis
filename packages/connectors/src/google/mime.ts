// Gmail `format=full` payload -> readable text (T-063). Walks the MIME tree with hard limits, prefers text/plain,
// falls back to HTML converted to text, skips attachments entirely, and honours `maxChars`. Pure and synchronous: the
// result goes straight into an UntrustedBody and is never stored or logged (rules 6 and 9).
import type { BodyContentType } from "../comms/ephemeral";

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

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "..." };

const BLOCKS = ["script", "style", "head", "title"] as const;

/**
 * Removes comments and script/style/head/title blocks in ONE linear pass (indexOf only, no backtracking regex): an
 * unclosed block or comment drops the rest of the input. Other markup is left for the tag stripper.
 */
function stripBlocks(html: string): string {
  const out: string[] = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const j = html.indexOf("<", i);
    if (j < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, j));
    if (html.startsWith("<!--", j)) {
      const k = html.indexOf("-->", j + 4);
      out.push(" ");
      i = k < 0 ? n : k + 3;
      continue;
    }
    const head = html.slice(j + 1, j + 8).toLowerCase();
    const tag = BLOCKS.find((t) => head.startsWith(t) && !/[a-z0-9]/.test(head.charAt(t.length)));
    if (tag) {
      let k = html.indexOf("</", j + 1);
      while (k >= 0 && html.slice(k + 2, k + 2 + tag.length).toLowerCase() !== tag) k = html.indexOf("</", k + 2);
      const close = k < 0 ? -1 : html.indexOf(">", k);
      out.push(" ");
      i = close < 0 ? n : close + 1;
      continue;
    }
    out.push("<");
    i = j + 1;
  }
  return out.join("");
}

/** Minimal, safe HTML -> text: drops script/style/head, turns block ends into line breaks, strips tags, decodes entities. All steps are linear. */
export function htmlToText(html: string): string {
  const text = stripBlocks(html)
    .replace(/<\s{0,8}br\s{0,8}\/?>/gi, "\n")
    .replace(/<\/\s{0,8}(p|div|li|tr|h[1-6]|blockquote|table)\s{0,8}>/gi, "\n")
    .replace(/<[^<>]*>/g, " ")
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : " ";
      }
      return NAMED[e.toLowerCase()] ?? m;
    });
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cuts at `max` UTF-16 units without leaving half of a surrogate pair. */
export function cut(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

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
