// Small AST and path helpers shared by the rules. Plain ESM JavaScript so the root ESLint config loads it under
// Node 22 without a TypeScript loader.
import path from "node:path";

/**
 * Repo-relative, forward-slash path of the file being linted. The repo root comes from `settings.nichols.root`
 * (set by the shared config); it falls back to ESLint's cwd.
 * @param {import("eslint").Rule.RuleContext} context
 * @returns {string}
 */
export function repoPath(context) {
  const root = /** @type {any} */ (context.settings)?.nichols?.root ?? context.cwd;
  return path.relative(String(root), context.filename).split(path.sep).join("/");
}

/**
 * True when `rel` is one of the prefixes or inside one (prefix "packages/ai" matches "packages/ai/src/x.ts" but
 * not "packages/ai-extra/x.ts"). A prefix may also be an exact file path.
 * @param {string} rel
 * @param {readonly string[] | undefined} prefixes
 */
export function isUnder(rel, prefixes) {
  return (prefixes ?? []).some((p) => rel === p || rel.startsWith(`${p}/`));
}

/** Test and test-config files: they never ship, so a few rules (process.env) do not apply to them. */
export const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|((^|\/)vitest\.config\.[cm]?[jt]s$)|((^|\/)test-stubs\/)/;

/**
 * Strip TypeScript wrappers that do not change the runtime value.
 * @param {any} node
 */
export function unwrap(node) {
  let n = node;
  while (
    n &&
    ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "ChainExpression"].includes(n.type)
  ) {
    n = n.expression;
  }
  return n;
}

/**
 * String value of a literal or expression-free template, else undefined.
 * @param {any} node
 * @returns {string | undefined}
 */
export function staticKey(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

/**
 * Static property name of a member expression: `x.name`, `x["name"]` or ``x[`name`]``. Undefined when dynamic.
 * @param {any} node
 * @returns {string | undefined}
 */
export function propertyName(node) {
  if (!node || node.type !== "MemberExpression") return undefined;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  return staticKey(node.property);
}

/**
 * Name of an object-pattern property (`{ name }`, `{ name: x }`, `{ "name": x }`, `{ ["name"]: x }`), else undefined.
 * @param {any} prop
 * @returns {string | undefined}
 */
export function patternKeyName(prop) {
  if (prop.type !== "Property") return undefined;
  if (!prop.computed && prop.key.type === "Identifier") return prop.key.name;
  return staticKey(prop.key);
}

/**
 * True when `identifier` is a reference to a global (not shadowed by a local declaration or parameter).
 * @param {import("eslint").Rule.RuleContext} context
 * @param {any} identifier
 */
export function isGlobalReference(context, identifier) {
  /** @type {any} */
  let scope = context.sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) return variable.defs.length === 0;
    scope = scope.upper;
  }
  return true;
}

/**
 * Callback for module references: static import, `export ... from`, dynamic `import()` and `require()`.
 * `names` are the imported names ("default" for a default import, "*" for a namespace or when unknown).
 * `typeOnly` is true for `import type ...`, `import { type A }` (all specifiers) and `export type ... from`.
 * @typedef {(node: any, source: string, names: string[], typeOnly: boolean) => void} ModuleRefCallback
 */

/**
 * ESLint visitor that reports every module reference to `cb`.
 * @param {ModuleRefCallback} cb
 * @returns {Record<string, (node: any) => void>}
 */
