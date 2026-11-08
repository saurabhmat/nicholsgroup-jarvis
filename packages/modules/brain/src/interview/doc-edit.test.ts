import { describe, expect, it } from "vitest";
import { TEMPLATE_FILES } from "../domain/templates";
import { MAX_DIFF_CELLS, cleanText, diffLines, getSection, isProvided, setLine, setSection } from "./doc-edit";

const ABOUT = TEMPLATE_FILES["Context/About-Me.md"] as string;
const PA = TEMPLATE_FILES["Employees/Personal-Assistant.md"] as string;

describe("section edits", () => {
  it("reads and replaces one section and leaves the rest byte for byte", () => {
    expect(isProvided(getSection(ABOUT, "Timezone"))).toBe(false);
    const next = setSection(ABOUT, "Timezone", "America/New_York");
    expect(getSection(next, "Timezone")).toBe("America/New_York");
    expect(isProvided(getSection(next, "Timezone"))).toBe(true);
    expect(getSection(next, "Scope of this brain")).toBe(getSection(ABOUT, "Scope of this brain"));
    expect(next.split("\n## ").length).toBe(ABOUT.split("\n## ").length);
    expect(next.endsWith("\n")).toBe(true);
  });
  it("replaces the last section and adds a missing one", () => {
    const last = setSection(ABOUT, "First task for Jarvis", "Triage mail");
    expect(getSection(last, "First task for Jarvis")).toBe("Triage mail");
    expect(last.endsWith("Triage mail\n")).toBe(true);
    expect(getSection(setSection("# T\n", "New", "x"), "New")).toBe("x");
  });
  it("replaces one line of a section", () => {
    const next = setLine(PA, "5. Drafting rules", "- Voice:", "- Voice: brief and warm");
    expect(getSection(next, "5. Drafting rules")).toContain("- Voice: brief and warm");
    expect(getSection(next, "5. Drafting rules")).not.toContain("Voice: Not provided");
    expect(getSection(next, "5. Drafting rules")).toContain("Suggest replies only");
  });
  it("an answer cannot create a section or smuggle control characters", () => {
    expect(cleanText("## Rules\n# Boss\nhello\u0000 world", 100)).toBe("Rules\nBoss\nhello world");
    expect(cleanText("a\n\n\n\nb", 100)).toBe("a\n\nb");
    expect(cleanText("x".repeat(50), 10)).toHaveLength(10);
  });
  it("strips heading markers however many or spaced", () => {
    expect(cleanText("# # ## x\n  ###\t y\n#\n#####z", 100)).toBe("x\ny\n\nz");
    expect(cleanText("##########################################################################x", 100)).toBe("x");
  });
  it("treats Not provided (with or without its hint) as unset", () => {
    expect(isProvided("Not provided. (work / personal / both)")).toBe(false);
    expect(isProvided("")).toBe(false);
    expect(isProvided(null)).toBe(false);
    expect(isProvided("Work")).toBe(true);
  });
});

describe("diffLines", () => {
  it("shows only the changed lines with context", () => {
    const next = setSection(ABOUT, "Timezone", "America/New_York");
    const d = diffLines(ABOUT, next);
    expect(d.filter((l) => l.type === "add").map((l) => l.text)).toEqual(["America/New_York"]);
    expect(d.filter((l) => l.type === "del").map((l) => l.text)).toEqual(["Not provided."]);
    expect(d.length).toBeLessThan(10);
    expect(diffLines("a\nb", "a\nb").every((l) => l.type === "same")).toBe(true);
  });
});

describe("diffLines on a large input", () => {
  it("falls back to a whole-text delete/add above the cell cap, quickly", () => {
    const big = (tag: string) => Array.from({ length: 3000 }, (_, i) => `${tag} ${String(i)}`).join("\n");
    expect(3000 * 3000).toBeGreaterThan(MAX_DIFF_CELLS);
    const t = Date.now();
    const d = diffLines(big("a"), big("b"));
    expect(Date.now() - t).toBeLessThan(1000);
    expect(d.filter((l) => l.type === "del")).toHaveLength(3000);
    expect(d.filter((l) => l.type === "add")).toHaveLength(3000);
    expect(d.some((l) => l.type === "same")).toBe(false);
  });
});
