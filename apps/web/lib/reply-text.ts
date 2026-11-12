// Pure text helpers of the Reply drawer (T-237 part E). No AI call, no I/O, client-safe.
//   stripPlaceholders  an AI draft never reaches the textarea with a masked "[amount]" / "[number]" token: the sentence is dropped.
//   findCommitments    dates, times and promises in a body; commitmentToCheck keeps only those that were in the AI draft.
//   savedLabel / senderName / threadTime  display strings (times are America/New_York with an "ET" suffix, never ISO or "Z").
const PLACEHOLDER = /\[(?:amount|number)\]/i;

export type Stripped = { text: string; removed: number };

/** Removes every sentence holding a masked-figure token. `removed` counts the lines that lost something. */
export function stripPlaceholders(text: string): Stripped {
  let removed = 0;
  const lines = text.split("\n").map((line) => {
    if (!PLACEHOLDER.test(line)) return line;
    removed += 1;
    const kept = line.split(/(?<=[.!?])\s+/).filter((s) => !PLACEHOLDER.test(s));
    return kept.join(" ").trim();
  });
  // Lines emptied by the removal go away; blank lines that were there before stay (at most one in a row).
  const out: string[] = [];
  lines.forEach((l, i) => {
    const wasBlank = (text.split("\n")[i] ?? "").trim() === "";
    if (l.trim() === "" && !wasBlank) return;
    if (l.trim() === "" && out.length > 0 && (out[out.length - 1] ?? "").trim() === "") return;
    out.push(l);
  });
  return { text: out.join("\n").trim(), removed };
}

const WEEKDAY = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)";
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const TIME = "(?:noon|midnight|\\d{1,2}(?::\\d{2})?\\s?(?:am|pm))";
const ZONE = "(?:ET|EST|EDT|CT|PT|UTC)";
const CALENDAR_DAY = `(?:${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?|\\d{4}-\\d{2}-\\d{2})`;
const DAY = `(?:next\\s+${WEEKDAY}|${WEEKDAY}|tomorrow|tonight|end\\s+of\\s+(?:the\\s+)?(?:day|week|month)|eod|cob|${CALENDAR_DAY})`;
const WHEN = `${DAY}(?:\\s+(?:at\\s+)?(?:morning|afternoon|evening|${TIME}))?(?:\\s+${ZONE})?`;

// 1. "by Thursday noon ET", "before Nov 14", "no later than 3pm": the quoted phrase leaves the preposition out (group "core").
const WITH_PREPOSITION = new RegExp(`\\b(?:by|before|until|on|no\\s+later\\s+than)\\s+(?:the\\s+)?(?<core>${WHEN}|${TIME}(?:\\s+${ZONE})?)(?![\\w])`, "gi");
// 2. a bare time word: "tomorrow", "end of day", "next week".
const BARE = new RegExp(`\\b(?<core>tomorrow|tonight|end\\s+of\\s+(?:the\\s+)?(?:day|week|month)|eod|cob|next\\s+(?:week|month))\\b`, "gi");
// 3. "within 2 days", "within two business days".
const WITHIN = /\bwithin\s+(?:\d+|an?|one|two|three|four|five|six|seven|ten)\s+(?:business\s+|working\s+)?(?:hours?|days?|weeks?)\b/gi;
// 4. promises: "we will send", "I'll confirm".
const PROMISE = /\b(?:we|i)(?:'ll|’ll|\s+will)\s+(?:send|confirm|deliver|provide|share|follow\s+up|get\s+back\s+to\s+you|have\s+it\s+to\s+you)\b/gi;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Commitment phrases in the text, in order of first appearance within each kind (times and dates first, then promises). */
export function findCommitments(text: string): string[] {
  const found: string[] = [];
  const add = (p: string) => {
    const n = norm(p);
    if (n !== "" && !found.some((f) => f.toLowerCase() === n.toLowerCase())) found.push(n);
  };
  for (const m of text.matchAll(WITH_PREPOSITION)) add(m.groups?.core ?? m[0]);
  for (const m of text.matchAll(BARE)) add(m.groups?.core ?? m[0]);
  for (const m of text.matchAll(WITHIN)) add(m[0]);
  for (const m of text.matchAll(PROMISE)) add(m[0]);
  return found;
}

/** The first commitment still in the current body that the AI draft contained, else null. Text the user typed is never flagged. */
export function commitmentToCheck(current: string, aiDraft: string): string | null {
  if (aiDraft.trim() === "") return null;
  const fromAi = new Set(findCommitments(aiDraft).map((p) => p.toLowerCase()));
  if (fromAi.size === 0) return null;
  return findCommitments(current).find((p) => fromAi.has(p.toLowerCase())) ?? null;
}

/** "Saved just now" / "Saved 3 min ago" (null when nothing was saved this session). */
export function savedLabel(savedAt: number | null, now: number): string | null {
  if (savedAt === null) return null;
  const min = Math.floor(Math.max(0, now - savedAt) / 60_000);
  return min < 1 ? "Saved just now" : `Saved ${min} min ago`;
}

/** "Dana Whitfield" from "Dana Whitfield <dana@x.test>"; the bare address when there is no name; null when nothing usable. */
export function senderName(replyingTo: string): string | null {
  const m = /^(.*?)\s*<[^>]*>\s*$/.exec(replyingTo.trim());
  const name = (m ? (m[1] ?? "") : replyingTo).replace(/^["']|["']$/g, "").trim();
  return name === "" || name === "Unknown sender" ? null : name;
}

const THREAD_TIME = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

/** "Tue, Nov 10, 4:12 PM ET" (Eastern time whatever the browser zone); null when the date is missing or invalid. */
export function threadTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${THREAD_TIME.format(d)} ET`;
}
