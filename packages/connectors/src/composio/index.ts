// `@nichols/connectors/composio` (T-219): the Composio connect flow, the Test check and the availability flags wired to the
// real connection store, state store, lane config and audit log. Server-only (core env is). apps/web's routes and
// Settings page are thin wrappers over this; `@composio/core` is imported only by ./sdk.ts.
//
// Credentials: `COMPOSIO_API_KEY` through `requireConnectorEnv("composio")` at call time (fails closed naming variables,
// never values), registered for redaction, passed explicitly to the SDK. The auth config ids are read from the same
// environment (not secrets, not hard-coded, not per company).
import { getAudit } from "@nichols/core/lane-router";
import { EnvValidationError, getServerEnv, requireConnectorEnv } from "@nichols/core/env/server";
import { ConnectorError } from "../contract/errors";
import { dbStateStore } from "../oauth/state";
import { composioConnectionStore, laneConfigReader } from "../vault/index";
import { SecretValue } from "../vault/secret";
import { createComposioCheck } from "./check";
import { createComposioConnect, type ComposioAvailability } from "./connect";
import { TOOLKITS, TOOLKIT_SPECS, type Toolkit } from "./constants";
import { guardComposio } from "./port";
import { createSdkPort } from "./sdk";

export { createComposioHandlers } from "./handlers";
export type { ComposioCheck, ComposioCheckStatus } from "./check";
export type { ComposioAvailability, ComposioCallbackResult } from "./connect";
export { TOOLKITS, TOOLKIT_SPECS, isToolkit, type Toolkit } from "./constants";

const env = () => requireConnectorEnv("composio");

const composio = guardComposio(createSdkPort({ apiKey: () => new SecretValue(env().COMPOSIO_API_KEY) }));

/** The toolkit's auth config id, or null when the project key or the id is not configured. */
function authConfigId(toolkit: Toolkit): string | null {
  try {
    return env()[TOOLKIT_SPECS[toolkit].authConfigEnv] ?? null;
  } catch {
    return null;
  }
}

/** Which toolkits can be connected here (booleans only). Not configured = the button says so and does nothing. */
export function composioAvailability(): ComposioAvailability {
  return Object.fromEntries(TOOLKITS.map((t) => [t, authConfigId(t) !== null])) as ComposioAvailability;
}

const SETTING_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Per toolkit, the NAMES of the settings that stop it being connected (empty = configured). Names only, never values:
 * the project key when it is missing or invalid, else the toolkit's auth config id when it is not set.
 */
export function composioMissingSettings(): Record<Toolkit, string[]> {
  let keyProblems: string[] = [];
  let e: ReturnType<typeof env> | null = null;
  try {
    e = env();
  } catch (err) {
    keyProblems = err instanceof EnvValidationError ? [...err.missing, ...err.invalid].filter((n) => SETTING_NAME.test(n)) : ["COMPOSIO_API_KEY"];
  }
  const names = Object.fromEntries(
    TOOLKITS.map((t) => {
      const name = TOOLKIT_SPECS[t].authConfigEnv;
      // Without a usable project key nothing can be connected: that is the setting to fix first.
      return [t, e === null ? (keyProblems.length > 0 ? keyProblems : ["COMPOSIO_API_KEY"]) : e[name] ? [] : [name]];
    }),
  );
  return names as Record<Toolkit, string[]>;
}

function appOrigin(): string {
  const e = getServerEnv();
  if (e.NEXT_PUBLIC_APP_URL && URL.canParse(e.NEXT_PUBLIC_APP_URL)) return new URL(e.NEXT_PUBLIC_APP_URL).origin;
  if (e.APP_ENV === "local") return "http://localhost:3000";
  throw new ConnectorError({ kind: "connection_unavailable", message: "The app URL is not configured" });
}

export const composioFlow = createComposioConnect({
  composio,
  states: dbStateStore,
  connections: composioConnectionStore,
  laneConfig: laneConfigReader,
  authConfigId,
  appOrigin,
  audit: getAudit(),
});

export const composioCheck = createComposioCheck({ composio, connections: composioConnectionStore, laneConfig: laneConfigReader });
