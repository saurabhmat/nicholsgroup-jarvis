// Per-lane provider account settings (T-050; CLAUDE.md rule 2). The OAuth callback needs the QuickBooks realm a lane is
// configured for (`lane_config.qbo.realm_id`) to refuse a callback for another company file. The read uses the lane's
// job client (`lane_config_current` is service_role-readable) and takes only the one field it needs; nothing else of
// the config reaches connector code. A lane without `qbo` has no configured realm; a malformed one fails closed.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import type { JobClientFor } from "./tokens";

export interface LaneConfigReader {
  /** The realm id configured for the lane's QuickBooks file, or null when none is set. */
  qboRealmId(laneId: LaneId): Promise<string | null>;
  /** The mailboxes (lower-cased) the lane's mail connection may be, from `lane_config.mailboxes`; empty when none is set (T-063). */
  mailboxes(laneId: LaneId): Promise<string[]>;
  /** The lane policy's `retention_days` (how long metadata is kept); throws when the policy cannot be read (fail closed) (T-063). */
  retentionDays(laneId: LaneId): Promise<number>;
}

const LANE_ID = /^[A-Z]{1,8}$/;
const REALM = /^\d{1,20}$/;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export function createLaneConfigReader(clientFor: JobClientFor): LaneConfigReader {
  async function readConfig(laneId: LaneId): Promise<unknown> {
    if (typeof laneId !== "string" || !LANE_ID.test(laneId)) {
      throw new ConnectorError({ kind: "invalid_input", message: "A lane is required" });
    }
    let client: Awaited<ReturnType<JobClientFor>>;
    try {
      client = await clientFor(laneId);
    } catch {
      throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for configuration access" });
    }
    try {
      const { data, error } = await client.schema("core").from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle();
      if (error) throw error;
      return data?.config;
    } catch {
      throw new ConnectorError({ kind: "transient", message: "Lane configuration unavailable" });
    }
  }
  return {
    async retentionDays(laneId) {
      if (typeof laneId !== "string" || !LANE_ID.test(laneId)) throw new ConnectorError({ kind: "invalid_input", message: "A lane is required" });
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for policy access" });
      }
      let days: unknown;
      try {
        const { data, error } = await client.schema("core").from("lane_policies").select("retention_days").eq("lane_id", laneId).maybeSingle();
        if (error) throw error;
        days = data?.retention_days;
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Lane policy unavailable" });
      }
      if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650) {
        throw new ConnectorError({ kind: "connection_unavailable", message: "The lane's retention policy is missing or not valid" });
      }
      return days;
    },
    async mailboxes(laneId) {
      const config = await readConfig(laneId);
      const list = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).mailboxes : undefined;
      if (list === undefined || list === null) return [];
      if (!Array.isArray(list) || list.some((m) => typeof m !== "string" || !EMAIL.test(m))) {
        throw new ConnectorError({ kind: "provider_error", message: "The lane's configured mailboxes are not valid" });
      }
      return (list as string[]).map((m) => m.toLowerCase());
    },
    async qboRealmId(laneId) {
      const config = await readConfig(laneId);
      const qbo = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).qbo : undefined;
      if (qbo === undefined || qbo === null) return null;
      const realm = typeof qbo === "object" && !Array.isArray(qbo) ? (qbo as Record<string, unknown>).realm_id : undefined;
      if (typeof realm !== "string" || !REALM.test(realm)) {
        throw new ConnectorError({ kind: "provider_error", message: "The lane's configured QuickBooks realm is not valid" });
      }
      return realm;
    },
  };
}
