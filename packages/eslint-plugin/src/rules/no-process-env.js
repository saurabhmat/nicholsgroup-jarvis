// (H4c) Environment values flow only through the typed accessors in @nichols/core/env. Reading `process.env`
// anywhere else is reported: `process.env.X`, `process["env"]`, `process[key]`, `globalThis.process.env`,
// `const { env } = process`, `const p = process` (aliasing), `import.meta.env`, `Deno.env`.
// Allowed: the `allow` path prefixes/files, test files and vitest configs (they never ship).
// Limits: reads through `Reflect`/`eval`/`require("process")` are not seen (`require("process")` is an import of a
// builtin and caught nowhere else); config files outside the allow list must be added to it deliberately.
import { isGlobalReference, isProcessLike, isUnder, patternKeyName, propertyName, repoPath, TEST_FILE, unwrap } from "../ast.js";

/** @type {import("eslint").Rule.RuleModule} */
export const noProcessEnv = {
  meta: {
    type: "problem",
    docs: { description: "Do not read process.env outside the env package and the listed bootstrap files." },
    schema: [{ type: "object", properties: { allow: { type: "array", items: { type: "string" } } }, additionalProperties: false }],
    messages: {
      env: "Do not read process.env here; use the typed accessors from @nichols/core/env (allowed: {{allowed}}, test files).",
      alias: "Do not alias or destructure `process` here; use the typed accessors from @nichols/core/env.",
    },
  },
  create(context) {
    const rel = repoPath(context);
    const allow = /** @type {string[]} */ (context.options[0]?.allow ?? []);
    if (isUnder(rel, allow) || TEST_FILE.test(rel)) return {};
    const data = { allowed: allow.join(", ") };
    /** @param {any} node */
    const reportEnv = (node) => context.report({ node, messageId: "env", data });
    return {
      /** @param {any} node */
      MemberExpression(node) {
        const name = propertyName(node);
        const object = unwrap(node.object);
        if (isProcessLike(object)) {
          if (object.type === "Identifier" && !isGlobalReference(context, object)) return; // a local named `process`
          // process.env / process["env"] / process[key]; other static members (process.cwd, process.exit) are fine
          if (name === "env" || name === undefined) reportEnv(node);
        } else if (object.type === "MetaProperty" && name === "env") {
          reportEnv(node);
        } else if (object.type === "Identifier" && object.name === "Deno" && name === "env") {
          reportEnv(node);
        }
      },
      /** @param {any} node */
      Identifier(node) {
        if (node.name !== "process" || !isGlobalReference(context, node)) return;
        const parent = node.parent;
        if (parent?.type === "MemberExpression" && parent.object === node) return; // handled above
        if (parent?.type === "VariableDeclarator" && parent.init === node && parent.id.type === "ObjectPattern") return; // below
        if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return; // globalThis.process
        if (parent && ["Property", "MethodDefinition", "PropertyDefinition"].includes(parent.type) && parent.key === node && !parent.computed) return;
        if (parent && ["TSTypeQuery", "TSQualifiedName", "ImportSpecifier", "ExportSpecifier"].includes(parent.type)) return;
        context.report({ node, messageId: "alias" });
      },
      /** @param {any} node */
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern" || !node.init || !isProcessLike(node.init)) return;
        if (node.id.properties.some((/** @type {any} */ p) => p.type === "RestElement" || patternKeyName(p) === "env")) reportEnv(node);
      },
    };
  },
};
