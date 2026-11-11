// The lane policy's write permissions as the connect flow needs them (T-232). `core.lane_policies.write_actions_allowed`
// lists what the lane may ever write through approvals (PKG production: none). Only whether email writes are allowed
// reaches connector code; the read uses the lane's job client and fails closed (a policy that cannot be read is an error,
// never "allowed").
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import type { JobClientFor } from "./tokens";

export interface WritePolicyReader {
  /** True when `write_actions_allowed` contains `email_send` or `email_draft`; throws when the policy cannot be read. */
  emailWritesAllowed(laneId: LaneId): Promise<boolean>;
}

const LANE_ID = /^[A-Z]{1,8}$/;

export function createWritePolicyReader(clientFor: JobClientFor): WritePolicyReader {
  return {
    async emailWritesAllowed(laneId) {
      if (typeof laneId !== "string" || !LANE_ID.test(laneId)) throw new ConnectorError({ kind: "invalid_input", message: "A lane is required" });
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for policy access" });
      }
      let allowed: unknown;
      try {
        const { data, error } = await client.schema("core").from("lane_policies").select("write_actions_allowed").eq("lane_id", laneId).maybeSingle();
        if (error) throw error;
        allowed = data?.write_actions_allowed;
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Lane policy unavailable" });
      }
      if (!Array.isArray(allowed)) throw new ConnectorError({ kind: "connection_unavailable", message: "The lane's write policy is missing or not valid" });
      return allowed.includes("email_send") || allowed.includes("email_draft");
    },
  };
}

export interface ActionClaimReader {
  /**
   * True only when the approvals database has this action executing with an open claim, the given approved hash and the
   * recorded approver (core.act_claim_open, service_role). Any read error is "no" (fails closed).
   */
  claimOpen(laneId: LaneId, actionId: string, hash: string, approvedBy: string): Promise<boolean>;
}

export function createActionClaimReader(clientFor: JobClientFor): ActionClaimReader {
  return {
    async claimOpen(laneId, actionId, hash, approvedBy) {
      if (typeof laneId !== "string" || !LANE_ID.test(laneId)) return false;
      try {
        const client = await clientFor(laneId);
        const { data, error } = await client.schema("core").rpc("act_claim_open", { p_lane: laneId, p_id: actionId, p_hash: hash, p_approver: approvedBy });
        return !error && data === true;
      } catch {
        return false;
      }
    },
  };
}
