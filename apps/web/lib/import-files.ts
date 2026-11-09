// Reading the user's files IN THE BROWSER for the memory import (T-220, D-39). Nothing here talks to the network: a file is read
// into memory, reduced to the text the user selects, and only that text (at most 50,000 characters) is ever posted. No file, zip
// or raw text is stored by Jarvis. Pure functions over bytes or strings so they are unit-tested; the UI calls them with a File's
// contents. Zip limits (a brain folder is a handful of small .md files): the file at most 10 MB, at most 200 entries, each page
// we read at most 1 MB inflated (more is treated as a zip bomb) and in practice at most 48 KB (a page limit), at most 20 MB inflated
// in total, no `..`, absolute or drive paths, and only .md files under Context/, Employees/ and Projects/ are considered.
import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from "fflate";
import type { ImportTarget } from "@nichols/brain/import";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PASTE_CHARS = 50_000;
export const MAX_ZIP_ENTRIES = 200;
export const MAX_ZIP_TOTAL_BYTES = 20 * 1024 * 1024;
/** More than this inflated from one entry means a zip bomb: the whole zip is refused. */
export const MAX_ZIP_ENTRY_BYTES = 1024 * 1024;
/** A page larger than this is skipped with a note (the brain's page limit is 32 KB; 48,000 bytes is under the 50,000-character request limit). */
export const MAX_PAGE_BYTES = 48_000;
/** Compressed bytes fed at a time: a deflate stream inflates at most about 1000:1, so memory stays bounded whatever the headers claim. */
const SLICE = 4096;

export type ZipError = "too_many_entries" | "too_large" | "unsafe_path" | "unreadable" | "empty";
export const ZIP_ERROR_TEXT: Record<ZipError, string> = {
  too_many_entries: "This .zip has too many files to be an AI Brain folder (limit 200). Zip only the Context, Employees and Projects folders.",
  too_large: "This .zip unpacks to far more than a brain folder should. It was not read.",
  unsafe_path: "This .zip contains file paths that point outside the folder, so it was not read.",
  unreadable: "This file could not be read as a .zip.",
  empty: "No importable pages were found. Expected Context/About-Me.md, Context/Preferences.md, Context/Work.md or Employees/Personal-Assistant.md.",
};

export type ZipPage = { target: ImportTarget; path: string; text: string };
export type ZipResult = { ok: true; pages: ZipPage[]; notes: string[] } | { ok: false; error: ZipError };

const TOP = ["Context", "Employees", "Projects", "Skills"];
const PAGE_FOR: Record<string, ImportTarget> = {
  "Context/About-Me.md": "about_me",
  "Context/Preferences.md": "preferences",
  "Context/Work.md": "work",
  "Employees/Personal-Assistant.md": "pa",
};

/** `null` for a path that is unsafe anywhere in the archive; otherwise the path with one wrapping folder removed. */
export function safePath(raw: string): string | null {
  if (raw.includes("\u0000")) return null;
  const p = raw.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split("/");
  if (parts.some((s) => s === "..")) return null;
  const clean = parts.filter((s) => s !== "" && s !== ".");
  // A zipped folder usually wraps everything in one folder ("MyBrain/Context/..."): accept exactly one.
  if (clean.length > 1 && !TOP.includes(clean[0] as string) && TOP.includes(clean[1] as string)) clean.shift();
  return clean.join("/") + (p.endsWith("/") ? "/" : "");
}

