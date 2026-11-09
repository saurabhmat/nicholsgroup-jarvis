import { describe, expect, it, vi } from "vitest";
import { ABOUT_ME_PATH, WORK_PATH } from "../domain/index";
import type { InterviewCtx, LaneInfo } from "../interview/index";
import { BrainError } from "./errors";
import { InterviewRefusal, activateEmployee, completeGroup, confirmSetup, loadInterviewState, loadProgress, proposeGroup, saveGroup, type InterviewEnv } from "./interview";
import { createBrainStore, EmployeeConfigError, type BrainDb } from "./store";

// A stateful fake of the core.brain_* wrappers. Every rpc is recorded, so a test can prove what was (not) written.
type Row = Record<string, unknown>;
function backend() {
  const docs = new Map<string, { id: string; body: string; version: number }>();
  let employee: Row | null = null;
  const completed = new Set<string>();
  const fail = { completions: false, complete: false };
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const kindOf = (p: string) => (p === ABOUT_ME_PATH ? "about_me" : p === "Context/Preferences.md" ? "preferences" : "context");
  const rpc = async (fn: string, a: Record<string, unknown>) => {
    calls.push({ fn, args: a });
    const key = `${String(a.p_lane)}|${String(a.p_path)}`;
    switch (fn) {
      case "brain_document_get": {
        const d = docs.get(key);
        return { data: d ? [{ id: d.id, path: a.p_path, kind: kindOf(String(a.p_path)), body_md: d.body, version: d.version, updated_at: "2026-11-08T00:00:00Z", is_mine: true }] : [], error: null };
      }
      case "brain_document_save": {
        const d = docs.get(key);
        if ((d?.version ?? 0) !== a.p_if_version) return { data: null, error: { code: "40001", message: "version_conflict" } };
        const next = { id: d?.id ?? `00000000-0000-4000-8000-0000000000${String(docs.size).padStart(2, "0")}`, body: String(a.p_body), version: (d?.version ?? 0) + 1 };
        docs.set(key, next);
        return { data: [{ o_id: next.id, o_version: next.version, o_updated_at: "2026-11-08T00:00:00Z" }], error: null };
      }
      case "brain_section_completions":
        if (fail.completions) return { data: null, error: { code: "XX000", message: "down" } };
        return { data: [...completed].map((section_id) => ({ section_id, completed_at: "2026-11-09T00:00:00Z" })), error: null };
      case "brain_section_complete":
        if (fail.complete) return { data: null, error: { code: "XX000", message: "down" } };
        for (const id of a.p_sections as string[]) completed.add(id);
        return { data: (a.p_sections as string[]).map((o_section_id) => ({ o_section_id, o_completed_at: "2026-11-09T00:00:00Z" })), error: null };
      case "brain_employees_list":
        return { data: employee ? [employee] : [], error: null };
      case "brain_employee_save": {
        if (((employee?.version as number | undefined) ?? 0) !== a.p_if_version) return { data: null, error: { code: "40001", message: "version_conflict" } };
        employee = { id: "00000000-0000-4000-8000-00000000e001", is_mine: true, role_key: a.p_role_key, name: a.p_name, instructions_md: a.p_instructions_md, config: a.p_config, status: a.p_status, version: ((employee?.version as number | undefined) ?? 0) + 1, updated_at: "2026-11-08T00:00:00Z" };
        return { data: [{ o_id: employee.id, o_version: employee.version, o_updated_at: "2026-11-08T00:00:00Z" }], error: null };
      }
      default:
        return { data: null, error: { code: "XX000", message: "unexpected" } };
    }
  };
  const db = { schema: () => ({ rpc }) } as unknown as BrainDb;
  return { docs, calls, completed, fail, employee: () => employee, db };
}

const lane: LaneInfo = {
  laneId: "TST",
  name: "Test Co",
  mailboxes: ["ops@example.test"],
  kpis: ["mrr"],
  connected: [],
  policy: { write_actions_allowed: ["email_draft"], store_outbound_drafts: true, llm_allowed_categories: ["email"] },
  financeView: true,
};
const ctx: InterviewCtx = { home: "TST", current: "TST", lanes: [lane], timezones: ["America/New_York", "UTC"] };

