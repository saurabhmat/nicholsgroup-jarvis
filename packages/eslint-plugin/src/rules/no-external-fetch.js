// (a, H3) Outbound network access outside the allowed packages (default: packages/connectors).
// Default-deny: EVERY `fetch` call is reported unless its first argument is statically RELATIVE:
//  - a string/template that starts with "/" (but not "//"), or a local const resolving to one
//  - `new URL(<relative>, <base>)` / `new Request(<relative>)` when the base is not statically an absolute URL
// Also reported: aliasing or indirect use of fetch (`const f = fetch`, `fetch.call/apply/bind`,
// `globalThis["fetch"]`), `XMLHttpRequest`, `WebSocket`, `EventSource` and `navigator.sendBeacon`.
// Other network modules (net, tls, http2, dgram, child_process, ws, ...) are import-restricted by no-vendor-sdk.
// Limits: a call through an object that merely forwards to fetch (a wrapper function defined elsewhere) is only as
// safe as the wrapper's own file; `new URL(rel, someVariable)` is trusted when the base is not a visible literal.
import { isGlobalReference, isUnder, propertyName, repoPath, resolveInit, unwrap } from "../ast.js";

const GLOBAL_HOSTS = new Set(["globalThis", "window", "self", "global"]);
const NETWORK_CONSTRUCTORS = new Set(["XMLHttpRequest", "WebSocket", "EventSource"]);

/**
 * Static string prefix of an expression, or undefined when unknown.
 * @param {import("eslint").Rule.RuleContext} context
 * @param {any} input
 * @param {number} depth
 * @returns {string | undefined}
 */
function staticPrefix(context, input, depth = 0) {
  const node = unwrap(input);
  if (!node || depth > 6) return undefined;
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" ? node.value : undefined;
    case "TemplateLiteral": {
      const first = node.quasis[0]?.value.cooked ?? "";
      if (first !== "" || node.expressions.length === 0) return first;
      return staticPrefix(context, node.expressions[0], depth + 1);
    }
    case "BinaryExpression":
      return node.operator === "+" ? staticPrefix(context, node.left, depth + 1) : undefined;
    case "Identifier": {
      const init = resolveInit(context, node);
      return init ? staticPrefix(context, init, depth + 1) : undefined;
    }
    default:
      return undefined;
  }
}

/** @param {string | undefined} prefix */
const isRelativePrefix = (prefix) => prefix !== undefined && prefix.startsWith("/") && !prefix.startsWith("//");
/** @param {string | undefined} prefix */
const isAbsolutePrefix = (prefix) => prefix !== undefined && /^\s*([a-z][a-z0-9+.-]*:)?\/\//i.test(prefix);

/**
 * True when the fetch target is provably relative.
 * @param {import("eslint").Rule.RuleContext} context
 * @param {any} input
 * @param {number} depth
 * @returns {boolean}
 */
function isRelativeTarget(context, input, depth = 0) {
  const node = unwrap(input);
  if (!node || depth > 6) return false;
  if (node.type === "NewExpression" && node.callee.type === "Identifier" && ["URL", "Request"].includes(node.callee.name)) {
    const base = node.callee.name === "URL" ? node.arguments[1] : undefined;
    if (base && isAbsolutePrefix(staticPrefix(context, base))) return false;
    return isRelativeTarget(context, node.arguments[0], depth + 1);
  }
  if (node.type === "Identifier") {
    const init = resolveInit(context, node);
    return init ? isRelativeTarget(context, init, depth + 1) : false;
  }
  return isRelativePrefix(staticPrefix(context, node));
}

/** @type {import("eslint").Rule.RuleModule} */
export const noExternalFetch = {
  meta: {
    type: "problem",
    docs: { description: "No outbound network access outside the allowed packages (default: packages/connectors)." },
    schema: [{ type: "object", properties: { allow: { type: "array", items: { type: "string" } } }, additionalProperties: false }],
    messages: {
      external: "fetch is allowed here only with a statically relative URL. Call external APIs only through packages/connectors.",
      alias: "Do not alias or indirectly call fetch here; call external APIs only through packages/connectors.",
      network: "'{{name}}' opens network connections; use packages/connectors for external APIs.",
    },
  },
  create(context) {
    if (isUnder(repoPath(context), context.options[0]?.allow)) return {};

    /** @param {any} node a fetch reference (Identifier or global member) */
    const checkFetchRef = (node) => {
      const parent = node.parent;
      if (parent?.type === "CallExpression" && parent.callee === node) {
        const first = parent.arguments[0];
        if (!first || !isRelativeTarget(context, first)) context.report({ node: parent, messageId: "external" });
      } else {
        context.report({ node, messageId: "alias" });
      }
    };

    return {
      /** @param {any} node */
      Identifier(node) {
        const parent = node.parent;
        // property keys, member property names, declarations of our own `fetch` are not references
        if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return;
        if (parent && ["Property", "MethodDefinition", "PropertyDefinition"].includes(parent.type) && parent.key === node && !parent.computed) return;
        if (parent && ["ImportSpecifier", "ExportSpecifier", "TSTypeReference", "TSTypeQuery"].includes(parent.type)) return;
        if (node.name === "fetch") {
          if (isGlobalReference(context, node)) checkFetchRef(node);
        } else if (NETWORK_CONSTRUCTORS.has(node.name) && isGlobalReference(context, node)) {
          context.report({ node, messageId: "network", data: { name: node.name } });
        }
      },
      /** @param {any} node */
      MemberExpression(node) {
        const name = propertyName(node);
        if (node.object.type !== "Identifier") return;
        if (GLOBAL_HOSTS.has(node.object.name) && isGlobalReference(context, node.object)) {
          if (name === "fetch") checkFetchRef(node);
          else if (name && NETWORK_CONSTRUCTORS.has(name)) context.report({ node, messageId: "network", data: { name } });
        } else if (node.object.name === "navigator" && name === "sendBeacon") {
          context.report({ node, messageId: "network", data: { name: "navigator.sendBeacon" } });
        }
      },
    };
  },
};
