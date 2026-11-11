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
      t({ fromAddress: "ceo@bigclient.test", subject: "Priority", unreadCount: 0 }),
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

  it("priority senders skip exclusions except one-time codes", () => {
    const { top } = rankAttention(
      [t({ fromAddress: "ceo@bigclient.test", subject: "Deck", labels: ["INBOX", "CATEGORY_PROMOTIONS"] }), t({ fromAddress: "ceo@bigclient.test", subject: "Your verification code" })],
      rules,
      now,
    );
    expect(top.map((i) => i.thread.subject)).toEqual(["Deck"]);
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
  it("finds invoices, bills, renewals and failed payments (failed first); skips promotions and card alerts", () => {
    const rows = [
      t({ subject: "Invoice #1042 from Vendor" }),
      t({ subject: "Your payment failed", fromAddress: "billing@saas.test" }),
      t({ subject: "Your plan renews on Dec 1", fromAddress: "no-reply@saas.test" }),
      t({ subject: "Invoice sale! 50% off", labels: ["CATEGORY_PROMOTIONS"] }),
      t({ subject: "Card transaction alert: purchase" }),
      t({ subject: "Lunch?" }),
    ];
    expect(moneyThreads(rows, rules).map((m) => [m.kind, m.thread.subject])).toEqual([
      ["failed_payment", "Your payment failed"],
      ["invoice", "Invoice #1042 from Vendor"],
      ["renewal", "Your plan renews on Dec 1"],
    ]);
  });
});
