// T-245 static check: a "use client" or "use server" module may export only what crosses the server/client boundary safely.
// Production crash (Nov 14, 2026): `PERIODS` was a constant exported from the "use client" period toggle; the server Finance page
// imported it and received a client reference instead of the array, so `PERIODS.map is not a function`. Vitest ignores the
// directives (the constant is a real array in unit tests), so only a static check catches this class of bug.
//   "use client": exported values must be components (function declarations, arrow or function expressions, classes, or
//                 memo/forwardRef/lazy wrappers). Constants, objects and value re-exports belong in a plain shared module.
//   "use server": every exported value must be an async function (Next requires it; anything else is a reference or a build error).
// Type-only exports are always allowed (erased at build time).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCAN = ["apps/web", "packages"];
const SKIP_DIR = new Set(["node_modules", "dist", ".next", ".turbo", "coverage", "test-results", "e2e", "public"]);
const DIRECTIVE_HEAD = /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*["']use (client|server)["']/;
const COMPONENT_WRAPPERS = new Set(["memo", "forwardRef", "lazy"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

type Directive = "use client" | "use server";

function directiveOf(sf: ts.SourceFile): Directive | null {
  for (const st of sf.statements) {
    if (ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression)) {
      const v = st.expression.text;
      if (v === "use client" || v === "use server") return v;
      continue;
    }
    break;
  }
  return null;
}

const hasExport = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const isAsync = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);

function isComponentValue(init: ts.Expression | undefined): boolean {
  if (!init) return false;
  let e = init;
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isClassExpression(e)) return true;
  if (ts.isCallExpression(e)) {
    const callee = e.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    return COMPONENT_WRAPPERS.has(name);
  }
  return false;
}

function isAsyncFunctionValue(init: ts.Expression | undefined): boolean {
  if (!init) return false;
  let e = init;
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  return (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) && isAsync(e);
}

/** The exports of a directive module that are not allowed for its directive, as "name (reason)". */
export function badExports(code: string, fileName = "x.tsx"): string[] {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const directive = directiveOf(sf);
  if (directive === null) return [];
  const server = directive === "use server";
  const bad: string[] = [];
  // Top-level names bound to a component (client) or an async function (server): `export default X` must name one of them.
  const componentNames = new Set<string>();
  const asyncNames = new Set<string>();
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
      componentNames.add(st.name.text);
      if (ts.isFunctionDeclaration(st) && isAsync(st)) asyncNames.add(st.name.text);
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        if (isComponentValue(d.initializer)) componentNames.add(d.name.text);
        if (isAsyncFunctionValue(d.initializer)) asyncNames.add(d.name.text);
      }
    }
  }
  for (const st of sf.statements) {
    if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) continue;
    if (ts.isFunctionDeclaration(st) && hasExport(st)) {
      if (server && !isAsync(st)) bad.push(`${st.name?.text ?? "default"} (not async)`);
      continue;
    }
    if (ts.isClassDeclaration(st) && hasExport(st)) {
      if (server) bad.push(`${st.name?.text ?? "default"} (class)`);
      continue;
    }
    if (ts.isEnumDeclaration(st) && hasExport(st)) {
      bad.push(`${st.name.text} (enum)`);
      continue;
    }
    if (ts.isVariableStatement(st) && hasExport(st)) {
      for (const d of st.declarationList.declarations) {
        const name = ts.isIdentifier(d.name) ? d.name.text : d.name.getText(sf);
        const ok = server ? isAsyncFunctionValue(d.initializer) : isComponentValue(d.initializer);
        if (!ok) bad.push(`${name} (${server ? "not an async function" : "not a component"})`);
      }
      continue;
    }
    if (ts.isExportAssignment(st)) {
      const e = st.expression;
      const ok = server ? isAsyncFunctionValue(e) || (ts.isIdentifier(e) && asyncNames.has(e.text)) : (ts.isIdentifier(e) && componentNames.has(e.text)) || isComponentValue(e);
      if (!ok) bad.push("default (export default value)");
      continue;
    }
    if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
      const names = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements.filter((el) => !el.isTypeOnly).map((el) => el.name.text) : ["*"];
      // A value re-export cannot be checked here: re-export from a plain module instead, or list the export directly.
      for (const n of names) bad.push(`${n} (re-export)`);
    }
  }
  return bad;
}

