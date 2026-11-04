// Integration test: the real shared config (nicholsConfig) wired through the ESLint API. This proves the allow
// lists and the config blocks, not just the rule logic: the same code passes inside its allowed package and fails
// everywhere else, and a "use client" file cannot import the server env.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { nicholsConfig, plugin, PUBLIC_SECRET_NAME_EXEMPT_FILES } from "./config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: true,
  overrideConfig: [{ files: ["**/*.{ts,tsx}"], languageOptions: { parser: tseslint.parser } }, ...nicholsConfig({ root: ROOT })],
});

/** @param {string} code @param {string} file repo-relative */
async function lint(code, file) {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  return (result?.messages ?? []).map((m) => String(m.ruleId));
}

/** @type {[string, string, string, string | undefined][]} description, code, file, expected rule id (undefined = clean) */
const cases = [
  ["Stripe SDK in apps/web", `import Stripe from "stripe";`, "apps/web/app/x.ts", "nichols/no-vendor-sdk"],
  ["Stripe SDK in a module", `import Stripe from "stripe";`, "packages/modules/finance/src/x.ts", "nichols/no-vendor-sdk"],
  ["Stripe SDK in connectors", `import Stripe from "stripe";`, "packages/connectors/src/stripe/index.ts", undefined],
  ["Anthropic SDK in packages/ai", `import A from "@anthropic-ai/sdk";`, "packages/ai/src/provider.ts", undefined],
  ["Anthropic SDK in connectors", `import A from "@anthropic-ai/sdk";`, "packages/connectors/src/x.ts", "nichols/no-vendor-sdk"],
  ["node:net in a module", `import net from "node:net";`, "packages/modules/finance/src/x.ts", "nichols/no-vendor-sdk"],
  ["openai in apps/web", `import OpenAI from "openai";`, "apps/web/app/x.ts", "nichols/no-vendor-sdk"],
  ["Supabase client in a module", `import { createClient } from "@supabase/supabase-js";`, "packages/modules/finance/src/x.ts", "nichols/no-vendor-sdk"],
  ["Supabase ssr client in proxy.ts", `import { createServerClient } from "@supabase/ssr";`, "apps/web/proxy.ts", undefined],
  ["Supabase ssr client in core auth", `import { createServerClient } from "@supabase/ssr";`, "packages/core/src/auth/session.ts", undefined],
  ["Supabase type import anywhere", `import type { SupabaseClient } from "@supabase/supabase-js";`, "packages/modules/finance/src/x.ts", undefined],
  ["pg driver in a module", `import pg from "pg";`, "packages/modules/finance/src/x.ts", "nichols/no-vendor-sdk"],
  ["Deno URL import", `import x from "https://esm.sh/x";`, "supabase/functions/hook/index.ts", "nichols/no-vendor-sdk"],
  ["Anthropic SDK in a module", `import A from "@anthropic-ai/sdk";`, "packages/modules/comms/src/x.ts", "nichols/no-vendor-sdk"],
  ["Inngest in apps/web is allowed", `import { Inngest } from "inngest";`, "apps/web/app/api/inngest/route.ts", undefined],
  ["external fetch in apps/web", `await fetch("https://api.example.com/x");`, "apps/web/app/x.ts", "nichols/no-external-fetch"],
  ["external fetch in connectors", `await fetch("https://api.example.com/x");`, "packages/connectors/src/x.ts", undefined],
  ["relative fetch in apps/web", `await fetch("/api/x");`, "apps/web/app/x.ts", undefined],
  ["unknown fetch target in apps/web", `await fetch(url);`, "apps/web/app/x.ts", "nichols/no-external-fetch"],
  ["aliased fetch in a module", `const f = fetch;`, "packages/modules/finance/src/x.ts", "nichols/no-external-fetch"],
  ["WebSocket in apps/web", `new WebSocket("wss://x.test");`, "apps/web/app/x.ts", "nichols/no-external-fetch"],
  ["fetch in the edge functions dir", `await fetch("https://x.test");`, "supabase/functions/hook/index.ts", "nichols/no-external-fetch"],
  ["executeWrite import in a module", `import { executeWrite } from "@nichols/connectors";`, "packages/modules/finance/src/x.ts", "nichols/no-restricted-names"],
  ["executeWrite import in approvals", `import { executeWrite } from "@nichols/connectors";`, "packages/modules/approvals/src/jobs/execute.ts", undefined],
  ["executeWrite import in apps/web", `import { executeWrite } from "@nichols/connectors";`, "apps/web/app/x.ts", "nichols/no-restricted-names"],
  ["executeWrite import in connectors", `import { executeWrite } from "./x";`, "packages/connectors/src/x.ts", "nichols/no-restricted-names"],
  ["executeWrite re-export in connectors", `export { executeWrite } from "./x";`, "packages/connectors/src/index.ts", undefined],
  ["executeWrite renamed re-export in connectors", `export { executeWrite as run } from "./x";`, "packages/connectors/src/index.ts", "nichols/no-restricted-names"],
  ["executeWrite destructured from a namespace", `import * as c from "@nichols/connectors"; export const { executeWrite } = c;`, "packages/modules/finance/src/x.ts", "nichols/no-restricted-names"],
  ["raw env parser in apps/web", `import { parseServerEnv } from "@nichols/core/env";`, "apps/web/app/x.ts", "nichols/no-restricted-names"],
  ["requireConnectorEnv in a module", `import { requireConnectorEnv } from "@nichols/core/env/server";`, "packages/modules/finance/src/x.ts", "nichols/no-restricted-names"],
  ["getAnthropicEnv in a module", `import { getAnthropicEnv } from "@nichols/core/env/server";`, "packages/modules/comms/src/x.ts", "nichols/no-restricted-names"],
  ["getInngestEnv in the inngest client", `import { getInngestEnv } from "@nichols/core/env/server";`, "packages/core/src/inngest/client.ts", undefined],
  ["process.env in app code", `export const k = process.env.NODE_ENV;`, "apps/web/app/x.ts", "nichols/no-process-env"],
  ["process destructuring in a module", `export const { env } = process;`, "packages/modules/admin/src/x.ts", "nichols/no-process-env"],
  ["process.env in a test file", `export const k = process.env.NODE_ENV;`, "packages/modules/admin/src/x.test.ts", undefined],
  ["process.env in next.config.ts", `export const k = process.env.NODE_ENV;`, "apps/web/next.config.ts", undefined],
  ["createClient in apps/web", `import { createClient } from "@supabase/supabase-js";`, "apps/web/app/x.ts", "nichols/no-supabase-secret"],
  ["createClient in the lane router", `import { createClient } from "@supabase/supabase-js";`, "packages/core/src/lane-router/index.ts", undefined],
  ["secret key accessor in apps/web", `import { getSupabaseSecretKey } from "@nichols/core/env/server";`, "apps/web/app/x.ts", "nichols/no-restricted-names"],
  ["secret key accessor in connectors outside vault", `import { getSupabaseSecretKey } from "@nichols/core/env/server";`, "packages/connectors/src/stripe/index.ts", "nichols/no-restricted-names"],
  ["secret key accessor in the token vault", `import { getSupabaseSecretKey } from "@nichols/core/env/server";`, "packages/connectors/src/vault/token.ts", undefined],
  ["secret key accessor in the lane router", `import { getSupabaseSecretKey } from "@nichols/core/env/server";`, "packages/core/src/lane-router/index.ts", undefined],
  ["Inngest SDK in module code", `import { Inngest } from "inngest";`, "packages/modules/finance/src/jobs.ts", "nichols/no-vendor-sdk"],
  ["Inngest SDK type import in module code", `import type { InngestFunction } from "inngest";`, "packages/modules/finance/src/jobs.ts", undefined],
  ["Inngest client getter in an app route", `import { getInngest } from "@nichols/core/inngest";`, "apps/web/app/api/x/route.ts", "nichols/no-restricted-names"],
  ["sendLaneEvent in an app route", `import { sendLaneEvent } from "@nichols/core/inngest";`, "apps/web/app/api/x/route.ts", undefined],
  ["job client in an app route", `import { getLaneJobClient } from "@nichols/core/lane-router";`, "apps/web/app/api/x/route.ts", "nichols/no-restricted-names"],
  ["job client in module domain code", `import { getLaneJobClient } from "@nichols/core/lane-router";`, "packages/modules/finance/src/domain/x.ts", "nichols/no-restricted-names"],
  ["job client via namespace in apps/web", `import * as r from "@nichols/core/lane-router"; r.getLaneJobClient("PKG");`, "apps/web/lib/x.ts", "nichols/no-restricted-names"],
  ["job client in the Inngest client", `import { getLaneJobClient } from "@nichols/core/lane-router";`, "packages/core/src/inngest/client.ts", undefined],
  ["job client in the approvals executor", `import { getLaneJobClient } from "@nichols/core/lane-router";`, "packages/modules/approvals/src/execute.ts", undefined],
  ["router factory in apps/web", `import { createLaneRouter } from "@nichols/core/lane-router";`, "apps/web/lib/x.ts", "nichols/no-restricted-names"],
  ["user lane client in apps/web", `import { getLaneClient } from "@nichols/core/lane-router";`, "apps/web/app/api/x/route.ts", undefined],
  ["secret key env read in a module", `export const k = process.env.SUPABASE_SECRET_KEY;`, "packages/modules/admin/src/x.ts", "nichols/no-supabase-secret"],
  ["secret key env read in core/env", `export const k = process.env.SUPABASE_SECRET_KEY;`, "packages/core/src/env/x.ts", undefined],
  ["server env import in a client module", `"use client";\nimport { getServerEnv } from "@nichols/core/env/server";`, "apps/web/app/c.tsx", "nichols/no-server-secret-in-client"],
  ["public secret-like name", `export const k = process.env.NEXT_PUBLIC_STRIPE_SECRET;`, "apps/web/app/x.ts", "nichols/no-public-secret-name"],
  ["public by-design name", `export const k = "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";`, "apps/web/app/x.ts", undefined],
  ["spreading a connector env", `const e = requireConnectorEnv("stripe"); export const c = { ...e };`, "packages/connectors/src/x.ts", "nichols/no-env-result-copy"],
  ["parseConnectorEnv in a connector", `import { parseConnectorEnv } from "@nichols/core/env/server";`, "packages/connectors/src/x.ts", "nichols/no-restricted-names"],
  ["free-text env read in app code", `export const m = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE;`, "apps/web/app/x.ts", "nichols/no-free-text-env-read"],
  // T-033: connector tokens, the Vault and the internal contract subpath
  ["internal subpath in apps/web", `import { mintLaneBoundConnection } from "@nichols/connectors/internal";`, "apps/web/app/x.ts", "nichols/no-vendor-sdk"],
  ["internal subpath in a module", `import { buildProviderSchemas } from "@nichols/connectors/internal";`, "packages/modules/finance/src/x.ts", "nichols/no-vendor-sdk"],
  ["internal subpath in the approvals module", `import { mintLaneBoundConnection } from "@nichols/connectors/internal";`, "packages/modules/approvals/src/x.ts", "nichols/no-vendor-sdk"],
  ["internal subpath inside connectors", `import { mintLaneBoundConnection } from "@nichols/connectors/internal";`, "packages/connectors/src/quickbooks/index.ts", undefined],
  ["getToken in apps/web", `import { getToken } from "@nichols/connectors";`, "apps/web/app/x.ts", "nichols/no-restricted-names"],
  ["getToken member access in a module", `export const t = vault.getToken("PKG", c);`, "packages/modules/finance/src/x.ts", "nichols/no-restricted-names"],
  ["getToken in a connector", `import { getToken } from "../vault/index";`, "packages/connectors/src/quickbooks/index.ts", undefined],
  ["revokeToken in the approvals module", `import { revokeToken } from "@nichols/connectors";`, "packages/modules/approvals/src/x.ts", "nichols/no-restricted-names"],
  ["SecretValue.reveal in apps/web", `export const v = secret.reveal();`, "apps/web/app/x.ts", "nichols/no-restricted-names"],
  ["SecretValue.reveal in packages/ai", `export const v = secret.reveal();`, "packages/ai/src/prompt.ts", "nichols/no-restricted-names"],
  ["SecretValue.reveal in a connector", `export const v = secret.reveal();`, "packages/connectors/src/http/client.ts", undefined],
  ["createTokenVault outside the vault", `import { createTokenVault } from "../vault/tokens";`, "packages/connectors/src/quickbooks/index.ts", "nichols/no-restricted-names"],
  ["Vault schema in a module", `await db.schema("vault").from("decrypted_secrets").select();`, "packages/modules/admin/src/x.ts", "nichols/no-vault-access"],
  ["Vault table name in apps/web", `export const t = "vault.decrypted_secrets";`, "apps/web/app/x.ts", "nichols/no-vault-access"],
  ["token RPC in a connector outside the vault", `await db.schema("core").rpc("connection_token_read", a);`, "packages/connectors/src/quickbooks/index.ts", "nichols/no-vault-access"],
  ["token RPC in a template", "export const f = `connection_token_${op}`;", "packages/core/src/lane-router/x.ts", "nichols/no-vault-access"],
  ["token RPC in the token vault", `await db.schema("core").rpc("connection_token_read", a);`, "packages/connectors/src/vault/tokens.ts", undefined],
  ["generated DB types name the token functions", `export type F = { "connection_token_read": 1 };`, "packages/core/src/db/types.ts", undefined],
  ["ordinary word containing vault", `export const s = "vaulted ceiling";`, "apps/web/app/x.ts", undefined],
  // T-033 review fixes: SQL text naming the Vault (M2)
  ["Vault SQL text in a module", "export const q = `select * from vault.decrypted_secrets`;", "packages/modules/admin/src/x.ts", "nichols/no-vault-access"],
  ["Vault function in SQL text", `export const q = "select vault.create_secret($1)";`, "apps/web/app/x.ts", "nichols/no-vault-access"],
  ["Vault view name alone", `export const t = "decrypted_secrets";`, "packages/core/src/lane-router/x.ts", "nichols/no-vault-access"],
  ["prose mentioning the token vault", `export const m = "Stored in the token vault. Use getToken.";`, "apps/web/app/x.ts", undefined],
  // relative paths into another package (H2)
  ["relative import of the internal contract from apps/web", `import { mintLaneBoundConnection } from "../../../packages/connectors/src/contract/internal";`, "apps/web/app/api/x.ts", "nichols/no-cross-package-relative"],
  ["relative import of the lane-bound contract from apps/web", `import * as lb from "../../../packages/connectors/src/contract/lane-bound";`, "apps/web/app/api/x.ts", "nichols/no-cross-package-relative"],
  ["relative import of the vault from apps/web", `import { connectionLoader } from "../../../packages/connectors/src/vault/index";`, "apps/web/app/api/x.ts", "nichols/no-cross-package-relative"],
  ["relative import of connectors from a module", `export * from "../../../connectors/src/vault/index";`, "packages/modules/finance/src/x.ts", "nichols/no-cross-package-relative"],
  ["relative dynamic import of the vault from a module", `await import("../../../connectors/src/vault/secret");`, "packages/modules/finance/src/x.ts", "nichols/no-cross-package-relative"],
  ["relative import inside a package", `import { x } from "../contract/errors";`, "packages/connectors/src/vault/x.ts", undefined],
  ["relative import inside apps/web", `import { x } from "../../lib/x";`, "apps/web/app/api/x.ts", undefined],
  // names restricted by the review fixes (H1, H2)
  ["mint in apps/web by name", `import { mintLaneBoundConnection } from "@nichols/connectors";`, "apps/web/app/x.ts", "nichols/no-restricted-names"],
  ["schema builder in a module by name", `import { buildProviderSchemas } from "@nichols/connectors";`, "packages/modules/finance/src/x.ts", "nichols/no-restricted-names"],
  ["connectionLoader in apps/web", `export const l = vault.connectionLoader;`, "apps/web/app/x.ts", "nichols/no-restricted-names"],
  ["connectionLoader in a connector", `import { connectionLoader } from "../vault/index";`, "packages/connectors/src/quickbooks/index.ts", undefined],
  ["createConnectionLoader in a connector", `import { createConnectionLoader } from "../vault/loader";`, "packages/connectors/src/quickbooks/index.ts", "nichols/no-restricted-names"],
  ["rememberSecret outside the vault", `import { rememberSecret } from "../vault/secret";`, "packages/connectors/src/http/client.ts", "nichols/no-restricted-names"],
  ["scrubKnownSecrets in the connector logger", `import { scrubKnownSecrets } from "../vault/secret";`, "packages/connectors/src/log/redact.ts", undefined],
  ["scrubKnownSecrets in a connector", `import { scrubKnownSecrets } from "../vault/secret";`, "packages/connectors/src/quickbooks/index.ts", "nichols/no-restricted-names"],
  ["forgetSecretsForTests in a module", `secret.forgetSecretsForTests();`, "packages/modules/finance/src/x.test.ts", "nichols/no-restricted-names"],
  ["forgetSecretsForTests in the vault tests", `import { forgetSecretsForTests } from "./secret";`, "packages/connectors/src/vault/x.test.ts", undefined],
  // T-034: test harnesses only in tests
  ["msw in app code", `import { http } from "msw";`, "apps/web/app/x.ts", "nichols/no-test-only-import"],
  ["msw/node in a module", `import { setupServer } from "msw/node";`, "packages/modules/finance/src/x.ts", "nichols/no-test-only-import"],
  ["connectors testing subpath in apps/web", `import { useMockServer } from "@nichols/connectors/testing/msw";`, "apps/web/lib/x.ts", "nichols/no-test-only-import"],
  ["connectors testing in a module test", `import { useMockServer } from "@nichols/connectors/testing/msw";`, "packages/modules/finance/src/x.test.ts", undefined],
  ["msw in the harness itself", `import { setupServer } from "msw/node";`, "packages/connectors/src/testing/msw/index.ts", undefined],
  ["msw type import in app code", `import type { RequestHandler } from "msw";`, "apps/web/app/x.ts", undefined],
  // T-035: connection rows are created only inside packages/connectors; the oauth subpath is the app's entry point
  ["connectionStore in apps/web", `export const s = vault.connectionStore;`, "apps/web/app/api/x/route.ts", "nichols/no-restricted-names"],
  ["connectionStore in the OAuth flow", `import { connectionStore } from "../vault/index";`, "packages/connectors/src/oauth/index.ts", undefined],
  ["createConnectionStore outside the vault", `import { createConnectionStore } from "../vault/connections";`, "packages/connectors/src/oauth/index.ts", "nichols/no-restricted-names"],
  // T-039: raw records are written only inside packages/connectors
  ["rawRecords in apps/web", `export const r = vault.rawRecords;`, "apps/web/app/api/x/route.ts", "nichols/no-restricted-names"],
  ["rawRecords in a connector", `import { rawRecords } from "../vault/index";`, "packages/connectors/src/raw/index.ts", undefined],
  // T-050 R-L1: the write subpath belongs to the approvals module only
  ["write subpath in apps/web", `import { quickbooksWriter } from "@nichols/connectors/write";`, "apps/web/app/api/x/route.ts", "nichols/no-write-subpath-import"],
  ["write subpath in a finance module", `import { quickbooksWriter } from "@nichols/connectors/write";`, "packages/modules/finance/src/x.ts", "nichols/no-write-subpath-import"],
  ["write subpath type import in apps/web", `import type { QboApprovedAction } from "@nichols/connectors/write";`, "apps/web/lib/x.ts", "nichols/no-write-subpath-import"],
  ["write subpath re-exported by a module", `export { quickbooksWriter } from "@nichols/connectors/write";`, "packages/modules/finance/src/x.ts", "nichols/no-write-subpath-import"],
  ["write subpath required dynamically", `const w = await import("@nichols/connectors/write");`, "packages/core/src/x.ts", "nichols/no-write-subpath-import"],
  ["write subpath inside connectors", `import { quickbooksWriter } from "@nichols/connectors/write";`, "packages/connectors/src/oauth/x.ts", "nichols/no-write-subpath-import"],
  ["relative import of the write dir from apps/web", `import { quickbooksWriter } from "../../../../../packages/connectors/src/write/index";`, "apps/web/app/api/x/route.ts", "nichols/no-write-subpath-import"],
  ["relative import of the write dir (no index) from a module", `import { quickbooksWriter } from "../../../../connectors/src/write";`, "packages/modules/finance/src/domain/x.ts", "nichols/no-write-subpath-import"],
  ["relative import of the write dir from inside connectors", `import { quickbooksWriter } from "../write/index";`, "packages/connectors/src/quickbooks/x.ts", "nichols/no-write-subpath-import"],
  ["relative import of the built write dir", `import { quickbooksWriter } from "../../../connectors/dist/write/index.js";`, "packages/modules/finance/src/x.ts", "nichols/no-write-subpath-import"],
  ["write subpath in the approvals module", `import { quickbooksWriter } from "@nichols/connectors/write";`, "packages/modules/approvals/src/jobs/execute.ts", undefined],
  ["a sibling directory named like write", `import { x } from "../writers/x";`, "packages/connectors/src/quickbooks/x.ts", undefined],
  ["oauth subpath in an app route", `import { oauthFlow } from "@nichols/connectors/oauth";`, "apps/web/app/api/connect/x/route.ts", undefined],
  ["redact subpath in apps/web", `import { redactText } from "@nichols/connectors/redact";`, "apps/web/instrumentation.ts", undefined],
];

