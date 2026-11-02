// Fixture tests: every rule has failing (invalid) and passing (valid) fixtures. Filenames are virtual paths under
// ROOT, which is how the rules decide where they are (settings.nichols.root). Options come from the real shared
// config, so these fixtures exercise the real allow-lists too (config.test.js repeats the key ones end to end).
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";
import {
  CONNECTORS,
  CORE_ENV,
  LANE_ROUTER,
  PROCESS_ENV_ALLOWED,
  RESTRICTED_NAMES,
  TYPE_IMPORTS_ALLOWED,
  VENDORS,
} from "./config.js";
import { noEnvResultCopy } from "./rules/no-env-result-copy.js";
import { noExternalFetch } from "./rules/no-external-fetch.js";
import { noFreeTextEnvRead } from "./rules/no-free-text-env-read.js";
import { noProcessEnv } from "./rules/no-process-env.js";
import { noPublicSecretName } from "./rules/no-public-secret-name.js";
import { noRestrictedNames } from "./rules/no-restricted-names.js";
import { noServerSecretInClient } from "./rules/no-server-secret-in-client.js";
import { noSupabaseSecret } from "./rules/no-supabase-secret.js";
import { noVaultAccess } from "./rules/no-vault-access.js";
import { noVendorSdk } from "./rules/no-vendor-sdk.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ROOT = "/repo";
const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
  settings: { nichols: { root: ROOT } },
});
/** @param {string} p */
const at = (p) => `${ROOT}/${p}`;

const WEB = at("apps/web/app/page.tsx");
const CONNECTOR = at("packages/connectors/src/stripe/index.ts");
const VAULT = at("packages/connectors/src/vault/token.ts");
const AI = at("packages/ai/src/provider.ts");
const FINANCE = at("packages/modules/finance/src/domain/x.ts");
const APPROVALS = at("packages/modules/approvals/src/jobs/execute.ts");
const LANE_ROUTER_FILE = at("packages/core/src/lane-router/index.ts");
const CORE_ENV_FILE = at("packages/core/src/env/server.ts");
const AUTH_FILE = at("packages/core/src/auth/session.ts");
const PROXY = at("apps/web/proxy.ts");
const INNGEST_CLIENT = at("packages/core/src/inngest/client.ts");

const err = (/** @type {string} */ messageId, count = 1) => Array.from({ length: count }, () => ({ messageId }));
const VENDOR_OPTS = [{ vendors: VENDORS, typeImportsAllowed: TYPE_IMPORTS_ALLOWED, urlImportsAllow: CONNECTORS }];

