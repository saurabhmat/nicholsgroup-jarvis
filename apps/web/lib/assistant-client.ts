// Pure helpers for the assistant chat UI (no server imports: used by a client component).
export type ChatRole = "user" | "assistant";
export type ClientTurn = { role: ChatRole; text: string; error?: string };
export type Citation = { kind: string; label: string; url: string | null; asOf: string; freshness: "live" | "cached" | "stale" };

export const MAX_SENT_TURNS = 19;
const MAX_TURN_CHARS = 4000;
const MAX_HISTORY_CHARS = 20_000;

/**
 * The request history: complete (question, answer) pairs only, oldest dropped first to stay within the server's
 * caps, then the new question. A pair whose answer failed, was stopped or is empty is dropped as a whole, so turns
 * always alternate and every answer stays with its own question.
 */
export function buildMessages(turns: ClientTurn[], question: string): { role: ChatRole; text: string }[] {
  const pairs: [{ role: "user"; text: string }, { role: "assistant"; text: string }][] = [];
  for (let i = 0; i + 1 < turns.length; i++) {
    const q = turns[i];
    const a = turns[i + 1];
    if (q?.role !== "user" || a?.role !== "assistant") continue;
    i++;
    const qt = q.text.trim().slice(0, MAX_TURN_CHARS);
    const at = a.text.trim().slice(0, MAX_TURN_CHARS);
    if (a.error || !qt || !at) continue;
    pairs.push([{ role: "user", text: qt }, { role: "assistant", text: at }]);
  }
  const last = { role: "user" as const, text: question.trim().slice(0, MAX_TURN_CHARS) };
  let kept = pairs.slice(-Math.floor((MAX_SENT_TURNS - 1) / 2));
  const size = () => kept.reduce((n, [q, a]) => n + q.text.length + a.text.length, last.text.length);
  while (kept.length > 0 && size() > MAX_HISTORY_CHARS) kept = kept.slice(1);
  return [...kept.flat(), last];
}

/** Incremental server-sent-events parser: feed decoded text, get complete events; malformed frames are skipped. */
export function createSseParser() {
  let buf = "";
  const take = (final: boolean) => {
    const out: { type: string; [k: string]: unknown }[] = [];
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0 || (final && buf.trim() !== "")) {
      const frame = i >= 0 ? buf.slice(0, i) : buf;
      buf = i >= 0 ? buf.slice(i + 2) : "";
      const data = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!data) continue;
      try {
        const e = JSON.parse(data.slice(6)) as unknown;
        if (e && typeof e === "object" && typeof (e as { type?: unknown }).type === "string") out.push(e as { type: string });
      } catch {
        // skip a malformed frame, keep the stream
      }
    }
    return out;
  };
  return { push: (text: string) => ((buf += text), take(false)), end: () => take(true) };
}

/** At most three chips per source kind, then one "+N more" chip linking to that kind's page. */
export function groupCitations(cs: Citation[], perKind = 3): (Citation & { more?: number })[] {
  const byKind = new Map<string, Citation[]>();
  for (const c of cs) byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c]);
  return [...byKind.values()].flatMap((list) => {
    const shown: (Citation & { more?: number })[] = list.slice(0, perKind);
    const rest = list.length - perKind;
    if (rest > 0) {
      const first = list[0] as Citation;
      const page = first.url?.match(/^\/[A-Z]{1,8}\/[a-z]+/)?.[0] ?? null;
      shown.push({ ...first, label: `+${rest} more`, url: page, more: rest });
    }
    return shown;
  });
}

const TZ = "America/New_York";
const TIME = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const DATE = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" });
const YMD = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });

/** "9:05 AM" today, "Nov 9" otherwise (New York). */
export function asOfLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return YMD.format(d) === YMD.format(now) ? TIME.format(d) : DATE.format(d);
}

export const isInAppPath = (u: string | null): u is string => typeof u === "string" && /^\/[A-Za-z0-9_][A-Za-z0-9_/-]*$/.test(u);
