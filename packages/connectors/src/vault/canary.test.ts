// Canary-token tests (T-033): a credential that went through the vault never shows up in logs, API responses, RSC
// payloads, prompt text or errors, whatever path it takes out.
import { inspect, format } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError, toConnectorError } from "../contract/errors";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { redactFields, redactText } from "../log/redact";
import { forgetSecretsForTests, isSecretValue, REDACTED, SecretValue } from "./secret";
import { createTokenVault } from "./tokens";

const CANARY = "synthetic-canary-9f3b7c1e-access";
const REFRESH = "synthetic-canary-refresh-77aa";
const TOKEN_SET = JSON.stringify({ access_token: CANARY, refresh_token: REFRESH, expires_in: 3600 });

const conn = () =>
  mintLaneBoundConnection({
    id: "00000000-0000-4000-8000-0000000000c1",
    lane_id: "PKG",
    provider: "quickbooks",
    external_account_id: "realm-synthetic",
    status: "active",
    features: {},
    features_checked_at: null,
    token_expires_at: null,
    last_sync_at: null,
    last_error: null,
  });

/** A fake job client whose RPC returns the stored token set. */
function vaultWith(stored: string) {
  const client = { schema: () => ({ rpc: async () => ({ data: stored, error: null }) }) };
  return createTokenVault(async () => client as never);
}

const leaks = (text: string) => text.includes(CANARY) || text.includes(REFRESH);

afterEach(() => forgetSecretsForTests());

describe("SecretValue", () => {
  it("prints [redacted] through every ordinary conversion", () => {
    const s = new SecretValue(CANARY);
    const views = [
      JSON.stringify({ token: s }), // API response bodies, RSC/JSON payloads
      JSON.stringify([s]),
      String(s),
      `${s}`, // prompt templates
      "Authorization: " + s,
      inspect(s),
      inspect({ nested: { s } }, { depth: 5 }),
      format("%s %o %O %j", s, s, s, s), // console.log formatting
      JSON.stringify(structuredClone({ s })), // RSC / postMessage use structured-clone semantics
      JSON.stringify({ ...s }),
      Object.keys(s).join(","),
    ];
    for (const v of views) expect(leaks(v), v).toBe(false);
    expect(s.reveal()).toBe(CANARY);
  });

  it("cannot be modified or read through properties", () => {
    const s = new SecretValue(CANARY);
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.getOwnPropertyNames(s)).toEqual([]);
  });

  it("rejects empty values", () => {
    expect(() => new SecretValue("")).toThrow(TypeError);
  });
});

describe("getToken output", () => {
  it("is a SecretValue, and every field of a stored token set is scrubbed once seen", async () => {
    const token = await vaultWith(TOKEN_SET).getToken("PKG", conn());
    expect(isSecretValue(token)).toBe(true);
    expect(JSON.stringify({ token })).not.toContain("canary");
    // a provider echoing the refresh token back in an error body
    expect(redactText(`invalid_grant for ${REFRESH} (access ${CANARY})`)).toBe(`invalid_grant for ${REDACTED} (access ${REDACTED})`);
  });
});

