import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
  }, 30_000); // building and reading 30 MB of zeros can pass the default 5 s on a one-core machine (seen once, T-273 review)
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

// T-273: fflate 0.8.2 looped forever on a local header that carries the ZIP64 size marker (0xFFFFFFFF) without a ZIP64 extra field
// (GHSA-px8p-9vwx-vf98): the import froze the browser tab before any of our limits ran. Fixed in fflate 0.8.3.
describe("brain-folder zip: ZIP64 size marker without its extra field (T-273)", () => {
  const has = (version: string) => {
    const [major = 0, minor = 0, patch = 0] = version.replace(/^[^0-9]*/, "").split(".").map(Number);
    return major > 0 || minor > 8 || (minor === 8 && patch >= 3);
  };
  const pinned = (JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies.fflate ?? "";
  // The INSTALLED copy too: with an out-of-date node_modules the pin can say 0.8.3 while 0.8.2 is what runs.
  const installed = (() => {
    let dir = dirname(createRequire(import.meta.url).resolve("fflate"));
    for (let i = 0; i < 6; i += 1, dir = dirname(dir)) {
      const file = join(dir, "package.json");
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "fflate") return pkg.version ?? "";
    }
    return "";
  })();
  const fixed = has(pinned) && has(installed);

  it("the pinned and the installed fflate have the fix (0.8.3 or later)", () => {
    expect(has(pinned), `fflate is pinned to ${pinned}`).toBe(true);
    expect(has(installed), `fflate ${installed || "(unknown)"} is installed: run pnpm install`).toBe(true);
  });

  // Skipped on an older fflate: there the call never returns, and a synchronous loop cannot be timed out by the test runner.
  it.skipIf(!fixed)("is refused as unreadable at once instead of looping", () => {
    const name = strToU8("Context/About-Me.md");
    const header = new Uint8Array(30 + name.length + 8);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); // local file header
    view.setUint16(4, 45, true);
    view.setUint32(18, 0xffffffff, true); // compressed size: "see the ZIP64 extra field"
    view.setUint32(22, 0xffffffff, true); // uncompressed size: the same
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true); // ...but there is no extra field
    header.set(name, 30);
    const started = Date.now();
    expect(readBrainZip(header)).toEqual({ ok: false, error: "unreadable" });
    expect(Date.now() - started).toBeLessThan(2_000);
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