tester.run("no-vendor-sdk", noVendorSdk, {
  valid: [
    ...["stripe", "googleapis", "@notionhq/client", "@mondaydotcomorg/api", "resend", "axios", "node:https", "ws", "node:net", "openai", "@slack/web-api"].map(
      (s) => ({ code: `import x from "${s}";`, filename: CONNECTOR, options: VENDOR_OPTS }),
    ),
    { code: `import A from "@anthropic-ai/sdk";`, filename: AI, options: VENDOR_OPTS },
    // The Inngest SDK only in the Inngest client folder; type imports anywhere (T-037 review L1).
    { code: `import { z } from "zod"; import { Inngest } from "inngest";`, filename: at("packages/core/src/inngest/index.ts"), options: VENDOR_OPTS },
    { code: `import type { InngestFunction } from "inngest";`, filename: WEB, options: VENDOR_OPTS },
    { code: `import x from "stripe-mock-helper";`, filename: WEB, options: VENDOR_OPTS }, // similarly named, not the vendor
    { code: `import { createClient } from "@supabase/supabase-js";`, filename: LANE_ROUTER_FILE, options: VENDOR_OPTS },
    { code: `import { createServerClient } from "@supabase/ssr";`, filename: AUTH_FILE, options: VENDOR_OPTS },
    { code: `import { createServerClient } from "@supabase/ssr";`, filename: PROXY, options: VENDOR_OPTS },
    { code: `import type { SupabaseClient } from "@supabase/supabase-js";`, filename: FINANCE, options: VENDOR_OPTS },
    { code: `import { type SupabaseClient } from "@supabase/supabase-js";`, filename: WEB, options: VENDOR_OPTS },
    { code: `export type { Pool } from "pg";`, filename: WEB, options: VENDOR_OPTS },
    { code: `import { spawnSync } from "node:child_process";`, filename: at("scripts/test-db.mjs"), options: VENDOR_OPTS },
    { code: `import "stripe";`, filename: CONNECTOR, options: VENDOR_OPTS },
    { code: `import x from "https://esm.sh/x";`, filename: CONNECTOR, options: VENDOR_OPTS },
  ],
  invalid: [
    { code: `import { Inngest } from "inngest";`, filename: WEB, options: VENDOR_OPTS, errors: err("vendor") },
    { code: `import Stripe from "stripe";`, filename: WEB, options: VENDOR_OPTS, errors: err("vendor") },
    { code: `import Stripe from "stripe";`, filename: FINANCE, options: VENDOR_OPTS, errors: err("vendor") },
    // Anthropic is packages/ai only, not connectors (T-100)
    { code: `import A from "@anthropic-ai/sdk";`, filename: FINANCE, options: VENDOR_OPTS, errors: err("vendor") },
    { code: `import A from "@anthropic-ai/sdk";`, filename: CONNECTOR, options: VENDOR_OPTS, errors: err("vendor") },
    { code: `import { google } from "googleapis/build/src/index";`, filename: WEB, options: VENDOR_OPTS, errors: err("vendor") },
    { code: `import { Client } from "@microsoft/microsoft-graph-client";`, filename: WEB, options: VENDOR_OPTS, errors: err("vendor") },
    { code: `import { Client } from "@notionhq/client";`, filename: AI, options: VENDOR_OPTS, errors: err("vendor") },
    { code: `import api from "@mondaydotcomorg/api";`, filename: WEB, options: VENDOR_OPTS, errors: err("vendor") },
    { code: `const s = await import("stripe");`, filename: WEB, options: VENDOR_OPTS, errors: err("vendor") },
    { code: `const s = require("stripe");`, filename: WEB, options: VENDOR_OPTS, errors: err("vendor") },
    { code: `export { default } from "stripe";`, filename: WEB, options: VENDOR_OPTS, errors: err("vendor") },
    // raw network modules, SDKs added in the H3 round
    ...["node:https", "https", "node:http2", "net", "node:tls", "dgram", "ws", "node:child_process", "openai", "twilio", "nodemailer", "@sendgrid/mail", "@slack/web-api", "@google-cloud/pubsub", "web-push", "plaid", "voyageai", "graphql-request"].map(
      (s) => ({ code: `import x from "${s}";`, filename: WEB, options: VENDOR_OPTS, errors: err("vendor") }),
    ),
    { code: `import x from "node:child_process";`, filename: at("apps/web/app/x.ts"), options: VENDOR_OPTS, errors: err("vendor") },
    // DB clients: lane router and auth-session paths only (H5)
    { code: `import { createClient } from "@supabase/supabase-js";`, filename: WEB, options: VENDOR_OPTS, errors: err("vendor") },
    { code: `import { createClient } from "@supabase/supabase-js";`, filename: CONNECTOR, options: VENDOR_OPTS, errors: err("vendor") },
    { code: `import { createServerClient } from "@supabase/ssr";`, filename: FINANCE, options: VENDOR_OPTS, errors: err("vendor") },
    { code: `import { createServerClient } from "@supabase/ssr";`, filename: at("apps/web/app/layout.tsx"), options: VENDOR_OPTS, errors: err("vendor") },
    ...["pg", "postgres", "kysely", "drizzle-orm", "drizzle-orm/pg-core", "@neondatabase/serverless", "mysql2", "better-sqlite3"].map((s) => ({
      code: `import x from "${s}";`,
      filename: FINANCE,
      options: VENDOR_OPTS,
      errors: err("vendor"),
    })),
    { code: `import { createClient, type SupabaseClient } from "@supabase/supabase-js";`, filename: WEB, options: VENDOR_OPTS, errors: err("vendor") },
    { code: `const { Pool } = await import("pg");`, filename: WEB, options: VENDOR_OPTS, errors: err("vendor") },
    // URL / npm: / jsr: specifiers (Deno edge functions) outside connectors
    { code: `import x from "https://esm.sh/stripe";`, filename: at("supabase/functions/hook/index.ts"), options: VENDOR_OPTS, errors: err("urlImport") },
    { code: `import Stripe from "npm:stripe";`, filename: at("supabase/functions/hook/index.ts"), options: VENDOR_OPTS, errors: err("urlImport") },
    { code: `import x from "jsr:@std/http";`, filename: WEB, options: VENDOR_OPTS, errors: err("urlImport") },
  ],
});

