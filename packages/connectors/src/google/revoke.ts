// Revoking a grant at Google's revocation endpoint (T-063). An external write (decided D-24: no exception to rule 5), so
// it is called only from the approvals-only writer (./writer.ts), never from the connector, the connect flow or a
// route. Never retried: a lost response is settled by asking again later, not by guessing.
import { isConnectorError } from "../contract/errors";
import type { HttpClient } from "../http/client";
import type { SecretValue } from "../vault/secret";

export async function revokeGoogleGrant({ http, path, token }: { http: HttpClient; path: string; token: SecretValue }): Promise<{ providerTid: string | null }> {
  const res = await http.request({
    method: "POST",
    path,
    body: new URLSearchParams({ token: token.reveal() }),
    retry: false,
  });
  return { providerTid: res.providerTid };
}

/**
 * Only a 400 `invalid_token` / `invalid_grant` means Google no longer knows the token (already revoked or expired). A
 * 401/403 can mean our own client is wrong and a 5xx or timeout means we do not know: neither is "already revoked".
 */
export function isAlreadyRevoked(e: unknown): boolean {
  return isConnectorError(e) && e.info.http_status === 400 && (e.info.provider_error_code === "invalid_token" || e.info.provider_error_code === "invalid_grant");
}
