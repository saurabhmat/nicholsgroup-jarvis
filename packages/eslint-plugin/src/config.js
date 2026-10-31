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
import { fileURLToPath } from "node:url";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import { noEnvResultCopy } from "./rules/no-env-result-copy.js";
import { noExternalFetch } from "./rules/no-external-fetch.js";
import { noFreeTextEnvRead } from "./rules/no-free-text-env-read.js";
import { noProcessEnv } from "./rules/no-process-env.js";
import { noPublicSecretName } from "./rules/no-public-secret-name.js";
import { noRestrictedNames } from "./rules/no-restricted-names.js";
import { noServerSecretInClient } from "./rules/no-server-secret-in-client.js";
import { noSupabaseSecret } from "./rules/no-supabase-secret.js";
import { noVendorSdk } from "./rules/no-vendor-sdk.js";

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
  },
};

export const CONNECTORS = ["packages/connectors"];
export const AI = ["packages/ai"];
export const APPROVALS = ["packages/modules/approvals"];
export const LANE_ROUTER = ["packages/core/src/lane-router"];
export const CORE_ENV = ["packages/core/src/env"];
export const TOKEN_VAULT = ["packages/connectors/src/vault"];
export const AUTH_SESSION = ["packages/core/src/auth", "apps/web/proxy.ts"];
export const INNGEST_CLIENT = ["packages/core/src/inngest", "apps/web/app/api/inngest"];
export const SCRIPTS = ["scripts", "apps/web/scripts"];
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
  ...DB_DRIVERS,
};

/** Patterns whose `import type` is erased at build time and therefore allowed everywhere. */
export const TYPE_IMPORTS_ALLOWED = Object.keys(DB_DRIVERS);

/** Restricted names: where each may be used (see rules/no-restricted-names.js). */
export const RESTRICTED_NAMES = {
  executeWrite: { allow: APPROVALS, allowReexport: CONNECTORS, hint: "only the approvals package executes writes" },
  mintApprovedAction: { allow: APPROVALS, hint: "only the approvals package mints approved actions" },
  getSupabaseSecretKey: { allow: [...LANE_ROUTER, ...TOKEN_VAULT, ...CORE_ENV], hint: "lane router and token vault only" },
  parseServerEnv: { allow: CORE_ENV, hint: "returns unredacted secrets; use the accessors in @nichols/core/env/server" },
  parseConnectorEnv: { allow: CORE_ENV, hint: "use requireConnectorEnv (redacted, fails closed)" },
  runtimeFlags: { allow: CORE_ENV, hint: "internal to packages/core/src/env" },
  requireConnectorEnv: { allow: [...CONNECTORS, ...CORE_ENV], hint: "connector credentials are read inside packages/connectors" },
  getAnthropicEnv: { allow: [...AI, ...CORE_ENV], hint: "the Anthropic key is read inside packages/ai" },
  getInngestEnv: { allow: [...INNGEST_CLIENT, ...CORE_ENV], hint: "the Inngest keys are read by the Inngest client only" },
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
