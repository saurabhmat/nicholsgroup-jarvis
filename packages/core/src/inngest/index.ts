import "server-only";
// Inngest client and route handlers (T-037, architecture §8). Import path: @nichols/core/inngest
// - getInngest(): the client, created on first use (restricted to this folder, lint). Keys come from
//   getInngestEnv(). Dev mode (local Inngest dev server, no request signing) needs APP_ENV=local AND a development
//   build, so a production build can never run unsigned (T-037 review L2).
// - inngestRoute(functions): GET/POST/PUT for app/api/inngest/route.ts. Not on PR Previews (unreviewed code; their
//   env refuses Inngest keys), and outside local only with keys: otherwise 503. In cloud mode, registration needs a
//   signed request and the app's URL is pinned to NEXT_PUBLIC_APP_URL (review M1).
// - sendLaneEvent(event): validates against the REGISTERED schema for the event name and refuses lanes this deployment
//   does not serve (review L1, L4). Functions validate again on receipt (eventType triggers).
// Functions take `laneId` from their event and use the lane router's job client (JOB_RUNNERS lint list).
import { Inngest, type InngestFunction } from "inngest";
import { serve } from "inngest/next";
import { getInngestEnv, getServerEnv, isDevelopmentRuntime } from "../env/server";
import { LANE_EVENTS } from "./events";

export { actionApproved, connSyncRequested, LANE_EVENTS, laneIdSchema, systemHeartbeat, webhookReceived } from "./events";
export { platformFunctions } from "./functions";
export { CONN_SYNC_CONCURRENCY, CONN_SYNC_RETRIES, connSyncFunction, handleConnSync } from "./conn-sync";
export type { ConnSyncDeps, ConnSyncResult } from "./conn-sync";

const APP_ID = "nichols-portal";
let client: Inngest | undefined;

const isLocalDev = () => getServerEnv().APP_ENV === "local" && isDevelopmentRuntime();

export function getInngest(): Inngest {
  if (client) return client;
  const local = isLocalDev();
  const keys = getInngestEnv();
  client = new Inngest({
    id: APP_ID,
    isDev: local,
    ...(keys.configured && !local ? { eventKey: keys.INNGEST_EVENT_KEY, signingKey: keys.INNGEST_SIGNING_KEY } : {}),
  });
  return client;
}

/** Whether this deployment can serve and send Inngest jobs (local dev server, or keys configured). */
export function inngestAvailable(): boolean {
  if (getServerEnv().APP_ENV === "preview") return false;
  return isLocalDev() || getInngestEnv().configured;
}

/**
 * Validates a lane event against its schema, then sends it. Always use this instead of `getInngest().send()`, so an
 * event without a valid `laneId` (or with unknown fields) never leaves the process. `id` (optional) is Inngest's event
 * id: a second send with the same id inside Inngest's dedupe window is dropped (webhook receiver, T-036).
 */
export async function sendLaneEvent(event: { name: string; data: { laneId: string }; id?: string }) {
  const registered = LANE_EVENTS.find((e) => e.name === event.name);
  if (!registered) throw new Error("unknown event");
  const parsed = await registered.schema["~standard"].validate(event.data);
  if (parsed.issues) throw new Error("invalid event data"); // missing/invalid laneId or unknown fields; no values echoed
  if (!getServerEnv().ENABLED_LANES.includes(event.data.laneId)) throw new Error("lane not served");
  if (!inngestAvailable()) throw new Error("jobs not configured");
  return getInngest().send({ name: event.name, data: event.data, ...(event.id ? { id: event.id } : {}) });
}

type Handler = (request: Request, context: unknown) => Promise<Response>;

/** `functions` is called on the first request (no env access while the app is built). */
export function inngestRoute(
  functions: (inngest: Inngest) => readonly InngestFunction.Any[],
): { GET: Handler; POST: Handler; PUT: Handler } {
  let handlers: { GET: Handler; POST: Handler; PUT: Handler } | undefined;
  const unavailable = () =>
    Response.json({ error: "jobs_not_configured" }, { status: 503, headers: { "cache-control": "no-store" } });
  const route = (method: "GET" | "POST" | "PUT"): Handler => async (request, context) => {
    if (!inngestAvailable()) return unavailable();
    const inngest = getInngest();
    handlers ??= serve({
      client: inngest,
      functions: [...functions(inngest)],
      ...(isLocalDev() ? {} : { enableUnauthedSync: false, serveOrigin: getServerEnv().NEXT_PUBLIC_APP_URL }),
    }) as unknown as typeof handlers & object;
    return handlers[method](request, context);
  };
  return { GET: route("GET"), POST: route("POST"), PUT: route("PUT") };
}
