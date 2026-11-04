// Intuit OpenID discovery (QB-5, T-050). The authorization, token and revocation endpoints are read from Intuit's
// discovery document for INTUIT_ENVIRONMENT and cached in memory (24 h; a stale copy is served for up to 7 days if
// Intuit cannot be reached). The document is public provider metadata, not lane data, so one cache serves every lane;
// the HTTP client still needs a lane for its logs and rate bucket, so callers pass theirs.
// A poisoned or mistaken document cannot redirect credentials: every endpoint must be https on an intuit.com host and
// the token and revocation endpoints must not carry a query.
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { ConnectorError, isConnectorError } from "../contract/errors";
import { createHttpClient, type HttpClient } from "../http/client";
import type { ConnectorLogger } from "../log/index";
import { DISCOVERY_ORIGIN, DISCOVERY_PATH, INTUIT_TID_HEADER, type IntuitEnvironment } from "./constants";

export type IntuitEndpoints = { authorization: string; token: string; revocation: string };

const TTL_MS = 24 * 3600_000;
const STALE_MAX_MS = 7 * 24 * 3600_000;

const Doc = z.looseObject({
  authorization_endpoint: z.string().max(2048),
  token_endpoint: z.string().max(2048),
  revocation_endpoint: z.string().max(2048),
});

function checked(name: string, value: string, allowQuery: boolean): string {
  const bad = () => new ConnectorError({ kind: "provider_error", message: `Discovery document has an unusable ${name}` });
  if (!URL.canParse(value)) throw bad();
  const u = new URL(value);
  const intuitHost = u.hostname === "intuit.com" || u.hostname.endsWith(".intuit.com");
  if (u.protocol !== "https:" || !intuitHost || u.username || u.password || u.port || u.hash || (!allowQuery && u.search)) throw bad();
  return u.toString();
}

export function parseDiscoveryDocument(body: unknown): IntuitEndpoints {
  const parsed = Doc.safeParse(body);
  if (!parsed.success) throw new ConnectorError({ kind: "provider_error", message: "Discovery document is not valid" });
  return {
    authorization: checked("authorization_endpoint", parsed.data.authorization_endpoint, false),
    token: checked("token_endpoint", parsed.data.token_endpoint, false),
    revocation: checked("revocation_endpoint", parsed.data.revocation_endpoint, false),
  };
}

export type DiscoveryOptions = {
  now?: () => number;
  logger?: ConnectorLogger;
  /** Test hook. */
  http?: (laneId: LaneId) => HttpClient;
};

export interface Discovery {
  get(laneId: LaneId, environment: IntuitEnvironment): Promise<IntuitEndpoints>;
}

export function createDiscovery(options: DiscoveryOptions = {}): Discovery {
  const now = options.now ?? Date.now;
  const httpFor =
    options.http ??
    ((laneId: LaneId) =>
      createHttpClient({ provider: "quickbooks", baseUrl: DISCOVERY_ORIGIN, laneId, requestIdHeader: INTUIT_TID_HEADER, maxResponseBytes: 256 * 1024, ...(options.logger ? { logger: options.logger } : {}) }));
  const cache = new Map<IntuitEnvironment, { endpoints: IntuitEndpoints; at: number }>();
  const inflight = new Map<IntuitEnvironment, Promise<IntuitEndpoints>>();

  async function load(laneId: LaneId, environment: IntuitEnvironment): Promise<IntuitEndpoints> {
    const res = await httpFor(laneId).request({ method: "GET", path: DISCOVERY_PATH[environment] });
    const endpoints = parseDiscoveryDocument(res.data);
    cache.set(environment, { endpoints, at: now() });
    return endpoints;
  }

  return {
    async get(laneId, environment) {
      if (environment !== "sandbox" && environment !== "production") {
        throw new ConnectorError({ kind: "invalid_input", message: "Unknown Intuit environment" });
      }
      const hit = cache.get(environment);
      if (hit && now() - hit.at < TTL_MS) return hit.endpoints;
      let flight = inflight.get(environment);
      if (!flight) {
        flight = load(laneId, environment).finally(() => inflight.delete(environment));
        inflight.set(environment, flight);
      }
      try {
        return await flight;
      } catch (e) {
        // Intuit unreachable or answered nonsense: keep working on a recent copy rather than stop every refresh.
        if (hit && now() - hit.at < STALE_MAX_MS && isConnectorError(e) && e.info.kind !== "invalid_input") return hit.endpoints;
        throw e;
      }
    },
  };
}
