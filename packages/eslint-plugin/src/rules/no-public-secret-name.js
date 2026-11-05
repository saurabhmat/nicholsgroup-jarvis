// (d, part 1) A NEXT_PUBLIC_* name that looks like a secret ships the value to every browser.
// Uses isSecretLikeName from @nichols/core (the T-005 pattern list plus its public-by-design allowlist); the
// patterns are not redefined here. Checks string literals, no-expression templates and identifiers/properties
// that are exactly a NEXT_PUBLIC_* name. Limits: names built at runtime and .env files are not linted (the
// client-schema test in packages/core covers the schema; .env files are never committed).
import { isSecretLikeName } from "@nichols/core/env/secret-patterns";

const PUBLIC_NAME = /^NEXT_PUBLIC_[A-Za-z0-9_]+$/;

/** @type {import("eslint").Rule.RuleModule} */
export const noPublicSecretName = {
  meta: {
    type: "problem",
    docs: { description: "NEXT_PUBLIC_* environment names must not match the secret-name patterns." },
    schema: [],
    messages: { secretName: "'{{name}}' would expose a secret to the browser: NEXT_PUBLIC_* names must not match the secret patterns." },
  },
  create(context) {
    /** @param {any} node @param {unknown} name */
    const check = (node, name) => {
      if (typeof name === "string" && PUBLIC_NAME.test(name) && isSecretLikeName(name)) {
        context.report({ node, messageId: "secretName", data: { name } });
      }
    };
    return {
      /** @param {any} node */
      Literal: (node) => check(node, node.value),
      /** @param {any} node */
      TemplateLiteral: (node) => {
        if (node.expressions.length === 0) check(node, node.quasis[0]?.value.cooked);
      },
      /** @param {any} node */
      Identifier: (node) => {
        // `{ NAME }` shorthand: key and value are the same name; report it once (on the key)
        if (node.parent?.type === "Property" && node.parent.shorthand && node === node.parent.value && node !== node.parent.key) return;
        check(node, node.name);
      },
    };
  },
};