const FETCH_OPTS = [{ allow: CONNECTORS }];
tester.run("no-external-fetch", noExternalFetch, {
  valid: [
    { code: `fetch("https://api.stripe.com/v1/charges");`, filename: CONNECTOR, options: FETCH_OPTS },
    { code: `new WebSocket("wss://x.test");`, filename: CONNECTOR, options: FETCH_OPTS },
    { code: `fetch("/api/health");`, filename: WEB, options: FETCH_OPTS },
    { code: "fetch(`/api/lanes/${id}`);", filename: WEB, options: FETCH_OPTS },
    { code: `fetch("/api/x", { method: "POST" });`, filename: WEB, options: FETCH_OPTS },
    { code: `const u = new URL("/api/x", window.location.origin); fetch(u);`, filename: WEB, options: FETCH_OPTS },
    { code: `fetch(new URL("/api/x", base));`, filename: WEB, options: FETCH_OPTS },
    { code: `const P = "/api/x"; fetch(P);`, filename: WEB, options: FETCH_OPTS },
    { code: `fetch(new Request("/api/x"));`, filename: WEB, options: FETCH_OPTS },
    { code: `window.fetch("/api/x");`, filename: WEB, options: FETCH_OPTS },
    { code: `const href = "https://example.com"; link(href);`, filename: WEB, options: FETCH_OPTS }, // not passed to fetch
    { code: `class A { fetch() {} } const o = { fetch: 1 }; o.fetch; ctx.fetch(u);`, filename: WEB, options: FETCH_OPTS }, // not the global
    { code: `function f(fetch) { return fetch(url); }`, filename: WEB, options: FETCH_OPTS }, // shadowed parameter
  ],
  invalid: [
    { code: `fetch("https://api.stripe.com/v1/charges");`, filename: WEB, options: FETCH_OPTS, errors: err("external") },
    { code: `fetch("http://example.com");`, filename: FINANCE, options: FETCH_OPTS, errors: err("external") },
    { code: `fetch("//cdn.example.com/x.js");`, filename: WEB, options: FETCH_OPTS, errors: err("external") },
    { code: "fetch(`https://api.example.com/${id}`);", filename: WEB, options: FETCH_OPTS, errors: err("external") },
    { code: "fetch(`${'https://a.test'}/x`);", filename: WEB, options: FETCH_OPTS, errors: err("external") },
    { code: `fetch("https://api.example.com/" + id);`, filename: WEB, options: FETCH_OPTS, errors: err("external") },
    { code: `fetch(new URL("https://api.example.com/x"));`, filename: WEB, options: FETCH_OPTS, errors: err("external") },
    { code: `fetch(new URL("/x", "https://api.example.com"));`, filename: WEB, options: FETCH_OPTS, errors: err("external") },
    { code: `fetch(new Request("https://api.example.com/x"));`, filename: WEB, options: FETCH_OPTS, errors: err("external") },
    { code: `const url = new URL("https://api.example.com"); await fetch(url.href);`, filename: WEB, options: FETCH_OPTS, errors: err("external") },
    { code: `const BASE = "https://api.example.com/v1"; fetch(BASE);`, filename: AI, options: FETCH_OPTS, errors: err("external") },
    { code: `fetch("https://x.test", { method: "POST" });`, filename: at("packages/core/src/x.ts"), options: FETCH_OPTS, errors: err("external") },
    // default-deny: unknown targets are reported
    { code: `fetch(url);`, filename: WEB, options: FETCH_OPTS, errors: err("external") },
    { code: "fetch(`${base}/x`);", filename: WEB, options: FETCH_OPTS, errors: err("external") },
    { code: `fetch(getUrl());`, filename: WEB, options: FETCH_OPTS, errors: err("external") },
    { code: `fetch();`, filename: WEB, options: FETCH_OPTS, errors: err("external") },
    { code: `fetch(new URL(path, process.env.API));`, filename: WEB, options: FETCH_OPTS, errors: err("external") },
    // aliasing and indirect use
    { code: `globalThis.fetch("https://x.test");`, filename: WEB, options: FETCH_OPTS, errors: err("external") },
    { code: `globalThis["fetch"]("https://x.test");`, filename: WEB, options: FETCH_OPTS, errors: err("external") },
    { code: "globalThis[`fetch`](u);", filename: WEB, options: FETCH_OPTS, errors: err("external") },
    { code: `const f = fetch; f("https://x.test");`, filename: WEB, options: FETCH_OPTS, errors: err("alias") },
    { code: `const f = globalThis.fetch;`, filename: WEB, options: FETCH_OPTS, errors: err("alias") },
    { code: `fetch.call(null, "https://x.test");`, filename: WEB, options: FETCH_OPTS, errors: err("alias") },
    { code: `fetch.apply(null, ["https://x.test"]);`, filename: WEB, options: FETCH_OPTS, errors: err("alias") },
    { code: `const g = fetch.bind(globalThis);`, filename: WEB, options: FETCH_OPTS, errors: err("alias") },
    { code: `run(fetch);`, filename: WEB, options: FETCH_OPTS, errors: err("alias") },
    // other network APIs
    { code: `new XMLHttpRequest();`, filename: WEB, options: FETCH_OPTS, errors: err("network") },
    { code: `new WebSocket("wss://x.test");`, filename: WEB, options: FETCH_OPTS, errors: err("network") },
    { code: `new EventSource("/sse");`, filename: WEB, options: FETCH_OPTS, errors: err("network") },
    { code: `new window.WebSocket("wss://x.test");`, filename: WEB, options: FETCH_OPTS, errors: err("network") },
    { code: `navigator.sendBeacon("/x", data);`, filename: WEB, options: FETCH_OPTS, errors: err("network") },
  ],
});

