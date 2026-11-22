// T-251: Microsoft Graph connector env (spec microsoft.md 5.2). Synthetic values only; errors name variables, never values.
import { describe, expect, it } from "vitest";
import { CLIENT_ENV_NAMES, EnvValidationError, connectorEnvShapes, describeEnvError, graphNotificationUrl, parseConnectorEnv } from "./schema";
import { isSecretLikeName } from "./secret-patterns";

const CANARY = "canary-graph-7c2e41a9-not-a-real-secret";
const LOCAL = { production: false, local: true, realData: false } as const;
const HOSTED = { production: false, local: false, realData: true, appOrigin: "https://app.example.test" } as const;
const COMMERCIAL = { GRAPH_CLIENT_ID: "synthetic-id", GRAPH_CLIENT_SECRET: CANARY };
const USGOV = { GRAPH_USGOV_CLIENT_ID: "synthetic-gov-id", GRAPH_USGOV_CLIENT_SECRET: CANARY };
const OK_URI = "https://app.example.test/api/connect/microsoft/callback";

function fail(name: "graph" | "graph_usgov", env: Record<string, string>, flags: typeof HOSTED | typeof LOCAL = HOSTED): EnvValidationError {
  try {
    parseConnectorEnv(name, env, flags);
  } catch (e) {
    return e as EnvValidationError;
  }
  throw new Error("expected a failure");
}

