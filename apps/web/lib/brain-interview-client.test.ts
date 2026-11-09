import { afterEach, describe, expect, it, vi } from "vitest";
import { TEMPLATE_FILES } from "@nichols/brain/domain";
import { buildGroups, setSection, type GroupView } from "@nichols/brain/interview";
import { activeQuestions, buildAnswers, callInterview, canPreview, initialValues, isInterviewRequest, issueLabel, nextGroupId } from "./brain-interview-client";

const group = (over: Partial<GroupView> = {}): GroupView => ({
  id: "A-1",
  part: "A",
  title: "About you",
  saves: "Context/About-Me.md",
  done: false,
  complete: false,
  questions: [
    { id: "A1", prompt: "What should Jarvis call you?", status: "known", known: "Pat", fields: [{ key: "name", label: "Name", kind: "text", required: true }], prefill: { name: "Pat" } },
    { id: "A3", prompt: "First task?", status: "ask", fields: [{ key: "first_task", label: "First task", kind: "longtext" }] },
    { id: "A2", prompt: "Skipped one", status: "skipped", skipReason: "known", fields: [{ key: "scope", label: "Scope", kind: "select", required: true }] },
  ],
  ...over,
});

describe("form values", () => {
  it("starts from the stored answer or a neutral default", () => {
    expect(initialValues(group())).toEqual({ A1: { name: "Pat" }, A3: { first_task: "" }, A2: { scope: "" } });
  });
  it("only asked questions, and known ones being edited, are active; skipped never", () => {
    expect(activeQuestions(group(), new Set()).map((q) => q.id)).toEqual(["A3"]);
    expect(activeQuestions(group(), new Set(["A1", "A2"])).map((q) => q.id)).toEqual(["A1", "A3"]);
  });
  it("builds answers for active questions only, leaves empty optional text out and sends numbers as numbers", () => {
    const g = group();
    expect(buildAnswers(g, { A1: { name: "Pat" }, A3: { first_task: "" } }, new Set())).toEqual({ A3: {} });
    expect(buildAnswers(g, { A1: { name: "Pat K" }, A3: { first_task: "Triage" } }, new Set(["A1"]))).toEqual({ A1: { name: "Pat K" }, A3: { first_task: "Triage" } });
    const b6: GroupView = group({ questions: [{ id: "B6", prompt: "Calendar", status: "ask", fields: [{ key: "days_ahead", label: "Days", kind: "number", required: true, min: 0, max: 14 }] }] });
    expect(buildAnswers(b6, { B6: { days_ahead: "5" } }, new Set())).toEqual({ B6: { days_ahead: 5 } });
  });
  it("B7 sends picked KPIs only for 'pick'", () => {
    const b7: GroupView = group({
      questions: [{ id: "B7", prompt: "Finance", status: "ask", fields: [{ key: "show", label: "Show", kind: "select", required: true }, { key: "kpis", label: "KPIs", kind: "multiselect" }] }],
    });
    expect(buildAnswers(b7, { B7: { show: "all", kpis: ["mrr"] } }, new Set())).toEqual({ B7: { show: "all" } });
    expect(buildAnswers(b7, { B7: { show: "pick", kpis: ["mrr"] } }, new Set())).toEqual({ B7: { show: "pick", kpis: ["mrr"] } });
  });
  it("requires required fields before a preview", () => {
    const g = group({ questions: [{ id: "A1", prompt: "q", status: "ask", fields: [{ key: "name", label: "Name", kind: "text", required: true }] }] });
    expect(canPreview(g, { A1: { name: "  " } }, new Set())).toBe(false);
    expect(canPreview(g, { A1: { name: "Pat" } }, new Set())).toBe(true);
  });
});