const NAMES = [{ names: RESTRICTED_NAMES }];
tester.run("no-restricted-names", noRestrictedNames, {
  valid: [
    { code: `import { executeWrite } from "@nichols/connectors";`, filename: APPROVALS, options: NAMES },
    { code: `import { mintApprovedAction } from "./domain/mint";`, filename: APPROVALS, options: NAMES },
    { code: `connector.executeWrite(action);`, filename: APPROVALS, options: NAMES },
    { code: `const { executeWrite } = connector;`, filename: APPROVALS, options: NAMES },
    // connectors may define and re-export (no rename) but not call it
    { code: `export const executeWrite = () => {};`, filename: CONNECTOR, options: NAMES },
    { code: `export function executeWrite() {}`, filename: CONNECTOR, options: NAMES },
    { code: `export { executeWrite } from "./write";`, filename: CONNECTOR, options: NAMES },
    { code: `const mock = { executeWrite() {} };`, filename: FINANCE, options: NAMES }, // defining is not using
    { code: `const x = {}; x.constructor; x["toString"];`, filename: FINANCE, options: NAMES },
    // key accessor and credential accessors in their homes
    { code: `import { getSupabaseSecretKey } from "@nichols/core/env/server";`, filename: LANE_ROUTER_FILE, options: NAMES },
    { code: `import { getSupabaseSecretKey } from "@nichols/core/env/server";`, filename: VAULT, options: NAMES },
    { code: `import { getSupabaseSecretKey } from "../env/server";`, filename: CORE_ENV_FILE, options: NAMES },
    { code: `import { requireConnectorEnv } from "@nichols/core/env/server";`, filename: CONNECTOR, options: NAMES },
    { code: `import { getAnthropicEnv } from "@nichols/core/env/server";`, filename: AI, options: NAMES },
    { code: `import { getInngestEnv } from "@nichols/core/env/server";`, filename: INNGEST_CLIENT, options: NAMES },
    { code: `import { parseConnectorEnv, parseServerEnv, runtimeFlags } from "./schema";`, filename: CORE_ENV_FILE, options: NAMES },
  ],
  invalid: [
    { code: `import { executeWrite } from "@nichols/connectors";`, filename: FINANCE, options: NAMES, errors: err("restricted") },
    { code: `import { executeWrite as run } from "@nichols/connectors";`, filename: WEB, options: NAMES, errors: err("restricted") },
    { code: `import { executeWrite } from "./x";`, filename: CONNECTOR, options: NAMES, errors: err("restricted") }, // import + call in connectors
    { code: `export { executeWrite } from "@nichols/connectors";`, filename: at("packages/core/src/x.ts"), options: NAMES, errors: err("restricted") },
    { code: `const { executeWrite } = await import("@nichols/connectors");`, filename: FINANCE, options: NAMES, errors: err("restricted") },
    { code: `const { executeWrite } = require("@nichols/connectors");`, filename: FINANCE, options: NAMES, errors: err("restricted") },
    { code: `import * as c from "@nichols/connectors"; c.executeWrite(a);`, filename: FINANCE, options: NAMES, errors: err("restricted") },
    // destructuring a namespace import (H4b) and any other binding (H6)
    { code: `import * as c from "@nichols/connectors"; const { executeWrite } = c;`, filename: FINANCE, options: NAMES, errors: err("restricted") },
    { code: `import * as c from "@nichols/connectors"; const { executeWrite: run } = c;`, filename: FINANCE, options: NAMES, errors: err("restricted") },
    { code: `import * as c from "@nichols/connectors"; const { "executeWrite": run } = c;`, filename: FINANCE, options: NAMES, errors: err("restricted") },
    { code: `const { executeWrite } = registry.get("stripe");`, filename: WEB, options: NAMES, errors: err("restricted") },
    { code: `function f({ executeWrite }) { return executeWrite; }`, filename: FINANCE, options: NAMES, errors: err("restricted") },
    { code: `registry.get("stripe").executeWrite(action);`, filename: at("packages/ai/src/tool.ts"), options: NAMES, errors: err("restricted") },
    { code: `x["executeWrite"](a);`, filename: FINANCE, options: NAMES, errors: err("restricted") },
    { code: "x[`executeWrite`](a);", filename: FINANCE, options: NAMES, errors: err("restricted") },
    { code: `connector.executeWrite(a);`, filename: CONNECTOR, options: NAMES, errors: err("restricted") },
    // renaming re-exports is flagged everywhere, including the places that may use the name
    { code: `export { executeWrite as run } from "./write";`, filename: CONNECTOR, options: NAMES, errors: err("renamed") },
    { code: `export { executeWrite as run } from "./write";`, filename: APPROVALS, options: NAMES, errors: err("renamed") },
    { code: `export { executeWrite as run };`, filename: CONNECTOR, options: NAMES, errors: err("renamed") },
    { code: `import { mintApprovedAction } from "@nichols/approvals";`, filename: CONNECTOR, options: NAMES, errors: err("restricted") },
    { code: `import { mintApprovedAction } from "@nichols/approvals";`, filename: WEB, options: NAMES, errors: err("restricted") },
    // secret-key accessor
    { code: `import { getSupabaseSecretKey } from "@nichols/core/env/server";`, filename: WEB, options: NAMES, errors: err("restricted") },
    { code: `import { getSupabaseSecretKey } from "@nichols/core/env/server";`, filename: CONNECTOR, options: NAMES, errors: err("restricted") }, // connectors outside vault/
    { code: `import { getSupabaseSecretKey } from "@nichols/core/env/server";`, filename: at("packages/modules/finance/src/jobs/x.ts"), options: NAMES, errors: err("restricted") },
    { code: `const { getSupabaseSecretKey } = await import("@nichols/core/env/server");`, filename: WEB, options: NAMES, errors: err("restricted") },
    { code: `import * as env from "@nichols/core/env/server"; env.getSupabaseSecretKey();`, filename: WEB, options: NAMES, errors: err("restricted") },
    { code: `import * as env from "@nichols/core/env/server"; const { getSupabaseSecretKey } = env;`, filename: WEB, options: NAMES, errors: err("restricted") },
    // raw parsers (H4a) and credential accessors (M1)
    { code: `import { parseServerEnv } from "@nichols/core/env";`, filename: WEB, options: NAMES, errors: err("restricted") },
    { code: `import * as e from "@nichols/core/env"; e.parseServerEnv(process.env);`, filename: WEB, options: NAMES, errors: err("restricted") },
    { code: `import { parseConnectorEnv } from "@nichols/core/env/server";`, filename: CONNECTOR, options: NAMES, errors: err("restricted") },
    { code: `const { parseConnectorEnv } = require("@nichols/core/env/server");`, filename: CONNECTOR, options: NAMES, errors: err("restricted") },
    { code: `import { runtimeFlags } from "@nichols/core/env";`, filename: WEB, options: NAMES, errors: err("restricted") },
    { code: `import { requireConnectorEnv } from "@nichols/core/env/server";`, filename: FINANCE, options: NAMES, errors: err("restricted") },
    { code: `import { requireConnectorEnv } from "@nichols/core/env/server";`, filename: WEB, options: NAMES, errors: err("restricted") },
    { code: `import { getAnthropicEnv } from "@nichols/core/env/server";`, filename: CONNECTOR, options: NAMES, errors: err("restricted") },
    { code: `import { getAnthropicEnv } from "@nichols/core/env/server";`, filename: FINANCE, options: NAMES, errors: err("restricted") },
    { code: `import { getInngestEnv } from "@nichols/core/env/server";`, filename: FINANCE, options: NAMES, errors: err("restricted") },
  ],
});

