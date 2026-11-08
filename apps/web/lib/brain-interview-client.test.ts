import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupView } from "@nichols/brain/interview";
import { activeQuestions, buildAnswers, callInterview, canPreview, initialValues, isInterviewRequest, issueLabel, nextGroupId } from "./brain-interview-client";

const group = (over: Partial<GroupView> = {}): GroupView => ({
  id: "A-1",
  part: "A",
  title: "About you",
  saves: "Context/About-Me.md",
  done: false,
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
  const gs = [group({ id: "A-1", done: true }), group({ id: "A-2", done: false }), group({ id: "B-1", done: false })];
  it("moves to the next group that is not done or skipped, then wraps, then null", () => {
    expect(nextGroupId(gs, null, new Set())).toBe("A-2");
    expect(nextGroupId(gs, "A-2", new Set())).toBe("B-1");
    expect(nextGroupId(gs, "B-1", new Set())).toBe("A-2");
    expect(nextGroupId(gs, "A-2", new Set(["A-2", "B-1"]))).toBeNull();
  });
  it("labels an issue with the question and field", () => {
    expect(issueLabel({ code: "invalid_answer", path: "A1.name" }, group())).toContain("What should Jarvis call you? (Name)");
  });
  it("recognises typed requests to start the setup, and nothing longer or vaguer", () => {
    expect(isInterviewRequest("Set up my brain")).toBe("setup");
    expect(isInterviewRequest("let's reconfigure my personal assistant")).toBe("assistant");
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
