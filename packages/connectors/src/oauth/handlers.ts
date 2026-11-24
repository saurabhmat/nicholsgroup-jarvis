// HTTP handlers for the /api/connect routes (T-035), built over a flow and a session guard so they can be tested
// without Next.js. apps/web's route files only call these.
//
// start:    POST same-origin only (it creates server state) → 303 to the provider's consent page.
// callback: GET from the provider → 303 to a fixed path with a coarse result code; provider text never reaches the page.
import { authErrorResponse } from "@nichols/core/auth";
import { EnvValidationError, describeEnvError } from "@nichols/core/env/server";
import { isConnectorError, TEAMS_ONE_ACCOUNT_MESSAGE } from "../contract/errors";
import { consentReturn } from "../microsoft/consent";
import { TEAMS_PROVIDER } from "../teams/constants";
import type { AuthorizeFn, createOAuthFlow } from "./flow";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (error: string, status: number) => Response.json({ error }, { status, headers: NO_STORE });

/** The lane codes the lane router issues (also the pattern of the lane in a state, pkce.ts). */
const LANE_CODE = /^[A-Z]{1,8}$/;

/**
 * Codes for the fixed banners Settings draws after a connect could not start because the server is not configured.
 * The page maps the code to text written there; nothing from the request or the error ever reaches the page.
 */
const ENV_ERROR_CODES: Readonly<Record<string, string>> = { google: "google_env" };
const GENERIC_ENV_ERROR_CODE = "connect_env";

/** The providers' own check of their redirect address (`<NAME>_REDIRECT_URI must end with <callback path>`): a fixed message, no value in it. */
const REDIRECT_URI_SETTING = /^[A-Z][A-Z0-9_]{0,40}_REDIRECT_URI must end with \/[a-z0-9/_-]{1,80}$/;
function isRedirectUriSetting(e: unknown): boolean {
  return isConnectorError(e) && e.info.kind === "connection_unavailable" && REDIRECT_URI_SETTING.test(e.info.message);
}

/** A connect button is a plain form POST (the browser navigates); a script or API client is not. */
function isFormNavigation(request: Request): boolean {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  return type.startsWith("application/x-www-form-urlencoded") || type.startsWith("multipart/form-data") || request.headers.get("sec-fetch-mode") === "navigate";
}

/**
 * The answer to a person's Connect click when the server is not configured: back to the lane's Settings page with a fixed code
 * (the lane must be a lane code; the code comes from the fixed map, own keys only). Null for a script caller or any other lane value.
 */
function notConfigured(request: Request, url: URL, provider: string): Response | null {
  const lane = url.searchParams.get("lane") ?? "";
  if (!isFormNavigation(request) || !LANE_CODE.test(lane)) return null;
  const code = Object.hasOwn(ENV_ERROR_CODES, provider) ? ENV_ERROR_CODES[provider] : GENERIC_ENV_ERROR_CODE;
  return new Response(null, { status: 303, headers: { ...NO_STORE, location: `/${lane}/settings?error=${code}` } });
}

/** How long the callback waits for its follow-up before redirecting anyway. */
export const ON_CONNECTED_TIMEOUT_MS = 3_000;

/** Called once after a connect or reconnect stored its tokens (T-241: QuickBooks starts its full initial load). Ids only. */
export type OnConnected = (connected: { provider: string; laneId: string; connectionId: string }) => Promise<void>;

