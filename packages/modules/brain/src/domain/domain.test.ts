import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ABOUT_ME_PATH,
  BRAIN_RULES_MD,
  HOME_SEED_DOCUMENTS,
  LANE_SEED_DOCUMENTS,
  PERSONAL_ASSISTANT_INSTRUCTIONS,
  PREFERENCES_PATH,
  PROJECT_TEMPLATES,
  SEED_SKILLS,
  TEMPLATE_FILES,
  containsSecret,
  documentKindFor,
  isValidBrainPath,
  resolveHomeLane,
  utf8Bytes,
} from "./index";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("paths and kinds (mirror brain.valid_path / brain.document_kind in SQL)", () => {
  it("accepts brain-style paths", () => {
    for (const p of ["Context/About-Me.md", "Context/Work.md", "Projects/Ask-Pub-K/BRIEF.md", "Projects/_template/HANDOFF.md", "Notes/Log.md"]) {
      expect(isValidBrainPath(p), p).toBe(true);
    }
  });
  it("refuses traversal, other folders, other extensions, empty names and too many segments", () => {
    for (const p of ["Context/../Etc.md", "Other/Work.md", "Context/Work.txt", "Context/.md", "/Context/Work.md", "Context//Work.md", "Context/a b.md", "Work.md", "Context/a/b/c/d/e/f.md", `Notes/${"a".repeat(200)}.md`, "", 5, null]) {
      expect(isValidBrainPath(p), String(p)).toBe(false);
    }
  });
  it("derives the kind from the path only", () => {
    expect(documentKindFor("Context/About-Me.md")).toBe("about_me");
    expect(documentKindFor("Context/Preferences.md")).toBe("preferences");
    expect(documentKindFor("Context/Work.md")).toBe("context");
    expect(documentKindFor("Context/Anything.md")).toBe("context");
    expect(documentKindFor("Projects/Ask-Pub-K/BRIEF.md")).toBe("project_brief");
    expect(documentKindFor("Projects/Ask-Pub-K/HANDOFF.md")).toBe("project_handoff");
    expect(documentKindFor("Projects/Ask-Pub-K/Other.md")).toBe("note");
    expect(documentKindFor("Notes/About-Me.md")).toBe("note");
  });
  it("counts UTF-8 bytes", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é")).toBe(2);
  });
});

describe("secret scan (reuses looksLikeSecretValue)", () => {
  it("finds a credential anywhere in the text", () => {
    const hits = [
      "token: sk_live_abcdefghijklmnop1234",
      "notes\nsk-ant-api03-abcdefghijklmnop",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
      "(see https://example.test/cb?access_token=abc123)",
      "-----BEGIN PRIVATE KEY-----\nabc",
      "sk_live_abcdefghijklmnop1234",
      "use **ghp_abcdefghijklmnopqrstuvwxyz0123456789** for it",
      // security review H-1: name=value and name:value forms
      "STRIPE_SECRET_KEY=sk_live_51Habcdefghijklmnop",
      "token:ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "key:AKIAABCDEFGHIJKLMNOP",
      "https://api.example.com/v1?api_key=abcdefghijk123",
      "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "password: Hunter2-Correct-Horse-Battery",
      '"client_secret": "abcdefgh12345678"',
    ];
    for (const t of hits) expect(containsSecret(t), t).toBe(true);
  });
  it("lets ordinary text through", () => {
    const fine = [
      "See https://example.test/path?x=1 or mail a@example.test. Basic understanding of the work; skip secrets.",
      "Prefers replies under 100 words. Meetings 9-5 ET.",
      "# About me\nName: Synthetic Owner",
      "Reset the password: monthly, via the admin console.",
      "Token: see the vault entry for Stripe",
      "Meeting at 10:30, room=boardroom2",
      "",
    ];
    for (const t of fine) expect(containsSecret(t), t).toBe(false);
  });
});

