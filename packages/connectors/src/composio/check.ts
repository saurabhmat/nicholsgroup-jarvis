// Settings → Connections "Test" for a Composio account (T-219; spec §8.2): a read-only identity check plus one page
// read, reduced to a status and a time. Nothing from the account (address, subjects, event titles, counts) is returned
// or stored; the page read's result is dropped. The account status also refreshes the connection's health: EXPIRED,
// REVOKED, FAILED, INACTIVE or disabled → `reconnect_required` (T-040 semantics); ACTIVE again → `active`.
// Everything is a read through the allow-list; the only write is our own `core.connections.status`.
import type { LaneId } from "@nichols/core";
import { isConnectorError } from "../contract/errors";
import type { LaneConfigReader } from "../vault/lane-config";
import { TOOLKIT_SPECS, type Toolkit } from "./constants";
import { extractIdentity } from "./identity";
import { healthOf, type GuardedComposio } from "./port";
import type { ComposioConnectionStore } from "./store";

export type ComposioCheckStatus = "ok" | "reconnect_required" | "not_connected" | "mailbox_not_allowed" | "error";
export type ComposioCheck = { status: ComposioCheckStatus; checked_at: string };

export type ComposioCheckDeps = {
  composio: GuardedComposio;
  connections: ComposioConnectionStore;
  laneConfig: Pick<LaneConfigReader, "mailboxes">;
  now?: () => number;
};

export function createComposioCheck(deps: ComposioCheckDeps): (laneId: LaneId, toolkit: Toolkit) => Promise<ComposioCheck> {
  const now = deps.now ?? Date.now;
  return async (laneId, toolkit) => {
    const done = (status: ComposioCheckStatus): ComposioCheck => ({ status, checked_at: new Date(now()).toISOString() });
    try {
      const conn = await deps.connections.find(laneId, toolkit);
      if (!conn || conn.status === "pending" || !conn.createdBy) return done("not_connected");

      // The Composio account status first: an expired or revoked account is the one thing the user must act on.
      const account = await deps.composio.getAccount(conn.accountId);
      const health = healthOf(account);
      if (health === "reconnect_required") {
        await deps.connections.setHealth(laneId, conn, "reconnect_required");
        return done("reconnect_required");
      }
      if (health === "pending") return done("not_connected");
      if (account.toolkitSlug !== toolkit) return done("error");

      // The mailbox is re-checked against lane_config on every call (fail closed).
      const mailboxes = await deps.laneConfig.mailboxes(laneId);
      if (!conn.identity || !mailboxes.includes(conn.identity)) return done("mailbox_not_allowed");

      const spec = TOOLKIT_SPECS[toolkit];
      const who = await deps.composio.execute(toolkit, spec.identityTool, { userId: conn.createdBy, accountId: conn.accountId, arguments: {} });
      if (!who.successful || extractIdentity(who.data) !== conn.identity) return done("error");
      const page = await deps.composio.execute(toolkit, spec.testTool, { userId: conn.createdBy, accountId: conn.accountId, arguments: spec.testArguments });
      if (!page.successful) return done("error");

      if (conn.status === "reconnect_required") await deps.connections.setHealth(laneId, conn, "active");
      return done("ok");
    } catch (e) {
      if (isConnectorError(e) && e.info.kind === "reconnect_required") return done("reconnect_required");
      return done("error");
    }
  };
}
