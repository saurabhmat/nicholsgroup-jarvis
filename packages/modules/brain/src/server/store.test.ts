import { describe, expect, it, vi } from "vitest";
import { BrainError } from "./errors";
import { createBrainStore, EmployeeConfigError, type BrainDb, type ClientFor } from "./store";

type Call = { fn: string; args: Record<string, unknown> };
type Reply = { data?: unknown; error?: { code?: string; message?: string } | null };

/** A fake lane client: records every rpc and answers from `reply`. */
const laneSettingsFor = async (lane: string) => (lane === "PKG" ? { mailboxes: ["boss@example.test"], kpis: ["mrr"] } : null);

function fake(reply: (c: Call) => Reply) {
  const calls: Call[] = [];
  const clientFor = vi.fn(async (lane: string): Promise<BrainDb> => {
    expect(lane).toMatch(/^[A-Z]+$/);
    const db = {
      schema(name: string) {
        expect(name).toBe("core");
        return {
          rpc: async (fn: string, args: Record<string, unknown>) => {
            calls.push({ fn, args });
            const r = reply({ fn, args });
            return { data: r.data ?? null, error: r.error ?? null };
          },
        };
      },
    };
    return db as unknown as BrainDb;
  });
  return { calls, clientFor, store: createBrainStore({ clientFor, laneSettingsFor }) };
}

const ID = "00000000-0000-4000-8000-000000000001";
const saved = { data: [{ o_id: ID, o_version: 2, o_updated_at: "2026-11-07T12:00:00Z" }] };

describe("saveDocument", () => {
  it("saves through the wrapper with the lane, path, body and expected version", async () => {
    const f = fake(() => saved);
    await expect(f.store.saveDocument("PKG", "Context/Work.md", "# Work", 1)).resolves.toEqual({ id: ID, version: 2, updatedAt: "2026-11-07T12:00:00Z" });
    expect(f.calls).toEqual([{ fn: "brain_document_save", args: { p_lane: "PKG", p_path: "Context/Work.md", p_body: "# Work", p_if_version: 1 } }]);
    expect(f.clientFor).toHaveBeenCalledWith("PKG");
  });
  it("refuses bad input before any call: path, size, version, lane, secret", async () => {
    const f = fake(() => saved);
    const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as BrainError).code;
    expect(await code(f.store.saveDocument("PKG", "Context/../x.md", "x", 0))).toBe("invalid");
    expect(await code(f.store.saveDocument("PKG", "Context/Work.md", "a".repeat(32_769), 0))).toBe("invalid");
    expect(await code(f.store.saveDocument("PKG", "Context/Work.md", "x", -1))).toBe("invalid");
    expect(await code(f.store.saveDocument("PKG", "Context/Work.md", "x", 1.5))).toBe("invalid");
    expect(await code(f.store.saveDocument("pkg", "Context/Work.md", "x", 0))).toBe("invalid");
    expect(await code(f.store.saveDocument("PKG", "Context/Work.md", "key sk_live_abcdefghijklmnop1234", 0))).toBe("secret");
    expect(f.calls).toEqual([]);
    expect(f.clientFor).not.toHaveBeenCalled();
  });
  it("maps database errors to fixed codes without echoing text", async () => {
    const cases: [{ code?: string; message?: string }, string][] = [
      [{ code: "40001", message: "brain: version_conflict" }, "version_conflict"],
      [{ code: "22023", message: "brain: content looks like a credential" }, "secret"],
      [{ code: "22023", message: "brain: invalid path" }, "invalid"],
      [{ code: "42501", message: "brain: the owner role in this lane is required" }, "forbidden"],
      [{ code: "XX000", message: "secret page text leaked here" }, "unavailable"],
    ];
    for (const [error, want] of cases) {
      const f = fake(() => ({ error }));
      const e = (await f.store.saveDocument("PKG", "Context/Work.md", "x", 0).catch((x: unknown) => x)) as BrainError;
      expect(e).toBeInstanceOf(BrainError);
      expect(e.code).toBe(want);
      expect(e.message).not.toContain("leaked");
    }
  });
  const laneError = (reason: string) => Object.assign(new Error("x"), { name: "LaneAccessError", reason });
  it("refuses sensitive numbers before the round trip, naming the kind, and maps the database refusal the same way", async () => {
    const f = fake(() => ({ data: [] }));
    for (const [text, code] of [
      ["SSN 123-45-6789", "sensitive_ssn"],
      ["card 4111 1111 1111 1111", "sensitive_card"],
      ["Routing number is 021000021", "sensitive_bank"],
    ] as const) {
      const e = (await f.store.saveDocument("PKG", "Notes/S.md", text, 0).catch((x: unknown) => x)) as BrainError;
      expect(e.code).toBe(code);
      expect(e.message).not.toContain(text);
    }
    expect(f.calls).toEqual([]);
    for (const kind of ["ssn", "card", "bank"] as const) {
      const db = fake(() => ({ error: { code: "22023", message: `brain: sensitive_${kind} (content contains a sensitive number and was not saved)` } }));
      const e = (await db.store.saveDocument("PKG", "Notes/S.md", "x", 0).catch((x: unknown) => x)) as BrainError;
      expect(e.code).toBe(`sensitive_${kind}`);
    }
    await expect(f.store.saveSkill("PKG", { key: "pay-run", title: "Pay run", body: "Use account number 12345678" }, 0)).rejects.toMatchObject({ code: "sensitive_bank" });
  });
  it("is forbidden when the lane router refuses the lane", async () => {
    const store = createBrainStore({ laneSettingsFor, clientFor: async () => Promise.reject(laneError("not_allowed")) });
    const e = (await store.getDocument("APK", "Context/Work.md").catch((x: unknown) => x)) as BrainError;
    expect(e.code).toBe("forbidden");
  });
  it("is unavailable, not forbidden, on an outage", async () => {
    const cases: ClientFor[] = [
      async () => Promise.reject(new Error("fetch failed")),
      async () => Promise.reject(laneError("data_plane_unavailable")),
      async () => ({ schema: () => ({ rpc: async () => Promise.reject(new Error("ECONNRESET")) }) }) as unknown as BrainDb,
    ];
    for (const clientFor of cases) {
      const e = (await createBrainStore({ clientFor, laneSettingsFor }).getDocument("PKG", "Context/Work.md").catch((x: unknown) => x)) as BrainError;
      expect(e.code).toBe("unavailable");
    }
  });
  it("rejects a malformed reply from the database", async () => {
    const f = fake(() => ({ data: [{ o_id: "not-a-uuid", o_version: 1, o_updated_at: "x" }] }));
    const e = (await f.store.saveDocument("PKG", "Context/Work.md", "x", 0).catch((x: unknown) => x)) as BrainError;
    expect(e.code).toBe("invalid");
  });
});

