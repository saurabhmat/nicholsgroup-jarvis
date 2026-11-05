// (d, part 2) A module that starts with the "use client" directive must not import the server env, the lane
// router or connectors, nor reference the Supabase secret key or the connector credential helpers.
// Limits: only direct imports and identifiers in the client file itself. Transitive imports are caught at build
// time by `server-only` (imported by @nichols/core/env/server).
import { envNamesRead, moduleRefVisitor } from "../ast.js";

const SERVER_MODULES = [
  /^@nichols\/core\/env\/server$/,
  /^@nichols\/core\/lane-router(\/|$)/,
  /^@nichols\/connectors(\/|$)/,
  /(^|\/)env\/server(\.[jt]s)?$/,
  /(^|\/)lane-router(\/|$)/,
  /^server-only$/,
];
const SERVER_NAMES = /^(getSupabaseSecretKey|requireConnectorEnv|parseConnectorEnv|getAnthropicEnv|getInngestEnv)$/;
const SECRET_ENV = /SUPABASE_\w*SECRET_KEY|SERVICE_ROLE/;

/** @param {any} program */
function hasUseClient(program) {
  for (const statement of program.body) {
    if (statement.type !== "ExpressionStatement" || typeof statement.directive !== "string") return false;
    if (statement.directive === "use client") return true;
  }
  return false;
}

/** @type {import("eslint").Rule.RuleModule} */
export const noServerSecretInClient = {
  meta: {
    type: "problem",
    docs: { description: 'Modules with "use client" must not import the server env/secret client or reference the secret key.' },
    schema: [],
    messages: {
      server: "Client modules must not import '{{what}}': it is server-only (secret key, lane router, connector credentials).",
      name: "Client modules must not reference '{{what}}'.",
    },
  },
  create(context) {
    if (!hasUseClient(context.sourceCode.ast)) return {};
    return {
      ...moduleRefVisitor((node, source) => {
        if (SERVER_MODULES.some((re) => re.test(source))) {
          context.report({ node, messageId: "server", data: { what: source } });
        }
      }),
      /** @param {any} node */
      Identifier(node) {
        if (node.parent?.type === "ImportSpecifier" && node === node.parent.local) return; // reported via `imported`
        if (node.parent?.type === "Property" && node.parent.shorthand && node === node.parent.value && node !== node.parent.key) return;
        if (SERVER_NAMES.test(node.name) || SECRET_ENV.test(node.name)) {
          context.report({ node, messageId: "name", data: { what: node.name } });
        }
      },
      /** @param {any} node */
      Literal(node) {
        if (typeof node.value === "string" && SECRET_ENV.test(node.value)) {
          context.report({ node, messageId: "name", data: { what: node.value } });
        }
      },
      /** @param {any} node */
      VariableDeclarator(node) {
        for (const name of envNamesRead(node)) if (SECRET_ENV.test(name)) context.report({ node, messageId: "name", data: { what: name } });
      },
    };
  },
};
