import { describe, expect, it } from "vitest";
import { TEMPLATE_FILES } from "../domain/templates";
import { applyAnswers, newConfig, parseAnswers, AnswerError, splitList, type InterviewCtx, type LaneInfo } from "./answers";
import { questionById } from "./bank";
import { setSection } from "./doc-edit";
import { buildGroups, skipReason, type Docs } from "./engine";

const lane = (over: Partial<LaneInfo> = {}): LaneInfo => ({
  laneId: "TST",
  name: "Test Co",
  mailboxes: ["ops@example.test", "boss@example.test"],
  kpis: ["cash_book_balance", "mrr"],
  connected: ["ops@example.test"],
  policy: { write_actions_allowed: ["email_draft"], store_outbound_drafts: true, llm_allowed_categories: ["email", "calendar"] },
  financeView: true,
  ...over,
});
const ctx = (l: LaneInfo[] = [lane()]): InterviewCtx => ({ home: "TST", current: "TST", lanes: l, timezones: ["America/New_York", "UTC"] });
const empty: Docs = { about_me: null, preferences: null, work: null, pa: null };
const must = <T,>(v: T | undefined): T => {
  if (v === undefined) throw new Error("missing");
  return v;
};
const q = (id: string) => must(questionById(id));
const view = (groups: ReturnType<typeof buildGroups>, id: string) => must(groups.flatMap((g) => g.questions).find((x) => x.id === id));

describe("skip rules", () => {
  it("skips a question whose page section is already filled, and shows it as known", () => {
    const docs: Docs = { ...empty, about_me: setSection(TEMPLATE_FILES["Context/About-Me.md"] as string, "Name and how to address me", "Pat") };
    const groups = buildGroups(docs, null, ctx());
    const a1 = view(groups, "A1");
    expect(a1.status).toBe("known");
    expect(a1.known).toBe("Pat");
    expect(view(groups, "A2").status).toBe("ask");
  });
  it("skips finance with no finance view, web with no web category, drafts without a draft policy", () => {
    const c = ctx([lane({ financeView: false, policy: { write_actions_allowed: [], store_outbound_drafts: false, llm_allowed_categories: ["email"] } })]);
    const cfg = newConfig(c);
    expect(skipReason(q("B7"), empty, cfg, c)).toBe("no_finance");
    expect(skipReason(q("B9"), empty, cfg, c)).toBe("no_web");
    expect(skipReason(q("B13"), empty, cfg, c)).toBe("no_drafts");
    const open = ctx([lane({ policy: { write_actions_allowed: ["email_draft"], store_outbound_drafts: true, llm_allowed_categories: ["email", "web"] } })]);
    expect(skipReason(q("B7"), empty, newConfig(open), open)).toBeNull();
    expect(skipReason(q("B9"), empty, newConfig(open), open)).toBeNull();
    expect(skipReason(q("B13"), empty, newConfig(open), open)).toBeNull();
  });
  it("never shows more than three questions per step and marks connected mailboxes", () => {
    const groups = buildGroups(empty, null, ctx());
    for (const g of groups) expect(g.questions.length).toBeLessThanOrEqual(3);
    const b2 = view(groups, "B2");
    const opts = must(must(b2.fields[0]).options);
    expect(opts.find((o) => o.value === "TST|ops@example.test")?.note).toBe("connected");
    expect(opts.find((o) => o.value === "TST|boss@example.test")?.note).toBe("not_connected");
  });
  it("an unreadable connection state is unknown, never 'missing'", () => {
    const b2 = view(buildGroups(empty, null, ctx([lane({ connected: null })])), "B2");
    expect(must(must(b2.fields[0]).options).every((o) => o.note === "unknown")).toBe(true);
  });
});

