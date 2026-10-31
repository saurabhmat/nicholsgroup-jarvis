// (c) The Supabase service/secret client and key exist only in the lane router (and the connector token vault).
//  - importing `createClient` from @supabase/supabase-js outside packages/core/src/lane-router (second layer behind
//    the @supabase/* import restriction in no-vendor-sdk, which also allows the auth-session paths)
//  - any createClient/createServerClient/createBrowserClient call whose arguments mention the secret key
//  - reading SUPABASE_*SECRET_KEY (or the legacy service-role name) from the environment outside packages/core/src/env
// `getSupabaseSecretKey` access is controlled by no-restricted-names; every `process.env` read is controlled by
// no-process-env.
// Limits: a secret passed through an unrelated variable or helper is not seen; aliasing `const e = process.env` is
// banned by no-process-env rather than tracked here.
import { envNamesRead, isUnder, mergeVisitors, moduleRefVisitor, propertyName, repoPath } from "../ast.js";

const SECRET_ENV = /SUPABASE_\w*SECRET_KEY|SERVICE_ROLE/;
const SECRET_TEXT = /SUPABASE_\w*SECRET_KEY|SERVICE_ROLE|getSupabaseSecretKey|sb_secret_/;
const CLIENT_FACTORIES = new Set(["createClient", "createServerClient", "createBrowserClient"]);

/** @type {import("eslint").Rule.RuleModule} */
export const noSupabaseSecret = {
  meta: {
    type: "problem",
    docs: { description: "The Supabase secret client and key are created and read only in the lane router and token vault." },
    schema: [
      {
        type: "object",
        properties: {
          allowClient: { type: "array", items: { type: "string" } },
          allowEnvRead: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      client: "Create Supabase clients only in the lane router (packages/core/src/lane-router); request one from there.",
      secretArg: "A Supabase client is being created with the secret key. Only the lane router may do that.",
      envRead: "Do not read '{{name}}' from the environment here; only packages/core/src/env reads it.",
    },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const rel = repoPath(context);
    const clientOk = isUnder(rel, options.allowClient);
    const envOk = isUnder(rel, options.allowEnvRead);
    /** @param {any} node */
    const checkEnv = (node) => {
      if (envOk) return;
      for (const name of envNamesRead(node)) {
        if (SECRET_ENV.test(name)) context.report({ node, messageId: "envRead", data: { name } });
      }
    };
    return mergeVisitors(
      moduleRefVisitor((node, source, names) => {
        if (!clientOk && source === "@supabase/supabase-js" && (names.includes("createClient") || names.includes("*"))) {
          context.report({ node, messageId: "client" });
        }
      }),
      {
        /** @param {any} node */
        CallExpression(node) {
          const callee = node.callee;
          const name = callee.type === "Identifier" ? callee.name : propertyName(callee);
          if (clientOk || !name || !CLIENT_FACTORIES.has(name)) return;
          const text = node.arguments.map((/** @type {any} */ a) => context.sourceCode.getText(a)).join(",");
          if (SECRET_TEXT.test(text)) context.report({ node, messageId: "secretArg" });
        },
        MemberExpression: checkEnv,
        VariableDeclarator: checkEnv,
      },
    );
  },
};
