// The Composio connect flow (T-219; spec §8.2). Settings → Connections is the only caller (via handlers.ts); the chat
// never connects. Steps:
//
// start:    authorize (owner/admin_technical at aal2, by the caller) → the lane must have mailboxes configured (fail closed)
//           → `connectedAccounts.link(userId, authConfigId, { callbackUrl })` → the T-035 state (single use, bound by the
//           database to user + lane, and here also to the toolkit and the connected account id returned by link) → audited
//           → the Composio-hosted consent URL.
// callback: lane from the state → authorize again → consume the state → the account is the one stored at start (an id in
//           the URL that differs is refused) → `connectedAccounts.get` (ACTIVE, the toolkit we asked for) → read the
//           identity with an allow-listed read tool → the address must be one of `lane_config.mailboxes` → pending row →
//           security-definer activation (no token row) → audited.
//
// Results are coarse reason codes for the UI. A refusal after Composio holds an ACTIVE account leaves that account in
// place: deleting it is an external write and runs only through approvals (D-24), so the user is told to remove it in
// the Composio dashboard (the documented manual route) and, if wanted, the app's access in their Google account.
import type { LaneId } from "@nichols/core";
import { withAudit, type Audit } from "@nichols/core/audit";
import { ACCOUNT_IN_USE_MESSAGE, ConnectorError, isConnectorError } from "../contract/errors";
import { connectorLog, type ConnectorLogger } from "../log/index";
import type { AuthorizeFn, ConnectFailure } from "../oauth/flow";
import { hashState, laneOfState, newCodeVerifier, newState } from "../oauth/pkce";
import type { StateStore } from "../oauth/state";
import type { LaneConfigReader } from "../vault/lane-config";
import { COMPOSIO_CALLBACK_PATH, COMPOSIO_LINK_HOST, COMPOSIO_PROVIDER, TOOLKIT_SPECS, isToolkit, type Toolkit } from "./constants";
import { extractIdentity } from "./identity";
import { healthOf, type GuardedComposio } from "./port";
import type { ComposioConnectionStore } from "./store";

export type ComposioConnectDeps = {
  composio: GuardedComposio;
  states: StateStore;
  connections: ComposioConnectionStore;
  laneConfig: Pick<LaneConfigReader, "mailboxes">;
  /** The toolkit's auth config id from configuration, or null when not configured. Never hard-coded. */
  authConfigId(toolkit: Toolkit): string | null;
  /** The app origin the callback URL is built on (the app's own origin; https outside local). */
  appOrigin(): string;
  audit: Audit;
  random?: (n: number) => Buffer;
  logger?: ConnectorLogger;
};

export type ComposioCallbackResult =
  | { ok: true; laneId: LaneId; toolkit: Toolkit; connectionId: string }
  | { ok: false; reason: ConnectFailure; laneId?: LaneId; toolkit?: Toolkit; message?: string };

export const COMPOSIO_GRANT_NOT_STORED_MESSAGE =
  "Nothing was connected in Jarvis. The account may still exist in the Composio project and in your Google account's third-party access: remove it in the Composio dashboard (and at Google if you want), then try again.";

const OUTAGE_KINDS: ReadonlySet<string> = new Set(["transient", "rate_limited", "connection_unavailable", "timeout"]);

class Refused extends Error {
  override readonly name = "Refused";
  constructor(override readonly cause: unknown) {
    super("account refused");
  }
}

/** The configured toolkits, for the Settings page (booleans only: ids and the key never leave the server). */
export type ComposioAvailability = Record<Toolkit, boolean>;