describe("graph connector env", () => {
  it("has exactly the three commercial variables and no tenant id", () => {
    expect(Object.keys(connectorEnvShapes.graph).sort()).toEqual(["GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET", "GRAPH_NOTIFICATION_URL", "GRAPH_REDIRECT_URI"]);
    expect(Object.keys(connectorEnvShapes.graph)).not.toContain("GRAPH_TENANT_ID");
    expect(Object.keys(connectorEnvShapes.graph_usgov).sort()).toEqual(["GRAPH_USGOV_CLIENT_ID", "GRAPH_USGOV_CLIENT_SECRET", "GRAPH_USGOV_REDIRECT_URI"]);
  });

  it("a stray GRAPH_TENANT_ID is neither required nor returned", () => {
    const v = parseConnectorEnv("graph", { ...COMMERCIAL, GRAPH_TENANT_ID: "x" }, LOCAL) as Record<string, string>;
    expect(v.GRAPH_TENANT_ID).toBeUndefined();
  });

  it("locally the redirect defaults to the localhost callback; a set value is kept", () => {
    expect(parseConnectorEnv("graph", COMMERCIAL, LOCAL).GRAPH_REDIRECT_URI).toBe("http://localhost:3000/api/connect/microsoft/callback");
    expect(parseConnectorEnv("graph", { ...COMMERCIAL, GRAPH_REDIRECT_URI: OK_URI }, LOCAL).GRAPH_REDIRECT_URI).toBe(OK_URI);
  });

  it("elsewhere the redirect is required, https and on the app's own origin", () => {
    expect(describeEnvError(fail("graph", COMMERCIAL))).toBe("GRAPH_REDIRECT_URI: is not set");
    expect(describeEnvError(fail("graph", { ...COMMERCIAL, GRAPH_REDIRECT_URI: "http://app.example.test/cb" }))).toBe("GRAPH_REDIRECT_URI: https required");
    expect(describeEnvError(fail("graph", { ...COMMERCIAL, GRAPH_REDIRECT_URI: "https://other.example.test/cb" }))).toBe(
      "GRAPH_REDIRECT_URI: must be on the app's own origin",
    );
    expect(parseConnectorEnv("graph", { ...COMMERCIAL, GRAPH_REDIRECT_URI: OK_URI }, HOSTED).GRAPH_REDIRECT_URI).toBe(OK_URI);
    // No known app origin fails closed.
    expect(() => parseConnectorEnv("graph", { ...COMMERCIAL, GRAPH_REDIRECT_URI: OK_URI }, { ...HOSTED, appOrigin: undefined })).toThrow(EnvValidationError);
  });

  describe("GRAPH_NOTIFICATION_URL (T-068)", () => {
    const URL_OK = "https://app.example.test/api/webhooks/microsoft";
    const REDIRECTED = { ...COMMERCIAL, GRAPH_REDIRECT_URI: OK_URI };
    const group = (value: string | undefined, flags: typeof HOSTED | typeof LOCAL) => parseConnectorEnv("graph", { ...REDIRECTED, ...(value === undefined ? {} : { GRAPH_NOTIFICATION_URL: value }) }, flags);
    const problem = (value: string, flags: typeof HOSTED | typeof LOCAL = HOSTED) => {
      try {
        graphNotificationUrl(group(value, flags), flags);
      } catch (e) {
        return describeEnvError(e as EnvValidationError);
      }
      return null;
    };

    it("is optional everywhere: unset means no subscriptions (null), never an error", () => {
      expect(graphNotificationUrl(group(undefined, LOCAL), LOCAL)).toBeNull();
      expect(graphNotificationUrl(group(undefined, HOSTED), HOSTED)).toBeNull();
      expect(graphNotificationUrl(parseConnectorEnv("graph", COMMERCIAL, LOCAL), LOCAL)).toBeNull();
    });

    it("a valid value is returned, locally and on the app's own origin", () => {
      expect(graphNotificationUrl(group(URL_OK, LOCAL), LOCAL)).toBe(URL_OK);
      expect(graphNotificationUrl(group(URL_OK, HOSTED), HOSTED)).toBe(URL_OK);
    });

    it("must be https (in local development too), without credentials, query or fragment, and exactly the receiver path", () => {
      expect(problem("http://app.example.test/api/webhooks/microsoft")).toBe("GRAPH_NOTIFICATION_URL: https required");
      expect(problem("http://localhost:3000/api/webhooks/microsoft", LOCAL)).toBe("GRAPH_NOTIFICATION_URL: https required");
      expect(problem("not a url")).toBe("GRAPH_NOTIFICATION_URL: https required");
      for (const bad of ["https://user:pw@app.example.test/api/webhooks/microsoft", `${URL_OK}?x=1`, `${URL_OK}#frag`, "https://app.example.test/api/webhooks/qbo", "https://app.example.test/x/api/webhooks/microsoft", `${URL_OK}/`]) {
        expect(problem(bad), bad).toBe("GRAPH_NOTIFICATION_URL: must be the receiver URL");
      }
    });

    it("outside local it must be on the app's own origin (a host is never taken from a request); no known origin fails closed", () => {
      expect(problem("https://other.example.test/api/webhooks/microsoft")).toBe("GRAPH_NOTIFICATION_URL: must be on the app's own origin");
      expect(() => graphNotificationUrl(group(URL_OK, HOSTED), { ...HOSTED, appOrigin: undefined })).toThrow(EnvValidationError);
    });

    it("a mistake in it does NOT stop the rest of the Microsoft group: connect, sync and health read the same group and still parse", () => {
      for (const bad of ["http://app.example.test/api/webhooks/microsoft", "garbage", "https://other.example.test/x"]) {
        expect(parseConnectorEnv("graph", { ...REDIRECTED, GRAPH_NOTIFICATION_URL: bad }, HOSTED).GRAPH_CLIENT_ID).toBe("synthetic-id");
      }
    });

    it("the error text names the variable and the rule, never the value", () => {
      const e = (() => {
        try {
          graphNotificationUrl(group("https://user:SECRET-CANARY@app.example.test/api/webhooks/microsoft", HOSTED), HOSTED);
        } catch (x) {
          return x as EnvValidationError;
        }
        throw new Error("expected a failure");
      })();
      expect(JSON.stringify([e.message, describeEnvError(e)])).not.toContain("SECRET-CANARY");
    });
  });

  it("missing variables are named and no value appears in any error text", () => {
    const m = fail("graph", { GRAPH_CLIENT_SECRET: CANARY, GRAPH_REDIRECT_URI: OK_URI });
    expect(m.missing).toEqual(["GRAPH_CLIENT_ID"]);
    expect(m.message + describeEnvError(m)).not.toContain(CANARY);
    const e = fail("graph", { ...COMMERCIAL, GRAPH_REDIRECT_URI: `https://other.example.test/${CANARY}` });
    expect(e.invalid).toEqual(["GRAPH_REDIRECT_URI"]);
    for (const text of [e.message, describeEnvError(e), JSON.stringify(e.rules)]) {
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain("other.example.test");
    }
    const bad = fail("graph", { ...COMMERCIAL, GRAPH_REDIRECT_URI: `not a url ${CANARY}` });
    expect(bad.message).not.toContain(CANARY);
    expect(describeEnvError(bad)).not.toContain(CANARY);
  });

  it("the usgov group has the same redirect rules and the same local default, and leaks no value", () => {
    expect(parseConnectorEnv("graph_usgov", USGOV, LOCAL).GRAPH_USGOV_REDIRECT_URI).toBe("http://localhost:3000/api/connect/microsoft/callback");
    expect(describeEnvError(fail("graph_usgov", USGOV))).toBe("GRAPH_USGOV_REDIRECT_URI: is not set");
    expect(describeEnvError(fail("graph_usgov", { ...USGOV, GRAPH_USGOV_REDIRECT_URI: "http://app.example.test/cb" }))).toBe("GRAPH_USGOV_REDIRECT_URI: https required");
    const e = fail("graph_usgov", { ...USGOV, GRAPH_USGOV_REDIRECT_URI: `https://other.example.test/${CANARY}` });
    expect(describeEnvError(e)).toBe("GRAPH_USGOV_REDIRECT_URI: must be on the app's own origin");
    expect(e.message + describeEnvError(e)).not.toContain(CANARY);
    expect(parseConnectorEnv("graph_usgov", { ...USGOV, GRAPH_USGOV_REDIRECT_URI: OK_URI }, HOSTED).GRAPH_USGOV_REDIRECT_URI).toBe(OK_URI);
  });

  it("the secrets match the secret patterns and every GRAPH_* name is server-only", () => {
    expect(isSecretLikeName("GRAPH_CLIENT_SECRET")).toBe(true);
    expect(isSecretLikeName("GRAPH_USGOV_CLIENT_SECRET")).toBe(true);
    for (const name of [...Object.keys(connectorEnvShapes.graph), ...Object.keys(connectorEnvShapes.graph_usgov)]) {
      expect(name.startsWith("NEXT_PUBLIC_"), name).toBe(false);
      expect(CLIENT_ENV_NAMES as readonly string[], name).not.toContain(name);
    }
  });
});
