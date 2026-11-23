// T-276: the layout and Home's greeting ask for the same first name; one profile read per request and lane.
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
const { firstNameFor } = await import("./first-name");

beforeEach(() => {
  for (const r of memo.roots) r.clear();
});

describe("firstNameFor is shared within a request", () => {
  const g = { requireLane: async () => ({ client: {}, session: { userId: "u1" } }) } as never;
  it("reads the profile once for the layout and the greeting, and again for a new request", async () => {
    const load = vi.fn(async () => "Dana");
    const [a, b] = await Promise.all([firstNameFor(g, "PKG", load), firstNameFor(g, "PKG", load)]);
    expect([a, b]).toEqual(["Dana", "Dana"]);
    expect(load).toHaveBeenCalledTimes(1);
    for (const r of memo.roots) r.clear();
    await firstNameFor(g, "PKG", load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
