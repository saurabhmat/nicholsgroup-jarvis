import "server-only";
// teams.activity (T-289, spec 9.2): turns an accepted Teams change notification (webhook/received, provider "microsoft", event type `teams_chats.changed`, queued by the Microsoft receiver after
// the clientState check, the stored-subscription lookup and the dedupe claim) into ONE write of "a notice arrived" for the connection: `comms.teams_activity_notice` (times and a capped counter).
//   - NO Graph call, no content: the notification never carried any (no resource data was asked for), and the receiver never read its `resource`. This function does not know which chat changed, and
//     the page does not either: it shows a dot, not a count.
//   - The event type is set by the receiver from OUR stored subscription row, never from the notification. Anything that is not exactly `teams_chats.changed` of provider "microsoft" is skipped
//     (so the mail and calendar events, which `microsoft-webhook-sync` handles, never reach the database here, and a Teams event never reaches that function: its pattern is `mail|calendar`).
//   - Events can reach Inngest without passing sendLaneEvent: validated again on receipt, nothing echoed. The lane must be one this deployment serves.
//   - The write is a step (it must not repeat on a replay); the database refuses a connection that is not a usable Teams connection of the lane (disconnected meanwhile): that is "dropped", not a failure.
//   - Idempotent enough: a repeated write only moves `last_notice_at` forward and raises a capped counter; the event id is deterministic, so Inngest drops a replayed event.
import type { Inngest, InngestFunction } from "inngest";
import { webhookReceived } from "./events";

export type TeamsActivityDeps = {
  /** Records one accepted notice. False: the database knows no usable Teams connection of this lane with this id (dropped). Throws for a failure worth a retry. */
  recordNotice: (laneId: string, connectionId: string) => Promise<boolean>;
  enabledLanes: () => readonly string[];
};

export const TEAMS_ACTIVITY_RETRIES = 3;
/** The one event type this function handles: the receiver's `${resource}.changed` for a `teams_chats` subscription row. */
export const TEAMS_ACTIVITY_EVENT_TYPE = "teams_chats.changed";

type StepApi = { run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T> };

export type TeamsActivityResult = { recorded: boolean; skipped: "invalid" | "not_microsoft" | "not_teams_notice" | "lane_not_served" | "not_usable" | null };

/** The function body without Inngest, for tests. `raw` is the event's data. */
export async function handleTeamsActivity(deps: TeamsActivityDeps, raw: unknown, step: StepApi): Promise<TeamsActivityResult> {
  const parsed = await webhookReceived.schema["~standard"].validate(raw);
  if (parsed.issues) return { recorded: false, skipped: "invalid" };
  const data = parsed.value;
  if (data.provider !== "microsoft") return { recorded: false, skipped: "not_microsoft" };
  if (data.eventType !== TEAMS_ACTIVITY_EVENT_TYPE) return { recorded: false, skipped: "not_teams_notice" };
  if (!deps.enabledLanes().includes(data.laneId)) return { recorded: false, skipped: "lane_not_served" };
  const recorded = await step.run(`notice:${data.laneId}:${data.connectionId}`, () => deps.recordNotice(data.laneId, data.connectionId));
  return recorded ? { recorded: true, skipped: null } : { recorded: false, skipped: "not_usable" };
}

export function teamsActivityFunctions(inngest: Inngest, deps: TeamsActivityDeps): InngestFunction.Any[] {
  const fn = inngest.createFunction({ id: "teams-activity", triggers: [webhookReceived], retries: TEAMS_ACTIVITY_RETRIES }, async ({ event, step }) =>
    handleTeamsActivity(deps, event.data, step as unknown as StepApi),
  );
  return [fn];
}
