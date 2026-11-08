// The only file that imports `@composio/core` (VENDORS: this folder only; the dependency is pinned exactly in package.json).
// Maps the SDK to `ComposioPort`: explicit apiKey and baseURL (no environment fallbacks), tracking off, toolkit versions
// pinned, no npm version-check call (disableVersionCheck), a timeout on every call, and SDK errors reduced to coarse ConnectorErrors (SDK messages can echo request data).
import { Composio } from "@composio/core";
import { ConnectorError } from "../contract/errors";
import { connectorLog, type ConnectorLogger } from "../log/index";
import type { SecretValue } from "../vault/secret";
import { COMPOSIO_BASE_URL, COMPOSIO_TIMEOUT_MS, TOOLKIT_VERSIONS } from "./constants";
import type { ComposioAccount, ComposioAccountStatus, ComposioPort } from "./port";

const STATUSES: readonly string[] = ["INITIALIZING", "INITIATED", "ACTIVE", "FAILED", "EXPIRED", "INACTIVE", "REVOKED"];

function mapError(e: unknown): ConnectorError {
  if (e instanceof ConnectorError) return e;
  const name = e instanceof Error ? e.name : "";
  const status = typeof (e as { status?: unknown } | null)?.status === "number" ? ((e as { status: number }).status) : undefined;
  if (/abort|timeout|cancel/i.test(name)) return new ConnectorError({ kind: "timeout", message: "Composio did not answer in time" });
  if (status === 401 || status === 403) return new ConnectorError({ kind: "connection_unavailable", message: "Composio refused the project credentials" });
  if (status === 404) return new ConnectorError({ kind: "not_found", message: "Composio does not know this account" });
  if (status === 429) return new ConnectorError({ kind: "rate_limited", message: "Composio rate limit" });
  return new ConnectorError({ kind: "transient", message: "Composio is unavailable" });
}

export function createSdkPort(deps: { apiKey: () => SecretValue; logger?: ConnectorLogger; timeoutMs?: number }): ComposioPort {
  let client: Composio | undefined;
  const sdk = (): Composio => {
    // `reveal` of the project key happens here only, once, into the SDK constructor.
    client ??= new Composio({ apiKey: deps.apiKey().reveal(), baseURL: COMPOSIO_BASE_URL, allowTracking: false, disableVersionCheck: true, toolkitVersions: { ...TOOLKIT_VERSIONS } });
    return client;
  };
  const signal = () => AbortSignal.timeout(deps.timeoutMs ?? COMPOSIO_TIMEOUT_MS);
  const log = (event: string, fields: Record<string, unknown>) => (deps.logger ?? connectorLog).child({ provider: "composio" }).info(event, fields);

  return {
    async link({ userId, authConfigId, callbackUrl }) {
      try {
        const req = await sdk().connectedAccounts.link(userId, authConfigId, { callbackUrl, allowMultiple: true }, { signal: signal() });
        if (typeof req.id !== "string" || typeof req.redirectUrl !== "string" || req.redirectUrl === "") {
          throw new ConnectorError({ kind: "provider_error", message: "Composio returned no consent link" });
        }
        log("composio.link", {});
        return { accountId: req.id, redirectUrl: req.redirectUrl };
      } catch (e) {
        throw mapError(e);
      }
    },
    async getAccount(accountId): Promise<ComposioAccount> {
      try {
        const a = await sdk().connectedAccounts.get(accountId, { signal: signal() });
        if (!STATUSES.includes(a.status)) throw new ConnectorError({ kind: "provider_error", message: "Composio returned an unknown account status" });
        return { id: a.id, status: a.status as ComposioAccountStatus, toolkitSlug: String(a.toolkit?.slug ?? ""), isDisabled: a.isDisabled === true };
      } catch (e) {
        throw mapError(e);
      }
    },
    async execute({ slug, userId, accountId, arguments: args }) {
      try {
        const res = await sdk().tools.execute(slug, { userId, connectedAccountId: accountId, arguments: { ...args } }, { signal: signal() });
        log("composio.execute", { slug, successful: res.successful }); // the slug only: never arguments or results
        return { successful: res.successful === true, data: res.data ?? {} };
      } catch (e) {
        throw mapError(e);
      }
    },
  };
}