const DISABLE = "@eslint-community/eslint-comments";
const bypassCases = [
  ["disable-next-line of a nichols rule", `// eslint-disable-next-line nichols/no-vendor-sdk\nimport Stripe from "stripe";`, `${DISABLE}/no-restricted-disable`],
  ["disable-line of a nichols rule", `import Stripe from "stripe"; // eslint-disable-line nichols/no-vendor-sdk`, `${DISABLE}/no-restricted-disable`],
  ["block disable of a nichols rule", `/* eslint-disable nichols/no-vendor-sdk */\nimport Stripe from "stripe";`, `${DISABLE}/no-restricted-disable`],
  ["block disable of every nichols rule", `/* eslint-disable nichols/* */\nimport Stripe from "stripe";`, `${DISABLE}/no-restricted-disable`],
  ["blanket disable", `/* eslint-disable */\nimport Stripe from "stripe";`, `${DISABLE}/no-unlimited-disable`],
  ["blanket disable-next-line", `// eslint-disable-next-line\nimport Stripe from "stripe";`, `${DISABLE}/no-unlimited-disable`],
  ["unused disable directive", `// eslint-disable-next-line no-console\nexport const a = 1;`, "null"],
];

describe("inline disable directives (H1)", () => {
  it.each(bypassCases)("%s is reported", async (_name, code, expected) => {
    const ids = await lint(code, "apps/web/app/x.ts");
    expect(ids).toContain(expected);
  });
});