/** A workspace import the check could not resolve: reported, so a client module behind it cannot be skipped silently. */
const UNRESOLVED = "<unresolved>";
const EXT = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];

type Pkg = { dir: string; exports: Record<string, unknown> };
let packages: Map<string, Pkg> | undefined;
/** The workspace packages by name (packages/* and packages/modules/*), with their package.json `exports`. */
function workspacePackages(): Map<string, Pkg> {
  if (packages) return packages;
  packages = new Map();
  const dirs = [join(ROOT, "packages"), join(ROOT, "packages/modules")];
  for (const parent of dirs) {
    for (const name of readdirSync(parent)) {
      const dir = join(parent, name);
      try {
        const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; exports?: Record<string, unknown> };
        if (pj.name) packages.set(pj.name, { dir, exports: pj.exports ?? {} });
      } catch {
        /* not a package */
      }
    }
  }
  return packages;
}

const exportTarget = (v: unknown): string | null => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") for (const k of ["import", "default", "types"]) { const t = exportTarget((v as Record<string, unknown>)[k]); if (t) return t; }
  return null;
};

/** `@nichols/x[/sub]` through the package's exports map (exact key, then one `*` pattern). Null when it cannot be resolved. */
function resolvePackage(spec: string): string | null {
  const m = /^(@nichols\/[^/]+)(\/.*)?$/.exec(spec);
  if (!m?.[1]) return null;
  const pkg = workspacePackages().get(m[1]);
  if (!pkg) return null;
  const key = `.${m[2] ?? ""}`;
  let target = exportTarget(pkg.exports[key]);
  if (!target) {
    for (const [k, v] of Object.entries(pkg.exports)) {
      const star = k.indexOf("*");
      if (star < 0 || !key.startsWith(k.slice(0, star)) || !key.endsWith(k.slice(star + 1))) continue;
      const t = exportTarget(v);
      if (t) target = t.replace("*", key.slice(star, key.length - (k.length - star - 1)));
      break;
    }
  }
  return target ? join(pkg.dir, target) : null;
}

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, "apps/web", spec.slice(2));
  else if (spec.startsWith("@nichols/")) {
    const r = resolvePackage(spec);
    if (r === null) return UNRESOLVED;
    base = r;
  } else if (spec.startsWith(".")) base = join(from, "..", spec);
  else return null;
  for (const e of EXT) {
    try {
      if (statSync(base + e).isFile()) return base + e;
    } catch {
      /* next extension */
    }
  }
  return spec.startsWith("@nichols/") || spec.startsWith("@/") || spec.startsWith(".") ? UNRESOLVED : null;
}

/**
 * Value names a module without a directive takes from "use client" modules that are not components (not PascalCase). On the server
 * they are client references: calling or reading them fails exactly like PERIODS did. Type-only imports are skipped.
 */
export function clientHelperImports(file: string, code: string, isClient: (resolved: string) => boolean): string[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (directiveOf(sf) !== null) return [];
  const bad: string[] = [];
  for (const st of sf.statements) {
    let spec: string | null = null;
    let names: string[] = [];
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && !st.importClause?.isTypeOnly) {
      spec = st.moduleSpecifier.text;
      const b = st.importClause?.namedBindings;
      if (b && ts.isNamespaceImport(b)) names = ["* (namespace)"];
      else if (b) names = b.elements.filter((el) => !el.isTypeOnly).map((el) => (el.propertyName ?? el.name).text);
    } else if (ts.isExportDeclaration(st) && !st.isTypeOnly && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      spec = st.moduleSpecifier.text;
      names = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements.filter((el) => !el.isTypeOnly).map((el) => (el.propertyName ?? el.name).text) : ["* (export *)"];
    }
    if (spec === null) continue;
    const target = resolveImport(file, spec);
    if (target === UNRESOLVED) {
      bad.push(`${spec} (cannot resolve)`);
      continue;
    }
    if (target === null || !isClient(target)) continue;
    for (const n of names) if (!/^[A-Z]/.test(n) || /^[A-Z0-9_]+$/.test(n)) bad.push(`${n} from ${spec}`);
  }
  return bad;
}

