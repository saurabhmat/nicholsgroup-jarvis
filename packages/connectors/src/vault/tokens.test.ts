import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import { createConnectionLoader, CONNECTION_COLUMNS } from "./loader";
import { forgetSecretsForTests, SecretValue } from "./secret";
import { createTokenVault } from "./tokens";

const ID = "00000000-0000-4000-8000-0000000000d1";
const row = {
  id: ID,
  lane_id: "PKG",
  provider: "quickbooks",
  external_account_id: "realm-synthetic",
  status: "active",
  features: {},
  features_checked_at: null,
  token_expires_at: null,
  last_sync_at: null,
  last_error: null,
} as const;
const conn = () => mintLaneBoundConnection({ ...row });

type Call = { schema: string; fn: string; args: Record<string, unknown> };

function fakeClient(result: { data?: unknown; error?: { code?: string; message?: string } | null } | (() => never)) {
  const calls: Call[] = [];
  const client = {
    schema: (schema: string) => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ schema, fn, args });
        if (typeof result === "function") return result();
        return { data: result.data ?? null, error: result.error ?? null };
      },
    }),
  };
  return { calls, clientFor: vi.fn(async () => client as never) };
}

const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorError);
    return (e as ConnectorError).info.kind;
  }
  throw new Error("expected a rejection");
};

afterEach(() => forgetSecretsForTests());

