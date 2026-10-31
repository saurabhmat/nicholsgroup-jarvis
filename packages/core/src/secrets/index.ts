// Value-level credential detection shared by lane config (T-011) and audit redaction (T-015). It extends the env
// secret-pattern list with shapes that show up in data rather than env vars; core.jsonb_has_secret() mirrors it in SQL.
import { isSecretLikeValue } from "../env/secret-patterns";

const EXTRA_VALUE_PATTERNS: readonly RegExp[] = [
  /^eyJ[\w-]+\.[\w-]+\./, // any JWT (the env list flags only service-role JWTs)
  /^(bearer|basic)\s/i, // Authorization header values
  /^ya29\./, // Google OAuth access tokens
  /^glpat-/, // GitLab personal access tokens
  /[?&#](access_token|token|code|key|sig|signature)=/i, // URLs carrying a credential in the query or fragment
];

/** Surrounding whitespace, including zero-width characters and BOM, cannot hide a prefix. */
const strip = (v: string) => v.replace(/^[\s​﻿]+|[\s​﻿]+$/g, "");

export function looksLikeSecretValue(value: string): boolean {
  const v = strip(value);
  return isSecretLikeValue(v) || EXTRA_VALUE_PATTERNS.some((p) => p.test(v));
}