describe("reads", () => {
  it("maps a page, null when there is none", async () => {
    const row = { id: ID, path: "Context/Work.md", kind: "context", body_md: "# Work", version: 3, updated_at: "2026-11-07T12:00:00Z", is_mine: true };
    expect(await fake(() => ({ data: [row] })).store.getDocument("PKG", "Context/Work.md")).toEqual({
      id: ID, path: "Context/Work.md", kind: "context", body: "# Work", version: 3, updatedAt: "2026-11-07T12:00:00Z", isMine: true,
    });
    expect(await fake(() => ({ data: [] })).store.getDocument("PKG", "Context/Work.md")).toBeNull();
  });
  it("lists metadata with the optional prefix", async () => {
    const f = fake(() => ({ data: [{ path: "Context/Work.md", kind: "context", version: 1, updated_at: "t", is_mine: false }] }));
    expect(await f.store.listDocuments("PKG", "Context/")).toEqual([{ path: "Context/Work.md", kind: "context", version: 1, updatedAt: "t", isMine: false }]);
    expect(f.calls[0]).toEqual({ fn: "brain_documents_list", args: { p_lane: "PKG", p_prefix: "Context/" } });
  });
  it("passes only the lane for the employee and skill lists", async () => {
    const f = fake(() => ({ data: [] }));
    await f.store.listEmployees("PKG");
    await f.store.listSkills("PKG");
    expect(f.calls.map((c) => [c.fn, c.args])).toEqual([["brain_employees_list", { p_lane: "PKG" }], ["brain_skills_list", { p_lane: "PKG" }]]);
  });
  it("finds the home lane or null", async () => {
    expect(await fake(() => ({ data: "PKG" })).store.findHomeLane("PKG")).toBe("PKG");
    expect(await fake(() => ({ data: null })).store.findHomeLane("PKG")).toBeNull();
    expect(await fake(() => ({ data: "pkg" })).store.findHomeLane("PKG")).toBeNull();
  });
});

