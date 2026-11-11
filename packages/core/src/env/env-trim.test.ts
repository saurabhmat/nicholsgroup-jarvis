// T-234 part 0: every environment value is trimmed centrally; model ids must look like model ids after trimming; a bad
// value fails with the variable NAME and never prints the value.
import { describe, expect, it, vi } from "vitest";
import { shouldValidateBuildEnv } from "./build";
import {
  EnvValidationError,
  isRealDataEnv,
  describeEnvError,
  normalizeEnv,
  parseConnectorEnv,
  parseServerEnv,
  resolveAnthropicEnv,
  runtimeFlags,
  type EnvRecord,
} from "./schema";

const CORE = {
  NEXT_PUBLIC_APP_URL: "https://app.example.test",
  NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.test",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_FAKEFAKEFAKE",
  APP_ENV: "staging",
  ENABLED_LANES: "PKG",
  SUPABASE_SECRET_KEY: "sb_secret_FAKE-do-not-leak-1",
} as const;
const AI = { ANTHROPIC_API_KEY: "fake-anthropic-do-not-leak-4", ANTHROPIC_MODEL_ANALYSIS: "claude-sonnet-5-5", ANTHROPIC_MODEL_FAST: "claude-haiku-5-5" };
const prod = (extra: EnvRecord): EnvRecord => ({ ...CORE, APP_ENV: "production", ...extra });

describe("normalizeEnv", () => {
  it("trims spaces, tabs and CR/LF; whitespace-only counts as unset", () => {
    const out = normalizeEnv({ A: "  x\t", B: "y\r\n", C: "\t \r\n", D: "", E: undefined, F: "a b" });
    expect(out).toEqual({ A: "x", B: "y", F: "a b" });
  });
  it("leaves NEXT_PUBLIC_* as given (they are inlined into the browser build; a stray space is reported by name)", () => {
    expect(normalizeEnv({ NEXT_PUBLIC_APP_URL: " https://x.test " }).NEXT_PUBLIC_APP_URL).toBe(" https://x.test ");
  });
});

