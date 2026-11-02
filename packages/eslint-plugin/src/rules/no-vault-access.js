// (T-033, T-032 review M1) The Vault may be used only from the connector token vault. Supabase grants service_role
// direct access to `vault.*`, and the database cannot revoke it, so this rule is what keeps every other piece of
// server code away from the stored credentials: it flags any string (literal or template part) that names the vault
// schema or the token functions/mapping table outside the allowed paths.
//
// Flagged: "vault" and "vault.<anything>" (e.g. `.schema("vault")`, `"vault.decrypted_secrets"`), and any string
// containing `connection_token_` or `connection_secrets` (e.g. `.rpc("connection_token_read")`).
// Limits: a name assembled at runtime from parts that are each harmless is not seen.

import { isUnder, repoPath } from "../ast.js";

const VAULT_NAME = /^vault(\.|$)/i;
const TOKEN_NAMES = /connection_token_|connection_secrets/i;

/** @param {string} text */
const isVaultName = (text) => VAULT_NAME.test(text.trim()) || TOKEN_NAMES.test(text);

/** @type {import("eslint").Rule.RuleModule} */
export const noVaultAccess = {
  meta: {
    type: "problem",
    docs: { description: "The Vault schema and the connection token functions may be named only in the token vault." },
    schema: [
      {
        type: "object",
        properties: { allow: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: {
      vault:
        "'{{text}}' reaches the Vault or the connection token functions; only the token vault may (allowed here: {{allowed}}). Use getToken from packages/connectors.",
    },
  },
  create(context) {
    const allow = /** @type {string[]} */ (context.options[0]?.allow ?? []);
    if (isUnder(repoPath(context), allow)) return {};
    /** @param {any} node @param {string} text */
    const check = (node, text) => {
      if (!isVaultName(text)) return;
      context.report({ node, messageId: "vault", data: { text: text.slice(0, 60), allowed: allow.join(", ") || "nowhere" } });
    };
    return {
      /** @param {any} node */
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      /** @param {any} node */
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};
