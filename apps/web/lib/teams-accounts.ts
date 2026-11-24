// Several Teams accounts of one person (T-295; spec docs/specs/messages.md 22.4, 22.5). Plain functions, no directive: server and client components and the routes share them.
//   - `isConnId`: the shape of the `conn` the browser names a connection by (the person's own connection id; a NAME, never a permission: every route re-checks it);
//   - `accountLabels`: the short text on each row and in the conversation header when the person has two or more usable accounts. Computed from the person's own sign-in names only, never from
//     chat content. The domain when the accounts are on different domains ("pubkgroup.com", "pub-k.org"), otherwise the part before "@"; the full sign-in name when even that would repeat.
const CONN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A lower-case connection id (an upper-case or otherwise odd spelling is not accepted: one spelling per id). */
export const isConnId = (v: unknown): v is string => typeof v === "string" && CONN_ID.test(v);

/** At iPhone width the badge keeps this many characters, then an ellipsis (the chat title truncates first). */
export const BADGE_MAX_CHARS = 14;

const domainOf = (upn: string): string => upn.slice(upn.lastIndexOf("@") + 1).toLowerCase();
const localOf = (upn: string): string => (upn.includes("@") ? upn.slice(0, upn.lastIndexOf("@")) : upn);
const allDistinct = (xs: readonly string[]): boolean => new Set(xs).size === xs.length;

/** One label per sign-in name, in the same order; distinct whenever the names are distinct. */
export function accountLabels(upns: readonly string[]): string[] {
  const names = upns.map((u) => u.trim().toLowerCase());
  const domains = names.map(domainOf);
  if (allDistinct(domains)) return domains;
  const locals = names.map(localOf);
  if (allDistinct(locals)) return locals;
  return names;
}
