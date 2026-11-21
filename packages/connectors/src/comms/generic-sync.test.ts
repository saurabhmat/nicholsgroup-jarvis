// T-255: the sync runs and the index twin are generic over the provider (log names by provider; a Microsoft connection is accepted by the
// twin like the SQL writers of T-252 / T-253 accept it). Synthetic data only (rule 10): a stub provider, no network.
import { describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import type { Connection } from "../contract/schemas";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { createGoogleHarness, HARNESS_OWNER_ID } from "../testing/google-harness";
import { createFakeGoogle } from "../testing/msw/google/handlers";
import { createCalendarSync } from "./cal-sync";
import { createMailSync } from "./mail-sync";
import type { CalendarProvider, MailProvider } from "./provider";
import type { CalendarSyncResult, MailSyncResult } from "./schemas";

const ID = "00000000-0000-4000-8000-000000000f01";
const conn = (provider: "google" | "microsoft") =>
  mintLaneBoundConnection<"google" | "microsoft">({ id: ID, lane_id: "PKG", provider, external_account_id: "a@example.test", status: "active", features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null, owner_user_id: HARNESS_OWNER_ID } as Connection<"google" | "microsoft">);
const page = { upserts: [], removals: [], nextCursor: { value: `m1.${ID}.m:x` }, hasMore: false, fullResyncRequired: false } as unknown as MailSyncResult;
const calPage = { upserts: [], removals: [], nextCursor: { value: `m1.${ID}.c:x` }, hasMore: false, fullResyncRequired: false } as unknown as CalendarSyncResult;
const counts = { removed: 0, written: 0, skipped: 0, conflict: false };

function stores() {
  const store = { async getCursor() { return null; }, async resetCursor() {}, async applyPage() { return counts; } };
  return store;
}

describe("generic mail and calendar runs", () => {
  it("a Microsoft mail run uses the Microsoft provider and logs under its name", async () => {
    const entries: LogEntry[] = [];
    const calls: string[] = [];
    const mail = { provider: "microsoft", async sync() { calls.push("sync"); return page; } } as unknown as MailProvider<"microsoft">;
    const run = createMailSync({ mail, store: stores(), logger: createConnectorLogger({ sink: (e) => entries.push(e) }) });
    await expect(run.run("PKG", conn("microsoft") as never)).resolves.toMatchObject({ mode: "full", pages: 1 });
    expect(calls).toEqual(["sync"]);
    expect(JSON.stringify(entries)).toContain("microsoft.mail.sync_done");
    expect(JSON.stringify(entries)).not.toContain("google.");
  });

  it("a Microsoft calendar run logs under its name", async () => {
    const entries: LogEntry[] = [];
    const calendar = { provider: "microsoft", async sync() { return calPage; } } as unknown as CalendarProvider<"microsoft">;
    await createCalendarSync({ calendar, store: stores(), logger: createConnectorLogger({ sink: (e) => entries.push(e) }) }).run("PKG", conn("microsoft") as never);
    expect(JSON.stringify(entries)).toContain("microsoft.calendar.sync_done");
  });

  it("a run refuses a connection of another provider before the store or the provider is touched", async () => {
    const calls: string[] = [];
    const store = { ...stores(), async getCursor() { calls.push("store"); return null; } };
    const mail = { provider: "microsoft", async sync() { calls.push("sync"); return page; } } as unknown as MailProvider<"microsoft">;
    await expect(createMailSync({ mail, store }).run("PKG", conn("google") as never)).rejects.toBeInstanceOf(ConnectorError);
    const calendar = { provider: "google", async sync() { calls.push("sync"); return calPage; } } as unknown as CalendarProvider<"google">;
    await expect(createCalendarSync({ calendar, store }).run("PKG", conn("microsoft") as never)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(calls).toEqual([]);
  });
});

describe("the TypeScript index twin (testing/google-harness.ts) accepts both providers", () => {
  it("applies a mail page and a calendar page for a Microsoft connection, and still refuses a connection that is not usable", async () => {
    const h = createGoogleHarness({ fake: createFakeGoogle(), mailboxes: { PKG: [] } });
    const row = { id: ID, lane_id: "PKG", provider: "microsoft" as never, external_account_id: "a@example.test", status: "active" as const, features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null, owner_user_id: HARNESS_OWNER_ID };
    h.rows.set(ID, row as never);
    const bound = h.bind(row as never) as never;
    await expect(h.store.applyPage("PKG", bound, page, { expected: null })).resolves.toMatchObject({ conflict: false });
    await expect(h.calStore.applyPage("PKG", bound, calPage, { expected: null })).resolves.toMatchObject({ conflict: false });
    row.status = "reconnect_required" as never;
    await expect(h.store.applyPage("PKG", bound, page, { expected: page.nextCursor })).rejects.toMatchObject({ info: { kind: "forbidden" } });
    row.status = "active";
    (row as { provider: string }).provider = "quickbooks";
    await expect(h.store.applyPage("PKG", bound, page, { expected: page.nextCursor })).rejects.toMatchObject({ info: { kind: "forbidden" } });
  });
});