function env(b = backend(), over: Partial<InterviewCtx> = {}): { env: InterviewEnv; b: ReturnType<typeof backend> } {
  const store = createBrainStore({ clientFor: async () => b.db, laneSettingsFor: async (l) => (l === "TST" ? { mailboxes: ["ops@example.test"], kpis: ["mrr"] } : null) });
  return { env: { store, ctx: { ...ctx, ...over }, now: new Date("2026-11-08T12:00:00Z") }, b };
}
const must = <T,>(v: T | null | undefined): T => {
  if (v === null || v === undefined) throw new Error("missing");
  return v;
};
const writes = (b: ReturnType<typeof backend>) => b.calls.filter((c) => /_save$/.test(c.fn));

describe("nothing persists without Save", () => {
  it("state and propose write nothing", async () => {
    const { env: e, b } = env();
    await loadInterviewState(e);
    const p = await proposeGroup(e, "A-1", { A1: { name: "Pat" }, A2: { scope: "work" } });
    expect(p.changes).toHaveLength(1);
    expect(p.changes[0]).toMatchObject({ kind: "document", path: ABOUT_ME_PATH, baseVersion: 0 });
    const added = (p.changes[0] as { diff: { type: string; text: string }[] }).diff.filter((l) => l.type === "add").map((l) => l.text);
    expect(added).toEqual(["Pat", "Work"]);
    await proposeGroup(e, "B-1", { B2: { mailboxes: ["TST|ops@example.test"] } });
    expect(writes(b)).toEqual([]);
    expect(b.docs.size).toBe(0);
    expect(b.employee()).toBeNull();
  });

  it("Save writes exactly the proposed text, through the document writer, in the right lane", async () => {
    const { env: e, b } = env();
    const answers = { A1: { name: "Pat" }, A2: { scope: "both" } };
    const p = await proposeGroup(e, "A-1", answers);
    await saveGroup(e, "A-1", answers, p.proposalId);
    expect(writes(b)).toEqual([{ fn: "brain_document_save", args: expect.objectContaining({ p_lane: "TST", p_path: ABOUT_ME_PATH, p_if_version: 0 }) }]);
    expect(b.docs.get(`TST|${ABOUT_ME_PATH}`)?.body).toContain("## Name and how to address me\nPat");
    expect(b.docs.get(`TST|${ABOUT_ME_PATH}`)?.body).toContain("Both work and personal");
    // Untouched sections keep their template text.
    expect(b.docs.get(`TST|${ABOUT_ME_PATH}`)?.body).toContain("## Goals right now\nNot provided.");
  });

  it("Save refuses when the answers differ from the proposal the user saw, or the page changed since", async () => {
    const { env: e, b } = env();
    const p = await proposeGroup(e, "A-1", { A1: { name: "Pat" } });
    await expect(saveGroup(e, "A-1", { A1: { name: "Someone else" } }, p.proposalId)).rejects.toMatchObject({ code: "proposal_changed" });
    await expect(saveGroup(e, "A-1", { A1: { name: "Pat" } }, "0".repeat(64))).rejects.toBeInstanceOf(InterviewRefusal);
    expect(writes(b)).toEqual([]);
    await saveGroup(e, "A-1", { A1: { name: "Pat" } }, p.proposalId);
    // The same proposal id is stale after the page moved on (version 0 -> 1).
    await expect(saveGroup(e, "A-1", { A1: { name: "Pat" } }, p.proposalId)).rejects.toBeInstanceOf(InterviewRefusal);
  });

  it("a stale write is a version conflict from the writer, not an overwrite", async () => {
    const { env: e, b } = env();
    const p = await proposeGroup(e, "A-4", { A8: { writing: "Short and warm" } });
    // Someone saves the same page between the proposal and Save, with the digest still matching a re-plan: simulate by racing the writer.
    const original = b.db.schema("core").rpc;
    (b.db as unknown as { schema: () => { rpc: unknown } }).schema = () => ({
      rpc: async (fn: string, a: Record<string, unknown>) => (fn === "brain_document_save" ? { data: null, error: { code: "40001", message: "version_conflict" } } : (original as (f: string, x: Record<string, unknown>) => unknown)(fn, a)),
    });
    await expect(saveGroup(e, "A-4", { A8: { writing: "Short and warm" } }, p.proposalId)).rejects.toMatchObject({ code: "version_conflict" });
  });

  it("an unchanged group proposes nothing", async () => {
    const { env: e } = env();
    const answers = { A8: { writing: "Short and warm" } };
    await saveGroup(e, "A-4", answers, (await proposeGroup(e, "A-4", answers)).proposalId);
    const again = await proposeGroup(e, "A-4", answers);
    expect(again.changes).toEqual([]);
  });
});

