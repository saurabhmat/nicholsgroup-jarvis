// Validation of interview answers and how each lands in the draft employee config and the pages (T-216).
// Pure: lane facts (mailboxes, KPIs, policies) come in as `InterviewCtx`, read by the server from lane_config and
// lane_policies through the signed-in user's own lane client. The interview never writes lane_config or lane_policies.
import { z } from "zod";
import { KPI_IDS, email } from "@nichols/core/lane-config";
import { employeeConfigSchema, type EmployeeConfig } from "../domain/employee-config";
import { PA_SECTIONS } from "./bank";
import { cleanText, oneLine } from "./doc-edit";
import type { Answers, DocTarget, Field, Question } from "./types";

export type LaneInfo = {
  laneId: string;
  name: string;
  mailboxes: readonly string[];
  kpis: readonly string[];
  /** Lower-case addresses with a live connection; null = could not be read (never reported as "missing"). */
  connected: readonly string[] | null;
  policy: { write_actions_allowed: readonly string[]; store_outbound_drafts: boolean; llm_allowed_categories: readonly string[] };
  financeView: boolean;
};

export type InterviewCtx = {
  /** Where About-Me, Preferences and the employee live (home lane, spec §3). */
  home: string;
  /** The lane the chat or Settings page is open in (its Work page). */
  current: string;
  lanes: readonly LaneInfo[];
  timezones: readonly string[];
};

export type AnswerIssue = { code: "invalid_answer" | "mailbox_unknown" | "kpi_unknown" | "invalid_sender" | "unknown_question"; path: string };

export class AnswerError extends Error {
  readonly issues: AnswerIssue[];
  constructor(issues: AnswerIssue[]) {
    super("The answers are not valid.");
    this.name = "AnswerError";
    this.issues = issues;
  }
}

export type SectionEdit = { target: DocTarget; text: string };

/** Section names in their canonical order (a test pins this to employeeConfigSchema). */
export const SECTION_ORDER = ["coverage", "attention", "calendar", "deadlines", "money", "finance_kpis", "approvals", "news", "priorities", "drafts", "clarifications"] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DOMAIN = /^@[a-z0-9.-]+\.[a-z]{2,}$/;

export const laneOf = (ctx: InterviewCtx, laneId: string): LaneInfo | undefined => ctx.lanes.find((l) => l.laneId === laneId);
export const mailboxKey = (lane: string, mailbox: string): string => `${lane}|${mailbox}`;

function fieldSchema(f: Field): z.ZodType {
  const req = f.required === true;
  let s: z.ZodType;
  switch (f.kind) {
    case "text":
    case "longtext":
    case "list":
      s = req ? z.string().max(f.max ?? 1500).refine((v) => v.trim().length > 0) : z.string().max(f.max ?? 1500);
      break;
    case "select":
      s = f.options ? z.enum(f.options.map((o) => o.value) as [string, ...string[]]) : z.string().min(1).max(64);
      break;
    case "multiselect":
      s = f.options ? z.array(z.enum(f.options.map((o) => o.value) as [string, ...string[]])).max(30) : z.array(z.string().max(64)).max(30);
      if (req) s = (s as z.ZodArray<z.ZodType>).min(1);
      break;
    case "number":
      s = z.number().int().min(f.min ?? 0).max(f.max ?? 100);
      break;
    case "time":
      s = z.union([z.string().regex(HHMM), z.literal("")]);
      break;
    case "boolean":
      s = z.boolean();
      break;
    case "mailbox_order":
      s = z.array(z.string().max(300)).max(30);
      break;
    case "mailbox_text":
      s = z.record(z.string().max(300), z.string().max(2000));
      break;
  }
  return req || f.kind === "boolean" || f.kind === "number" ? s : s.optional();
}

/** Strict parse of one question's answers: unknown keys, wrong types and out-of-range values are issues (paths only). */
export function parseAnswers(q: Question, raw: unknown): Answers {
  const shape: Record<string, z.ZodType> = {};
  for (const f of q.fields) shape[f.key] = fieldSchema(f);
  const res = z.strictObject(shape).safeParse(raw);
  if (!res.success) {
    throw new AnswerError(res.error.issues.map((i) => ({ code: "invalid_answer" as const, path: `${q.id}.${i.path.join(".")}`.replace(/\.$/, "") })));
  }
  return res.data as Answers;
}

/** Every free-text value in a set of answers (for the credential, sensitive-number and Nichols Law screens). */
export function answerTexts(answers: Answers): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      out.push(k);
      walk(x);
    }
  };
  walk(answers);
  return out;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function splitList(text: string, max = 50): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\n,;]+/)) {
    const t = part.trim();
    if (t) seen.add(t);
  }
  return [...seen].slice(0, max);
}

