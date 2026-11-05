// Secret-pattern list: the single source of truth for "this looks like a secret".
// PURE DATA MODULE: no imports, no side effects, no `server-only`. It is plain ESM JavaScript (with JSDoc types)
// so that an ESLint config running in Node (T-003) can import it without a TypeScript loader.
// Import path: @nichols/core/env/secret-patterns
//
// Rules of use:
//  - A NEXT_PUBLIC_* variable name must not match SECRET_NAME_PATTERNS, unless it is listed by exact name in
//    PUBLIC_BY_DESIGN_NAMES.
//  - A value that goes to the browser must not match SECRET_VALUE_PATTERNS.
// None of the patterns use the g or y flag, so `.test()` is stateless and safe to share.

/**
 * Case-insensitive patterns tested against an environment variable NAME.
 * @type {readonly RegExp[]}
 */
export const SECRET_NAME_PATTERNS = Object.freeze([
  /SECRET/i, // SUPABASE_SECRET_KEY, *_CLIENT_SECRET, STRIPE_WEBHOOK_SECRET
  /PRIVATE/i, // VAPID_PRIVATE_KEY, GHL_PRIVATE_INTEGRATION_TOKEN
  /TOKEN/i, // MONDAY_API_TOKEN, INTUIT_WEBHOOK_VERIFIER_TOKEN
  /PASS|PWD/i, // PASSWORD, PASSWD, PASS, PWD
  /SERVICE_ROLE/i, // legacy Supabase service-role key name
  /KEY/i, // *_API_KEY, SIGNING_KEY, EVENT_KEY, RESTRICTED_KEY; public keys are allowlisted by exact name below
  /SIGNING/i, // INNGEST_SIGNING_KEY
  /WEBHOOK/i, // webhook secrets and verifier tokens
  /RESTRICTED/i, // STRIPE_RESTRICTED_KEY
  /CREDENTIAL/i,
  /(^|_)AUTH(_|$)/i, // BASIC_AUTH, AUTH_TOKEN; token match so Vercel's ..._AUTHOR_LOGIN is not caught
  /SALT|HMAC|PEPPER/i,
  /JWT/i,
  /BEARER/i,
  /CERT/i,
  /POSTGRES|REDIS|MONGO/i, // datastore connection details
  /DATABASE_URL|DB_URL/i, // connection strings embed the password
  /CONNECTION_STRING|_URI$/i,
  /DSN$/i, // DSNs can embed credentials; the Sentry DSN is allowlisted below
]);

/**
 * Exact names that are public by design and may carry NEXT_PUBLIC_ even though they match a pattern above.
 * Keep this list NARROW: add a name only with a comment saying why it is safe in a browser.
 * @type {readonly string[]}
 */
export const PUBLIC_BY_DESIGN_NAMES = Object.freeze([
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", // sb_publishable_: designed for browsers, access is governed by RLS
  "NEXT_PUBLIC_VAPID_PUBLIC_KEY", // web-push public key: the browser needs it to subscribe
  "NEXT_PUBLIC_SENTRY_DSN", // Sentry DSNs are write-only ingest endpoints, designed for browser SDKs
]);

/**
 * Vercel-owned system variables whose VALUES are free text chosen by developers (commit message, branch, author,
 * repo). They are exempt from the VALUE scan only (a commit message "re_fix: typo" is not a Resend key). Exact
 * names, no prefix exemption: their NAMES are still checked, and so is every other NEXT_PUBLIC_VERCEL_* name.
 * @type {readonly string[]}
 */
export const FREE_TEXT_VALUE_NAMES = Object.freeze([
  "NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE",
  "NEXT_PUBLIC_VERCEL_GIT_COMMIT_AUTHOR_NAME",
  "NEXT_PUBLIC_VERCEL_GIT_COMMIT_AUTHOR_LOGIN",
  "NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF",
  "NEXT_PUBLIC_VERCEL_GIT_REPO_SLUG",
  "NEXT_PUBLIC_VERCEL_GIT_REPO_OWNER",
]);

/**
 * Patterns tested against a VALUE (case-sensitive: these are vendor prefixes).
 * @type {readonly RegExp[]}
 */
export const SECRET_VALUE_PATTERNS = Object.freeze([
  /^sb_secret_/, // Supabase secret key
  /^(sk|rk)_/, // Stripe secret / restricted keys (live and test)
  /^whsec_/, // Stripe webhook signing secret
  /^sk-ant-/, // Anthropic API key
  /^(ghp|gho|ghs|github_pat)_/, // GitHub tokens
  /^xox[abprs]-/, // Slack tokens
  /^signkey-/, // Inngest signing key
  /^GOCSPX-/, // Google OAuth client secret
  /^re_[A-Za-z0-9]/, // Resend API key
  /^sntry[a-z]_/, // Sentry auth tokens
  /^(ntn|secret)_/, // Notion integration tokens
  /^pit-/, // GoHighLevel private integration tokens
  /^AKIA[0-9A-Z]{16}/, // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private keys
  /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]+@/, // any URL whose userinfo carries a password
]);

/**
 * True for a JWT whose payload says role=service_role (Supabase legacy service key). Never throws.
 * @param {string} value
 * @returns {boolean}
 */
function isServiceRoleJwt(value) {
  if (!/^eyJ[\w-]+\.[\w-]+\./.test(value)) return false;
  try {
    const payload = value.split(".")[1] ?? "";
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && parsed.role === "service_role";
  } catch {
    return false;
  }
}

/**
 * True when the name is a NEXT_PUBLIC_* name that must not be exposed: it matches a secret pattern and is not
 * allowlisted. (Name-only check; the NEXT_PUBLIC_ prefix itself is enforced by the client schema test.)
 * @param {string} name
 * @returns {boolean}
 */
export function isSecretLikeName(name) {
  if (PUBLIC_BY_DESIGN_NAMES.includes(name)) return false;
  return SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Value check. Surrounding whitespace is ignored so it cannot defeat the anchored patterns.
 * @param {string} value
 * @returns {boolean}
 */
export function isSecretLikeValue(value) {
  const v = value.trim();
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(v)) || isServiceRoleJwt(v);
}
