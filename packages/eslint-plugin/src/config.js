// The shared flat-config fragment. Paths are repo-relative and resolved against `root` (settings.nichols.root),
// so the same fragment works from the root config and from apps/web's own config.
//
// Decisions (architecture section 10, CLAUDE.md rules 1, 4, 5; each path below is a deliberate, reviewable choice):
//  - Vendor SDKs, raw network modules and HTTP clients: packages/connectors only. `@anthropic-ai/*` is packages/ai
//    only (backlog T-100: Anthropic implementation via packages/ai). Inngest is platform job infrastructure, not an
//    external data API, so the SDK itself is not restricted; its env accessor is (INNGEST_CLIENT below).
//  - DB drivers and every `@supabase/*` import: the lane router, plus the auth-session locations T-018 will use
//    (packages/core/src/auth and apps/web/proxy.ts). `import type` is allowed everywhere. T-018 may change
//    AUTH_SESSION deliberately; nothing else should.
//  - The Supabase secret key accessor: lane router, the connector token vault (packages/connectors/src/vault, the path
//    T-032/T-033 must use) and packages/core/src/env.
//  - Inngest client location: packages/core/src/inngest (client + event schemas, T-037) and the route handler.
//  - Connector tokens (T-033): the token functions are used only inside packages/connectors; the Vault itself (SQL
//    names) only in the token vault (packages/connectors/src/vault) and the generated DB types; the internal contract
//    subpath (`@nichols/connectors/internal`: mint, schema builder) only inside packages/connectors, where the
//    connection loader also lives (packages/connectors/src/vault). The secret registry (`rememberSecret`,
//    `scrubKnownSecrets`) stays in the token vault and the connector logger. Relative imports cannot reach into
//    another package's sources (no-cross-package-relative), so these boundaries cannot be skipped with `../../`.
import { fileURLToPath } from "node:url";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import { noCrossPackageRelative } from "./rules/no-cross-package-relative.js";
import { noEnvResultCopy } from "./rules/no-env-result-copy.js";
import { noExternalFetch } from "./rules/no-external-fetch.js";
import { noFreeTextEnvRead } from "./rules/no-free-text-env-read.js";
import { noProcessEnv } from "./rules/no-process-env.js";
import { noPublicSecretName } from "./rules/no-public-secret-name.js";
import { noRestrictedNames } from "./rules/no-restricted-names.js";
import { noServerSecretInClient } from "./rules/no-server-secret-in-client.js";
import { noSupabaseSecret } from "./rules/no-supabase-secret.js";
import { noTestOnlyImport } from "./rules/no-test-only-import.js";
import { noVaultAccess } from "./rules/no-vault-access.js";
import { noVendorSdk } from "./rules/no-vendor-sdk.js";
import { noWriteSubpathImport } from "./rules/no-write-subpath-import.js";

export const plugin = {
  meta: { name: "@nichols/eslint-plugin", version: "0.1.0" },
  rules: {
    "no-vendor-sdk": noVendorSdk,
    "no-external-fetch": noExternalFetch,
    "no-restricted-names": noRestrictedNames,
    "no-supabase-secret": noSupabaseSecret,
    "no-server-secret-in-client": noServerSecretInClient,
    "no-public-secret-name": noPublicSecretName,
    "no-env-result-copy": noEnvResultCopy,
    "no-free-text-env-read": noFreeTextEnvRead,
    "no-process-env": noProcessEnv,
    "no-vault-access": noVaultAccess,
    "no-cross-package-relative": noCrossPackageRelative,
    "no-test-only-import": noTestOnlyImport,
    "no-write-subpath-import": noWriteSubpathImport,
  },
};

export const CONNECTORS = ["packages/connectors"];
export const AI = ["packages/ai"];
export const APPROVALS = ["packages/modules/approvals"];
export const LANE_ROUTER = ["packages/core/src/lane-router"];
export const CORE_ENV = ["packages/core/src/env"];
export const TOKEN_VAULT = ["packages/connectors/src/vault"];
export const CONNECTOR_LOG = ["packages/connectors/src/log"];
export const AUTH_SESSION = ["packages/core/src/auth", "apps/web/proxy.ts"];
export const INNGEST_CLIENT = ["packages/core/src/inngest", "apps/web/app/api/inngest"];
export const SCRIPTS = ["scripts", "apps/web/scripts"];
/**
 * Where the Vault and the token functions may be named: the token vault, the generated DB types (type keys), and this
 * plugin's own sources (the rule and its fixtures spell the names out on purpose).
 */
export const VAULT_NAMES_ALLOWED = [...TOKEN_VAULT, "packages/core/src/db/types.ts", "packages/eslint-plugin/src"];
/**
 * Code that may use the RLS-bypassing job client (T-016 review H1): the Inngest client and route, the approvals
 * executor and the token vault. Module jobs join this list deliberately (reviewed) when they are written.
 */
