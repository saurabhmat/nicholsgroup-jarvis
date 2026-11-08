import { describe, expect, it } from "vitest";
import { TEMPLATE_FILES } from "../domain/templates";
import { cleanText, diffLines, getSection, isProvided, setLine, setSection } from "./doc-edit";

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
