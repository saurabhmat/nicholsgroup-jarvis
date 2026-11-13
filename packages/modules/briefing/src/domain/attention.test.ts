import { describe, expect, it } from "vitest";
import { laneConfigSchema } from "@nichols/core/lane-config";
import { classify, maskFigures, moneyThreads, rankAttention, senderHas, subjectHas, waitingOnYou, type AttentionRules, type ThreadRow } from "./attention";

const b = laneConfigSchema.shape.briefing.parse({});
const rules: AttentionRules = { prioritySenders: ["boss@pubk.test", "@bigclient.test"], freshHours: b.attention.fresh_hours, deadlineSubjects: b.deadline_subjects, ownDomains: [], securitySubjects: b.security_subjects, securitySenders: b.security_senders, exclusions: b.exclusions, money: b.money };
const now = new Date("2026-11-11T15:00:00Z");
let n = 0;
const t = (over: Partial<ThreadRow>): ThreadRow => ({
  connectionId: "c",
  threadKey: `t${String(++n)}`,
  messageId: `m${String(n)}`,
  fromAddress: "person@acme.test",
  fromName: null,
  subject: "Hello",
  receivedAt: "2026-11-11T10:00:00Z",
  sourceUrl: "https://mail.google.com/x",
  labels: ["INBOX"],
  isImportant: false,
  lastIsOwner: false,
  ownerReplied: false,
  unreadCount: 1,
  inboundCount: 1,
  ...over,
});

describe("exclusions", () => {
  it.each([
    [{ labels: ["INBOX", "CATEGORY_PROMOTIONS"] }, "label"],
    [{ fromAddress: "newsletter@shop.test" }, "newsletter"],
    [{ fromAddress: "messages-noreply@linkedin.com" }, "social"],
    [{ subject: "Your verification code is 123456" }, "otp"],
    [{ subject: "Transaction alert: you made a purchase" }, "bank_alert"],
    [{ fromAddress: "notifications@github.com", subject: "Run failed" }, "bot"],
    [{ subject: "Your verification code is 123456", fromAddress: "boss@pubk.test" }, "otp"],
  ])("%o -> %s", (over, why) => {
    expect(classify(t(over), rules).excluded).toBe(why);
  });
  it("keeps bank statements and due dates, and security alerts from automated senders", () => {
    expect(classify(t({ subject: "Your statement is ready" }), rules).excluded).toBeNull();
    expect(classify(t({ subject: "Card transaction: payment due Nov 20" }), rules).excluded).toBeNull();
    expect(classify(t({ fromAddress: "no-reply@accounts.google.com", subject: "Security alert: new sign-in on Mac" }), rules)).toMatchObject({ excluded: null, security: true });
  });
});