export function createConnectHandlers(flow: Pick<ReturnType<typeof createOAuthFlow>, "has" | "start" | "callback">, authorizer: () => Promise<AuthorizeFn>, opts: { onConnected?: OnConnected } = {}) {
  return {
    async start(request: Request, provider: string): Promise<Response> {
      if (!flow.has(provider)) return json("not_found", 404);
      const url = new URL(request.url);
      if (request.headers.get("origin") !== url.origin) return json("forbidden", 403);
      // A reconnect names its connection (T-238); anything but a UUID is refused before any state is stored.
      const connection = url.searchParams.get("connection");
      if (connection !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connection)) return json("not_found", 404);
      try {
        const location = await flow.start(provider, url.searchParams.get("lane") ?? "", await authorizer(), connection === null ? {} : { connectionId: connection.toLowerCase() });
        return new Response(null, { status: 303, headers: { ...NO_STORE, location } });
      } catch (e) {
        const res = authErrorResponse(e);
        if (res) return res;
        if (e instanceof EnvValidationError) {
          // Variable NAMES and the rule each broke, never values (the error carries none).
          console.error(`[api/connect/start] not configured (${provider}, ${e.scope.slice(0, 80)}): ${describeEnvError(e)}`);
          return notConfigured(request, url, provider) ?? json("unavailable", 503);
        }
        const kind = isConnectorError(e) ? e.info.kind : undefined;
        if (kind === "forbidden") {
          // T-294: the person already has as many Teams accounts as the company allows. A person's click goes back to Settings with the fixed refusal (nothing was stored and nobody was redirected to
          // Microsoft); a script gets the plain 403. The code and sub-code come from this file, never from the request.
          const lane = url.searchParams.get("lane") ?? "";
          if (isConnectorError(e) && e.info.message === TEAMS_ONE_ACCOUNT_MESSAGE && isFormNavigation(request) && LANE_CODE.test(lane)) {
            return new Response(null, { status: 303, headers: { ...NO_STORE, location: `/${lane}/settings?connect=account_refused&provider=${TEAMS_PROVIDER}&detail=one_account`, "referrer-policy": "no-referrer" } });
          }
          return json("forbidden", 403);
        }
        if (kind === "not_found") return json("not_found", 404);
        if (kind === "rate_limited") return json("too_many_connects", 429);
        // The class name, and for a ConnectorError its kind and fixed (already redacted) message: enough to tell a configuration refusal from an outage.
        console.error("[api/connect/start] unavailable:", e instanceof Error ? e.name : typeof e, isConnectorError(e) ? { kind: e.info.kind, message: e.info.message } : {});
        // T-275: a redirect address that does not end with the provider's callback path is a server setting, like a missing variable:
        // a person who clicked a Connect button is sent back to Settings with the same fixed banner instead of a bare JSON answer.
        // (Reached only after the origin check above and `authorize` inside flow.start, which runs before the provider's client() check.)
        return (isRedirectUriSetting(e) ? notConfigured(request, url, provider) : null) ?? json("unavailable", 503);
      }
    },

    async callback(request: Request, provider: string): Promise<Response> {
      if (!flow.has(provider)) return json("not_found", 404);
      const url = new URL(request.url);
      // T-257: the return from a tenant admin consent link is not a connect (no `code`, the fixed marker `state`; see microsoft/consent.ts). It is
      // answered before anything else with one of two fixed codes and nothing from the request: no session, no database, no state, no token, no
      // request to Microsoft. A request carrying a `code` never takes this branch.
      const consent = consentReturn(provider, url.searchParams);
      if (consent) {
        const back = new URL(`/${encodeURIComponent(consent.laneId)}/settings`, url.origin);
        back.searchParams.set("connect", consent.ok ? "consent_ok" : "consent_failed");
        back.searchParams.set("provider", provider);
        return new Response(null, { status: 303, headers: { ...NO_STORE, location: back.pathname + back.search, "referrer-policy": "no-referrer" } });
      }
      try {
        const result = await flow.callback(provider, url.searchParams, await authorizer());
        if (result.ok && opts.onConnected) {
          // The connect stands whatever happens here: a failure is logged by class and the next scheduled sync still loads the data.
          try {
            // Bounded (review L4): a slow event API must not hold the user's redirect; the scheduled poll still loads the data.
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("follow-up timed out"), { name: "TimeoutError" })), ON_CONNECTED_TIMEOUT_MS); });
            try {
              await Promise.race([opts.onConnected({ provider: result.provider, laneId: result.laneId, connectionId: result.connectionId }), timeout]);
            } finally {
              clearTimeout(timer);
            }
          } catch (e) {
            console.error("[api/connect/callback] follow-up not started:", e instanceof Error ? e.name : typeof e);
          }
        }
        // Back to the lane's Settings page, which shows the result. The lane is parsed from `state` (`[A-Z]{1,8}`, pkce.ts)
        // and passed `authorize` for this user; it is not necessarily a matched state row, so use it for this redirect only.
        // Without a lane (garbage state, unknown provider) back to the entry page, which drops the result (accepted).
        const home = new URL(result.laneId ? `/${encodeURIComponent(result.laneId)}/settings` : "/", url.origin);
        home.searchParams.set("connect", result.ok ? "ok" : result.reason);
        if (result.provider) home.searchParams.set("provider", result.provider);
        // T-278 review C1: a fixed sub-code from the provider's own list (already checked against a fixed shape in the flow); nothing from a provider response.
        // T-294: a successful connect can carry one too (Teams: the account was already connected and only its sign-in was refreshed).
        if (result.detail && /^[a-z][a-z_]{0,23}$/.test(result.detail)) home.searchParams.set("detail", result.detail);
        // T-294: a reconnect that came back as another account names its own row (a uuid from the verified state); Settings words it with that row's own address, read from the database.
        if (!result.ok && result.provider === TEAMS_PROVIDER && result.connectionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result.connectionId)) home.searchParams.set("conn", result.connectionId);
        // The code was exchanged but nothing was stored: the owner is told to remove the app's access at the provider (D-24).
        if (!result.ok && result.message) home.searchParams.set("notice", "remove_app_access");
        return new Response(null, { status: 303, headers: { ...NO_STORE, location: home.pathname + home.search, "referrer-policy": "no-referrer" } });
      } catch (e) {
        const res = authErrorResponse(e);
        if (res) return res;
        console.error("[api/connect/callback] unavailable:", e instanceof Error ? e.name : typeof e);
        return json("unavailable", 503);
      }
    },
  };
}
