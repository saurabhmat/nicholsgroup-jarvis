// T-247: the scheduled briefing runs per person: the users who own an active mailbox in the lane, once each.
import { describe, expect, it } from "vitest";
import { briefingOwners } from "./index";

function fake(rows: unknown, error: unknown = null) {
  const seen: string[] = [];
  const q: Record<string, unknown> = {
    select: (c: string) => (seen.push(`select ${c}`), q),
    eq: (c: string, v: unknown) => (seen.push(`${c}=${String(v)}`), q),
    in: (c: string, v: unknown[]) => (seen.push(`${c} in ${v.join(",")}`), q),
    not: (c: string, op: string, v: unknown) => (seen.push(`${c} not ${op} ${String(v)}`), Promise.resolve({ data: rows, error })),
  };
  return { client: { schema: () => ({ from: (t: string) => (seen.push(`from ${t}`), q) }) } as never, seen };
}

describe("briefingOwners", () => {
  it("returns each owner of an active mail connection once, sorted; two accounts of one user are one run", async () => {
    const f = fake([{ owner_user_id: "b" }, { owner_user_id: "a" }, { owner_user_id: "b" }]);
    expect(await briefingOwners(f.client, "PKG")).toEqual(["a", "b"]);
  });
  it("reads only this lane's active or degraded Google/Microsoft connections that have an owner", async () => {
    const f = fake([]);
    await briefingOwners(f.client, "PKG");
    expect(f.seen).toEqual(["from connections", "select owner_user_id", "lane_id=PKG", "provider in google,microsoft", "transport=native", "status in active,degraded", "owner_user_id not is null"]);
  });
  it("an error or an unexpected answer is nobody (fail closed)", async () => {
    expect(await briefingOwners(fake(null, { message: "x" }).client, "PKG")).toEqual([]);
    expect(await briefingOwners(fake("nope").client, "PKG")).toEqual([]);
    expect(await briefingOwners(fake([{ owner_user_id: 5 }, {}]).client, "PKG")).toEqual([]);
  });
});