// T-234 part 2: synthetic look-alikes of two real false positives, plus auto-reply, OTP and CI, and the negatives.
describe("T-234 part 2 exclusions", () => {
  const orgRules: AttentionRules = { ...rules, exclusions: { ...b.exclusions, org_newsletter_senders: ["weekly@pubk.test"] } };
  const kept = (over: Partial<ThreadRow>, r = rules) => rankAttention([t(over)], r, now).top.length === 1;
  it("an org newsletter with List-Unsubscribe (flag from sync) is excluded, even from the lane's own domain", () => {
    const row = t({ fromAddress: "robert.jones@pubk.test", fromName: "Pub K Weekly", subject: "This week at Pub K", isBulk: true });
    expect(classify(row, rules).excluded).toBe("bulk");
    expect(kept({ fromAddress: "robert.jones@pubk.test", subject: "This week at Pub K", isBulk: true })).toBe(false);
  });
  it("an org newsletter sender listed in lane_config is excluded even without a flag (older rows)", () => {
    expect(classify(t({ fromAddress: "weekly@pubk.test", subject: "Weekly update" }), orgRules).excluded).toBe("bulk");
    expect(kept({ fromAddress: "weekly@pubk.test", subject: "Weekly update" }, orgRules)).toBe(false);
    expect(kept({ fromAddress: "weekly@pubk.test", subject: "Weekly update" })).toBe(true); // not listed: the default list is empty
  });
  it("'Updated invitation: ... @ Wed Nov 12' with a text/calendar part is excluded by flag and by subject", () => {
    const subject = "Updated invitation: Capture review @ Wed Nov 12, 2026 2pm - 3pm (EST) (robert@pubk.test)";
    expect(classify(t({ fromAddress: "calendar-notification@google.com", subject, isCalendar: true }), rules).excluded).toBe("calendar");
    expect(classify(t({ fromAddress: "colleague@pubk.test", subject }), rules).excluded).toBe("calendar"); // no flag: prefix pattern
    expect(classify(t({ subject: "Canceled event: Standup @ Thu Nov 13" }), rules).excluded).toBe("calendar");
    expect(classify(t({ subject: "Invitation: Standup @ Thu Nov 13" }), rules).excluded).toBe("calendar");
  });
  it("a priority sender cannot bring back a calendar notification, an auto-reply or a code (header flags are hard)", () => {
    expect(kept({ fromAddress: "boss@pubk.test", subject: "Invitation: board call", isCalendar: true, isAuthPass: true })).toBe(false);
    expect(kept({ fromAddress: "boss@pubk.test", subject: "Out of office", isAuto: true, isAuthPass: true })).toBe(false);
    expect(kept({ fromAddress: "boss@pubk.test", subject: "Your one-time code is 123456", isAuthPass: true })).toBe(false);
    expect(kept({ fromAddress: "boss@pubk.test", subject: "Capture review", isAuthPass: true })).toBe(true);
  });
  it("a subject prefix alone is a soft exclusion: an authenticated priority sender keeps 'Canceled: PO 4471'; anyone else is excluded", () => {
    for (const subject of ["Canceled: PO 4471", "Accepted: revised teaming agreement"]) {
      expect(kept({ fromAddress: "boss@pubk.test", subject, isAuthPass: true })).toBe(true);
      expect(kept({ fromAddress: "boss@pubk.test", subject })).toBe(false); // no auth pass
      expect(kept({ fromAddress: "person@acme.test", subject })).toBe(false);
    }
  });
  it("auto-generated mail (soft): excluded for others, kept from an authenticated priority sender", () => {
    expect(classify(t({ subject: "Status", isGenerated: true }), rules)).toMatchObject({ excluded: "generated", hard: false, automated: true });
    expect(kept({ fromAddress: "boss@pubk.test", subject: "Status", isGenerated: true, isAuthPass: true })).toBe(true);
    expect(kept({ fromAddress: "boss@pubk.test", subject: "Status", isGenerated: true })).toBe(false);
    expect(kept({ fromAddress: "person@acme.test", subject: "Status", isGenerated: true })).toBe(false);
  });
  it("a spoofed priority sender (bulk, no auth pass) is excluded; T-237: bulk mail stays out even with an auth pass, while an authenticated auto-generated one is kept as priority", () => {
    const spoof = { fromAddress: "boss@pubk.test", subject: "Wire request", isBulk: true };
    expect(rankAttention([t(spoof)], rules, now).top).toEqual([]);
    expect(rankAttention([t({ ...spoof, isAuthPass: true })], rules, now).top).toEqual([]);
    const ok = rankAttention([t({ fromAddress: "boss@pubk.test", subject: "Wire request", isGenerated: true, isAuthPass: true })], rules, now).top;
    expect(ok).toHaveLength(1);
    expect(ok[0]?.kind).toBe("priority");
    // without the pass, an unflagged priority-address mail is an ordinary sender, not tier 0
    expect(rankAttention([t({ fromAddress: "boss@pubk.test", subject: "Hi" })], rules, now).top[0]?.kind).not.toBe("priority");
  });
  it("an authenticated priority sender is kept despite an auto-generated flag and a bot subject (bulk is never kept: T-237)", () => {
    expect(kept({ fromAddress: "boss@pubk.test", subject: "Update", isGenerated: true, isAuthPass: true })).toBe(true);
    expect(kept({ fromAddress: "boss@pubk.test", subject: "Update", isBulk: true, isAuthPass: true })).toBe(false);
    expect(kept({ fromAddress: "noreply@bigclient.test", subject: "Build #1234 failed", isAuthPass: true })).toBe(true);
    expect(classify(t({ fromAddress: "noreply@ci.example.test", subject: "Build #1234 failed" }), rules).excluded).toBe("bot_subject");
  });
  it("auto-replies are excluded by flag and by subject prefix", () => {
    expect(classify(t({ subject: "Re: Proposal", isAuto: true }), rules).excluded).toBe("auto_reply");
    expect(classify(t({ subject: "Automatic reply: Proposal" }), rules).excluded).toBe("auto_reply");
    expect(classify(t({ subject: "Out of Office Autoreply: Proposal" }), rules).excluded).toBe("auto_reply");
  });
  it("one-time codes are excluded", () => {
    expect(classify(t({ fromAddress: "colleague@pubk.test", subject: "Your one-time code is 482913" }), rules).excluded).toBe("otp");
  });
  it("CI / bot noise from automated senders is excluded, including a no-reply sender with a CI subject", () => {
    expect(classify(t({ fromAddress: "noreply@ci.example.test", subject: "[GitHub] Pull request merged: fix typo" }), rules).excluded).toBe("bot_subject");
    expect(classify(t({ fromAddress: "notifications@vercel.com", subject: "Deployment ready: web-app" }), rules).excluded).toBe("bot");
    expect(kept({ fromAddress: "noreply@ci.example.test", subject: "Preview deployment ready" })).toBe(false);
  });
  it("negatives: a real person from the org's own domain with no bulk headers is kept; a person's pull request question is kept", () => {
    expect(classify(t({ fromAddress: "robert.jones@pubk.test", subject: "Can you review the capture plan?" }), rules).excluded).toBeNull();
    expect(kept({ fromAddress: "robert.jones@pubk.test", subject: "Can you review the capture plan?" }, orgRules)).toBe(true);
    expect(classify(t({ fromAddress: "colleague@pubk.test", subject: "Pull request on the proposal?" }), rules).excluded).toBeNull();
    expect(classify(t({ fromAddress: "colleague@pubk.test", subject: "Re: Invitation: board call" }), rules).excluded).toBeNull();
    expect(classify(t({ fromAddress: "colleague@pubk.test", subject: "Your invitation to the gala" }), rules).excluded).toBeNull();
  });
  it("security alerts from trusted senders are still never excluded", () => {
    expect(classify(t({ fromAddress: "no-reply@accounts.google.com", subject: "Security alert: new sign-in", isBulk: true }), rules)).toMatchObject({ excluded: null, security: true });
  });
  it("authenticated money mail survives the bulk, auto-generated, label and bot_subject exclusions", () => {
    for (const flags of [{ isBulk: true }, { isGenerated: true }, { labels: ["INBOX", "CATEGORY_PROMOTIONS"] }]) {
      expect(moneyThreads([t({ fromAddress: "billing@pubk.test", subject: "Invoice 1042 is attached", isAuthPass: true, ...flags })], rules)).toHaveLength(1);
    }
    expect(moneyThreads([t({ fromAddress: "noreply@billing.example.test", subject: "Payment failed for your subscription", isBulk: true, isAuthPass: true })], rules)[0]?.kind).toBe("failed_payment");
  });
  it("unauthenticated bulk/label money mail stays out, and spam or trash is never money (security re-check M2)", () => {
    expect(moneyThreads([t({ fromAddress: "billing@pubk.test", subject: "Invoice overdue, pay here", isBulk: true })], rules)).toEqual([]);
    expect(moneyThreads([t({ subject: "Invoice overdue", labels: ["CATEGORY_PROMOTIONS"] })], rules)).toEqual([]);
    expect(moneyThreads([t({ subject: "Invoice 1042", labels: ["INBOX", "SPAM"], isAuthPass: true })], rules)).toEqual([]);
    expect(moneyThreads([t({ subject: "Invoice 1042", labels: ["TRASH"], isAuthPass: true })], rules)).toEqual([]);
    // Ordinary (not excluded) money mail needs no auth pass.
    expect(moneyThreads([t({ subject: "Invoice 1042 is attached" })], rules)).toHaveLength(1);
  });
  it("but codes, calendar notices, true auto-replies and the newsletter sender lists stay out of the money list", () => {
    const inv = "Invoice 1042 is attached";
    expect(moneyThreads([t({ subject: inv, isCalendar: true }), t({ subject: inv, isAuto: true }), t({ subject: "Invoice: your verification code is 1" }), t({ subject: inv, fromAddress: "newsletter@shop.test" })], rules)).toEqual([]);
    expect(moneyThreads([t({ fromAddress: "weekly@pubk.test", subject: inv })], orgRules)).toEqual([]);
  });
});

