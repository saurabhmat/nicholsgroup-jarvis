import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertBuildEnv, assertNoSecretPublicVars, parseGateFlag, shouldValidateBuildEnv } from "./build";
import {
  CLIENT_ENV_NAMES,
  CONNECTOR_NAMES,
  EnvValidationError,
  SERVER_ONLY_ENV_NAMES,
  clientEnvSchema,
  connectorEnvShapes,
  parseClientEnv,
  parseConnectorEnv,
  parseServerEnv,
  type ConnectorName,
  type EnvRecord,
} from "./schema";
import {
  FREE_TEXT_VALUE_NAMES,
  PUBLIC_BY_DESIGN_NAMES,
  SECRET_NAME_PATTERNS,
  isSecretLikeName,
  isSecretLikeValue,
} from "./secret-patterns";
import { requireConnectorEnv } from "./server";

// Synthetic values only.
const VAPID = "B".repeat(87);
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = (payload: unknown) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.fakesignature`;

const CORE = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_FAKEFAKEFAKE",
  APP_ENV: "local",
  ENABLED_LANES: "PKG",
  SUPABASE_SECRET_KEY: "sb_secret_FAKE-do-not-leak-1",
} as const satisfies EnvRecord;

const AI = {
  ANTHROPIC_API_KEY: "fake-anthropic-do-not-leak-4",
  ANTHROPIC_MODEL_ANALYSIS: "fake-analysis-model",
  ANTHROPIC_MODEL_FAST: "fake-fast-model",
} as const;
const JOBS = {
  INNGEST_EVENT_KEY: "fake-event-key-do-not-leak-2",
  INNGEST_SIGNING_KEY: "fake-signing-key-do-not-leak-3",
} as const;
const HTTPS = { NEXT_PUBLIC_APP_URL: "https://app.example.test", NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.test" } as const;
const PROD_CORE = { ...CORE, ...HTTPS, APP_ENV: "production" } as const;
const STAGING_CORE = { ...CORE, ...HTTPS, APP_ENV: "staging" } as const;
// A PR Preview (APP_ENV=preview) may have no database; Vercel's custom environment "staging" is a preview target.
const PREVIEW_CORE = { NEXT_PUBLIC_APP_URL: HTTPS.NEXT_PUBLIC_APP_URL, APP_ENV: "preview", ENABLED_LANES: "PKG" } as const;
const SUPABASE_HTTPS = {
  NEXT_PUBLIC_SUPABASE_URL: HTTPS.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: CORE.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_SECRET_KEY: CORE.SUPABASE_SECRET_KEY,
} as const;
const VERCEL_PREVIEW = { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" } as const;
const VERCEL_STAGING = { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "staging" } as const;
const LOCAL_FLAGS = { production: false, local: true, realData: false } as const;
const PROD_FLAGS = { production: true, local: false, realData: true } as const;

const CORE_REQUIRED = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "APP_ENV",
  "ENABLED_LANES",
  "SUPABASE_SECRET_KEY",
] as const;
// Modules re-imported after vi.resetModules() have their own error class, so match on the message.
const VALIDATION_FAILED = /^Environment validation failed/;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("server env", () => {
  it("parses a valid env, splits and dedupes ENABLED_LANES", () => {
    const env = parseServerEnv({ ...CORE, ENABLED_LANES: "PKG, NL, PKG" });
    expect(env.APP_ENV).toBe("local");
    expect(env.ENABLED_LANES).toEqual(["PKG", "NL"]);
    expect(env.NEXT_PUBLIC_VAPID_PUBLIC_KEY).toBeUndefined();
  });

  it.each(CORE_REQUIRED)("fails fast when %s is missing (local)", (name) => {
    const env: Record<string, string> = Object.fromEntries(Object.entries(CORE).filter(([key]) => key !== name));
    const err = catchError(() => parseServerEnv(env));
    expect(err).toBeInstanceOf(EnvValidationError);
    expect((err as EnvValidationError).missing).toEqual([name]);
    expect((err as Error).message).toContain(name);
  });

  it("does not require Anthropic or Inngest outside production", () => {
    expect(() => parseServerEnv(CORE)).not.toThrow();
  });

  it("treats blank values (as in .env.example) as missing", () => {
    const err = catchError(() => parseServerEnv({ ...CORE, SUPABASE_SECRET_KEY: "  " })) as EnvValidationError;
    expect(err.missing).toEqual(["SUPABASE_SECRET_KEY"]);
  });

  it("reports invalid values by name", () => {
    const err = catchError(() => parseServerEnv({ ...CORE, APP_ENV: "prod", ENABLED_LANES: "pkg" })) as EnvValidationError;
    expect(err.invalid).toEqual(["APP_ENV", "ENABLED_LANES"]);
    expect(err.missing).toEqual([]);
  });

  it("requires https for every URL outside local, not in local", () => {
    expect(() => parseServerEnv(CORE)).not.toThrow();
    const err = catchError(() => parseServerEnv({ ...CORE, APP_ENV: "staging" })) as EnvValidationError;
    expect(err.invalid).toEqual(["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SUPABASE_URL"]);
    expect(() => parseServerEnv(STAGING_CORE)).not.toThrow();
    for (const extra of [
      { SUPABASE_NL_URL: "http://nl.example.test" },
      { NEXT_PUBLIC_SENTRY_DSN: "http://abc@o0.ingest.sentry.io/1" },
    ]) {
      const e = catchError(() => parseServerEnv({ ...STAGING_CORE, ...extra })) as EnvValidationError;
      expect(e.invalid).toEqual(Object.keys(extra));
    }
    expect(() => parseServerEnv({ ...CORE, SUPABASE_NL_URL: "http://nl.example.test" })).not.toThrow();
  });

  it("does not emit a duplicate invalid for URLs when APP_ENV is missing", () => {
    const env: Record<string, string> = { ...CORE };
    delete env.APP_ENV;
    const err = catchError(() => parseServerEnv(env)) as EnvValidationError;
    expect(err.missing).toEqual(["APP_ENV"]);
    expect(err.invalid).toEqual([]);
  });

  it("APP_ENV must agree with the platform (N2)", () => {
    const bad = (extra: Record<string, string>, base: Record<string, string> = STAGING_CORE) =>
      catchError(() => parseServerEnv({ ...base, ...extra })) as EnvValidationError;
    expect(bad({ VERCEL: "1" }, CORE).invalid).toEqual(["APP_ENV"]); // local on Vercel
    expect(bad({ VERCEL: "true" }, CORE).invalid).toEqual(["APP_ENV"]);
    expect(bad({ VERCEL_ENV: "production", ...AI, ...JOBS }).invalid).toEqual(["APP_ENV"]); // staging on a production deployment
    expect(bad({ VERCEL_ENV: "preview", ...AI, ...JOBS }, PROD_CORE as Record<string, string>).invalid).toEqual(["APP_ENV"]);
    expect(() => parseServerEnv({ ...STAGING_CORE, ...VERCEL_STAGING })).not.toThrow();
    expect(() => parseServerEnv({ ...PROD_CORE, ...AI, ...JOBS, VERCEL: "1", VERCEL_ENV: "production" })).not.toThrow();
    expect(() => parseServerEnv({ ...CORE, VERCEL_ENV: "development" })).not.toThrow();
  });

  it("error messages never contain env values", () => {
    const env: Record<string, string> = {
      ...CORE,
      APP_ENV: "fake-bad-env-value-do-not-leak-5",
      NEXT_PUBLIC_APP_URL: "not a url do-not-leak-6",
    };
    delete env.SUPABASE_SECRET_KEY;
    const err = catchError(() => parseServerEnv(env)) as EnvValidationError;
    const text = `${err.message} ${err.stack ?? ""} ${JSON.stringify(err)}`;
    for (const value of Object.values(env)) expect(text).not.toContain(value);
    expect(text).toContain("APP_ENV");
  });
});

describe("production strictness (Anthropic, Inngest)", () => {
  it("are optional in production when entirely absent (APP_ENV or VERCEL_ENV)", () => {
    expect(() => parseServerEnv(PROD_CORE)).not.toThrow();
    expect(() => parseServerEnv({ ...PROD_CORE, VERCEL_ENV: "production" })).not.toThrow();
  });

  it("a partial group is an error in production", () => {
    const err = catchError(() =>
      parseServerEnv({ ...PROD_CORE, ...JOBS, ANTHROPIC_API_KEY: AI.ANTHROPIC_API_KEY }),
    ) as EnvValidationError;
    expect(err.missing).toEqual(["ANTHROPIC_MODEL_ANALYSIS", "ANTHROPIC_MODEL_FAST"]);
    const jobs = catchError(() =>
      parseServerEnv({ ...PROD_CORE, INNGEST_EVENT_KEY: JOBS.INNGEST_EVENT_KEY }),
    ) as EnvValidationError;
    expect(jobs.missing).toEqual(["INNGEST_SIGNING_KEY"]);
  });

  it("passes in production with everything set", () => {
    expect(() => parseServerEnv({ ...PROD_CORE, ...AI, ...JOBS })).not.toThrow();
  });

  it("assertBuildEnv: production builds pass without them, fail on a partial group", () => {
    expect(() => assertBuildEnv({ ...PROD_CORE, VERCEL: "1", VERCEL_ENV: "production" })).not.toThrow();
    const partial = catchError(() =>
      assertBuildEnv({ ...PROD_CORE, VERCEL: "1", VERCEL_ENV: "production", INNGEST_SIGNING_KEY: JOBS.INNGEST_SIGNING_KEY }),
    ) as EnvValidationError;
    expect(partial.missing).toEqual(["INNGEST_EVENT_KEY"]);
    expect(partial.message).toContain("INNGEST_EVENT_KEY");

    expect(() => assertBuildEnv({ ...PREVIEW_CORE, ...VERCEL_PREVIEW })).not.toThrow();
    expect(() => assertBuildEnv({ ...STAGING_CORE, ...VERCEL_STAGING })).not.toThrow();
    expect(() => assertBuildEnv({ ...STAGING_CORE })).not.toThrow();
    expect(() => assertBuildEnv({ ...CORE })).not.toThrow();
    expect(() => assertBuildEnv({})).not.toThrow();
  });

  it("getAnthropicEnv / getInngestEnv return not-configured outside production", async () => {
    const { getAnthropicEnv, getInngestEnv } = await import("./server");
    expect(getAnthropicEnv({ ...CORE })).toEqual({
      configured: false,
      missing: ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL_ANALYSIS", "ANTHROPIC_MODEL_FAST"],
    });
    expect(getInngestEnv({ ...CORE })).toEqual({
      configured: false,
      missing: ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"],
    });
  });

  it("a partial group is not configured outside production", async () => {
    const { getAnthropicEnv } = await import("./server");
    const r = getAnthropicEnv({ ...CORE, ANTHROPIC_API_KEY: AI.ANTHROPIC_API_KEY });
    expect(r).toEqual({ configured: false, missing: ["ANTHROPIC_MODEL_ANALYSIS", "ANTHROPIC_MODEL_FAST"] });
  });

  it("accessors return values when configured; in production absent is not-configured, partial throws", async () => {
    const { getAnthropicEnv, getInngestEnv } = await import("./server");
    const ai = getAnthropicEnv({ ...CORE, ...AI });
    expect(ai.configured && ai.ANTHROPIC_MODEL_FAST).toBe("fake-fast-model");
    expect(getInngestEnv({ ...CORE, ...JOBS }).configured).toBe(true);
    vi.stubEnv("APP_ENV", "production");
    expect(getAnthropicEnv({ ...PROD_CORE })).toEqual({
      configured: false,
      missing: ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL_ANALYSIS", "ANTHROPIC_MODEL_FAST"],
    });
    expect(getAnthropicEnv({ ...PROD_CORE, ANTHROPIC_API_KEY: "  " }).configured).toBe(false); // blank = unset
    expect(() => getAnthropicEnv({ ...PROD_CORE, ANTHROPIC_API_KEY: AI.ANTHROPIC_API_KEY })).toThrow(VALIDATION_FAILED);
    vi.stubEnv("APP_ENV", "");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(getInngestEnv({ ...CORE }).configured).toBe(false);
    expect(() => getInngestEnv({ ...CORE, INNGEST_EVENT_KEY: JOBS.INNGEST_EVENT_KEY })).toThrow(VALIDATION_FAILED);
  });

  it("production is decided from the real process env, not from the caller's env subset (N6)", async () => {
    const { getAnthropicEnv, getInngestEnv } = await import("./server");
    const partialAi = { ANTHROPIC_API_KEY: AI.ANTHROPIC_API_KEY };
    // Process env is not production: a caller-supplied APP_ENV=production must not flip the mode.
    expect(getAnthropicEnv({ ...PROD_CORE, ...partialAi }).configured).toBe(false);
    expect(getInngestEnv({ ...PROD_CORE }).configured).toBe(false);
    // Process env IS production: a caller-supplied "local" cannot relax it.
    vi.stubEnv("APP_ENV", "production");
    expect(() => getAnthropicEnv({ ...CORE, ...partialAi })).toThrow(VALIDATION_FAILED);
  });

  it("emits one startup warning, names only, and not twice", async () => {
    const { warnUnconfiguredFeatures: warn } = await import("./startup");
    const log = vi.fn();
    const env = { ...CORE, ANTHROPIC_API_KEY: AI.ANTHROPIC_API_KEY };
    warn(env, log);
    warn(env, log);
    expect(log).toHaveBeenCalledTimes(1);
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain("AI features not configured: ANTHROPIC_MODEL_ANALYSIS, ANTHROPIC_MODEL_FAST");
    expect(message).toContain("Background jobs not configured: INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY");
    for (const value of Object.values(env)) expect(message).not.toContain(value);
  });

  it("stays silent when fully configured, and warns in production when a group is absent", async () => {
    const log = vi.fn();
    const { warnUnconfiguredFeatures: warn } = await import("./startup");
    warn({ ...CORE, ...AI, ...JOBS }, log);
    expect(log).not.toHaveBeenCalled();
    vi.resetModules();
    const { warnUnconfiguredFeatures: warn2 } = await import("./startup");
    warn2({ ...PROD_CORE, ...JOBS }, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("AI features not configured");
    expect(String(log.mock.calls[0]?.[0])).not.toContain("Background jobs");
  });
});

describe("server accessors and redaction", () => {
  const stubCore = () => {
    for (const [k, v] of Object.entries(CORE)) vi.stubEnv(k, v);
  };

  it("getServerEnv is memoised, lazy, and holds no secret keys", async () => {
    const mod = await import("./server"); // importing never throws, even with no env
    for (const k of CORE_REQUIRED) vi.stubEnv(k, "");
    expect(() => mod.getServerEnv()).toThrow(VALIDATION_FAILED);
    stubCore();
    const first = mod.getServerEnv();
    expect(mod.getServerEnv()).toBe(first);
    expect(first.APP_ENV).toBe("local");
    expect(Object.keys(first)).not.toContain("SUPABASE_SECRET_KEY");
    expect(JSON.stringify(first)).not.toContain("do-not-leak");
    expect(mod.getSupabaseSecretKey()).toBe(CORE.SUPABASE_SECRET_KEY);
  });

  it("getClientEnv is memoised and lazy", async () => {
    const mod = await import("./client");
    for (const k of CLIENT_ENV_NAMES) vi.stubEnv(k, "");
    expect(() => mod.getClientEnv()).toThrow(VALIDATION_FAILED);
    stubCore();
    const first = mod.getClientEnv();
    expect(mod.getClientEnv()).toBe(first);
  });

  it("console.log / inspect / JSON.stringify of connector env redact secrets", () => {
    const env = requireConnectorEnv("stripe", {
      STRIPE_RESTRICTED_KEY: "rk_test_FAKE-do-not-leak-7",
      STRIPE_WEBHOOK_SECRET: "whsec_FAKE-do-not-leak-8",
    });
    expect(env.STRIPE_RESTRICTED_KEY).toBe("rk_test_FAKE-do-not-leak-7"); // explicit access still works
    for (const text of [JSON.stringify(env), inspect(env), JSON.stringify({ nested: env })]) {
      expect(text).not.toContain("do-not-leak");
      expect(text).toContain("[redacted]");
    }
  });

  it("redacts the Anthropic key in logs", async () => {
    const { getAnthropicEnv } = await import("./server");
    const r = getAnthropicEnv({ ...CORE, ...AI });
    expect(inspect(r)).not.toContain("do-not-leak");
    expect(JSON.stringify(r)).not.toContain("do-not-leak");
    expect(JSON.stringify(r)).toContain("fake-fast-model");
  });
});

describe("real-data environments (Staging environment, Oct 28, 2026)", () => {
  const bad = (env: Record<string, string>) => catchError(() => parseServerEnv(env)) as EnvValidationError;

  it("only Vercel's custom environment staging may set APP_ENV=staging; a PR Preview must say preview", () => {
    expect(() => parseServerEnv({ ...STAGING_CORE, ...VERCEL_STAGING })).not.toThrow();
    expect(() => parseServerEnv({ ...PREVIEW_CORE, ...VERCEL_PREVIEW })).not.toThrow();
    expect(bad({ ...STAGING_CORE, ...VERCEL_PREVIEW }).invalid).toEqual(["APP_ENV"]); // PR Preview claiming staging
    expect(bad({ ...STAGING_CORE, VERCEL: "1", VERCEL_ENV: "preview" }).invalid).toEqual(["APP_ENV"]); // no target
    expect(bad({ ...PREVIEW_CORE, ...SUPABASE_HTTPS, ...VERCEL_STAGING }).invalid).toEqual(["APP_ENV"]);
  });

  it("APP_ENV=preview exists only on a Vercel Preview", () => {
    expect(bad({ ...PREVIEW_CORE, ...SUPABASE_HTTPS }).invalid).toEqual(["APP_ENV"]);
    expect(bad({ ...PREVIEW_CORE, ...SUPABASE_HTTPS, VERCEL: "1", VERCEL_ENV: "production", ...AI, ...JOBS }).invalid).toEqual([
      "APP_ENV",
      "INNGEST_EVENT_KEY",
      "INNGEST_SIGNING_KEY",
    ]);
  });

  it("a PR Preview may not hold Inngest keys (T-037 review M2)", () => {
    expect(bad({ ...PREVIEW_CORE, ...VERCEL_PREVIEW, ...JOBS }).invalid).toEqual(["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"]);
    expect(bad({ ...PREVIEW_CORE, ...VERCEL_PREVIEW, INNGEST_SIGNING_KEY: JOBS.INNGEST_SIGNING_KEY }).invalid).toEqual(["INNGEST_SIGNING_KEY"]);
  });

  it("a PR Preview needs no Supabase, but all three variables or none", () => {
    expect(parseServerEnv({ ...PREVIEW_CORE, ...VERCEL_PREVIEW }).SUPABASE_SECRET_KEY).toBeUndefined();
    expect(bad({ ...PREVIEW_CORE, ...VERCEL_PREVIEW, SUPABASE_SECRET_KEY: "sb_secret_FAKE" }).missing).toEqual([
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "NEXT_PUBLIC_SUPABASE_URL",
    ]);
    const publicOnly: Record<string, string> = { ...SUPABASE_HTTPS };
    delete publicOnly.SUPABASE_SECRET_KEY;
    expect(bad({ ...PREVIEW_CORE, ...VERCEL_PREVIEW, ...publicOnly }).missing).toEqual(["SUPABASE_SECRET_KEY"]);
  });

  it.each(["local", "staging", "production"])("APP_ENV=%s still requires all Supabase variables", (appEnv) => {
    const base = appEnv === "local" ? CORE : { ...CORE, ...HTTPS, ...AI, ...JOBS };
    const env: Record<string, string> = { ...base, APP_ENV: appEnv };
    delete env.SUPABASE_SECRET_KEY;
    delete env.NEXT_PUBLIC_SUPABASE_URL;
    expect(bad(env).missing).toEqual(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"]);
  });

  it("refuses INTUIT_ENVIRONMENT=production unless APP_ENV is staging or production (build and boot)", () => {
    const PROD_INTUIT = { INTUIT_ENVIRONMENT: "production" };
    expect(bad({ ...CORE, ...PROD_INTUIT }).invalid).toEqual(["INTUIT_ENVIRONMENT"]);
    expect(bad({ ...PREVIEW_CORE, ...VERCEL_PREVIEW, ...PROD_INTUIT }).invalid).toEqual(["INTUIT_ENVIRONMENT"]);
    const built = catchError(() => assertBuildEnv({ ...PREVIEW_CORE, ...VERCEL_PREVIEW, ...PROD_INTUIT })) as EnvValidationError;
    expect(built.invalid).toEqual(["INTUIT_ENVIRONMENT"]);
    expect(() => parseServerEnv({ ...STAGING_CORE, ...VERCEL_STAGING, ...PROD_INTUIT })).not.toThrow();
    expect(() => parseServerEnv({ ...PROD_CORE, ...AI, ...JOBS, ...PROD_INTUIT })).not.toThrow();
    expect(() => parseServerEnv({ ...CORE, INTUIT_ENVIRONMENT: "sandbox" })).not.toThrow();
    expect(bad({ ...CORE, INTUIT_ENVIRONMENT: "prod" }).invalid).toEqual(["INTUIT_ENVIRONMENT"]);
  });

  it("local builds and boots refuse production Intuit keys too (gate otherwise off)", () => {
    for (const env of [{ APP_ENV: "local", INTUIT_ENVIRONMENT: "production" }, { INTUIT_ENVIRONMENT: "production" }]) {
      const err = catchError(() => assertBuildEnv(env)) as EnvValidationError;
      expect(err.invalid).toEqual(["INTUIT_ENVIRONMENT"]);
    }
    expect(() => assertBuildEnv({ APP_ENV: "local", INTUIT_ENVIRONMENT: "sandbox" })).not.toThrow();
    expect(() => assertBuildEnv({ ...STAGING_CORE, INTUIT_ENVIRONMENT: "production" })).not.toThrow();
  });

  it("on Vercel, staging needs VERCEL_TARGET_ENV=staging and vercel dev is local only", () => {
    const VERCEL_DEV = { VERCEL: "1", VERCEL_ENV: "development" };
    expect(() => parseServerEnv({ ...CORE, ...VERCEL_DEV })).not.toThrow();
    expect(bad({ ...STAGING_CORE, ...VERCEL_DEV }).invalid).toEqual(["APP_ENV"]);
    expect(bad({ ...STAGING_CORE, ...VERCEL_DEV, INTUIT_ENVIRONMENT: "production" }).invalid).toEqual([
      "APP_ENV",
      "INTUIT_ENVIRONMENT",
    ]);
    expect(bad({ ...STAGING_CORE, VERCEL: "1", VERCEL_TARGET_ENV: "preview" }).invalid).toEqual(["APP_ENV"]);
    expect(bad({ ...CORE, VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" }).invalid).toEqual(["APP_ENV"]);
  });

  it("VERCEL_ENV=production wins: production rules apply whatever APP_ENV says", async () => {
    const { isRealDataEnv } = await import("./schema");
    expect(isRealDataEnv({ APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "production" })).toBe(true);
    // The production all-or-none rule for Anthropic applies, and APP_ENV must say production.
    const err = bad({ ...STAGING_CORE, VERCEL: "1", VERCEL_ENV: "production", ANTHROPIC_API_KEY: AI.ANTHROPIC_API_KEY });
    expect(err.missing).toEqual(["ANTHROPIC_MODEL_ANALYSIS", "ANTHROPIC_MODEL_FAST"]);
    expect(err.invalid).toEqual(["APP_ENV"]);
  });

  it("on Vercel, VERCEL_ENV must be present (fail closed)", () => {
    expect(bad({ ...STAGING_CORE, VERCEL: "1" }).missing).toEqual(["VERCEL_ENV"]);
  });

  it("a PR Preview may not hold the Nichols Law data plane", () => {
    expect(bad({ ...PREVIEW_CORE, ...VERCEL_PREVIEW, SUPABASE_NL_URL: "https://nl.example.test" }).invalid).toEqual([
      "SUPABASE_NL_URL",
    ]);
    expect(bad({ ...PREVIEW_CORE, ...VERCEL_PREVIEW, SUPABASE_NL_SECRET_KEY: "sb_secret_FAKE-nl" }).invalid).toEqual([
      "SUPABASE_NL_SECRET_KEY",
    ]);
  });

  it("isRealDataEnv: APP_ENV=staging on a Vercel PR Preview target is not a real-data environment", async () => {
    const { isRealDataEnv } = await import("./schema");
    expect(isRealDataEnv({ APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" })).toBe(false);
    expect(isRealDataEnv({ APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "preview" })).toBe(false);
    expect(isRealDataEnv({ APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "development" })).toBe(false);
    expect(isRealDataEnv({ APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "staging" })).toBe(true);
    expect(isRealDataEnv({ APP_ENV: "staging" })).toBe(true); // local machine against staging, by design
    expect(isRealDataEnv({ APP_ENV: "preview", VERCEL_ENV: "production" })).toBe(true); // production fails closed
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_TARGET_ENV", "preview");
    expect(() =>
      requireConnectorEnv("intuit", {
        INTUIT_CLIENT_ID: "fake-id",
        INTUIT_CLIENT_SECRET: "fake-secret",
        INTUIT_REDIRECT_URI: "https://app.example.test/cb",
        INTUIT_WEBHOOK_VERIFIER_TOKEN: "fake-verifier",
        INTUIT_ENVIRONMENT: "production",
      }),
    ).toThrow(EnvValidationError);
  });

  it("google: the redirect URI defaults to localhost only in local development; elsewhere it is https on the app's own origin (T-063)", () => {
    const G = { GOOGLE_OAUTH_CLIENT_ID: "fake-id", GOOGLE_OAUTH_CLIENT_SECRET: "fake-secret" };
    vi.stubEnv("APP_ENV", "local");
    expect(requireConnectorEnv("google", G).GOOGLE_REDIRECT_URI).toBe("http://localhost:3000/api/connect/google/callback");
    expect(requireConnectorEnv("google", { ...G, GOOGLE_REDIRECT_URI: "http://localhost:3001/api/connect/google/callback" }).GOOGLE_REDIRECT_URI).toBe(
      "http://localhost:3001/api/connect/google/callback",
    );
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
    expect(() => requireConnectorEnv("google", G)).toThrow(EnvValidationError);
    expect(() => requireConnectorEnv("google", { ...G, GOOGLE_REDIRECT_URI: "http://app.example.test/cb" })).toThrow(EnvValidationError);
    // another origin than the app's is refused (an attacker-chosen host would receive the authorization code)
    expect(() => requireConnectorEnv("google", { ...G, GOOGLE_REDIRECT_URI: "https://evil.example.test/api/connect/google/callback" })).toThrow(EnvValidationError);
    expect(requireConnectorEnv("google", { ...G, GOOGLE_REDIRECT_URI: "https://app.example.test/api/connect/google/callback" }).GOOGLE_REDIRECT_URI).toMatch(/^https:/);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(() => requireConnectorEnv("google", { ...G, GOOGLE_REDIRECT_URI: "https://app.example.test/api/connect/google/callback" })).toThrow(EnvValidationError); // no app origin: fail closed
  });

  it("refuses INTUIT_ENVIRONMENT=production when the connector is used outside staging/production", () => {
    const INTUIT_PROD = {
      INTUIT_CLIENT_ID: "fake-id",
      INTUIT_CLIENT_SECRET: "fake-secret",
      INTUIT_REDIRECT_URI: "https://app.example.test/cb",
      INTUIT_WEBHOOK_VERIFIER_TOKEN: "fake-verifier",
      INTUIT_ENVIRONMENT: "production",
    };
    for (const flags of [LOCAL_FLAGS, { production: false, local: false, realData: false }]) {
      const err = catchError(() => parseConnectorEnv("intuit", INTUIT_PROD, flags)) as EnvValidationError;
      expect(err.invalid).toEqual(["INTUIT_ENVIRONMENT"]);
    }
    expect(parseConnectorEnv("intuit", INTUIT_PROD, { production: false, local: false, realData: true }).INTUIT_ENVIRONMENT).toBe(
      "production",
    );
    // requireConnectorEnv derives the flags from the real process env, not from the caller's record.
    vi.stubEnv("APP_ENV", "preview");
    expect(() => requireConnectorEnv("intuit", { ...INTUIT_PROD, APP_ENV: "staging" })).toThrow(EnvValidationError);
    vi.stubEnv("APP_ENV", "staging");
    expect(requireConnectorEnv("intuit", INTUIT_PROD).INTUIT_ENVIRONMENT).toBe("production");
  });

  it("getSupabaseSecretKey fails closed on a Preview without a database; getServerEnv still works", async () => {
    for (const [k, v] of Object.entries({ ...PREVIEW_CORE, ...VERCEL_PREVIEW })) vi.stubEnv(k, v);
    for (const k of Object.keys(SUPABASE_HTTPS)) vi.stubEnv(k, "");
    const mod = await import("./server");
    expect(mod.getServerEnv().APP_ENV).toBe("preview");
    const err = catchError(() => mod.getSupabaseSecretKey()) as Error;
    expect(err.message).toMatch(VALIDATION_FAILED);
    expect(err.message).toContain("SUPABASE_SECRET_KEY");
  });

  it("client: the Supabase pair is all or none, and requireSupabasePublicEnv fails closed by name", async () => {
    const { requireSupabasePublicEnv } = await import("./client");
    const none = parseClientEnv({ NEXT_PUBLIC_APP_URL: HTTPS.NEXT_PUBLIC_APP_URL });
    const err = catchError(() => requireSupabasePublicEnv(none)) as EnvValidationError;
    expect(err.missing).toEqual(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]);
    expect(requireSupabasePublicEnv(parseClientEnv(CORE)).NEXT_PUBLIC_SUPABASE_URL).toBe(CORE.NEXT_PUBLIC_SUPABASE_URL);
    const half = catchError(() =>
      parseClientEnv({ NEXT_PUBLIC_APP_URL: HTTPS.NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_SUPABASE_URL: HTTPS.NEXT_PUBLIC_SUPABASE_URL }),
    ) as EnvValidationError;
    expect(half.missing).toEqual(["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]);
  });

  it("startup warns (names only) when a Preview has no database", async () => {
    const { warnUnconfiguredFeatures } = await import("./startup");
    const log = vi.fn();
    warnUnconfiguredFeatures({ ...PREVIEW_CORE, ...VERCEL_PREVIEW, ...AI, ...JOBS }, log);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toContain("No database");
  });
});

describe("connector env", () => {
  it("covers every connector family and requires nothing at startup", () => {
    expect([...CONNECTOR_NAMES].sort()).toEqual(
      ["ghl", "google", "graph", "intuit", "monday", "notion", "push", "sentry", "stripe"].sort(),
    );
    expect(() => parseServerEnv(CORE)).not.toThrow();
  });

  it("requireConnectorEnv fails closed naming missing variables only", () => {
    const err = catchError(() =>
      requireConnectorEnv("stripe", { STRIPE_RESTRICTED_KEY: "rk_test_FAKE-do-not-leak-7" }),
    ) as EnvValidationError;
    expect(err).toBeInstanceOf(EnvValidationError);
    expect(err.missing).toEqual(["STRIPE_WEBHOOK_SECRET"]);
    expect(err.message).toContain("STRIPE_WEBHOOK_SECRET");
    expect(err.message).not.toContain("rk_test_FAKE-do-not-leak-7");
  });

  it("fails closed when everything is missing, listing every required name", () => {
    const err = catchError(() => requireConnectorEnv("ghl", {})) as EnvValidationError;
    expect(err.missing).toEqual(["GHL_LOCATION_ID", "GHL_PRIVATE_INTEGRATION_TOKEN"]);
  });

  const INTUIT = {
    INTUIT_CLIENT_ID: "fake-id",
    INTUIT_CLIENT_SECRET: "fake-secret",
    INTUIT_REDIRECT_URI: "http://localhost:3000/api/connect/qbo/callback",
    INTUIT_WEBHOOK_VERIFIER_TOKEN: "fake-verifier",
  };
  const HTTPS_CB = "https://app.example.test/cb";

  it("intuit: defaults to sandbox only outside production", () => {
    expect(parseConnectorEnv("intuit", INTUIT, LOCAL_FLAGS).INTUIT_ENVIRONMENT).toBe("sandbox");
    const prod = catchError(() =>
      parseConnectorEnv("intuit", { ...INTUIT, INTUIT_REDIRECT_URI: HTTPS_CB }, PROD_FLAGS),
    ) as EnvValidationError;
    expect(prod.missing).toEqual(["INTUIT_ENVIRONMENT"]);
    expect(
      parseConnectorEnv(
        "intuit",
        { ...INTUIT, INTUIT_REDIRECT_URI: HTTPS_CB, INTUIT_ENVIRONMENT: "production" },
        PROD_FLAGS,
      ).INTUIT_ENVIRONMENT,
    ).toBe("production");
  });

  it("intuit: redirect URI must be https unless local; output holds only intuit variables (N6)", () => {
    const err = catchError(() =>
      parseConnectorEnv("intuit", INTUIT, { production: false, local: false, realData: false }),
    ) as EnvValidationError;
    expect(err.invalid).toEqual(["INTUIT_REDIRECT_URI"]);
    const ok = parseConnectorEnv("intuit", { ...INTUIT, APP_ENV: "local", VERCEL_ENV: "preview" }, LOCAL_FLAGS);
    expect(Object.keys(ok).sort()).toEqual(
      [...Object.keys(connectorEnvShapes.intuit)].sort(),
    );
  });

  it("requireConnectorEnv takes intuit flags from the real process env", () => {
    expect(() => requireConnectorEnv("intuit", INTUIT)).toThrow(EnvValidationError); // no APP_ENV: fail closed
    vi.stubEnv("APP_ENV", "local");
    expect(requireConnectorEnv("intuit", INTUIT).INTUIT_ENVIRONMENT).toBe("sandbox");
    vi.stubEnv("APP_ENV", "production");
    expect(() => requireConnectorEnv("intuit", { ...INTUIT, INTUIT_REDIRECT_URI: HTTPS_CB })).toThrow(
      EnvValidationError,
    );
  });

  it("flags invalid values by name without echoing them", () => {
    const err = catchError(() =>
      parseConnectorEnv("push", {
        VAPID_PRIVATE_KEY: "fake-private-do-not-leak-8",
        VAPID_SUBJECT: "admin-at-example-do-not-leak-9",
        NEXT_PUBLIC_VAPID_PUBLIC_KEY: VAPID,
      }, LOCAL_FLAGS),
    ) as EnvValidationError;
    expect(err.invalid).toEqual(["VAPID_SUBJECT"]);
    expect(err.message).not.toContain("do-not-leak");
  });

  it("push and sentry reuse the client validators", () => {
    const base = { VAPID_PRIVATE_KEY: "x", VAPID_SUBJECT: "mailto:a@example.com" };
    expect(() => parseConnectorEnv("push", { ...base, NEXT_PUBLIC_VAPID_PUBLIC_KEY: "short" }, LOCAL_FLAGS)).toThrow(
      EnvValidationError,
    );
    expect(() => parseConnectorEnv("sentry", { NEXT_PUBLIC_SENTRY_DSN: "sk_live_FAKE" }, LOCAL_FLAGS)).toThrow(EnvValidationError);
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "nope"])(
    "rejects unknown or prototype connector name %s",
    (name) => {
      expect(() => requireConnectorEnv(name as never, {})).toThrow(EnvValidationError);
    },
  );

  it("does not treat prototype names in env as present", () => {
    const err = catchError(() => requireConnectorEnv("monday", {})) as EnvValidationError;
    expect(err.missing).toEqual(["MONDAY_API_TOKEN"]);
  });

  it("every connector schema validates when all of its variables are present", () => {
    for (const name of CONNECTOR_NAMES) {
      const env: Record<string, string> = {};
      for (const key of connectorKeys(name)) env[key] = valueFor(key);
      expect(() => parseConnectorEnv(name, env, LOCAL_FLAGS), name).not.toThrow();
    }
  });
});

describe("client env schema", () => {
  it("parses a valid client env", () => {
    const env = parseClientEnv({ ...CORE, NEXT_PUBLIC_VAPID_PUBLIC_KEY: VAPID });
    expect(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe("sb_publishable_FAKEFAKEFAKE");
  });

  it("contains only NEXT_PUBLIC_ names", () => {
    for (const name of CLIENT_ENV_NAMES) expect(name.startsWith("NEXT_PUBLIC_"), name).toBe(true);
    expect(Object.keys(clientEnvSchema.shape).sort()).toEqual([...CLIENT_ENV_NAMES].sort());
  });

  it("has no NEXT_PUBLIC_ name matching a secret pattern", () => {
    for (const name of CLIENT_ENV_NAMES) expect(isSecretLikeName(name), name).toBe(false);
  });

  it("server-only names never carry the NEXT_PUBLIC_ prefix", () => {
    for (const name of SERVER_ONLY_ENV_NAMES) expect(name.startsWith("NEXT_PUBLIC_"), name).toBe(false);
  });

  it("every .env.example NEXT_PUBLIC_ name is in the client schema, passes the secret check, and vice versa", () => {
    const example = readFileSync(fileUrl("../../../../.env.example"), "utf8");
    const names = [...example.matchAll(/^(NEXT_PUBLIC_[A-Z0-9_]+)=/gm)].map((m) => m[1] as string).sort();
    expect(names).toEqual([...CLIENT_ENV_NAMES].sort());
    for (const name of names) expect(isSecretLikeName(name), name).toBe(false);
  });

  it("every server and connector name exists in .env.example", () => {
    const example = readFileSync(fileUrl("../../../../.env.example"), "utf8");
    const declared = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
    const all = new Set<string>(SERVER_ONLY_ENV_NAMES);
    for (const name of CONNECTOR_NAMES) for (const key of connectorKeys(name)) all.add(key);
    all.delete("VERCEL_ENV"); // platform variable, not ours
    for (const name of all) expect(declared.has(name), name).toBe(true);
  });

  it("rejects secret-looking values", () => {
    for (const bad of ["sb_secret_FAKE", "sk_live_FAKE", "sk_test_FAKE", "rk_live_FAKE", "whsec_FAKE"]) {
      const err = catchError(() =>
        parseClientEnv({ ...CORE, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: bad }),
      ) as EnvValidationError;
      expect(err.invalid).toEqual(["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]);
      expect(err.message).not.toContain(bad);
    }
    expect(() => parseClientEnv({ ...CORE, NEXT_PUBLIC_VAPID_PUBLIC_KEY: "sk_live_FAKE" })).toThrow(EnvValidationError);
  });

  it("the publishable key must match sb_publishable_ exactly (allow-pattern)", () => {
    for (const bad of [
      "fake-anon-key",
      "sb_publishable_",
      "sb_publishable_has space",
      "SB_PUBLISHABLE_x",
      fakeJwt({ role: "anon" }),
    ]) {
      expect(() => parseClientEnv({ ...CORE, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: bad }), bad).toThrow(
        EnvValidationError,
      );
    }
  });

  it("rejects values with surrounding whitespace (M1)", () => {
    for (const bad of [
      " sb_secret_FAKE",
      "sb_secret_FAKE ",
      "\tsk_live_FAKE",
      " sb_publishable_FAKE",
      "sb_publishable_FAKE\n",
    ]) {
      expect(
        () => parseClientEnv({ ...CORE, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: bad }),
        JSON.stringify(bad),
      ).toThrow(EnvValidationError);
    }
    expect(() => parseClientEnv({ ...CORE, NEXT_PUBLIC_APP_URL: " http://localhost:3000" })).toThrow(
      EnvValidationError,
    );
  });

  it("restricts URLs to http/https and the VAPID key to a base64url point (M2)", () => {
    expect(() => parseClientEnv({ ...CORE, NEXT_PUBLIC_APP_URL: "javascript://x/%0Aalert(1)" })).toThrow(
      EnvValidationError,
    );
    expect(() => parseClientEnv({ ...CORE, NEXT_PUBLIC_SENTRY_DSN: "ftp://abc@host/1" })).toThrow(EnvValidationError);
    expect(() =>
      parseClientEnv({ ...CORE, NEXT_PUBLIC_SENTRY_DSN: "https://abc@o0.ingest.sentry.io/1" }),
    ).not.toThrow();
    for (const bad of ["B".repeat(85), "B".repeat(89), `${"B".repeat(86)}+`, "short"])
      expect(() => parseClientEnv({ ...CORE, NEXT_PUBLIC_VAPID_PUBLIC_KEY: bad }), bad).toThrow(EnvValidationError);
    for (const ok of ["B".repeat(86), "B".repeat(87), "B".repeat(88)])
      expect(() => parseClientEnv({ ...CORE, NEXT_PUBLIC_VAPID_PUBLIC_KEY: ok })).not.toThrow();
  });

  it("client.ts reads every client variable with a literal process.env access (Next inlining)", async () => {
    const src = readFileSync(fileUrl("./client.ts"), "utf8");
    for (const name of CLIENT_ENV_NAMES) expect(src, name).toContain(`process.env.${name}`);
    expect(src).not.toMatch(/process\.env\[/);
    const { readClientEnvFromProcess } = await import("./client");
    expect(Object.keys(readClientEnvFromProcess()).sort()).toEqual([...CLIENT_ENV_NAMES].sort());
  });

  it("client-safe modules import nothing server-only", () => {
    for (const f of [
      "./client.ts",
      "./schema.ts",
      "./secret-patterns.js",
      "./build.ts",
      "./startup.ts",
      "./redact.ts",
      "./index.ts",
    ])
      expect(readFileSync(fileUrl(f), "utf8"), f).not.toMatch(/^\s*import\s+["']server-only["']/m);
  });

  it("server.ts imports server-only", () => {
    expect(readFileSync(fileUrl("./server.ts"), "utf8")).toMatch(/^import "server-only";/m);
  });
});

describe("secret patterns", () => {
  it("does not use stateful regex flags", () => {
    for (const p of SECRET_NAME_PATTERNS) expect(p.flags).not.toMatch(/[gy]/);
  });

  it.each([
    "NEXT_PUBLIC_SUPABASE_SECRET_KEY",
    "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_SERVICE_ROLE",
    "NEXT_PUBLIC_STRIPE_SECRET",
    "NEXT_PUBLIC_VAPID_PRIVATE_KEY",
    "NEXT_PUBLIC_MONDAY_API_TOKEN",
    "NEXT_PUBLIC_SENTRY_AUTH_TOKEN",
    "NEXT_PUBLIC_DB_PASSWORD",
    "NEXT_PUBLIC_ANTHROPIC_API_KEY",
    "NEXT_PUBLIC_OPENAI_APIKEY",
    "NEXT_PUBLIC_INNGEST_SIGNING_KEY",
    "NEXT_PUBLIC_INNGEST_EVENT_KEY",
    "NEXT_PUBLIC_STRIPE_WEBHOOK_URL",
    "NEXT_PUBLIC_STRIPE_RESTRICTED_KEY",
    "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", // not allowlisted: must be added deliberately
    "NEXT_PUBLIC_GOOGLE_CLIENT_SECRET",
    "NEXT_PUBLIC_DATABASE_URL",
    "next_public_supabase_secret_key",
    // M3 false negatives
    "NEXT_PUBLIC_POSTGRES_URL",
    "NEXT_PUBLIC_REDIS_URL",
    "NEXT_PUBLIC_MONGODB_URI",
    "NEXT_PUBLIC_DATABASE_DSN",
    "NEXT_PUBLIC_SMTP_PASS",
    "NEXT_PUBLIC_SUPABASE_DB_PWD",
    "NEXT_PUBLIC_BASIC_AUTH",
    "NEXT_PUBLIC_AUTH",
    "NEXT_PUBLIC_AUTH_TOKEN",
    "NEXT_PUBLIC_AUTH_SECRET",
    "NEXT_PUBLIC_VERCEL_AUTOMATION_BYPASS_SECRET",
    "NEXT_PUBLIC_HMAC_SALT",
    "NEXT_PUBLIC_PEPPER",
    "NEXT_PUBLIC_DB_CONNECTION_STRING",
    "NEXT_PUBLIC_QUEUE_URI",
    // The allowlist is by exact name only: look-alikes are still flagged.
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY_2",
    "NEXT_PUBLIC_VAPID_PUBLIC_KEY_OLD",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ",
  ])("flags %s as secret-like", (name) => {
    expect(isSecretLikeName(name)).toBe(true);
  });

  it.each([
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
    "NEXT_PUBLIC_SENTRY_DSN",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
  ])("passes public-by-design %s", (name) => {
    expect(isSecretLikeName(name)).toBe(false);
  });

  it("keeps the public-by-design allowlist narrow and exact", () => {
    expect([...PUBLIC_BY_DESIGN_NAMES]).toEqual([
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
      "NEXT_PUBLIC_SENTRY_DSN",
    ]);
  });

  it("catches every real secret variable name from .env.example", () => {
    for (const name of [
      "SUPABASE_SECRET_KEY",
      "SUPABASE_NL_SECRET_KEY",
      "INNGEST_EVENT_KEY",
      "INNGEST_SIGNING_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GRAPH_CLIENT_SECRET",
      "INTUIT_CLIENT_SECRET",
      "INTUIT_WEBHOOK_VERIFIER_TOKEN",
      "STRIPE_RESTRICTED_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "GHL_PRIVATE_INTEGRATION_TOKEN",
      "MONDAY_API_TOKEN",
      "NOTION_INTEGRATION_TOKEN",
      "VAPID_PRIVATE_KEY",
    ])
      expect(isSecretLikeName(name), name).toBe(true);
  });

  it.each([
    "sb_secret_FAKE",
    "sk_live_FAKE",
    "sk_test_FAKE",
    "rk_live_FAKE",
    "rk_test_FAKE",
    "whsec_FAKE",
    "sk-ant-FAKE",
    "ghp_FAKE",
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    "postgresql://user:fakepass@host:5432/db",
    "redis://:fakepass@host:6379",
    "mongodb+srv://user:fakepass@host/db",
    // M4 vendor prefixes
    "signkey-prod-FAKE",
    "GOCSPX-FAKE",
    "re_FAKE123",
    "sntrys_FAKE",
    "sntryu_FAKE",
    "ntn_FAKE",
    "secret_FAKE",
    "pit-FAKE-0000",
    "AKIAABCDEFGHIJKLMNOP",
    // M1: whitespace must not defeat anchored patterns
    " sb_secret_FAKE",
    "sk_live_FAKE\n",
    "\t whsec_FAKE ",
  ])("flags secret value %j", (value) => {
    expect(isSecretLikeValue(value)).toBe(true);
  });

  it("flags service_role JWTs (decoded payload) but not anon JWTs, and never throws", () => {
    expect(isSecretLikeValue(fakeJwt({ role: "service_role", iss: "supabase" }))).toBe(true);
    expect(isSecretLikeValue(` ${fakeJwt({ role: "service_role" })} `)).toBe(true);
    expect(isSecretLikeValue(fakeJwt({ role: "anon" }))).toBe(false);
    expect(isSecretLikeValue(fakeJwt("just a string"))).toBe(false);
    expect(isSecretLikeValue(fakeJwt(null))).toBe(false);
    for (const garbage of ["eyJ.x.y", "eyJhbGciOi.%%%.sig", "eyJabc.eyJ.", `eyJabc.${b64url("not json").slice(0, 5)}.z`])
      expect(() => isSecretLikeValue(garbage), garbage).not.toThrow();
  });

  it.each([
    "sb_publishable_FAKE",
    "http://localhost:3000",
    "https://abc@o0.ingest.sentry.io/1",
    "BFAKEvapidpublickey",
    "postgresql://host:5432/db",
    "http://localhost:3000/a@b",
  ])("passes public value %s", (value) => {
    expect(isSecretLikeValue(value)).toBe(false);
  });
});

describe("build-time validation", () => {
  it("does nothing on CI-style builds without env", () => {
    expect(shouldValidateBuildEnv({})).toBe(false);
    expect(() => assertBuildEnv({})).not.toThrow();
  });

  it("fails a Vercel build that is missing core vars, naming them", () => {
    expect(shouldValidateBuildEnv({ VERCEL: "1" })).toBe(true);
    const err = catchError(() =>
      assertBuildEnv({ VERCEL: "1", ...STAGING_CORE, SUPABASE_SECRET_KEY: "" }),
    ) as EnvValidationError;
    expect(err.missing).toEqual(["SUPABASE_SECRET_KEY"]);
  });

  it("passes a preview build with a full core env and nothing else", () => {
    expect(() => assertBuildEnv({ ...VERCEL_PREVIEW, ...PREVIEW_CORE })).not.toThrow();
    expect(() => assertBuildEnv({ ...VERCEL_PREVIEW, ...PREVIEW_CORE, ...SUPABASE_HTTPS })).not.toThrow();
  });

  it("can be forced explicitly", () => {
    expect(() => assertBuildEnv({ NICHOLS_VALIDATE_ENV: "true" })).toThrow(EnvValidationError);
    expect(() => assertBuildEnv({ NICHOLS_VALIDATE_ENV: "1" })).toThrow(EnvValidationError);
  });

  it("gate flags accept 1/true only; anything else non-empty throws", () => {
    expect(parseGateFlag("X", undefined)).toBe(false);
    expect(parseGateFlag("X", "")).toBe(false);
    expect(parseGateFlag("X", "1")).toBe(true);
    expect(parseGateFlag("X", "TRUE")).toBe(true);
    expect(parseGateFlag("X", "True")).toBe(true);
    for (const bad of ["0", "false", "yes", "2", " 1"]) {
      const err = catchError(() => parseGateFlag("NICHOLS_VALIDATE_ENV", bad)) as EnvValidationError;
      expect(err).toBeInstanceOf(EnvValidationError);
      expect(err.invalid).toEqual(["NICHOLS_VALIDATE_ENV"]);
    }
    expect(() => shouldValidateBuildEnv({ VERCEL: "maybe" })).toThrow(EnvValidationError);
  });

  it("scans every NEXT_PUBLIC_* variable present, declared or not (M5)", () => {
    const err = catchError(() =>
      assertBuildEnv({
        VERCEL: "1",
        ...CORE,
        NEXT_PUBLIC_STRIPE_SECRET: "x", // name
        NEXT_PUBLIC_ANALYTICS_ID: "sk_live_FAKE-do-not-leak-10", // value
        NEXT_PUBLIC_OK: "fine",
      }),
    ) as EnvValidationError;
    expect(err.invalid).toEqual(["NEXT_PUBLIC_ANALYTICS_ID", "NEXT_PUBLIC_STRIPE_SECRET"]);
    expect(err.message).not.toContain("do-not-leak");
    expect(() =>
      assertNoSecretPublicVars({ ...CORE, NEXT_PUBLIC_SENTRY_DSN: "https://abc@o0.ingest.sentry.io/1" }),
    ).not.toThrow();
  });
});

describe("Vercel system variables (N1)", () => {
  const VERCEL_SYSTEM: Record<string, string> = {
    NEXT_PUBLIC_VERCEL_ENV: "preview",
    NEXT_PUBLIC_VERCEL_TARGET_ENV: "preview",
    NEXT_PUBLIC_VERCEL_URL: "my-app-git-sk-foo-team.vercel.app",
    NEXT_PUBLIC_VERCEL_BRANCH_URL: "my-app-git-sk-foo-team.vercel.app",
    NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL: "app.example.test",
    NEXT_PUBLIC_VERCEL_REGION: "iad1",
    NEXT_PUBLIC_VERCEL_GIT_PROVIDER: "github",
    NEXT_PUBLIC_VERCEL_GIT_REPO_SLUG: "re_portal",
    NEXT_PUBLIC_VERCEL_GIT_REPO_OWNER: "sk_org",
    NEXT_PUBLIC_VERCEL_GIT_REPO_ID: "123456789",
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF: "sk_foo",
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE: "re_x: fix typo in sk_ docs",
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_AUTHOR_LOGIN: "pit-author",
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_AUTHOR_NAME: "Ada Lovelace",
    NEXT_PUBLIC_VERCEL_GIT_PREVIOUS_SHA: "fedcba9876543210fedcba9876543210fedcba98",
    NEXT_PUBLIC_VERCEL_GIT_PULL_REQUEST_ID: "42",
  };

  it("a full Vercel Preview build with framework system vars passes", () => {
    expect(() =>
      assertBuildEnv({ ...PREVIEW_CORE, ...VERCEL_PREVIEW, ...VERCEL_SYSTEM }),
    ).not.toThrow();
  });

  it("every system variable NAME passes the name check", () => {
    for (const name of Object.keys(VERCEL_SYSTEM)) expect(isSecretLikeName(name), name).toBe(false);
  });

  it("an unexpected NEXT_PUBLIC_VERCEL_* name is still flagged by name", () => {
    const err = catchError(() =>
      assertBuildEnv({
        ...PREVIEW_CORE,
        ...VERCEL_PREVIEW,
        ...VERCEL_SYSTEM,
        NEXT_PUBLIC_VERCEL_AUTOMATION_BYPASS_SECRET: "fake-value",
      }),
    ) as EnvValidationError;
    expect(err.invalid).toEqual(["NEXT_PUBLIC_VERCEL_AUTOMATION_BYPASS_SECRET"]);
  });

  it("the free-text exemption is for those exact names and for the value scan only", () => {
    expect([...FREE_TEXT_VALUE_NAMES].sort()).toEqual(
      [
        "NEXT_PUBLIC_VERCEL_GIT_COMMIT_AUTHOR_LOGIN",
        "NEXT_PUBLIC_VERCEL_GIT_COMMIT_AUTHOR_NAME",
        "NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE",
        "NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF",
        "NEXT_PUBLIC_VERCEL_GIT_REPO_OWNER",
        "NEXT_PUBLIC_VERCEL_GIT_REPO_SLUG",
      ].sort(),
    );
    // Same secret-looking value under a non-exempt name is still caught.
    expect(() => assertNoSecretPublicVars({ NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA: "sk_live_FAKE" })).toThrow(
      EnvValidationError,
    );
    expect(() => assertNoSecretPublicVars({ NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE: "sk_live_FAKE" })).not.toThrow();
  });

  it("AUTH is matched as a name token: AUTHOR is fine, AUTH / BASIC_AUTH / AUTH_TOKEN are not", () => {
    expect(isSecretLikeName("NEXT_PUBLIC_VERCEL_GIT_COMMIT_AUTHOR_LOGIN")).toBe(false);
    expect(isSecretLikeName("NEXT_PUBLIC_AUTHOR")).toBe(false);
    for (const n of ["NEXT_PUBLIC_AUTH", "NEXT_PUBLIC_BASIC_AUTH", "NEXT_PUBLIC_AUTH_TOKEN", "AUTH_X"])
      expect(isSecretLikeName(n), n).toBe(true);
  });
});

describe("build gate (N3)", () => {
  it("validates whenever APP_ENV is staging or production, even without Vercel", () => {
    expect(shouldValidateBuildEnv({ APP_ENV: "staging" })).toBe(true);
    expect(shouldValidateBuildEnv({ APP_ENV: "production" })).toBe(true);
    expect(shouldValidateBuildEnv({ APP_ENV: "local" })).toBe(false);
    expect(() => assertBuildEnv({ APP_ENV: "staging" })).toThrow(EnvValidationError);
    expect(() => assertBuildEnv({ ...STAGING_CORE })).not.toThrow();
  });
});

function connectorKeys(name: ConnectorName): string[] {
  return Object.keys(connectorEnvShapes[name]);
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected function to throw");
}

function fileUrl(rel: string): string {
  return fileURLToPath(new URL(rel, import.meta.url));
}

function valueFor(key: string): string {
  if (key === "INTUIT_ENVIRONMENT") return "sandbox";
  if (key === "INTUIT_REDIRECT_URI") return "http://localhost:3000/cb";
  if (key === "GOOGLE_REDIRECT_URI") return "http://localhost:3000/api/connect/google/callback";
  if (key === "APP_ENV") return "local";
  if (key === "VERCEL_ENV") return "preview";
  if (key === "VAPID_SUBJECT") return "mailto:admin@example.com";
  if (key === "NEXT_PUBLIC_VAPID_PUBLIC_KEY") return VAPID;
  if (key === "NEXT_PUBLIC_SENTRY_DSN") return "https://abc@o0.ingest.sentry.io/1";
  return "fake-value";
}
