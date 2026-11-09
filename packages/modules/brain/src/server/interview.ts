// Setup interview orchestration (T-216, spec brain-and-employees §7). The server side of the chat and Settings flows:
//   state    read-only: the questions, what is already set, what each source looks like
//   propose  read-only: the exact page / profile change a group's answers would make (the diff card). Writes NOTHING.
//   save     the user's Save click: re-plans from the CURRENT stored pages, refuses when it no longer matches the
//            proposal the user saw (proposalId), then writes through the store's reviewed writers only
//   confirm / activate  the review and activation steps (the test briefing waits for T-213)
// Every write goes through BrainStore (core.brain_* security-definer wrappers over the session-bound lane client): there
// is no service role here, no model call, and no external write. Answers are the user's own typed text; nothing here
// reads retrieved content. A model is never in this loop, so no model output can reach a save (rule 9).
import type { LaneId } from "@nichols/core";
import {
  ABOUT_ME_PATH,
  PERSONAL_ASSISTANT_INSTRUCTIONS,
  PREFERENCES_PATH,
  WORK_PATH,
  containsSecret,
  effectivePermissionsByLane,
  findSensitiveNumber,
  HOME_SEED_DOCUMENTS,
  LANE_SEED_DOCUMENTS,
  type ActionType,
  type EffectivePermissions,
  employeeConfigSchema,
  type EmployeeConfig,
} from "../domain/index";
import {
  PA_NAME,
  PA_ROLE_KEY,
  TEST_BRIEFING_AVAILABLE,
  TEST_BRIEFING_PENDING_MESSAGE,
  AnswerError,
  answerTexts,
  applyAnswers,
  buildGroups,
  diffLines,
  getSection,
  groupById,
  isProvided,
  newConfig,
  parseAnswers,
  questionById,
  questionsOf,
  setLine,
  setSection,
  skipReason,
  storedConfig,
  type Answers,
  type DiffLine,
  type Docs,
  type GroupView,
  type InterviewCtx,
  type SectionEdit,
} from "../interview/index";
import { BrainError } from "./errors";
import type { BrainEmployee, BrainStore } from "./store";

export type InterviewStore = Pick<BrainStore, "getDocument" | "saveDocument" | "listEmployees" | "saveEmployee" | "loadEmployeeConfig" | "listCompletions" | "completeSections">;
export type InterviewEnv = {
  store: InterviewStore;
  ctx: InterviewCtx;
  now: Date;
  /** The owner's role in a lane (the brain view is owner-only, so this is "owner" for every lane the caller can open it in). */
  roleFor?: (lane: string) => string;
};

/** A refusal that is not a store error: the answers name something this brain must not hold. */
export class InterviewRefusal extends Error {
  readonly code: "nichols_law" | "no_employee" | "nothing_to_activate" | "proposal_changed" | "unknown_group" | "instruction_text" | "profile_invalid" | "import_not_found" | "nothing_to_import";
  constructor(code: InterviewRefusal["code"]) {
    super(code);
    this.name = "InterviewRefusal";
    this.code = code;
  }
}

// Nichols Law content is out of scope (pilot-scope rule 13; interview rules). This is a deliberate, named exception to
// "no company-specific code" (rule 2): no lane_config or policy field lists excluded entities, so the term is one constant.
export const EXCLUDED_ENTITY_PATTERN = /nichols[\s\-_.&]*law/;

/** Folds a text so spacing, width and invisible-character tricks cannot hide the term: NFKC, no zero-width/soft hyphen, lower case. */
export function foldForScreen(text: string): string {
  return text.normalize("NFKC").replace(/[\u200b-\u200f\u2060-\u2064\ufeff\u00ad\u034f\u180e]/g, "").toLowerCase();
}

/** Screens answer text before anything is planned: credentials, SSN / card / bank numbers (store rules) and Nichols Law content (out of scope). */
export function screenAnswers(answers: Answers): void {
  for (const t of answerTexts(answers)) {
    if (containsSecret(t)) throw new BrainError("secret");
    const kind = findSensitiveNumber(t.normalize("NFKC").replace(/[\u200b-\u200f\u2060-\u2064\ufeff\u00ad]/g, ""));
    if (kind !== null) throw new BrainError(`sensitive_${kind}`);
    if (EXCLUDED_ENTITY_PATTERN.test(foldForScreen(t))) throw new InterviewRefusal("nichols_law");
  }
}

