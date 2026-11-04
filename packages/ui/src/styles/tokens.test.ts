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

function sources(): (readonly [string, string])[] {
  const componentsDir = join(here, "..", "components");
  return readdirSync(componentsDir)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => [f, readFileSync(join(componentsDir, f), "utf8")] as const);
}

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

describe("light design tokens (docs/plan-review.md §7, v2; final with D-20)", () => {
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
    ["--muted-foreground", "--muted"],
    ["--destructive-foreground", "--destructive"],
  ])("text %s on %s meets WCAG AA (4.5:1)", (fg, bg) => {
    expect(contrast(hex(fg), hex(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it("raw gold fails on light grounds, so it must stay decoration only", () => {
    expect(contrast(hex("--gold"), hex("--background"))).toBeLessThan(4.5);
  });

  it("alert on alert-surface fails, so alert text there must use --alert-foreground", () => {
    expect(contrast(hex("--alert"), hex("--alert-surface"))).toBeLessThan(4.5);
  });

  it.each(sources())("%s never puts text-alert on bg-alert-surface", (_file, source) => {
    expect(source).not.toMatch(/bg-alert-surface[^"]*\btext-alert(?!-foreground)\b|\btext-alert(?!-foreground)\b[^"]*bg-alert-surface/);
  });

  it.each([
    ["--chart-1", "#0E2A47"],
    ["--chart-2", "#3B6EA5"],
    ["--chart-3", "#B45309"],
    ["--chart-4", "#7C2D12"],
  ])("light chart %s = %s", (name, value) => {
    expect(tokens.get(name)?.toUpperCase()).toBe(value.toUpperCase());
  });

  it.each(["--chart-1", "--chart-2", "--chart-3", "--chart-4"])("light chart %s meets 4.5:1 on card and ground", (name) => {
    expect(contrast(hex(name), hex("--card"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex(name), hex("--background"))).toBeGreaterThanOrEqual(4.5);
  });
});

function block(css: string, selector: RegExp): Map<string, string> {
  const m = selector.exec(css);
  if (!m?.[1]) throw new Error(`no block for ${selector}`);
  const out = new Map<string, string>();
  for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (d[1] && d[2]) out.set(d[1], d[2].trim());
  }
  return out;
}

const darkMedia = block(themeCss, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/);
const darkAttr = block(themeCss, /:root\[data-theme="dark"\]\s*\{([^}]*)\}/);

function darkHex(name: string): string {
  const value = darkAttr.get(name) ?? tokens.get(name);
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} is not a 6-digit hex colour: ${value}`);
  return value;
}

describe("dark design tokens (docs/design/README.md, Nov 4, 2026)", () => {
  it("the system-dark block and the data-theme=dark block are identical", () => {
    expect([...darkMedia.entries()]).toEqual([...darkAttr.entries()]);
  });

  it("overrides every light colour token", () => {
    const colourNames = [...tokens.entries()].filter(([, v]) => /^#[0-9a-f]{6}$/i.test(v)).map(([k]) => k);
    expect(colourNames.filter((k) => !darkAttr.has(k))).toEqual([]);
  });

  it("sets color-scheme per mode", () => {
    expect(themeCss).toMatch(/^:root\s*\{[^}]*color-scheme:\s*light/m);
    expect(themeCss).toMatch(/:root\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark/);
  });

  it.each([
    ["--foreground", "--background"],
    ["--foreground", "--card"],
    ["--muted-foreground", "--background"],
    ["--muted-foreground", "--card"],
    ["--muted-foreground", "--muted"],
    ["--primary-foreground", "--primary"],
    ["--primary", "--primary-tint"],
    ["--foreground", "--primary-tint"],
    ["--accent-italic", "--background"],
    ["--accent-italic", "--card"],
    ["--gold-foreground", "--background"],
    ["--gold-foreground", "--card"],
    ["--alert", "--background"],
    ["--alert", "--card"],
    ["--alert-foreground", "--alert-surface"],
    ["--success", "--success-surface"],
    ["--sidebar-foreground", "--sidebar"],
    ["--sidebar-section", "--sidebar"],
    ["--sidebar-foreground", "--sidebar-active"],
    ["--gold", "--sidebar"],
    ["--destructive-foreground", "--destructive"],
  ])("dark text %s on %s meets WCAG AA (4.5:1)", (fg, bg) => {
    expect(contrast(darkHex(fg), darkHex(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["--chart-1", "--chart-2", "--chart-3", "--chart-4"])("dark chart %s meets 3:1 (graphics) on card", (name) => {
    expect(contrast(darkHex(name), darkHex("--card"))).toBeGreaterThanOrEqual(3);
  });
});

describe("components use tokens only", () => {
  it("finds component sources", () => {
    expect(sources().length).toBeGreaterThan(0);
  });

  it.each(sources())("%s has no hard-coded colours", (_file, source) => {
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(source).not.toMatch(/\b(?:rgb|hsl|oklch)a?\(/i);
  });

  it.each(sources())("%s never uses raw gold for text", (_file, source) => {
    expect(source).not.toMatch(/\btext-gold(?!-foreground)\b/);
  });

  it.each(sources())("%s does not inject HTML", (_file, source) => {
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });

  it.each(sources())("%s never says bank balance", (_file, source) => {
    expect(source.toLowerCase()).not.toContain("bank balance");
  });
});