export function createComposioConnect(deps: ComposioConnectDeps) {
  const log = () => (deps.logger ?? connectorLog).child({ provider: COMPOSIO_PROVIDER });

  async function mailboxes(laneId: LaneId): Promise<string[]> {
    const list = await deps.laneConfig.mailboxes(laneId);
    if (list.length === 0) throw new ConnectorError({ kind: "forbidden", message: "No mailboxes are configured for this lane" });
    return list;
  }

  return {
    /** The Composio-hosted consent URL. Throws AuthError (from `authorize`) or ConnectorError (`connection_unavailable` = not configured). */
    async start(toolkit: string, laneId: LaneId, authorize: AuthorizeFn): Promise<string> {
      if (!isToolkit(toolkit)) throw new ConnectorError({ kind: "not_found", message: "Unknown toolkit" });
      const { userId, client } = await authorize(laneId);
      const authConfigId = deps.authConfigId(toolkit);
      if (!authConfigId) throw new ConnectorError({ kind: "connection_unavailable", message: "This toolkit is not configured" });
      await mailboxes(laneId); // fail closed: a lane with no mailbox list never starts a connect
      const origin = deps.appOrigin();
      const state = newState(laneId, deps.random);
      const callbackUrl = `${origin}${COMPOSIO_CALLBACK_PATH}?state=${encodeURIComponent(state)}`;
      const { accountId, redirectUrl } = await deps.composio.link({ userId, authConfigId, callbackUrl });
      const link = URL.canParse(redirectUrl) ? new URL(redirectUrl) : null;
      if (!link || link.protocol !== "https:" || !COMPOSIO_LINK_HOST.test(link.hostname)) {
        throw new ConnectorError({ kind: "provider_error", message: "Composio returned a consent link that is not a Composio https address" });
      }
      // The PKCE verifier column is mandatory in the shared state table; Composio's flow has no code exchange, so it is
      // a fresh random value that is never used. The binding (toolkit + connected account) is what this flow checks.
      await deps.states.create(client, laneId, COMPOSIO_PROVIDER, hashState(state), newCodeVerifier(deps.random), `${origin}${COMPOSIO_CALLBACK_PATH}`, {
        toolkit,
        accountRef: accountId,
      });
      await deps.audit.log({
        laneId,
        actor: { kind: "user", userId },
        action: "connection.connect_started",
        target: `provider:${COMPOSIO_PROVIDER}`,
        metadata: { transport: "composio", toolkit },
      });
      return link.toString();
    },

    /** Finishes a connect from Composio's redirect. Authorization errors from `authorize` are rethrown; every other failure is a coarse result. */
    async callback(query: URLSearchParams, authorize: AuthorizeFn): Promise<ComposioCallbackResult> {
      const state = query.get("state");
      const laneId = laneOfState(state);
      if (!laneId || state === null) return { ok: false, reason: "invalid_state" };
      const { userId, client } = await authorize(laneId);

      let stored: Awaited<ReturnType<StateStore["consume"]>>;
      try {
        stored = await deps.states.consume(client, laneId, hashState(state));
      } catch {
        return { ok: false, reason: "unavailable", laneId };
      }
      if (!stored || stored.provider !== COMPOSIO_PROVIDER || !isToolkit(stored.toolkit) || !stored.accountRef) return { ok: false, reason: "invalid_state", laneId };
      const { toolkit, accountRef } = { toolkit: stored.toolkit, accountRef: stored.accountRef };
      const entry = { laneId, actor: { kind: "user" as const, userId }, action: "connection.connect", target: `provider:${COMPOSIO_PROVIDER}`, metadata: { transport: "composio", toolkit } };

      // An account id in the URL must be the one this connect created; anything else is a forged or replayed redirect.
      const urlAccount = query.get("connected_account_id");
      if (urlAccount !== null && urlAccount !== accountRef) return { ok: false, reason: "invalid_state", laneId, toolkit };
      // The user cancelled or Composio/Google refused at the consent screen.
      const status = query.get("status");
      if (query.get("error") !== null || (status !== null && status.toLowerCase() !== "success")) {
        await deps.audit.log({ ...entry, action: "connection.connect.failed", metadata: { ...entry.metadata, reason: "denied" } }).catch(() => undefined);
        return { ok: false, reason: "denied", laneId, toolkit };
      }

      let accountActive = false; // an ACTIVE account exists at Composio (see COMPOSIO_GRANT_NOT_STORED_MESSAGE)
      try {
        const connectionId = await withAudit(deps.audit, entry, async () => {
          const account = await call(() => deps.composio.getAccount(accountRef));
          if (healthOf(account) !== "active") throw new ExchangeIncomplete();
          accountActive = true;
          if (account.toolkitSlug !== toolkit) throw new Refused(new ConnectorError({ kind: "forbidden", message: "The Composio account is for a different toolkit" }));
          const allowed = await refuseOrOutage(() => mailboxes(laneId));
          const res = await call(() => deps.composio.execute(toolkit, TOOLKIT_SPECS[toolkit].identityTool, { userId, accountId: accountRef, arguments: {} }));
          const identity = res.successful ? extractIdentity(res.data) : null;
          if (!identity) throw new Refused(new ConnectorError({ kind: "forbidden", message: "The account address could not be read" }));
          if (!allowed.includes(identity)) throw new Refused(new ConnectorError({ kind: "forbidden", message: "This account is not one of the lane's configured mailboxes" }));
          const row = await refuseInUse(() => deps.connections.ensurePending(laneId, toolkit, accountRef, userId));
          await refuseInUse(() => deps.connections.activate(laneId, row.id, identity, userId));
          return row.id;
        });
        return { ok: true, laneId, toolkit, connectionId };
      } catch (e) {
        const reason: ConnectFailure = e instanceof Refused ? "account_refused" : e instanceof ExchangeIncomplete ? "exchange_failed" : "unavailable";
        const cause = e instanceof Refused ? e.cause : e;
        log().child({ laneId }).warn("connector.composio_callback_failed", { reason, toolkit, error: isConnectorError(cause) ? cause : { error_name: cause instanceof Error ? cause.name : typeof cause } });
        if (accountActive) {
          await deps.audit.log({ ...entry, action: "connection.connect.grant_not_stored", metadata: { ...entry.metadata, reason } }).catch(() => undefined);
          const inUse = isConnectorError(cause) && cause.info.message === ACCOUNT_IN_USE_MESSAGE;
          const message = inUse ? `This account is already connected to another company in Jarvis. ${COMPOSIO_GRANT_NOT_STORED_MESSAGE}` : COMPOSIO_GRANT_NOT_STORED_MESSAGE;
          return { ok: false, reason, laneId, toolkit, message };
        }
        return { ok: false, reason, laneId, toolkit };
      }
    },
  };

  /** Outage kinds pass through (the result is `unavailable`); anything else from the checks is a refusal of the account. */
  async function refuseOrOutage<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isConnectorError(e) && OUTAGE_KINDS.has(e.info.kind)) throw e;
      throw new Refused(e);
    }
  }
  /** A Composio call: an outage is `unavailable`; the account being unknown at Composio is an incomplete connect. */
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isConnectorError(e) && (e.info.kind === "not_found" || e.info.kind === "forbidden")) throw new ExchangeIncomplete();
      throw e;
    }
  }
  async function refuseInUse<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isConnectorError(e) && e.info.kind === "forbidden" && e.info.message === ACCOUNT_IN_USE_MESSAGE) throw new Refused(e);
      throw e;
    }
  }
}

class ExchangeIncomplete extends Error {
  override readonly name = "ExchangeIncomplete";
  constructor() {
    super("composio account not active");
  }
}