// ---------------------------------------------------------------------------------------------------- reading

type DocRead = { body: string | null; version: number };
export type Snapshot = {
  docs: Docs;
  versions: Record<"about_me" | "preferences" | "work", number>;
  employee: BrainEmployee | null;
  config: EmployeeConfig | null;
  /** The stored employee config fails the schema: never silently replaced by defaults (the diff card says so). */
  configInvalid: boolean;
};

export const seedBody = (path: string): string => [...HOME_SEED_DOCUMENTS, ...LANE_SEED_DOCUMENTS].find((d) => d.path === path)?.body ?? "";

async function readDoc(env: InterviewEnv, lane: LaneId, path: string): Promise<DocRead> {
  const d = await env.store.getDocument(lane, path);
  return d !== null && d.isMine ? { body: d.body, version: d.version } : { body: null, version: 0 };
}

export async function snapshot(env: InterviewEnv): Promise<Snapshot> {
  const { home, current } = env.ctx;
  const [about, prefs, work, employees] = await Promise.all([
    readDoc(env, home, ABOUT_ME_PATH),
    readDoc(env, home, PREFERENCES_PATH),
    readDoc(env, current, WORK_PATH),
    env.store.listEmployees(home),
  ]);
  const employee = employees.find((e) => e.isMine && e.roleKey === PA_ROLE_KEY) ?? null;
  return {
    docs: { about_me: about.body, preferences: prefs.body, work: work.body, pa: employee?.instructions ?? null },
    versions: { about_me: about.version, preferences: prefs.version, work: work.version },
    employee,
    config: employee ? storedConfig(employee.config, env.ctx) : null,
    configInvalid: employee ? !employeeConfigSchema.safeParse(employee.config).success : false,
  };
}

/** The timezone for a new employee: the confirmed About-Me one when it is a real IANA zone, else the schema default. */
export function timezoneFrom(docs: Docs, ctx: InterviewCtx): string | undefined {
  const tz = getSection(docs.about_me ?? "", "Timezone");
  return isProvided(tz) && ctx.timezones.includes(tz as string) ? (tz as string) : undefined;
}

// ---------------------------------------------------------------------------------------------------- planning

export type SettingChange = { path: string; before: string; after: string };
export type ChangeView =
  | { kind: "document"; lane: string; path: string; baseVersion: number; diff: DiffLine[] }
  | { kind: "employee"; lane: string; name: string; status: string; baseVersion: number; diff: DiffLine[]; settings: SettingChange[]; resetsInvalid: boolean };

export type Write =
  | { kind: "document"; lane: LaneId; path: string; body: string; baseVersion: number }
  | { kind: "employee"; lane: LaneId; body: Parameters<InterviewStore["saveEmployee"]>[1]; baseVersion: number };

type Plan = { views: ChangeView[]; writes: Write[]; digest: string };

