import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MAX_ZIP_ENTRIES, chatGptMemory, fileKind, memoryFromJsonFile, readBrainZip, safePath } from "./import-files";

const zip = (files: Record<string, string | Uint8Array>, level: 0 | 6 = 6) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v])), { level });

const ABOUT = "# About me\n## Name and how to address me\nPat Example\n";

describe("brain-folder zip", () => {
  it("reads the four importable pages, also inside one wrapping folder and with stored entries", () => {
    for (const level of [6, 0] as const) {
      const r = readBrainZip(
        zip(
          {
            "MyBrain/Context/About-Me.md": ABOUT,
            "MyBrain/Context/Preferences.md": "# Preferences\n## Writing\nShort",
            "MyBrain/Context/Work.md": "# Work\n## My role here\nOps",
            "MyBrain/Employees/Personal-Assistant.md": "# PA\n## 3. What to leave out\n- Newsletters",
          },
          level,
        ),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.pages.map((p) => [p.target, p.path])).toEqual([
        ["about_me", "Context/About-Me.md"],
        ["preferences", "Context/Preferences.md"],
        ["work", "Context/Work.md"],
        ["pa", "Employees/Personal-Assistant.md"],
      ]);
      expect(r.pages[0]?.text).toBe(ABOUT);
    }
  });
  it("ignores other files without reading them: other employees, Projects pages, non-.md, files outside the known folders", () => {
    const r = readBrainZip(zip({ "Context/About-Me.md": ABOUT, "Employees/Analyst.md": "x", "Projects/P/BRIEF.md": "x", "Context/notes.txt": "x", "random.md": "x", "__MACOSX/._a": "x", "Skills/s/SKILL.md": "x" }));
    expect(r.ok && r.pages.map((p) => p.path)).toEqual(["Context/About-Me.md"]);
    if (r.ok) expect(r.notes.join(" ")).toMatch(/other employee file/);
  });
  it("refuses a zip bomb: a page that inflates far beyond a brain page, whatever its headers say", () => {
    const bomb = zip({ "Context/About-Me.md": new Uint8Array(30 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(1_000_000); // small on disk
    expect(readBrainZip(bomb)).toEqual({ ok: false, error: "too_large" });
  });
  it("refuses too many entries (an entry bomb)", () => {
    const files: Record<string, string> = { "Context/About-Me.md": ABOUT };
    for (let i = 0; i < MAX_ZIP_ENTRIES + 5; i++) files[`Projects/p${String(i)}.md`] = "x";
    expect(readBrainZip(zip(files))).toEqual({ ok: false, error: "too_many_entries" });
  });
  it.each(["../evil.md", "Context/../../evil.md", "/etc/passwd.md", "C:/Windows/x.md", "Context\\..\\..\\x.md"])("refuses a path that leaves the folder: %s", (name) => {
    expect(readBrainZip(zip({ "Context/About-Me.md": ABOUT, [name]: "x" }))).toEqual({ ok: false, error: "unsafe_path" });
  });
  it("skips a page over the page limit with a note, and reports nothing found when no page matches", () => {
    const big = readBrainZip(zip({ "Context/About-Me.md": "a".repeat(60_000), "Context/Work.md": "# Work\n## My role here\nOps" }));
    expect(big.ok && big.pages.map((p) => p.path)).toEqual(["Context/Work.md"]);
    if (big.ok) expect(big.notes.join(" ")).toMatch(/too large/);
    expect(readBrainZip(zip({ "Notes/a.md": "x" }))).toEqual({ ok: false, error: "empty" });
  });
  it("a file that is not a zip, an empty file and a truncated zip are unreadable, never an exception", () => {
    expect(readBrainZip(strToU8("not a zip"))).toMatchObject({ ok: false });
    expect(readBrainZip(new Uint8Array())).toEqual({ ok: false, error: "unreadable" });
    expect(readBrainZip(zip({ "Context/About-Me.md": ABOUT }).slice(0, 20))).toMatchObject({ ok: false });
  });
  it("safePath normalises one wrapping folder and nothing else", () => {
    expect(safePath("Brain/Context/Work.md")).toBe("Context/Work.md");
    expect(safePath("Context/Work.md")).toBe("Context/Work.md");
    expect(safePath("Context/")).toBe("Context/");
    expect(safePath("a/b/Context/Work.md")).toBe("a/b/Context/Work.md");
    expect(safePath("a/../b")).toBeNull();
    expect(safePath("x\u0000.md")).toBeNull();
  });
});

describe("ChatGPT conversations.json", () => {
  const withMemory = [
    {
      title: "chat 1",
      mapping: {
        a: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["Please plan my trip to Rome. My cat is Luna."] } } },
        b: { message: { content: { content_type: "user_editable_context", user_profile: "Runs a small pub group in Austin.", user_instructions: "Keep answers short." } } },
        c: { message: { content: { content_type: "model_editable_context", model_set_context: "1. Prefers morning meetings.\n2. Based in Austin." } } },
      },
    },
    { title: "chat 2", mapping: { d: { message: { content: { content_type: "user_editable_context", user_profile: "Runs a small pub group in Austin." } } } } },
  ];
  it("takes only the memory and custom-instruction parts, deduplicated, never the chat text", () => {
    const r = chatGptMemory(withMemory);
    expect(r).toEqual({ found: true, text: "Runs a small pub group in Austin.\n\nKeep answers short.\n\n1. Prefers morning meetings.\n2. Based in Austin." });
    expect(JSON.stringify(r)).not.toContain("Rome");
    expect(JSON.stringify(r)).not.toContain("Luna");
  });
  it("without memory parts it finds nothing (the UI then asks for the memory list instead)", () => {
    expect(chatGptMemory([{ title: "x", mapping: { a: { message: { content: { content_type: "text", parts: ["hello"] } } } } }])).toEqual({ found: false });
    expect(chatGptMemory({})).toEqual({ found: false });
    expect(chatGptMemory("text")).toEqual({ found: false });
  });
  it("parses file text; invalid JSON is reported, never thrown", () => {
    expect(memoryFromJsonFile(JSON.stringify(withMemory))).toMatchObject({ found: true });
    expect(memoryFromJsonFile("{not json")).toEqual({ found: false, invalid: true });
  });
  it("a deeply nested hostile file does not run away", () => {
    let v: unknown = { content_type: "user_editable_context", user_profile: "deep" };
    for (let i = 0; i < 5000; i++) v = { x: v };
    expect(chatGptMemory(v)).toEqual({ found: false });
  });
});

describe("fileKind", () => {
  it("accepts .txt, .md, .json and .zip only", () => {
    expect(fileKind("memory.TXT")).toBe("text");
    expect(fileKind("a.md")).toBe("text");
    expect(fileKind("conversations.json")).toBe("json");
    expect(fileKind("brain.zip")).toBe("zip");
    expect(fileKind("brain.exe")).toBeNull();
    expect(fileKind("brain.zip.exe")).toBeNull();
  });
});
