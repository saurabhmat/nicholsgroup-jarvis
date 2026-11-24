// T-280: the Teams Disconnect route is the Microsoft Disconnect handler over the Teams connector: owner only, AAL2, same-origin, fixed answers; it never calls the mailbox disconnect.
import { describe, expect, it, vi } from "vitest";

const disconnectTeams = vi.hoisted(() => vi.fn(async () => true));
const disconnectMicrosoft = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@nichols/connectors/teams-settings", () => ({ disconnectTeams }));
vi.mock("@nichols/connectors/microsoft-settings", () => ({ disconnectMicrosoft }));
vi.mock("@/lib/guards", () => ({
  guards: async () => ({ requireLane: async () => ({}), requireRole: async () => ({ session: { userId: "00000000-0000-4000-8000-0000000000aa" } }) }),
}));

const { POST } = await import("../app/api/lanes/[laneId]/connections/[connectionId]/disconnect-teams/route");
const ID = "00000000-0000-4000-8000-0000000000c2";
const call = (headers: Record<string, string>) =>
  POST(new Request(`http://localhost:3000/api/lanes/PKG/connections/${ID}/disconnect-teams`, { method: "POST", headers }), { params: Promise.resolve({ laneId: "PKG", connectionId: ID }) } as never);

describe("POST disconnect-teams", () => {
  it("a same-origin owner request disconnects through the Teams connector only", async () => {
    const res = await call({ origin: "http://localhost:3000", "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
    expect(disconnectTeams).toHaveBeenCalledWith("PKG", ID, "00000000-0000-4000-8000-0000000000aa");
    expect(disconnectMicrosoft).not.toHaveBeenCalled();
  });

  it("a cross-site request is refused before anything runs", async () => {
    disconnectTeams.mockClear();
    expect((await call({ origin: "https://evil.example.test" })).status).toBe(403);
    expect((await call({ origin: "http://localhost:3000", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(disconnectTeams).not.toHaveBeenCalled();
  });
});
