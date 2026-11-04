// T-050 / QB-17: INTUIT_* secrets live only in server-side env vars (never NEXT_PUBLIC_, never logged, never in client
// bundles). The real-bundle check (a production build scanned for canary values) is apps/web/tests/client-bundle.test.ts.
// Synthetic values only.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertBuildEnv, assertNoSecretPublicVars } from "./build";
import { readClientEnvFromProcess } from "./client";
import {
  CLIENT_ENV_NAMES,
  EnvValidationError,
  SERVER_ONLY_ENV_NAMES,
  clientEnvSchema,
  connectorEnvShapes,
  parseClientEnv,
  parseConnectorEnv,
  parseServerEnv,
} from "./schema";
import { isSecretLikeName, isSecretLikeValue } from "./secret-patterns";
import { requireConnectorEnv } from "./server";

const INTUIT_NAMES = Object.keys(connectorEnvShapes.intuit);
const CANARY = "canary-intuit-9f2c61d0-not-a-real-secret";
const LOCAL = { production: false, local: true, realData: false } as const;
const BASE = {
  INTUIT_CLIENT_ID: "synthetic-client-id",
  INTUIT_CLIENT_SECRET: CANARY,
  INTUIT_ENVIRONMENT: "sandbox",
  INTUIT_REDIRECT_URI: "http://localhost:3000/api/connect/qbo/callback",
} as const;
const example = () => readFileSync(fileURLToPath(new URL("../../../../.env.example", import.meta.url)), "utf8");

afterEach(() => vi.unstubAllEnvs());

describe("INTUIT_* env (QB-17)", () => {
  it("covers the five Intuit variables", () => {
    expect([...INTUIT_NAMES].sort()).toEqual(
      ["INTUIT_CLIENT_ID", "INTUIT_CLIENT_SECRET", "INTUIT_ENVIRONMENT", "INTUIT_REDIRECT_URI", "INTUIT_WEBHOOK_VERIFIER_TOKEN"].sort(),
    );
  });

  it("every INTUIT_* name is server-only: never NEXT_PUBLIC_, never in the client schema or the client reader", () => {
    for (const name of INTUIT_NAMES) {
      expect(name.startsWith("NEXT_PUBLIC_"), name).toBe(false);
      expect(CLIENT_ENV_NAMES as readonly string[], name).not.toContain(name);
      expect(Object.keys(clientEnvSchema.shape), name).not.toContain(name);
      expect(Object.keys(readClientEnvFromProcess()), name).not.toContain(name);
      // A NEXT_PUBLIC_ copy of the name is not an accepted way to ship it to the browser.
      expect(example(), `NEXT_PUBLIC_${name}`).not.toContain(`NEXT_PUBLIC_${name}`);
    }
    // They are connector variables, read where the connector is used, not part of the startup server env.
    for (const name of INTUIT_NAMES) expect(SERVER_ONLY_ENV_NAMES, name).not.toContain(name);
    expect(INTUIT_NAMES.every((n) => new RegExp(`^#?\\s*${n}=`, "m").test(example()))).toBe(true);
  });

  it("INTUIT_CLIENT_SECRET and INTUIT_WEBHOOK_VERIFIER_TOKEN match the secret name patterns, so a NEXT_PUBLIC_ copy is refused", () => {
    for (const name of ["INTUIT_CLIENT_SECRET", "INTUIT_WEBHOOK_VERIFIER_TOKEN"]) {
      expect(isSecretLikeName(name), name).toBe(true);
      expect(isSecretLikeName(`NEXT_PUBLIC_${name}`), `NEXT_PUBLIC_${name}`).toBe(true);
      expect(() => assertNoSecretPublicVars({ [`NEXT_PUBLIC_${name}`]: CANARY }), name).toThrow(EnvValidationError);
    }
    // The redirect URI is a secret-like name too (…_URI), so it cannot be shipped public by accident either.
    expect(isSecretLikeName("NEXT_PUBLIC_INTUIT_REDIRECT_URI")).toBe(true);
  });

  it("a canary never reaches the client environment", () => {
    for (const name of INTUIT_NAMES) vi.stubEnv(name, CANARY);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    expect(JSON.stringify(readClientEnvFromProcess())).not.toContain(CANARY);
    const client = parseClientEnv({ ...readClientEnvFromProcess(), ...Object.fromEntries(INTUIT_NAMES.map((n) => [n, CANARY])) });
    expect(JSON.stringify(client)).not.toContain(CANARY);
    // And the build gate refuses a public variable that carries a secret-looking value or name.
    expect(() => assertBuildEnv({ APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "production", NEXT_PUBLIC_INTUIT_CLIENT_SECRET: CANARY })).toThrow(
      EnvValidationError,
    );
  });

  it("the connector env is redacted when printed or serialised, and errors name variables only", () => {
    const env = parseConnectorEnv("intuit", { ...BASE, INTUIT_WEBHOOK_VERIFIER_TOKEN: `${CANARY}-verifier` }, LOCAL);
    expect(env.INTUIT_CLIENT_SECRET).toBe(CANARY); // the accessor hands the real value to the connector only
    vi.stubEnv("APP_ENV", "local");
    const wrapped = requireConnectorEnv("intuit", { ...BASE, INTUIT_WEBHOOK_VERIFIER_TOKEN: `${CANARY}-verifier` });
    for (const text of [JSON.stringify(wrapped), inspect(wrapped, { depth: 5 }), String(JSON.stringify({ env: wrapped }))]) {
      expect(text).not.toContain(CANARY);
      expect(text).toContain("[redacted]");
    }
    const err = (() => {
      try {
        parseConnectorEnv("intuit", { INTUIT_CLIENT_SECRET: CANARY }, LOCAL);
      } catch (e) {
        return e as EnvValidationError;
      }
      throw new Error("expected a throw");
    })();
    expect(err.missing).toEqual(["INTUIT_CLIENT_ID", "INTUIT_REDIRECT_URI"]);
    expect(err.message).not.toContain(CANARY);
  });

  it("connecting needs only the four OAuth variables; the webhook verifier token is optional until T-053", () => {
    expect(parseConnectorEnv("intuit", BASE, LOCAL).INTUIT_WEBHOOK_VERIFIER_TOKEN).toBeUndefined();
    expect(() => parseConnectorEnv("intuit", { ...BASE, INTUIT_WEBHOOK_VERIFIER_TOKEN: "" }, LOCAL)).not.toThrow();
  });

  it("the Intuit variables are not part of the startup env, so a deployment without them still boots", () => {
    expect(() =>
      parseServerEnv({
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_FAKEFAKEFAKE",
        APP_ENV: "local",
        ENABLED_LANES: "PKG",
        SUPABASE_SECRET_KEY: "sb_secret_FAKE-do-not-leak-1",
      }),
    ).not.toThrow();
  });

  it("no value of the secret kinds slips through as 'looks public': the secret's own shape is not a vendor prefix (name patterns are the control)", () => {
    // Documented limit: Intuit client secrets have no vendor prefix, so the NAME patterns are what protect them.
    expect(isSecretLikeValue(CANARY)).toBe(false);
  });
});