describe("refusals before any plan", () => {
  it("credentials, SSN-like numbers and Nichols Law content are not planned", async () => {
    const { env: e, b } = env();
    await expect(proposeGroup(e, "A-1", { A3: { first_task: "use key sk_live_abcdefghijklmnop1234" } })).rejects.toMatchObject({ code: "secret" });
    await expect(proposeGroup(e, "A-1", { A3: { first_task: "my SSN 123-45-6789" } })).rejects.toMatchObject({ code: "sensitive_ssn" });
    await expect(proposeGroup(e, "A-3", { A6: { company: "Handles Nichols Law client matter 12", people: "x" } })).rejects.toMatchObject({ code: "nichols_law" });
    expect(writes(b)).toEqual([]);
  });
  it("answers for a question outside the group, a skipped one or an unknown group are refused", async () => {
    const { env: e } = env();
    await expect(proposeGroup(e, "A-1", { A8: { writing: "x" } })).rejects.toMatchObject({ name: "AnswerError" });
    await expect(proposeGroup(e, "B-3", { B7: { show: "all" }, B6: { days_ahead: 3 } })).resolves.toBeDefined();
    const { env: noFin } = env(undefined, { lanes: [{ ...lane, financeView: false }] });
    await expect(proposeGroup(noFin, "B-3", { B7: { show: "all" } })).rejects.toMatchObject({ name: "AnswerError" });
    await expect(proposeGroup(e, "Z-9", {})).rejects.toBeInstanceOf(InterviewRefusal);
  });
  it("a stored employee config is validated with lane_config: an unknown mailbox cannot be proposed", async () => {
    const { env: e } = env();
    await expect(proposeGroup(e, "B-1", { B2: { mailboxes: ["TST|stranger@example.test"] } })).rejects.toMatchObject({ name: "AnswerError" });
  });
});

