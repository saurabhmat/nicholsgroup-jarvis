// T-005 review N5: results of requireConnectorEnv / getAnthropicEnv / getInngestEnv carry redaction
// (toJSON / inspect) as defence in depth; a copy drops it. Flags, for a value that is (an alias of) such a result:
//  - spread into an object/array/call, `...rest` in destructuring
//  - Object.assign / structuredClone / Object.entries / values / fromEntries
//  - logging it, or any member of it, via console.* / logger.* / log.*
// Limits (best effort): tracks direct calls, `await`, one `const x = call()` binding and `const y = x` aliases in
// the same file. Values pulled out first (`const k = env.STRIPE_KEY; console.log(k)`), results passed through
// other functions, and logging through a logger not named console/logger/log are not tracked. `.configured` is
// allowed in logs (boolean).
import { propertyName, resolveInit, unwrap } from "../ast.js";

const COPY_FUNCTIONS = new Set(["structuredClone"]);
const OBJECT_COPIERS = new Set(["assign", "entries", "values", "fromEntries"]);
const LOGGERS = new Set(["console", "logger", "log"]);

/** @type {import("eslint").Rule.RuleModule} */
export const noEnvResultCopy = {
  meta: {
    type: "problem",
    docs: { description: "Do not copy or log the redacted results of the env accessors." },
    schema: [{ type: "object", properties: { functions: { type: "array", items: { type: "string" } } }, additionalProperties: false }],
    messages: {
      copy: "Do not copy the result of {{fn}}: a copy drops its redaction. Read the fields you need instead.",
      log: "Do not log the result of {{fn}} or its fields: they are credentials.",
    },
  },
  create(context) {
    const functions = new Set(context.options[0]?.functions ?? ["requireConnectorEnv", "getAnthropicEnv", "getInngestEnv"]);

    /**
     * Name of the tracked accessor this expression derives from, or undefined.
     * @param {any} input @param {boolean} members include member access (x.FIELD)
     * @param {number} depth
     * @returns {string | undefined}
     */
    const origin = (input, members, depth = 0) => {
      const node = unwrap(input);
      if (!node || depth > 5) return undefined;
      if (node.type === "AwaitExpression") return origin(node.argument, members, depth + 1);
      if (node.type === "CallExpression" && node.callee.type === "Identifier" && functions.has(node.callee.name)) return node.callee.name;
      if (node.type === "Identifier") {
        const init = resolveInit(context, node);
        return init ? origin(init, members, depth + 1) : undefined;
      }
      if (members && node.type === "MemberExpression") {
        // `.configured` is a boolean flag, not a credential
        return propertyName(node) === "configured" ? undefined : origin(node.object, members, depth + 1);
      }
      return undefined;
    };

    /** @param {any} node @param {any} value @param {"copy"|"log"} id @param {boolean} members */
    const flag = (node, value, id, members) => {
      const fn = origin(value, members);
      if (fn) context.report({ node, messageId: id, data: { fn } });
    };

    return {
      /** @param {any} node */
      SpreadElement: (node) => flag(node, node.argument, "copy", false),
      /** @param {any} node */
      SpreadProperty: (node) => flag(node, node.argument, "copy", false),
      /** @param {any} node */
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern" || !node.init) return;
        if (node.id.properties.some((/** @type {any} */ p) => p.type === "RestElement")) flag(node, node.init, "copy", false);
      },
      /** @param {any} node */
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === "Identifier" && COPY_FUNCTIONS.has(callee.name)) {
          for (const arg of node.arguments) flag(node, arg, "copy", false);
        } else if (callee.type === "MemberExpression" && callee.object.type === "Identifier" && callee.property.type === "Identifier") {
          if (callee.object.name === "Object" && OBJECT_COPIERS.has(callee.property.name)) {
            for (const arg of node.arguments) flag(node, arg, "copy", false);
          } else if (LOGGERS.has(callee.object.name)) {
            for (const arg of node.arguments) flag(node, arg, "log", true);
          }
        }
      },
    };
  },
};
