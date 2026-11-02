// (T-034 security review L3) Test harnesses may be imported only from test files: `msw` installs network interceptors
// and `@nichols/connectors/testing*` carries the mock connector and MSW setup, none of which may reach a server bundle.
//
// Allowed in test files (*.test.*, *.spec.*, vitest configs, test-stubs/) and in the configured paths (the harness
// itself). `import type` is allowed everywhere (erased at build time).
import { isUnder, moduleRefVisitor, repoPath, TEST_FILE } from "../ast.js";

/** @param {string} source @param {string} name */
const matches = (source, name) => source === name || source.startsWith(`${name}/`);

/** @type {import("eslint").Rule.RuleModule} */
export const noTestOnlyImport = {
  meta: {
    type: "problem",
    docs: { description: "Test harness modules (msw, @nichols/connectors/testing) may be imported only from test files." },
    schema: [
      {
        type: "object",
        properties: {
          modules: { type: "array", items: { type: "string" } },
          allow: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      testOnly: "'{{source}}' is a test harness; import it only from test files (*.test.*, *.spec.*, vitest configs).",
    },
  },
  create(context) {
    const modules = /** @type {string[]} */ (context.options[0]?.modules ?? []);
    const allow = /** @type {string[]} */ (context.options[0]?.allow ?? []);
    const rel = repoPath(context);
    if (TEST_FILE.test(rel) || isUnder(rel, allow)) return {};
    return moduleRefVisitor((node, source, _names, typeOnly) => {
      if (typeOnly || !modules.some((m) => matches(source, m))) return;
      context.report({ node, messageId: "testOnly", data: { source } });
    });
  },
};