describe("createTokenVault", () => {
  it("reads by (lane, connection) through core.connection_token_read and returns a SecretValue", async () => {
    const { calls, clientFor } = fakeClient({ data: "synthetic-token-1" });
    const token = await createTokenVault(clientFor).getToken("PKG", conn());
    expect(token).toBeInstanceOf(SecretValue);
    expect(token.reveal()).toBe("synthetic-token-1");
    expect(clientFor).toHaveBeenCalledWith("PKG");
    expect(calls).toEqual([{ schema: "core", fn: "connection_token_read", args: { p_lane_id: "PKG", p_connection_id: ID } }]);
  });

  it("refuses a connection minted for another lane before touching the database", async () => {
    const { calls, clientFor } = fakeClient({ data: "x" });
    expect(await kindOf(createTokenVault(clientFor).getToken("APK", conn()))).toBe("lane_mismatch");
    expect(clientFor).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("refuses forged (unminted) connections", async () => {
    const { clientFor } = fakeClient({ data: "x" });
    await expect(createTokenVault(clientFor).getToken("PKG", { ...row } as never)).rejects.toBeInstanceOf(ConnectorError);
    expect(clientFor).not.toHaveBeenCalled();
  });

  it.each([
    ["P0002", "not_found"],
    ["55000", "connection_unavailable"],
    ["22023", "invalid_input"],
    ["42501", "forbidden"],
    ["XX000", "transient"],
  ])("maps database error %s to %s without passing the database message on", async (code, kind) => {
    const { clientFor } = fakeClient({ error: { code, message: "row (synthetic-leak-1) failed" } });
    const p = createTokenVault(clientFor).getToken("PKG", conn());
    expect(await kindOf(p)).toBe(kind);
    await p.catch((e: ConnectorError) => expect(JSON.stringify(e)).not.toContain("synthetic-leak-1"));
  });

  it("treats a thrown client or an unavailable lane as safe errors", async () => {
    const thrower = fakeClient(() => {
      throw new Error("socket closed synthetic-leak-2");
    });
    expect(await kindOf(createTokenVault(thrower.clientFor).getToken("PKG", conn()))).toBe("transient");
    const noLane = createTokenVault(async () => {
      throw new Error("not served");
    });
    expect(await kindOf(noLane.getToken("PKG", conn()))).toBe("connection_unavailable");
  });

  it("an empty read result is not a token", async () => {
    const { clientFor } = fakeClient({ data: "" });
    expect(await kindOf(createTokenVault(clientFor).getToken("PKG", conn()))).toBe("not_found");
  });

  it("stores and rotates through RPC arguments (bind parameters), with explicit expiry and actor", async () => {
    const { calls, clientFor } = fakeClient({ data: null });
    const vault = createTokenVault(clientFor);
    await vault.storeToken("PKG", conn(), new SecretValue("synthetic-token-2"), new Date("2027-02-01T00:00:00Z"), "00000000-0000-4000-8000-0000000000aa");
    await vault.rotateToken("PKG", conn(), new SecretValue("synthetic-token-3"), null);
    expect(calls).toEqual([
      {
        schema: "core",
        fn: "connection_token_store",
        args: {
          p_lane_id: "PKG",
          p_connection_id: ID,
          p_secret: "synthetic-token-2",
          p_expires_at: "2027-02-01T00:00:00.000Z",
          p_actor_id: "00000000-0000-4000-8000-0000000000aa",
        },
      },
      {
        schema: "core",
        fn: "connection_token_rotate",
        args: { p_lane_id: "PKG", p_connection_id: ID, p_secret: "synthetic-token-3", p_expires_at: null },
      },
    ]);
  });

  it("only accepts credentials as SecretValue and expiries as valid dates", async () => {
    const { calls, clientFor } = fakeClient({ data: null });
    const vault = createTokenVault(clientFor);
    expect(await kindOf(vault.storeToken("PKG", conn(), "plain" as never, null))).toBe("invalid_input");
    expect(await kindOf(vault.rotateToken("PKG", conn(), new SecretValue("synthetic-token-4"), new Date("nope")))).toBe("invalid_input");
    expect(calls).toEqual([]);
  });

  it("revokes (disconnects) and reports whether a credential was deleted", async () => {
    const { calls, clientFor } = fakeClient({ data: true });
    expect(await createTokenVault(clientFor).revokeToken("PKG", conn())).toBe(true);
    expect(calls[0]).toEqual({ schema: "core", fn: "connection_token_revoke", args: { p_lane_id: "PKG", p_connection_id: ID, p_actor_id: null } });
  });
});

describe("createConnectionLoader", () => {
  function fakeTable(data: unknown, error: unknown = null) {
    const filters: [string, unknown][] = [];
    let selected = "";
    const q = {
      select: (cols: string) => ((selected = cols), q),
      eq: (col: string, v: unknown) => (filters.push([col, v]), q),
      maybeSingle: async () => ({ data, error }),
    };
    const client = { schema: () => ({ from: (t: string) => (expect(t).toBe("connections"), q) }) };
    return { filters, selected: () => selected, clientFor: async () => client as never };
  }

  it("selects exactly the contract columns by lane and id, and mints the row", async () => {
    const t = fakeTable({ ...row });
    const loaded = await createConnectionLoader(t.clientFor).loadConnection("PKG", ID);
    expect(loaded.id).toBe(ID);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(t.selected()).toBe(CONNECTION_COLUMNS);
    expect(t.filters).toEqual([
      ["lane_id", "PKG"],
      ["id", ID],
    ]);
    // the minted row passes the vault's lane guard
    const { clientFor } = fakeClient({ data: "synthetic-token-5" });
    await expect(createTokenVault(clientFor).getToken("PKG", loaded)).resolves.toBeInstanceOf(SecretValue);
  });

  it("reports a missing or other-lane row as not_found", async () => {
    expect(await kindOf(createConnectionLoader(fakeTable(null).clientFor).loadConnection("PKG", ID))).toBe("not_found");
  });

  it("rejects bad ids, store errors and rows that do not match the contract", async () => {
    const loader = createConnectionLoader(fakeTable({ ...row }).clientFor);
    expect(await kindOf(loader.loadConnection("PKG", "not-a-uuid"))).toBe("invalid_input");
    expect(await kindOf(loader.loadConnection("pkg" as never, ID))).toBe("invalid_input");
    expect(await kindOf(createConnectionLoader(fakeTable(null, { code: "XX" }).clientFor).loadConnection("PKG", ID))).toBe("transient");
    expect(await kindOf(createConnectionLoader(fakeTable({ ...row, extra: 1 }).clientFor).loadConnection("PKG", ID))).toBe("provider_error");
  });
});
