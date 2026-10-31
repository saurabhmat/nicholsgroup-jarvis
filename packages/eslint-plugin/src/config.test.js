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
