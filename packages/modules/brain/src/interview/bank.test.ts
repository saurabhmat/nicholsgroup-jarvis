import { describe, expect, it } from "vitest";
import { employeeConfigSchema } from "../domain/employee-config";
import { TEMPLATE_FILES } from "../domain/templates";
import { SECTION_ORDER } from "./answers";
import { GROUPS, MAX_QUESTIONS_PER_GROUP, QUESTIONS, TEST_BRIEFING_AVAILABLE, questionById } from "./bank";
import { getSection } from "./doc-edit";

// Walks a Zod 4 schema by a dotted path (`[]` = array element) through defaults, prefaults, pipes and optionals.
type Def = { type: string; shape?: Record<string, unknown>; element?: unknown; innerType?: unknown; in?: unknown };
const defOf = (s: unknown): Def => (s as { _zod: { def: Def } })._zod.def;
function unwrap(s: unknown): unknown {
  let cur = s;
  for (;;) {
    const d = defOf(cur);
    if (d.type === "default" || d.type === "prefault" || d.type === "optional" || d.type === "nullable") cur = d.innerType;
    else if (d.type === "pipe") cur = d.in;
    else return cur;
  }
}
function schemaHasPath(path: string): boolean {
  let cur: unknown = employeeConfigSchema;
  for (const raw of path.split(".")) {
    const isArray = raw.endsWith("[]");
    const key = isArray ? raw.slice(0, -2) : raw;
    const d = defOf(unwrap(cur));
    if (d.type !== "object" || d.shape === undefined || !(key in d.shape)) return false;
    cur = d.shape[key];
    if (isArray) {
      const a = defOf(unwrap(cur));
      if (a.type !== "array") return false;
      cur = a.element;
    }
  }
  return true;
}

describe("question bank (docs/specs/brain-interview.md)", () => {
  it("every config.* target is a path of employeeConfigSchema", () => {
    const targets = QUESTIONS.flatMap((q) => q.configTargets);
    expect(targets.length).toBeGreaterThan(20);
    for (const t of targets) {
      expect(t.startsWith("config."), t).toBe(true);
      expect(schemaHasPath(t.slice("config.".length)), t).toBe(true);
    }
    // The walker itself rejects a path that is not in the schema.
    expect(schemaHasPath("sources.mail[].nope")).toBe(false);
    expect(schemaHasPath("lane_policies")).toBe(false);
  });

  it("never targets lane_config or lane_policies", () => {
    for (const q of QUESTIONS) for (const t of q.configTargets) expect(t).not.toMatch(/lane_(config|policies)/);
  });

  it("has at most 3 questions per step, and every question is in exactly one group", () => {
    for (const g of GROUPS) {
      expect(g.questionIds.length).toBeLessThanOrEqual(MAX_QUESTIONS_PER_GROUP);
      expect(g.questionIds.length).toBeGreaterThan(0);
    }
    for (const q of QUESTIONS) {
      expect(GROUPS.filter((g) => g.questionIds.includes(q.id)).map((g) => g.id)).toEqual([q.group]);
    }
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(QUESTIONS.length);
    // The spec's bank: A1-A10 and B1-B15, none dropped.
    const ids = QUESTIONS.map((q) => q.id).sort();
    const expected = [...Array.from({ length: 10 }, (_, i) => `A${String(i + 1)}`), ...Array.from({ length: 15 }, (_, i) => `B${String(i + 1)}`)].sort();
    expect(ids).toEqual(expected);
  });

  it("every page target names a real section of its template", () => {
    const body = { about_me: TEMPLATE_FILES["Context/About-Me.md"], preferences: TEMPLATE_FILES["Context/Preferences.md"], work: TEMPLATE_FILES["Context/Work.md"], pa: TEMPLATE_FILES["Employees/Personal-Assistant.md"] };
    for (const q of QUESTIONS) {
      for (const t of [...q.targets, ...q.fields.flatMap((f) => (f.into ? [f.into] : []))]) {
        const section = getSection(body[t.doc] as string, t.section);
        expect(section, `${q.id} ${t.section}`).not.toBeNull();
        if (t.line) expect(section, `${q.id} ${t.line}`).toContain(t.line);
      }
    }
  });

  it("every page target of a Part A group is the same document", () => {
    for (const g of GROUPS.filter((x) => x.part === "A")) {
      const docs = new Set(g.questionIds.flatMap((id) => questionById(id)?.targets.map((t) => t.doc) ?? []));
      expect(docs.size, g.id).toBe(1);
    }
  });

  it("asks for no passwords, codes, keys or account numbers", () => {
    for (const q of QUESTIONS) expect(`${q.prompt} ${q.fields.map((f) => f.label).join(" ")}`).not.toMatch(/password|passcode|api key|secret|account number|routing number|card number/i);
  });

  it("section names match employeeConfigSchema", () => {
    const parsed = employeeConfigSchema.parse({ lanes: ["PKG"], output: { sections: [...SECTION_ORDER] } });
    expect(parsed.output.sections).toEqual([...SECTION_ORDER]);
    expect(() => employeeConfigSchema.parse({ lanes: ["PKG"], output: { sections: ["bogus"] } })).toThrow();
  });

  it("keeps the test briefing behind the T-213 check", () => {
    expect(TEST_BRIEFING_AVAILABLE).toBe(false);
    expect(questionById("B13")?.skip).toBe("no_drafts");
  });
});

describe("section ids match the database (T-227)", () => {
  it("brain.valid_section lists exactly the bank's group ids", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "supabase", "core", "supabase", "migrations", "20261109090000_brain_section_completion.sql");
    const sql = readFileSync(file, "utf8");
    const listed = [...(/array\[([^\]]+)\]/.exec(sql)?.[1] ?? "").matchAll(/'([A-Z]-\d+)'/g)].map((m) => m[1]);
    expect(listed).toEqual(GROUPS.map((g) => g.id));
  });
});
