// T-276: the config row and the Coverage rows are read ONCE per request and lane, however many parts of Home ask (it used to be 5 and 2). Each caller still takes only
// its own keys; a different client (another lane or request) never shares an answer; a failure is shared too (every caller sees the same answer).
import { beforeEach, describe, expect, it, vi } from "vitest";

const memo = vi.hoisted(() => ({ roots: [] as Map<unknown, unknown>[] }));
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  cache: <A extends unknown[], R>(fn: (...a: A) => R) => {
    const root = new Map<unknown, unknown>();
    memo.roots.push(root);
    const RES = Symbol("r");
    return (...a: A): R => {
      let node = root;
      for (const x of a) {
        let next = node.get(x) as Map<unknown, unknown> | undefined;
        if (!next) node.set(x, (next = new Map()));
        node = next;
      }
      if (!node.has(RES)) node.set(RES, fn(...a));
      return node.get(RES) as R;
    };
  },
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/guards", () => ({ guards: async () => ({}) }));

const { coverageRows, laneConfigRow } = await import("./lane-reads");
const { loadCoverage } = await import("./coverage");
const { loadBriefing } = await import("./briefing");
const { loadNewsCard } = await import("./news");
const { loadLaneGate } = await import("./lane-modules");
const { readLaneInfo } = await import("./brain-interview");

const CONFIG = { config: { limit_to_enabled_modules: true, enabled_modules: ["comms"], news: { enabled: true }, mailboxes: [], briefing: { attention_days: 3 }, secret_other_key: "x" } };

function fake() {
  const reads: string[] = [];
  const row = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in"]) q[m] = () => q;
    q.maybeSingle = () => q;
    q.then = (res: (v: unknown) => unknown) => (reads.push(`from:${table}`), res({ data: table === "lane_config_current" ? CONFIG : { llm_allowed_categories: [], store_outbound_drafts: false, write_actions_allowed: [] }, error: null }));
    return q;
  };
  return {
    reads,
    client: {
      schema: () => ({
        from: (table: string) => row(table),
        rpc: (fn: string) => ({ then: (res: (v: unknown) => unknown) => (reads.push(`rpc:${fn}`), res({ data: [], error: null })) }),
      }),
    } as never,
  };
}

beforeEach(() => {
  for (const r of memo.roots) r.clear();
});

describe("shared reads (T-276)", () => {
  it("Home's five lane_config readers and two Coverage readers share ONE read each", async () => {
    const { client, reads } = fake();
    const now = new Date("2026-11-20T15:00:00Z");
    await Promise.all([
      loadLaneGate(client, "PKG"),
      loadCoverage(client, "PKG", now),
      loadBriefing(client, "PKG", now, "America/New_York"),
      loadNewsCard(client, "PKG", { isOwner: true, isAdmin: true }, now),
      readLaneInfo(client as never, "PKG", "PKG", false, false),
    ]);
    expect(reads.filter((r) => r === "from:lane_config_current")).toHaveLength(1);
    expect(reads.filter((r) => r === "rpc:briefing_coverage")).toHaveLength(1);
  });

  it("the gate still keeps only its three keys, and the news read still reads the config only for an owner", async () => {
    const { client, reads } = fake();
    const gate = await loadLaneGate(client, "PKG");
    expect(gate.limited).toBe(true);
    expect(gate.newsShown).toBe(true);
    expect(gate.visible("comms")).toBe(true);
    expect(gate.visible("finance")).toBe(false);
    expect(JSON.stringify(gate)).not.toContain("secret_other_key");
    reads.length = 0;
    for (const r of memo.roots) r.clear();
    await loadNewsCard(client, "PKG", { isOwner: false, isAdmin: false }, new Date());
    expect(reads).not.toContain("from:lane_config_current");
  });

  it("a job that names an owner reads Coverage for that owner directly (never the shared caller read)", async () => {
    const { client, reads } = fake();
    await loadCoverage(client, "PKG", new Date());
    await loadBriefing(client, "PKG", new Date(), "America/New_York", "00000000-0000-4000-8000-000000000001");
    expect(reads.filter((r) => r === "rpc:briefing_coverage")).toHaveLength(2);
  });

  it("a different client or lane never shares an answer", async () => {
    const a = fake();
    const b = fake();
    await Promise.all([laneConfigRow(a.client, "PKG"), laneConfigRow(b.client, "PKG"), laneConfigRow(a.client, "AAA"), coverageRows(a.client, "PKG"), coverageRows(a.client, "AAA")]);
    expect(a.reads.filter((r) => r === "from:lane_config_current")).toHaveLength(2);
    expect(b.reads.filter((r) => r === "from:lane_config_current")).toHaveLength(1);
    expect(a.reads.filter((r) => r === "rpc:briefing_coverage")).toHaveLength(2);
  });

  it("a failed read is the same answer for every caller in the render", async () => {
    const reads: string[] = [];
    const client = {
      schema: () => ({
        from: () => {
          const q: Record<string, unknown> = {};
          for (const m of ["select", "eq", "maybeSingle"]) q[m] = () => q;
          q.then = (_res: unknown, rej: (e: unknown) => unknown) => (reads.push("read"), rej(new Error("down")));
          return q;
        },
      }),
    } as never;
    const out = await Promise.allSettled([laneConfigRow(client, "PKG"), laneConfigRow(client, "PKG")]);
    expect(out.map((o) => o.status)).toEqual(["rejected", "rejected"]);
    expect(reads).toHaveLength(1);
    expect((await loadLaneGate(client, "PKG")).limited).toBe(false); // the gate fails open to "show everything", as before
  });
});