describe("logs", () => {
  it("never write a known credential, wherever it sits in an entry", async () => {
    const token = await vaultWith(TOKEN_SET).getToken("PKG", conn());
    const entries: LogEntry[] = [];
    const log = createConnectorLogger({ sink: (e) => entries.push(e) });
    log.info("quickbooks.request", {
      token,
      headers: { Authorization: `Bearer ${token.reveal()}` },
      url: `https://example.test/cb?code=abc&access_token=${token.reveal()}`,
      note_for_humans: `got ${token.reveal()} back`,
      error: new Error(`provider said ${token.reveal()}`),
      list: [token.reveal(), { deeper: TOKEN_SET }],
      status: 401,
    });
    log.child({ laneId: "PKG", provider: "quickbooks", connectionId: conn().id }).error("quickbooks.refresh_failed", {
      response: TOKEN_SET,
    });
    const out = JSON.stringify(entries);
    expect(leaks(out)).toBe(false);
    expect(entries[0]?.fields.status).toBe(401);
    expect(entries[1]?.lane_id).toBe("PKG");
  });

  it("redacts credential shapes it has never seen (Bearer, query parameters, JSON fields, JWTs, vendor keys)", () => {
    const text = [
      "Authorization: Bearer abc.def-ghi",
      "https://x.test/cb?state=1&code=AB12&client_secret=shh",
      '{"refresh_token": "rt-123", "realm": "1"}',
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJl",
      "key sk_live_51Hsynthetic here",
    ].join(" | ");
    const out = redactText(text);
    for (const secret of ["abc.def-ghi", "AB12", "shh", "rt-123", "eyJhbGciOiJIUzI1NiJ9", "sk_live_51Hsynthetic"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("state=1");
    expect(out).toContain('"realm": "1"');
  });

  it("drop credential-named fields and keep ordinary ones", () => {
    expect(redactFields({ access_token: "x", apiKey: "y", status: 503, realm_count: 2 })).toEqual({ status: 503, realm_count: 2 });
  });
});

describe("errors (stored in last_error / sync_runs.error and returned to callers)", () => {
  it("ConnectorError redacts its message and ids", async () => {
    const token = await vaultWith(TOKEN_SET).getToken("PKG", conn());
    const e = new ConnectorError({
      kind: "forbidden",
      message: `401 for Bearer ${token.reveal()}`,
      provider_tid: `tid ${token.reveal()}`,
    });
    expect(leaks(JSON.stringify(e))).toBe(false);
    expect(leaks(e.message)).toBe(false);
    expect(leaks(String(e.info.provider_tid))).toBe(false);
  });

  it("ConnectorError keeps a non-empty message even when everything was a secret", () => {
    const e = new ConnectorError({ kind: "forbidden", message: "Authorization: Bearer abc" });
    expect(e.message.length).toBeGreaterThan(0);
    expect(e.message).not.toContain("abc");
  });

  it("foreign errors lose their message entirely", () => {
    const e = toConnectorError(new Error(`boom ${CANARY}`));
    expect(leaks(JSON.stringify(e))).toBe(false);
  });
});

describe("review fixes (T-033 security + code reviews)", () => {
  it("scrubs encoded forms of a known credential (URL-encoded, base64, hex, JSON-escaped)", () => {
    const raw = 'synthetic+canary/9f3b="quoted"';
    new SecretValue(raw);
    const bytes = Buffer.from(raw, "utf8");
    for (const form of [encodeURIComponent(raw), bytes.toString("base64"), bytes.toString("base64url"), bytes.toString("hex"), JSON.stringify(raw).slice(1, -1)]) {
      expect(redactText(`echo ${form} end`)).toBe(`echo ${REDACTED} end`);
    }
  });

  it("registers only the credential fields of a token set (scope and expiry stay readable)", () => {
    new SecretValue(JSON.stringify({ access_token: CANARY, refresh_token: REFRESH, scope: "com.intuit.quickbooks.accounting", expires_at: "2026-11-02T10:00:00Z" }));
    expect(redactText("scope com.intuit.quickbooks.accounting until 2026-11-02T10:00:00Z")).toBe(
      "scope com.intuit.quickbooks.accounting until 2026-11-02T10:00:00Z",
    );
    expect(redactText(`r=${REFRESH}`)).not.toContain(REFRESH);
  });

  it("re-registers a credential when it is revealed", () => {
    const s = new SecretValue(CANARY);
    forgetSecretsForTests();
    s.reveal();
    expect(redactText(`x ${CANARY}`)).toBe(`x ${REDACTED}`);
  });

  it("redacts credential shapes the first pass missed", () => {
    const cases = [
      ["X-API-Key: synthAPIkey123", "synthAPIkey123"],
      ["Authorization: Token synthtok", "synthtok"],
      ["Proxy-Authorization: Basic c3ludGg6cHc=", "c3ludGg6cHc="],
      ["https://x.test/v1?apikey=synthkey1", "synthkey1"],
      ['{"accessToken":"synthA1","refreshToken":"synthR1","clientSecret":"synthC1"}', "synth"],
      ["{'access_token': 'synthSQ1'}", "synthSQ1"],
      ["access_token: synthUQ1", "synthUQ1"],
      ["client_secret=synthUQ2", "synthUQ2"],
      ["refresh eyJlbmMiOiJBMTI4Q0JDLUhTMjU2IiwiYWxnIjoiZGlyIn0..aXZpdmVpdg.Y2lwaGVy.dGFn here", "aXZpdmVpdg"],
    ] as const;
    for (const [text, secret] of cases) expect(redactText(text), text).not.toContain(secret);
  });

  it("leaves ordinary text alone (false positives from the first pass)", () => {
    for (const text of ["Basic plan, 3 seats", "QuickBooks code=6000 (business validation)", "lookup key=CustomerRef", "reason re_authorization_required"]) {
      expect(redactText(text)).toBe(text);
    }
    expect(new ConnectorError({ kind: "provider_error", message: "x", provider_error_code: "secret_key_required" }).info.provider_error_code).toBe(
      "secret_key_required",
    );
  });

  it("cuts very large input before redacting", () => {
    expect(redactText("a ".repeat(100_000)).length).toBeLessThanOrEqual(64 * 1024);
  });

  it("logs keep ConnectorError detail and the fields T-034/T-040/T-196 need", () => {
    const entries: LogEntry[] = [];
    const log = createConnectorLogger({ sink: (e) => entries.push(e) });
    const err = new ConnectorError({ kind: "rate_limited", message: "Throttled", http_status: 429, provider_tid: "tid-77", provider_error_code: "3001", retry_after_seconds: 30, endpoint: "/v3/company/{realm}/query" });
    const long = "d".repeat(500);
    log.warn("quickbooks.request_failed", { error: err, external_account_id: "realm-1", token_expires_at: "2026-12-01T00:00:00Z", detail: long, access_token: CANARY });
    const f = entries[0]?.fields ?? {};
    expect(f.error).toEqual({ error_name: "ConnectorError", ...err.info });
    expect(f.external_account_id).toBe("realm-1");
    expect(f.token_expires_at).toBe("2026-12-01T00:00:00Z");
    expect(f.detail).toBe(long);
    expect(f.access_token).toBeUndefined();
  });

  it("ConnectorError.endpoint is redacted, and dropped when it is not a plain path", () => {
    new SecretValue(CANARY);
    expect(new ConnectorError({ kind: "forbidden", message: "x", endpoint: `/v1/keys/${CANARY}` }).info.endpoint).toBe(`/v1/keys/${REDACTED}`);
    expect(new ConnectorError({ kind: "forbidden", message: "x", endpoint: "/cb?access_token=synth" }).info.endpoint).toBeNull();
    expect(new ConnectorError({ kind: "forbidden", message: "x", endpoint: "https://api.test/v1" }).info.endpoint).toBeNull();
    expect(new ConnectorError({ kind: "forbidden", message: "x", endpoint: "/v3/company/{realm}/query" }).info.endpoint).toBe("/v3/company/{realm}/query");
  });
});
