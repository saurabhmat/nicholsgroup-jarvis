// (T-033 security review H2) A relative import may not leave its own package. `../../../packages/connectors/src/vault`
// from apps/web reaches files that the package's `exports` map does not offer, and every rule keyed on the package
// specifier (`@nichols/connectors/internal`) misses it. Cross-package imports go through the package name.
//
// A package is `apps/<name>`, `packages/<name>` or `packages/modules/<name>`. The specifier is resolved against the
// linted file; it is reported when it lands in a package other than the file's own (or in any package, from a file
// outside the packages, e.g. root scripts).
// Limits: specifiers built at runtime are not seen; absolute filesystem paths are not resolved.
import path from "node:path";
import { moduleRefVisitor, repoPath } from "../ast.js";

/**
 * The package directory a repo-relative path belongs to, or undefined (root files, supabase/, scripts/).
 * @param {string} rel
 */
export function packageOf(rel) {
  const m = /^(packages\/modules\/[^/]+|packages\/[^/]+|apps\/[^/]+)(\/|$)/.exec(rel);
  if (!m) return undefined;
  // `packages/modules` itself is not a package; its children are.
  return m[1] === "packages/modules" ? undefined : m[1];
}

/** @type {import("eslint").Rule.RuleModule} */
export const noCrossPackageRelative = {
  meta: {
    type: "problem",
    docs: { description: "Relative imports may not reach into another package; import it by its package name." },
    schema: [],
    messages: {
      cross: "'{{source}}' reaches into {{target}} from {{own}}. Import it by package name (only its exported subpaths are public).",
    },
  },
  create(context) {
    const rel = repoPath(context);
    const own = packageOf(rel);
    return moduleRefVisitor((node, source) => {
      if (!source.startsWith(".")) return;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), source));
      const targetPkg = packageOf(target);
      if (!targetPkg || targetPkg === own) return;
      context.report({ node, messageId: "cross", data: { source, target: targetPkg, own: own ?? "outside the packages" } });
    });
  },
};