/** Reads the importable pages of a brain-folder .zip. Never throws; refuses what looks like a bomb or a traversal. */
export function readBrainZip(bytes: Uint8Array): ZipResult {
  if (bytes.length === 0) return { ok: false, error: "unreadable" };
  if (bytes.length > MAX_FILE_BYTES) return { ok: false, error: "too_large" };
  let entries = 0;
  let total = 0;
  let abort: ZipError | null = null;
  let ignored = 0;
  let oversized = 0;
  const unsupported: string[] = [];
  const collected = new Map<string, Uint8Array[]>();
  const fail = (e: ZipError, f?: UnzipFile) => {
    abort ??= e;
    f?.terminate();
  };

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (f) => {
    if (abort) return f.terminate();
    entries++;
    if (entries > MAX_ZIP_ENTRIES) return fail("too_many_entries", f);
    const path = safePath(f.name);
    if (path === null) return fail("unsafe_path", f);
    if (path.endsWith("/")) return; // a folder
    const known = PAGE_FOR[path];
    const top = path.split("/")[0] ?? "";
    if (!path.endsWith(".md") || !["Context", "Employees", "Projects"].includes(top) || known === undefined) {
      if (path.endsWith(".md") && top === "Employees") unsupported.push(path);
      else ignored++;
      return; // never decompressed
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    f.ondata = (err, chunk) => {
      if (err) return fail("unreadable", f);
      size += chunk.length;
      total += chunk.length;
      if (size > MAX_ZIP_ENTRY_BYTES || total > MAX_ZIP_TOTAL_BYTES) return fail("too_large", f);
      chunks.push(chunk.slice());
    };
    collected.set(path, chunks);
    f.start();
  };
  try {
    for (let i = 0; i < bytes.length && abort === null; i += SLICE) unzip.push(bytes.subarray(i, Math.min(i + SLICE, bytes.length)), i + SLICE >= bytes.length);
  } catch {
    return { ok: false, error: abort ?? "unreadable" };
  }
  if (abort !== null) return { ok: false, error: abort };

  const pages: ZipPage[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (const [path, chunks] of collected) {
    const size = chunks.reduce((n, c) => n + c.length, 0);
    if (size > MAX_PAGE_BYTES) {
      oversized++;
      continue;
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.length;
    }
    const text = decoder.decode(all).replace(/^﻿/, "");
    if (text.trim() !== "") pages.push({ target: PAGE_FOR[path] as ImportTarget, path, text });
  }
  if (pages.length === 0 && oversized === 0) return { ok: false, error: entries === 0 ? "unreadable" : "empty" };
  const notes: string[] = [];
  if (oversized > 0) notes.push(`${String(oversized)} page(s) were too large to import (limit 48 KB).`);
  if (unsupported.length > 0) notes.push(`${String(unsupported.length)} other employee file(s) were skipped: only the Personal Assistant profile can be imported for now.`);
  if (ignored > 0) notes.push(`${String(ignored)} other file(s) (such as Projects pages) are not imported yet.`);
  return { ok: true, pages: pages.sort((a, b) => a.path.localeCompare(b.path)), notes };
}

// ---------------------------------------------------------------------------------------------------- conversations.json

export type MemoryText = { found: true; text: string } | { found: false };

const PROFILE_KEYS = ["user_profile", "user_instructions", "model_set_context"] as const;

/**
 * The memory and custom-instruction parts of a ChatGPT export's conversations.json, if any. Full chat histories are NOT read: only
 * nodes whose content is the user's editable context (profile, instructions, memory). `found: false` means "paste your memory
 * list instead". Walks the structure with a node cap, so a hostile file cannot run long.
 */
export function chatGptMemory(json: unknown): MemoryText {
  const out: string[] = [];
  let nodes = 0;
  const seen = new Set<string>();
  const add = (s: unknown) => {
    if (typeof s !== "string") return;
    const t = s.trim();
    if (t !== "" && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  const visit = (v: unknown, depth: number): void => {
    if (nodes++ > 2_000_000 || depth > 12 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    const ct = o.content_type;
    if (ct === "user_editable_context" || ct === "model_editable_context") for (const k of PROFILE_KEYS) add(o[k]);
    for (const [k, x] of Object.entries(o)) if (k !== "parts") visit(x, depth + 1);
  };
  visit(json, 0);
  return out.length === 0 ? { found: false } : { found: true, text: out.join("\n\n") };
}

/** A .json file's text -> memory text, or a reason. The file is parsed in memory and dropped. */
export function memoryFromJsonFile(text: string): MemoryText | { found: false; invalid: true } {
  try {
    return chatGptMemory(JSON.parse(text) as unknown);
  } catch {
    return { found: false, invalid: true };
  }
}

/** The kind of file a name says it is; `null` = not accepted. */
export function fileKind(name: string): "text" | "json" | "zip" | null {
  const n = name.toLowerCase();
  if (n.endsWith(".txt") || n.endsWith(".md")) return "text";
  if (n.endsWith(".json")) return "json";
  if (n.endsWith(".zip")) return "zip";
  return null;
}
