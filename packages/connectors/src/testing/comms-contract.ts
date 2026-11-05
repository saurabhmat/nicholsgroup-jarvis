// Contract suite for MailProvider, CalendarProvider and DocumentProvider (T-062). The mock passes it now; the Google
// (T-063, T-064, T-065, T-186) and Microsoft (T-066 to T-068, T-187) providers register themselves with it over their
// fakes (MSW) in their own test files:
//
//   describeCommsContract({ name: "google", expect: { mail: true, calendar: true, documents: false }, setup: () => harness });
//
// Some checks are also exported so the suite's own tests can prove it catches broken providers.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import type { LaneBoundConnection } from "../contract/lane-bound";
import { ProposedPayloadSchema, SourceResultSchema, type ConnectorErrorKind } from "../contract/schemas";
import { isUntrustedBody, type UntrustedBody } from "../comms/ephemeral";
import { COMMS_PROVIDER_KEYS, FORBIDDEN_EXECUTE_PATTERN, type CalendarProvider, type DocumentProvider, type MailProvider } from "../comms/provider";
import {
  CalendarSyncResultSchema,
  DocumentLinkSchema,
  EventMetaSchema,
  MailSyncResultSchema,
  MessageMetaSchema,
  WatchInfoSchema,
  type CommsCursor,
  type MailWriteIntent,
  type WatchInfo,
} from "../comms/schemas";

type Conn = LaneBoundConnection<"google" | "microsoft">;
export type CommsFaultKind = "auth_revoked" | "rate_limited" | "server_error" | "expired_cursor";

export interface CommsContractHarness {
  /** Provide whichever providers this vendor implements; each present one is checked. */
  mail?: MailProvider;
  calendar?: CalendarProvider;
  documents?: DocumentProvider;
  laneId: LaneId;
  otherLaneId: LaneId;
  /** A fresh active, seeded connection of the provider under test. Two connections must have equal-sized seeds. */
  connect: (opts?: { laneId?: LaneId; mailbox?: string }) => Promise<Conn>;
  /** A lane-bound connection of the OTHER provider in the same lane (must be refused before any token read or request). */
  connectForeignProvider: () => Promise<Conn>;
  markReconnectRequired: (conn: { id: string }) => void;
  /** One-shot fault: the next provider call on this connection fails that way (expired_cursor: next sync resyncs). */
  injectFault: (conn: { id: string }, kind: CommsFaultKind) => void;
  /** Source-side changes: the next incremental sync must report them. Each acts on the given connection. */
  addMessage: (conn: { id: string }, messageId?: string) => string;
  removeMessage: (conn: { id: string }) => string;
  addEvent: (conn: { id: string }) => string;
  removeEvent: (conn: { id: string }) => string;
  /** Source-side: an existing event becomes a cancelled stub (status cancelled, no times); returns its event id. */
  cancelEvent: (conn: { id: string }) => string;
  /** Provider write calls received (sends, drafts, event writes). Must stay 0 through every check here. */
  externalWriteCount: () => number;
  /** Requests that reached the provider's API and Vault token reads. Guard failures must not move either. */
  externalRequestCount?: () => number;
  tokenReads?: () => number;
  /**
   * Content writes into any store by the provider. Must stay 0. A real harness backs this with a DB-write spy and
   * log capture (T-063), not a constant.
   */
  persistedContentWrites: () => number;
  /** A string present in every body the fake serves and in no metadata. */
  bodyCanary: string;
  fixtures: {
    messageId: string;
    messageSearchTerm: string;
    calendarId: string;
    /** All the calendars the connection syncs; `calendar.watch` returns one WatchInfo for each. */
    calendarIds: readonly string[];
    eventId: string;
    documentId: string;
    documentSearchTerm: string;
  };
}

export interface CommsContractFixture {
  name: string;
  /** Which providers this vendor must implement; the suite fails if a flag disagrees with the harness. */
  expect?: { mail?: boolean; calendar?: boolean; documents?: boolean };
  setup: () => CommsContractHarness | Promise<CommsContractHarness>;
}

function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("provider not under test");
  return v;
}

