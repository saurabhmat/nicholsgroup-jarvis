// T-243: what the AI summary may do to "Needs your attention": only remove. Synthetic data.
import { describe, expect, it } from "vitest";
import { laneConfigSchema } from "@nichols/core/lane-config";
import { rankAttention, type AttentionRules, type AttentionThread, type ThreadRow } from "./attention";
import { checkContent, type AttentionNote, type BriefRef } from "./compose";
import { dropNoReplyItems, noteSaysNoAction, notesForMessages, summaryMarksNoReply, type SummaryForAttention } from "./attention-summary";

const b = laneConfigSchema.shape.briefing.parse({});
const rules: AttentionRules = { prioritySenders: [], freshHours: 48, deadlineSubjects: b.deadline_subjects, ownDomains: [], securitySubjects: b.security_subjects, securitySenders: b.security_senders, exclusions: b.exclusions, money: b.money };
const now = new Date("2026-11-11T15:00:00Z");
const row = (i: number, over: Partial<ThreadRow> = {}): ThreadRow => ({
  connectionId: "c1", threadKey: `t${String(i)}`, messageId: `m${String(i)}`, fromAddress: `p${String(i)}@acme.test`, fromName: `Person ${String(i)}`, subject: `Subject ${String(i)}`,
  receivedAt: new Date(now.getTime() - i * 3_600_000).toISOString(), sourceUrl: null, labels: ["INBOX"], isImportant: false, lastIsOwner: false, ownerReplied: false, unreadCount: 1, inboundCount: 1, ...over,
});
const ranked = (n: number) => rankAttention(Array.from({ length: n }, (_, i) => row(i + 1)), rules, now);
const ref = (r: string, i: number, over: Partial<BriefRef> = {}): BriefRef => ({ ref: r, connectionId: "c1", messageId: `m${String(i)}`, threadKey: `t${String(i)}`, mailbox: null, fromAddress: null, fromName: null, subject: null, receivedAt: now.toISOString(), sourceUrl: null, reason: "", kind: "unread", ...over });
const note = (r: string, needsReply?: boolean): AttentionNote => ({ ref: r, what: "w", why: "y", next: "n", ...(needsReply === undefined ? {} : { needsReply }) });
const saved = (refs: BriefRef[], attention: AttentionNote[], status = "ready"): SummaryForAttention => ({ status, refs, content: { attention } });
const keys = (l: readonly AttentionThread[]) => l.map((a) => a.thread.messageId);