describe("matching", () => {
  it("sender patterns are anchored: no fedex.com for x.com, no mary.jenkins for a bot domain", () => {
    expect(senderHas("ship@fedex.com", ["x.com"])).toBe(false);
    expect(senderHas("a@x.com", ["x.com"])).toBe(true);
    expect(senderHas("a@mail.x.com", ["x.com"])).toBe(true);
    expect(senderHas("mary.jenkins@client.test", b.exclusions.bot_senders)).toBe(false);
    expect(senderHas("info@vendor.test", b.exclusions.newsletter_senders)).toBe(false);
    expect(senderHas("news@paper.test", ["news@"])).toBe(true);
    expect(senderHas("goodnews@paper.test", ["news@"])).toBe(false);
  });
  it("subject patterns match whole words", () => {
    expect(subjectHas("Carbon footprint report", ["otp"])).toBe(false);
    expect(subjectHas("Your OTP is ready", ["otp"])).toBe(true);
    expect(classify(t({ subject: "Purchase order approval" }), rules).excluded).toBeNull();
  });
  it("masks amounts and long numbers in subjects", () => {
    expect(maskFigures("Invoice 88 for $4,500.00 is past due on card ending 12345")).toBe("Invoice 88 for [amount] is past due on card ending [number]");
  });
});

