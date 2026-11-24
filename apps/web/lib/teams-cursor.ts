// The combined "More chats" cursor (T-295; spec docs/specs/messages.md 22.5): ONE opaque value that says, for each account whose list was read, where its next page starts.
//   base64url of {"v":1,"s":[{"c":<connection id>,"k":<that source's $skiptoken, or "" when it has no more>}, ...]}, at most 5 entries and 6,400 characters.
// It is a NAME, never a permission: on use every `c` is checked again against the person's own usable connections (an entry that fails is dropped), and every `k` is checked for the shape of a
// skip token here and again by the Teams reader, which re-attaches it to `/me/chats` on the Graph host only. Nothing about a chat is in it. Hostile input (not base64url, not JSON, another
// version, too many entries, a foreign or duplicate connection, a token that is not a token) is simply "not a cursor": null. Plain functions, no directive.
import { isConnId } from "./teams-accounts";

export const CURSOR_VERSION = 1;
export const CURSOR_MAX_ENTRIES = 5;
/** The whole encoded value (also the longest `?more=` the page and the chats route accept). */
export const CURSOR_MAX_CHARS = 6_400;
/** One source's skip token: the same rule the single-account cursor always had. */
export const SOURCE_TOKEN = /^[A-Za-z0-9_-]{1,3200}$/;
const ENCODED = /^[A-Za-z0-9_-]{1,6400}$/;

export type CursorEntry = { conn: string; token: string };

const b64urlEncode = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

/** The encoded cursor, or null when there is nothing more to read, an entry is not valid or the value would pass the bounds (then "More chats" is not offered: fail closed). */
export function encodeCursor(entries: readonly { conn: string; token: string | null }[]): string | null {
  const more = entries.filter((e) => e.token !== null);
  if (more.length === 0) return null; // no source has a next page
  if (entries.length < 1 || entries.length > CURSOR_MAX_ENTRIES) return null;
  const s: { c: string; k: string }[] = [];
  for (const e of entries) {
    if (!isConnId(e.conn) || (e.token !== null && !SOURCE_TOKEN.test(e.token))) return null;
    s.push({ c: e.conn, k: e.token ?? "" });
  }
  if (new Set(s.map((x) => x.c)).size !== s.length) return null;
  const out = b64urlEncode(JSON.stringify({ v: CURSOR_VERSION, s }));
  return out.length <= CURSOR_MAX_CHARS ? out : null;
}

/** The entries of a cursor, or null for anything that is not exactly a cursor this module built. */
export function decodeCursor(raw: unknown): CursorEntry[] | null {
  if (typeof raw !== "string" || !ENCODED.test(raw)) return null;
  let parsed: unknown;
  try {
    const text = Buffer.from(raw, "base64url").toString("utf8");
    if (b64urlEncode(text) !== raw) return null; // canonical form only: one value per cursor
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (Object.keys(o).length !== 2 || o.v !== CURSOR_VERSION || !Array.isArray(o.s)) return null;
  if (o.s.length < 1 || o.s.length > CURSOR_MAX_ENTRIES) return null;
  const out: CursorEntry[] = [];
  for (const e of o.s as unknown[]) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) return null;
    const x = e as Record<string, unknown>;
    if (Object.keys(x).length !== 2 || !isConnId(x.c) || typeof x.k !== "string" || (x.k !== "" && !SOURCE_TOKEN.test(x.k))) return null;
    out.push({ conn: x.c, token: x.k });
  }
  if (new Set(out.map((e) => e.conn)).size !== out.length) return null;
  return out;
}

/** The shape of a value in `?more=`: either this module's cursor or (for a person with one account) an old single skip token. Anything longer than the bound is refused before it is decoded. */
export const looksLikeCursor = (v: unknown): v is string => typeof v === "string" && ENCODED.test(v);
