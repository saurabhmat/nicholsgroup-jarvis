// Revoking a grant at Intuit's revocation endpoint (QB-8, T-050). This is an external write (decided D-24: no exception
// to rule 5), so it is called only from the approvals-only writer (./writer.ts), never from the connector, the connect
// flow or a route. Never retried: a lost response is settled by asking again later, not by guessing.
import { isConnectorError } from "../contract/errors";
import { basicCredentials, type HttpClient } from "../http/client";
import type { SecretValue } from "../vault/secret";

export type RevokeInput = {
  /** A client for the revocation endpoint's origin. */
  http: HttpClient;
  /** The revocation endpoint from discovery. */
  revocation: string;
  client: { clientId: string; clientSecret: SecretValue };
  /** The refresh token (revoking it ends the whole grant) or, failing that, the access token. */
  token: SecretValue;
};

export async function revokeGrant({ http, revocation, client, token }: RevokeInput): Promise<{ providerTid: string | null }> {
  const url = new URL(revocation);
  const res = await http.request({
    method: "POST",
    path: url.pathname,
    body: { token: token.reveal() },
    auth: { scheme: "Basic", secret: basicCredentials(client.clientId, client.clientSecret) },
    retry: false,
  });
  return { providerTid: res.providerTid };
}

/**
 * Only a 400 `invalid_token` / `invalid_grant` means Intuit no longer knows the token (already revoked or expired).
 * A 401/403 can mean our own client credentials are wrong, and a 5xx or timeout means we do not know: neither is
 * "already revoked", so the caller must keep its copy of the tokens and report the failure.
 */
export function isAlreadyRevoked(e: unknown): boolean {
  return isConnectorError(e) && e.info.http_status === 400 && (e.info.provider_error_code === "invalid_token" || e.info.provider_error_code === "invalid_grant");
}
