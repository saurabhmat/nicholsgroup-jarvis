// The id_token of a Microsoft code exchange (T-066, spec §7 step 4; decision V-6 in docs/plan-review.md, "T-066: spec §15 verify items").
//
// The token is received DIRECTLY from the token endpoint, over TLS, from a host on the allow-list, in answer to a request that carried
// our client secret and the PKCE verifier. OpenID Connect Core 1.0 §3.1.3.7 rule 6 lets the client rely on that TLS validation instead of
// checking the signature, so this code checks NO signature (no JWT library, no key fetch) and does not call the token "verified". It
// refuses the grant unless ALL of these hold:
//   - `tid` is a lower-case GUID, is not a non-organisation tenant (personal accounts), and is in the lane's `tenant_ids`;
//   - `iss` is the v2.0 issuer of that same `tid`;
//   - `aud` is our client id;
//   - `exp` is in the future;
//   - `nonce` is the one this connect sent.
// Only `tid` leaves this function. The mailbox address is NEVER taken from the token (`preferred_username` and `email` are not
// authorization data, V-6); it comes from Graph `GET /me`. Nothing from the token appears in an error: messages are fixed.
import { z } from "zod";
import { issuerFor, isTenantId, NON_ORGANISATION_TENANTS, type MicrosoftCloud } from "./constants";

/** Why a token was refused. `wrong_tenant` is the user-facing result for a tenant that is not the lane's; the rest are `account_refused`. */
export type IdTokenFailure = "wrong_tenant" | "invalid";

export class IdTokenRefused extends Error {
  override readonly name = "IdTokenRefused";
  constructor(readonly failure: IdTokenFailure) {
    super(failure === "wrong_tenant" ? "The id_token is for a tenant that is not allowed for this company" : "The id_token is not acceptable");
  }
}

const MAX_TOKEN_CHARS = 16_384;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const ClaimsSchema = z.looseObject({
  tid: z.string().max(64),
  iss: z.string().max(512),
  aud: z.string().max(256),
  exp: z.number().finite(),
  nonce: z.string().max(256),
});

export type IdTokenCheck = {
  cloud: MicrosoftCloud;
  /** The lane's `microsoft.tenant_ids`. */
  tenantIds: readonly string[];
  clientId: string;
  /** The nonce sent on the authorize request. */
  nonce: string;
  /** Milliseconds since the epoch. */
  now: number;
};

const invalid = () => new IdTokenRefused("invalid");

/** Returns the tenant (`tid`) of the signed-in account; throws `IdTokenRefused` for anything else. */
export function checkIdToken(idToken: unknown, check: IdTokenCheck): { tenantId: string } {
  if (typeof idToken !== "string" || idToken.length === 0 || idToken.length > MAX_TOKEN_CHARS) throw invalid();
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts.every((p) => p.length > 0 && BASE64URL.test(p))) throw invalid();
  let claims: z.infer<typeof ClaimsSchema>;
  try {
    const parsed = ClaimsSchema.safeParse(JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8")));
    if (!parsed.success) throw new Error("shape");
    claims = parsed.data;
  } catch {
    throw invalid();
  }
  const tid = claims.tid;
  if (!isTenantId(tid)) throw invalid(); // not a lower-case GUID: malformed, never matched case-insensitively
  if (NON_ORGANISATION_TENANTS.has(tid)) throw new IdTokenRefused("wrong_tenant");
  if (!check.tenantIds.some((t) => t.toLowerCase() === tid)) throw new IdTokenRefused("wrong_tenant");
  // The remaining checks come after the tenant one only so that a token for another tenant is reported as such; each refuses on its own.
  if (claims.iss !== issuerFor(check.cloud, tid)) throw invalid();
  if (claims.aud !== check.clientId) throw invalid();
  if (!(claims.exp * 1000 > check.now)) throw invalid();
  if (check.nonce === "" || claims.nonce !== check.nonce) throw invalid();
  return { tenantId: tid };
}
