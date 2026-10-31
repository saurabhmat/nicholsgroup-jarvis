// (b, c, H4, H6, M1) Names that only certain paths may use: `executeWrite` and `mintApprovedAction` (approvals only),
// `getSupabaseSecretKey` (lane router, token vault, core/env), the raw env parsers (core/env), and the credential
// accessors (`requireConnectorEnv` connectors, `getAnthropicEnv` packages/ai, `getInngestEnv` Inngest client).
//
// A name is "used" when it is: imported or re-exported (static, dynamic, require), accessed as a member
// (`x.name`, `x["name"]`, ``x[`name`]``), or destructured from any binding (`const { name } = x`, including a
// namespace import). Defining your own function with that name is not flagged.
//
// Per-name options: `allow` (path prefixes/files that may use it), `allowReexport` (paths that may write
// `export { name } from "./x"` WITHOUT renaming; defining is always fine), `hint` (extra advice for the message).
// A re-export that RENAMES a restricted name (`export { name as other }`) is flagged everywhere, because it would
// hide the name from this rule.
//
// Limits: access through a computed non-literal key (`x[key]`), or a wrapper that forwards to the restricted
// function from a file that is itself allowed, is not seen. Renaming via a local alias in an allowed file is allowed.
import { isUnder, moduleRefVisitor, patternKeyName, propertyName, repoPath } from "../ast.js";

/** @type {import("eslint").Rule.RuleModule} */
export const noRestrictedNames = {
  meta: {
    type: "problem",
    docs: { description: "Restricted names (executeWrite, secret-key and credential accessors) may be used only in their owning paths." },
    schema: [
      {
        type: "object",
        properties: {
          names: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                allow: { type: "array", items: { type: "string" } },
                allowReexport: { type: "array", items: { type: "string" } },
                hint: { type: "string" },
              },
              required: ["allow"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      restricted: "'{{name}}' is restricted{{hint}} (allowed here: {{allowed}}).",
      renamed: "Do not rename '{{name}}' when re-exporting it: the rename hides it from the boundary rules.",
    },
  },
  create(context) {
    const names = /** @type {Record<string, {allow: string[], allowReexport?: string[], hint?: string}>} */ (
      context.options[0]?.names ?? {}
    );
    const rel = repoPath(context);
    /** @param {string} name */
    const entry = (name) => (Object.hasOwn(names, name) ? names[name] : undefined);
    /** @param {any} node @param {string} name */
    const check = (node, name) => {
      const e = entry(name);
      if (!e || isUnder(rel, e.allow)) return;
      context.report({
        node,
        messageId: "restricted",
        data: { name, hint: e.hint ? `: ${e.hint}` : "", allowed: e.allow.join(", ") || "nowhere" },
      });
    };
    return {
      ...moduleRefVisitor((node, _source, imported) => {
        // re-exports are handled per specifier and dynamic import()/require() via the ObjectPattern below
        if (node.type !== "ImportDeclaration") return;
        for (const name of imported) check(node, name);
      }),
      /** @param {any} node */
      ExportSpecifier(node) {
        const local = node.local.name ?? String(node.local.value);
        const exported = node.exported.name ?? String(node.exported.value);
        const e = entry(local);
        if (!e) return;
        if (local !== exported) {
          context.report({ node, messageId: "renamed", data: { name: local } });
        } else if (node.parent.source && !isUnder(rel, e.allowReexport)) {
          check(node, local);
        }
      },
      /** @param {any} node */
      MemberExpression(node) {
        const name = propertyName(node);
        if (name) check(node, name);
      },
      /** @param {any} node */
      ObjectPattern(node) {
        for (const prop of node.properties) {
          const name = patternKeyName(prop);
          if (name) check(prop, name);
        }
      },
    };
  },
};
