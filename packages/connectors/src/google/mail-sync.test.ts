// The sync run (T-063): pages applied atomically with their cursor, removals before upserts, stale versions skipped, a
// failed provider call never advances the stored cursor, an expired cursor reloads from scratch, and the persisted rows
// hold metadata only. The index here is the in-memory twin of core.comms_mail_apply_page (pinned by pgTAP 160).
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { createGoogleHarness } from "../testing/google-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeGoogle, GOOGLE_BODY_CANARY, GOOGLE_SNIPPET_CANARY, seedMessage } from "../testing/msw/google/handlers";
import { createMailSync } from "./mail-sync";
import type { MailProvider } from "../comms/provider";

const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
});
const EXEC = "exec@pubkgroup.example.test";

function setup() {
  const fake = createFakeGoogle();
  server.use(...fake.handlers);
  const h = createGoogleHarness({ fake, mailboxes: { PKG: [EXEC] } });
  const { row, account } = h.connectGoogle("PKG", EXEC);
  return { fake, h, conn: h.bind(row), account, row };
}
const rowsOf = (h: ReturnType<typeof setup>["h"]) => [...h.index.values()];

describe("sync run", () => {
  it("loads the mailbox on the first run, stores the cursor, and is quiet on the second", async () => {
    const { h, conn, row } = setup();
    const first = await h.sync.run("PKG", conn);
    expect(first).toMatchObject({ mode: "full", written: 5, removed: 0, resynced: false });
    expect(rowsOf(h)).toHaveLength(5);
    expect(h.cursors.get(`PKG\u0000${conn.id}`)).toMatch(new RegExp(`^g1\\.${conn.id}\\.h:\\d+$`));
    expect(row.last_sync_at).not.toBeNull();
    const second = await h.sync.run("PKG", conn);
    expect(second).toMatchObject({ mode: "incremental", written: 0, removed: 0 });
  });

  it("pages (pageSize 2) with the cursor stored after every page", async () => {
    const { h, conn } = setup();
    const sync = createMailSync({ mail: h.mail, store: h.store, pageSize: 2 });
    const r = await sync.run("PKG", conn);
    expect(r.pages).toBe(3);
    expect(r.written).toBe(5);
    expect(h.indexStats.applies).toBe(3);
  });

  it("applies deletions and label changes on the next run and keeps a removed row flagged, not deleted", async () => {
    const { fake, h, conn, account } = setup();
    await h.sync.run("PKG", conn);
    const gone = fake.removeMessage(account);
    const second = seedMessage(2, EXEC).id;
    fake.relabel(account, second, ["INBOX", "STARRED"]);
    const added = fake.addMessage(account);
    const r = await h.sync.run("PKG", conn);
    expect(r).toMatchObject({ removed: 1, written: 2 });
    const byId = new Map(rowsOf(h).map((x) => [x.message_id, x]));
    expect(byId.get(gone)?.deleted).toBe(true);
    expect(byId.get(second)).toMatchObject({ is_starred: true, deleted: false });
    expect(byId.get(added)?.deleted).toBe(false);
    expect(byId.size).toBe(6);
  });

  it("a provider failure leaves the stored cursor untouched and the next run picks the change up", async () => {
    const { fake, h, conn, account } = setup();
    await h.sync.run("PKG", conn);
    const cursor = h.cursors.get(`PKG\u0000${conn.id}`);
    const added = fake.addMessage(account);
    fake.setFault(account, "server_error", 2);
    await expect(h.sync.run("PKG", conn)).rejects.toMatchObject({ info: { kind: "transient" } });
    expect(h.cursors.get(`PKG\u0000${conn.id}`)).toBe(cursor);
    const r = await h.sync.run("PKG", conn);
    expect(r.written).toBe(1);
    expect(h.index.get(`PKG\u0000${conn.id}\u0000${added}`)).toBeDefined();
  });

  it("an expired history discards the cursor and reloads everything", async () => {
    const { fake, h, conn, account } = setup();
    await h.sync.run("PKG", conn);
    fake.expireHistory(account);
    fake.addMessage(account);
    const r = await h.sync.run("PKG", conn);
    expect(r).toMatchObject({ mode: "full", resynced: true, written: 6 });
    expect(h.indexStats.resets).toBe(1);
    expect(h.cursors.get(`PKG\u0000${conn.id}`)).toMatch(/\.h:\d+$/);
  });

  it("the persisted rows hold metadata only: no body, snippet or preview anywhere in what was written", async () => {
    const { h, conn } = setup();
    await h.sync.run("PKG", conn);
    const text = JSON.stringify(h.writes) + JSON.stringify(rowsOf(h));
    expect(text).not.toContain(GOOGLE_SNIPPET_CANARY);
    expect(text).not.toContain(GOOGLE_BODY_CANARY);
    expect(h.contentWriteCount()).toBe(0);
    for (const r of rowsOf(h)) expect(Object.keys(r)).not.toEqual(expect.arrayContaining(["snippet"]));
  });

  it("another provider's or another lane's connection cannot be synced", async () => {
    const { h } = setup();
    const foreign = await h.contractHarness().connectForeignProvider();
    await expect(h.sync.run("PKG", foreign as never)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    const otherLane = h.bind(h.connectGoogle("APK", "apk@apk.example.test").row);
    await expect(h.sync.run("PKG", otherLane)).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
    expect(h.index.size).toBe(0);
  });

  it("a concurrent run that moved the cursor first wins: this run stops without applying and reports the conflict", async () => {
    const { fake, h, conn, account } = setup();
    await h.sync.run("PKG", conn);
    const key = `PKG\u0000${conn.id}`;
    const stored = h.cursors.get(key);
    fake.addMessage(account);
    const racing = createMailSync({
      mail: h.mail,
      store: {
        ...h.store,
        applyPage: async (...args) => {
          h.cursors.set(key, "g1.other-run.h:1"); // the other run commits between our read and our write
          return h.store.applyPage(...args);
        },
      },
    });
    const r = await racing.run("PKG", conn);
    expect(r.conflict).toBe(true);
    expect(r.written).toBe(0);
    expect(h.cursors.get(key)).toBe("g1.other-run.h:1");
    expect(h.cursors.get(key)).not.toBe(stored);
  });

  it("applyPage from a stale cursor writes nothing", async () => {
    const { h, conn } = setup();
    await h.sync.run("PKG", conn);
    const before = h.index.size;
    const counts = await h.store.applyPage("PKG", conn, { upserts: [], removals: [{ message_id: seedMessage(1, EXEC).id }], nextCursor: { value: "g1.x.h:9" }, hasMore: false, fullResyncRequired: false }, { expected: { value: "stale" } });
    expect(counts.conflict).toBe(true);
    expect(h.index.size).toBe(before);
    expect([...h.index.values()].some((r) => r.deleted)).toBe(false);
  });

  it("asks for at most one resync per run", async () => {
    const { h, conn } = setup();
    await h.sync.run("PKG", conn);
    const always: MailProvider<"google"> = { ...h.mail, sync: async () => ({ upserts: [], removals: [], nextCursor: null, hasMore: false, fullResyncRequired: true }) };
    await expect(createMailSync({ mail: always, store: h.store }).run("PKG", conn)).rejects.toMatchObject({ info: { kind: "provider_error" } });
    expect(h.indexStats.resets).toBe(1);
  });

  it("a trashed message is flagged deleted and comes back when untrashed (fresh page revives)", async () => {
    const { fake, h, conn, account } = setup();
    await h.sync.run("PKG", conn);
    const id = seedMessage(3, EXEC).id;
    const key = `PKG\u0000${conn.id}\u0000${id}`;
    fake.relabel(account, id, ["TRASH"]);
    await h.sync.run("PKG", conn);
    expect(h.index.get(key)?.deleted).toBe(true);
    fake.relabel(account, id, ["INBOX"]);
    await h.sync.run("PKG", conn);
    expect(h.index.get(key)?.deleted).toBe(false);
  });
});
