// Pure helpers for the memory import UI (T-220; no server imports, used by a client component and unit-tested): the exact
// instructions and prompts, the error texts, grouping of the checklist and the one call to the import route.
import { IMPORT_TARGETS, TARGET_LABEL, type ImportTarget } from "@nichols/brain/import";
import type { ImportCandidateView } from "@nichols/brain/server";

export const CLAUDE_PROMPT = "Write out your memories of me verbatim, exactly as they appear in your memory.";
export const CHATGPT_PROMPT = "List everything you remember about me, one item per line.";
export const WARNING_LINE = "Don't include passwords, account numbers, or client or matter details. Nothing is saved until you tick it and click Save.";
export const LOCAL_READ_NOTE = "Files are read in this browser and are not uploaded or stored. Only the text you choose to import is sent, up to 50,000 characters.";

export type ImportTab = "claude" | "chatgpt" | "folder";
export const TABS: { id: ImportTab; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "folder", label: "AI Brain folder" },
];

export const IMPORT_ERROR_TEXT: Record<string, string> = {
  not_configured: "Needs the AI to be configured. Ask your administrator. A brain folder .zip can still be imported.",
  not_allowed: "Not allowed for this company.",
  forbidden: "Not allowed for you here.",
  rate_limited: "Too many imports just now. Try again in a little while.",
  extraction_failed: "The AI could not read that text. Try again, or paste less.",
  timeout: "That took too long. Try again with less text.",
  invalid_request: "That could not be sent. Check the text and try again.",
  import_not_found: "This import is no longer open. Start again.",
  proposal_changed: "A page changed since the preview. Preview again before saving.",
  version_conflict: "A page was changed somewhere else. Preview again before saving.",
  profile_invalid: "The stored assistant profile is not valid, so it cannot be changed here. Open the setup first.",
  nothing_to_import: "Nothing in that page can be imported.",
  instruction_text: "That text reads like an instruction to the assistant, so it was not added. Reword it as a fact about you.",
  nichols_law: "Nichols Law client or matter details are not kept in this brain. Remove them and try again.",
  secret: "The text looks like a credential, so nothing was saved. Remove it and try again.",
  sensitive_ssn: "The text contains what looks like a Social Security number, so nothing was saved. Remove it and try again.",
  sensitive_card: "The text contains what looks like a payment card number, so nothing was saved. Remove it and try again.",
  sensitive_bank: "The text contains what looks like a bank account, routing or IBAN number, so nothing was saved. Remove it and try again.",
  config_invalid: "These settings are not valid for this company.",
  invalid: "That could not be saved.",
  session: "Your session has expired. Reload the page and sign in again.",
  home_lane_unavailable: "Your brain lives in a company you can no longer open. Ask an administrator.",
  unavailable: "Something went wrong. Try again.",
};

export type ImportApiOk<T> = { ok: true; data: T };
export type ImportApiErr = { ok: false; code: string };

/** One call to the import route. Never throws: a network failure is `unavailable`. */
export async function callImport<T>(laneId: string, body: Record<string, unknown>): Promise<ImportApiOk<T> | ImportApiErr> {
  try {
    const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/brain/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (res.ok && j.ok) return { ok: true, data: j as T };
    return { ok: false, code: res.status === 401 ? "session" : (j.error ?? "unavailable") };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

export type CandidateGroup = { target: ImportTarget; label: string; items: ImportCandidateView[] };

/** The checklist grouped by target, in the order of the targets; empty groups are left out. */
export function groupByTarget(candidates: readonly ImportCandidateView[]): CandidateGroup[] {
  return IMPORT_TARGETS.map((t) => ({ target: t, label: TARGET_LABEL[t], items: candidates.filter((c) => c.target === t) })).filter((g) => g.items.length > 0);
}

/** The ticked candidates with their (possibly edited) text, for the propose / save requests. Empty edits fall back to the proposed fact. */
export function tickedItems(candidates: readonly ImportCandidateView[], ticks: Readonly<Record<string, boolean>>, edits: Readonly<Record<string, string>>): { id: string; text: string }[] {
  return candidates.flatMap((c) => (ticks[c.id] === true ? [{ id: c.id, text: (edits[c.id] ?? c.fact).trim() || c.fact }] : []));
}

/** What the user is told about text that was left out (counts only; the text itself is never shown or kept). */
export function droppedNote(d: { instructions: number; sensitive: number; other: number }): string | null {
  const parts: string[] = [];
  if (d.instructions > 0) parts.push(`${String(d.instructions)} line(s) that read like instructions to an assistant were left out`);
  if (d.sensitive > 0) parts.push(`${String(d.sensitive)} item(s) that looked like passwords or account numbers were left out`);
  return parts.length === 0 ? null : `${parts.join("; ")}.`;
}

/** Typed requests to import memories in the chat: answered with a link, no model. */
export function isImportRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length > 80) return false;
  return /\b(import|bring in|bring over|move|transfer|copy)\b.*\b(memor(y|ies)|chatgpt|claude)\b/.test(t) || /\b(memor(y|ies))\b.*\b(import)\b/.test(t);
}
