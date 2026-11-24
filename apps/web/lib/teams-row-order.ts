// The merge order of the chat rows of several accounts (T-295; spec docs/specs/messages.md 22.5), and the rule that a row is one (account, chat) pair. A plain module: no directive and no server
// import, so the server's merge and the browser's re-read of one account share one definition.
type Ordered = { at: string | null; key: string; ord: number };
type Keyed = { conn: string; key: string };

/** Newest preview first; ties by chat KEY (the encoded chat id: one stable text per chat), then by the order the accounts were connected in (deterministic). Rows without a time are last. */
export function compareRows(a: Ordered, b: Ordered): number {
  // a time that does not parse counts as "no time" (last): NaN would make the order inconsistent
  const time = (x: string | null): number => {
    const t = x === null ? Number.NaN : Date.parse(x);
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  };
  const ta = time(a.at);
  const tb = time(b.at);
  if (ta !== tb) return ta < tb ? 1 : -1;
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  return a.ord - b.ord;
}

/** A row already shown is not drawn twice: rows are keyed by (connection id, chat key), never by the chat alone. The first one wins. */
export function dedupeRows<T extends Keyed>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const id = `${r.conn}\u0000${r.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** The rows after ONE account's rows were read again: its old rows are replaced by the new ones, the others stay, and the whole list is in merge order. */
export function replaceAccountRows<T extends Ordered & Keyed>(current: readonly T[], conn: string, fresh: readonly T[]): T[] {
  return dedupeRows([...current.filter((r) => r.conn !== conn), ...fresh]).sort(compareRows);
}
