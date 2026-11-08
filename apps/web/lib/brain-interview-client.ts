// Pure helpers for the setup interview UI (T-216; no server imports, used by a client component and unit-tested).
import type { GroupView, QuestionView, FieldView } from "@nichols/brain/interview";

export const ERROR_TEXT: Record<string, string> = {
  invalid_answers: "Some answers need fixing.",
  config_invalid: "These settings are not valid for this company. Check the mailboxes and numbers you picked.",
  secret: "The text looks like a credential, so nothing was saved. Remove it and try again.",
  sensitive_ssn: "The text contains what looks like a Social Security number, so nothing was saved. Remove it and try again.",
  sensitive_card: "The text contains what looks like a payment card number, so nothing was saved. Remove it and try again.",
  sensitive_bank: "The text contains what looks like a bank account, routing or IBAN number, so nothing was saved. Remove it and try again.",
  nichols_law: "Nichols Law client or matter details are not kept in this brain, so nothing was saved. Remove them and try again.",
  proposal_changed: "The page changed since the preview. Preview again before saving.",
  version_conflict: "The page was changed somewhere else. Preview again before saving.",
  forbidden: "The AI brain is not available for you in this company.",
  home_lane_unavailable: "Your brain lives in a company you can no longer open. Ask an administrator.",
  no_employee: "Save at least one Personal Assistant section first.",
  nothing_to_activate: "The assistant is already active.",
  invalid: "That could not be saved.",
  unavailable: "Something went wrong. Try again.",
  session: "Your session has expired. Reload the page and sign in again.",
  invalid_request: "That request could not be sent.",
  unknown_group: "That section does not exist.",
};

export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; code: string; issues?: { code: string; path: string }[] };

/** One call to the interview route. Never throws: a network failure is `unavailable`. */
export async function callInterview<T>(laneId: string, body: Record<string, unknown>): Promise<ApiOk<T> | ApiErr> {
  try {
    const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/brain/interview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; issues?: { code: string; path: string }[] };
    if (res.ok && j.ok) return { ok: true, data: j as T };
    const code = res.status === 401 ? "session" : (j.error ?? "unavailable");
    return { ok: false, code, ...(j.issues ? { issues: j.issues } : {}) };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

export type FormValues = Record<string, Record<string, unknown>>;

/** The starting value of a field: the stored answer, else a neutral default (the schema's own defaults for numbers and days). */
export function initialValue(f: FieldView, stored: unknown): unknown {
  if (stored !== undefined) return stored;
  switch (f.kind) {
    case "multiselect":
      if (f.key === "days") return ["1", "2", "3", "4", "5"]; // Monday to Friday (D-32)
      if (f.key === "delivery") return ["in_app", "push"];
      if (f.key === "exclude") return (f.options ?? []).map((o) => o.value);
      if (f.key === "sections") return ["coverage", "attention", "calendar", "deadlines", "finance_kpis", "approvals", "priorities", "drafts", "clarifications"];
      return [];
    case "number":
      return f.key === "days_ahead" ? 7 : f.key === "max_attention" ? 5 : f.key === "max_drafts" ? 3 : (f.min ?? 0);
    case "boolean":
      return true;
    case "select":
      return f.key === "target_words" ? "500" : f.key === "show" ? "all" : f.key === "timezone" ? "America/New_York" : "";
    case "mailbox_order":
      return [];
    case "mailbox_text":
      return {};
    default:
      return "";
  }
}

export function initialValues(group: GroupView): FormValues {
  const out: FormValues = {};
  for (const q of group.questions) {
    out[q.id] = {};
    for (const f of q.fields) (out[q.id] as Record<string, unknown>)[f.key] = initialValue(f, q.prefill?.[f.key]);
  }
  return out;
}

/** Questions that are shown as a form: asked ones, and known ones the user chose to edit. Skipped ones never. */
export function activeQuestions(group: GroupView, editing: ReadonlySet<string>): QuestionView[] {
  return group.questions.filter((q) => q.status === "ask" || (q.status === "known" && editing.has(q.id)));
}

const isEmpty = (v: unknown): boolean => v === "" || v === undefined;

/** The answers payload: only the active questions, with empty optional text left out and numbers as numbers. */
export function buildAnswers(group: GroupView, values: FormValues, editing: ReadonlySet<string>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const q of activeQuestions(group, editing)) {
    const a: Record<string, unknown> = {};
    for (const f of q.fields) {
      let v = values[q.id]?.[f.key];
      if (f.kind === "number") v = typeof v === "number" ? v : Number(v);
      if (isEmpty(v) && !f.required && f.kind !== "time") continue;
      // A selected KPI list only matters when the user picked "pick".
      if (q.id === "B7" && f.key === "kpis" && values[q.id]?.show !== "pick") continue;
      a[f.key] = v;
    }
    out[q.id] = a;
  }
  return out;
}

/** True when every required text or select field of the active questions has a value. */
export function canPreview(group: GroupView, values: FormValues, editing: ReadonlySet<string>): boolean {
  return activeQuestions(group, editing).every((q) =>
    q.fields.every((f) => {
      if (!f.required) return true;
      const v = values[q.id]?.[f.key];
      if (f.kind === "multiselect") return Array.isArray(v) && v.length > 0;
      if (f.kind === "text" || f.kind === "longtext" || f.kind === "list") return typeof v === "string" && v.trim() !== "";
      return !isEmpty(v);
    }),
  );
}

/**
 * The next group to ask, in bank order. `visited` = groups saved or skipped in this session, never asked again. Part A
 * groups whose sections are all known are skipped. At the start (afterId null) Part B is skipped when the employee
 * already exists (go to the summary; the user picks sections to change). There is no wrap-around: null = go to the summary.
 */
export function nextGroupId(groups: readonly GroupView[], afterId: string | null, visited: ReadonlySet<string>, hasEmployee = false): string | null {
  const start = afterId === null ? 0 : groups.findIndex((g) => g.id === afterId) + 1;
  return (
    groups
      .slice(start)
      .find((g) => !visited.has(g.id) && !(g.part === "A" && g.done) && !(afterId === null && g.part === "B" && hasEmployee))?.id ?? null
  );
}

/** "Pick a mailbox" style label for an issue path like `B2.mailboxes.0`. */
export function issueLabel(issue: { code: string; path: string }, group: GroupView): string {
  const [qid, key] = issue.path.split(".");
  const q = group.questions.find((x) => x.id === qid);
  const f = q?.fields.find((x) => x.key === key);
  const where = f ? `${q?.prompt ?? qid} (${f.label})` : (q?.prompt ?? issue.path);
  const why: Record<string, string> = {
    mailbox_unknown: "that mailbox is not set up for this company",
    kpi_unknown: "pick numbers this company has",
    invalid_sender: "use full email addresses or @domains",
    unknown_question: "this question is not asked now",
    invalid_answer: "check the value",
  };
  return `${where}: ${why[issue.code] ?? "check the value"}`;
}

/** Typed requests that start the interview in the chat instead of going to the model. */
export function isInterviewRequest(text: string): "setup" | "assistant" | null {
  const t = text.trim().toLowerCase();
  if (t.length > 80) return null;
  if (/\b(set ?up|configure|reconfigure)\b.*\b(personal assistant)\b/.test(t)) return "assistant";
  if (/\b(set ?up|reconfigure|configure|start)\b.*\b(brain|profile)\b/.test(t)) return "setup";
  return null;
}