function splitRules(text: string): string[] {
  return text
    .split(/\n|;/)
    .map((t) => oneLine(cleanText(t, 200)))
    .filter(Boolean)
    .slice(0, 20);
}

type SectionName = EmployeeConfig["output"]["sections"][number];
function toggle(sections: SectionName[], name: SectionName, on: boolean): SectionName[] {
  const set = new Set(sections);
  if (on) set.add(name);
  else set.delete(name);
  return SECTION_ORDER.filter((s) => set.has(s));
}

export function newConfig(ctx: InterviewCtx, timezone?: string): EmployeeConfig {
  return employeeConfigSchema.parse({ lanes: [ctx.home], ...(timezone ? { timezone } : {}) });
}

/** The lanes this employee reads, as known lanes. */
export const selectedLanes = (config: Pick<EmployeeConfig, "lanes">, ctx: InterviewCtx): LaneInfo[] => config.lanes.flatMap((l) => laneOf(ctx, l) ?? []);

export function priorityText(config: EmployeeConfig, ctx: InterviewCtx): string {
  const lines: string[] = [];
  if (config.sources.mail.length > 0) {
    lines.push("Mailboxes, highest priority first:");
    [...config.sources.mail]
      .sort((a, b) => a.priority - b.priority)
      .forEach((m, i) => {
        const lane = laneOf(ctx, m.lane)?.name ?? m.lane;
        lines.push(`${String(i + 1)}. ${m.mailbox} (${lane})${m.include.length ? `: ${m.include.join("; ")}` : ""}`);
      });
  }
  if (config.sources.vip_senders.length > 0) lines.push(`VIP senders: ${config.sources.vip_senders.join(", ")}`);
  return lines.length > 0 ? lines.join("\n") : "Not provided.";
}

const EXCLUDE_LABEL: Record<string, string> = { newsletters: "newsletters", promotions: "promotions", social: "social", automated: "automated messages" };
export function leaveOutText(config: EmployeeConfig, exceptions: string): string {
  const base = `Leave out: ${config.exclude.length ? config.exclude.map((e) => EXCLUDE_LABEL[e] ?? e).join(", ") : "nothing"}.`;
  return exceptions ? `${base}\nExceptions: ${exceptions}` : base;
}
export function calendarText(config: EmployeeConfig, prep: string): string {
  const base = `Look ahead ${String(config.sources.calendar.days_ahead)} days.`;
  return prep ? `${base}\nMeetings that need prep: ${prep}` : base;
}

/** The text after `marker` in a generated section ("" when absent), for prefilling the free-text part again. */
export function afterMarker(section: string | null, marker: string): string {
  if (section === null) return "";
  const at = section.indexOf(marker);
  return at < 0 ? "" : section.slice(at + marker.length).trim();
}

/**
 * Applies one question's (already parsed) answers: mutates the draft config and returns the page edits. Answers the
 * config cannot hold (a mailbox the lane does not list, a KPI the lane does not configure) are issues, never guesses.
 */
