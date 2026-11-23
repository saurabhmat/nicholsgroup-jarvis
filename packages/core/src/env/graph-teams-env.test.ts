// T-279: the Microsoft Teams connector env (a second Entra app, docs/specs/messages.md 5). Synthetic values only; errors name variables, never values.
import { describe, expect, it } from "vitest";
import { EnvValidationError, connectorEnvShapes, describeEnvError, parseConnectorEnv } from "./schema";
import { isSecretLikeName } from "./secret-patterns";

const CANARY = "canary-graph-teams-5e8b13d7-not-a-real-secret";
const LOCAL = { production: false, local: true, realData: false } as const;
const HOSTED = { production: false, local: false, realData: true, appOrigin: "https://app.example.test" } as const;
const TEAMS = { GRAPH_TEAMS_CLIENT_ID: "synthetic-teams-id", GRAPH_TEAMS_CLIENT_SECRET: CANARY };
const OK_URI = "https://app.example.test/api/connect/teams/callback";

function fail(env: Record<string, string>, flags: typeof HOSTED | typeof LOCAL = HOSTED): EnvValidationError {
  try {
    parseConnectorEnv("graph_teams", env, flags);
  } catch (e) {
    return e as EnvValidationError;
  }
  throw new Error("expected a failure");
}

describe("graph_teams connector env", () => {
  it("has exactly the three Teams variables and shares nothing with the mail app", () => {
    expect(Object.keys(connectorEnvShapes.graph_teams).sort()).toEqual(["GRAPH_TEAMS_CLIENT_ID", "GRAPH_TEAMS_CLIENT_SECRET", "GRAPH_TEAMS_REDIRECT_URI"]);
    const mail = Object.keys(connectorEnvShapes.graph);
    expect(Object.keys(connectorEnvShapes.graph_teams).some((k) => mail.includes(k))).toBe(false);
  });

  it("the mail app's variables do not satisfy the Teams group", () => {
    const e = fail({ GRAPH_CLIENT_ID: "x", GRAPH_CLIENT_SECRET: "y", GRAPH_REDIRECT_URI: OK_URI.replace("teams", "microsoft") });
    expect(describeEnvError(e)).toContain("GRAPH_TEAMS_CLIENT_ID: is not set");
    expect(describeEnvError(e)).toContain("GRAPH_TEAMS_CLIENT_SECRET: is not set");
  });

  it("locally the redirect defaults to the Teams localhost callback; a set value is kept", () => {
    expect(parseConnectorEnv("graph_teams", TEAMS, LOCAL).GRAPH_TEAMS_REDIRECT_URI).toBe("http://localhost:3000/api/connect/teams/callback");
    expect(parseConnectorEnv("graph_teams", { ...TEAMS, GRAPH_TEAMS_REDIRECT_URI: OK_URI }, LOCAL).GRAPH_TEAMS_REDIRECT_URI).toBe(OK_URI);
  });

  it("elsewhere the redirect is required, https and on the app's own origin", () => {
    expect(describeEnvError(fail(TEAMS))).toBe("GRAPH_TEAMS_REDIRECT_URI: is not set");
    expect(describeEnvError(fail({ ...TEAMS, GRAPH_TEAMS_REDIRECT_URI: "http://app.example.test/cb" }))).toBe("GRAPH_TEAMS_REDIRECT_URI: https required");
    expect(describeEnvError(fail({ ...TEAMS, GRAPH_TEAMS_REDIRECT_URI: "https://other.example.test/cb" }))).toBe("GRAPH_TEAMS_REDIRECT_URI: must be on the app's own origin");
    expect(parseConnectorEnv("graph_teams", { ...TEAMS, GRAPH_TEAMS_REDIRECT_URI: OK_URI }, HOSTED).GRAPH_TEAMS_REDIRECT_URI).toBe(OK_URI);
    expect(() => parseConnectorEnv("graph_teams", { ...TEAMS, GRAPH_TEAMS_REDIRECT_URI: OK_URI }, { ...HOSTED, appOrigin: undefined })).toThrow(EnvValidationError);
  });

  it("an error never carries a value", () => {
    const e = fail({ ...TEAMS, GRAPH_TEAMS_REDIRECT_URI: "http://app.example.test/cb" });
    expect(JSON.stringify(e)).not.toContain(CANARY);
    expect(e.message).not.toContain(CANARY);
    expect(describeEnvError(e)).not.toContain(CANARY);
  });

  it("the secret name is recognised as a secret (redaction and the secret-name scan)", () => {
    expect(isSecretLikeName("GRAPH_TEAMS_CLIENT_SECRET")).toBe(true);
  });
});
