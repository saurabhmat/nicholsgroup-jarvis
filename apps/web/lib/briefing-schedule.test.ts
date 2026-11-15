// T-231c: the schedule is off unless lane_config.briefing.schedule_enabled; only the lane's New York hour.
// T-247: a briefing is per person: the run goes to every user who owns an active mailbox in the lane (not to the lane's owners), and each
// is re-checked for the own_mail view on every run; the job reads that user's mailboxes only (loadBriefing names the owner).
import { describe, expect, it } from "vitest";
import { dueOwners, refreshOwners, type ClientFor } from "./briefing-schedule";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const AT_7_NY = new Date("2026-11-11T12:10:00Z");

/** `mailboxOwners`: the owner_user_id of each active Google connection of the lane (duplicates = several accounts of one user). */
function client(config: unknown, views: Record<string, string[]> = {}, mailboxOwners: string[] = [A, B, B]): ClientFor {
  const seen: string[] = [];
  const c = {
    schema: () => ({
      from: (t: string) => ({
        select: () => {
          const q: Record<string, unknown> = {
            eq: (col: string, v: unknown) => (seen.push(`${t}.${col}=${String(v)}`), q),
            in: (col: string, v: unknown[]) => (seen.push(`${t}.${col} in ${v.join(",")}`), q),
            not: (col: string, op: string, v: unknown) => (seen.push(`${t}.${col} not ${op} ${String(v)}`), Promise.resolve({ data: mailboxOwners.map((o) => ({ owner_user_id: o })), error: null })),
            maybeSingle: async () => ({ data: { config }, error: null }),
          };
          return q;
        },
      }),
      rpc: async (_fn: string, args: { p_uid: string; p_view: string }) => ({ data: (views[args.p_uid] ?? []).includes(args.p_view) ? ["PKG"] : [], error: null }),
    }),
    seen,
  };
  const f: ClientFor & { seen?: string[] } = async () => c as never;
  f.seen = seen;
  return f;
}

describe("dueOwners", () => {
  it("off by default", async () => {
    await expect(dueOwners(client({}), "PKG", AT_7_NY)).resolves.toEqual([]);
  });
  it("on, at the lane's hour: users who own an active mailbox and hold own_mail, once each (two accounts of one user are one run)", async () => {
    const cfg = { briefing: { schedule_enabled: true, time: "07:00" } };
    const views = { [A]: ["own_mail"], [B]: ["own_mail"] };
    await expect(dueOwners(client(cfg, views), "PKG", AT_7_NY)).resolves.toEqual([A, B]);
    await expect(dueOwners(client(cfg, views), "PKG", new Date("2026-11-11T14:10:00Z"))).resolves.toEqual([]);
  });
  it("a user who lost own_mail, and a lane owner with no mailbox of their own, get no run", async () => {
    const cfg = { briefing: { schedule_enabled: true, time: "07:00" } };
    // A holds own_mail; B owns a mailbox but no longer holds the view; C holds the view but owns no mailbox (not in the connections rows)
    const views = { [A]: ["own_mail"], [C]: ["own_mail"] };
    await expect(dueOwners(client(cfg, views, [A, B]), "PKG", AT_7_NY)).resolves.toEqual([A]);
  });
  it("reads only active/degraded Google or Microsoft connections of this lane with an owner (the job never guesses an owner)", async () => {
    const cfg = { briefing: { schedule_enabled: true, time: "07:00" } };
    const c = client(cfg, { [A]: ["own_mail"] }, [A]);
    await dueOwners(c, "PKG", AT_7_NY);
    expect((c as unknown as { seen: string[] }).seen).toEqual(
      expect.arrayContaining(["connections.lane_id=PKG", "connections.provider in google,microsoft", "connections.status in active,degraded", "connections.owner_user_id not is null"]),
    );
  });
  it("defaults (D-32): 06:30 New York on weekdays only", async () => {
    const cfg = { briefing: { schedule_enabled: true } };
    const views = { [A]: ["own_mail"] };
    await expect(dueOwners(client(cfg, views, [A]), "PKG", new Date("2026-11-11T11:30:00Z"))).resolves.toEqual([A]); // Wed 06:30
    await expect(dueOwners(client(cfg, views, [A]), "PKG", new Date("2026-11-14T11:30:00Z"))).resolves.toEqual([]); // Sat 06:30
  });
});

describe("refreshOwners (T-238: the refresh after new mail follows the schedule switch)", () => {
  const views = { [A]: ["own_mail"] };
  it("schedule off (default, or explicitly false): nobody, so no automatic refresh", async () => {
    await expect(refreshOwners(client({}, views), "PKG")).resolves.toEqual([]);
    await expect(refreshOwners(client({ briefing: { schedule_enabled: false } }, views), "PKG")).resolves.toEqual([]);
  });
  it("schedule on: every mailbox owner holding own_mail, at any hour or day (the run claim still gates)", async () => {
    await expect(refreshOwners(client({ briefing: { schedule_enabled: true } }, views, [A, B]), "PKG")).resolves.toEqual([A]);
  });
  it("an unreadable config is off", async () => {
    const broken: ClientFor = async () => ({ schema: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "x" } }) }) }) }) }) }) as never;
    await expect(refreshOwners(broken, "PKG")).resolves.toEqual([]);
  });
});
