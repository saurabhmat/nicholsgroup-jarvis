// In-memory twin of the mail index writer (`core.comms_mail_apply_page`, T-252) for the provider-generic sync tests (T-258). It keeps the SQL's rules:
// the connection is usable and of provider `google` or `microsoft`; the new cursor must start with `g1.<id>.` (google) or `m1.<id>.m:` (microsoft) and be at
// most 16384 characters; removals first (with a folder, only a stored row in that folder is flagged deleted); an upsert replaces a row only when
// its source_updated_at is not older; an absent flag keeps the stored value on update and is false on insert; the cursor is stored with the page, all
// or nothing; a page applies only when the stored cursor is the expected one. pgTAP 160 / 321 pin the real function.
// Every write is recorded (`writes`), so a test can prove what reached the store and that nothing touched another connection.
import { ConnectorError } from "../contract/errors";
import { assertLaneBound } from "../contract/lane-bound";
import type { ApplyCounts } from "../comms/index-rpc";
import type { MailIndexStore } from "../comms/mail-store";
import type { MailSyncResult, MessageMeta } from "../comms/schemas";

export type TwinIndexRow = MessageMeta & { deleted: boolean; connection_id: string; lane_id: string };
const FLAGS = ["is_read", "is_starred", "is_important", "has_attachments", "is_bulk", "is_calendar", "is_auto", "is_generated", "is_auth_pass"] as const;

export function createMailIndexTwin(deps: { rowOf: (laneId: string, conn: { id: string }) => { provider: string; status: string } }) {
  const rows = new Map<string, TwinIndexRow>();
  const cursors = new Map<string, string>();
  const writes: { store: string; connectionId: string; value: unknown }[] = [];
  const stats = { applies: 0, resets: 0 };
  const rk = (laneId: string, connectionId: string, messageId: string) => `${laneId}\u0000${connectionId}\u0000${messageId}`;
  const ck = (laneId: string, connectionId: string) => `${laneId}\u0000${connectionId}`;

  const store: MailIndexStore = {
    async getCursor(laneId, conn) {
      assertLaneBound(laneId, conn);
      const v = cursors.get(ck(laneId, conn.id));
      return v === undefined ? null : { value: v };
    },
    async resetCursor(laneId, conn) {
      assertLaneBound(laneId, conn);
      stats.resets += 1;
      writes.push({ store: "cursors", connectionId: conn.id, value: "reset" });
      cursors.delete(ck(laneId, conn.id));
    },
    async applyPage(laneId, conn, page: MailSyncResult, opts): Promise<ApplyCounts> {
      assertLaneBound(laneId, conn);
      const row = deps.rowOf(laneId, conn);
      if (!["google", "microsoft"].includes(row.provider) || !["active", "degraded"].includes(row.status)) throw new ConnectorError({ kind: "forbidden", message: "Mail index access refused" });
      if (page.nextCursor === null) throw new ConnectorError({ kind: "invalid_input", message: "A resync answer is not a page" });
      const stored = cursors.get(ck(laneId, conn.id)) ?? null;
      if (stored !== (opts.expected?.value ?? null)) return { removed: 0, written: 0, skipped: 0, conflict: true };
      const prefix = row.provider === "google" ? `g1.${conn.id}.` : `m1.${conn.id}.m:`;
      if (!page.nextCursor.value.startsWith(prefix) || page.nextCursor.value.length > 16_384) throw new ConnectorError({ kind: "invalid_input", message: "A mail sync page or record was refused by the index" });
      stats.applies += 1;
      writes.push({ store: "message_index", connectionId: conn.id, value: { upserts: page.upserts, removals: page.removals } });
      writes.push({ store: "cursors", connectionId: conn.id, value: page.nextCursor.value });
      let removed = 0;
      for (const r of page.removals) {
        const hit = rows.get(rk(laneId, conn.id, r.message_id));
        if (hit && !hit.deleted && (r.folder === undefined || r.folder === hit.folder)) {
          hit.deleted = true;
          removed += 1;
        }
      }
      const last = new Map(page.upserts.map((m) => [m.message_id, m]));
      let written = 0;
      for (const m of last.values()) {
        const k = rk(laneId, conn.id, m.message_id);
        const hit = rows.get(k);
        const newer = !hit || hit.source_updated_at === null || (m.source_updated_at !== null && m.source_updated_at >= hit.source_updated_at);
        if (!newer) continue;
        const flags = Object.fromEntries(FLAGS.map((f) => [f, m[f] ?? hit?.[f] ?? false]));
        rows.set(k, { ...m, ...flags, deleted: opts.revive === true ? false : (hit?.deleted ?? false), connection_id: conn.id, lane_id: laneId });
        written += 1;
      }
      cursors.set(ck(laneId, conn.id), page.nextCursor.value);
      return { removed, written, skipped: last.size - written, conflict: false };
    },
  };

  return {
    store,
    rows,
    cursors,
    writes,
    stats,
    cursorOf: (laneId: string, connectionId: string) => cursors.get(ck(laneId, connectionId)),
    rowsOf: (connectionId: string) => [...rows.values()].filter((r) => r.connection_id === connectionId),
    /** Test setup: a row and a cursor that exist before the code under test runs (not recorded as a write). */
    seed(laneId: string, connectionId: string, rowsIn: TwinIndexRow[], cursor: string) {
      for (const r of rowsIn) rows.set(rk(laneId, connectionId, r.message_id), r);
      cursors.set(ck(laneId, connectionId), cursor);
    },
  };
}
export type MailIndexTwin = ReturnType<typeof createMailIndexTwin>;
