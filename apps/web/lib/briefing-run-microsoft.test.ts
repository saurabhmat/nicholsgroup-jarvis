// T-260: one briefing run for a person with a Google and a Microsoft mailbox. Both mailboxes' threads are read live through the injected reader with each row's OWN
// connection id (the real reader is the facade with the owner check); a reply draft for a Microsoft thread is never proposed (replying from Microsoft is T-262/T-263), while the
// Google thread's draft is. Synthetic data; the mock model.
import { describe, expect, it } from "vitest";
import { createMockProvider, textResult } from "@nichols/ai/testing";
import type { LaneId } from "@nichols/core";
import { runBriefing, type RunDeps, type SavedBriefing } from "./briefing-run";
import type { loadBriefing } from "./briefing";

const NOW = new Date("2026-11-20T15:00:00Z");
const OWNER = "00000000-0000-4000-8000-000000000001";
const G = "00000000-0000-4000-8000-0000000c2601";
const M = "00000000-0000-4000-8000-0000000c2602";
const cov = (stream: string, provider: string, connection: string, account: string) => ({ stream, account, connection_id: connection, provider, status: "active", configured: true, last_sync_at: "2026-11-20T14:55:00Z", error_kind: null });
const thread = (connection: string, id: string, subject: string) => ({ connection_id: connection, thread_key: `t-${id}`, message_id: id, from_address: `sender-${id}@acme.example.test`, from_name: "Dana", subject, received_at: "2026-11-20T14:00:00Z", source_url: null, labels: ["INBOX"], is_important: true, last_is_owner: false, owner_replied: false, unread_count: 1, inbound_count: 1, last_to_owner: true });
const client = {
  schema: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { config: { mailboxes: ["robert@pubk.example.test"] } }, error: null }) }) }) }),
    rpc: async (fn: string) =>
      fn === "briefing_coverage" ? { data: [cov("mail", "google", G, "robert@pubk.example.test"), cov("mail", "microsoft", M, "robert@pubkgroup.example.test"), cov("calendar", "microsoft", M, "robert@pubkgroup.example.test")], error: null }
      : fn === "briefing_threads" ? { data: [thread(G, "g-1", "Gmail thread"), thread(M, "ms-1", "Outlook thread")], error: null }
      : { data: [], error: null },
  }),
} as unknown as Parameters<typeof loadBriefing>[0];

const withCoverage = (rows: unknown[]) => ({
  schema: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { config: { mailboxes: ["robert@pubk.example.test"] } }, error: null }) }) }) }),
    rpc: async (fn: string) => (fn === "briefing_coverage" ? { data: rows, error: null } : fn === "briefing_threads" ? { data: [thread(G, "g-1", "Gmail thread"), thread(M, "ms-1", "Outlook thread")], error: null } : { data: [], error: null }),
  }),
}) as unknown as Parameters<typeof loadBriefing>[0];

const reply = JSON.stringify({ lines: ["Two threads need you."], attention: [], deadlines: [], priorities: [], more_replies: [], replies: [{ ref: "r1", status: "ready", context: "x", text: "Thanks, noted." }, { ref: "r2", status: "ready", context: "y", text: "Thanks, noted." }] });

function run(coverageRows?: unknown[], canProposeFor?: RunDeps["canProposeFor"]) {
  const saved: SavedBriefing[] = [];
  const reads: { connection: string; message: string }[] = [];
  const proposed: { connectionId: string }[] = [];
  const d: RunDeps = {
    client: coverageRows ? withCoverage(coverageRows) : client,
    provider: createMockProvider([textResult(reply)]),
    readBody: async (_l, connection, message) => (reads.push({ connection, message }), "Plain synthetic body"),
    brain: null,
    policy: { email: true, calendar: true, storeDrafts: true },
    save: async (_l, r) => (saved.push(r), "id-1"),
    proposeReply: async (_l, r) => (proposed.push(r), "00000000-0000-4000-8000-0000000000d1"),
    // The connection's own provider and grant decide (security L4): the Google connection is allowed, the Microsoft one only when it holds the write grant.
    canProposeFor: canProposeFor ?? (async (_l, c) => c === G),
  };
  return { d, saved, reads, proposed };
}

describe("a briefing run for a person with a Google and a Microsoft mailbox", () => {
  it("reads each thread through the reader with its own connection id, and proposes a reply only for the Google thread", async () => {
    const { d, saved, reads, proposed } = run();
    await runBriefing(d, { laneId: "PKG" as LaneId, ownerUserId: OWNER, trigger: "manual", now: NOW, viewerTz: "America/New_York" });
    expect(reads.map((r) => [r.connection, r.message]).sort()).toEqual([[G, "g-1"], [M, "ms-1"]].sort());
    expect(proposed.map((p) => p.connectionId)).toEqual([G]);
    const s = saved[0];
    expect(s?.content.notes.filter((n) => n.startsWith("reply_not_proposed:"))).toHaveLength(1);
    expect(s?.content.notes.some((n) => n.startsWith("reply_proposal_failed"))).toBe(false); // no failed attempt, no unsupported_op noise
    expect(s?.sourceRefs.map((r) => r.connectionId).sort()).toEqual([G, M].sort());
    expect(JSON.stringify(s)).not.toContain("Plain synthetic body");
  });

  it("fail closed: a thread whose connection's provider is unknown to the gate (not in Coverage, not loadable) is never proposed a reply", async () => {
    // Coverage lists only the Microsoft connection M and a Google one G2; the Google thread's connection G is missing, so its provider is unknown.
    const G2 = "00000000-0000-4000-8000-0000000c2699";
    const { d, proposed } = run([cov("mail", "google", G2, "other@pubk.example.test"), cov("mail", "microsoft", M, "robert@pubkgroup.example.test")], async () => false);
    await runBriefing(d, { laneId: "PKG" as LaneId, ownerUserId: OWNER, trigger: "manual", now: NOW, viewerTz: "America/New_York" });
    expect(proposed).toEqual([]);
  });

  it("security L4: the decision is the connection's (provider and grant), never a source label: empty or unreadable coverage changes nothing, and a Microsoft connection WITH the grant is proposed", async () => {
    const open = { ...{}, calls: [] as string[] };
    for (const rows of [[], undefined, [cov("mail", "microsoft", M, "robert@pubkgroup.example.test")]]) {
      const { d, proposed } = run(rows as unknown[] | undefined, async (_l, c) => (open.calls.push(c), c === G)); // Microsoft without the grant, whatever coverage says
      await runBriefing(d, { laneId: "PKG" as LaneId, ownerUserId: OWNER, trigger: "manual", now: NOW, viewerTz: "America/New_York" });
      expect(proposed.map((p) => p.connectionId).filter((c) => c !== G)).toEqual([]);
    }
    const granted = run(undefined, async () => true);
    await runBriefing(granted.d, { laneId: "PKG" as LaneId, ownerUserId: OWNER, trigger: "manual", now: NOW, viewerTz: "America/New_York" });
    expect(granted.proposed.map((p) => p.connectionId).sort()).toEqual([G, M].sort());
    const broken = run(undefined, async () => { throw new Error("facts unreadable"); });
    await runBriefing(broken.d, { laneId: "PKG" as LaneId, ownerUserId: OWNER, trigger: "manual", now: NOW, viewerTz: "America/New_York" });
    expect(broken.proposed).toEqual([]); // fail closed
  });
});
