// Parsing of the mail headers the index needs (T-063): From, To, Cc, Subject. Defensive by design: header text comes
// from the sender (rule 9), so every value is stripped of control and bidirectional characters, bounded, and checked
// against the same limits as comms.message_index; anything unusable becomes null / is dropped instead of failing the sync.

/** Same set as the T-062 schemas refuse (controls, line/paragraph separators, bidi controls). */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export function cleanText(s: string): string {
  return s.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
}

function decodeBytes(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

/** RFC 2047 encoded words (`=?utf-8?B?...?=`, `=?iso-8859-1?Q?...?=`) -> text. Adjacent encoded words join without space. */
export function decodeEncodedWords(input: string): string {
  const joined = input.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replace(/=\?([^?\s]{1,40})\?([bBqQ])\?([^?\s]{0,500})\?=/g, (_m, charset: string, enc: string, text: string) => {
    if (enc.toLowerCase() === "b") return decodeBytes(Buffer.from(text, "base64"), charset);
    const bytes: number[] = [];
    const q = text.replace(/_/g, " ");
    for (let i = 0; i < q.length; i++) {
      const c = q[i] as string;
      if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(q.slice(i + 1, i + 3))) {
        bytes.push(parseInt(q.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(...Buffer.from(c, "utf8"));
    }
    return decodeBytes(Buffer.from(bytes), charset);
  });
}

/** Splits an address list on commas that are outside quotes, angle brackets and comments. */
function splitList(list: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i] as string;
    if (quote) {
      cur += c;
      if (c === "\\" && i + 1 < list.length) cur += list[++i] as string;
      else if (c === '"') quote = false;
      continue;
    }
    if (c === '"') quote = true;
    else if (c === "<") angle++;
    else if (c === ">") angle = Math.max(0, angle - 1);
    else if (c === "(") paren++;
    else if (c === ")") paren = Math.max(0, paren - 1);
    if ((c === "," || c === ";") && angle === 0 && paren === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

const ADDR = /^[^\s@<>(),;:"\\]{1,64}@[A-Za-z0-9.-]{1,253}$/;

export type ParsedAddress = { address: string; name?: string };

/** One mailbox (`Name <a@b>`, `"Name" <a@b>`, `a@b`); null when no valid address is found. */
export function parseMailbox(raw: string): ParsedAddress | null {
  const text = raw.slice(0, 2048).trim();
  const angle = /<([^<>]*)>\s*$/.exec(text);
  let address: string;
  let name = "";
  if (angle) {
    address = (angle[1] as string).trim();
    name = text.slice(0, angle.index).trim();
  } else {
    address = text.replace(/\([^()]*\)/g, "").trim();
  }
  address = cleanText(address).toLowerCase();
  if (!ADDR.test(address) || address.length < 3 || address.length > 320) return null;
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  name = cleanText(decodeEncodedWords(name)).slice(0, 200);
  return name !== "" && name.toLowerCase() !== address ? { address, name } : { address };
}

/** Largest raw header text parsed: To/Cc lists 16 KB, a single From 2 KB (the rest is ignored, never scanned). */
export const MAX_LIST_HEADER = 16_384;
export const MAX_SINGLE_HEADER = 2048;

export function parseAddressList(raw: string | undefined, max = 200, rawCap = MAX_LIST_HEADER): ParsedAddress[] {
  if (!raw) return [];
  const out: ParsedAddress[] = [];
  for (const part of splitList(raw.slice(0, rawCap))) {
    const m = parseMailbox(part);
    if (m) out.push(m);
    if (out.length >= max) break;
  }
  return out;
}

/** The subject decoded, cleaned and cut to the table's limit; null when empty. */
export function parseSubject(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const s = cleanText(decodeEncodedWords(raw.slice(0, MAX_SINGLE_HEADER))).slice(0, 998);
  return s === "" ? null : s;
}