describe("home lane (no lane code is hard-coded)", () => {
  it("keeps the lane that already holds About-Me", () => {
    expect(resolveHomeLane({ openLanes: ["AAA", "BBB", "CCC"], existingLaneId: "BBB", personalLaneId: "CCC", pickedLaneId: "AAA" })).toEqual({ ok: true, laneId: "BBB" });
  });
  it("prefers the Personal lane once it is open for the user, then the picked lane", () => {
    expect(resolveHomeLane({ openLanes: ["AAA", "CCC"], personalLaneId: "CCC", pickedLaneId: "AAA" })).toEqual({ ok: true, laneId: "CCC" });
    expect(resolveHomeLane({ openLanes: ["AAA", "BBB"], personalLaneId: "CCC", pickedLaneId: "BBB" })).toEqual({ ok: true, laneId: "BBB" });
  });
  it("ignores Personal and picked lanes the user cannot open", () => {
    expect(resolveHomeLane({ openLanes: ["AAA"], personalLaneId: "CCC", pickedLaneId: "YYY" })).toEqual({ ok: true, laneId: "AAA" });
  });
  it("never moves the home lane silently when the existing About-Me lane can no longer be opened", () => {
    expect(resolveHomeLane({ openLanes: ["AAA"], existingLaneId: "ZZZ", personalLaneId: "AAA", pickedLaneId: "AAA" })).toEqual({ ok: false, reason: "home_lane_unavailable" });
  });
  it("uses the only open lane, asks when several are open and none is chosen, and fails with none", () => {
    expect(resolveHomeLane({ openLanes: ["AAA"] })).toEqual({ ok: true, laneId: "AAA" });
    expect(resolveHomeLane({ openLanes: ["AAA", "BBB"] })).toEqual({ ok: false, reason: "needs_pick" });
    expect(resolveHomeLane({ openLanes: [], pickedLaneId: "AAA" })).toEqual({ ok: false, reason: "no_lane" });
  });
});

describe("seed templates", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { recursive: true })
      .map((f) => String(f).split(path.sep).join("/"))
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .sort();
  const dir = path.join(here, "..", "..", "templates");

  it("the generated bundle matches the files (run scripts/build-templates.mjs when this fails)", () => {
    const files = walk(dir);
    expect(Object.keys(TEMPLATE_FILES).sort()).toEqual(files);
    for (const f of files) expect(TEMPLATE_FILES[f], f).toBe(readFileSync(path.join(dir, f), "utf8"));
  });
  it("creates About-Me and Preferences in the home lane and Work in every lane", () => {
    expect(HOME_SEED_DOCUMENTS.map((d) => d.path)).toEqual([ABOUT_ME_PATH, PREFERENCES_PATH]);
    expect(LANE_SEED_DOCUMENTS.map((d) => d.path)).toEqual(["Context/Work.md"]);
    for (const d of [...HOME_SEED_DOCUMENTS, ...LANE_SEED_DOCUMENTS]) expect(isValidBrainPath(d.path), d.path).toBe(true);
  });
  it("has the two system skills, with valid keys", () => {
    expect(SEED_SKILLS.map((s) => s.key)).toEqual(["brain-maintenance", "project-handoff"]);
    for (const s of SEED_SKILLS) {
      expect(s.key).toMatch(/^[a-z][a-z0-9-]{1,59}$/);
      expect(s.title).toBe(s.title.trim());
      expect(s.body).toContain(`name: ${s.key}`);
    }
  });
  it("is synthetic placeholder text: no credential-like value, nothing from a real company, no Nichols Law document", () => {
    const all = [...Object.values(TEMPLATE_FILES), BRAIN_RULES_MD, PERSONAL_ASSISTANT_INSTRUCTIONS, PROJECT_TEMPLATES.brief, PROJECT_TEMPLATES.handoff];
    for (const t of all) {
      expect(containsSecret(t)).toBe(false);
      expect(utf8Bytes(t)).toBeLessThan(32_768);
    }
    expect(Object.keys(TEMPLATE_FILES).filter((f) => /nichols[-_ ]?law|(^|\/)NL(\/|[-.])/i.test(f))).toEqual([]);
  });
});