describe("saveEmployee and saveSkill", () => {
  const input = { roleKey: "personal_assistant", name: "Jarvis", instructions: "Be brief.", config: { lanes: ["PKG"] }, status: "draft" as const };
  it("sends the profile to the wrapper", async () => {
    const f = fake(() => saved);
    await f.store.saveEmployee("PKG", input, 0);
    expect(f.calls[0]).toEqual({
      fn: "brain_employee_save",
      args: { p_lane: "PKG", p_role_key: "personal_assistant", p_name: "Jarvis", p_instructions_md: "Be brief.", p_config: expect.objectContaining({ lanes: ["PKG"], timezone: "America/New_York", schedule: { days: [1, 2, 3, 4, 5] }, permissions: { propose: ["email.save_draft"] } }), p_status: "draft", p_if_version: 0 },
    });
  });
  it("refuses a bad role, status, config or a secret before any call", async () => {
    const f = fake(() => saved);
    const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as BrainError).code;
    expect(await code(f.store.saveEmployee("PKG", { ...input, roleKey: "Bad Role" }, 0))).toBe("invalid");
    expect(await code(f.store.saveEmployee("PKG", { ...input, status: "running" as never }, 0))).toBe("invalid");
    expect(await code(f.store.saveEmployee("PKG", { ...input, config: [] as never }, 0))).toBe("invalid");
    expect(await code(f.store.saveEmployee("PKG", { ...input, instructions: "key sk_live_abcdefghijklmnop1234" }, 0))).toBe("secret");
    expect(await code(f.store.saveEmployee("PKG", { ...input, config: { lanes: ["PKG"], note: "sk_live_abcdefghijklmnop1234" } }, 0))).toBe("secret");
    expect(await code(f.store.saveSkill("PKG", { key: "Bad Key", title: "T", body: "x" }, 0))).toBe("invalid");
    expect(f.calls).toEqual([]);
  });
});

describe("saveEmployee config validation (T-211)", () => {
  const base = { roleKey: "personal_assistant", name: "Jarvis", instructions: "Be brief.", status: "draft" as const };
  const issues = async (config: Record<string, unknown>) => {
    const f = fake(() => saved);
    const e = (await f.store.saveEmployee("PKG", { ...base, config }, 0).catch((x: unknown) => x)) as EmployeeConfigError;
    expect(e).toBeInstanceOf(EmployeeConfigError);
    expect(e.code).toBe("config_invalid");
    expect(f.calls).toEqual([]); // nothing reached the database
    return e.issues.map((i) => i.code);
  };
  it("accepts a valid config and stores it normalised", async () => {
    const f = fake(() => saved);
    await f.store.saveEmployee("PKG", { ...base, config: { lanes: ["PKG"], sources: { mail: [{ lane: "PKG", mailbox: "Boss@example.test", priority: 1 }], finance_kpis: ["mrr"] } } }, 0);
    const cfg = f.calls[0]?.args.p_config as { sources: { mail: { include: string[] }[] } };
    expect(cfg.sources.mail[0]?.include).toEqual([]);
  });
  it("rejects a mailbox that is not in lane_config.mailboxes", async () => {
    expect(await issues({ lanes: ["PKG"], sources: { mail: [{ lane: "PKG", mailbox: "other@example.test", priority: 1 }] } })).toEqual(["mailbox_unknown"]);
  });
  it("rejects unknown keys, mail lanes outside lanes, KPIs outside lane_config.kpis and single-lane mismatch", async () => {
    expect(await issues({ lanes: ["PKG"], extra: 1 })).toEqual(["schema"]);
    expect(await issues({ lanes: ["PKG"], sources: { mail: [{ lane: "OTH", mailbox: "boss@example.test", priority: 1 }] } })).toContain("mail_lane_not_in_lanes");
    expect(await issues({ lanes: ["PKG"], sources: { finance_kpis: ["ar_total"] } })).toEqual(["kpi_not_in_lane"]);
    expect(await issues({ lanes: ["OTH"] })).toEqual(expect.arrayContaining(["lanes_mismatch", "lane_not_available"]));
  });
});

describe("employee config: the lane router decides lane access, and stored configs are re-checked (T-211 review)", () => {
  const laneError = (reason: string) => Object.assign(new Error("x"), { name: "LaneAccessError", reason });
  const base = { roleKey: "personal_assistant", name: "Jarvis", instructions: "Be brief.", status: "draft" as const };
  it("treats a lane the router refuses as not available, even if laneSettingsFor answers for it", async () => {
    const calls: string[] = [];
    const clientFor = async (lane: string): Promise<BrainDb> => {
      if (lane === "OTH") throw laneError("not_allowed");
      return { schema: () => ({ rpc: async (fn: string) => (calls.push(fn), { data: saved.data, error: null }) }) } as unknown as BrainDb;
    };
    const store = createBrainStore({ clientFor, laneSettingsFor: async () => ({ mailboxes: ["boss@example.test"], kpis: ["mrr"] }) });
    const e = (await store.saveEmployee("PKG", { ...base, config: { lanes: ["PKG", "OTH"] } }, 0).catch((x: unknown) => x)) as EmployeeConfigError;
    expect(e.issues.map((i) => i.code)).toEqual(["lane_not_available"]);
    expect(calls).toEqual([]);
  });
  it("is forbidden when the employee's own lane is refused, and unavailable on an outage", async () => {
    const refused = createBrainStore({ clientFor: async () => Promise.reject(laneError("not_allowed")), laneSettingsFor });
    expect(((await refused.loadEmployeeConfig("PKG", { lanes: ["PKG"] }).catch((x: unknown) => x)) as BrainError).code).toBe("forbidden");
    const down = createBrainStore({ clientFor: fake(() => saved).clientFor, laneSettingsFor: async () => Promise.reject(new Error("fetch failed")) });
    expect(((await down.loadEmployeeConfig("PKG", { lanes: ["PKG"] }).catch((x: unknown) => x)) as BrainError).code).toBe("unavailable");
  });
  it("loadEmployeeConfig refuses a tampered stored config (extra lane, unknown mailbox, bad shape)", async () => {
    const f = fake(() => saved);
    for (const stored of [
      { lanes: ["PKG", "OTH"] },
      { lanes: ["PKG"], sources: { mail: [{ lane: "PKG", mailbox: "attacker@example.test", priority: 1 }] } },
      { lanes: ["PKG"], permissions: { propose: ["qbo.post"] } },
      "not an object",
    ]) {
      await expect(f.store.loadEmployeeConfig("PKG", stored)).rejects.toBeInstanceOf(EmployeeConfigError);
    }
    expect((await f.store.loadEmployeeConfig("PKG", { lanes: ["PKG"] })).permissions.propose).toEqual(["email.save_draft"]);
  });
});

