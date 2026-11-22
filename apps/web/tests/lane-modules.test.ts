// T-265: the module gate (lib/lane-modules.ts). Synthetic config rows; nothing company-specific.
import { beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.fn((to: string) => {
  throw new Error(`redirect:${to}`);
});
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
let row: unknown = null;
let failWith: unknown = null;
const selected: string[] = [];
const client = {
  schema: () => ({
    from: () => ({
      select: (cols: string) => {
        selected.push(cols);
        return { eq: () => ({ maybeSingle: async () => ({ data: row, error: failWith }) }) };
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

  it("a limited company shows exactly its list: finance, approvals, assistant, projects and the setup entry are hidden", () => {
    const g = gateFrom(LIMITED);
    expect(g.limited).toBe(true);
    expect([g.visible("comms"), g.visible("calendar"), g.visible("briefing")]).toEqual([true, true, true]);
    expect(hiddenNavKeys(g).sort()).toEqual(["approvals", "assistant", "finance", "onboarding", "projects"]);
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

  it("reads only the three keys it needs, for the lane asked", async () => {
    row = LIMITED;
    await loadLaneGate(client, "XX");
    expect(selected).toEqual(["modules:config->enabled_modules, limited:config->limit_to_enabled_modules, news:config->news"]);
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