export function moduleRefVisitor(cb) {
  /** @param {any} spec */
  const importedName = (spec) => {
    if (spec.type === "ImportDefaultSpecifier") return "default";
    if (spec.type === "ImportNamespaceSpecifier") return "*";
    return spec.imported.type === "Identifier" ? spec.imported.name : String(spec.imported.value);
  };
  /** @param {any} node */
  const dynamicNames = (node) => {
    // const { a, b } = await import("x")  /  const { a } = require("x")
    let parent = node.parent;
    if (parent?.type === "AwaitExpression") parent = parent.parent;
    if (parent?.type === "VariableDeclarator" && parent.id.type === "ObjectPattern") {
      return parent.id.properties.map((/** @type {any} */ p) => patternKeyName(p) ?? "*");
    }
    return ["*"];
  };
  return {
    /** @param {any} node */
    ImportDeclaration(node) {
      const typeOnly =
        node.importKind === "type" ||
        (node.specifiers.length > 0 && node.specifiers.every((/** @type {any} */ s) => s.importKind === "type"));
      cb(node, String(node.source.value), node.specifiers.length === 0 ? ["*"] : node.specifiers.map(importedName), typeOnly);
    },
    /** @param {any} node */
    ExportNamedDeclaration(node) {
      if (!node.source) return;
      cb(
        node,
        String(node.source.value),
        node.specifiers.map((/** @type {any} */ s) => s.local.name ?? String(s.local.value)),
        node.exportKind === "type",
      );
    },
    /** @param {any} node */
    ExportAllDeclaration(node) {
      cb(node, String(node.source.value), ["*"], node.exportKind === "type");
    },
    /** @param {any} node */
    ImportExpression(node) {
      const source = staticKey(node.source);
      if (source !== undefined) cb(node, source, dynamicNames(node), false);
    },
    /** @param {any} node */
    CallExpression(node) {
      const arg = node.arguments[0];
      const source = arg ? staticKey(arg) : undefined;
      if (node.callee.type === "Identifier" && node.callee.name === "require" && source !== undefined) {
        cb(node, source, dynamicNames(node), false);
      }
    },
  };
}

/**
 * True for `process` or `globalThis.process` / `global.process` / `self.process` / `window.process`.
 * @param {any} input
 */
export function isProcessLike(input) {
  const n = unwrap(input);
  if (!n) return false;
  if (n.type === "Identifier") return n.name === "process";
  return (
    n.type === "MemberExpression" &&
    n.object.type === "Identifier" &&
    ["globalThis", "global", "self", "window"].includes(n.object.name) &&
    propertyName(n) === "process"
  );
}

/**
 * Names of environment variables read at `node` through `process.env.X`, `process.env["X"]`,
 * `import.meta.env.X` or destructuring (`const { X } = process.env`). Aliasing (`const e = process.env`) is not
 * tracked here; no-process-env bans that outright.
 * @param {any} node
 * @returns {string[]}
 */
export function envNamesRead(node) {
  /** @param {any} n */
  const isEnvObject = (n) => {
    const e = unwrap(n);
    if (!e || e.type !== "MemberExpression" || propertyName(e) !== "env") return false;
    return isProcessLike(e.object) || e.object.type === "MetaProperty";
  };
  if (node.type === "MemberExpression" && isEnvObject(node.object)) {
    const name = propertyName(node);
    return name ? [name] : [];
  }
  if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern" && node.init && isEnvObject(node.init)) {
    return node.id.properties.flatMap((/** @type {any} */ p) => {
      const name = patternKeyName(p);
      return name ? [name] : [];
    });
  }
  return [];
}

/**
 * Resolve an identifier to its single `const x = <init>` / `let x = <init>` initialiser, if any.
 * @param {import("eslint").Rule.RuleContext} context
 * @param {any} identifier
 */
export function resolveInit(context, identifier) {
  /** @type {any} */
  let scope = context.sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) {
      const def = variable.defs.length === 1 ? variable.defs[0] : undefined;
      if (def?.type === "Variable" && def.node.id.type === "Identifier" && def.node.init) return def.node.init;
      return undefined;
    }
    scope = scope.upper;
  }
  return undefined;
}

/**
 * Combine ESLint visitors; handlers for the same node type are all called.
 * @param {...Record<string, (node: any) => void>} visitors
 * @returns {Record<string, (node: any) => void>}
 */
export function mergeVisitors(...visitors) {
  /** @type {Record<string, ((node: any) => void)[]>} */
  const byType = {};
  for (const visitor of visitors) {
    for (const [type, fn] of Object.entries(visitor)) (byType[type] ??= []).push(fn);
  }
  return Object.fromEntries(
    Object.entries(byType).map(([type, fns]) => [type, (/** @type {any} */ node) => fns.forEach((fn) => fn(node))]),
  );
}