describe("rankAttention", () => {
  it("acceptance order: priority, waiting on you, unread people, trusted security alerts; drops answered and automated", () => {
    const rows = [
      t({ fromAddress: "friend@acme.test", subject: "Unread", receivedAt: "2026-11-11T12:00:00Z" }),
      t({ fromAddress: "colleague@acme.test", subject: "Waiting", ownerReplied: true, unreadCount: 0, receivedAt: "2026-11-10T12:00:00Z", lastToOwner: true }),
      t({ fromAddress: "no-reply@accounts.google.com", subject: "Security alert", unreadCount: 0 }),
      t({ fromAddress: "ceo@bigclient.test", subject: "Priority", unreadCount: 0, isAuthPass: true }),
      t({ fromAddress: "x@acme.test", subject: "Answered", lastIsOwner: true, ownerReplied: true }),
      t({ fromAddress: "no-reply@saas.test", subject: "Weekly report" }),
    ];
    const { top, more } = rankAttention(rows, rules, now);
    expect(top.map((i) => [i.thread.subject, i.kind])).toEqual([
      ["Priority", "priority"],
      ["Waiting", "waiting"],
      ["Unread", "unread"],
      ["Security alert", "security"],
    ]);
    expect(top[0]?.reason).toBe("Priority sender, not answered · 5h");
    expect(top[1]?.reason).toBe("Waiting on your reply · 27h");
    expect(more).toBe(0);
  });

  it("read but never answered counts as waiting; a security subject from an untrusted sender is not a security alert", () => {
    const { top } = rankAttention(
      [t({ subject: "Question", unreadCount: 0 }), t({ fromAddress: "alerts@phish.test", subject: "Security alert: verify now" })],
      rules,
      now,
    );
    expect(top.map((i) => [i.thread.subject, i.kind, i.reason])).toEqual([["Question", "waiting", "Read, no reply from you · 5h"]]);
  });

  it("authenticated priority senders skip the soft exclusions (auto-generated) but not one-time codes", () => {
    const { top } = rankAttention(
      [t({ fromAddress: "ceo@bigclient.test", subject: "Deck", isGenerated: true, isAuthPass: true }), t({ fromAddress: "ceo@bigclient.test", subject: "Your verification code", isAuthPass: true })],
      rules,
      now,
    );
    expect(top.map((i) => i.thread.subject)).toEqual(["Deck"]);
  });

  // T-237: promotional / newsletter / bulk mail is never in the top 5, whoever sends it.
  it("promotional (CATEGORY_PROMOTIONS), newsletter and bulk mail never reach the top list, not even from an authenticated priority sender", () => {
    const rows = [
      t({ fromAddress: "ceo@bigclient.test", subject: "Promo", labels: ["INBOX", "CATEGORY_PROMOTIONS"], isAuthPass: true }),
      t({ fromAddress: "ceo@bigclient.test", subject: "Bulk", isBulk: true, isAuthPass: true }),
      t({ fromAddress: "newsletter@shop.test", subject: "Newsletter" }),
      t({ fromAddress: "someone@else.test", subject: "Sale", labels: ["INBOX", "CATEGORY_PROMOTIONS"] }),
      t({ fromAddress: "someone@else.test", subject: "Bulk 2", isBulk: true }),
      t({ fromAddress: "colleague@pubk.test", subject: "A real question" }),
    ];
    const { top, more } = rankAttention(rows, rules, now);
    expect(top.map((i) => i.thread.subject)).toEqual(["A real question"]);
    expect(more).toBe(0);
    // also with the priority sender configured: the promotional mail from it still stays out
    const prio = { ...rules, prioritySenders: ["ceo@bigclient.test"] };
    expect(rankAttention(rows, prio, now).top.map((i) => i.thread.subject)).toEqual(["A real question"]);
  });

  it("shows bot/CI mail only as one item when failures repeat", () => {
    const ci = (s: string) => t({ fromAddress: "notifications@github.com", subject: s });
    // ("Run failed" etc.)
    expect(rankAttention([ci("Run failed"), ci("Run failed")], rules, now).top).toEqual([]);
    const { top } = rankAttention([ci("Run failed"), ci("Build failed"), ci("Run failed"), ci("Pull request merged")], rules, now);
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({ kind: "repeated_failures", count: 3, reason: "3 failure alerts from github.com" });
  });

  it("caps at five and counts the rest", () => {
    const { top, more } = rankAttention(Array.from({ length: 8 }, () => t({})), rules, now);
    expect(top).toHaveLength(5);
    expect(more).toBe(3);
  });
});

