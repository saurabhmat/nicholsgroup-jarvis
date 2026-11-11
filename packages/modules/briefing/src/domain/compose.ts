// AI briefing content (T-231c, T-231d): the shape the model must return, how it is checked, and the grounding rules.
// The model only writes text; every reference must be one of the refs the server gave it, recipients and sources come
// from metadata (never from the model), and any money amount, percentage or date it writes must appear in that item's
// own source material, otherwise the field becomes "Awaiting your input" (never invent prices, dates, commitments).
// Pure: no zod here (the module may depend on core only), hand-written validation instead.

export const AWAITING = "Awaiting your input";

export type BriefRef = {
  /** "r1", "r2", ... given to the model. */
  ref: string;
  connectionId: string;
  messageId: string;
  threadKey: string;
  mailbox: string | null;
  fromAddress: string | null;
  fromName: string | null;
  subject: string | null;
  receivedAt: string;
  sourceUrl: string | null;
  /** Rule-based reason (T-231b). */
  reason: string;
  kind: string;
};

export type AttentionNote = { ref: string; what: string; why: string; next: string };
export type Deadline = { ref: string | null; text: string; due: string | null };
export type Priority = { text: string; reason: string; refs: string[] };
export type ReplyDraft = { ref: string; status: "ready" | "awaiting_input"; context: string; text: string };

export type BriefContent = {
  lines: string[];
  attention: AttentionNote[];
  deadlines: Deadline[];
  priorities: Priority[];
  replies: ReplyDraft[];
  /** Threads needing a reply beyond the drafted ones, by sender name. */
  moreReplies: string[];
  /** Codes only (e.g. "bodies_not_allowed", "body_unreadable:r2", "ungrounded:r1.next"). */
  notes: string[];
};

const MAX = { line: 400, field: 400, reply: 4000, lines: 5, attention: 8, deadlines: 8, priorities: 3, replies: 3 };

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  return t === "" ? null : t.slice(0, max);
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The first JSON object in the model's text (it may wrap it in prose or a code fence). */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Amounts, percentages and dates a sentence asserts (ISO dates, d/m forms, "Nov 20" and "20 Nov"). */
const FIGURE = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?)|(?:\b\d[\d,]*(?:\.\d+)?\s?%)|(?:\b\d{4}-\d{2}-\d{2}\b)|(?:\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b)|(?:\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b)|(?:\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b)/gi;
const MONTH = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?/g;

/** Lower case, single spaces, months as 3 letters ("November" and "Nov." -> "nov"), ordinals dropped. */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(MONTH, "$1").replace(/(\d)(?:st|nd|rd|th)\b/g, "$1");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True when every figure/date in `text` appears in one of the sources as a whole figure: "$5" is not grounded by "$500"
 * and "10%" not by "110%" (no digit, or separator + digit, on either side). A trailing comma or full stop is not part of
 * the figure. "Nov 20" is also found as "20 Nov".
 */
export function grounded(text: string, sources: readonly string[]): boolean {
  const hay = norm(sources.join("\n"));
  for (const m of text.matchAll(FIGURE)) {
    const fig = norm(m[0]).replace(/[.,]+$/, "");
    const forms = [fig];
    const md = /^([a-z]{3}) (\d{1,2})$/.exec(fig);
    const dm = /^(\d{1,2}) ([a-z]{3})$/.exec(fig);
    if (md) forms.push(`${md[2] ?? ""} ${md[1] ?? ""}`);
    if (dm) forms.push(`${dm[2] ?? ""} ${dm[1] ?? ""}`);
    const found = forms.some((f) => new RegExp(`(?<![\\d.,])${escapeRe(f)}(?!\\d|[.,]\\d)`).test(hay));
    if (!found) return false;
  }
  return true;
}

/**
 * Masks what Home must not show from model text (rule 7, the T-231b subject decision; security review H3): money
 * amounts become "[amount]" and long digit runs (5+ digits, separators allowed: account, routing, card, SSN-like or
 * phone numbers) "[number]". ISO dates and 4-digit years stay.
 */
export function maskText(text: string): string {
  return text
    .replace(/(?:[$€£¥]|\b(?:usd|eur|gbp)\s?)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|million|thousand)\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|dollars)\b/gi, "[amount]")
    .replace(/\d(?:[\d\s().-]*\d)?/g, (run) => (/^\d{4}-\d{2}-\d{2}$/.test(run) ? run : run.replace(/\D/g, "").length >= 5 ? "[number]" : run));
}

/** maskText over every model-written string of a checked briefing (called after grounding, before saving). */
export function maskContent(c: BriefContent): BriefContent {
  const m = maskText;
  return {
    ...c,
    lines: c.lines.map(m),
    attention: c.attention.map((a) => ({ ...a, what: m(a.what), why: m(a.why), next: m(a.next) })),
    deadlines: c.deadlines.map((d) => ({ ...d, text: m(d.text), due: d.due === null ? null : m(d.due) })),
    priorities: c.priorities.map((p) => ({ ...p, text: m(p.text), reason: m(p.reason) })),
    replies: c.replies.map((r) => ({ ...r, context: m(r.context), text: m(r.text) })),
  };
}

/**
 * Validates the model's JSON against the refs and grounds every field. `sourcesFor(ref)` = the metadata line and (when
 * read) the body of that ref; `allSources` = everything the model saw (for lines and priorities). Unknown refs are
 * dropped; ungrounded fields become AWAITING and are noted.
 */
