// The interview engine (T-216): which questions to ask, which to skip, what is already set, and the view the UI renders.
// Pure. The bank is data (bank.ts); lane facts and page bodies come in as arguments.
import { employeeConfigSchema, type EmployeeConfig } from "../domain/employee-config";
import { DAY_OPTIONS, GROUPS, MAX_QUESTIONS_PER_GROUP, PA_SECTIONS, QUESTIONS, WORD_OPTIONS, questionsOf } from "./bank";
import { getSection, isProvided } from "./doc-edit";
import { SECTION_ORDER, afterMarker, laneOf, mailboxKey, selectedLanes, newConfig, type InterviewCtx } from "./answers";
import type { DocTarget, Field, FieldOption, Group, Question } from "./types";

/** Page bodies read for the user (null = no page yet). */
export type Docs = { about_me: string | null; preferences: string | null; work: string | null; pa: string | null };

export type SkipReason = "known" | "no_finance" | "no_web" | "no_drafts";
export type FieldView = Omit<Field, "into" | "optionsFrom" | "options"> & { options?: FieldOption[] };
export type QuestionView = {
  id: string;
  prompt: string;
  hint?: string;
  fields: FieldView[];
  /** ask = show the fields; known = "Already set: …" with an edit button; skipped = not asked (reason shown). */
  status: "ask" | "known" | "skipped";
  skipReason?: SkipReason;
  /** Human text of what is already set. */
  known?: string;
  prefill?: Record<string, unknown>;
};
export type GroupView = {
  id: string;
  part: "A" | "B";
  title: string;
  saves: string;
  questions: QuestionView[];
  /** Chat routing only (Part A: nothing left to ask; Part B: the draft employee exists). NOT progress: use `complete`. */
  done: boolean;
  /** Real progress (T-226): every required question is answered from stored state; optional ones never block. */
  complete: boolean;
};

const docBody = (docs: Docs, t: DocTarget): string | null => docs[t.doc];

/** Skip rules from the bank (spec brain-interview.md `skip_if`). Pure; `config` is the draft or stored employee config. */
export function skipReason(q: Question, docs: Docs, config: EmployeeConfig, ctx: InterviewCtx): SkipReason | null {
  switch (q.skip) {
    case "none":
      return null;
    case "known":
      return q.targets.length > 0 && q.targets.every((t) => isProvided(getSection(docBody(docs, t) ?? "", t.section))) ? "known" : null;
    case "no_finance": {
      const lanes = selectedLanes(config, ctx);
      return lanes.some((l) => l.financeView) ? null : "no_finance";
    }
    case "no_web":
      return selectedLanes(config, ctx).some((l) => l.policy.llm_allowed_categories.includes("web")) ? null : "no_web";
    case "no_drafts":
      return selectedLanes(config, ctx).some((l) => l.policy.store_outbound_drafts && (l.policy.write_actions_allowed.includes("email_draft") || l.policy.write_actions_allowed.includes("email_send")))
        ? null
        : "no_drafts";
  }
}

function lineValue(section: string | null, prefix: string): string {
  if (section === null) return "";
  const line = section.split("\n").find((l) => l.startsWith(prefix));
  const v = line === undefined ? "" : line.slice(prefix.length).trim();
  return isProvided(v) ? v : "";
}

