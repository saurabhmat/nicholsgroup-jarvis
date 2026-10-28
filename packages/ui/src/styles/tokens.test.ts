// @vitest-environment node
/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const themeCss = readFileSync(join(here, "theme.css"), "utf8");

function rootTokens(css: string): Map<string, string> {
  const root = /:root\s*\{([^}]*)\}/.exec(css);
  if (!root?.[1]) throw new Error("no :root block in theme.css");
  const tokens = new Map<string, string>();
  for (const m of root[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (m[1] && m[2]) tokens.set(m[1], m[2].trim());
  }
  return tokens;
}

const tokens = rootTokens(themeCss);

function hex(name: string): string {
  const value = tokens.get(name);
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} is not a 6-digit hex colour: ${value}`);
  return value;
}

function luminance(color: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("provisional design tokens (docs/plan-review.md §7, v2)", () => {
  it.each([
    ["--background", "#F7F4EC"],
    ["--card", "#FFFFFF"],
    ["--border", "#E7E1D3"],
    ["--divider", "#F1ECE0"],
    ["--foreground", "#111827"],
    ["--muted-foreground", "#4B5563"],
    ["--primary", "#0E2A47"],
    ["--primary-hover", "#081A2E"],
    ["--primary-tint", "#E4ECF5"],
    ["--accent-italic", "#1F4A7A"],
    ["--gold", "#D4AF5A"],
    ["--gold-foreground", "#8A6A1F"],
    ["--alert", "#B45309"],
    ["--alert-foreground", "#92400E"],
    ["--alert-surface", "#FCEFD9"],
    ["--success", "#166534"],
    ["--success-surface", "#DCFCE7"],
    ["--sidebar", "#0E2A47"],
    ["--sidebar-foreground", "#D5DEEA"],
    ["--sidebar-section", "#A9B8CC"],
    ["--sidebar-active", "#1F4A7A"],
    ["--sidebar-switcher", "#143559"],
    ["--sidebar-switcher-border", "#2C4F78"],
    ["--control-radius", "8px"],
    ["--card-radius", "12px"],
  ])("%s = %s", (name, value) => {
    expect(tokens.get(name)?.toUpperCase()).toBe(value.toUpperCase());
  });

  it("uses Source Serif 4 for headings and Inter for body, with the documented fallbacks", () => {
    expect(tokens.get("--heading-font")).toMatch(/Source Serif 4.*Georgia, serif/);
    expect(tokens.get("--body-font")).toMatch(/Inter.*system-ui/);
  });

  it.each([
    ["--foreground", "--background"],
    ["--foreground", "--card"],
    ["--muted-foreground", "--background"],
    ["--muted-foreground", "--card"],
    ["--primary-foreground", "--primary"],
    ["--primary", "--primary-tint"],
    ["--accent-italic", "--background"],
    ["--gold-foreground", "--background"],
    ["--gold-foreground", "--card"],
    ["--alert", "--background"],
    ["--alert-foreground", "--alert-surface"],
    ["--success", "--success-surface"],
    ["--sidebar-foreground", "--sidebar"],
    ["--sidebar-section", "--sidebar"],
    ["--sidebar-foreground", "--sidebar-active"],
    ["--gold", "--sidebar"],
  ])("text %s on %s meets WCAG AA (4.5:1)", (fg, bg) => {
    expect(contrast(hex(fg), hex(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it("raw gold fails on light grounds, so it must stay decoration only", () => {
    expect(contrast(hex("--gold"), hex("--background"))).toBeLessThan(4.5);
  });

  it("does not define dark-mode values yet (undecided until D-20)", () => {
    expect(themeCss).not.toMatch(/prefers-color-scheme|\.dark\b/);
  });
});

describe("components use tokens only", () => {
  const componentsDir = join(here, "..", "components");
  const sources = readdirSync(componentsDir)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => [f, readFileSync(join(componentsDir, f), "utf8")] as const);

  it("finds component sources", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(sources)("%s has no hard-coded colours", (_file, source) => {
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(source).not.toMatch(/\b(?:rgb|hsl|oklch)a?\(/i);
  });

  it.each(sources)("%s never uses raw gold for text", (_file, source) => {
    expect(source).not.toMatch(/\btext-gold(?!-foreground)\b/);
  });

  it.each(sources)("%s does not inject HTML", (_file, source) => {
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });

  it.each(sources)("%s never says bank balance", (_file, source) => {
    expect(source.toLowerCase()).not.toContain("bank balance");
  });
});