describe("answers", () => {
  it("rejects unknown keys, wrong types and out-of-range values", () => {
    expect(() => parseAnswers(q("B6"), { days_ahead: 99, prep: "" })).toThrow(AnswerError);
    expect(() => parseAnswers(q("B6"), { days_ahead: 3, prep: "", extra: 1 })).toThrow(AnswerError);
    expect(() => parseAnswers(q("A1"), { name: "  " })).toThrow(AnswerError);
    expect(parseAnswers(q("B6"), { days_ahead: 3 })).toEqual({ days_ahead: 3 });
  });
  it("B2 refuses a mailbox the lane does not list", () => {
    const c = ctx();
    expect(() => applyAnswers(q("B2"), { mailboxes: ["TST|stranger@example.test"] }, newConfig(c), c)).toThrow(AnswerError);
    expect(() => applyAnswers(q("B2"), { mailboxes: ["OTH|ops@example.test"] }, newConfig(c), c)).toThrow(AnswerError);
  });
  it("B2 and B3 build the mail sources in priority order and keep the lane list single", () => {
    const c = ctx();
    const cfg = newConfig(c);
    applyAnswers(q("B2"), { mailboxes: ["TST|boss@example.test", "TST|ops@example.test"] }, cfg, c);
    const edits = applyAnswers(q("B3"), { include: { "TST|boss@example.test": "team waiting on me; invoices" } }, cfg, c);
    expect(cfg.sources.mail.map((m) => [m.mailbox, m.priority])).toEqual([["boss@example.test", 1], ["ops@example.test", 2]]);
    expect(must(cfg.sources.mail[0]).include).toEqual(["team waiting on me", "invoices"]);
    expect(cfg.lanes).toEqual(["TST"]);
    expect(must(edits[0]).text).toContain("1. boss@example.test (Test Co): team waiting on me; invoices");
  });
  it("B4 validates senders; B7 picks only KPIs the lane configures", () => {
    const c = ctx();
    const cfg = newConfig(c);
    expect(() => applyAnswers(q("B4"), { vip: "not an address" }, cfg, c)).toThrow(AnswerError);
    applyAnswers(q("B4"), { vip: "Ceo@Example.test, @partner.example" }, cfg, c);
    expect(cfg.sources.vip_senders).toEqual(["ceo@example.test", "@partner.example"]);
    expect(() => applyAnswers(q("B7"), { show: "pick", kpis: ["ar_total"] }, cfg, c)).toThrow(AnswerError);
    applyAnswers(q("B7"), { show: "pick", kpis: ["mrr"] }, cfg, c);
    expect(cfg.sources.finance_kpis).toEqual(["mrr"]);
    applyAnswers(q("B7"), { show: "none" }, cfg, c);
    expect(cfg.sources.finance_alerts).toBe(false);
    expect(cfg.output.sections).not.toContain("finance_kpis");
  });
  it("B13 turns drafts off and on without touching other permissions", () => {
    const c = ctx();
    const cfg = newConfig(c);
    applyAnswers(q("B13"), { max_drafts: 0 }, cfg, c);
    expect(cfg.permissions.propose).toEqual([]);
    applyAnswers(q("B13"), { max_drafts: 2 }, cfg, c);
    expect(cfg.permissions.propose).toEqual(["email.save_draft"]);
    expect(cfg.output.max_drafts).toBe(2);
  });
  it("B10 defaults to Mon-Fri semantics and an empty time means the lane default", () => {
    const c = ctx();
    const cfg = newConfig(c);
    cfg.schedule.time = "07:15";
    applyAnswers(q("B10"), { time: "", days: ["3", "1", "5"] }, cfg, c);
    expect(cfg.schedule.time).toBeUndefined();
    expect(cfg.schedule.days).toEqual([1, 3, 5]);
  });
  it("A4 accepts only a listed timezone", () => {
    const c = ctx();
    expect(applyAnswers(q("A4"), { timezone: "UTC" }, newConfig(c), c)[0]?.text).toBe("UTC");
    expect(() => applyAnswers(q("A4"), { timezone: "Mars/Base" }, newConfig(c), c)).toThrow(AnswerError);
  });
  it("splitList splits on commas, semicolons and new lines and dedupes", () => {
    expect(splitList("a, b;c\nb")).toEqual(["a", "b", "c"]);
  });
});
