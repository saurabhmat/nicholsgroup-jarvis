// Memory import (T-220, spec brain-and-employees §7a; D-39, D-40). The server side of "Import memories":
//   extract   the pasted / selected text (already bounded to 50,000 characters by the route) -> instruction-like sentences
//             removed -> the injected `extract` function (the fast model, in the request, untrusted-content wrapped) -> candidate
//             facts, screened -> the reviewed writer opens an import in review and stores the candidates (fact + a quote of at most
//             300 characters). The text itself is never stored, logged or sent to a job.
//   propose   read-only: the exact change the TICKED candidates would make to the pages (the same diff card as the interview)
//   save      the user's Save click: re-plans from the pages as they are NOW, refuses unless it equals the proposal the user
//             saw, writes through the store's reviewed writers, then finishes the import (its candidates are deleted) and
//             records the matching setup sections as done (T-227: only where a Save happened)
//   discard   the user closes the import without saving: every candidate is skipped and deleted
//   page_*    a brain-folder page (About-Me, Preferences, Work, Personal Assistant): no model; the importable sections become
//             a diff, saved only by an explicit click
// The model only proposes candidates; no model output reaches a page without the user's tick and Save, and the target page and
// section of a candidate always come from the stored candidate (the writer limits them to four pages and the user's lanes), never
// from the request. Request item ids are checked against the caller's own import. No external system is touched.
import type { LaneId } from "@nichols/core";
import { PA_NAME, PA_ROLE_KEY, newConfig, diffLines, buildGroups } from "../interview/index";
import { PERSONAL_ASSISTANT_INSTRUCTIONS } from "../domain/index";
import {
  IMPORT_TARGETS,
  TARGET_LABEL,
  applyPageEdit,
  buildCandidates,
  editsFromPage,
  groupsFor,
  isImportSection,
  isInstructionLike,
  laneFor,
  namesExcludedEntity,
  screenSensitive,
  stripInstructions,
  targetFromPath,
  type CandidateFlag,
  type DroppedCounts,
  type ImportSource,
  type ImportTarget,
  type PageEdit,
  type PageSkips,
} from "../import/index";
import { BrainError } from "./errors";
import {
  InterviewRefusal,
  digestOf,
  logCompletionFailure,
  pendingBackfill,
  readCompletions,
  refreshPaDerived,
  seedBody,
  settingChanges,
  snapshot,
  stripDate,
  timezoneFrom,
  type ChangeView,
  type InterviewEnv,
  type Snapshot,
  type Write,
} from "./interview";
import type { BrainStore } from "./store";

export type ImportStore = Pick<
  BrainStore,
  "getDocument" | "saveDocument" | "listEmployees" | "saveEmployee" | "loadEmployeeConfig" | "listCompletions" | "completeSections" | "createImport" | "listImportCandidates" | "decideImport"
>;
export type ImportEnv = Omit<InterviewEnv, "store"> & { store: ImportStore };

/** The model call, supplied by the route (so this module has no model dependency). Receives bounded, instruction-stripped text; returns the parsed JSON reply or throws. */
export type Extractor = (text: string) => Promise<unknown>;

export type ImportCandidateView = { id: string; fact: string; evidence: string | null; target: ImportTarget; targetLabel: string; section: string; flags: CandidateFlag[] };
export type ExtractResult = { importId: string | null; candidates: ImportCandidateView[]; dropped: DroppedCounts };
export type ImportProposal = { changes: ChangeView[]; proposalId: string };
export type PageProposal = ImportProposal & { target: ImportTarget; sections: string[]; skips: PageSkips };

// ---------------------------------------------------------------------------------------------------- extract

export async function extractCandidates(env: ImportEnv, source: ImportSource, text: string, extract: Extractor): Promise<ExtractResult> {
  const stripped = stripInstructions(text);
  const none = (dropped: DroppedCounts): ExtractResult => ({ importId: null, candidates: [], dropped });
  if (stripped.text === "") return none({ instructions: stripped.dropped, sensitive: 0, other: 0 });
  const reply = await extract(stripped.text); // throws on a refusal, a timeout or a broken reply: nothing is stored
  const { candidates, dropped } = buildCandidates(reply, stripped.text, { home: env.ctx.home, current: env.ctx.current }, stripped.dropped);
  if (candidates.length === 0) return none(dropped);
  const created = await env.store.createImport(
    env.ctx.home,
    source,
    candidates.map((c) => ({ fact: c.fact, evidence: c.evidence, targetPath: c.targetPath, targetSection: c.targetSection, targetLane: c.targetLane, flags: c.flags })),
  );
  if (created.candidateIds.length !== candidates.length) throw new BrainError("unavailable");
  return {
    importId: created.importId,
    dropped,
    candidates: candidates.map((c, i) => {
      const target = targetFromPath(c.targetPath) as ImportTarget;
      return { id: created.candidateIds[i] as string, fact: c.fact, evidence: c.evidence, target, targetLabel: TARGET_LABEL[target], section: c.targetSection, flags: c.flags };
    }),
  };
}

