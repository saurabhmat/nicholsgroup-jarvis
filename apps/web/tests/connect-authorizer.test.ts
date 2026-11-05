// T-050: connecting QuickBooks (or any provider) needs owner or admin_technical of the lane. The session guard enforces
// the role and AAL2; this checks that the connect routes ask it for exactly those roles and pass its refusals on.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { laneId: string; roles: readonly string[] };
let calls: Call[] = [];
let outcome: () => Promise<unknown> = async () => undefined;
vi.mock("@/lib/guards", () => ({
  guards: async () => ({
    requireRole: (laneId: string, roles: readonly string[]) => {
      calls.push({ laneId, roles });
      return outcome();
    },
  }),
}));

const { connectAuthorizer } = await import("../lib/connect");

beforeEach(() => {
  calls = [];
});

describe("connectAuthorizer", () => {
  it("asks the guard for owner or admin_technical of the requested lane, and nothing broader", async () => {
    outcome = async () => ({ session: { userId: "00000000-0000-4000-8000-0000000000a1" }, client: { marker: "lane-client" } });
    const out = await (await connectAuthorizer())("PKG");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.laneId).toBe("PKG");
    expect([...(calls[0]?.roles ?? [])].sort()).toEqual(["admin_technical", "owner"]);
    expect(out).toEqual({ userId: "00000000-0000-4000-8000-0000000000a1", client: { marker: "lane-client" } });
  });

  it("passes the guard's refusal on (viewer, finance_operator, AAL1, no session): nothing is returned", async () => {
    const refusal = Object.assign(new Error("Not allowed."), { status: 403 });
    outcome = async () => {
      throw refusal;
    };
    const authorize = await connectAuthorizer();
    const result = await authorize("PKG").then(
      () => "resolved",
      (e: unknown) => e,
    );
    expect(result).toBe(refusal);
  });
});
