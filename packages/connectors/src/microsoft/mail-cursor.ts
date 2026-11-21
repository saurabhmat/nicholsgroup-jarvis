// The composite cursor of the Microsoft mail sync (T-258, spec §8.1): `m1.<connection id>.m:<base64url JSON>` with
// `{ v: 1, folders: [{ name, id, delta?|next?, since }], pos, fp }`.
//  - `folders` (1..3, the lane's well-known folders in config order): `id` is the folder's Graph id (resolved once; the delta URL needs it),
//    `next` the link of the page in progress, `delta` the finished delta link, `since` the start of the window (older messages are dropped by
//    the mapper). At most one link per folder; none = the folder has not been started.
//  - `pos`: the folder being read; one Graph page per sync call. `fp`: a fingerprint of the configured folders; a change means a fresh discovery.
//  - Links are OPAQUE ("save and apply the entire link"): stored and sent back unchanged, never rebuilt or truncated. But a link is used only
//    after `validateDeltaLink`: its origin is the cloud's Graph origin and its path is exactly the delta path of the folder id held in the cursor;
//    anything else is a malformed cursor (`fullResyncRequired`), never followed to another host or path.
//  - Bounds: a link at most MAX_LINK_CHARS, a folder id at most MAX_FOLDER_ID_CHARS; with 3 folders the largest state encodes well under the
//    table's 16 KB. A state that would not fit is refused (`encodeCursor` returns null: the caller fails safe with a resync), never cut.
// The cursor carries no token (links hold Graph's own opaque paging/delta state, no credential).
import { z } from "zod";
import { CommsCursorSchema, type CommsCursor } from "../comms/schemas";
import { InstantSchema } from "../contract/schemas";
import { isOpaqueQuery } from "./api";
import { GRAPH_COMMERCIAL_BASE } from "./constants";

export const MAIL_FOLDER_NAMES = ["inbox", "sentitems", "archive"] as const;
export type MailFolderName = (typeof MAIL_FOLDER_NAMES)[number];
/** The canonical `folder` values the readers know (`INBOX`, `SENT`; spec §8.2). */
export const CANONICAL_FOLDER: Readonly<Record<MailFolderName, string>> = Object.freeze({ inbox: "INBOX", sentitems: "SENT", archive: "ARCHIVE" });

/** Our bounds for what the documentation leaves open (V-11, V-12). A real link or id above them fails safe. */
export const MAX_LINK_CHARS = 2800;
export const MAX_FOLDER_ID_CHARS = 256;
/** The cursor table's limit (`CommsCursorSchema`). */
export const MAX_CURSOR_CHARS = 16_384;
const FOLDER_ID = new RegExp(`^[A-Za-z0-9_=+.-]{1,${String(MAX_FOLDER_ID_CHARS)}}$`);
export const isFolderId = (v: unknown): v is string => typeof v === "string" && FOLDER_ID.test(v);

export type FolderState = { name: MailFolderName; id: string; delta?: string; next?: string; since: string };
export type CursorState = { v: 1; folders: FolderState[]; pos: number; fp: string };

export const cursorPrefix = (connectionId: string): string => `m1.${connectionId}.m:`;

/** Fingerprint of the configured folders (order does not matter): a change means a fresh discovery and a full load of new folders. */
export const fingerprintOf = (names: readonly string[]): string => [...new Set(names)].sort().join(",");

const BASE = new URL(GRAPH_COMMERCIAL_BASE);

/**
 * The query of a delta or next link when it may be used for this folder, else null. Valid = the string starts with the cloud's exact Graph
 * origin, the path (taken from the raw text, not from a parsed URL) is the delta path of `folderId` (`/v1.0/me/mailFolders/{id}/messages/delta`,
 * or the OData key form `/v1.0/me/mailFolders('{id}')/messages/delta`, whose id is compared after decoding), there is no fragment, and the query is
 * non-empty, in the URL character set and within the length bound.
 */
export function validateDeltaLink(link: unknown, folderId: string, base: URL = BASE): { query: string } | null {
  if (typeof link !== "string" || link.length === 0 || link.length > MAX_LINK_CHARS || !/^[\x21-\x7e]+$/.test(link) || link.includes("#")) return null;
  const q = link.indexOf("?");
  if (q < 0) return null;
  const head = link.slice(0, q);
  const query = link.slice(q + 1);
  if (query === "" || !isOpaqueQuery(query)) return null;
  const origin = base.origin;
  if (!head.startsWith(`${origin}/`)) return null;
  const segments = head.slice(origin.length).split("/");
  const basePath = base.pathname.replace(/\/+$/, "").split("/"); // ["", "v1.0"]
  const at = basePath.length;
  if (segments.length < at + 4) return null;
  if (!basePath.every((s, i) => segments[i] === s) || segments[at] !== "me") return null;
  const rest = segments.slice(at + 1);
  let id: string | null = null;
  try {
    if (rest.length === 4 && rest[0] === "mailFolders" && rest[2] === "messages" && rest[3] === "delta") id = decodeURIComponent(rest[1] as string);
    else if (rest.length === 3 && rest[1] === "messages" && rest[2] === "delta") {
      const m = /^mailFolders\('([^']*)'\)$/.exec(decodeURIComponent(rest[0] as string));
      id = m ? (m[1] as string) : null;
    }
  } catch {
    return null;
  }
  return id !== null && id === folderId ? { query } : null;
}

const link = z.string().min(1).max(MAX_LINK_CHARS);
const FolderSchema = z.strictObject({
  name: z.enum(MAIL_FOLDER_NAMES),
  id: z.string().regex(FOLDER_ID),
  delta: link.optional(),
  next: link.optional(),
  since: InstantSchema,
});
const StateSchema = z.strictObject({
  v: z.literal(1),
  folders: z.array(FolderSchema).min(1).max(3),
  pos: z.int().min(0).max(2),
  fp: z.string().min(1).max(64),
});

/**
 * The cursor's state when it is well-formed AND belongs to this connection AND every stored link passes `validateDeltaLink` for its own
 * folder; null otherwise (the caller answers `fullResyncRequired`). Never throws.
 */
export function parseCursor(value: string, connectionId: string): CursorState | null {
  const prefix = cursorPrefix(connectionId);
  if (value.length > MAX_CURSOR_CHARS || !value.startsWith(prefix)) return null;
  const encoded = value.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{1,16384}$/.test(encoded)) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = StateSchema.safeParse(json);
  if (!parsed.success) return null;
  const s = parsed.data;
  if (s.pos >= s.folders.length || new Set(s.folders.map((f) => f.name)).size !== s.folders.length) return null;
  for (const f of s.folders) {
    if (f.delta !== undefined && f.next !== undefined) return null;
    const l = f.next ?? f.delta;
    if (l !== undefined && validateDeltaLink(l, f.id) === null) return null;
  }
  return s as CursorState;
}

/** The cursor for a state, or null when it would not fit the 16 KB limit (the caller fails safe: a resync, never a cut link). */
export function encodeCursor(connectionId: string, state: CursorState): CommsCursor | null {
  const value = `${cursorPrefix(connectionId)}${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`;
  return CommsCursorSchema.safeParse({ value }).success ? { value } : null;
}