const SUPA = [{ allowClient: LANE_ROUTER, allowEnvRead: CORE_ENV }];
tester.run("no-supabase-secret", noSupabaseSecret, {
  valid: [
    { code: `import { createClient } from "@supabase/supabase-js";`, filename: LANE_ROUTER_FILE, options: SUPA },
    { code: `createClient(url, getSupabaseSecretKey());`, filename: LANE_ROUTER_FILE, options: SUPA },
    { code: `const k = process.env.SUPABASE_SECRET_KEY;`, filename: CORE_ENV_FILE, options: SUPA },
    { code: `import { createBrowserClient } from "@supabase/ssr"; createBrowserClient(url, publishableKey);`, filename: WEB, options: SUPA },
    { code: `const k = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;`, filename: WEB, options: SUPA },
  ],
  invalid: [
    { code: `import { createClient } from "@supabase/supabase-js";`, filename: WEB, options: SUPA, errors: err("client") },
    { code: `import { createClient } from "@supabase/supabase-js";`, filename: AUTH_FILE, options: SUPA, errors: err("client") },
    { code: `import * as s from "@supabase/supabase-js";`, filename: FINANCE, options: SUPA, errors: err("client") },
    { code: `const { createClient } = await import("@supabase/supabase-js");`, filename: FINANCE, options: SUPA, errors: err("client") },
    {
      code: `import { createClient } from "@supabase/supabase-js"; createClient(u, process.env.SUPABASE_SECRET_KEY!);`,
      filename: FINANCE,
      options: SUPA,
      errors: [{ messageId: "client" }, { messageId: "secretArg" }, { messageId: "envRead" }],
    },
    { code: `createServerClient(url, getSupabaseSecretKey(), {});`, filename: WEB, options: SUPA, errors: err("secretArg") },
    { code: `const k = process.env.SUPABASE_SECRET_KEY;`, filename: WEB, options: SUPA, errors: err("envRead") },
    { code: `const k = process.env["SUPABASE_SECRET_KEY"];`, filename: CONNECTOR, options: SUPA, errors: err("envRead") },
    { code: `const k = process.env.SUPABASE_NL_SECRET_KEY;`, filename: LANE_ROUTER_FILE, options: SUPA, errors: err("envRead") },
    { code: `const { SUPABASE_SECRET_KEY } = process.env;`, filename: FINANCE, options: SUPA, errors: err("envRead") },
    { code: `const k = process.env.SUPABASE_SERVICE_ROLE_KEY;`, filename: WEB, options: SUPA, errors: err("envRead") },
    { code: `const k = import.meta.env.SUPABASE_SECRET_KEY;`, filename: WEB, options: SUPA, errors: err("envRead") },
    { code: `const k = globalThis.process.env.SUPABASE_SECRET_KEY;`, filename: WEB, options: SUPA, errors: err("envRead") },
  ],
});

