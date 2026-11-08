// Section-level edits of the brain's markdown pages, and the line diff shown on the diff card (T-216). Pure.
// A page is "# Title" then "## Heading" sections; an answer replaces the body of exactly one section (or one line in it).
import type { DiffLine } from "./types";

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Owner-typed text made safe to place in a page: no control characters, no heading lines (an answer must not create sections). */
export function cleanText(input: string, max: number): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, "").replace(/^\s*#{1,6}(\s|$)/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max)
    .trim();
}

export const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();

const HEADING = /^## (.+?)\s*$/;

type Span = { start: number; end: number }; // line indexes: heading at start, body start+1 .. end-1

function findSection(lines: readonly string[], heading: string): Span | null {
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i] as string);
    if (m && m[1] === heading) {
      let end = i + 1;
      while (end < lines.length && !HEADING.test(lines[end] as string)) end++;
      return { start: i, end };
    }
  }
  return null;
}

/** The body of a section, trimmed; null when the page has no such heading. */
export function getSection(body: string, heading: string): string | null {
  const lines = body.split("\n");
  const span = findSection(lines, heading);
  return span === null ? null : lines.slice(span.start + 1, span.end).join("\n").trim();
}

/** True when a section holds a real answer: not empty and not a "Not provided." placeholder (with or without its hint). */
export function isProvided(section: string | null): boolean {
  if (section === null) return false;
  const t = section.trim();
  return t !== "" && !/^Not provided\b/i.test(t);
}

/** Replaces the body of a section (adds the section at the end when missing). Everything else is kept byte for byte. */
export function setSection(body: string, heading: string, text: string): string {
  const lines = body.split("\n");
  const span = findSection(lines, heading);
  if (span === null) return `${body.replace(/\s+$/, "")}\n\n## ${heading}\n${text}\n`;
  const head = lines.slice(0, span.start + 1);
  const rest = lines.slice(span.end); // starts at the next heading, or empty at the end of the page
  return [...head, ...text.split("\n"), "", ...rest].join("\n");
}

/** Replaces the one line of a section that starts with `prefix` (appended to the section when absent). */
export function setLine(body: string, heading: string, prefix: string, newLine: string): string {
  const lines = body.split("\n");
  const span = findSection(lines, heading);
  if (span === null) return setSection(body, heading, newLine);
  for (let i = span.start + 1; i < span.end; i++) {
    if ((lines[i] as string).startsWith(prefix)) {
      lines[i] = newLine;
      return lines.join("\n");
    }
  }
  let at = span.end;
  while (at > span.start + 1 && (lines[at - 1] as string).trim() === "") at--;
  lines.splice(at, 0, newLine);
  return lines.join("\n");
}

/** Line diff with one line of context. Unchanged runs longer than that collapse to a single "same" gap marker line. */
export function diffLines(before: string, after: string, context = 1): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = (i: number, j: number): number => lcs[i]?.[j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] ?? [];
    for (let j = m - 1; j >= 0; j--) row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  }
  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      all.push({ type: "same", text: a[i] as string });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      all.push({ type: "del", text: a[i++] as string });
    } else {
      all.push({ type: "add", text: b[j++] as string });
    }
  }
  while (i < n) all.push({ type: "del", text: a[i++] as string });
  while (j < m) all.push({ type: "add", text: b[j++] as string });

  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((l, k) => {
    if (l.type === "same") return;
    for (let d = -context; d <= context; d++) if (k + d >= 0 && k + d < all.length) keep[k + d] = true;
  });
  const out: DiffLine[] = [];
  let gap = false;
  all.forEach((l, k) => {
    if (keep[k]) {
      out.push(l);
      gap = false;
    } else if (!gap) {
      out.push({ type: "same", text: "…" });
      gap = true;
    }
  });
  return out;
}
