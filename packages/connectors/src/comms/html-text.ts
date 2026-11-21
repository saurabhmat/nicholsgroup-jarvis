// HTML -> text and the text cut, shared by the live body readers (Gmail's MIME walker, Microsoft's body read, T-259). Moved verbatim from
// google/mime.ts so the Microsoft code imports no Google code. Pure and linear; the result is never stored or logged (rules 6 and 9).

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

