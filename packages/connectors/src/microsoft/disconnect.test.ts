// T-257 (D-55): local Disconnect of a Microsoft mailbox. Owner only, any enabled state, tokens deleted by the Vault call, nothing sent to
// Microsoft. The real token vault runs over an RPC twin of core.connection_token_revoke in one test. Synthetic data only (rule 10).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import { createMicrosoftDisconnect } from "./disconnect";

afterEach(() => vi.unstubAllGlobals());

const OWNER = "00000000-0000-4000-8000-0000000b0257";
const OTHER = "00000000-0000-4000-8000-0000000b0258";
const CID = "00000000-0000-4000-8000-0000000c0257";
const row = (over: Record<string, unknown> = {}) => ({
  id: CID, lane_id: "PKG", provider: "microsoft", external_account_id: "exec@corp.example.test", status: "active", features: {},
  features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null, owner_user_id: OWNER, ...over,
});
const conn = (over: Record<string, unknown> = {}) => mintLaneBoundConnection(row(over) as never) as LaneBoundConnection<string>;

function setup(rowOver: Record<string, unknown> = {}, laneOfRow = "PKG") {
  const revoked: { lane: string; id: string; actor: string | undefined }[] = [];
  const loader = {
    loadConnection: vi.fn(async (laneId: string, id: string) => {
      if (laneId !== laneOfRow || id !== CID) throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
      return conn(rowOver);
    }),
  };
  const vault = { revokeToken: vi.fn(async (lane: string, c: LaneBoundConnection<string>, actor?: string) => { revoked.push({ lane, id: c.id, actor }); return true; }) };
  return { loader, vault, revoked, disconnect: createMicrosoftDisconnect({ loader: loader as never, vault: vault as never }) };
}
const refused = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as ConnectorError;

describe("who may disconnect", () => {
  it("the mailbox owner: the Vault call runs once for this lane and row with the owner as the actor", async () => {
    const s = setup();
    expect(await s.disconnect("PKG", CID, OWNER)).toBe(true);
    expect(s.revoked).toEqual([{ lane: "PKG", id: CID, actor: OWNER }]);
  });
  it("another user, even with a role in the lane, gets not_found and nothing is deleted", async () => {
    const s = setup();
    expect((await refused(s.disconnect("PKG", CID, OTHER))).info.kind).toBe("not_found");
    expect(s.vault.revokeToken).not.toHaveBeenCalled();
  });
  it("a row with no owner (legacy) is nobody's to disconnect here", async () => {
    const s = setup({ owner_user_id: null });
    expect((await refused(s.disconnect("PKG", CID, OWNER))).info.kind).toBe("not_found");
    expect(s.vault.revokeToken).not.toHaveBeenCalled();
  });
  it("another lane's connection id is not_found (the row is read by lane and id)", async () => {
    const s = setup({}, "APK");
    expect((await refused(s.disconnect("PKG", CID, OWNER))).info.kind).toBe("not_found");
    expect(s.vault.revokeToken).not.toHaveBeenCalled();
  });
  it("a Google or QuickBooks row is not disconnected here", async () => {
    for (const provider of ["google", "quickbooks"]) {
      const s = setup({ provider });
      expect((await refused(s.disconnect("PKG", CID, OWNER))).info.kind, provider).toBe("not_found");
      expect(s.vault.revokeToken).not.toHaveBeenCalled();
    }
  });
  it("a missing or malformed acting user is refused before the row is read", async () => {
    const s = setup();
    for (const actor of ["", "not-a-uuid", undefined as unknown as string]) expect((await refused(s.disconnect("PKG", CID, actor))).info.kind).toBe("invalid_input");
    expect(s.loader.loadConnection).not.toHaveBeenCalled();
  });
});

describe("what it does and does not do", () => {
  it("works in any status and without asking whether Microsoft is enabled (a paused connection can be disconnected): the only reads are the row and the Vault call", async () => {
    for (const status of ["active", "pending", "degraded", "reconnect_required", "disconnected"]) {
      const s = setup({ status });
      await s.disconnect("PKG", CID, OWNER);
      expect(s.revoked, status).toHaveLength(1);
      expect(Object.keys(s.loader)).toEqual(["loadConnection"]);
    }
  });
  it("makes no request to Microsoft or anyone else: global fetch is never called", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    await setup().disconnect("PKG", CID, OWNER);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("a Vault failure is passed on and the caller sees it (nothing is claimed deleted)", async () => {
    const s = setup();
    s.vault.revokeToken.mockRejectedValueOnce(new ConnectorError({ kind: "transient", message: "Token store unavailable" }));
    expect((await refused(s.disconnect("PKG", CID, OWNER))).info.kind).toBe("transient");
  });
});

describe("change-notification subscriptions (T-264)", () => {
  const withSubs = (removeConnection: (lane: string, id: string) => Promise<unknown>) => {
    const s = setup();
    const entries: unknown[] = [];
    const logger = { child: () => logger, info: () => undefined, error: () => undefined, debug: () => undefined, warn: (_m: string, f: unknown) => void entries.push(f) };
    return { s, entries, disconnect: createMicrosoftDisconnect({ loader: s.loader as never, vault: s.vault as never, subscriptions: { removeConnection }, logger: logger as never }) };
  };

  it("after the Vault call, the connection's subscriptions are marked removed for exactly this lane and connection; nothing is sent to Microsoft", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const removeConnection = vi.fn(async () => 2);
    const { s, disconnect } = withSubs(removeConnection);
    expect(await disconnect("PKG", CID, OWNER)).toBe(true);
    expect(removeConnection).toHaveBeenCalledExactlyOnceWith("PKG", CID);
    expect(s.revoked).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a failure to mark them never blocks or fails the disconnect (best effort); the log line carries ids only", async () => {
    const { s, entries, disconnect } = withSubs(async () => { throw new ConnectorError({ kind: "transient", message: "Subscription store unavailable for SECRET-TEXT" }); });
    expect(await disconnect("PKG", CID, OWNER)).toBe(true);
    expect(s.revoked).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain("SECRET-TEXT");
    expect(entries).toEqual([{ laneId: "PKG", connectionId: CID, provider: "microsoft" }]);
  });

  it("nothing is marked when the caller is refused (another user's connection, another lane's id)", async () => {
    const removeConnection = vi.fn(async () => 0);
    const { disconnect } = withSubs(removeConnection);
    expect((await refused(disconnect("PKG", CID, OTHER))).info.kind).toBe("not_found");
    expect((await refused(disconnect("APK", CID, OWNER))).info.kind).toBe("not_found");
    expect(removeConnection).not.toHaveBeenCalled();
  });

  it("a Vault failure means the subscriptions are not marked either (the connection is still connected)", async () => {
    const removeConnection = vi.fn(async () => 0);
    const { s, disconnect } = withSubs(removeConnection);
    s.vault.revokeToken.mockRejectedValueOnce(new ConnectorError({ kind: "transient", message: "x" }));
    await refused(disconnect("PKG", CID, OWNER));
    expect(removeConnection).not.toHaveBeenCalled();
  });
});

describe("no way to reach Microsoft (source level)", () => {
  it("microsoft/disconnect.ts imports no HTTP client, token manager, guard, Graph api, provider or http module", () => {
    const source = readFileSync(new URL("./disconnect.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1] ?? "");
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec, spec).not.toMatch(/http|token-manager|guard|\/api$|\.\/api|provider|graph|undici|axios|node:https?/i);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});
