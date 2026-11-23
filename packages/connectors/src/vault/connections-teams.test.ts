// T-278: the connection store's mailbox list never includes a Teams account, and the owner is set for Teams rows at connect time (a fake job client stands in for the database).
import { describe, expect, it } from "vitest";
import { createConnectionStore } from "./connections";

describe("connection store and Teams", () => {
  it("listMailAccounts (the lane's own addresses) queries google and microsoft only", async () => {
    const ins: [string, unknown][] = [];
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq"]) builder[m] = () => builder;
    builder.in = (c: string, v: unknown) => (ins.push([c, v]), builder);
    builder.then = (resolve: (v: unknown) => void) => resolve({ data: [{ external_account_id: "A@x.test" }], error: null });
    const store = createConnectionStore((async () => ({ schema: () => ({ from: () => builder }) })) as never);
    expect(await store.listMailAccounts("PKG")).toEqual(["a@x.test"]);
    expect(ins).toEqual([["provider", ["google", "microsoft"]]]);
  });

  it("ensureConnection sets the owner of a Teams row to the user who connects it", async () => {
    const upserts: Record<string, unknown>[] = [];
    const row = { id: "00000000-0000-4000-8000-0000000000aa", lane_id: "PKG", provider: "microsoft_teams", external_account_id: "p@x.test", status: "pending", features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null, owner_user_id: "00000000-0000-4000-8000-0000000000bb" };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is"]) b[m] = () => b;
    b.upsert = async (v: Record<string, unknown>) => (upserts.push(v), { error: null });
    b.update = (v: Record<string, unknown>) => (upserts.push({ update: v }), b);
    b.maybeSingle = async () => ({ data: row, error: null });
    b.then = (r: (v: unknown) => void) => r({ error: null });
    const store = createConnectionStore((async () => ({ schema: () => ({ from: () => b }) })) as never);
    await store.ensureConnection("PKG", "microsoft_teams", "p@x.test", row.owner_user_id);
    expect(upserts[0]).toMatchObject({ provider: "microsoft_teams", owner_user_id: row.owner_user_id });
  });
});