export function applyAnswers(q: Question, a: Answers, config: EmployeeConfig, ctx: InterviewCtx): SectionEdit[] {
  switch (q.id) {
    case "B2": {
      const picked = (a.mailboxes as string[] | undefined) ?? [];
      const old = new Map(config.sources.mail.map((m) => [mailboxKey(m.lane, m.mailbox.toLowerCase()), m.include]));
      const issues: AnswerIssue[] = [];
      const mail: EmployeeConfig["sources"]["mail"] = [];
      picked.forEach((key, i) => {
        const [lane = "", ...rest] = key.split("|");
        const address = rest.join("|");
        const info = laneOf(ctx, lane);
        const listed = info?.mailboxes.find((m) => m.toLowerCase() === address.toLowerCase());
        if (listed === undefined || mail.some((m) => m.lane === lane && m.mailbox.toLowerCase() === listed.toLowerCase())) {
          issues.push({ code: "mailbox_unknown", path: `B2.mailboxes.${String(i)}` });
          return;
        }
        mail.push({ lane, mailbox: listed, priority: Math.min(mail.length + 1, 9), include: old.get(mailboxKey(lane, listed.toLowerCase())) ?? [] });
      });
      if (issues.length > 0) throw new AnswerError(issues);
      config.sources.mail = mail;
      config.lanes = [...new Set([ctx.home, ...mail.map((m) => m.lane)])];
      return [{ target: { doc: "pa", section: PA_SECTIONS.priority }, text: priorityText(config, ctx) }];
    }
    case "B3": {
      const rules = (a.include as Record<string, string> | undefined) ?? {};
      const issues: AnswerIssue[] = [];
      for (const key of Object.keys(rules)) {
        const m = config.sources.mail.find((x) => mailboxKey(x.lane, x.mailbox) === key);
        if (m === undefined) issues.push({ code: "mailbox_unknown", path: `B3.include.${key}` });
        else m.include = splitRules(rules[key] ?? "");
      }
      if (issues.length > 0) throw new AnswerError(issues);
      return [{ target: { doc: "pa", section: PA_SECTIONS.priority }, text: priorityText(config, ctx) }];
    }
    case "B4": {
      const senders = splitList(str(a.vip), 50).map((s) => s.toLowerCase());
      const bad = senders.flatMap((s, i) => (email.safeParse(s).success || DOMAIN.test(s) ? [] : [{ code: "invalid_sender" as const, path: `B4.vip.${String(i)}` }]));
      if (bad.length > 0) throw new AnswerError(bad);
      config.sources.vip_senders = senders;
      return [{ target: { doc: "pa", section: PA_SECTIONS.priority }, text: priorityText(config, ctx) }];
    }
    case "B5": {
      config.exclude = [...new Set((a.exclude as EmployeeConfig["exclude"] | undefined) ?? [])];
      const exceptions = cleanText(str(a.exceptions), 1500);
      return [{ target: { doc: "pa", section: PA_SECTIONS.leaveOut }, text: leaveOutText(config, exceptions) }];
    }
    case "B6": {
      config.sources.calendar.days_ahead = a.days_ahead as number;
      return [{ target: { doc: "pa", section: PA_SECTIONS.calendar }, text: calendarText(config, cleanText(str(a.prep), 1500)) }];
    }
    case "B7": {
      const show = a.show as string;
      const available = new Set(selectedLanes(config, ctx).flatMap((l) => [...l.kpis]));
      const picked = ((a.kpis as string[] | undefined) ?? []).filter((k): k is (typeof KPI_IDS)[number] => (KPI_IDS as readonly string[]).includes(k));
      if (show === "pick" && (picked.length === 0 || picked.length !== ((a.kpis as string[] | undefined) ?? []).length || picked.some((k) => !available.has(k)))) {
        throw new AnswerError([{ code: "kpi_unknown", path: "B7.kpis" }]);
      }
      config.sources.finance_alerts = show !== "none";
      config.sources.finance_kpis = show === "pick" ? [...new Set(picked)] : [];
      config.output.sections = toggle(config.output.sections, "finance_kpis", show !== "none");
      return [];
    }
    case "B8":
      config.sources.approvals_pending = a.approvals === true;
      config.output.sections = toggle(config.output.sections, "approvals", a.approvals === true);
      return [];
    case "B9": {
      const topics = splitList(str(a.topics), 10).map((t) => oneLine(cleanText(t, 100))).filter(Boolean);
      config.sources.external = topics.length > 0 ? [{ kind: "web_news", topics }] : [];
      config.output.sections = toggle(config.output.sections, "news", topics.length > 0);
      return [];
    }
    case "B10": {
      const time = str(a.time);
      if (time) config.schedule.time = time;
      else delete config.schedule.time;
      config.schedule.days = [...new Set((a.days as string[]).map(Number))].sort((x, y) => x - y);
      return [];
    }
    case "B11":
      config.delivery = [...new Set(a.delivery as EmployeeConfig["delivery"])];
      return [];
    case "B12": {
      config.output.target_words = Number(a.target_words);
      config.output.max_attention_items = a.max_attention as number;
      const chosen = new Set(((a.sections as string[] | undefined) ?? []).filter((s) => (SECTION_ORDER as readonly string[]).includes(s)));
      config.output.sections = SECTION_ORDER.filter((s) => chosen.has(s));
      return [];
    }
    case "B13": {
      const n = a.max_drafts as number;
      config.output.max_drafts = n;
      const others = config.permissions.propose.filter((t) => (t as string) !== "email.save_draft" && (t as string) !== "email.draft");
      config.permissions.propose = (n > 0 ? ["email.save_draft", ...others] : others) as EmployeeConfig["permissions"]["propose"];
      return [];
    }
    default:
      break;
  }
  // Plain page answers: one section (or line) per field that names a target.
  const edits: SectionEdit[] = [];
  for (const f of q.fields) {
    if (!f.into) continue;
    const v = a[f.key];
    let text = "";
    if (f.kind === "select") text = f.options?.find((o) => o.value === v)?.label ?? str(v);
    else text = cleanText(str(v), f.max ?? 1500);
    if (f.key === "timezone" && !ctx.timezones.includes(text)) throw new AnswerError([{ code: "invalid_answer", path: `${q.id}.timezone` }]);
    if (f.into.line !== undefined) text = oneLine(text);
    const fallback = "Not provided.";
    edits.push({ target: f.into, text: f.into.line !== undefined ? `${f.into.line} ${text || fallback}` : text || fallback });
  }
  return edits;
}