describe("employee flow: groups -> draft -> confirm -> activate", () => {
  it("saves the draft profile per group, keeps it a draft, then activates on the user's click without a test briefing", async () => {
    const { env: e, b } = env();
    const a1 = { B1: { objective: "Do not let me miss board mail" }, B2: { mailboxes: ["TST|ops@example.test"] }, B3: { include: { "TST|ops@example.test": "board; invoices" } } };
    await saveGroup(e, "B-1", a1, (await proposeGroup(e, "B-1", a1)).proposalId);
    expect(b.employee()).toMatchObject({ status: "draft", version: 1, role_key: "personal_assistant" });
    const a5 = { B12: { target_words: "250", max_attention: 4, sections: ["coverage", "attention", "calendar"] }, B13: { max_drafts: 0 }, B14: { voice: "plain and brief" } };
    await saveGroup(e, "B-5", a5, (await proposeGroup(e, "B-5", a5)).proposalId);
    const emp = must(b.employee());
    expect(emp.version).toBe(2);
    expect(emp.status).toBe("draft");
    const cfg = emp.config as { sources: { mail: { mailbox: string; include: string[] }[] }; output: { max_drafts: number; target_words: number }; permissions: { propose: string[] }; lanes: string[] };
    expect(cfg.sources.mail).toMatchObject([{ mailbox: "ops@example.test", include: ["board", "invoices"] }]);
    expect(cfg.output).toMatchObject({ max_drafts: 0, target_words: 250 });
    expect(cfg.permissions.propose).toEqual([]);
    expect(cfg.lanes).toEqual(["TST"]);
    const prose = String(emp.instructions_md);
    expect(prose).toContain("Do not let me miss board mail");
    expect(prose).toContain("Voice: plain and brief");
    expect(prose).toContain("Status: draft.");
    expect(prose).toContain("Up to 0 per briefing");
    expect(prose).toContain("Target length: 250 words");
    expect(prose).toContain("1. ops@example.test (Test Co): board; invoices");

    const state = await loadInterviewState(e);
    expect(state.employee).toMatchObject({ status: "draft", version: 2 });
    expect(state.testBriefing).toEqual({ available: false, message: "Your test briefing arrives with the daily briefing (T-213)." });
    const confirmed = await confirmSetup(e);
    expect(confirmed.employee.permissions[0]).toMatchObject({ lane: "TST", allowed: [] });

    await activateEmployee(e);
    expect(b.employee()).toMatchObject({ status: "active", version: 3 });
    expect(String(must(b.employee()).instructions_md)).toContain("Status: active.");
    await expect(activateEmployee(e)).rejects.toMatchObject({ code: "nothing_to_activate" });
  });

  it("confirm and activate need a saved profile; a tampered stored config fails closed", async () => {
    const { env: e, b } = env();
    await expect(confirmSetup(e)).rejects.toMatchObject({ code: "no_employee" });
    await expect(activateEmployee(e)).rejects.toMatchObject({ code: "no_employee" });
    const a = { B2: { mailboxes: ["TST|ops@example.test"] } };
    await saveGroup(e, "B-1", a, (await proposeGroup(e, "B-1", a)).proposalId);
    // Someone writes a config that widens permissions or names an unknown mailbox straight through the rpc.
    const mail = (must(b.employee()).config as { sources: { mail: { mailbox: string }[] } }).sources.mail[0];
    if (mail) mail.mailbox = "stranger@example.test";
    await expect(confirmSetup(e)).rejects.toBeInstanceOf(EmployeeConfigError);
    await expect(activateEmployee(e)).rejects.toBeInstanceOf(EmployeeConfigError);
    expect(must(b.employee()).status).toBe("draft");
  });

  it("the draft permissions are the lane ceiling: a lane without draft policy allows nothing", async () => {
    const strict: LaneInfo = { ...lane, policy: { write_actions_allowed: [], store_outbound_drafts: false, llm_allowed_categories: ["email"] } };
    const { env: e } = env(undefined, { lanes: [strict] });
    const a = { B2: { mailboxes: ["TST|ops@example.test"] } };
    await saveGroup(e, "B-1", a, (await proposeGroup(e, "B-1", a)).proposalId);
    const s = await loadInterviewState(e);
    expect(s.employee?.permissions[0]?.allowed).toEqual([]);
    expect(s.employee?.permissions[0]?.denied).toEqual([{ type: "email.save_draft", reason: "lane_policy" }]);
    // B13 is skipped here (no draft policy), so it cannot be answered.
    await expect(proposeGroup(e, "B-5", { B13: { max_drafts: 3 } })).rejects.toMatchObject({ name: "AnswerError" });
  });
});

describe("the Work page", () => {
  it("is created in the current lane from the template with the lane's name, and the person is the owner of it", async () => {
    const { env: e, b } = env();
    const a = { A5: { role: "Owner" }, A6: { company: "Sells widgets", people: "Ana, ops" } };
    await saveGroup(e, "A-3", a, (await proposeGroup(e, "A-3", a)).proposalId);
    const body = b.docs.get(`TST|${WORK_PATH}`)?.body ?? "";
    expect(body).toContain("## My role here\nOwner");
    expect(body).toContain("## Key people\nAna, ops");
  });
  it("a store error from a lane the user cannot open is a refusal, not a write", async () => {
    const b = backend();
    const store = createBrainStore({
      clientFor: async () => {
        throw Object.assign(new Error("x"), { name: "LaneAccessError", reason: "not_member" });
      },
      laneSettingsFor: async () => null,
    });
    await expect(loadInterviewState({ store, ctx, now: new Date() })).rejects.toBeInstanceOf(BrainError);
    expect(b.calls).toEqual([]);
  });
});