const PROC = [{ allow: PROCESS_ENV_ALLOWED }];
tester.run("no-process-env", noProcessEnv, {
  valid: [
    { code: `const k = process.env.X;`, filename: CORE_ENV_FILE, options: PROC },
    { code: `const k = process.env.NODE_ENV;`, filename: at("apps/web/next.config.ts"), options: PROC },
    { code: `const k = process.env.NODE_ENV;`, filename: at("apps/web/instrumentation.ts"), options: PROC },
    { code: `assertBuildEnv(process.env);`, filename: at("apps/web/app/env-check.ts"), options: PROC },
    { code: `const k = process.env.HOME;`, filename: at("apps/web/scripts/check-env-build.mjs"), options: PROC },
    { code: `const k = process.env.HOME; const p = process;`, filename: at("scripts/test-db.mjs"), options: PROC },
    { code: `const k = process.env.X;`, filename: at("packages/connectors/src/stripe/stripe.test.ts"), options: PROC },
    { code: `const k = process.env.X;`, filename: at("packages/core/vitest.config.ts"), options: PROC },
    { code: `process.exit(1); process.cwd(); process.on("exit", f); process.platform;`, filename: WEB, options: PROC },
    { code: `type T = typeof process; const o = { process: 1 }; o.process;`, filename: WEB, options: PROC },
    { code: `function f(process) { return process.env; }`, filename: WEB, options: PROC }, // shadowed
  ],
  invalid: [
    { code: `const k = process.env.X;`, filename: WEB, options: PROC, errors: err("env") },
    { code: `const k = process.env;`, filename: FINANCE, options: PROC, errors: err("env") },
    { code: `const k = process["env"].X;`, filename: WEB, options: PROC, errors: err("env") },
    { code: "const k = process[`env`].X;", filename: WEB, options: PROC, errors: err("env") },
    { code: `const k = process[key];`, filename: WEB, options: PROC, errors: err("env") },
    { code: `const k = globalThis.process.env.X;`, filename: WEB, options: PROC, errors: err("env") },
    { code: `const k = globalThis["process"].env;`, filename: WEB, options: PROC, errors: err("env") },
    { code: `const k = global.process.env.X;`, filename: WEB, options: PROC, errors: err("env") },
    { code: `const { env } = process;`, filename: WEB, options: PROC, errors: err("env") },
    { code: `const { env: e } = process;`, filename: WEB, options: PROC, errors: err("env") },
    { code: `const { env } = globalThis.process;`, filename: WEB, options: PROC, errors: err("env") },
    { code: `const { ...all } = process;`, filename: WEB, options: PROC, errors: err("env") },
    { code: `const p = process; p.env.X;`, filename: WEB, options: PROC, errors: err("alias") },
    { code: `read(process);`, filename: WEB, options: PROC, errors: err("alias") },
    { code: `const k = import.meta.env.X;`, filename: WEB, options: PROC, errors: err("env") },
    { code: `const k = Deno.env.get("X");`, filename: at("supabase/functions/x/index.ts"), options: PROC, errors: err("env") },
    { code: `const k = process.env.X;`, filename: at("packages/connectors/src/stripe/index.ts"), options: PROC, errors: err("env") },
    // only the exact files are allowed, not siblings
    { code: `const k = process.env.X;`, filename: at("apps/web/app/env-check-2.ts"), options: PROC, errors: err("env") },
    { code: `const k = process.env.X;`, filename: at("apps/web/proxy.ts"), options: PROC, errors: err("env") },
  ],
});

