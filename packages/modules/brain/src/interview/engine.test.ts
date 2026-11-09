import { describe, expect, it } from "vitest";
import { TEMPLATE_FILES } from "../domain/templates";
import { applyAnswers, newConfig, parseAnswers, AnswerError, splitList, type InterviewCtx, type LaneInfo } from "./answers";
import { questionById } from "./bank";
import { setLine, setSection } from "./doc-edit";
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

describe("section progress (T-226): complete = every required question answered from stored state", () => {
  const about = TEMPLATE_FILES["Context/About-Me.md"] as string;
  const pa = TEMPLATE_FILES["Employees/Personal-Assistant.md"] as string;
  const complete = (groups: ReturnType<typeof buildGroups>) => groups.filter((g) => g.derivedComplete).map((g) => g.id);
  const withConfig = (mut: (c: ReturnType<typeof newConfig>) => void) => {
    const c = newConfig(ctx());
    mut(c);
    return c;
  };

  it("an untouched brain has no complete section, and a saved draft profile alone completes nothing", () => {
    expect(complete(buildGroups(empty, null, ctx()))).toEqual([]);
    expect(complete(buildGroups({ ...empty, pa }, newConfig(ctx()), ctx()))).toEqual([]);
  });

  it("saving only B-1 completes only B-1 (the draft profile existing does not complete B-2..B-6)", () => {
    const config = withConfig((c) => {
      c.sources.mail = [{ lane: "TST", mailbox: "ops@example.test", priority: 1, include: ["board"] }];
    });
    const groups = buildGroups({ ...empty, pa }, config, ctx());
    expect(complete(groups)).toEqual(["B-1"]);
    // the chat routing flag keeps its old meaning (profile exists), so routing is unchanged
    expect(groups.filter((g) => g.part === "B").every((g) => g.done)).toBe(true);
  });

  it("a required question missing blocks the section; a skipped optional one does not", () => {
    const name = setSection(about, "Name and how to address me", "Pat");
    const noScope = buildGroups({ ...empty, about_me: name }, null, ctx());
    expect(complete(noScope)).not.toContain("A-1");
    const both = setSection(name, "Scope of this brain", "Work");
    const groups = buildGroups({ ...empty, about_me: both }, null, ctx());
    expect(view(groups, "A3").status).toBe("ask"); // optional, left blank: still shows as not provided
    expect(complete(groups)).toContain("A-1");
  });

  it("a section of optional questions only needs one answer; untouched it is not complete", () => {
    expect(complete(buildGroups(empty, null, ctx()))).not.toContain("A-4");
    const prefs = setSection(TEMPLATE_FILES["Context/Preferences.md"] as string, "Writing", "Short and plain");
    expect(complete(buildGroups({ ...empty, preferences: prefs }, null, ctx()))).toContain("A-4");
  });

  it("settings answers count only when they differ from the fresh-profile default; a skipped-by-policy question never blocks", () => {
    const days3 = withConfig((c) => {
      c.sources.calendar.days_ahead = 3;
    });
    expect(complete(buildGroups({ ...empty, pa }, days3, ctx()))).not.toContain("B-3"); // B7 (finance numbers) still at its default
    const noFinance = ctx([lane({ financeView: false })]);
    const days3b = withConfig((c) => {
      c.sources.calendar.days_ahead = 3;
    });
    const g = buildGroups({ ...empty, pa }, { ...days3b, lanes: ["TST"] }, noFinance);
    expect(complete(g)).toContain("B-3");
  });

  it("all ten complete once every required answer is stored", () => {
    let docs: Docs = {
      about_me: ["Name and how to address me", "Scope of this brain", "Timezone"].reduce((b, h) => setSection(b, h, "Filled in."), about),
      preferences: setSection(TEMPLATE_FILES["Context/Preferences.md"] as string, "Writing", "Short"),
      work: setSection(TEMPLATE_FILES["Context/Work.md"] as string, "My role here", "Owner"),
      pa,
    };
    const c = ctx([lane({ policy: { write_actions_allowed: ["email_draft"], store_outbound_drafts: true, llm_allowed_categories: ["email", "web"] } })]);
    const cfg = withConfig(() => undefined);
    cfg.sources.mail = [{ lane: "TST", mailbox: "ops@example.test", priority: 1, include: ["board"] }];
    cfg.sources.vip_senders = ["ceo@example.test"];
    cfg.sources.calendar.days_ahead = 3;
    cfg.sources.finance_alerts = false;
    cfg.schedule.days = [1, 2];
    cfg.delivery = ["in_app"];
    cfg.output.target_words = 250;
    cfg.output.max_attention_items = 3;
    cfg.output.max_drafts = 1;
    docs = { ...docs, pa: setLine(setSection(pa, "1. Role and objective", "Watch the board mail"), "7. Rules", "- Additional rules:", "- Additional rules: never reply to press") };
    const groups = buildGroups(docs, cfg, c);
    expect(groups.filter((g) => !g.derivedComplete).map((g) => g.id)).toEqual([]);
  });

  it("a field another question also writes does not make a question known (approvals off + a news topic leave B-5 incomplete)", () => {
    const noDrafts = ctx([lane({ policy: { write_actions_allowed: [], store_outbound_drafts: false, llm_allowed_categories: ["email", "web"] } })]); // B13 skipped by policy
    const cfg = withConfig((c) => {
      c.sources.approvals_pending = false;
      c.sources.external = [{ kind: "web", topics: ["regulation"] } as never];
      c.output.sections = ["coverage", "attention"];
    });
    const groups = buildGroups({ ...empty, pa }, cfg, noDrafts);
    expect(view(groups, "B13").status).toBe("skipped");
    expect(complete(groups)).not.toContain("B-5");
    expect(complete(groups)).not.toContain("B-4"); // B10 days and B11 delivery are still at their defaults
  });

  it("B12 with only its length changed is not known (the items limit is required too)", () => {
    const only = withConfig((c) => {
      c.output.target_words = 250;
    });
    const groups = buildGroups({ ...empty, pa }, only, ctx());
    expect(complete(groups)).not.toContain("B-5");
    const both = withConfig((c) => {
      c.output.target_words = 250;
      c.output.max_attention_items = 3;
      c.output.max_drafts = 1;
    });
    expect(complete(buildGroups({ ...empty, pa }, both, ctx()))).toContain("B-5");
  });

  it("B6 needs its required days-ahead, not just the optional prep text", () => {
    const cfg = withConfig(() => undefined);
    const body = setLine(pa, "4. Calendar", "Meetings that need prep:", "Meetings that need prep: board calls");
    expect(complete(buildGroups({ ...empty, pa: body }, cfg, ctx()))).not.toContain("B-3");
  });
});