describe("Nichols Law screen", () => {
  const forms = ["Nichols Law", "nicholslaw.com", "Nichols-Law", "NICHOLS_LAW", "Nichols & Law", "Nichols.Law", "Nic\u200bhols\u200d Law", "Nichols\u00adLaw", "\uFEFFNichols\u2060 law", "\uFF2E\uFF49chols Law"];
  it("refuses every spelling in a text answer", async () => {
    const { env: e, b } = env();
    for (const f of forms) {
      await expect(proposeGroup(e, "A-3", { A6: { company: `We act for ${f} matters`, people: "x" } }), f).rejects.toMatchObject({ code: "nichols_law" });
    }
    expect(writes(b)).toEqual([]);
  });
  it("refuses it in a VIP sender and in a record key too", async () => {
    const { env: e } = env();
    await expect(proposeGroup(e, "B-2", { B4: { vip: "ceo@nicholslaw.com" } })).rejects.toMatchObject({ code: "nichols_law" });
    await expect(proposeGroup(e, "B-1", { B3: { include: { "TST|nichols-law@example.test": "x" } } })).rejects.toMatchObject({ code: "nichols_law" });
  });
  it("does not refuse ordinary text", async () => {
    const { env: e } = env();
    await expect(proposeGroup(e, "A-3", { A6: { company: "Nick and Nicole work on the law review", people: "x" } })).resolves.toBeDefined();
  });
});

describe("timezone follows into the employee", () => {
  it("A4 on a saved employee also changes config.timezone, in one proposal", async () => {
    const { env: e, b } = env();
    const a = { B2: { mailboxes: ["TST|ops@example.test"] } };
    await saveGroup(e, "B-1", a, (await proposeGroup(e, "B-1", a)).proposalId);
    const t = { A4: { timezone: "UTC" } };
    const p = await proposeGroup(e, "A-2", t);
    expect(p.changes.map((c) => c.kind)).toEqual(["document", "employee"]);
    const emp = p.changes[1] as { settings: { path: string; before: string; after: string }[] };
    expect(emp.settings).toEqual([{ path: "timezone", before: "America/New_York", after: "UTC" }]);
    await saveGroup(e, "A-2", t, p.proposalId);
    expect((must(b.employee()).config as { timezone: string }).timezone).toBe("UTC");
    expect(b.docs.get(`TST|${ABOUT_ME_PATH}`)?.body).toContain("## Timezone\nUTC");
  });
});

describe("a stored profile that is not valid", () => {
  it("is never replaced silently: the card says so, and it is shown in the state", async () => {
    const { env: e, b } = env();
    const a = { B2: { mailboxes: ["TST|ops@example.test"] } };
    await saveGroup(e, "B-1", a, (await proposeGroup(e, "B-1", a)).proposalId);
    (must(b.employee()).config as Record<string, unknown>).surprise = true; // written straight through the rpc
    expect((await loadInterviewState(e)).employee?.invalid).toBe(true);
    const n = { B4: { vip: "ceo@example.test" } };
    const p = await proposeGroup(e, "B-2", n);
    expect(p.changes[0]).toMatchObject({ kind: "employee", resetsInvalid: true });
    await saveGroup(e, "B-2", n, p.proposalId);
    expect((await loadInterviewState(e)).employee?.invalid).toBe(false);
  });
  it("an answer equal to the defaults still proposes the reset", async () => {
    const { env: e, b } = env();
    const a = { B11: { delivery: ["in_app", "push"] } };
    await saveGroup(e, "B-4", a, (await proposeGroup(e, "B-4", a)).proposalId);
    (must(b.employee()).config as Record<string, unknown>).surprise = true;
    expect((await proposeGroup(e, "B-4", a)).changes).toHaveLength(1);
  });
});

describe("proposal digest", () => {
  it("does not depend on the date, so a proposal made before midnight still saves after it", async () => {
    const { env: e } = env();
    const a = { B2: { mailboxes: ["TST|ops@example.test"] } };
    const p = await proposeGroup(e, "B-1", a);
    const later = { ...e, now: new Date("2026-11-09T04:30:00Z") };
    await expect(saveGroup(later, "B-1", a, p.proposalId)).resolves.toEqual({ saved: 1, completed: true });
  });
});

