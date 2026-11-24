// T-170 (security suite), area 3: token canaries across EVERY connector provider and EVERY outbound sink of the connector layer.
// Subjects: the provider names (contract PROVIDERS) that have a connector folder, found from the file system; each must have an echo-shape
// entry below (the way THAT provider's errors tend to echo a credential) or fails. Sinks: ConnectorError (message, endpoint, ids, JSON, inspect),
// the connector logger, field redaction, and the API-error store scrub (what core.connector_api_errors keeps). Tokens here were never
// registered with the vault (the exact-match layer cannot help), and a second pass registers them to cover the exact-match layer too.
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => forgetSecretsForTests());

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
