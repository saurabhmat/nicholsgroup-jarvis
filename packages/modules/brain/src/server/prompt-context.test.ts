import { describe, expect, it, vi } from "vitest";
import { buildEmployeePrompt, loadBrainPromptContext, type PromptStore } from "./prompt-context";
import { EmployeeConfigError } from "./store";
import { employeeConfigSchema } from "../domain/index";
import { BrainError } from "./errors";

const ME = "00000000-0000-4000-8000-000000000001";
type Doc = { path: string; kind: string; isMine: boolean; body: string; updatedAt: string; version: number; id: string };
const d = (lane: string, path: string, kind: string, isMine = true, body = `${lane}:${path}`): Doc & { lane: string } => ({ lane, path, kind, isMine, body, updatedAt: "2026-11-01T00:00:00Z", version: 1, id: "i" });

function store(docs: (Doc & { lane: string })[], home: string | null = "PKG", unreadable: string[] = []) {
  const reads: string[] = [];
  const s = {
    findHomeLane: vi.fn(async () => home),
    listDocuments: vi.fn(async (lane: string) => {
      if (unreadable.includes(lane)) throw new Error("forbidden");
      return docs.filter((x) => x.lane === lane && (x.isMine || !["about_me", "preferences"].includes(x.kind)));
    }),
    getDocument: vi.fn(async (lane: string, path: string) => {
      reads.push(`${lane}:${path}`);
      if (unreadable.includes(lane)) throw new Error("forbidden");
      return docs.find((x) => x.lane === lane && x.path === path) ?? null;
    }),
  };
  return { s: s as unknown as PromptStore, reads };
}

describe("loadBrainPromptContext", () => {
  it("About-Me and Preferences come from the home lane in a call for another lane (D-28), pages only from the call's lane", async () => {
    const { s, reads } = store([
      d("PKG", "Context/About-Me.md", "about_me"),
      d("PKG", "Context/Preferences.md", "preferences"),
      d("PKG", "Context/Work.md", "context"),
      d("NL", "Context/Work.md", "context"),
    ]);
    const c = await loadBrainPromptContext(s, { userId: ME, lanes: ["NL"] });
    expect(c.brainUser).toEqual({ ownerUserId: ME, aboutMe: "PKG:Context/About-Me.md", preferences: "PKG:Context/Preferences.md" });
    expect(Object.keys(c.laneBrain)).toEqual(["NL"]);
    expect(reads.filter((r) => r.startsWith("PKG:Context/Work"))).toEqual([]); // never read another lane's pages
  });
  it("ignores another owner's copies (getDocument falls back to them)", async () => {
    const { s } = store([d("PKG", "Context/About-Me.md", "about_me", false), d("PKG", "Context/Work.md", "context", false)]);
    const c = await loadBrainPromptContext(s, { userId: ME, lanes: ["PKG"] });
    expect(c.brainUser).toBeNull();
    expect(c.laneBrain).toEqual({});
  });
  it("never returns about_me or preferences as lane pages", async () => {
    const { s } = store([d("PKG", "Context/About-Me.md", "about_me"), d("PKG", "Context/Preferences.md", "preferences")]);
    const c = await loadBrainPromptContext(s, { userId: ME, lanes: ["PKG"] });
    expect(c.laneBrain).toEqual({});
  });
  it("fails soft: an unreadable lane or home lane gives notes, not an error", async () => {
    const { s } = store([d("PKG", "Context/Work.md", "context")], "PKG", ["PKG"]);
    const c = await loadBrainPromptContext(s, { userId: ME, lanes: ["PKG"] });
    expect(c.brainUser).toBeNull();
    expect(c.notes).toEqual(["home_lane_unreadable", "lane_unreadable:PKG"]);
  });
  it("no home lane means no brain_user", async () => {
    const { s } = store([d("PKG", "Context/Work.md", "context")], null);
    const c = await loadBrainPromptContext(s, { userId: ME, lanes: ["PKG"] });
    expect(c.brainUser).toBeNull();
    expect(c.notes).toContain("no_home_lane");
  });
});

describe("buildEmployeePrompt", () => {
  const config = employeeConfigSchema.parse({ lanes: ["PKG", "NL"], sources: { mail: [{ lane: "PKG", mailbox: "boss@example.test", priority: 1, include: ["boards INCLUDEME"] }], external: [{ kind: "web_news", topics: ["TOPICME"] }] }, permissions: { propose: ["email.save_draft", "email.send"] } });
  const emp = { isMine: true, laneId: "PKG", roleKey: "personal_assistant", name: "PA", instructions: "Be brief", config: config as unknown as Record<string, unknown> };
  const policies: Record<string, { write_actions_allowed: string[]; store_outbound_drafts: boolean }> = {
    PKG: { write_actions_allowed: ["email_draft"], store_outbound_drafts: true },
    NL: { write_actions_allowed: [], store_outbound_drafts: false },
  };
  const deps = (load = vi.fn(async () => config)) => ({
    loadEmployeeConfig: load,
    policyFor: (l: string) => policies[l] ?? { write_actions_allowed: [], store_outbound_drafts: false },
    roleFor: (l: string) => (l === "PKG" ? "owner" : "viewer"),
    laneSettingsFor: (l: string) => ({ mailboxes: [], kpis: l === "PKG" ? ["mrr"] : [] }),
  });
  it("re-loads the stored config every run, with permissions per lane and include/topics kept apart from the summary", async () => {
    const load = vi.fn(async () => config);
    const b = await buildEmployeePrompt(emp, "PKG", ME, deps(load));
    expect(load).toHaveBeenCalledWith("PKG", emp.config);
    expect(b.summary.join("\n")).toContain("Lane PKG: may propose email.save_draft");
    expect(b.summary.join("\n")).toContain("Lane NL: may propose nothing");
    expect(b.summary.join("\n")).not.toMatch(/INCLUDEME|TOPICME|boss@example/);
    expect(b.userPreferences).toEqual(["boards INCLUDEME", "TOPICME"]);
  });
  it("fails closed when the stored config is rejected", async () => {
    const load = vi.fn(async () => {
      throw new EmployeeConfigError([{ code: "schema", path: "lanes" }]);
    });
    await expect(buildEmployeePrompt(emp, "PKG", ME, deps(load))).rejects.toBeInstanceOf(EmployeeConfigError);
  });
  it("refuses another owner's employee row and one from another lane", async () => {
    await expect(buildEmployeePrompt({ ...emp, isMine: false }, "PKG", ME, deps())).rejects.toBeInstanceOf(BrainError);
    await expect(buildEmployeePrompt({ ...emp, laneId: "NL" }, "PKG", ME, deps())).rejects.toBeInstanceOf(BrainError);
  });
  it("returns the effective permissions and no uncapped config.permissions", async () => {
    const b = await buildEmployeePrompt(emp, "PKG", ME, deps());
    expect(b.permissions.PKG?.allowed).toEqual(["email.save_draft"]); // email.send requested but not in the lane policy
    expect(b.permissions.NL?.allowed).toEqual([]);
    expect("permissions" in b.config).toBe(false);
    expect(b.ownerUserId).toBe(ME);
  });
});
