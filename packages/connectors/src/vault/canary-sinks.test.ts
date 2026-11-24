// T-170 (security suite), area 3: token canaries across EVERY connector provider and EVERY outbound sink of the connector layer.
// Subjects: the provider names (contract PROVIDERS) that have a connector folder, found from the file system; each must have an echo-shape
// entry below (the way THAT provider's errors tend to echo a credential) or fails. Sinks: ConnectorError (message, endpoint, ids, JSON, inspect),
// the connector logger, field redaction, and the API-error store scrub (what core.connector_api_errors keeps). Tokens here were never
// registered with the vault (the exact-match layer cannot help), and a second pass registers them to cover the exact-match layer too.
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpClient } from "../http/client";
import { RateLimiter } from "../http/rate-limit";
import { http, HttpResponse, useMockServer } from "../testing/msw/index";
import { ConnectorError } from "../contract/errors";
import { PROVIDERS } from "../contract/schemas";
import { scrubApiError, safeFixedMessage } from "../error-log/scrub";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { redactFields, redactText } from "../log/redact";
import { forgetSecretsForTests, SecretValue } from "./secret";

const connectorsDir = resolve(__dirname, "..");
const folders = new Set(readdirSync(connectorsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));
/** Connector folder per provider (providers with no folder have no connector yet and are listed with the reason). */
const FOLDER: Record<string, string | null> = {
  quickbooks: "quickbooks", google: "google", microsoft: "microsoft", microsoft_teams: "teams",
  stripe: null, gohighlevel: null, monday: null, notion: null, timesolv: null,
};
// A realistic echo per provider; the credential is a fresh synthetic value, distinct per provider.
const jwt = (tag: string) => `eyJ${tag}header.eyJ${tag}payload.${tag}signature0123456789`;
const ECHO: Record<string, { token: string; echo: (t: string) => string[] }> = {
  quickbooks: { token: `eyJlbmMiOiJBMTI4Q0JDLUhTMjU2IiwiYWxnIjoiZGlyIn0..CANARYqbo0123456789.abcdef`, echo: (t) => [`Authorization: Bearer ${t}`, `{"refresh_token":"${t}"}`, `https://quickbooks.api.intuit.example/v3/company/9130/query?access_token=${t}`] },
  google: { token: "ya29.CANARY-google-access-token-0123456789", echo: (t) => [`Authorization: Bearer ${t}`, `{"access_token":"${t}","error":"invalid_grant"}`, `https://gmail.example.test/x?access_token=${t}&alt=json`] },
  microsoft: { token: jwt("CANARYms"), echo: (t) => [`Authorization: Bearer ${t}`, `{"error":{"message":"token ${t} expired"}}`, `https://graph.example.test/v1.0/me/messages?$select=id&token=${t}`] },
  microsoft_teams: { token: jwt("CANARYteams"), echo: (t) => [`Authorization: Bearer ${t}`, `{"id_token":"${t}"}`, `https://graph.example.test/v1.0/chats/19:x@thread.v2/messages?code=${t}`] },
};

const server = useMockServer();
afterEach(() => {
  forgetSecretsForTests();
  RateLimiter.resetForTests();
});

describe("coverage", () => {
  it("every provider with a connector folder has an echo entry; providers without a folder really have none; no stale entry", () => {
    expect(Object.keys(FOLDER).sort()).toEqual([...PROVIDERS].sort());
    for (const [provider, folder] of Object.entries(FOLDER)) {
      if (folder === null) expect(folders.has(provider), `${provider} gained a connector folder: add an echo entry`).toBe(false);
      else {
        expect(folders.has(folder), folder).toBe(true);
        expect(ECHO[provider], `${provider} needs an echo entry`).toBeDefined();
      }
    }
    expect(Object.keys(ECHO).sort()).toEqual(Object.entries(FOLDER).filter(([, f]) => f !== null).map(([p]) => p).sort());
  });
  it("every connector folder with a token manager or HTTP layer has at least one test that plants a canary (found by scanning test files)", async () => {
    const { readFileSync } = await import("node:fs");
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(resolve(d, e.name)) : [resolve(d, e.name)]));
    for (const folder of Object.values(FOLDER).filter((f): f is string => f !== null)) {
      const tests = walk(resolve(connectorsDir, folder)).filter((f) => f.endsWith(".test.ts"));
      expect(tests.some((f) => /canary/i.test(readFileSync(f, "utf8")) && /not\.toContain/.test(readFileSync(f, "utf8"))), `${folder}: a canary test`).toBe(true);
    }
  });
});

