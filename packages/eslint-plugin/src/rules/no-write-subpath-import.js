// (T-050 security review R-L1) CLAUDE.md rule 5: only packages/modules/approvals may reach the connectors' write side
// (`@nichols/connectors/write`: the writers, e.g. the QuickBooks revoke). Reported in every other file:
//  - the package specifier (`@nichols/connectors/write`, with or without a deeper path);
//  - a relative specifier that resolves into the write directory (`packages/connectors/src/write`, or its built copy
//    under `dist`), including from files inside packages/connectors itself.
// Type-only imports are reported too: nothing but the approvals module has a reason to name the write side.
// Limits: specifiers built at runtime and absolute filesystem paths are not seen (dynamic `import(x)` with a variable).
import path from "node:path";
import { isUnder, moduleRefVisitor, repoPath } from "../ast.js";

/** @type {import("eslint").Rule.RuleModule} */
export const noWriteSubpathImport = {
  meta: {
    type: "problem",
    docs: { description: "Only the approvals module may import the connectors' write subpath." },
    schema: [
      {
        type: "object",
        properties: {
          specifiers: { type: "array", items: { type: "string" } },
          dirs: { type: "array", items: { type: "string" } },
          allow: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      write: "'{{source}}' is the connectors' write side; only packages/modules/approvals may import it (executes approved actions only).",
    },
  },
  create(context) {
    const specifiers = /** @type {string[]} */ (context.options[0]?.specifiers ?? []);
    const dirs = /** @type {string[]} */ (context.options[0]?.dirs ?? []);
    const allow = /** @type {string[]} */ (context.options[0]?.allow ?? []);
    const rel = repoPath(context);
    if (isUnder(rel, allow)) return {};
    // `.../write`, `.../write/x`, `.../write.ts` or `.../write.js` (an extension on the directory's index shim).
    const intoDir = (/** @type {string} */ target) => dirs.some((d) => target === d || target.startsWith(`${d}/`) || target.startsWith(`${d}.`));
    return moduleRefVisitor((node, source) => {
      const hit = specifiers.some((s) => source === s || source.startsWith(`${s}/`));
      const relative = source.startsWith(".") && intoDir(path.posix.normalize(path.posix.join(path.posix.dirname(rel), source)));
      if (hit || relative) context.report({ node, messageId: "write", data: { source } });
    });
  },
};
