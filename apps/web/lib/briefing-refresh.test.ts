// T-238: the briefing refresh after new mail asks the existing run claim; a refusal never reaches the model; the claim is closed after the run.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockProvider } from "@nichols/ai/testing";

const m = vi.hoisted(() => ({ run: vi.fn(), rpc: vi.fn(), configured: true }));
vi.mock("@nichols/ai/config", () => ({ getLLMProvider: () => ({ configured: m.configured, provider: createMockProvider([]) }) }));
vi.mock("@nichols/connectors/google", () => ({ readGmailBody: async () => ({ text: "" }) }));
vi.mock("./briefing-proposals", () => ({ replyProposer: () => async () => "p1" }));
vi.mock("./briefing-run", async (orig) => ({ ...(await orig<typeof import("./briefing-run")>()), runBriefing: (...a: unknown[]) => m.run(...a) }));
import { runRefresh } from "./briefing-schedule";

const client = {
  schema: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { llm_allowed_categories: ["email"], store_outbound_drafts: false }, error: null }) }) }) }),
    rpc: (fn: string, args: unknown) => m.rpc(fn, args),
  }),
};
const OWNER = "00000000-0000-4000-8000-0000000000c1";
const go = () => runRefresh(async () => client as never, "PKG", OWNER, new Date());

beforeEach(() => {
  vi.clearAllMocks();
  m.configured = true;
  m.rpc.mockResolvedValue({ data: { id: "claim-1", gate: null }, error: null });
  m.run.mockResolvedValue({ id: "b1", status: "ready" });
});

describe("runRefresh", () => {
  it("claims through briefing_claim_refresh, runs once as trigger schedule, then closes the claim done", async () => {
    await expect(go()).resolves.toBe("ran");
    expect(m.rpc.mock.calls.map((c) => c[0])).toEqual(["briefing_claim_refresh", "briefing_claim_refresh_close"]);
    expect(m.rpc).toHaveBeenCalledWith("briefing_claim_refresh", { p_lane: "PKG", p_owner: OWNER });
    expect(m.rpc).toHaveBeenLastCalledWith("briefing_claim_refresh_close", { p_lane: "PKG", p_owner: OWNER, p_status: "done" });
    expect(m.run).toHaveBeenCalledTimes(1);
    expect(m.run.mock.calls[0]?.[1]).toMatchObject({ laneId: "PKG", ownerUserId: OWNER, trigger: "schedule" });
  });

  it("every gate of the claim (not_stale, running, cap_reached, cooldown) means no model call", async () => {
    for (const gate of ["not_stale", "running", "cap_reached", "cooldown", "anything"]) {
      m.rpc.mockResolvedValueOnce({ data: { id: null, gate }, error: null });
      await expect(go()).resolves.toBe("refused");
    }
    expect(m.run).not.toHaveBeenCalled();
    expect(m.rpc.mock.calls.every((c) => c[0] === "briefing_claim_refresh")).toBe(true);
  });

  it("a claim that cannot be read stops the refresh without a model call", async () => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { message: "x" } });
    await expect(go()).rejects.toThrow("claim unavailable");
    m.rpc.mockResolvedValueOnce({ data: {}, error: null });
    await expect(go()).resolves.toBe("refused");
    expect(m.run).not.toHaveBeenCalled();
  });

  it("with no model configured nothing is claimed", async () => {
    m.configured = false;
    await expect(go()).resolves.toBe("skipped");
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("a failed model step closes the claim failed and throws; a died run closes it lost", async () => {
    m.run.mockResolvedValueOnce({ id: "b2", status: "failed" });
    await expect(go()).rejects.toThrow("briefing model step failed");
    expect(m.rpc).toHaveBeenLastCalledWith("briefing_claim_refresh_close", { p_lane: "PKG", p_owner: OWNER, p_status: "failed" });
    m.run.mockRejectedValueOnce(new Error("boom with detail"));
    const err = (await go().catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("detail");
    expect(m.rpc).toHaveBeenLastCalledWith("briefing_claim_refresh_close", { p_lane: "PKG", p_owner: OWNER, p_status: "lost" });
  });
});
