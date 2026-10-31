import "server-only";
// Inngest client and route handlers (T-037, architecture §8). Import path: @nichols/core/inngest
// - getInngest(): the client, created on first use. Keys come from getInngestEnv() (only this module may read them,
//   T-003 lint). Dev mode (local Inngest dev server, no request signing) is on ONLY when APP_ENV=local.
// - inngestRoute(functions): GET/POST/PUT for app/api/inngest/route.ts. Outside local development, if the Inngest
//   keys are not configured, the route answers 503 instead of serving unsigned requests.
// Functions take `laneId` from their event and use the lane router's job client (JOB_RUNNERS lint list).
import { Inngest, type InngestFunction } from "inngest";
import { serve } from "inngest/next";
import { getInngestEnv, getServerEnv } from "../env/server";

export { actionApproved, connSyncRequested, LANE_EVENTS, laneIdSchema, systemHeartbeat } from "./events";
export { platformFunctions } from "./functions";

const APP_ID = "nichols-portal";
let client: Inngest | undefined;

export function getInngest(): Inngest {
  if (client) return client;
  const local = getServerEnv().APP_ENV === "local";
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
  return getServerEnv().APP_ENV === "local" || getInngestEnv().configured;
}

/**
 * Validates a lane event against its schema, then sends it. Always use this instead of `getInngest().send()`, so an
 * event without a valid `laneId` (or with unknown fields) never leaves the process.
 */
export async function sendLaneEvent(event: { name: string; data: { laneId: string }; validate(): Promise<void> }) {
  await event.validate(); // throws on a missing/invalid laneId or unknown fields
  return getInngest().send({ name: event.name, data: event.data });
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
    handlers ??= serve({ client: inngest, functions: [...functions(inngest)] }) as unknown as typeof handlers & object;
    return handlers[method](request, context);
  };
  return { GET: route("GET"), POST: route("POST"), PUT: route("PUT") };
}