/** The answers already stored for a question, as the form's values (empty object when nothing is stored). */
export function prefillFor(q: Question, docs: Docs, config: EmployeeConfig | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Page-backed fields.
  for (const f of q.fields) {
    const t = f.into;
    if (!t || (q.id === "B5" && f.key === "exceptions")) continue;
    const body = docBody(docs, t);
    const raw = t.line !== undefined ? lineValue(body === null ? null : getSection(body, t.section), t.line) : getSection(body ?? "", t.section);
    if (!isProvided(raw)) continue;
    if (f.kind === "select") {
      const hit = f.options?.find((o) => o.label === raw);
      if (hit) out[f.key] = hit.value;
      else if (!f.options) out[f.key] = raw;
    } else out[f.key] = raw;
  }
  if (q.part === "A" || config === null) return out;
  switch (q.id) {
    case "B2":
      out.mailboxes = [...config.sources.mail].sort((a, b) => a.priority - b.priority).map((m) => mailboxKey(m.lane, m.mailbox));
      break;
    case "B3":
      out.include = Object.fromEntries(config.sources.mail.map((m) => [mailboxKey(m.lane, m.mailbox), m.include.join("\n")]));
      break;
    case "B4":
      out.vip = config.sources.vip_senders.join("\n");
      break;
    case "B5":
      out.exclude = config.exclude;
      out.exceptions = afterMarker(getSection(docs.pa ?? "", PA_SECTIONS.leaveOut), "Exceptions:");
      break;
    case "B6":
      out.days_ahead = config.sources.calendar.days_ahead;
      out.prep = afterMarker(getSection(docs.pa ?? "", PA_SECTIONS.calendar), "Meetings that need prep:");
      break;
    case "B7":
      out.show = !config.sources.finance_alerts ? "none" : config.sources.finance_kpis.length === 0 ? "all" : "pick";
      out.kpis = config.sources.finance_kpis;
      break;
    case "B8":
      out.approvals = config.sources.approvals_pending;
      break;
    case "B9":
      out.topics = config.sources.external.flatMap((e) => e.topics).join("\n");
      break;
    case "B10":
      out.time = config.schedule.time ?? "";
      out.days = config.schedule.days.map(String);
      break;
    case "B11":
      out.delivery = config.delivery;
      break;
    case "B12":
      out.target_words = WORD_OPTIONS.some((o) => o.value === String(config.output.target_words)) ? String(config.output.target_words) : "500";
      out.max_attention = config.output.max_attention_items;
      out.sections = config.output.sections;
      break;
    case "B13":
      out.max_drafts = config.output.max_drafts;
      break;
  }
  return out;
}

const KPI_LABEL = (id: string): string => id.replace(/_/g, " ");
const SECTION_LABEL: Record<string, string> = {
  coverage: "Coverage",
  attention: "Needs your attention",
  calendar: "Calendar",
  deadlines: "Deadlines",
  money: "Money",
  finance_kpis: "Finance numbers",
  approvals: "Pending approvals",
  news: "Outside news",
  priorities: "Priorities",
  drafts: "Suggested replies",
  clarifications: "Questions for you",
};

function optionsFor(f: Field, config: EmployeeConfig, ctx: InterviewCtx): FieldOption[] | undefined {
  switch (f.optionsFrom) {
    case "timezones":
      return ctx.timezones.map((t) => ({ value: t, label: t }));
    case "mailboxes":
      // Every mailbox the user's lanes list; the connection state is a note, never a reason to hide it.
      return ctx.lanes.flatMap((l) =>
        l.mailboxes.map((m) => ({
          value: mailboxKey(l.laneId, m),
          label: `${m} (${l.name})`,
          note: l.connected === null ? ("unknown" as const) : l.connected.includes(m.toLowerCase()) ? ("connected" as const) : ("not_connected" as const),
        })),
      );
    case "kpis":
      return [...new Set(selectedLanes(config, ctx).flatMap((l) => [...l.kpis]))].map((k) => ({ value: k, label: KPI_LABEL(k) }));
    case "sections":
      return SECTION_ORDER.map((s) => ({ value: s, label: SECTION_LABEL[s] ?? s }));
    case undefined:
      return f.options ? [...f.options] : undefined;
  }
}