tester.run("no-server-secret-in-client", noServerSecretInClient, {
  valid: [
    { code: `"use client";\nimport { useState } from "react";\nimport { clientEnv } from "@nichols/core/env/client";`, filename: WEB },
    { code: `import { getSupabaseSecretKey } from "@nichols/core/env/server";`, filename: WEB }, // not a client module (other rules cover it)
    { code: `import { x } from "@nichols/core/env/server";\n"use client";`, filename: WEB }, // the directive must come first
    { code: `"use strict";\n"use client";\nconst a = 1;`, filename: WEB },
  ],
  invalid: [
    { code: `"use client";\nimport { getServerEnv } from "@nichols/core/env/server";`, filename: WEB, errors: err("server") },
    { code: `'use client'\nimport { getSupabaseSecretKey } from "@nichols/core/env/server";`, filename: WEB, errors: [{ messageId: "server" }, { messageId: "name" }] },
    { code: `"use client";\nimport { getSupabaseSecretKey } from "../../x";`, filename: WEB, errors: err("name") },
    { code: `"use client";\nimport { db } from "@nichols/core/lane-router";`, filename: WEB, errors: err("server") },
    { code: `"use client";\nimport { x } from "../../../packages/core/src/env/server";`, filename: WEB, errors: err("server") },
    { code: `"use client";\nconst k = process.env.SUPABASE_SECRET_KEY;`, filename: WEB, errors: err("name") },
    { code: `"use client";\nconst { SUPABASE_SECRET_KEY } = process.env;`, filename: WEB, errors: err("name", 2) },
    { code: `"use client";\nconst k = requireConnectorEnv("stripe");`, filename: WEB, errors: err("name") },
    { code: `"use client";\nimport { stripe } from "@nichols/connectors";`, filename: WEB, errors: err("server") },
  ],
});

tester.run("no-public-secret-name", noPublicSecretName, {
  valid: [
    { code: `const a = process.env.NEXT_PUBLIC_APP_URL;`, filename: WEB },
    { code: `const a = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;`, filename: WEB }, // allowlisted by design
    { code: `const a = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;`, filename: WEB },
    { code: `const a = "NEXT_PUBLIC_SENTRY_DSN";`, filename: WEB },
    { code: `const a = process.env.STRIPE_SECRET;`, filename: WEB }, // not a NEXT_PUBLIC_ name
    { code: `const a = "the NEXT_PUBLIC_SECRET text";`, filename: WEB }, // prose, not a name
  ],
  invalid: [
    { code: `const a = process.env.NEXT_PUBLIC_SUPABASE_SECRET_KEY;`, filename: WEB, errors: err("secretName") },
    { code: `const a = process.env["NEXT_PUBLIC_STRIPE_SECRET"];`, filename: WEB, errors: err("secretName") },
    { code: "const a = `NEXT_PUBLIC_API_TOKEN`;", filename: WEB, errors: err("secretName") },
    { code: `const schema = { NEXT_PUBLIC_DB_PASSWORD: z.string() };`, filename: WEB, errors: err("secretName") },
    { code: `const { NEXT_PUBLIC_VAPID_PRIVATE_KEY } = process.env;`, filename: WEB, errors: err("secretName") },
    // the allowlist is exact-name only
    { code: `const a = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY_2;`, filename: WEB, errors: err("secretName") },
  ],
});

