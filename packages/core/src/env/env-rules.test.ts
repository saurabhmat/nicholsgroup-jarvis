// T-226: an EnvValidationError carries the NAME of each variable and the fixed rule it broke, never a value.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_RULE_TEXTS, EnvValidationError, GENERIC_ENV_RULE, describeEnvError, parseConnectorEnv } from "./schema";

const CANARY = "canary-envrule-4b1d77e0-not-a-real-value";
const CLEAN = { production: false, local: false, realData: true, appOrigin: "https://app.example.test" } as const;
const GOOGLE = { GOOGLE_OAUTH_CLIENT_ID: "synthetic-id", GOOGLE_OAUTH_CLIENT_SECRET: CANARY };

function fail(env: Record<string, string>, runtime = CLEAN): EnvValidationError {
  try {
    parseConnectorEnv("google", env, runtime);
  } catch (e) {
    return e as EnvValidationError;
  }
  throw new Error("expected a failure");
}

describe("env rule names", () => {
  it("names the variable and the rule for a redirect on another origin, without any value", () => {
    const e = fail({ ...GOOGLE, GOOGLE_REDIRECT_URI: `https://other.example.test/${CANARY}/api/connect/google/callback` });
    expect(e.rules).toEqual({ GOOGLE_REDIRECT_URI: "must be on the app's own origin" });
    expect(describeEnvError(e)).toBe("GOOGLE_REDIRECT_URI: must be on the app's own origin");
    for (const text of [e.message, describeEnvError(e), JSON.stringify(e.rules)]) {
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain("other.example.test");
    }
  });

  it("an http redirect says https is required; a missing variable says it is not set", () => {
    expect(describeEnvError(fail({ ...GOOGLE, GOOGLE_REDIRECT_URI: "http://app.example.test/cb" }))).toBe("GOOGLE_REDIRECT_URI: https required");
    const missing = fail({ GOOGLE_OAUTH_CLIENT_SECRET: CANARY, GOOGLE_REDIRECT_URI: "https://app.example.test/api/connect/google/callback" });
    expect(describeEnvError(missing)).toBe("GOOGLE_OAUTH_CLIENT_ID: is not set");
    expect(describeEnvError(missing)).not.toContain(CANARY);
  });

  it("an issue whose text is not a fixed rule (for example a built-in schema message) is reported generically", () => {
    const e = fail({ ...GOOGLE, GOOGLE_REDIRECT_URI: `not a url ${CANARY}` });
    expect(Object.values(e.rules).every((r) => ENV_RULE_TEXTS.has(r))).toBe(true);
    expect(describeEnvError(e)).toMatch(new RegExp(`^GOOGLE_REDIRECT_URI: (${GENERIC_ENV_RULE}|[a-z' ]+)$`));
    expect(describeEnvError(e)).not.toContain(CANARY);
  });

  it("only variable-shaped names and listed rules can be described (a tampered error carries no free text)", () => {
    const e = new EnvValidationError("x", ["lowercase value 123", `A_B=${CANARY}`], ["GOOD_NAME", `bad ${CANARY}`], { GOOD_NAME: `free text ${CANARY}` });
    expect(describeEnvError(e)).toBe(`GOOD_NAME: ${GENERIC_ENV_RULE}`);
  });

  it("every message literal in the schema is on the fixed list (so its rule can be shown)", () => {
    const source = readFileSync(fileURLToPath(new URL("./schema.ts", import.meta.url)), "utf8");
    const literals = [...source.matchAll(/message: "((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? "").replace(/\\'/g, "'"));
    expect(literals.length).toBeGreaterThan(5);
    for (const l of literals) expect(ENV_RULE_TEXTS.has(l), l).toBe(true);
  });
});