describe("directive module exports (T-245)", () => {
  it("catches the production bug and the other unsafe shapes", () => {
    expect(badExports(`"use client";\nexport const PERIODS = [{ key: "mtd" }] as const;\nexport function T() { return null; }`)).toEqual(["PERIODS (not a component)"]);
    expect(badExports(`'use client'\nexport const LABEL = "x"; export enum E { A }`)).toEqual(["LABEL (not a component)", "E (enum)"]);
    expect(badExports(`"use client";\nexport { X } from "./x";\nexport type { Y } from "./y";`)).toEqual(["X (re-export)"]);
    expect(badExports(`"use client";\nconst LIST = [1];\nexport default LIST;`)).toEqual(["default (export default value)"]);
    expect(badExports(`"use client";\nfunction Page() { return null; }\nexport default Page;`)).toEqual([]);
    expect(badExports(`"use server";\nexport function sync() {}\nexport const LIMIT = 3;\nexport async function ok() {}\nexport const ok2 = async () => {};`)).toEqual([
      "sync (not async)",
      "LIMIT (not an async function)",
    ]);
  });

  it("allows components, wrappers, types and plain modules", () => {
    expect(badExports(`"use client";\nimport { memo } from "react";\nexport type P = { a: 1 };\nexport interface Q { b: 2 }\nexport function A() { return null; }\nexport const B = () => null;\nexport const C = memo(function C() { return null; });\nexport default function D() { return null; }`)).toEqual([]);
    expect(badExports(`export const PERIODS = [1, 2];`)).toEqual([]);
    expect(badExports(`// comment\n"use client";\nexport const N = 1;`)).toEqual(["N (not a component)"]);
  });

  it("no \"use client\" or \"use server\" module in the app or packages exports a constant or a non-async server value", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const dir of SCAN) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        const code = readFileSync(file, "utf8");
        if (!DIRECTIVE_HEAD.test(code)) continue;
        scanned += 1;
        for (const b of badExports(code, file)) offenders.push(`${relative(ROOT, file)}: ${b}`);
      }
    }
    expect(scanned).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it("no module without a directive imports a non-component value from a \"use client\" module", () => {
    const all = SCAN.flatMap((d) => sourceFiles(join(ROOT, d)));
    const code = new Map(all.map((f) => [f, readFileSync(f, "utf8")]));
    const client = new Set(all.filter((f) => DIRECTIVE_HEAD.test(code.get(f) ?? "") && directiveOf(ts.createSourceFile(f, code.get(f) ?? "", ts.ScriptTarget.Latest)) === "use client"));
    const offenders = all
      .filter((f) => !client.has(f))
      .flatMap((f) => clientHelperImports(f, code.get(f) ?? "", (t) => client.has(t)).map((b) => `${relative(ROOT, f)}: ${b}`));
    expect(client.size).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  }, 30_000);

  it("flags the shapes that broke production", () => {
    const isClient = (t: string) => t.endsWith("period-toggle.tsx");
    const page = join(ROOT, "apps/web/components/x.tsx");
    expect(clientHelperImports(page, `import { PeriodToggle, PERIODS, periodLabel } from "@nichols/ui/components/period-toggle";\nimport type { PeriodToggleProps } from "@nichols/ui/components/period-toggle";`, isClient)).toEqual([
      "PERIODS from @nichols/ui/components/period-toggle",
      "periodLabel from @nichols/ui/components/period-toggle",
    ]);
    expect(clientHelperImports(page, `"use client";\nimport { periodLabel } from "@nichols/ui/components/period-toggle";`, isClient)).toEqual([]);
    expect(clientHelperImports(page, `import { x } from "@nichols/no-such-package";\nimport { y } from "./no-such-file";`, () => false)).toEqual([
      "@nichols/no-such-package (cannot resolve)",
      "./no-such-file (cannot resolve)",
    ]);
    expect(clientHelperImports(page, `import { PERIODS } from "@nichols/ui/lib/periods";\nimport { guards } from "@/lib/guards";`, () => false)).toEqual([]);
  });
});