// ---------------------------------------------------------------------------------------------------- planning

type TickedItem = { id: string; text: string };

/** Screens text that is about to be written to a page: credentials and sensitive numbers, the Nichols Law name, instruction-like sentences. */
function screenForPage(text: string): void {
  const s = screenSensitive(text);
  if (!s.ok) throw new BrainError(s.reason);
  if (namesExcludedEntity(text)) throw new InterviewRefusal("nichols_law");
  if (isInstructionLike(text)) throw new InterviewRefusal("instruction_text");
}

/** The ticked candidates as page edits. Every id must be a candidate of the caller's own open import; target and section come from the stored row. */
async function editsFromTicked(env: ImportEnv, importId: string, items: readonly TickedItem[]): Promise<{ edits: PageEdit[]; touched: [ImportTarget, string][] }> {
  const stored = await env.store.listImportCandidates(env.ctx.home, importId);
  const byId = new Map(stored.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const groups = new Map<string, { target: ImportTarget; section: string; lines: string[] }>();
  for (const item of items) {
    const c = byId.get(item.id);
    const target = c ? targetFromPath(c.targetPath) : null;
    if (!c || target === null || c.targetSection === null || !isImportSection(target, c.targetSection) || c.targetLane !== laneFor(target, env.ctx) || seen.has(item.id)) {
      throw new InterviewRefusal("import_not_found"); // unknown, someone else's, already used, or for another lane
    }
    seen.add(item.id);
    const text = item.text.trim();
    if (text === "") throw new InterviewRefusal("import_not_found");
    screenForPage(text);
    const key = `${target}|${c.targetSection}`;
    const g = groups.get(key) ?? { target, section: c.targetSection, lines: [] };
    g.lines.push(text);
    groups.set(key, g);
  }
  const edits: PageEdit[] = [...groups.values()].map((g) => ({ target: g.target, section: g.section, op: "append", lines: g.lines }));
  return { edits, touched: edits.map((e) => [e.target, e.section]) };
}

const DOC_KEY = { about_me: "about_me", preferences: "preferences", work: "work" } as const;

type Planned = { views: ChangeView[]; writes: Write[]; digest: string };

/** Applies edits to the CURRENT pages and returns the exact diff, the writes and a digest of both. Writes nothing. */
async function planEdits(env: ImportEnv, edits: readonly PageEdit[], snap: Snapshot): Promise<Planned> {
  for (const e of edits) screenForPage(e.op === "append" ? e.lines.join("\n") : e.text);
  const views: ChangeView[] = [];
  const writes: Write[] = [];
  for (const target of IMPORT_TARGETS) {
    const mine = edits.filter((e) => e.target === target);
    if (mine.length === 0) continue;
    if (target !== "pa") {
      const key = DOC_KEY[target];
      const lane = laneFor(target, env.ctx) as LaneId;
      const path = target === "about_me" ? "Context/About-Me.md" : target === "preferences" ? "Context/Preferences.md" : "Context/Work.md";
      const before = snap.docs[key] ?? seedBody(path).replace("{{lane_name}}", env.ctx.lanes.find((l) => l.laneId === lane)?.name ?? lane);
      const after = mine.reduce(applyPageEdit, before);
      if (after === before) continue;
      const baseVersion = snap.versions[key];
      views.push({ kind: "document", lane, path, baseVersion, diff: diffLines(before, after) });
      writes.push({ kind: "document", lane, path, body: after, baseVersion });
      continue;
    }
    // The Personal Assistant profile: prose sections only; the permissions config is kept exactly as stored.
    if (snap.employee !== null && snap.configInvalid) throw new InterviewRefusal("profile_invalid");
    const config = structuredClone(snap.config ?? newConfig(env.ctx, timezoneFrom(snap.docs, env.ctx)));
    const before = snap.docs.pa ?? PERSONAL_ASSISTANT_INSTRUCTIONS;
    const status = snap.employee?.status ?? "draft";
    const baseVersion = snap.employee?.version ?? 0;
    const checked = await env.store.loadEmployeeConfig(env.ctx.home, config);
    let prose = mine.reduce(applyPageEdit, before);
    prose = refreshPaDerived(prose, checked, { date: env.now.toISOString().slice(0, 10), version: baseVersion + 1, status });
    if (snap.employee !== null && stripDate(prose) === stripDate(snap.employee.instructions)) continue;
    views.push({
      kind: "employee",
      lane: env.ctx.home,
      name: snap.employee?.name ?? PA_NAME,
      status,
      baseVersion,
      diff: diffLines(before, prose),
      settings: settingChanges(snap.config ?? newConfig(env.ctx, timezoneFrom(snap.docs, env.ctx)), checked),
      resetsInvalid: false,
    });
    writes.push({ kind: "employee", lane: env.ctx.home, baseVersion, body: { roleKey: PA_ROLE_KEY, name: snap.employee?.name ?? PA_NAME, instructions: prose, config: checked, status } });
  }
  const digest = await digestOf({
    imp: true,
    writes: writes.map((w) => (w.kind === "document" ? { l: w.lane, p: w.path, v: w.baseVersion, b: w.body } : { l: w.lane, v: w.baseVersion, b: stripDate(w.body.instructions), s: w.body.status })),
  });
  return { views, writes, digest };
}

async function writeAll(env: ImportEnv, writes: readonly Write[]): Promise<number> {
  let saved = 0;
  for (const w of writes) {
    if (w.kind === "document") await env.store.saveDocument(w.lane, w.path, w.body, w.baseVersion);
    else await env.store.saveEmployee(w.lane, w.body, w.baseVersion);
    saved++;
  }
  return saved;
}

/**
 * The setup sections a Save finishes (T-227): those that write a page section that received something, recorded in the home
 * lane together with the one-time backfill (see interview.ts). If only this step fails the pages ARE saved: reported, not thrown.
 */
async function recordSections(env: ImportEnv, snap: Snapshot, touched: readonly [ImportTarget, string][]): Promise<boolean> {
  const ids = [...new Set(touched.flatMap(([t, s]) => groupsFor(t, s)))];
  if (ids.length === 0) return true;
  try {
    const backfill = pendingBackfill(buildGroups(snap.docs, snap.config, env.ctx), await readCompletions(env as InterviewEnv));
    await env.store.completeSections(env.ctx.home, [...new Set([...backfill, ...ids])]);
    return true;
  } catch (e) {
    logCompletionFailure("completion not recorded after an import", e);
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------- propose / save / discard

export async function proposeImport(env: ImportEnv, importId: string, items: readonly TickedItem[]): Promise<ImportProposal> {
  const { edits } = await editsFromTicked(env, importId, items);
  const p = await planEdits(env, edits, await snapshot(env as InterviewEnv));
  return { changes: p.views, proposalId: p.digest };
}

export async function saveImport(env: ImportEnv, importId: string, items: readonly TickedItem[], proposalId: string): Promise<{ saved: number; completed: boolean; finished: boolean }> {
  const { edits, touched } = await editsFromTicked(env, importId, items);
  const snap = await snapshot(env as InterviewEnv);
  const p = await planEdits(env, edits, snap);
  if (p.digest !== proposalId) throw new InterviewRefusal("proposal_changed");
  const saved = await writeAll(env, p.writes);
  // Finish the import: ticked candidates are kept, every other one skipped, and ALL candidates are deleted (spec §7a).
  const all = await env.store.listImportCandidates(env.ctx.home, importId).catch(() => []);
  const ticked = new Set(items.map((i) => i.id));
  let finished = true;
  try {
    await env.store.decideImport(env.ctx.home, importId, all.map((c) => ({ id: c.id, decision: ticked.has(c.id) ? ("keep" as const) : ("skip" as const) })), true);
  } catch (e) {
    finished = false; // the hourly purge removes the candidates within 24 h
    logCompletionFailure("import not closed after a save", e);
  }
  return { saved, completed: await recordSections(env, snap, touched), finished };
}

/** "Discard": the user leaves without saving. Every candidate is skipped and deleted; nothing is written to a page. */
export async function discardImport(env: ImportEnv, importId: string): Promise<{ discarded: true }> {
  const all = await env.store.listImportCandidates(env.ctx.home, importId);
  if (all.length === 0) throw new InterviewRefusal("import_not_found");
  await env.store.decideImport(env.ctx.home, importId, all.map((c) => ({ id: c.id, decision: "skip" as const })), true);
  return { discarded: true };
}

// ---------------------------------------------------------------------------------------------------- brain-folder pages (no model)

export async function proposePage(env: ImportEnv, target: ImportTarget, text: string): Promise<PageProposal> {
  const { edits, skips } = editsFromPage(target, text);
  if (edits.length === 0) throw new InterviewRefusal("nothing_to_import");
  const p = await planEdits(env, edits, await snapshot(env as InterviewEnv));
  return { target, changes: p.views, proposalId: p.digest, sections: edits.map((e) => e.section), skips };
}

export async function savePage(env: ImportEnv, target: ImportTarget, text: string, proposalId: string): Promise<{ saved: number; completed: boolean }> {
  const { edits } = editsFromPage(target, text);
  if (edits.length === 0) throw new InterviewRefusal("nothing_to_import");
  const snap = await snapshot(env as InterviewEnv);
  const p = await planEdits(env, edits, snap);
  if (p.digest !== proposalId) throw new InterviewRefusal("proposal_changed");
  const saved = await writeAll(env, p.writes);
  return { saved, completed: await recordSections(env, snap, edits.map((e) => [e.target, e.section] as [ImportTarget, string])) };
}
