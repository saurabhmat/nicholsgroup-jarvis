// The mail index store (T-063) over core.comms_mail_apply_page / sync_cursor_*: lane-bound, metadata re-validated, RPC
// arguments exact, database messages never passed on. The functions themselves are pinned by pgTAP 160.
import { describe, expect, it, vi } from "vitest";
import type { MailSyncResult, MessageMeta } from "../comms/schemas";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import type { Connection } from "../contract/schemas";
import { createMailIndexStore } from "./mail-store";

const row: Connection<"google"> = {
  id: "00000000-0000-4000-8000-000000000631",
  lane_id: "PKG",
  provider: "google",
  external_account_id: "exec@pubkgroup.example.test",
  status: "active",
  features: {},
  features_checked_at: null,
  token_expires_at: null,
  last_sync_at: null,
  last_error: null,
};
const conn = mintLaneBoundConnection<"google">(row);
const meta = (id: string): MessageMeta => ({
  message_id: id,
  thread_id: "t1",
  source_url: "https://mail.example.test/m",
  from_address: "a@example.test",
  from_name: null,
  to_recipients: [],
  cc_recipients: [],
  subject: "S",
  received_at: "2026-10-01T12:00:00.000Z",
  is_read: true,
  is_starred: false,
  is_important: false,
  has_attachments: false,
  folder: "INBOX",
  labels: ["INBOX"],
  source_updated_at: "2026-10-01T12:00:00.000Z",
});
const page = (over: Partial<MailSyncResult> = {}): MailSyncResult => ({ upserts: [meta("m1")], removals: [{ message_id: "m0" }], nextCursor: { value: "g1.x.h:1" }, hasMore: false, fullResyncRequired: false, ...over });

function fake(result: { data?: unknown; error?: { code?: string; message?: string } | null } | (() => never)) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const schema = { rpc: async (fn: string, args: Record<string, unknown>) => (calls.push({ fn, args }), typeof result === "function" ? result() : { data: result.data ?? null, error: result.error ?? null }) };
  const clientFor = vi.fn(async () => ({ schema: () => schema }) as never);
  return { calls, clientFor };
}
const NONE = { expected: null } as const;
const kind = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { info?: { kind?: string; message?: string } }).info;
  }
  return null;
};