describe("stored section completion (T-227)", () => {
  const completeCalls = (b: ReturnType<typeof backend>) => b.calls.filter((c) => c.fn === "brain_section_complete");
  const doneIds = async (e: InterviewEnv) => (await loadInterviewState(e)).groups.filter((g) => g.complete).map((g) => g.id);

  const seedPreT227 = async (e: InterviewEnv, b: ReturnType<typeof backend>) => {
    const answers = { A1: { name: "Pat" }, A2: { scope: "work" }, A3: { first_task: "Tidy my week" } };
    const p = await proposeGroup(e, "A-1", answers);
    await saveGroup(e, "A-1", answers, p.proposalId);
    b.completed.clear(); // answers exist, but no completion rows (as before T-227)
    b.calls.length = 0;
  };

  it("loadProgress never writes, not even the backfill; it shows the derived value until rows exist", async () => {
    const { env: e, b } = env();
    await seedPreT227(e, b);
    const p = await loadProgress(e);
    expect(p.filter((g) => g.complete).map((g) => g.id)).toEqual(["A-1"]);
    expect(completeCalls(b)).toEqual([]);
    expect(b.completed.size).toBe(0);
  });

  it("the first Save backfills older sections in the same write, before the new one", async () => {
    const { env: e, b } = env();
    await seedPreT227(e, b);
    const answers = { A8: { writing: "Short" } };
    const p = await proposeGroup(e, "A-4", answers);
    await saveGroup(e, "A-4", answers, p.proposalId);
    expect(completeCalls(b)).toHaveLength(1);
    expect(completeCalls(b)[0]?.args.p_sections).toEqual(["A-1", "A-4"]);
    expect([...b.completed].sort()).toEqual(["A-1", "A-4"]);
  });

  it("Nothing to add backfills first too", async () => {
    const { env: e, b } = env();
    await seedPreT227(e, b);
    await completeGroup(e, "B-6");
    expect([...b.completed].sort()).toEqual(["A-1", "B-6"]);
  });

  it("a backfill that fails on a state load is logged (class only) and a later Save still backfills older sections", async () => {
    const { env: e, b } = env();
    await seedPreT227(e, b);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    b.fail.complete = true;
    await loadInterviewState(e); // transient failure while backfilling
    expect(log.mock.calls.flat().join(" ")).toContain("completion backfill failed");
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/Pat|Tidy/);
    expect(b.completed.size).toBe(0);
    b.fail.complete = false;
    const answers = { A8: { writing: "Short" } };
    const p = await proposeGroup(e, "A-4", answers);
    await saveGroup(e, "A-4", answers, p.proposalId);
    expect([...b.completed].sort()).toEqual(["A-1", "A-4"]);
    log.mockRestore();
  });

  it("if only the completion write fails after a save, the answers are saved and the result says completed: false", async () => {
    const { env: e, b } = env();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const answers = { A1: { name: "Pat" }, A2: { scope: "work" } };
    const p = await proposeGroup(e, "A-1", answers);
    b.fail.complete = true;
    const r = await saveGroup(e, "A-1", answers, p.proposalId);
    expect(r).toEqual({ saved: 1, completed: false });
    expect(b.docs.get(`TST|${ABOUT_ME_PATH}`)?.body).toContain("Pat");
    expect(log.mock.calls.flat().join(" ")).toContain("completion not recorded after a save");
    b.fail.complete = false;
    const again = await proposeGroup(e, "A-1", answers);
    expect(again.changes).toEqual([]);
    expect(await saveGroup(e, "A-1", answers, again.proposalId)).toEqual({ saved: 0, completed: true });
    log.mockRestore();
  });

  it("chat routing skips finished sections (nextGroupId) but they stay listed and complete", async () => {
    const { env: e } = env();
    await completeGroup(e, "A-1");
    const s = await loadInterviewState(e);
    expect(s.groups.find((g) => g.id === "A-1")?.complete).toBe(true);
    expect(s.nextGroupId).not.toBe("A-1");
  });

  it("an untouched brain has no complete section, and reading state records nothing", async () => {
    const { env: e, b } = env();
    expect(await doneIds(e)).toEqual([]);
    expect((await loadProgress(e)).every((g) => !g.complete)).toBe(true);
    expect(completeCalls(b)).toEqual([]);
  });

  it("Save completes exactly that section", async () => {
    const { env: e, b } = env();
    const answers = { A1: { name: "Pat" }, A2: { scope: "work" } };
    const p = await proposeGroup(e, "A-1", answers);
    expect(b.completed.size).toBe(0); // the preview records nothing
    await saveGroup(e, "A-1", answers, p.proposalId);
    expect([...b.completed]).toEqual(["A-1"]);
    expect(await doneIds(e)).toEqual(["A-1"]);
  });

  it("keeping every default and clicking Save still completes the section and writes no brain change", async () => {
    const { env: e, b } = env();
    const answers = { A8: { writing: "Short and warm" } };
    const first = await proposeGroup(e, "A-4", answers);
    await saveGroup(e, "A-4", answers, first.proposalId);
    b.completed.clear();
    const docWrites = writes(b).length;
    const again = await proposeGroup(e, "A-4", answers);
    expect(again.changes).toEqual([]); // nothing would change
    await saveGroup(e, "A-4", answers, again.proposalId);
    expect(writes(b).length).toBe(docWrites); // no new brain write
    expect(await doneIds(e)).toEqual(["A-4"]);
  });

  it("Nothing to add completes the section, writes no page or profile, and leaves its questions unanswered", async () => {
    const { env: e, b } = env();
    await completeGroup(e, "B-3");
    expect(writes(b)).toEqual([]);
    expect(b.docs.size).toBe(0);
    expect(b.employee()).toBeNull();
    const state = await loadInterviewState(e);
    expect(state.groups.filter((g) => g.complete).map((g) => g.id)).toEqual(["B-3"]);
    const b3 = state.groups.find((g) => g.id === "B-3");
    expect(b3?.questions.every((q) => q.status !== "known" || q.known === undefined)).toBe(true);
    expect(b3?.questions.find((q) => q.id === "B6")?.known).toBeUndefined(); // still "Not provided"
  });

  it("refuses a section that is not in the bank, before any call", async () => {
    const { env: e, b } = env();
    await expect(completeGroup(e, "Z-9")).rejects.toMatchObject({ code: "unknown_group" });
    await expect(e.store.completeSections("TST", ["A-1", "nope"])).rejects.toBeInstanceOf(BrainError);
    expect(completeCalls(b)).toEqual([]);
  });

  it("backfills answers saved before completion existed, once, idempotently", async () => {
    const { env: e, b } = env();
    // A page as the pre-T-227 interview left it: A-1's questions answered, no completion rows.
    const answers = { A1: { name: "Pat" }, A2: { scope: "work" }, A3: { first_task: "Tidy my week" } };
    const p = await proposeGroup(e, "A-1", answers);
    await saveGroup(e, "A-1", answers, p.proposalId);
    b.completed.clear(); // as if the rows never existed
    b.calls.length = 0;
    expect(await doneIds(e)).toEqual(["A-1"]); // backfilled from the derived rule
    expect(completeCalls(b)).toHaveLength(1);
    expect(await doneIds(e)).toEqual(["A-1"]);
    expect(completeCalls(b)).toHaveLength(1); // second load: rows exist, no second write
  });

  it("does not backfill once the user has completion rows (the stored fact is the only rule)", async () => {
    const { env: e, b } = env();
    const answers = { A1: { name: "Pat" }, A2: { scope: "work" }, A3: { first_task: "x" } };
    const p = await proposeGroup(e, "A-1", answers);
    await saveGroup(e, "A-1", answers, p.proposalId);
    b.completed.clear();
    b.completed.add("B-6");
    expect(await doneIds(e)).toEqual(["B-6"]);
  });

  it("a completion that cannot be read shows nothing complete (fail safe)", async () => {
    const { env: e, b } = env();
    b.completed.add("A-1");
    b.fail.completions = true;
    expect(await doneIds(e)).toEqual([]);
    expect((await loadProgress(e)).every((g) => !g.complete)).toBe(true);
  });
});
