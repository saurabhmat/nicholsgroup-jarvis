// The Vercel free-text variables (FREE_TEXT_VALUE_NAMES, e.g. NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE) skip the
// build-time secret VALUE scan, so app code must not read them (they could carry a pasted secret into the
// browser). Only packages/core/src/env may mention them.
import { FREE_TEXT_VALUE_NAMES } from "@nichols/core/env/secret-patterns";
import { envNamesRead, isUnder, repoPath } from "../ast.js";

/** @type {import("eslint").Rule.RuleModule} */
export const noFreeTextEnvRead = {
  meta: {
    type: "problem",
    docs: { description: "App code must not read the Vercel free-text variables that skip the build-time value scan." },
    schema: [{ type: "object", properties: { allow: { type: "array", items: { type: "string" } } }, additionalProperties: false }],
    messages: { freeText: "Do not read '{{name}}': Vercel free-text variables skip the secret value scan." },
  },
  create(context) {
    if (isUnder(repoPath(context), context.options[0]?.allow)) return {};
    /** @param {any} node */
    const check = (node) => {
      for (const name of envNamesRead(node)) {
        if (FREE_TEXT_VALUE_NAMES.includes(name)) context.report({ node, messageId: "freeText", data: { name } });
      }
    };
    return { MemberExpression: check, VariableDeclarator: check };
  },
};