describe("T-240: recency-aware ranking", () => {
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  const subjects = (rows: ThreadRow[], r = rules) => rankAttention(rows, r, now).top.map((i) => i.thread.subject);
  it("a 2-hour-old unread from a person outranks a 6-day-old 'read, not answered' thread (which goes to Still waiting)", () => {
    const rows = [t({ subject: "Old", unreadCount: 0, receivedAt: ago(6 * 24) }), t({ subject: "New", receivedAt: ago(2) })];
    const out = rankAttention(rows, rules, now);
    expect(out.top.map((i) => i.thread.subject)).toEqual(["New"]);
    expect(out.stillWaiting.map((i) => i.thread.subject)).toEqual(["Old"]);
    expect(out.more).toBe(0);
  });
  it("48 hours is the boundary: exactly 48 h is fresh, a minute over is Still waiting", () => {
    const out = rankAttention([t({ subject: "At 48h", receivedAt: ago(48) }), t({ subject: "Over", receivedAt: new Date(now.getTime() - 48 * 3_600_000 - 60_000).toISOString() })], rules, now);
    expect(out.top.map((i) => i.thread.subject)).toEqual(["At 48h"]);
    expect(out.stillWaiting.map((i) => i.thread.subject)).toEqual(["Over"]);
  });
  it("a custom fresh_hours moves the boundary", () => {
    const rows = [t({ subject: "30h", receivedAt: ago(30) }), t({ subject: "5h", receivedAt: ago(5) })];
    expect(subjects(rows, { ...rules, freshHours: 24 })).toEqual(["5h"]);
    expect(subjects(rows, { ...rules, freshHours: 72 })).toEqual(["5h", "30h"]);
    expect(rankAttention(rows, { ...rules, freshHours: 24 }, now).stillWaiting).toHaveLength(1);
  });
  it("newest first within a band", () => {
    const rows = [t({ subject: "10h", receivedAt: ago(10) }), t({ subject: "1h", receivedAt: ago(1) }), t({ subject: "30h", receivedAt: ago(30) })];
    expect(subjects(rows)).toEqual(["1h", "10h", "30h"]);
  });
  it("importance bands across: VIP, money or deadline, waiting, unread, security, failures; a fresh older VIP beats a newer unread", () => {
    const ci = (s: string) => t({ fromAddress: "notifications@github.com", subject: s, receivedAt: ago(1) });
    const rows = [
      t({ subject: "Unread 1h", receivedAt: ago(1) }),
      t({ subject: "Waiting 5h", unreadCount: 0, receivedAt: ago(5) }),
      t({ subject: "Contract deadline Friday", receivedAt: ago(20) }),
      t({ subject: "VIP 40h", fromAddress: "ceo@bigclient.test", isAuthPass: true, unreadCount: 0, receivedAt: ago(40) }),
      t({ fromAddress: "no-reply@accounts.google.com", subject: "Security alert", receivedAt: ago(1) }),
      ci("Run failed"), ci("Run failed"), ci("Build failed"),
    ];
    expect(rankAttention(rows, rules, now, 10).top.map((i) => i.thread.subject)).toEqual(["VIP 40h", "Contract deadline Friday", "Waiting 5h", "Unread 1h", "Security alert", "Run failed"]);
  });
  it("money subjects take the money band, with the money flag", () => {
    const { top } = rankAttention([t({ subject: "Unread", receivedAt: ago(1) }), t({ subject: "Invoice 1042 is attached", receivedAt: ago(9) })], rules, now);
    expect(top.map((i) => i.thread.subject)).toEqual(["Invoice 1042 is attached", "Unread"]);
    expect(top[0]?.flags).toMatchObject({ money: "invoice", deadline: false });
  });
  it("no exception for priority senders: an old VIP thread goes to Still waiting", () => {
    const out = rankAttention([t({ subject: "Old VIP", fromAddress: "ceo@bigclient.test", isAuthPass: true, receivedAt: ago(100) })], rules, now);
    expect(out.top).toEqual([]);
    expect(out.stillWaiting.map((i) => i.kind)).toEqual(["priority"]);
  });
  it("Still waiting is newest first; old security alerts and old failures are dropped, not counted", () => {
    const old = (s: string, h: number, over: Partial<ThreadRow> = {}) => t({ subject: s, receivedAt: ago(h), ...over });
    const out = rankAttention(
      [old("A", 100), old("B", 80), old("C", 200, { unreadCount: 0 }), old("Alert", 90, { fromAddress: "no-reply@accounts.google.com", subject: "Security alert" }),
       ...["x", "y", "z"].map((s) => old(s, 120, { fromAddress: "notifications@github.com", subject: "Run failed" }))],
      rules,
      now,
    );
    expect(out.top).toEqual([]);
    expect(out.stillWaiting.map((i) => i.thread.subject)).toEqual(["B", "A", "C"]);
  });
  it("more = fresh items beyond the cap, never counting old ones", () => {
    const rows = [...Array.from({ length: 7 }, (_, i) => t({ receivedAt: ago(i + 1) })), t({ receivedAt: ago(500) })];
    const out = rankAttention(rows, rules, now);
    expect(out.top).toHaveLength(5);
    expect(out.more).toBe(2);
    expect(out.stillWaiting).toHaveLength(1);
  });
  it("exclusions are unchanged: bulk, newsletters, labels and calendar are never top 5 or Still waiting", () => {
    const rows = [t({ isBulk: true, receivedAt: ago(100) }), t({ fromAddress: "newsletter@shop.test", receivedAt: ago(100) }), t({ labels: ["INBOX", "CATEGORY_PROMOTIONS"], receivedAt: ago(1) }), t({ isCalendar: true, receivedAt: ago(100) })];
    const out = rankAttention(rows, rules, now);
    expect([out.top.length, out.stillWaiting.length]).toEqual([0, 0]);
  });
});