describe("exemptions", () => {
  it("lists exactly the expected no-public-secret-name exemption globs", () => {
    expect(PUBLIC_SECRET_NAME_EXEMPT_FILES).toEqual(["packages/core/src/env/**/*.test.ts", "packages/eslint-plugin/src/**/*.test.js"]);
    const exempt = nicholsConfig({ root: ROOT }).filter((c) => c.rules && Object.values(c.rules).some((r) => r === "off"));
    expect(exempt.map((c) => c.files)).toEqual([PUBLIC_SECRET_NAME_EXEMPT_FILES]);
    expect(exempt.map((c) => Object.keys(c.rules ?? {}))).toEqual([["nichols/no-public-secret-name"]]);
  });
  it("sets reportUnusedDisableDirectives to error", () => {
    expect(nicholsConfig({ root: ROOT })[0]?.linterOptions).toEqual({ reportUnusedDisableDirectives: "error" });
  });
});

describe("shared config wiring", () => {
  it.each(cases)("%s", async (_name, code, file, expected) => {
    const ids = await lint(code, file);
    if (expected) expect(ids).toContain(expected);
    else expect(ids.filter((id) => id.startsWith("nichols/"))).toEqual([]);
  });

  it("enables every rule the plugin defines", () => {
    const rules = nicholsConfig({ root: ROOT }).find((c) => c.name === "nichols/boundaries")?.rules ?? {};
    const enabled = Object.keys(rules)
      .filter((r) => r.startsWith("nichols/"))
      .map((r) => r.replace("nichols/", ""));
    expect(enabled.sort()).toEqual(Object.keys(plugin.rules).sort());
  });
});
