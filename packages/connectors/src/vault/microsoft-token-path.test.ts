// T-066 (review item of T-256): the first Microsoft token is stored by the connect flow through the REAL `createTokenVault` (the
// code `storeToken` / `getToken` / `rotateToken` use in production) over an RPC twin of the T-032 SQL functions, and is then read, refreshed
// and rotated by the real Microsoft token manager and used by the real Graph client. The twin passes the same arguments the SQL takes (ids,
// the secret, a SHA-256 of the replaced text) and, like the SQL, never looks at the provider. The pgTAP side of this is not run here.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { createMicrosoftHarness, CONNECT_USER, TENANT_A } from "../testing/microsoft-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeMicrosoft } from "../testing/msw/microsoft/handlers";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import { SecretValue } from "./secret";
import { createTokenVault } from "./tokens";
import { parseStored } from "../microsoft/token-manager";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

type Call = { fn: string; args: Record<string, unknown> };

function setup() {
  const fake = createFakeMicrosoft();
  server.use(...fake.handlers);
  const calls: Call[] = [];
  const secretWrites: string[] = [];
  // An RPC twin of core.connection_token_store / _read / _rotate over the harness's rows and secret map.
  const rpc = async (fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { code: string } | null }> => {
    calls.push({ fn, args: { ...args, ...(args.p_secret === undefined ? {} : { p_secret: "<secret>" }) } });
    const row = h.rows.get(String(args.p_connection_id));
    if (!row || row.lane_id !== args.p_lane_id) return { data: null, error: { code: "P0002" } };
    // The SQL: 1 to 16384 characters (22023); a disconnected connection's token is not readable (55000).
    const tooLong = (v: unknown) => typeof v !== "string" || v.length === 0 || v.length > 16384;
    if (fn === "connection_token_store") {
      if (tooLong(args.p_secret)) return { data: null, error: { code: "22023" } };
      secretWrites.push(String(args.p_secret));
      h.secrets.set(row.id, String(args.p_secret));
      row.status = "active";
      return { data: null, error: null };
    }
    if (fn === "connection_token_read") {
      if (row.status === "disconnected") return { data: null, error: { code: "55000" } };
      const text = h.secrets.get(row.id);
      return text === undefined ? { data: null, error: { code: "P0002" } } : { data: text, error: null };
    }
    if (fn === "connection_token_rotate") {
      const current = h.secrets.get(row.id);
      if (current === undefined) return { data: null, error: { code: "P0002" } };
      if (tooLong(args.p_secret)) return { data: null, error: { code: "22023" } };
      if (createHash("sha256").update(current, "utf8").digest("hex") !== args.p_expected_hash) return { data: null, error: { code: "40001" } };
      secretWrites.push(String(args.p_secret));
      h.secrets.set(row.id, String(args.p_secret));
      return { data: null, error: null };
    }
    return { data: null, error: { code: "42883" } };
  };
  const client = { schema: () => ({ rpc }) };
  const vault = createTokenVault(async () => client as never);
  const h = createMicrosoftHarness({
    fake,
    lanes: { PKG: { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: ["corp.example.test"] } },
    vault,
  });
  return { fake, h, calls, vault, secretWrites };
}

describe("a Microsoft token stored by the connect flow works through the real token vault", () => {
  it("is stored with core.connection_token_store, then read, refreshed and rotated (compare-and-swap) by the token manager, and used by Graph", async () => {
    const { fake, h, calls, vault, secretWrites } = setup();
    const { result } = await h.connectViaCallback("PKG", { address: "exec@corp.example.test" });
    expect(result.ok).toBe(true);
    const row = [...h.rows.values()][0];
    if (!row) throw new Error("no row");
    expect(row.status).toBe("active");
    expect(calls.map((c) => c.fn)).toEqual(["connection_token_store"]);
    expect(calls[0]?.args).toMatchObject({ p_lane_id: "PKG", p_connection_id: row.id, p_expires_at: null, p_actor_id: CONNECT_USER });

    // The stored text is a Microsoft token set the manager accepts (ISO `obtained_at`), without the id_token.
    const stored = parseStored(new SecretValue(secretWrites[0] ?? ""));
    expect(stored.refresh.reveal()).toMatch(/^synthetic-ms-refresh-/);
    expect(secretWrites[0]).not.toContain("id_token");

    // Read through the real vault: the guard approves the row, the manager hands out the stored access token (not expired yet: no refresh).
    const guarded = await h.guard("PKG", h.bind(row));
    const first = await h.tokens.accessToken("PKG", guarded);
    expect(first.reveal()).toMatch(/^synthetic-ms-access-/);
    expect(fake.state.refreshes).toBe(0);
    expect(calls.map((c) => c.fn)).toEqual(["connection_token_store", "connection_token_read"]);

    // Graph accepts it: the health check calls /me with the stored token through the guarded client.
    expect(await h.health("PKG", h.bind(row))).toMatchObject({ ok: true, status: "active" });

    // Expired: refreshed at the lane's tenant, and the new set REPLACES the stored one with a compare-and-swap on the old text's hash.
    const oldText = h.secrets.get(row.id) ?? "";
    h.expireStoredAccess(row.id);
    const expiredText = h.secrets.get(row.id) ?? "";
    const second = await h.tokens.accessToken("PKG", guarded);
    expect(second.reveal()).not.toBe(first.reveal());
    expect(fake.state.refreshes).toBe(1);
    const rotate = calls.filter((c) => c.fn === "connection_token_rotate");
    expect(rotate).toHaveLength(1);
    expect(rotate[0]?.args.p_expected_hash).toBe(createHash("sha256").update(expiredText, "utf8").digest("hex"));
    const rotated = parseStored(new SecretValue(h.secrets.get(row.id) ?? ""));
    expect(rotated.refresh.reveal()).not.toBe(stored.refresh.reveal()); // Microsoft rotates the refresh token: the new one is stored
    expect(h.secrets.get(row.id)).not.toBe(oldText);

    // A writer that still holds the old text loses the compare-and-swap and changes nothing.
    const before = h.secrets.get(row.id);
    expect(await vault.rotateToken("PKG", h.bind(row), new SecretValue("synthetic-late-set"), null, new SecretValue(expiredText))).toBe(false);
    expect(h.secrets.get(row.id)).toBe(before);
  });

  it("the twin's own lane check: a connection minted for lane APK with a PKG row's id reads nothing (not_found), and the TypeScript lane check refuses the PKG-bound one for APK", async () => {
    const { h, vault } = setup();
    await h.connectViaCallback("PKG", { address: "exec@corp.example.test" });
    const row = [...h.rows.values()][0];
    if (!row) throw new Error("no row");
    await expect(vault.getToken("PKG", h.bind(row))).resolves.toBeInstanceOf(SecretValue);
    const asApk = mintLaneBoundConnection({ ...row, lane_id: "APK", features: { ...row.features } });
    await expect(vault.getToken("APK", asApk)).rejects.toMatchObject({ info: { kind: "not_found" } });
    await expect(vault.getToken("APK", h.bind(row))).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
  });

  it("a disconnected connection's token is not readable, and a secret over 16384 characters is refused, as in the SQL", async () => {
    const { h, vault } = setup();
    await h.connectViaCallback("PKG", { address: "exec@corp.example.test" });
    const row = [...h.rows.values()][0];
    if (!row) throw new Error("no row");
    await expect(vault.storeToken("PKG", h.bind(row), new SecretValue("x".repeat(16385)), null)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    row.status = "disconnected";
    await expect(vault.getToken("PKG", h.bind(row))).rejects.toMatchObject({ info: { kind: "connection_unavailable" } });
  });
});