describe("decideImport", () => {
  const D = "00000000-0000-4000-8000-0000000000d1";
  it("sends the decisions and maps the kept facts", async () => {
    const f = fake(() => ({ data: [{ o_candidate_id: D, o_fact: "Prefers short replies", o_target_path: "Context/Preferences.md", o_target_lane: "PKG" }] }));
    expect(await f.store.decideImport("PKG", ID, [{ id: D, decision: "keep" }], true)).toEqual([
      { candidateId: D, fact: "Prefers short replies", targetPath: "Context/Preferences.md", targetLane: "PKG" },
    ]);
    expect(f.calls[0]?.args).toEqual({ p_lane: "PKG", p_import_id: ID, p_decisions: [{ id: D, decision: "keep" }], p_finish: true });
  });
  it("refuses a malformed id or decision", async () => {
    const f = fake(() => ({ data: [] }));
    const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as BrainError).code;
    expect(await code(f.store.decideImport("PKG", "nope", []))).toBe("invalid");
    expect(await code(f.store.decideImport("PKG", ID, [{ id: D, decision: "maybe" as never }]))).toBe("invalid");
  });
});

describe("ensureSeeds (lazy, first use)", () => {
  it("creates only what is missing for the caller, with if_version 0, and never touches an existing page", async () => {
    const store: Record<string, boolean> = { "Context/Work.md": true }; // the caller already has Work
    const f = fake(({ fn, args }) => {
      if (fn === "brain_documents_list")
        return { data: [{ path: "Context/Work.md", kind: "context", version: 1, updated_at: "t", is_mine: true }, { path: "Context/About-Me.md", kind: "about_me", version: 1, updated_at: "t", is_mine: false }] };
      if (fn === "brain_skills_list") return { data: [{ id: ID, is_mine: true, key: "brain-maintenance", title: "T", body_md: "b", version: 1, updated_at: "t" }] };
      if (fn === "brain_document_save") store[String(args.p_path)] = true;
      return saved;
    });
    const created = await f.store.ensureSeeds("PKG", { home: true });
    expect(created).toEqual({ documents: ["Context/About-Me.md", "Context/Preferences.md"], skills: ["project-handoff"] });
    const saves = f.calls.filter((c) => c.fn.endsWith("_save"));
    expect(saves.every((c) => c.args.p_if_version === 0)).toBe(true);
    expect(saves.map((c) => c.args.p_path ?? c.args.p_key)).toEqual(["Context/About-Me.md", "Context/Preferences.md", "project-handoff"]);
  });
  it("seeds only the lane's Work page outside the home lane", async () => {
    const f = fake(({ fn }) => (fn.endsWith("_list") ? { data: [] } : saved));
    const created = await f.store.ensureSeeds("PKG", { home: false });
    expect(created.documents).toEqual(["Context/Work.md"]);
  });
  it("skips a page when another request created it first (version conflict)", async () => {
    const f = fake(({ fn, args }) => {
      if (fn.endsWith("_list")) return { data: [] };
      if (fn === "brain_document_save" && args.p_path === "Context/Work.md") return { error: { code: "40001", message: "brain: version_conflict" } };
      return saved;
    });
    const created = await f.store.ensureSeeds("PKG", { home: false });
    expect(created.documents).toEqual([]);
    expect(created.skills.length).toBe(2);
  });
  it("lets any other error through", async () => {
    const f = fake(({ fn }) => (fn.endsWith("_list") ? { data: [] } : { error: { code: "42501", message: "x" } }));
    await expect(f.store.ensureSeeds("PKG", { home: false })).rejects.toMatchObject({ code: "forbidden" });
  });
});