const ENV_FNS = `import { requireConnectorEnv, getAnthropicEnv, getInngestEnv } from "@nichols/core/env/server";\n`;
tester.run("no-env-result-copy", noEnvResultCopy, {
  valid: [
    { code: `${ENV_FNS}const env = requireConnectorEnv("stripe"); const key = env.STRIPE_RESTRICTED_KEY; use(key);`, filename: CONNECTOR },
    { code: `${ENV_FNS}const env = requireConnectorEnv("stripe"); JSON.stringify(env);`, filename: CONNECTOR }, // toJSON redacts
    { code: `${ENV_FNS}const { STRIPE_RESTRICTED_KEY, STRIPE_ACCOUNT } = requireConnectorEnv("stripe");`, filename: CONNECTOR },
    { code: `const other = { a: 1 }; const copy = { ...other }; console.log(other);`, filename: WEB },
    { code: `${ENV_FNS}const a = getAnthropicEnv(); if (!a.configured) console.warn("anthropic not configured");`, filename: WEB },
    { code: `${ENV_FNS}const a = getAnthropicEnv(); console.log(a.configured);`, filename: AI }, // boolean flag
    { code: `${ENV_FNS}const env = requireConnectorEnv("stripe"); console.log("connector ready");`, filename: CONNECTOR },
  ],
  invalid: [
    { code: `${ENV_FNS}const env = requireConnectorEnv("stripe"); const copy = { ...env };`, filename: CONNECTOR, errors: err("copy") },
    { code: `${ENV_FNS}const copy = { ...requireConnectorEnv("stripe") };`, filename: CONNECTOR, errors: err("copy") },
    { code: `${ENV_FNS}const env = await getAnthropicEnv(); call({ ...env, extra: 1 });`, filename: AI, errors: err("copy") },
    { code: `${ENV_FNS}const env = getInngestEnv(); const list = [...env];`, filename: WEB, errors: err("copy") },
    { code: `${ENV_FNS}const env = requireConnectorEnv("stripe"); Object.assign({}, env);`, filename: CONNECTOR, errors: err("copy") },
    { code: `${ENV_FNS}const env = requireConnectorEnv("stripe"); structuredClone(env);`, filename: CONNECTOR, errors: err("copy") },
    { code: `${ENV_FNS}const env = requireConnectorEnv("stripe"); Object.entries(env);`, filename: CONNECTOR, errors: err("copy") },
    { code: `${ENV_FNS}const env = requireConnectorEnv("stripe"); const { A, ...rest } = env;`, filename: CONNECTOR, errors: err("copy") },
    { code: `${ENV_FNS}const env = requireConnectorEnv("stripe"); const alias = env; const c = { ...alias };`, filename: CONNECTOR, errors: err("copy") },
    { code: `${ENV_FNS}const env = requireConnectorEnv("stripe"); console.log(env);`, filename: CONNECTOR, errors: err("log") },
    { code: `${ENV_FNS}const env = requireConnectorEnv("stripe"); console.error("bad", env.STRIPE_RESTRICTED_KEY);`, filename: CONNECTOR, errors: err("log") },
    { code: `${ENV_FNS}logger.info(getAnthropicEnv());`, filename: AI, errors: err("log") },
    { code: `${ENV_FNS}console.log(requireConnectorEnv("stripe").STRIPE_ACCOUNT);`, filename: CONNECTOR, errors: err("log") },
  ],
});

const FREE = [{ allow: CORE_ENV }];
tester.run("no-free-text-env-read", noFreeTextEnvRead, {
  valid: [
    { code: `const sha = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA;`, filename: WEB, options: FREE },
    { code: `const m = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE;`, filename: CORE_ENV_FILE, options: FREE },
  ],
  invalid: [
    { code: `const m = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE;`, filename: WEB, options: FREE, errors: err("freeText") },
    { code: `const m = process.env["NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF"];`, filename: WEB, options: FREE, errors: err("freeText") },
    { code: `const { NEXT_PUBLIC_VERCEL_GIT_REPO_OWNER } = process.env;`, filename: FINANCE, options: FREE, errors: err("freeText") },
    { code: `const m = globalThis.process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE;`, filename: WEB, options: FREE, errors: err("freeText") },
  ],
});

tester.run("no-vault-access", noVaultAccess, {
  valid: [
    { code: `db.schema("core").rpc("connection_token_read", a);`, filename: VAULT, options: [{ allow: ["packages/connectors/src/vault"] }] },
    { code: `const s = "vaulted"; const t = "my vault";`, filename: WEB, options: [{ allow: ["packages/connectors/src/vault"] }] },
  ],
  invalid: [
    { code: `db.schema("vault");`, filename: CONNECTOR, options: [{ allow: ["packages/connectors/src/vault"] }], errors: err("vault") },
    { code: `const t = " Vault.secrets ";`, filename: WEB, options: [{ allow: [] }], errors: err("vault") },
    { code: "db.rpc(`connection_token_${x}`);", filename: FINANCE, options: [{ allow: [] }], errors: err("vault") },
    { code: `db.from("connection_secrets");`, filename: AI, options: [{ allow: [] }], errors: err("vault") },
  ],
});