describe("dropNoReplyItems", () => {
  it("a top-5 item marked needs_reply false leaves, the next fresh item moves up; the count excludes it", () => {
    const r = ranked(8);
    expect(keys(r.top)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    const out = dropNoReplyItems(r.fresh, saved([ref("r1", 2)], [note("r1", false)]));
    expect(keys(out.top)).toEqual(["m1", "m3", "m4", "m5", "m6"]);
    expect(out.more).toBe(2); // m7, m8 (m2 is no longer counted as needing attention)
    expect(out.removed).toBe(1);
  });
  it("unknown (no field) and true change nothing", () => {
    const r = ranked(7);
    for (const n of [note("r1"), note("r1", true)]) {
      const out = dropNoReplyItems(r.fresh, saved([ref("r1", 2)], [n]));
      expect(keys(out.top)).toEqual(keys(r.top));
      expect(out.more).toBe(r.more);
      expect(out.removed).toBe(0);
    }
  });
  it("an AI note can never ADD an item: unknown refs, a thread outside the list, or true on a thread the rules left out change nothing", () => {
    const r = ranked(3);
    const all = saved([ref("r1", 99), ref("r2", 98)], [note("r1", true), note("r2", false), note("r9", false)]);
    const out = dropNoReplyItems(r.fresh, all);
    expect(keys(out.top)).toEqual(["m1", "m2", "m3"]);
    // Whatever the notes say, the result is a subset of the rules' ranking, in the same order.
    const many = saved(Array.from({ length: 10 }, (_, i) => ref(`r${String(i)}`, i + 1)), Array.from({ length: 10 }, (_, i) => note(`r${String(i)}`, i % 2 === 0)));
    const sub = dropNoReplyItems(r.fresh, many).top.map((a) => a.key);
    const order = r.fresh.map((a) => a.key);
    expect(sub.every((k) => order.includes(k))).toBe(true);
    expect([...sub].sort((a, c) => order.indexOf(a) - order.indexOf(c))).toEqual(sub);
  });
  it("only the exact message the summary covered: a newer message in the same thread, another connection or thread is not removed", () => {
    const r = ranked(2);
    expect(dropNoReplyItems(r.fresh, saved([ref("r1", 1, { messageId: "older-message" })], [note("r1", false)])).removed).toBe(0);
    expect(dropNoReplyItems(r.fresh, saved([ref("r1", 1, { connectionId: "c2" })], [note("r1", false)])).removed).toBe(0);
    expect(dropNoReplyItems(r.fresh, saved([ref("r1", 1, { threadKey: "other" })], [note("r1", false)])).removed).toBe(0);
    expect(dropNoReplyItems(r.fresh, saved([ref("r1", 1, { threadKey: "" })], [note("r1", false)])).removed).toBe(1); // an old ref without a thread key
  });
  it("a failed briefing and no briefing change nothing", () => {
    const r = ranked(2);
    expect(dropNoReplyItems(r.fresh, saved([ref("r1", 1)], [note("r1", false)], "failed")).removed).toBe(0);
    expect(dropNoReplyItems(r.fresh, null).removed).toBe(0);
    expect(notesForMessages(saved([ref("r1", 1)], [note("r1", false)], "failed")).size).toBe(0);
  });
  it("a repeated-failures row is rule-made and never removed by a note", () => {
    const failing = Array.from({ length: 3 }, (_, i) => row(i + 1, { fromAddress: "ci@github.com", subject: "Run failed", unreadCount: 1 }));
    const r = rankAttention(failing, rules, now);
    const item = r.fresh.find((a) => a.kind === "repeated_failures");
    expect(item).toBeDefined();
    if (item) expect(summaryMarksNoReply(item, saved([ref("r1", 1)], [note("r1", false)]))).toBe(false);
  });
});

describe("T-243 review: the summary can never remove high-value rows", () => {
  const vipRules: AttentionRules = { ...rules, prioritySenders: ["boss@acme.test"] };
  const mk = (over: Partial<ThreadRow>[]) => rankAttention(over.map((o, i) => row(i + 1, o)), vipRules, now);
  const noReply = (n: number) => saved(Array.from({ length: n }, (_, i) => ref(`r${String(i + 1)}`, i + 1)), Array.from({ length: n }, (_, i) => note(`r${String(i + 1)}`, false)));
  it("security, VIP, money and deadline rows with needs_reply false stay in the top list", () => {
    const r = mk([
      { fromAddress: "no-reply@accounts.google.com", fromName: "Accounts", subject: "Security alert: new sign-in on Mac" },
      { fromAddress: "boss@acme.test", subject: "Quick one", isAuthPass: true },
      { subject: "Invoice 88 is overdue" },
      { subject: "Contract deadline Friday" },
      { subject: "Plain note" },
    ]);
    expect(r.fresh.map((a) => a.thread.subject)).toHaveLength(5);
    expect(r.fresh.find((a) => a.thread.subject?.startsWith("Security alert"))?.kind).toBe("security");
    const out = dropNoReplyItems(r.fresh, noReply(5));
    expect(out.removed).toBe(1); // only the plain row
    expect(out.top.map((a) => a.thread.subject)).not.toContain("Plain note");
    expect(out.top).toHaveLength(4);
    for (const a of r.fresh.filter((x) => x.thread.subject !== "Plain note")) expect(summaryMarksNoReply(a, noReply(5))).toBe(false);
  });
  it("re-check M-a: a security alert from a sender that does not look automated (ranked as unread) is still protected", () => {
    const r = mk([{ fromAddress: "jane@google.com", fromName: "Jane at Google", subject: "Security alert: new sign-in from a new device" }, { subject: "Plain note" }]);
    const alert = r.fresh.find((a) => a.thread.fromAddress === "jane@google.com");
    expect(alert?.kind).not.toBe("security"); // the rules ranked it as person mail ...
    expect(alert?.flags.security).toBe(true); // ... but it is flagged as a security alert
    const out = dropNoReplyItems(r.fresh, noReply(2));
    expect(out.top.map((a) => a.thread.fromAddress)).toContain("jane@google.com");
    expect(out.removed).toBe(1);
  });
  it("two refs for one message: a true wins over a false", () => {
    const r = ranked(1);
    const both = saved([ref("r1", 1), ref("r2", 1)], [note("r1", false), note("r2", true)]);
    expect(dropNoReplyItems(r.fresh, both).removed).toBe(0);
    expect(dropNoReplyItems(r.fresh, saved([ref("r1", 1), ref("r2", 1)], [note("r1", false), note("r2", false)])).removed).toBe(1);
  });
});

describe("noteSaysNoAction", () => {
  const n = (over: Partial<AttentionNote>): AttentionNote => ({ ref: "r1", what: "Receipt arrived", why: "Routine", next: "Archive it", ...over });
  it("the field decides when present", () => {
    expect(noteSaysNoAction(n({ needsReply: false }))).toBe(true);
    expect(noteSaysNoAction(n({ needsReply: true, next: "No action needed" }))).toBe(false);
  });
  it("without the field, the older wording does", () => {
    for (const next of ["No action needed.", "No further action required", "No reply needed", "Nothing needed from you", "No need to reply"]) expect(noteSaysNoAction(n({ next })), next).toBe(true);
    for (const next of ["FYI only", "For your information", "Reply with the figures", "Awaiting your decision", "No reply from Sam yet, follow up", "Call the vendor"]) expect(noteSaysNoAction(n({ next })), next).toBe(false);
  });
  it("no note: nothing", () => {
    expect(noteSaysNoAction(undefined)).toBe(false);
  });
});

describe("checkContent and needs_reply", () => {
  const refs = [ref("r1", 1), ref("r2", 2), ref("r3", 3)];
  const sources = () => ["from Person <p@acme.test>, subject \"Hello\""];
  const run = (attention: unknown[]) => checkContent({ lines: [], attention }, refs, sources, sources(), { replies: false }).attention;
  it("a boolean is kept, null/missing/other types mean unknown (field absent)", () => {
    const out = run([
      { ref: "r1", what: "Hello", why: "y", next: "n", needs_reply: false },
      { ref: "r2", what: "Hello", why: "y", next: "n", needs_reply: true },
      { ref: "r3", what: "Hello", why: "y", next: "n", needs_reply: null },
    ]);
    expect(out.map((a) => a.needsReply)).toEqual([false, true, undefined]);
    expect("needsReply" in (out[2] ?? {})).toBe(false);
    const old = run([{ ref: "r1", what: "Hello", why: "y", next: "n" }, { ref: "r2", what: "Hello", why: "y", next: "n", needs_reply: "false" }, { ref: "r3", what: "Hello", why: "y", next: "n", needs_reply: 0 }]);
    expect(old.every((a) => !("needsReply" in a))).toBe(true);
  });
  it("an unknown ref stays dropped whatever it says", () => {
    expect(run([{ ref: "r9", what: "Hello", why: "y", next: "n", needs_reply: false }])).toEqual([]);
  });
});
