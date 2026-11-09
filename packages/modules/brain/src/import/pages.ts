// Page edits for imported text (T-220): appending ticked facts under a section, and replacing sections from a brain-folder
// page. Pure and client-safe. Only the fixed sections of targets.ts are ever touched; every other heading in an imported page
// is ignored, so an imported file cannot add sections, rules or anything the interview does not write.
import { cleanText, getSection, isProvided, oneLine, setSection } from "../interview/doc-edit";
import { isInstructionLike, namesExcludedEntity, screenSensitive, stripInstructions } from "./screen";
import { IMPORT_SECTIONS, type ImportTarget } from "./targets";

export type PageEdit =
  | { target: ImportTarget; section: string; op: "append"; lines: string[] }
  | { target: ImportTarget; section: string; op: "replace"; text: string };

const bullet = (s: string): string => `- ${s}`;

/** Appends fact lines to a section. A section that is still "Not provided" is replaced; a line already there is not repeated. */
export function appendToSection(body: string, section: string, facts: readonly string[]): string {
  const existing = getSection(body, section);
  const lines = facts.map((f) => bullet(oneLine(cleanText(f, 400)))).filter((l) => l !== "- ");
  if (!isProvided(existing)) return setSection(body, section, [...new Set(lines)].join("\n"));
  const have = new Set((existing ?? "").split("\n").map((l) => l.trim()));
  const add = [...new Set(lines)].filter((l) => !have.has(l));
  return add.length === 0 ? body : setSection(body, section, `${(existing ?? "").trimEnd()}\n${add.join("\n")}`);
}

export const applyPageEdit = (body: string, e: PageEdit): string => (e.op === "append" ? appendToSection(body, e.section, e.lines) : setSection(body, e.section, e.text));

const HEADING = /^## (.+?)\s*$/;

/** "## Heading" sections of a page (the first occurrence of a heading wins), trimmed. */
export function pageSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let head: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (head !== null && !out.has(head)) out.set(head, buf.join("\n").trim());
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const m = HEADING.exec(line);
    if (m) {
      flush();
      head = m[1] as string;
      buf = [];
    } else buf.push(line);
  }
  flush();
  return out;
}

export type PageSkips = {
  /** Sentences that read like instructions, left out of the imported sections. */
  instructions: number;
  /** Sections left out because they hold a credential or a sensitive number. */
  sensitive: number;
  /** Sections left out because they name Nichols Law. */
  nicholsLaw: number;
};

/**
 * Section replacements from one imported page. Only the target's importable sections that hold a real answer are taken;
 * instruction-like sentences are removed, and a section with a credential, a sensitive number or the Nichols Law name is left out whole.
 */
export function editsFromPage(target: ImportTarget, text: string): { edits: PageEdit[]; skips: PageSkips } {
  const skips: PageSkips = { instructions: 0, sensitive: 0, nicholsLaw: 0 };
  const edits: PageEdit[] = [];
  const sections = pageSections(text);
  for (const section of IMPORT_SECTIONS[target]) {
    const raw = sections.get(section);
    if (raw === undefined || !isProvided(raw)) continue;
    const kept: string[] = [];
    for (const line of raw.split("\n")) {
      // Keep the page's own line structure (bullets); drop only the sentences that read like orders.
      if (line.trim() === "") continue;
      const stripped = stripInstructions(line);
      skips.instructions += stripped.dropped;
      if (stripped.dropped === 0) kept.push(line.trimEnd());
      else if (stripped.text !== "" && !isInstructionLike(stripped.text)) kept.push(/^\s*[-*]\s/.test(line) ? `- ${stripped.text.replace(/\n/g, " ")}` : stripped.text.replace(/\n/g, " "));
    }
    const cleaned = cleanText(kept.join("\n"), 1500);
    if (cleaned === "" || !isProvided(cleaned)) continue;
    if (namesExcludedEntity(cleaned)) {
      skips.nicholsLaw++;
      continue;
    }
    if (!screenSensitive(cleaned).ok) {
      skips.sensitive++;
      continue;
    }
    edits.push({ target, section, op: "replace", text: cleaned });
  }
  return { edits, skips };
}