export const JOB_RUNNERS = [...INNGEST_CLIENT, ...APPROVALS, ...TOKEN_VAULT];
/** The connectors' write side (rule 5): only the approvals module imports it, by package name or by relative path. */
export const WRITE_SUBPATHS = ["@nichols/connectors/write"];
export const WRITE_DIRS = ["packages/connectors/src/write", "packages/connectors/dist/write"];
/** Test harness modules: test files only (T-034), plus the harness's own sources. */
export const TEST_ONLY_MODULES = ["msw", "@nichols/connectors/testing"];
export const TEST_HARNESS = ["packages/connectors/src/testing"];
/** Files that may read process.env (besides test files and vitest configs). */
export const PROCESS_ENV_ALLOWED = [
  ...CORE_ENV,
  "apps/web/next.config.ts",
  "apps/web/instrumentation.ts",
  "apps/web/app/env-check.ts",
  ...SCRIPTS,
];

const DB_PATHS = [...LANE_ROUTER, ...AUTH_SESSION];
const DB_DRIVERS = Object.fromEntries(
  ["@supabase/*", "pg", "postgres", "kysely", "drizzle-orm", "@neondatabase/*", "mysql2", "better-sqlite3"].map((p) => [p, DB_PATHS]),
);

/** Vendor SDK, network-module and HTTP-client patterns that only packages/connectors may import. */
export const CONNECTOR_ONLY = [
  "stripe",
  "@stripe/*",
  "googleapis",
  "@googleapis/*",
  "google-auth-library",
  "@google-cloud/*",
  "@microsoft/microsoft-graph-client",
  "@azure/msal-node",
  "@azure/identity",
  "intuit-oauth",
  "node-quickbooks",
  "@notionhq/client",
  "@mondaydotcomorg/*",
  "monday-sdk-js",
  "resend",
  "@gohighlevel/*",
  "openai",
  "twilio",
  "nodemailer",
  "@sendgrid/*",
  "@slack/*",
  "web-push",
  "plaid",
  "voyageai",
  "graphql-request",
  // raw HTTP clients and sockets: same rule as fetch
  "axios",
  "got",
  "ky",
  "undici",
  "superagent",
  "node-fetch",
  "ws",
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
];

/** Pattern -> path prefixes that may import it (a deny list, second layer behind the dependency allow-list test). */
export const VENDORS = {
  ...Object.fromEntries(CONNECTOR_ONLY.map((pattern) => [pattern, CONNECTORS])),
  child_process: [...CONNECTORS, ...SCRIPTS],
  "@anthropic-ai/*": AI,
  "@nichols/connectors/internal": CONNECTORS, // mint + schema builder: connector implementations and the loader (T-033)
  inngest: INNGEST_CLIENT, // the SDK reads INNGEST_* from process.env itself (T-037 review L1)
  ...DB_DRIVERS,
};

/** Patterns whose `import type` is erased at build time and therefore allowed everywhere. */
export const TYPE_IMPORTS_ALLOWED = [...Object.keys(DB_DRIVERS), "inngest"];

