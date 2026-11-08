// The narrow Composio surface the connector uses (T-219), and the guard that puts the allow-list in front of it.
// `ComposioPort` is what tests fake; `createSdkPort` (sdk.ts) is the only code that imports `@composio/core`.
import { ConnectorError } from "../contract/errors";
import { assertAllowedSlug } from "./allowlist";
import { CONNECTED_ACCOUNT_ID, type Toolkit } from "./constants";

export type ComposioAccountStatus = "INITIALIZING" | "INITIATED" | "ACTIVE" | "FAILED" | "EXPIRED" | "INACTIVE" | "REVOKED";

export type ComposioAccount = {
  id: string;
  status: ComposioAccountStatus;
  toolkitSlug: string;
  isDisabled: boolean;
};

export interface ComposioPort {
  /** `connectedAccounts.link(userId, authConfigId, { callbackUrl })`: a connected account in INITIATED state and the hosted consent URL. */
  link(input: { userId: string; authConfigId: string; callbackUrl: string }): Promise<{ accountId: string; redirectUrl: string }>;
  /** `connectedAccounts.get(id)`: status and toolkit only (credentials are never read). */
  getAccount(accountId: string): Promise<ComposioAccount>;
  /** `tools.execute`; callers go through `GuardedComposio`, which checks the allow-list first. */
  execute(input: { slug: string; userId: string; accountId: string; arguments: Readonly<Record<string, unknown>> }): Promise<{ successful: boolean; data: Record<string, unknown> }>;
}

/** What the rest of the connector calls: every execute is allow-list checked before the port (and so the network). */
export interface GuardedComposio {
  link: ComposioPort["link"];
  getAccount: ComposioPort["getAccount"];
  execute(toolkit: Toolkit, slug: string, input: { userId: string; accountId: string; arguments: Readonly<Record<string, unknown>> }): Promise<{ successful: boolean; data: Record<string, unknown> }>;
}

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Composio `userId` is the Jarvis user UUID: never an email address, never "default" (spec §8.6). */
export function assertUserId(userId: string): void {
  if (typeof userId !== "string" || !USER_ID.test(userId)) throw new ConnectorError({ kind: "invalid_input", message: "A Composio user id must be a Jarvis user UUID" });
}

export function assertAccountId(accountId: string): void {
  if (typeof accountId !== "string" || !CONNECTED_ACCOUNT_ID.test(accountId)) throw new ConnectorError({ kind: "invalid_input", message: "The Composio account id is not valid" });
}

export function guardComposio(port: ComposioPort): GuardedComposio {
  return {
    async link(input) {
      assertUserId(input.userId);
      return port.link(input);
    },
    async getAccount(accountId) {
      assertAccountId(accountId);
      return port.getAccount(accountId);
    },
    async execute(toolkit, slug, input) {
      assertAllowedSlug(toolkit, slug); // before anything else: a refused slug never reaches the SDK
      assertUserId(input.userId);
      assertAccountId(input.accountId);
      return port.execute({ slug, userId: input.userId, accountId: input.accountId, arguments: input.arguments });
    },
  };
}

/** Health of a connection from the account status: usable, needs a reconnect, or not finished. */
export function healthOf(account: Pick<ComposioAccount, "status" | "isDisabled">): "active" | "reconnect_required" | "pending" {
  if (account.isDisabled) return "reconnect_required";
  switch (account.status) {
    case "ACTIVE":
      return "active";
    case "INITIALIZING":
    case "INITIATED":
      return "pending";
    default:
      return "reconnect_required"; // EXPIRED, REVOKED, FAILED, INACTIVE
  }
}