describe("T-240: Waiting on you vs the reason chips", () => {
  const one = (over: Partial<ThreadRow>, r = rules) => rankAttention([t(over)], r, now).top[0];
  it("waitingOnYou only when the owner is in the To of the latest message and no later reply", () => {
    expect(one({ lastToOwner: true, unreadCount: 0 })?.flags.waitingOnYou).toBe(true);
    expect(one({ lastToOwner: false, unreadCount: 0 })?.flags.waitingOnYou).toBe(false); // Cc, Bcc or a list address
    expect(one({ unreadCount: 0 })?.flags.waitingOnYou).toBe(false); // unknown: fails safe
    // the owner replied after it: the thread is not on the list at all
    expect(rankAttention([t({ lastToOwner: true, lastIsOwner: true, ownerReplied: true })], rules, now).top).toEqual([]);
    expect(waitingOnYou(t({ lastToOwner: true, lastIsOwner: true }))).toBe(false);
  });
  it("an automated security alert addressed to the owner is not \"Waiting on you\" (code review M1)", () => {
    const alert = one({ fromAddress: "no-reply@accounts.google.com", subject: "Security alert", unreadCount: 0, lastToOwner: true });
    expect(alert?.kind).toBe("security");
    expect(alert?.flags.waitingOnYou).toBe(false);
  });
  it("the reason text does not claim a reply is owed when the owner is not in the To", () => {
    expect(one({ unreadCount: 0, lastToOwner: true })?.reason).toBe("Read, not answered · 5h");
    expect(one({ unreadCount: 0 })?.reason).toBe("Read, no reply from you · 5h");
    expect(one({ ownerReplied: true, unreadCount: 0 })?.reason).toBe("New message after your reply · 5h");
  });
  it("reason flags: Money (existing patterns), Deadline (lane_config list), VIP (authenticated priority sender only)", () => {
    expect(one({ subject: "Invoice 88 is due" })?.flags).toMatchObject({ money: "invoice", deadline: false, vip: false });
    expect(one({ subject: "RFP response deadline moved" })?.flags).toMatchObject({ money: null, deadline: true });
    expect(one({ subject: "Due tomorrow: signed forms" })?.flags.deadline).toBe(true);
    expect(one({ subject: "Rapid footprint review" })?.flags.deadline).toBe(false); // whole words only
    expect(one({ subject: "Hi", fromAddress: "ceo@bigclient.test", isAuthPass: true })?.flags.vip).toBe(true);
    expect(one({ subject: "Hi", fromAddress: "ceo@bigclient.test" })?.flags.vip).toBe(false);
  });
  it("a custom deadline list replaces the default", () => {
    expect(one({ subject: "Cutoff Friday" }, { ...rules, deadlineSubjects: ["cutoff"] })?.flags.deadline).toBe(true);
    expect(one({ subject: "Deadline Friday" }, { ...rules, deadlineSubjects: ["cutoff"] })?.flags.deadline).toBe(false);
  });
});

