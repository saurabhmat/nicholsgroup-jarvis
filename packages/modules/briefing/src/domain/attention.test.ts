import { describe, expect, it } from "vitest";
import { laneConfigSchema } from "@nichols/core/lane-config";
import { classify, maskFigures, moneyThreads, rankAttention, senderHas, subjectHas, type AttentionRules, type ThreadRow } from "./attention";

const b = laneConfigSchema.shape.briefing.parse({});
const rules: AttentionRules = { prioritySenders: ["boss@pubk.test", "@bigclient.test"], securitySubjects: b.security_subjects, securitySenders: b.security_senders, exclusions: b.exclusions, money: b.money };
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
      t({ fromAddress: "colleague@acme.test", subject: "Waiting", ownerReplied: true, unreadCount: 0, receivedAt: "2026-11-09T12:00:00Z" }),
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
    expect(top[1]?.reason).toBe("Waiting on your reply · 2d");
    expect(more).toBe(0);
  });

  it("read but never answered counts as waiting; a security subject from an untrusted sender is not a security alert", () => {
    const { top } = rankAttention(
      [t({ subject: "Question", unreadCount: 0 }), t({ fromAddress: "alerts@phish.test", subject: "Security alert: verify now" })],
      rules,
      now,
    );
    expect(top.map((i) => [i.thread.subject, i.kind, i.reason])).toEqual([["Question", "waiting", "Read, not answered · 5h"]]);
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
