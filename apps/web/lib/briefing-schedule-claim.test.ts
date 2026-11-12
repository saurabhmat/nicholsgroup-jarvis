// T-235 part 1: the scheduled run records a claim (kind schedule) for tracking; a failure to record it never stops the briefing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockProvider } from "@nichols/ai/testing";

const m = vi.hoisted(() => ({ run: vi.fn(), rpc: vi.fn() }));
vi.mock("@nichols/ai/config", () => ({ getLLMProvider: () => ({ configured: true, provider: createMockProvider([]) }) }));
vi.mock("@nichols/connectors/google", () => ({ readGmailBody: async () => ({ text: "" }) }));
vi.mock("./briefing-proposals", () => ({ replyProposer: () => async () => "p1" }));
vi.mock("./briefing-run", async (orig) => ({ ...(await orig<typeof import("./briefing-run")>()), runBriefing: (...a: unknown[]) => m.run(...a) }));
import { runScheduled } from "./briefing-schedule";

const client = {
  schema: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { llm_allowed_categories: ["email"], store_outbound_drafts: false }, error: null }) }) }) }),
    rpc: (fn: string, args: unknown) => m.rpc(fn, args),
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  m.rpc.mockResolvedValue({ data: { id: "claim-1", gate: null }, error: null });
  m.run.mockResolvedValue({ id: "b1", status: "ready" });
});

describe("runScheduled", () => {
  it("records the schedule claim before the run, with the owner", async () => {
    await expect(runScheduled(async () => client as never, "PKG", "owner-1", new Date())).resolves.toBe("b1");
    expect(m.rpc).toHaveBeenCalledWith("briefing_claim_schedule", { p_lane: "PKG", p_owner: "owner-1" });
    expect(m.rpc.mock.invocationCallOrder[0]).toBeLessThan(m.run.mock.invocationCallOrder[0] ?? 0);
  });
  it("a day with a finished scheduled run answers 'done': a retry skips the model call (re-check M1)", async () => {
    m.rpc.mockResolvedValueOnce({ data: { id: "claim-0", gate: "done" }, error: null });
    await expect(runScheduled(async () => client as never, "PKG", "owner-1", new Date())).resolves.toBe("claim-0");
    expect(m.run).not.toHaveBeenCalled();
  });
  it("a claim that cannot be recorded (error or throw) never stops the briefing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    m.rpc.mockResolvedValueOnce({ data: null, error: { message: "x" } });
    await expect(runScheduled(async () => client as never, "PKG", "owner-1", new Date())).resolves.toBe("b1");
    m.rpc.mockRejectedValueOnce(new Error("down"));
    await expect(runScheduled(async () => client as never, "PKG", "owner-1", new Date())).resolves.toBe("b1");
    err.mockRestore();
  });
});