describe("T-240: newsletters from the lane's own domains", () => {
  const own = { ...rules, ownDomains: ["pubk.test"] };
  it("a non-person mailbox on an own domain is excluded as bulk even with no flag and an empty org list", () => {
    for (const from of ["news@pubk.test", "no-reply@pubk.test", "newsletter@mail.pubk.test", "updates@pubk.test", "info@pubk.test", "marketing@pubk.test"]) {
      expect(classify(t({ fromAddress: from }), own).excluded).toBe("bulk");
      expect(rankAttention([t({ fromAddress: from })], own, now).top).toEqual([]);
    }
  });
  it("a list-style label or auto-generated mail from an own domain is bulk", () => {
    expect(classify(t({ fromAddress: "robert@pubk.test", labels: ["INBOX", "List/Weekly"] }), own).excluded).toBe("bulk");
    expect(classify(t({ fromAddress: "robert@pubk.test", isGenerated: true }), own).excluded).toBe("bulk");
  });
  it("a real colleague on the same domain still ranks", () => {
    expect(rankAttention([t({ fromAddress: "colleague@pubk.test", subject: "Quick question" })], own, now).top).toHaveLength(1);
    expect(classify(t({ fromAddress: "robert.jones@pubk.test" }), own).excluded).toBeNull();
  });
  it("the same address from a domain that is not the lane's own is not caught by this rule", () => {
    expect(classify(t({ fromAddress: "info@client.test", subject: "Hello" }), own).excluded).toBeNull();
    expect(classify(t({ fromAddress: "info@pubk.test", subject: "Hello" }), rules).excluded).toBeNull(); // no own domains known
  });
  it("bulk from an own domain stays out even from an authenticated priority sender", () => {
    const prio = { ...own, prioritySenders: ["news@pubk.test"] };
    expect(rankAttention([t({ fromAddress: "news@pubk.test", isAuthPass: true })], prio, now).top).toEqual([]);
  });
});

describe("moneyThreads", () => {
  it("finds invoices, bills, renewals and failed payments (failed first); keeps promotions-labelled billing mail, skips card alerts", () => {
    const rows = [
      t({ subject: "Invoice #1042 from Vendor" }),
      t({ subject: "Your payment failed", fromAddress: "billing@saas.test" }),
      t({ subject: "Your plan renews on Dec 1", fromAddress: "no-reply@saas.test" }),
      t({ subject: "Invoice sale! 50% off", labels: ["CATEGORY_PROMOTIONS"] }), // unauthenticated promotion: out
      t({ subject: "Invoice 77 from SaaS", labels: ["CATEGORY_PROMOTIONS"], isAuthPass: true }),
      t({ subject: "Card transaction alert: purchase" }),
      t({ subject: "Lunch?" }),
    ];
    expect(moneyThreads(rows, rules).map((m) => [m.kind, m.thread.subject])).toEqual([
      ["failed_payment", "Your payment failed"],
      ["invoice", "Invoice #1042 from Vendor"],
      ["invoice", "Invoice 77 from SaaS"], // a label exclusion does not hide an authenticated money match
      ["renewal", "Your plan renews on Dec 1"],
    ]);
  });
});