/** Restricted names: where each may be used (see rules/no-restricted-names.js). */
export const RESTRICTED_NAMES = {
  executeWrite: { allow: APPROVALS, allowReexport: CONNECTORS, hint: "only the approvals package executes writes" },
  mintApprovedAction: { allow: APPROVALS, hint: "only the approvals package mints approved actions" },
  getSupabaseSecretKey: { allow: [...LANE_ROUTER, ...TOKEN_VAULT, ...CORE_ENV], hint: "lane router and token vault only" },
  getLaneJobClient: { allow: [...LANE_ROUTER, ...JOB_RUNNERS], hint: "the service client bypasses RLS: jobs, approvals executor and token vault only; request code uses getLaneClient / requireLane" },
  createLaneRouter: { allow: LANE_ROUTER, hint: "use getLaneClient / requireLane; client factories are internal to the lane router" },
  defaultClientFactory: { allow: LANE_ROUTER, hint: "internal to the lane router" },
  parseServerEnv: { allow: CORE_ENV, hint: "returns unredacted secrets; use the accessors in @nichols/core/env/server" },
  parseConnectorEnv: { allow: CORE_ENV, hint: "use requireConnectorEnv (redacted, fails closed)" },
  runtimeFlags: { allow: CORE_ENV, hint: "internal to packages/core/src/env" },
  requireConnectorEnv: { allow: [...CONNECTORS, ...CORE_ENV], hint: "connector credentials are read inside packages/connectors" },
  getAnthropicEnv: { allow: [...AI, ...CORE_ENV], hint: "the Anthropic key is read inside packages/ai" },
  getInngestEnv: { allow: [...INNGEST_CLIENT, ...CORE_ENV], hint: "the Inngest keys are read by the Inngest client only" },
  getInngest: { allow: INNGEST_CLIENT, hint: "send events with sendLaneEvent (validated, lane-checked)" },
  getToken: { allow: CONNECTORS, hint: "connector tokens are read only inside packages/connectors" },
  storeToken: { allow: CONNECTORS, hint: "connector tokens are written only inside packages/connectors" },
  rotateToken: { allow: CONNECTORS, hint: "connector tokens are written only inside packages/connectors" },
  revokeToken: { allow: CONNECTORS, hint: "connector tokens are deleted only inside packages/connectors" },
  createTokenVault: { allow: TOKEN_VAULT, hint: "internal to the token vault; use getToken" },
  reveal: { allow: CONNECTORS, hint: "a SecretValue is revealed only inside packages/connectors (HTTP client, token refresh)" },
  rememberSecret: { allow: TOKEN_VAULT, hint: "SecretValue registers credentials itself" },
  scrubKnownSecrets: { allow: [...TOKEN_VAULT, ...CONNECTOR_LOG], hint: "use redactText from @nichols/connectors/redact" },
  forgetSecretsForTests: {
    allow: [...TOKEN_VAULT, "packages/connectors/src/http/client.test.ts", "packages/connectors/src/oauth/flow.test.ts"],
    hint: "clearing the registry switches off exact-match redaction; vault tests only",
  },
  mintLaneBoundConnection: { allow: CONNECTORS, hint: "connections are minted by the connection loader; use loadConnection" },
  buildProviderSchemas: { allow: CONNECTORS, hint: "internal to the connector contract" },
  connectionLoader: { allow: CONNECTORS, hint: "it reads with the RLS-bypassing job client; ask a connector" },
  createConnectionLoader: { allow: TOKEN_VAULT, hint: "internal to the token vault; use connectionLoader inside packages/connectors" },
  connectionStore: { allow: CONNECTORS, hint: "it writes connection rows with the job client; the OAuth callback uses it (T-035)" },
  rawRecords: { allow: CONNECTORS, hint: "it writes raw provider payloads with the job client; connectors store records through their sync sink (T-039)" },
  createRawRecordStore: { allow: ["packages/connectors/src/raw", ...TOKEN_VAULT], hint: "internal to the raw record store; use rawRecords inside packages/connectors" },
  createConnectionStore: { allow: TOKEN_VAULT, hint: "internal to the token vault; use connectionStore inside packages/connectors" },
};

/** Files where no-public-secret-name is off: negative corpora that deliberately spell out secret-looking names. */
export const PUBLIC_SECRET_NAME_EXEMPT_FILES = ["packages/core/src/env/**/*.test.ts", "packages/eslint-plugin/src/**/*.test.js"];

/**
 * @param {{ root: string | URL }} options `root` is the repo root (directory of the root eslint config).
 * @returns {import("eslint").Linter.Config[]}
 */
export function nicholsConfig({ root }) {
  const rootPath = root instanceof URL ? fileURLToPath(root) : root;
  return [
    {
      name: "nichols/linter-options",
      linterOptions: { reportUnusedDisableDirectives: "error" },
    },
    {
      name: "nichols/boundaries",
      files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
      plugins: {
        nichols: plugin,
        "@eslint-community/eslint-comments": /** @type {any} */ (eslintComments),
      },
      settings: { nichols: { root: rootPath } },
      rules: {
        "nichols/no-vendor-sdk": ["error", { vendors: VENDORS, typeImportsAllowed: TYPE_IMPORTS_ALLOWED, urlImportsAllow: CONNECTORS }],
        "nichols/no-external-fetch": ["error", { allow: CONNECTORS }],
        "nichols/no-restricted-names": ["error", { names: RESTRICTED_NAMES }],
        "nichols/no-supabase-secret": ["error", { allowClient: LANE_ROUTER, allowEnvRead: CORE_ENV }],
        "nichols/no-server-secret-in-client": "error",
        "nichols/no-public-secret-name": "error",
        "nichols/no-env-result-copy": "error",
        "nichols/no-free-text-env-read": ["error", { allow: CORE_ENV }],
        "nichols/no-process-env": ["error", { allow: PROCESS_ENV_ALLOWED }],
        "nichols/no-vault-access": ["error", { allow: VAULT_NAMES_ALLOWED }],
        "nichols/no-cross-package-relative": "error",
        "nichols/no-test-only-import": ["error", { modules: TEST_ONLY_MODULES, allow: TEST_HARNESS }],
        "nichols/no-write-subpath-import": ["error", { specifiers: WRITE_SUBPATHS, dirs: WRITE_DIRS, allow: APPROVALS }],
        // The boundary rules cannot be switched off from inside a file.
        "@eslint-community/eslint-comments/no-restricted-disable": ["error", "nichols/*"],
        "@eslint-community/eslint-comments/no-unlimited-disable": "error",
      },
    },
    {
      // The T-005 secret-pattern test deliberately spells out secret-looking NEXT_PUBLIC_* names as its negative
      // corpus; the rule's own fixtures do the same. Nothing else is exempt.
      name: "nichols/public-secret-name-corpus",
      files: PUBLIC_SECRET_NAME_EXEMPT_FILES,
      rules: { "nichols/no-public-secret-name": "off" },
    },
  ];
}