export function checkContent(raw: unknown, refs: readonly BriefRef[], sourcesFor: (ref: string) => string[], allSources: readonly string[], opts: { replies: boolean }): BriefContent {
  const known = new Set(refs.map((r) => r.ref));
  const o = obj(raw);
  const notes: string[] = [];
  const ground = (text: string | null, src: readonly string[], where: string): string => {
    if (text === null) return AWAITING;
    if (grounded(text, src)) return text;
    notes.push(`ungrounded:${where}`);
    return AWAITING;
  };
  const rawLines = arr(o.lines)
    .map((l) => str(l, MAX.line))
    .filter((l): l is string => l !== null)
    .slice(0, MAX.lines)
    .flatMap((l, i) => {
      if (grounded(l, allSources)) return [l];
      notes.push(`ungrounded:line${String(i + 1)}`);
      return [];
    });
  const lines = rawLines;
  if (lines.length === 0 && arr(o.lines).length > 0) notes.push("lines_ungrounded");
  const seen = new Set<string>();
  const attention = arr(o.attention).flatMap((a) => {
    const x = obj(a);
    const ref = str(x.ref, 10);
    if (!ref || !known.has(ref) || seen.has(ref)) return [];
    seen.add(ref);
    const src = sourcesFor(ref);
    const what = ground(str(x.what, MAX.field), src, `${ref}.what`);
    // Nothing verified about what happened: no note (the rule-based item still shows).
    if (what === AWAITING) return [];
    return [{ ref, what, why: ground(str(x.why, MAX.field), src, `${ref}.why`), next: ground(str(x.next, MAX.field), src, `${ref}.next`) }];
  }).slice(0, MAX.attention);
  const deadlines = arr(o.deadlines).flatMap((d) => {
    const x = obj(d);
    const ref = str(x.ref, 10);
    const r = ref && known.has(ref) ? ref : null;
    const text = str(x.text, MAX.field);
    const due = str(x.due, 60);
    if (!text) return [];
    const src = r ? sourcesFor(r) : allSources;
    const t = ground(text, src, `${r ?? "deadline"}.text`);
    const dd = due === null ? null : grounded(due, src) ? due : (notes.push(`ungrounded:${r ?? "deadline"}.due`), null);
    return t === AWAITING ? [] : [{ ref: r, text: t, due: dd }];
  }).slice(0, MAX.deadlines);
  const priorities = arr(o.priorities).flatMap((p) => {
    const x = obj(p);
    const text = str(x.text, MAX.field);
    const reason = str(x.reason, MAX.field);
    const prRefs = arr(x.refs).flatMap((r) => (typeof r === "string" && known.has(r) ? [r] : []));
    // A priority tied to refs is grounded against those refs' own material; otherwise against everything read.
    const prSrc = prRefs.length > 0 ? [...prRefs.flatMap(sourcesFor)] : allSources;
    if (!text || !reason || !grounded(`${text} ${reason}`, prSrc)) {
      if (text) notes.push("ungrounded:priority");
      return [];
    }
    return [{ text, reason, refs: prRefs }];
  }).slice(0, MAX.priorities);
  const replySeen = new Set<string>();
  const replies = !opts.replies
    ? []
    : arr(o.replies).flatMap((r) => {
        const x = obj(r);
        const ref = str(x.ref, 10);
        const text = str(x.text, MAX.reply);
        if (!ref || !known.has(ref) || replySeen.has(ref) || !text) return [];
        replySeen.add(ref);
        const src = sourcesFor(ref);
        const okText = grounded(text, src);
        if (!okText) notes.push(`ungrounded:${ref}.reply`);
        // A draft that asserts an unverified figure or date is never kept: it becomes an empty draft waiting for the owner,
        // so no invented figure reaches Home, the copy button or an Approvals proposal.
        const status: ReplyDraft["status"] = x.status === "ready" && okText ? "ready" : "awaiting_input";
        return [{ ref, status, context: ground(str(x.context, MAX.field), src, `${ref}.context`), text: okText ? text : AWAITING }];
      }).slice(0, MAX.replies);
  const moreReplies = arr(o.more_replies ?? o.moreReplies).flatMap((n) => (typeof n === "string" && known.has(n) ? [n] : [])).slice(0, 20);
  return { lines, attention, deadlines, priorities, replies, moreReplies, notes };
}

/** The rules part of the briefing prompt (the system prompt; facts and untrusted bodies go in the user message). */
export const BRIEFING_RULES = [
  "You prepare the owner's daily briefing from the facts and messages given. Executive and concise.",
  "Never invent decisions, prices, amounts, dates, deadlines or commitments: write only what the given material says.",
  `When something needs the owner's decision or a fact is missing, write "${AWAITING}".`,
  "Each attention item says what happened, why it matters and the next step, for one ref.",
  "Reply drafts: plain text, short, in the owner's voice, no signature block; never promise anything the owner has not said; mark status awaiting_input when it depends on the owner's decision.",
  "Answer with one JSON object only, no prose: {\"lines\": [3-5 short sentences], \"attention\": [{\"ref\",\"what\",\"why\",\"next\"}],",
  "\"deadlines\": [{\"ref\",\"text\",\"due\"}], \"priorities\": [{\"text\",\"reason\",\"refs\": []}] (top 3),",
  "\"replies\": [{\"ref\",\"status\": \"ready\"|\"awaiting_input\",\"context\",\"text\"}] (at most 3), \"more_replies\": [refs]}.",
  "Use only refs from the facts (r1, r2, ...).",
].join(" ");