describe("applyPage", () => {
  it("sends exactly lane, connection, removal ids, metadata, cursor and the completion flag", async () => {
    const { calls, clientFor } = fake({ data: { removed: 1, written: 1, skipped: 0 } });
    const counts = await createMailIndexStore(clientFor).applyPage("PKG", conn, page(), { expected: { value: "g1.x.h:0" }, complete: true, revive: true });
    expect(counts).toEqual({ removed: 1, written: 1, skipped: 0, conflict: false });
    expect(clientFor).toHaveBeenCalledWith("PKG");
    expect(calls).toEqual([
      { fn: "comms_mail_apply_page", args: { p_lane: "PKG", p_connection_id: row.id, p_removals: ["m0"], p_upserts: [meta("m1")], p_expected_cursor: "g1.x.h:0", p_cursor: "g1.x.h:1", p_complete: true, p_revive: true } },
    ]);
  });

  it("refuses a record with a body-like extra field before any call (strict metadata)", async () => {
    const { calls, clientFor } = fake({ data: {} });
    const bad = { ...meta("m1"), snippet: "hello" } as unknown as MessageMeta;
    await expect(createMailIndexStore(clientFor).applyPage("PKG", conn, page({ upserts: [bad] }), NONE)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("refuses a resync answer, an oversized page, a forged connection and another lane's connection", async () => {
    const { calls, clientFor } = fake({ data: {} });
    const store = createMailIndexStore(clientFor);
    expect((await kind(store.applyPage("PKG", conn, page({ fullResyncRequired: true, nextCursor: null, upserts: [], removals: [] }), NONE)))?.kind).toBe("invalid_input");
    expect((await kind(store.applyPage("PKG", conn, page({ upserts: Array.from({ length: 20_001 }, (_v, i) => meta(`m${String(i)}`)) }), NONE)))?.kind).toBe("invalid_input");
    expect((await kind(store.applyPage("PKG", { ...conn } as never, page(), NONE)))?.kind).toBe("lane_mismatch");
    expect((await kind(store.applyPage("APK", conn, page(), NONE)))?.kind).toBe("lane_mismatch");
    expect(calls).toEqual([]);
  });

  it("maps database errors to fixed messages and never passes the database text on", async () => {
    for (const [code, expected] of [["42501", "forbidden"], ["23514", "invalid_input"], ["22023", "invalid_input"], ["57014", "transient"]] as const) {
      const { clientFor } = fake({ error: { code, message: "secret row detail: subject=Quarterly layoffs" } });
      const info = await kind(createMailIndexStore(clientFor).applyPage("PKG", conn, page(), NONE));
      expect(info?.kind).toBe(expected);
      expect(info?.message).not.toContain("layoffs");
    }
  });

  it("cuts a large page into chunks of 500 in order and puts the cursor and the completion flag on the last chunk only", async () => {
    const { calls, clientFor } = fake({ data: { removed: 0, written: 500, skipped: 0 } });
    const ups = Array.from({ length: 1200 }, (_v, i) => meta(`m${String(i)}`));
    const counts = await createMailIndexStore(clientFor).applyPage("PKG", conn, page({ upserts: ups, removals: [] }), { expected: { value: "g1.x.h:0" }, complete: true });
    expect(calls.map((c) => (c.args.p_upserts as unknown[]).length)).toEqual([500, 500, 200]);
    expect(calls.map((c) => c.args.p_cursor)).toEqual([null, null, "g1.x.h:1"]);
    expect(calls.map((c) => c.args.p_complete)).toEqual([false, false, true]);
    expect(calls.every((c) => c.args.p_expected_cursor === "g1.x.h:0")).toBe(true);
    expect((calls[0]?.args.p_upserts as { message_id: string }[])[0]?.message_id).toBe("m0");
    expect((calls[2]?.args.p_upserts as { message_id: string }[])[0]?.message_id).toBe("m1000");
    expect(counts.written).toBe(1500);
  });

  it("a cursor conflict is an outcome, not an error: the run stops and later chunks are not sent", async () => {
    const { calls, clientFor } = fake({ error: { code: "D0409", message: "the stored cursor moved" } });
    const ups = Array.from({ length: 600 }, (_v, i) => meta(`m${String(i)}`));
    const counts = await createMailIndexStore(clientFor).applyPage("PKG", conn, page({ upserts: ups }), NONE);
    expect(counts.conflict).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("data errors (class 22 and 23) are invalid_input, never transient", async () => {
    for (const code of ["22P02", "22001", "23505", "23514", "22023"]) {
      const { clientFor } = fake({ error: { code } });
      expect((await kind(createMailIndexStore(clientFor).applyPage("PKG", conn, page(), NONE)))?.kind, code).toBe("invalid_input");
    }
  });

  it("an unreachable lane client is connection_unavailable", async () => {
    const info = await kind(createMailIndexStore(async () => Promise.reject(new Error("no lane")) as never).applyPage("PKG", conn, page(), NONE));
    expect(info?.kind).toBe("connection_unavailable");
  });
});

describe("cursors", () => {
  it("getCursor returns the stored text or null; resetCursor calls the reset function", async () => {
    const a = fake({ data: "g1.x.h:9" });
    expect(await createMailIndexStore(a.clientFor).getCursor("PKG", conn)).toEqual({ value: "g1.x.h:9" });
    expect(a.calls[0]).toEqual({ fn: "sync_cursor_get", args: { p_lane: "PKG", p_connection_id: row.id, p_stream: "mail" } });
    expect(await createMailIndexStore(fake({ data: null }).clientFor).getCursor("PKG", conn)).toBeNull();
    const b = fake({ data: true });
    await createMailIndexStore(b.clientFor).resetCursor("PKG", conn);
    expect(b.calls[0]?.fn).toBe("sync_cursor_reset");
  });
});