describe("model ids (ANTHROPIC_MODEL_*)", () => {
  const withModel = (v: string) => ({ ...AI, ANTHROPIC_MODEL_ANALYSIS: v });
  it.each([
    ["trailing tab (the production incident)", "claude-sonnet-5-5\t"],
    ["leading and trailing spaces", "  claude-sonnet-5-5  "],
    ["CRLF", "claude-sonnet-5-5\r\n"],
    ["clean", "claude-sonnet-5-5"],
  ])("accepts after trimming: %s", (_n, v) => {
    const r = resolveAnthropicEnv(withModel(v), true);
    expect(r.configured).toBe(true);
    if (r.configured) expect(r.ANTHROPIC_MODEL_ANALYSIS).toBe("claude-sonnet-5-5");
  });

  it.each([
    ["internal space", "claude sonnet-5-5"],
    ["internal tab", "claude-sonnet\t5-5"],
    ["not a claude id", "gpt-4o"],
    ["upper case", "Claude-Sonnet-5-5"],
    ["just the prefix", "claude-"],
    ["injection-looking", "claude-x;rm -rf"],
  ])("rejects: %s, naming the variable and never the value", (_n, v) => {
    // Production: a partly set group fails closed.
    let err: unknown;
    try {
      parseServerEnv(prod({ ...withModel(v), INNGEST_EVENT_KEY: "e", INNGEST_SIGNING_KEY: "s" }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnvValidationError);
    const e = err as EnvValidationError;
    expect(e.invalid).toEqual(["ANTHROPIC_MODEL_ANALYSIS"]);
    expect(describeEnvError(e)).toBe("ANTHROPIC_MODEL_ANALYSIS: invalid model id");
    expect(e.message).not.toContain(v.trim());
    expect(JSON.stringify(e)).not.toContain("do-not-leak");
  });

  it("an empty string is unset: reported as missing, not as a bad value", () => {
    const r = resolveAnthropicEnv(withModel(""), false);
    expect(r).toEqual({ configured: false, missing: ["ANTHROPIC_MODEL_ANALYSIS"] });
  });

  it("outside production a bad id means not configured, listing the name", () => {
    expect(resolveAnthropicEnv(withModel("gpt-4o"), false)).toEqual({ configured: false, missing: ["ANTHROPIC_MODEL_ANALYSIS"] });
  });

  it("the fast model id is checked the same way", () => {
    const r = resolveAnthropicEnv({ ...AI, ANTHROPIC_MODEL_FAST: "haiku" }, false);
    expect(r).toEqual({ configured: false, missing: ["ANTHROPIC_MODEL_FAST"] });
  });
});

describe("other values are trimmed centrally", () => {
  it("API key, Inngest keys and the Supabase secret key lose surrounding whitespace", () => {
    const r = resolveAnthropicEnv({ ...AI, ANTHROPIC_API_KEY: "\tk-fake \n" }, true);
    expect(r.configured && r.ANTHROPIC_API_KEY).toBe("k-fake");
    const s = parseServerEnv(prod({ ...AI, INNGEST_EVENT_KEY: "e\t", INNGEST_SIGNING_KEY: " s", SUPABASE_SECRET_KEY: "sb_secret_FAKE\r\n" }));
    expect(s.SUPABASE_SECRET_KEY).toBe("sb_secret_FAKE");
  });
  it("production detection ignores surrounding whitespace in APP_ENV", () => {
    // "production\t" is production: the strict (all-or-none) group rules apply, so a half-set Anthropic group fails.
    expect(() => parseServerEnv({ ...CORE, APP_ENV: "production\t", ANTHROPIC_API_KEY: "k" })).toThrow(EnvValidationError);
  });
  it.each([
    ["google", { GOOGLE_OAUTH_CLIENT_ID: " id\t", GOOGLE_OAUTH_CLIENT_SECRET: "sec\n", GOOGLE_REDIRECT_URI: "https://app.example.test/api/connect/google/callback\t" }, "GOOGLE_OAUTH_CLIENT_ID", "id"],
    ["intuit", { INTUIT_CLIENT_ID: "i\t", INTUIT_CLIENT_SECRET: "s", INTUIT_REDIRECT_URI: "https://app.example.test/cb\r\n", INTUIT_ENVIRONMENT: "sandbox\t" }, "INTUIT_CLIENT_ID", "i"],
    ["composio", { COMPOSIO_API_KEY: "\tkey " }, "COMPOSIO_API_KEY", "key"],
    ["stripe", { STRIPE_RESTRICTED_KEY: "rk\t", STRIPE_WEBHOOK_SECRET: "wh" }, "STRIPE_RESTRICTED_KEY", "rk"],
    ["ghl", { GHL_PRIVATE_INTEGRATION_TOKEN: "t ", GHL_LOCATION_ID: "l\n" }, "GHL_PRIVATE_INTEGRATION_TOKEN", "t"],
  ] as const)("connector %s", (name, env, key, expected) => {
    const flags = runtimeFlags({ ...CORE, APP_ENV: "staging" });
    const v = parseConnectorEnv(name, env as EnvRecord, flags) as Record<string, string>;
    expect(v[key]).toBe(expected);
  });
  it("a Supabase URL with a stray space is still rejected by name (NEXT_PUBLIC values are not trimmed)", () => {
    let err: unknown;
    try {
      parseServerEnv({ ...CORE, NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.test " });
    } catch (e) {
      err = e;
    }
    expect(describeEnvError(err as EnvValidationError)).toBe("NEXT_PUBLIC_SUPABASE_URL: surrounding whitespace");
  });
});

describe("entry points compare trimmed values (T-234 review M3/L1)", () => {
  it.each(["preview\t", "staging\t", "production\n", " production "])("shouldValidateBuildEnv is true for APP_ENV=%j", (v) => {
    expect(shouldValidateBuildEnv({ APP_ENV: v })).toBe(true);
  });
  it("shouldValidateBuildEnv stays false for local", () => {
    expect(shouldValidateBuildEnv({ APP_ENV: "local\t" })).toBe(false);
  });
  it("isRealDataEnv and runtimeFlags read trimmed values", () => {
    expect(isRealDataEnv({ APP_ENV: "staging\t" })).toBe(true);
    expect(isRealDataEnv({ APP_ENV: "production\n" })).toBe(true);
    expect(isRealDataEnv({ APP_ENV: "staging", VERCEL: "1\t", VERCEL_TARGET_ENV: "preview" })).toBe(false);
    expect(runtimeFlags({ APP_ENV: "local\t" }).local).toBe(true);
    expect(runtimeFlags({ APP_ENV: "production\n" }).production).toBe(true);
  });
  it("parseServerEnv picks the preview schema for 'preview\\t' (no database needed)", () => {
    const s = parseServerEnv({ NEXT_PUBLIC_APP_URL: "https://app.example.test", APP_ENV: "preview\t", ENABLED_LANES: "PKG", VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" });
    expect(s.APP_ENV).toBe("preview");
  });
  it("startup warning treats 'preview\\t' as a preview", () => {
    const logs: string[] = [];
    vi.resetModules();
    return import("./startup").then((m) => {
      m.warnUnconfiguredFeatures({ APP_ENV: "preview\t" }, (x) => logs.push(x));
      expect(logs.join(" ")).toContain("No database in this preview deployment");
    });
  });
});
