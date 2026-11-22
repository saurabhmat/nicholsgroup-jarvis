import { describe, expect, it, vi } from "vitest";
import type { CapabilityFacts } from "@nichols/approvals/server";
import { replyableMicrosoftConnections } from "./reply-microsoft-rows";

const f = (over: Partial<CapabilityFacts>): CapabilityFacts => ({ mailbox: "a@x.example.test", provider: "microsoft", composeGranted: true, writeActionsAllowed: ["email_send"], approvalsLive: true, stepUpMaxAgeS: 300, ...over });
describe("replyableMicrosoftConnections", () => {
  it("only Microsoft connections with the grant and an email write policy; Google rows are never asked; an unreadable fact excludes", async () => {
    const facts: Record<string, CapabilityFacts | Error> = { m1: f({}), m2: f({ composeGranted: false }), m3: f({ writeActionsAllowed: [] }), m4: new Error("down") };
    const readFacts = vi.fn(async (_l: string, id: string) => { const x = facts[id]; if (!x || x instanceof Error) throw new Error("x"); return x; });
    const set = await replyableMicrosoftConnections({ readFacts } as never, "PKG", { g1: { provider: "google" }, m1: { provider: "microsoft" }, m2: { provider: "microsoft" }, m3: { provider: "microsoft" }, m4: { provider: "microsoft" } });
    expect([...set]).toEqual(["m1"]);
    expect(readFacts).not.toHaveBeenCalledWith("PKG", "g1");
    expect((await replyableMicrosoftConnections({ readFacts } as never, "PKG", undefined)).size).toBe(0);
  });
});
