// T-265: the module gate (lib/lane-modules.ts). Synthetic config rows; nothing company-specific.
import { beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.fn((to: string) => {
  throw new Error(`redirect:${to}`);
});
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
let row: unknown = null;
let failWith: unknown = null;
const selected: string[] = [];
// T-276: the gate reads the shared whole-config row (lib/lane-reads.ts) and takes three keys out of it; the tests keep their {modules, limited, news} rows and the fake
// wraps them as the stored config (the policy read below is a different table and is returned as is).
const stored = (table: string) => {
  const r = row as { modules?: unknown; limited?: unknown; news?: unknown } | null;
  return table === "lane_config_current" && r ? { config: { enabled_modules: r.modules, limit_to_enabled_modules: r.limited, news: r.news, secret_key: "must not leak" } } : row;
};
const client = {
  schema: () => ({
    from: (table: string) => ({
      select: (cols: string) => {
        selected.push(cols);
        return { eq: () => ({ maybeSingle: async () => ({ data: stored(table), error: failWith }) }) };
      },
    }),
  }),
};
vi.mock("@/lib/guards", () => ({ guards: async () => ({ requireLane: async () => ({ client, session: { userId: "u" } }) }) }));
const { gateFrom, hiddenNavKeys, loadLaneGate, laneGate, requireModule, UNLIMITED } = await import("@/lib/lane-modules");

beforeEach(() => {
  row = null;
  failWith = null;
  selected.length = 0;
  redirect.mockClear();
});

const LIMITED = { modules: ["comms", "calendar", "briefing"], limited: true, news: null };

describe("lane gate", () => {
  it("a company that does not limit itself shows everything, whatever its list says (the list was never read before)", () => {
    for (const r of [{ modules: ["assistant"], limited: null, news: null }, { modules: ["assistant"], limited: false, news: null }, { modules: null, limited: "true", news: null }]) {
      const g = gateFrom(r);
      expect(g.limited).toBe(false);
      expect(hiddenNavKeys(g)).toEqual([]);
      expect(g.visible("finance") && g.newsShown).toBe(true);
    }
  });

  it("a limited company shows exactly its list: finance, approvals, assistant, projects, Messages (T-278) and the setup entry are hidden", () => {
    const g = gateFrom(LIMITED);
    expect(g.limited).toBe(true);
    expect([g.visible("comms"), g.visible("calendar"), g.visible("briefing")]).toEqual([true, true, true]);
    expect(hiddenNavKeys(g).sort()).toEqual(["approvals", "assistant", "finance", "messages", "onboarding", "projects"]);
    expect(g.newsShown).toBe(false);
  });

  it("news shows for a limited company only when its own news.enabled is true", () => {
    expect(gateFrom({ ...LIMITED, news: { enabled: true } }).newsShown).toBe(true);
    for (const news of [{ enabled: false }, { enabled: "true" }, [], "x", {}]) expect(gateFrom({ ...LIMITED, news }).newsShown).toBe(false);
  });

  it("an unreadable row, a database error or a thrown read gives the unlimited default and never throws", async () => {
    expect(gateFrom(null)).toBe(UNLIMITED);
    failWith = { message: "db" };
    row = LIMITED;
    expect((await loadLaneGate(client, "XX")).limited).toBe(false);
    expect((await loadLaneGate({ schema: () => { throw new Error("boom"); } }, "XX")).limited).toBe(false);
  });

  it("reads the one shared config row and keeps only the three keys it needs (nothing else of the config is carried in the answer)", async () => {
    row = LIMITED;
    const gate = await loadLaneGate(client, "XX");
    expect(selected).toEqual(["config"]);
    expect(Object.keys(gate).sort()).toEqual(["limited", "newsShown", "visible"]);
    expect(JSON.stringify(gate)).not.toContain("must not leak");
  });

  it("requireModule sends a visitor of a hidden module to the company's Home (the switcher carries the page name across companies)", async () => {
    row = LIMITED;
    await expect(requireModule("XX", "finance")).rejects.toThrow("redirect:/XX");
    await expect(requireModule("XX", "comms")).resolves.toBeUndefined();
    row = { modules: [], limited: null, news: null };
    await expect(requireModule("YY", "finance")).resolves.toBeUndefined();
    expect(typeof laneGate).toBe("function");
  });
});

describe("emailWriteAllowed and hiddenModuleResponse (T-265)", () => {
  it("is true only when the policy lists an email write action; an unreadable policy answers true (nothing is hidden on a guess)", async () => {
    const { emailWriteAllowed } = await import("@/lib/lane-modules");
    for (const [data, want] of [[{ write_actions_allowed: [] }, false], [{ write_actions_allowed: ["calendar"] }, false], [{ write_actions_allowed: ["email_draft"] }, true], [{ write_actions_allowed: ["email_send"] }, true], [null, true]] as const) {
      row = data;
      expect(await emailWriteAllowed(client, "XX"), JSON.stringify(data)).toBe(want);
    }
    failWith = { message: "db" };
    expect(await emailWriteAllowed(client, "XX")).toBe(true);
  });
  it("hiddenModuleResponse ignores a malformed lane code (nothing is read)", async () => {
    const { hiddenModuleResponse } = await import("@/lib/lane-modules");
    row = LIMITED;
    expect(await hiddenModuleResponse("../x", "finance")).toBeNull();
    expect(await hiddenModuleResponse(null, "finance")).toBeNull();
    expect(selected).toEqual([]);
  });
});

describe("T-278: the messages module", () => {
  it("a limited company hides the Messages entry unless it lists `messages`; an unlimited one always shows it", () => {
    expect(hiddenNavKeys(gateFrom(LIMITED))).toContain("messages");
    expect(hiddenNavKeys(gateFrom({ modules: ["comms", "messages"], limited: true, news: null }))).not.toContain("messages");
    expect(hiddenNavKeys(gateFrom({ modules: [], limited: false, news: null }))).toEqual([]);
    expect(gateFrom(LIMITED).visible("messages")).toBe(false);
  });

  it("requireModule sends a limited company that does not list messages to its Home, and lets one that lists it through", async () => {
    row = LIMITED;
    await expect(requireModule("NC", "messages")).rejects.toThrow("redirect:");
    row = { modules: ["comms", "messages"], limited: true, news: null };
    await expect(requireModule("NC", "messages")).resolves.toBeUndefined();
  });
});