const flatten = (v: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> => {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  else out[prefix] = Array.isArray(v) ? JSON.stringify(v) : String(v);
  return out;
};
export function settingChanges(before: unknown, after: unknown): SettingChange[] {
  const b = flatten(before);
  const a = flatten(after);
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  return keys.flatMap((k) => (b[k] === a[k] ? [] : [{ path: k, before: b[k] ?? "(not set)", after: a[k] ?? "(not set)" }]));
}

const applyEdit = (body: string, e: SectionEdit): string => (e.target.line === undefined ? setSection(body, e.target.section, e.text) : setLine(body, e.target.section, e.target.line, e.text));

/** Keeps the profile's derived lines (header, reply count, sections and length) in step with the config. */
export function refreshPaDerived(body: string, config: EmployeeConfig, meta: { date: string; version: number; status: string }): string {
  let out = body.replace(/^Last updated:.*$/m, `Last updated: ${meta.date} (version ${String(meta.version)}). Status: ${meta.status}.`);
  out = out.replace(/^- Suggest replies only for emails that need me\..*$/m, `- Suggest replies only for emails that need me. Up to ${String(config.output.max_drafts)} per briefing; a draft is written only when I tap "Draft reply".`);
  const sections = [...new Set(["coverage", ...config.output.sections])].join(", ");
  out = setSection(out, "6. Output format", `Sections, in order: ${sections}. Target length: ${String(config.output.target_words)} words before drafts. Coverage is always shown.`);
  return out;
}

/** The "Last updated: <date>" header is left out of the proposal digest, so a proposal made before midnight still saves after it. */
export const stripDate = (body: string): string => body.replace(/^Last updated:.*$/m, "");

export async function digestOf(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const questionOf = (id: string) => {
  const q = questionById(id);
  if (q === undefined) throw new InterviewRefusal("unknown_group");
  return q;
};

async function plan(env: InterviewEnv, groupId: string, raw: Record<string, unknown>, snap: Snapshot, statusOverride?: "active"): Promise<Plan> {
  const group = groupById(groupId);
  if (!group) throw new InterviewRefusal("unknown_group");
  const questions = questionsOf(group);
  const config0 = snap.config ?? newConfig(env.ctx, timezoneFrom(snap.docs, env.ctx));
  const parsed: [string, Answers][] = [];
  const issues: AnswerError["issues"] = [];
  for (const [qid, a] of Object.entries(raw)) {
    const q = questions.find((x) => x.id === qid);
    const skip = q ? skipReason(q, snap.docs, config0, env.ctx) : null;
    if (!q || (skip !== null && skip !== "known")) {
      issues.push({ code: "unknown_question", path: qid });
      continue;
    }
    parsed.push([qid, parseAnswers(q, a)]);
  }
  if (issues.length > 0) throw new AnswerError(issues);
  for (const [, a] of parsed) screenAnswers(a);
  // Order of the bank, not of the request.
  parsed.sort((x, y) => group.questionIds.indexOf(x[0]) - group.questionIds.indexOf(y[0]));

  if (group.part === "A") {
    const docKey = (questionById(group.questionIds[0] as string)?.targets[0]?.doc ?? "about_me") as "about_me" | "preferences" | "work";
    const lane = docKey === "work" ? env.ctx.current : env.ctx.home;
    const path = docKey === "about_me" ? ABOUT_ME_PATH : docKey === "preferences" ? PREFERENCES_PATH : WORK_PATH;
    const before = snap.docs[docKey] ?? seedBody(path).replace("{{lane_name}}", env.ctx.lanes.find((l) => l.laneId === lane)?.name ?? lane);
    let after = before;
    for (const [qid, a] of parsed) {
      for (const e of applyAnswers(questionOf(qid), a, config0, env.ctx)) after = applyEdit(after, e);
    }
    const views: ChangeView[] = [];
    const writes: Write[] = [];
    if (after !== before) {
      const baseVersion = snap.versions[docKey];
      views.push({ kind: "document", lane, path, baseVersion, diff: diffLines(before, after) });
      writes.push({ kind: "document", lane, path, body: after, baseVersion });
    }
    // A4 (timezone) is also config.timezone of an existing employee, so the briefing schedule follows it.
    const tz = parsed.find(([id]) => id === "A4")?.[1].timezone;
    const emp = snap.employee;
    if (typeof tz === "string" && emp !== null && snap.config !== null && !snap.configInvalid && snap.config.timezone !== tz) {
      const next = structuredClone(snap.config);
      next.timezone = tz;
      const checked = await env.store.loadEmployeeConfig(env.ctx.home, next);
      const date = env.now.toISOString().slice(0, 10);
      const prose = refreshPaDerived(emp.instructions, checked, { date, version: emp.version + 1, status: emp.status });
      views.push({
        kind: "employee",
        lane: env.ctx.home,
        name: emp.name,
        status: emp.status,
        baseVersion: emp.version,
        diff: diffLines(emp.instructions, prose),
        settings: settingChanges(snap.config, checked),
        resetsInvalid: false,
      });
      writes.push({ kind: "employee", lane: env.ctx.home, baseVersion: emp.version, body: { roleKey: emp.roleKey, name: emp.name, instructions: prose, config: checked, status: emp.status } });
    }
    if (writes.length === 0) return { views: [], writes: [], digest: await digestOf({ groupId, none: true }) };
    return { views, writes, digest: await digestOf({ groupId, writes: writes.map((w) => (w.kind === "document" ? { l: w.lane, p: w.path, v: w.baseVersion, b: w.body } : { l: w.lane, v: w.baseVersion, b: stripDate(w.body.instructions), c: w.body.config, s: w.body.status })) }) };
  }

  // Part B: the employee profile (prose + config) in the home lane.
  const config: EmployeeConfig = structuredClone(config0);
  const before = snap.docs.pa ?? PERSONAL_ASSISTANT_INSTRUCTIONS;
  let prose = before;
  for (const [qid, a] of parsed) {
    for (const e of applyAnswers(questionOf(qid), a, config, env.ctx)) prose = applyEdit(prose, e);
  }
  const status = statusOverride ?? snap.employee?.status ?? "draft";
  const baseVersion = snap.employee?.version ?? 0;
  const checked = await env.store.loadEmployeeConfig(env.ctx.home, config); // schema + lane_config cross-checks; throws EmployeeConfigError
  const date = env.now.toISOString().slice(0, 10);
  prose = refreshPaDerived(prose, checked, { date, version: baseVersion + 1, status });
  if (snap.employee && !snap.configInvalid && stripDate(prose) === stripDate(snap.employee.instructions) && JSON.stringify(checked) === JSON.stringify(snap.config) && status === snap.employee.status) {
    return { views: [], writes: [], digest: await digestOf({ groupId, none: true }) };
  }
  const settings = settingChanges(snap.config ?? newConfig(env.ctx, timezoneFrom(snap.docs, env.ctx)), checked);
  return {
    views: [{ kind: "employee", lane: env.ctx.home, name: PA_NAME, status, baseVersion, diff: diffLines(before, prose), settings, resetsInvalid: snap.configInvalid }],
    writes: [{ kind: "employee", lane: env.ctx.home, baseVersion, body: { roleKey: PA_ROLE_KEY, name: snap.employee?.name ?? PA_NAME, instructions: prose, config: checked, status } }],
    digest: await digestOf({ groupId, lane: env.ctx.home, baseVersion, prose: stripDate(prose), checked, status, reset: snap.configInvalid }),
  };
}

// ---------------------------------------------------------------------------------------------------- state

export type SourceView = {
  laneId: string;
  laneName: string;
  /** Where to connect: the only place (spec §8.2). The chat links here and never connects. */
  settingsPath: string;
  mailboxes: { address: string; state: "connected" | "not_connected" | "unknown" }[];
  noMailboxes: boolean;
};

export type EmployeeView = {
  name: string;
  status: string;
  version: number;
  /** The stored config fails validation: it can only be replaced through a diff card that says so. */
  invalid: boolean;
  permissions: { lane: string; laneName: string; allowed: string[]; denied: { type: string; reason: string }[] }[];
};

export type InterviewState = {
  homeLane: string;
  currentLane: string;
  groups: GroupView[];
  employee: EmployeeView | null;
  sources: SourceView[];
  testBriefing: { available: boolean; message: string };
  nextGroupId: string | null;
};

export const settingsPathFor = (laneId: string): string => `/${laneId}/settings#connections`;

async function employeeView(env: InterviewEnv, snap: Snapshot): Promise<EmployeeView | null> {
  const emp = snap.employee;
  if (emp === null) return null;
  let perms: Record<string, EffectivePermissions> = {};
  try {
    // Re-validated like a run would (fail closed): an invalid stored config shows no permissions at all.
    const config = await env.store.loadEmployeeConfig(env.ctx.home, emp.config);
    perms = effectivePermissionsByLane(
      config.permissions.propose as ActionType[],
      config.lanes,
      (l) => {
        const p = env.ctx.lanes.find((x) => x.laneId === l)?.policy;
        return { write_actions_allowed: p?.write_actions_allowed ?? [], store_outbound_drafts: p?.store_outbound_drafts ?? false };
      },
      (l) => env.roleFor?.(l) ?? "owner",
    );
  } catch {
    perms = {};
  }
  return {
    name: emp.name,
    status: emp.status,
    version: emp.version,
    invalid: snap.configInvalid,
    permissions: Object.entries(perms).map(([lane, p]) => ({ lane, laneName: env.ctx.lanes.find((l) => l.laneId === lane)?.name ?? lane, allowed: p.allowed, denied: p.denied })),
  };
}

export function sourcesView(ctx: InterviewCtx): SourceView[] {
  return ctx.lanes.map((l) => ({
    laneId: l.laneId,
    laneName: l.name,
    settingsPath: settingsPathFor(l.laneId),
    noMailboxes: l.mailboxes.length === 0,
    mailboxes: l.mailboxes.map((m) => ({ address: m, state: l.connected === null ? "unknown" : l.connected.includes(m.toLowerCase()) ? "connected" : "not_connected" })),
  }));
}

/**
 * The state the setup UI renders. It reads and, the first time only, backfills completion (see `withCompletion`): the one
 * write this function can make, to the caller's own completion rows. No page or profile is created or saved here (seed pages
 * are only the base of a diff until the user saves).
 */
export async function loadInterviewState(env: InterviewEnv): Promise<InterviewState> {
  const snap = await snapshot(env);
  const groups = await withCompletion(env, buildGroups(snap.docs, snap.config, env.ctx));
  return {
    homeLane: env.ctx.home,
    currentLane: env.ctx.current,
    groups,
    employee: await employeeView(env, snap),
    sources: sourcesView(env.ctx),
    testBriefing: { available: TEST_BRIEFING_AVAILABLE, message: TEST_BRIEFING_PENDING_MESSAGE },
    // Chat routing: sections the user already finished (Save or Nothing to add) are not asked again; Edit still opens them.
    nextGroupId: groups.find((g) => !g.done && !g.complete)?.id ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------- completion (T-227)
// Completion is stored: a section is complete when the user clicked Save on it (even with every value a kept default) or
// "Nothing to add". `GroupView.derivedComplete` (T-226's rule over the saved answers) exists only for the one-time backfill of
// answers saved before T-227: while the user has NO completion rows in the home lane, the sections that rule counts complete
// are recorded through the same writer. The backfill only ever runs with the full interview context: from `loadInterviewState`
// (the POST `state` action) and as part of the first Save or Nothing to add (in the SAME write as the new section, so a fresh
// click can never become the first row ahead of an unfinished backfill). Pure reads (`loadProgress`: menu, Home, More,
// Settings) never write; until rows exist they show the derived value. Idempotent in SQL (`on conflict do nothing`), so
// concurrent loads are safe. An unreadable completion shows nothing complete (fail safe), never a guess.

export const logCompletionFailure = (what: string, e: unknown): void => {
  console.error(`[brain-interview] ${what}:`, e instanceof Error ? e.name : typeof e); // class only, no values
};

/** The caller's stored completion in the home lane, or null when it cannot be read. */
export async function readCompletions(env: InterviewEnv): Promise<string[] | null> {
  try {
    return await env.store.listCompletions(env.ctx.home);
  } catch (e) {
    logCompletionFailure("completion unreadable", e);
    return null;
  }
}

/** The derived-complete sections to record, only while the user has no rows at all. */
export const pendingBackfill = (groups: readonly GroupView[], stored: readonly string[] | null): string[] =>
  stored !== null && stored.length === 0 ? groups.filter((g) => g.derivedComplete).map((g) => g.id) : [];

/** `complete` from the stored rows; with no rows yet, the derived value (what the backfill will record). */
function applyCompletion(groups: GroupView[], stored: readonly string[] | null): GroupView[] {
  if (stored === null) return groups.map((g) => ({ ...g, complete: false }));
  const ids = new Set(stored.length > 0 ? stored : groups.filter((g) => g.derivedComplete).map((g) => g.id));
  return groups.map((g) => ({ ...g, complete: ids.has(g.id) }));
}

async function withCompletion(env: InterviewEnv, groups: GroupView[]): Promise<GroupView[]> {
  let stored = await readCompletions(env);
  const pending = pendingBackfill(groups, stored);
  if (pending.length > 0) {
    try {
      stored = await env.store.completeSections(env.ctx.home, pending);
    } catch (e) {
      logCompletionFailure("completion backfill failed", e); // the next full-context load or Save retries
    }
  }
  return applyCompletion(groups, stored);
}

/** Section progress only (menu badge, Home banner, More, Settings). READ-ONLY: never writes, even to backfill. */
export async function loadProgress(env: InterviewEnv): Promise<{ id: string; title: string; complete: boolean }[]> {
  const snap = await snapshot(env);
  const groups = applyCompletion(buildGroups(snap.docs, snap.config, env.ctx), await readCompletions(env));
  return groups.map((g) => ({ id: g.id, title: g.title, complete: g.complete }));
}

// ---------------------------------------------------------------------------------------------------- propose / save

export type Proposal = { groupId: string; saves: string; changes: ChangeView[]; proposalId: string };

/** The diff card. Writes nothing. Throws AnswerError / BrainError / EmployeeConfigError / InterviewRefusal. */
export async function proposeGroup(env: InterviewEnv, groupId: string, answers: Record<string, unknown>): Promise<Proposal> {
  const snap = await snapshot(env);
  const p = await plan(env, groupId, answers, snap);
  return { groupId, saves: groupById(groupId)?.saves ?? "", changes: p.views, proposalId: p.digest };
}

/**
 * The user's Save click. Re-plans from what is stored NOW and refuses unless the result is exactly the proposal the user
 * saw (same pages, same versions, same text). The version check in the writer then catches a concurrent edit.
 */
export async function saveGroup(env: InterviewEnv, groupId: string, answers: Record<string, unknown>, proposalId: string): Promise<{ saved: number; completed: boolean }> {
  const snap = await snapshot(env);
  const p = await plan(env, groupId, answers, snap);
  if (p.digest !== proposalId) throw new InterviewRefusal("proposal_changed");
  // Backfill basis: the sections the saved answers made complete BEFORE this write, recorded together with this one.
  const backfill = pendingBackfill(buildGroups(snap.docs, snap.config, env.ctx), await readCompletions(env));
  let saved = 0;
  for (const w of p.writes) {
    if (w.kind === "document") await env.store.saveDocument(w.lane, w.path, w.body, w.baseVersion);
    else await env.store.saveEmployee(w.lane, w.body, w.baseVersion);
    saved++;
  }
  // The click on Save is what completes the section, even when nothing changed (every value a kept default). If only this
  // step fails the answers ARE saved: say so (completed: false) instead of an error; clicking Save again records it.
  try {
    await env.store.completeSections(env.ctx.home, [...backfill, groupId]);
  } catch (e) {
    logCompletionFailure("completion not recorded after a save", e);
    return { saved, completed: false };
  }
  return { saved, completed: true };
}

/** "Nothing to add": marks the section done and writes no brain page. Its answers stay "Not provided"; nothing is guessed. */
export async function completeGroup(env: InterviewEnv, groupId: string): Promise<{ completed: string }> {
  if (groupById(groupId) === undefined) throw new InterviewRefusal("unknown_group");
  const snap = await snapshot(env);
  const backfill = pendingBackfill(buildGroups(snap.docs, snap.config, env.ctx), await readCompletions(env));
  await env.store.completeSections(env.ctx.home, [...backfill, groupId]);
  return { completed: groupId };
}

// ---------------------------------------------------------------------------------------------------- review and activate

/** The review step: the stored profile must pass every check a run applies. Read-only. */
export async function confirmSetup(env: InterviewEnv): Promise<{ employee: EmployeeView; testBriefing: InterviewState["testBriefing"] }> {
  const snap = await snapshot(env);
  if (snap.employee === null) throw new InterviewRefusal("no_employee");
  await env.store.loadEmployeeConfig(env.ctx.home, snap.employee.config); // throws EmployeeConfigError: fail closed
  const employee = await employeeView(env, snap);
  if (employee === null) throw new InterviewRefusal("no_employee");
  return { employee, testBriefing: { available: TEST_BRIEFING_AVAILABLE, message: TEST_BRIEFING_PENDING_MESSAGE } };
}

/**
 * Activation (the user's click). Re-validates the stored config, then saves the same profile with status `active`.
 * Until T-213 the test briefing cannot run, so it is not required; once it exists, activation will need it.
 */
export async function activateEmployee(env: InterviewEnv): Promise<{ status: "active" }> {
  const snap = await snapshot(env);
  const emp = snap.employee;
  if (emp === null || snap.config === null) throw new InterviewRefusal("no_employee");
  if (emp.status === "active") throw new InterviewRefusal("nothing_to_activate");
  const checked = await env.store.loadEmployeeConfig(env.ctx.home, emp.config);
  const date = env.now.toISOString().slice(0, 10);
  const instructions = refreshPaDerived(emp.instructions, checked, { date, version: emp.version + 1, status: "active" });
  await env.store.saveEmployee(env.ctx.home, { roleKey: emp.roleKey, name: emp.name, instructions, config: checked, status: "active" }, emp.version);
  return { status: "active" };
}

