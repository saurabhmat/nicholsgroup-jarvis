// Retention days per class for one lane (T-042). The lane policy (comms) and lane_config.retention (calendar,
// conversations, webhooks) are read separately: a bad lane_config does not stop the comms purge or the body purge.
import type { LaneId } from "@nichols/core";
import type { RetentionDays } from "./types";

export type RetentionSettingsReader = {
  retentionDays(laneId: LaneId): Promise<number>;
  retentionConfig(laneId: LaneId): Promise<{ calendarDays: number; conversationsDays: number; webhookDays: number }>;
};

export function retentionSettingsFrom(reader: RetentionSettingsReader): (laneId: LaneId) => Promise<Partial<RetentionDays>> {
  return async (laneId) => {
    const [comms, rest] = await Promise.all([
      reader.retentionDays(laneId).then((d): Partial<RetentionDays> => ({ comms: d }), (): Partial<RetentionDays> => ({})),
      reader
        .retentionConfig(laneId)
        .then((c): Partial<RetentionDays> => ({ calendar: c.calendarDays, conversations: c.conversationsDays, webhooks: c.webhookDays }), (): Partial<RetentionDays> => ({})),
    ]);
    return { ...comms, ...rest };
  };
}