/** One-line text of stored answers for "Already set: …" and the review summary. */
export function describeAnswers(q: Question, prefill: Record<string, unknown>, config: EmployeeConfig, ctx: InterviewCtx): string | null {
  const parts: string[] = [];
  for (const f of q.fields) {
    const v = prefill[f.key];
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    const opts = optionsFor(f, config, ctx) ?? [];
    const label = (x: unknown): string => opts.find((o) => o.value === x)?.label ?? String(x);
    let text: string;
    if (f.kind === "boolean") text = v === true ? "yes" : "no";
    else if (f.kind === "multiselect" || f.kind === "mailbox_order") text = (v as unknown[]).map((x) => (f.key === "days" ? (DAY_OPTIONS.find((d) => d.value === x)?.label ?? String(x)) : label(x))).join(", ");
    else if (f.kind === "mailbox_text") text = Object.entries(v as Record<string, string>).filter(([, t]) => t.trim()).map(([k, t]) => `${k.split("|").slice(1).join("|")}: ${t.replace(/\s*\n\s*/g, "; ")}`).join(" | ");
    else if (f.kind === "select") text = label(v);
    else text = String(v).replace(/\s*\n\s*/g, "; ");
    if (text) parts.push(q.fields.length > 1 ? `${f.label}: ${text}` : text);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** A question that must be answered for its section to count as complete: it has at least one required field. Optional ones never block. */
export const isRequiredQuestion = (q: Question): boolean => q.fields.some((f) => f.required === true);

/**
 * Whether a question's answer is stored (T-226 progress). Part A: its page sections are provided. Part B: a page-backed or
 * free-text answer is provided, or a settings-backed answer differs from the default a fresh profile starts with (a field
 * still at its default is not known; there is no per-group marker). Without a stored profile no settings answer is known.
 */
export function questionKnown(q: Question, docs: Docs, stored: EmployeeConfig | null, defaults: EmployeeConfig): boolean {
  const own = prefillFor(q, docs, q.part === "B" ? stored : null);
  const text = (k: string): boolean => typeof own[k] === "string" && (own[k] as string).trim() !== "";
  if (q.fields.some((f) => (f.into !== undefined || f.kind === "text" || f.kind === "longtext") && text(f.key))) return true;
  if (q.part === "A" || stored === null) return false;
  const base = prefillFor(q, docs, defaults);
  return q.fields.filter((f) => f.into === undefined).some((f) => JSON.stringify(own[f.key]) !== JSON.stringify(base[f.key]));
}

export function storedConfig(raw: unknown, ctx: InterviewCtx): EmployeeConfig | null {
  if (raw === null || raw === undefined) return null;
  const parsed = employeeConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : newConfig(ctx);
}

/**
 * The groups and questions for the current state. `employeeConfig` is the stored employee's config or null before one
 * exists (then the Part B answers are all unknown). Never more than MAX_QUESTIONS_PER_GROUP questions per group.
 */
export function buildGroups(docs: Docs, employeeConfig: EmployeeConfig | null, ctx: InterviewCtx): GroupView[] {
  const config = employeeConfig ?? newConfig(ctx);
  return GROUPS.map((g: Group) => {
    const questions: QuestionView[] = questionsOf(g)
      .slice(0, MAX_QUESTIONS_PER_GROUP)
      .map((q) => {
        const skip = skipReason(q, docs, config, ctx);
        const prefill = prefillFor(q, docs, q.part === "B" ? employeeConfig : null);
        const known = describeAnswers(q, prefill, config, ctx);
        const fields: FieldView[] = q.fields.map((f) => {
          const { into: _into, optionsFrom: _from, options: _options, ...rest } = f;
          void _into;
          void _from;
          void _options;
          const options = optionsFor(f, config, ctx);
          return { ...rest, ...(options ? { options } : {}) };
        });
        const view: QuestionView = { id: q.id, prompt: q.prompt, fields, status: skip === "known" ? "known" : skip ? "skipped" : "ask" };
        if (q.hint) view.hint = q.hint;
        if (skip) view.skipReason = skip;
        if (known) view.known = known;
        if (Object.keys(prefill).length > 0) view.prefill = prefill;
        return view;
      });
    // Part A: done when every section is known. Part B has no per-group marker (no SQL): it counts as done once the
    // employee exists, for display only. Routing through the groups never uses this for Part B (the UI tracks the session).
    const defaults = newConfig(ctx);
    const asked = questionsOf(g)
      .slice(0, MAX_QUESTIONS_PER_GROUP)
      .map((q, i) => ({ q, view: questions[i] as QuestionView }))
      .filter((x) => x.view.status !== "skipped");
    const known = asked.filter((x) => (x.view.status === "known" ? true : questionKnown(x.q, docs, employeeConfig, defaults)));
    const required = asked.filter((x) => isRequiredQuestion(x.q));
    // A section with only optional questions needs at least one answer (an untouched section is never "complete").
    const complete = required.every((x) => known.includes(x)) && (required.length > 0 || known.length > 0);
    const done = g.part === "A" ? questions.every((qv) => qv.status !== "ask") : employeeConfig !== null;
    return { id: g.id, part: g.part, title: g.title, saves: g.saves, questions, done, complete };
  });
}

export { QUESTIONS, laneOf };