describe.each(Object.entries(ECHO))("%s: a credential echoed by the provider", (provider, { token, echo }) => {
  const sinks = (registered: boolean) => {
    if (registered) new SecretValue(token);
    const lines = echo(token);
    const logs: LogEntry[] = [];
    const logger = createConnectorLogger({ sink: (e) => logs.push(e), context: { provider } });
    const out: string[] = [];
    for (const line of lines) {
      const err = new ConnectorError({ kind: "transient", message: `Provider said: ${line}`, endpoint: line.startsWith("https") ? new URL(line).pathname + new URL(line).search : "/v1/x", provider_message: line, provider_error_code: "E1" } as never);
      out.push(err.message, JSON.stringify(err.info), inspect(err, { depth: 6 }), String(err), JSON.stringify(redactFields({ detail: line, nested: { header: line, authorization: token, access_token: token, list: [line] } })), redactText(line));
      logger.error("provider.failed", { outcome: "x", message: line, headers: { authorization: `Bearer ${token}` }, error: err.info });
      const scrubbed = scrubApiError(provider, { ...err.info, endpoint: err.info.endpoint ?? null } as never, safeFixedMessage(line));
      out.push(JSON.stringify(scrubbed));
    }
    out.push(JSON.stringify(logs));
    return out.join("\n");
  };
  it("never reaches an error, its JSON or inspect output, a log entry, redacted fields or the stored API-error scrub (token never seen by the vault)", () => {
    const text = sinks(false);
    expect(text).not.toContain(token);
    expect(text.length).toBeGreaterThan(100);
  });
  it("same with the credential registered by the vault (exact-match layer), including its URL-encoded and base64 forms", () => {
    const text = sinks(true);
    for (const form of [token, encodeURIComponent(token), Buffer.from(token).toString("base64")]) expect(text).not.toContain(form);
  });
  it("a foreign Error (not a ConnectorError) keeps no message at all", () => {
    new SecretValue(token);
    const logs: LogEntry[] = [];
    createConnectorLogger({ sink: (e) => logs.push(e) }).error("x", { error: new Error(`boom ${token}`) } as never);
    expect(JSON.stringify(logs)).not.toContain(token);
  });
});