describe("navigation and labels", () => {
  const gs = [group({ id: "A-1", done: true }), group({ id: "A-2", done: false }), group({ id: "B-1", part: "B", done: false }), group({ id: "B-2", part: "B", done: false })];
  it("moves to the next group not yet visited, never wraps, and ends at the summary", () => {
    expect(nextGroupId(gs, null, new Set())).toBe("A-2");
    expect(nextGroupId(gs, "A-2", new Set(["A-2"]))).toBe("B-1");
    expect(nextGroupId(gs, "B-1", new Set(["A-2", "B-1"]))).toBe("B-2");
    expect(nextGroupId(gs, "B-2", new Set(["A-2", "B-1", "B-2"]))).toBeNull();
    expect(nextGroupId(gs, "A-2", new Set(["B-1"]))).toBe("B-2");
  });
  it("with an existing employee the start skips Part B (summary), but moving on within a session does not", () => {
    expect(nextGroupId(gs, null, new Set(["A-2"]), true)).toBeNull();
    expect(nextGroupId(gs, "B-1", new Set(["B-1"]), true)).toBe("B-2");
  });
  it("walks the real bank through all ten groups to the summary, from nothing and from a stored employee", () => {
    const lane = { laneId: "TST", name: "Test Co", mailboxes: ["ops@example.test"], kpis: ["mrr"], connected: [], policy: { write_actions_allowed: ["email_draft"], store_outbound_drafts: true, llm_allowed_categories: ["email"] }, financeView: true };
    const ctx = { home: "TST", current: "TST", lanes: [lane], timezones: ["UTC"] };
    const groups = buildGroups({ about_me: null, preferences: null, work: null, pa: null }, null, ctx);
    const seen: string[] = [];
    let id = nextGroupId(groups, null, new Set());
    const visited = new Set<string>();
    while (id !== null && seen.length < 20) {
      seen.push(id);
      visited.add(id);
      id = nextGroupId(groups, id, visited);
    }
    expect(seen).toEqual(["A-1", "A-2", "A-3", "A-4", "B-1", "B-2", "B-3", "B-4", "B-5", "B-6"]);
    // All Part A sections known: A-groups are not asked again; with no employee Part B still is.
    const known = "Filled in.";
    const docs = {
      about_me: ["Name and how to address me", "Scope of this brain", "Timezone", "Routine and constraints", "First task for Jarvis"].reduce((b, h) => setSection(b, h, known), TEMPLATE_FILES["Context/About-Me.md"] as string),
      preferences: ["Writing", "Delivery of information", "Always ask me first", "Never do"].reduce((b, h) => setSection(b, h, known), TEMPLATE_FILES["Context/Preferences.md"] as string),
      work: ["My role here", "What the company does", "Key people"].reduce((b, h) => setSection(b, h, known), TEMPLATE_FILES["Context/Work.md"] as string),
      pa: null,
    };
    const filled = buildGroups(docs, null, ctx);
    expect(filled.filter((g) => g.part === "A").every((g) => g.done)).toBe(true);
    expect(nextGroupId(filled, null, new Set())).toBe("B-1");
  });
  it("labels an issue with the question and field", () => {
    expect(issueLabel({ code: "invalid_answer", path: "A1.name" }, group())).toContain("What should Jarvis call you? (Name)");
  });
  it("recognises typed requests to start the setup, and nothing longer or vaguer", () => {
    expect(isInterviewRequest("Set up my brain")).toBe("setup");
    expect(isInterviewRequest("let's reconfigure my personal assistant")).toBe("assistant");
    expect(isInterviewRequest("change my briefing time to 7")).toBeNull();
    expect(isInterviewRequest("What needs my attention today?")).toBeNull();
    expect(isInterviewRequest(`set up my brain ${"x".repeat(100)}`)).toBeNull();
  });
});

describe("callInterview", () => {
  const calls: unknown[][] = [];
  const stub = (impl: () => Promise<Response>) => vi.stubGlobal("fetch", (...args: unknown[]) => (calls.push(args), impl()));
  afterEach(() => vi.unstubAllGlobals());
  it("returns data on ok, a code and issues on errors, and unavailable when the network fails", async () => {
    stub(async () => Response.json({ ok: true, state: { a: 1 } }));
    expect(await callInterview("PKG", { action: "state" })).toEqual({ ok: true, data: { ok: true, state: { a: 1 } } });
    expect(calls[0]?.[0]).toBe("/api/lanes/PKG/brain/interview");
    stub(async () => Response.json({ error: "invalid_answers", issues: [{ code: "invalid_answer", path: "A1.name" }] }, { status: 422 }));
    expect(await callInterview("PKG", {})).toEqual({ ok: false, code: "invalid_answers", issues: [{ code: "invalid_answer", path: "A1.name" }] });
    stub(async () => new Response("", { status: 401 }));
    expect(await callInterview("PKG", {})).toEqual({ ok: false, code: "session" });
    stub(async () => {
      throw new Error("net");
    });
    expect(await callInterview("PKG", {})).toEqual({ ok: false, code: "unavailable" });
  });
});
