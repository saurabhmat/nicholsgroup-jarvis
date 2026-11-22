// The briefing's reply gate (security L4): decided by the connection's provider and its grant, never by a source label; unknown provider or unreadable: no proposal.
import { describe, expect, it } from "vitest";
import { createBriefingReplyGate } from "./briefing-gate";
import type { CapabilityFacts } from "./types";

const facts = (over: Partial<CapabilityFacts> = {}): CapabilityFacts => ({ mailbox: "a@example.test", provider: "microsoft", composeGranted: true, writeActionsAllowed: ["email_send"], approvalsLive: true, stepUpMaxAgeS: 300, ...over });
const gate = (provider: string | Error, f: CapabilityFacts | Error = facts()) =>
  createBriefingReplyGate({
    loadWriteConnection: async () => { if (provider instanceof Error) throw provider; return { provider } as never; },
    readFacts: async () => { if (f instanceof Error) throw f; return f; },
  });

describe("createBriefingReplyGate", () => {
  it("Google rows are unchanged (allowed); a Microsoft row only with the grant, a usable connection and an email write policy", async () => {
    expect(await gate("google", new Error("facts not needed"))("PKG" as never, "c")).toBe(true);
    expect(await gate("microsoft")("PKG" as never, "c")).toBe(true);
    expect(await gate("microsoft", facts({ writeActionsAllowed: ["email_draft"] }))("PKG" as never, "c")).toBe(true);
    for (const f of [facts({ composeGranted: false }), facts({ writeActionsAllowed: [] }), facts({ mailbox: null }), facts({ provider: "google" }), facts({ provider: null })]) {
      expect(await gate("microsoft", f)("PKG" as never, "c")).toBe(false);
    }
  });
  it("fails closed: an unknown provider, an unreadable connection (including one missing from coverage) and unreadable facts give no proposal", async () => {
    expect(await gate("quickbooks")("PKG" as never, "c")).toBe(false);
    expect(await gate("")("PKG" as never, "c")).toBe(false);
    expect(await gate(new Error("not found"))("PKG" as never, "c")).toBe(false);
    expect(await gate("microsoft", new Error("down"))("PKG" as never, "c")).toBe(false);
  });
});