// ---------------------------------------------------------------- the connector's REAL error path
// The shared HTTP client (every connector's only door to its provider) maps a failing response to a ConnectorError and logs it. For each connector family the
// provider answers a failing request with a body and headers that echo the credential it was sent; the thrown error, its JSON, inspect output and the log
// entries must not hold it, whether or not the Vault ever registered it.
describe.each(Object.entries(ECHO))("%s: the HTTP client's real error mapping with a provider that echoes the credential", (provider, { token }) => {
  const BASE = `https://api.${provider.replace("_", "-")}.example.test`;
  const run = async (registered: boolean, status: number) => {
    const secret = new SecretValue(token); // the Vault hands the client a SecretValue; registration is the vault's side effect
    if (!registered) forgetSecretsForTests();
    server.use(
      http.post(`${BASE}/v1/things`, () =>
        HttpResponse.json(
          { error: { code: "invalid_token", message: `The access token ${token} is invalid`, detail: `Authorization: Bearer ${token}`, url: `${BASE}/v1/things?access_token=${token}` } },
          { status, headers: { "x-request-id": "tid-1", "www-authenticate": `Bearer error="invalid_token", error_description="${token}"` } },
        ),
      ),
    );
    const logs: LogEntry[] = [];
    const c = createHttpClient({ provider, baseUrl: BASE, laneId: "PKG", requestIdHeader: "x-request-id", sleep: async () => undefined, random: () => 0.5, maxRetries: 0, logger: createConnectorLogger({ sink: (e) => logs.push(e) }),
      errorCode: (b) => ((b as { error?: { code?: string } }).error?.code ?? null) });
    let thrown: unknown;
    try {
      await c.request({ method: "POST", path: "/v1/things", body: { x: 1 }, auth: { scheme: "Bearer", secret } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConnectorError);
    const e = thrown as ConnectorError;
    return [e.message, JSON.stringify(e.info), inspect(e, { depth: 8 }), String(e), JSON.stringify(logs)].join("\n");
  };
  it.each([401, 400, 500])("status %i, credential unknown to the vault: not in the error, its JSON, inspect output or the log", async (status) => {
    const text = await run(false, status);
    expect(text).not.toContain(token);
    expect(text.length).toBeGreaterThan(50);
  });
  it("status 401, credential registered: same", async () => {
    expect(await run(true, 401)).not.toContain(token);
  });
});

// ---------------------------------------------------------------- one test per redaction layer, with inputs ONLY that layer catches
// (a layer that is removed makes its test fail; see the mutation table in docs/security/pilot-test.md)
describe("each redaction layer on its own", () => {
  it("layer 1, exact match: a credential with no recognisable shape is removed only because the Vault registered it", () => {
    const plain = "plainvaultvalue9f3b7c1e";
    expect(redactText(`provider echoed ${plain} back`)).toContain(plain); // no shape layer can know it
    new SecretValue(plain);
    expect(redactText(`provider echoed ${plain} back`)).not.toContain(plain);
    expect(redactText(`provider echoed ${encodeURIComponent(plain + "+/=")} back`)).toBeDefined();
  });
  it("layer 2, embedded shapes: short or odd values in a credential position are removed without registration (header, query, JSON field, unquoted field)", () => {
    for (const [input, secret] of [
      ["Authorization: Token abc12", "abc12"],
      ["GET /x?code=ab12&state=1", "ab12"],
      ['{"refresh_token":"q1"}', "q1"],
      ["client_secret=zz9 other", "zz9"],
      ["x-api-key: k9", "k9"],
    ] as const) expect(redactText(input), input).not.toContain(secret);
  });
  it("layer 2, the bare `Bearer <value>` rule on its own: a short, low-entropy value outside any header or key", () => {
    const out = redactText("the gateway rejected Bearer aaaaaaaabb11 for this call");
    expect(out).not.toContain("aaaaaaaabb11");
    expect(out).toContain("Bearer");
  });
  it("layer 2, the JWT/JWE rule on its own: short, low-entropy JWT-shaped values (including an Intuit-style empty second segment)", () => {
    for (const jwt of ["eyJaaaaa..bbbb", "eyJaaaaaa.bbbbbbb.ccccccc", "eyJ11111.222.3", "eyJabcde.eyJabcde."]) expect(redactText(`see ${jwt} in the log`), jwt).not.toContain("eyJ");
  });
  it("layer 3, word shapes: a credential-looking word with no credential context is removed", () => {
    for (const w of ["sk_live_abcdefghijklmnop1234", "ghp_abcdefghijklmnopqrstuvwxyz0123", "eyJhbGciOiJIUzI1NiJ9abc.eyJzdWIiOiJ4In0.sig12345678"]) expect(redactText(`the value ${w} was rejected`), w).not.toContain(w);
  });
  it("layer 4, field names: a credential-named or content-named field is dropped whatever its value looks like", () => {
    const out = JSON.stringify(redactFields({ clientSecret: "plain-value", accessToken: "x", emailBody: "hello", snippet: "hi", nested: { password: "p", ok: "kept" } }));
    for (const gone of ["plain-value", "hello", "hi\"", "\"p\""]) expect(out).not.toContain(gone);
    expect(out).toContain("kept");
    // and the value-only layers would NOT have caught these: the plain values pass through redactText untouched
    expect(redactText("plain-value")).toBe("plain-value");
  });
});
