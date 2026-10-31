// (a, H3, H5) Vendor SDKs, raw network modules and DB drivers may be imported only where the option map allows it.
// Architecture section 10 / CLAUDE.md rules 1 and 4: external APIs only through packages/connectors, DB clients only
// from the lane router.
//
// Options:
//  - vendors: pattern ("stripe", "@scope/*", bare node builtins match with or without "node:") -> repo-relative path
//    prefixes (or exact files) where the import is allowed.
//  - typeImportsAllowed: patterns for which `import type` (erased at build time) is allowed everywhere.
//  - urlImportsAllow: path prefixes where `https:`/`npm:`/`jsr:` specifiers (Deno edge functions) are allowed.
//
// Limits: this is a deny list, so a new SDK must be added to VENDORS in config.js. The dependency allow-list test
// (scripts/dependency-allowlist.test.mjs) is the second layer: a package.json cannot declare a vendor SDK outside its
// package. Imports built at runtime (`import(name)`) are not seen.
import { isUnder, moduleRefVisitor, repoPath } from "../ast.js";

/** @param {string} source @param {string} pattern */
function matches(source, pattern) {
  const s = source.replace(/^node:/, "");
  if (pattern.endsWith("/*")) return s.startsWith(pattern.slice(0, -1));
  return s === pattern || s.startsWith(`${pattern}/`);
}

const URL_SPECIFIER = /^(https?|npm|jsr):/i;

/** @type {import("eslint").Rule.RuleModule} */
export const noVendorSdk = {
  meta: {
    type: "problem",
    docs: { description: "Vendor SDKs, network modules and DB drivers are allowed only in the configured paths." },
    schema: [
      {
        type: "object",
        properties: {
          vendors: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
          typeImportsAllowed: { type: "array", items: { type: "string" } },
          urlImportsAllow: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      vendor:
        "'{{source}}' is a vendor SDK, network module or DB driver. External APIs go through packages/connectors and DB clients through the lane router (allowed here: {{allowed}}).",
      urlImport: "URL/npm:/jsr: import specifiers are not allowed here; declare the dependency in package.json.",
    },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const vendors = /** @type {Record<string, string[]>} */ (options.vendors ?? {});
    const typeOk = /** @type {string[]} */ (options.typeImportsAllowed ?? []);
    const rel = repoPath(context);
    return moduleRefVisitor((node, source, _names, typeOnly) => {
      if (URL_SPECIFIER.test(source) && !isUnder(rel, options.urlImportsAllow)) {
        context.report({ node, messageId: "urlImport" });
        return;
      }
      for (const [pattern, allowed] of Object.entries(vendors)) {
        if (!matches(source, pattern) || isUnder(rel, allowed)) continue;
        if (typeOnly && typeOk.includes(pattern)) continue;
        context.report({ node, messageId: "vendor", data: { source, allowed: allowed.join(", ") } });
        return;
      }
    });
  },
};