async function rejectsKind(p: Promise<unknown>, kind: ConnectorErrorKind): Promise<ConnectorError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected ConnectorError ${kind}`).toBeInstanceOf(ConnectorError);
  expect((err as ConnectorError).info.kind).toBe(kind);
  expect(Object.getPrototypeOf(err)).toBe(ConnectorError.prototype);
  return err as ConnectorError;
}

const EMPTY_LANE = "" as LaneId;
const compose = (mailbox: string, over: Record<string, unknown> = {}) => ({
  fromMailbox: mailbox,
  to: ["recipient@example.test"],
  cc: [],
  bcc: [],
  subject: "Synthetic subject",
  bodyText: "Synthetic composed text.",
  ...over,
});
const intent = (type: "email.send" | "email.save_draft", mailbox: string, over: Record<string, unknown> = {}): MailWriteIntent =>
  ({ action_type: type, compose: compose(mailbox, over) }) as MailWriteIntent;

/** Every provider: only the contract members, and no execute-like name (`_x` helpers are allowed). */
export function checkNoExecutePath(provider: object): void {
  const names = new Set<string>();
  for (let o: object | null = provider; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Reflect.ownKeys(o)) if (typeof k === "string") names.add(k);
  }
  for (const k of names) {
    if (k === "constructor" || k.startsWith("_")) continue;
    expect(COMMS_PROVIDER_KEYS as readonly string[], `unexpected member ${k}: writes execute only via ConnectorWriter`).toContain(k);
    if (k !== "prepareWrite") expect(FORBIDDEN_EXECUTE_PATTERN.test(k), `${k} looks like an execute path`).toBe(false);
  }
}

type AnyProvider = MailProvider | CalendarProvider | DocumentProvider;
type Call = (p: AnyProvider, conn: Conn, laneId: LaneId) => Promise<unknown>;

/**
 * Lane, forgery, cross-provider and status guards for every call of one provider. A connection of the other provider
 * must be refused with `forbidden`, and no guard failure may read a token or reach the provider API.
 */
export async function checkGuards(h: CommsContractHarness, calls: Call[], provider: AnyProvider): Promise<void> {
  const conn = await h.connect();
  const foreign = await h.connectForeignProvider();
  const otherConn = await h.connect({ laneId: h.otherLaneId });
  const dead = await h.connect();
  h.markReconnectRequired(dead);
  const writes = h.externalWriteCount();
  const requests = h.externalRequestCount?.();
  const tokens = h.tokenReads?.();
  for (const call of calls) {
    await rejectsKind(call(provider, conn, EMPTY_LANE), "invalid_input");
    await rejectsKind(call(provider, { ...conn } as Conn, h.laneId), "lane_mismatch"); // forged copy
    await rejectsKind(call(provider, otherConn, h.laneId), "lane_mismatch"); // another lane's connection
    await rejectsKind(call(provider, conn, h.otherLaneId), "lane_mismatch");
    await rejectsKind(call(provider, foreign, h.laneId), "forbidden");
    await rejectsKind(call(provider, dead, h.laneId), "reconnect_required");
  }
  expect(h.externalWriteCount()).toBe(writes);
  if (requests !== undefined) expect(h.externalRequestCount?.(), "a guard failure reached the provider API").toBe(requests);
  if (tokens !== undefined) expect(h.tokenReads?.(), "a guard failure read a token").toBe(tokens);
}

/** Ids that must never reach a provider URL. */
export const BAD_IDS = ["", "a/b", "..", "x?y", "x#y", "x\u0007y", "a".repeat(513)];

async function drain<T extends { upserts: unknown[]; removals: unknown[]; nextCursor: CommsCursor | null; hasMore: boolean; fullResyncRequired: boolean }>(
  page: (cursor: CommsCursor | null) => Promise<T>,
  start: CommsCursor | null,
): Promise<{ upserts: T["upserts"]; removals: T["removals"]; cursor: CommsCursor }> {
  const upserts: unknown[] = [];
  const removals: unknown[] = [];
  let cursor = start;
  for (let i = 0; i < 1000; i++) {
    const r = await page(cursor);
    expect(r.fullResyncRequired).toBe(false);
    upserts.push(...r.upserts);
    removals.push(...r.removals);
    cursor = r.nextCursor;
    expect(cursor).not.toBeNull();
    if (!r.hasMore) return { upserts, removals, cursor: cursor as CommsCursor };
  }
  throw new Error("sync did not terminate");
}

function describeBody(
  origin: string,
  harness: () => Promise<CommsContractHarness>,
  read: (x: CommsContractHarness, conn: Conn, opts?: { maxChars?: number }) => Promise<unknown>,
  present: (x: CommsContractHarness) => boolean,
  badIds: (x: CommsContractHarness, conn: Conn, bad: string) => Promise<unknown>[],
): void {
  it(`${origin}: readBody is live, untrusted, ephemeral, bounded and never persisted`, async () => {
    const x = await harness();
    if (!present(x)) return;
    const conn = await x.connect();
    const before = x.persistedContentWrites();
    const res = (await read(x, conn)) as { data: unknown; freshness: string; connection_id: string; lane_id: string };
    SourceResultSchema.parse(res);
    expect(res.freshness).toBe("live");
    expect(res.lane_id).toBe(x.laneId);
    expect(res.connection_id).toBe(conn.id);
    expect(isUntrustedBody(res.data), "body must be an UntrustedBody").toBe(true);
    const body = res.data as UntrustedBody;
    expect(body.trust).toBe("untrusted");
    expect(body.reveal()).toContain(x.bodyCanary);
    for (const leak of [JSON.stringify(res), inspect(res, { depth: 6 }), String(body), JSON.stringify({ ...body })]) {
      expect(leak).not.toContain(x.bodyCanary);
    }
    const small = (await read(x, conn, { maxChars: 10 })) as { data: UntrustedBody };
    expect(small.data.reveal().length).toBeLessThanOrEqual(10);
    expect(small.data.truncated).toBe(true);
    expect(x.persistedContentWrites()).toBe(before);
    expect(x.externalWriteCount()).toBe(0);
  });

  it(`${origin}: ids that could alter a provider URL are invalid_input`, async () => {
    const x = await harness();
    if (!present(x)) return;
    const conn = await x.connect();
    const requests = x.externalRequestCount?.();
    for (const bad of BAD_IDS) for (const call of badIds(x, conn, bad)) await rejectsKind(call, "invalid_input");
    if (requests !== undefined) expect(x.externalRequestCount?.(), "a bad id reached the provider API").toBe(requests);
  });
}

/** Registers the suite. Call at the top level of a test file. */
export function describeCommsContract(fixture: CommsContractFixture): void {
  describe(`comms provider contract: ${fixture.name}`, () => {
    let h: CommsContractHarness | undefined;
    const harness = async (): Promise<CommsContractHarness> => (h ??= await fixture.setup());

    it("has the providers this vendor must implement", async () => {
      const x = await harness();
      expect(Boolean(x.mail ?? x.calendar ?? x.documents)).toBe(true);
      if (fixture.expect?.mail !== undefined) expect(Boolean(x.mail)).toBe(fixture.expect.mail);
      if (fixture.expect?.calendar !== undefined) expect(Boolean(x.calendar)).toBe(fixture.expect.calendar);
      if (fixture.expect?.documents !== undefined) expect(Boolean(x.documents)).toBe(fixture.expect.documents);
    });

    describe("mail", () => {
      it("has no execute path and only the contract members", async () => {
        const x = await harness();
        if (x.mail) checkNoExecutePath(x.mail);
      });

      it("refuses bad lane, forged, cross-lane, foreign-provider and reconnect_required connections on every call", async () => {
        const x = await harness();
        if (!x.mail) return;
        const probe = await x.connect();
        const w = await x.mail.watch(x.laneId, probe);
        await checkGuards(
          x,
          [
            (p, c, l) => (p as MailProvider).sync(l, c, null),
            (p, c, l) => (p as MailProvider).readBody(l, c, x.fixtures.messageId),
            (p, c, l) => (p as MailProvider).search(l, c, { query: x.fixtures.messageSearchTerm }),
            (p, c, l) => (p as MailProvider).watch(l, c),
            (p, c, l) => (p as MailProvider).renew(l, c, w),
            (p, c, l) => (p as MailProvider).stop(l, c, w),
            (p, c, l) => (p as MailProvider).prepareWrite(l, c, intent("email.save_draft", c.external_account_id)),
          ],
          x.mail,
        );
      });

      it("renew and stop act only on channels of the same connection", async () => {
        const x = await harness();
        if (!x.mail || x.mail.capabilities.watch !== "push") return;
        const a = await x.connect();
        const b = await x.connect();
        const w = await x.mail.watch(x.laneId, a);
        await rejectsKind(x.mail.renew(x.laneId, b, w), "not_found");
        await rejectsKind(x.mail.stop(x.laneId, b, w), "not_found");
        WatchInfoSchema.parse(await x.mail.renew(x.laneId, a, w)); // A's channel is untouched
      });

      it("full sync returns strict metadata only, then an incremental sync is empty", async () => {
        const x = await harness();
        if (!x.mail) return;
        const conn = await x.connect();
        const mail = x.mail;
        const first = await drain((c) => mail.sync(x.laneId, conn, c, { pageSize: 2 }), null);
        expect(first.upserts.length).toBeGreaterThan(2); // paging was exercised
        for (const u of first.upserts) MessageMetaSchema.parse(u);
        expect(new Set((first.upserts as { message_id: string }[]).map((m) => m.message_id)).size).toBe(first.upserts.length);
        expect(JSON.stringify(first.upserts)).not.toContain(x.bodyCanary);
        const again = await mail.sync(x.laneId, conn, first.cursor);
        MailSyncResultSchema.parse(again);
        expect(again.upserts).toEqual([]);
        expect(again.removals).toEqual([]);
        expect(again.fullResyncRequired).toBe(false);
      });

      it("incremental sync reports additions and removals, and remove-then-re-add ends present", async () => {
        const x = await harness();
        if (!x.mail) return;
        const conn = await x.connect();
        const mail = x.mail;
        const base = await drain((c) => mail.sync(x.laneId, conn, c), null);
        const added = x.addMessage(conn);
        const removed = x.removeMessage(conn);
        const delta = await drain((c) => mail.sync(x.laneId, conn, c), base.cursor);
        expect((delta.upserts as { message_id: string }[]).map((m) => m.message_id)).toContain(added);
        expect(delta.removals).toContainEqual({ message_id: removed });
        // The removed id comes back: applied removals-first, the upsert must be present in the same delta.
        const cursor = delta.cursor;
        x.addMessage(conn, removed);
        const back = await drain((c) => mail.sync(x.laneId, conn, c), cursor);
        expect((back.upserts as { message_id: string }[]).map((m) => m.message_id)).toContain(removed);
        expect(x.externalWriteCount()).toBe(0);
      });

      it("binds cursors to their connection: a foreign cursor needs a full resync", async () => {
        const x = await harness();
        if (!x.mail) return;
        const mail = x.mail;
        const a = await x.connect();
        const b = await x.connect();
        const cursorA = (await drain((c) => mail.sync(x.laneId, a, c), null)).cursor;
        const cursorB = (await drain((c) => mail.sync(x.laneId, b, c), null)).cursor;
        const addedA = x.addMessage(a);
        x.addMessage(b); // same number of changes on both, so a version-only cursor would pass
        const foreign = await mail.sync(x.laneId, b, cursorA);
        expect(foreign.fullResyncRequired).toBe(true);
        expect(foreign.nextCursor).toBeNull();
        expect(foreign.upserts).toEqual([]);
        const own = await drain((c) => mail.sync(x.laneId, a, c), cursorA);
        expect((own.upserts as { message_id: string }[]).map((m) => m.message_id)).toContain(addedA);
        void cursorB;
      });

      it("answers fullResyncRequired (not an error) for a stale, garbage or provider-expired cursor", async () => {
        const x = await harness();
        if (!x.mail) return;
        const conn = await x.connect();
        for (const value of ["stale-cursor-xyz", "v999999999"]) {
          const r = await x.mail.sync(x.laneId, conn, { value });
          MailSyncResultSchema.parse(r);
          expect(r.fullResyncRequired).toBe(true);
          expect(r.nextCursor).toBeNull();
          expect(r.upserts).toEqual([]);
        }
        const good = (await drain((c) => need(x.mail).sync(x.laneId, conn, c), null)).cursor;
        x.injectFault(conn, "expired_cursor");
        const expired = await x.mail.sync(x.laneId, conn, good);
        expect(expired.fullResyncRequired).toBe(true);
        await rejectsKind(x.mail.sync(x.laneId, conn, { value: "x".repeat(16_385) }), "invalid_input");
      });

      it("maps provider faults to error kinds and a failed sync does not lose changes", async () => {
        const x = await harness();
        if (!x.mail) return;
        const mail = x.mail;
        const conn = await x.connect();
        const cursor = (await drain((c) => mail.sync(x.laneId, conn, c), null)).cursor;
        const added = x.addMessage(conn);
        x.injectFault(conn, "server_error");
        await rejectsKind(mail.sync(x.laneId, conn, cursor), "transient");
        x.injectFault(conn, "rate_limited");
        const limited = await rejectsKind(mail.sync(x.laneId, conn, cursor), "rate_limited");
        expect(limited.info.retry_after_seconds).toBeGreaterThan(0);
        // The old cursor is still valid and still yields the change.
        const retry = await drain((c) => mail.sync(x.laneId, conn, c), cursor);
        expect((retry.upserts as { message_id: string }[]).map((m) => m.message_id)).toContain(added);
        x.injectFault(conn, "auth_revoked");
        await rejectsKind(mail.sync(x.laneId, conn, cursor), "reconnect_required");
      });

      describeBody(
        "mail",
        harness,
        (x, conn, opts) => need(x.mail).readBody(x.laneId, conn, x.fixtures.messageId, opts),
        (x) => Boolean(x.mail),
        (x, conn, bad) => [need(x.mail).readBody(x.laneId, conn, bad)],
      );

      it("readBody of an unknown message is not_found", async () => {
        const x = await harness();
        if (!x.mail) return;
        await rejectsKind(x.mail.readBody(x.laneId, await x.connect(), "does-not-exist"), "not_found");
      });

      it("search returns metadata only, honours limit, treats the query as plain text", async () => {
        const x = await harness();
        if (!x.mail) return;
        const conn = await x.connect();
        const res = await x.mail.search(x.laneId, conn, { query: x.fixtures.messageSearchTerm, limit: 1 });
        SourceResultSchema.parse(res);
        expect(res.freshness).toBe("live");
        expect(res.data.length).toBe(1);
        for (const m of res.data) MessageMetaSchema.parse(m);
        expect(JSON.stringify(res)).not.toContain(x.bodyCanary);
        const plain = await x.mail.search(x.laneId, conn, { query: x.fixtures.messageSearchTerm });
        const injected = await x.mail.search(x.laneId, conn, { query: `${x.fixtures.messageSearchTerm} OR from:anyone` });
        expect(injected.data.length, "search operators must not widen the result").toBeLessThanOrEqual(plain.data.length);
        await rejectsKind(x.mail.search(x.laneId, conn, { query: "" }), "invalid_input");
        await rejectsKind(x.mail.search(x.laneId, conn, { query: "a".repeat(501) }), "invalid_input");
      });

      it("watch, renew and stop follow the capability (push expires and renews; polling has neither)", async () => {
        const x = await harness();
        if (!x.mail) return;
        const conn = await x.connect();
        const w = WatchInfoSchema.parse(await x.mail.watch(x.laneId, conn));
        expect(w.resource).toBe("mail");
        expect(w.mode).toBe(x.mail.capabilities.watch);
        const r = WatchInfoSchema.parse(await x.mail.renew(x.laneId, conn, w));
        expect(r.mode).toBe(w.mode);
        if (w.mode === "push") {
          expect(Date.parse(w.expires_at as string)).toBeGreaterThan(Date.now());
          expect(Date.parse(r.expires_at as string)).toBeGreaterThanOrEqual(Date.parse(w.expires_at as string));
        }
        // stop needs only the persisted WatchInfo
        await x.mail.stop(x.laneId, conn, JSON.parse(JSON.stringify(r)) as WatchInfo);
        if (w.mode === "push") await rejectsKind(x.mail.renew(x.laneId, conn, r), "not_found");
      });

      it("prepareWrite returns an exact proposed payload and performs no external write", async () => {
        const x = await harness();
        if (!x.mail) return;
        const conn = await x.connect();
        for (const type of ["email.save_draft", "email.send"] as const) {
          const p = await x.mail.prepareWrite(x.laneId, conn, intent(type, conn.external_account_id, { inReplyTo: { threadId: "thr-1", messageId: "msg-1" } }));
          ProposedPayloadSchema.parse(p);
          expect(p.action_type).toBe(type);
          expect(p.lane_id).toBe(x.laneId);
          expect(p.connection_id).toBe(conn.id);
          expect(p.payload).toMatchObject({ fromMailbox: conn.external_account_id, subject: "Synthetic subject", bodyText: "Synthetic composed text." });
          expect(p.expected_before).toBeNull();
          expect(p.target).toMatchObject({ mailbox: conn.external_account_id, thread_id: "thr-1" });
        }
        const dup = await x.mail.prepareWrite(x.laneId, conn, intent("email.send", conn.external_account_id, { to: ["A@Example.test", "a@example.test", "b@example.test"], cc: ["C@Example.test"] }));
        expect(dup.payload).toMatchObject({ to: ["a@example.test", "b@example.test"], cc: ["c@example.test"] });
        expect(x.externalWriteCount()).toBe(0);
      });

      it("prepareWrite refuses another mailbox, header injection, spoofing characters, bad types and bad recipients", async () => {
        const x = await harness();
        if (!x.mail) return;
        const conn = await x.connect();
        const m = conn.external_account_id;
        await rejectsKind(x.mail.prepareWrite(x.laneId, conn, intent("email.send", "someone-else@example.test")), "forbidden");
        for (const subject of ["Hi\r\nBcc: attacker@example.test", "Hi\u0085there", "Hi there", "Hi‮evil", "Hi⁦x⁩"]) {
          await rejectsKind(x.mail.prepareWrite(x.laneId, conn, intent("email.send", m, { subject })), "invalid_input");
        }
        await rejectsKind(x.mail.prepareWrite(x.laneId, conn, intent("email.send", m, { to: ["not-an-address"] })), "invalid_input");
        await rejectsKind(x.mail.prepareWrite(x.laneId, conn, intent("email.send", m, { to: [] })), "invalid_input");
        await rejectsKind(x.mail.prepareWrite(x.laneId, conn, intent("email.send", m, { inReplyTo: { threadId: "a/b", messageId: "m1" } })), "invalid_input");
        await rejectsKind(x.mail.prepareWrite(x.laneId, conn, { action_type: "email.delete", compose: compose(m) } as never), "invalid_input");
        await rejectsKind(x.mail.prepareWrite(x.laneId, conn, { ...intent("email.send", m), extra: 1 } as never), "invalid_input");
        expect(x.externalWriteCount()).toBe(0);
      });
    });

    describe("calendar", () => {
      it("has no execute path and only the contract members", async () => {
        const x = await harness();
        if (x.calendar) checkNoExecutePath(x.calendar);
      });

      it("refuses bad lane, forged, cross-lane, foreign-provider and reconnect_required connections on every call", async () => {
        const x = await harness();
        if (!x.calendar) return;
        const probe = await x.connect();
        const [w] = await x.calendar.watch(x.laneId, probe);
        const watch = need(w);
        await checkGuards(
          x,
          [
            (p, c, l) => (p as CalendarProvider).sync(l, c, null),
            (p, c, l) => (p as CalendarProvider).readBody(l, c, x.fixtures.calendarId, x.fixtures.eventId),
            (p, c, l) => (p as CalendarProvider).watch(l, c),
            (p, c, l) => (p as CalendarProvider).renew(l, c, watch),
            (p, c, l) => (p as CalendarProvider).stop(l, c, watch),
            (p, c, l) => (p as CalendarProvider).prepareWrite(l, c, { action_type: "calendar.event.create", calendar_id: x.fixtures.calendarId, changes: {} }),
          ],
          x.calendar,
        );
      });

      it("renew and stop act only on channels of the same connection", async () => {
        const x = await harness();
        if (!x.calendar || x.calendar.capabilities.watch !== "push") return;
        const a = await x.connect();
        const b = await x.connect();
        const [w] = await x.calendar.watch(x.laneId, a);
        const watch = need(w);
        await rejectsKind(x.calendar.renew(x.laneId, b, watch), "not_found");
        await rejectsKind(x.calendar.stop(x.laneId, b, watch), "not_found");
        WatchInfoSchema.parse(await x.calendar.renew(x.laneId, a, watch));
      });

      it("syncs every calendar: expanded instances, all-day dates (incl. a DST weekend) and cancelled stubs", async () => {
        const x = await harness();
        if (!x.calendar) return;
        const cal = x.calendar;
        const conn = await x.connect();
        const first = await drain((c) => cal.sync(x.laneId, conn, c, { pageSize: 2 }), null);
        const events = first.upserts.map((e) => EventMetaSchema.parse(e));
        expect(events.length).toBeGreaterThan(2);
        expect(new Set(events.map((e) => `${e.calendar_id}/${e.event_id}`)).size).toBe(events.length);
        expect(new Set(events.map((e) => e.calendar_id))).toEqual(new Set(x.fixtures.calendarIds));
        const instances = events.filter((e) => e.recurring_event_id !== null);
        expect(instances.length, "fixture must include an expanded recurring series").toBeGreaterThanOrEqual(2);
        for (const i of instances) {
          expect(i.original_start_at).not.toBeNull();
          expect(i.event_id).not.toBe(i.recurring_event_id);
        }
        const allDay = events.filter((e) => e.all_day);
        expect(allDay.length, "fixture must include all-day events").toBeGreaterThan(1);
        for (const e of allDay) {
          expect((e.end_date as string) > (e.start_date as string)).toBe(true);
          expect(e.timezone).not.toBeNull(); // schema also checks local-midnight instants
        }
        expect(allDay.some((e) => (e.start_date as string) <= "2026-11-01" && (e.end_date as string) > "2026-11-01"), "fixture must span a DST change").toBe(true);
        expect(events.filter((e) => e.status === "cancelled").length, "fixture must include a cancelled stub").toBeGreaterThan(0);
        expect(JSON.stringify(events)).not.toContain(x.bodyCanary);
        const again = await cal.sync(x.laneId, conn, first.cursor);
        CalendarSyncResultSchema.parse(again);
        expect(again.upserts).toEqual([]);
      });

      it("incremental sync reports additions, removals and cancelled stubs; stale and foreign cursors resync", async () => {
        const x = await harness();
        if (!x.calendar) return;
        const cal = x.calendar;
        const conn = await x.connect();
        const other = await x.connect();
        const base = await drain((c) => cal.sync(x.laneId, conn, c), null);
        const added = x.addEvent(conn);
        const cancelled = x.cancelEvent(conn);
        const removed = x.removeEvent(conn);
        const delta = await drain((c) => cal.sync(x.laneId, conn, c), base.cursor);
        const ups = delta.upserts as { event_id: string; status: string; start_at: string | null }[];
        expect(ups.map((e) => e.event_id)).toContain(added);
        const stub = ups.find((e) => e.event_id === cancelled);
        expect(stub?.status).toBe("cancelled");
        expect(stub?.start_at).toBeNull();
        expect((delta.removals as { event_id: string }[]).map((e) => e.event_id)).toContain(removed);
        const stale = await cal.sync(x.laneId, conn, { value: "stale-token" });
        expect(stale.fullResyncRequired).toBe(true);
        expect(stale.nextCursor).toBeNull();
        const otherBase = await drain((c) => cal.sync(x.laneId, other, c), null);
        x.addEvent(other);
        void otherBase;
        const foreign = await cal.sync(x.laneId, other, base.cursor);
        expect(foreign.fullResyncRequired).toBe(true);
      });

      it("maps provider faults to error kinds", async () => {
        const x = await harness();
        if (!x.calendar) return;
        const conn = await x.connect();
        x.injectFault(conn, "server_error");
        await rejectsKind(x.calendar.sync(x.laneId, conn, null), "transient");
        x.injectFault(conn, "rate_limited");
        expect((await rejectsKind(x.calendar.sync(x.laneId, conn, null), "rate_limited")).info.retry_after_seconds).toBeGreaterThan(0);
        x.injectFault(conn, "auth_revoked");
        await rejectsKind(x.calendar.sync(x.laneId, conn, null), "reconnect_required");
      });

      describeBody(
        "calendar",
        harness,
        (x, conn, opts) => need(x.calendar).readBody(x.laneId, conn, x.fixtures.calendarId, x.fixtures.eventId, opts),
        (x) => Boolean(x.calendar),
        (x, conn, bad) => [need(x.calendar).readBody(x.laneId, conn, bad, x.fixtures.eventId), need(x.calendar).readBody(x.laneId, conn, x.fixtures.calendarId, bad)],
      );

      it("watches every calendar; renew and stop take one WatchInfo", async () => {
        const x = await harness();
        if (!x.calendar) return;
        const conn = await x.connect();
        const ws = (await x.calendar.watch(x.laneId, conn)).map((w) => WatchInfoSchema.parse(w));
        if (x.calendar.capabilities.watch === "push") {
          expect(ws.length).toBe(x.fixtures.calendarIds.length);
          expect(new Set(ws.map((w) => w.channel_id)).size).toBe(ws.length);
          expect(new Set(ws.map((w) => w.state))).toEqual(new Set(x.fixtures.calendarIds));
        } else {
          expect(ws.length).toBe(1);
        }
        for (const w of ws) {
          expect(w.resource).toBe("calendar");
          expect(w.mode).toBe(x.calendar.capabilities.watch);
          const r = WatchInfoSchema.parse(await x.calendar.renew(x.laneId, conn, w));
          await x.calendar.stop(x.laneId, conn, r);
        }
      });

      it("prepareWrite is unsupported until phase 4 and writes nothing", async () => {
        const x = await harness();
        if (!x.calendar) return;
        const conn = await x.connect();
        expect(x.calendar.capabilities.prepareWrite).toBe(false);
        await rejectsKind(
          x.calendar.prepareWrite(x.laneId, conn, { action_type: "calendar.event.create", calendar_id: x.fixtures.calendarId, changes: { title: "x" } }),
          "unsupported_op",
        );
        expect(x.externalWriteCount()).toBe(0);
      });
    });

    describe("documents", () => {
      it("has no execute path and only the contract members", async () => {
        const x = await harness();
        if (x.documents) checkNoExecutePath(x.documents);
      });

      it("refuses bad lane, forged, cross-lane, foreign-provider and reconnect_required connections on every call", async () => {
        const x = await harness();
        if (!x.documents) return;
        await checkGuards(
          x,
          [
            (p, c, l) => (p as DocumentProvider).search(l, c, { query: x.fixtures.documentSearchTerm }),
            (p, c, l) => (p as DocumentProvider).readBody(l, c, x.fixtures.documentId),
            (p, c, l) => (p as DocumentProvider).prepareWrite(l, c, { action_type: "document.update", document_id: x.fixtures.documentId, changes: {} }),
          ],
          x.documents,
        );
      });

      it("search returns links and metadata only, never content, and treats the query as plain text", async () => {
        const x = await harness();
        if (!x.documents) return;
        const conn = await x.connect();
        const res = await x.documents.search(x.laneId, conn, { query: x.fixtures.documentSearchTerm });
        SourceResultSchema.parse(res);
        expect(res.freshness).toBe("live");
        expect(res.data.length).toBeGreaterThan(0);
        for (const d of res.data) DocumentLinkSchema.parse(d);
        expect(JSON.stringify(res)).not.toContain(x.bodyCanary);
        const injected = await x.documents.search(x.laneId, conn, { query: `${x.fixtures.documentSearchTerm} OR owner:anyone` });
        expect(injected.data.length).toBeLessThanOrEqual(res.data.length);
        await rejectsKind(x.documents.search(x.laneId, conn, { query: "" }), "invalid_input");
      });

      describeBody(
        "document",
        harness,
        (x, conn, opts) => need(x.documents).readBody(x.laneId, conn, x.fixtures.documentId, opts),
        (x) => Boolean(x.documents),
        (x, conn, bad) => [need(x.documents).readBody(x.laneId, conn, bad)],
      );

      it("prepareWrite is unsupported and writes nothing", async () => {
        const x = await harness();
        if (!x.documents) return;
        const conn = await x.connect();
        expect(x.documents.capabilities.prepareWrite).toBe(false);
        await rejectsKind(x.documents.prepareWrite(x.laneId, conn, { action_type: "document.update", document_id: "doc-1", changes: {} }), "unsupported_op");
        expect(x.externalWriteCount()).toBe(0);
      });
    });
  });
}
