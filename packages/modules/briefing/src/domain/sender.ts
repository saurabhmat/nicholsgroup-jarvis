// How a sender is shown on a Needs-your-attention row (T-235 part 2): a name, a company or domain, initials and a stable
// palette slot for the avatar. Pure; the inputs are untrusted message metadata and the outputs are plain text.
import { nameFromEmail } from "./calendar";

export type SenderParts = { name: string; /** Organisation from the display name, else the address domain without "www."; null when neither exists. */ company: string | null; initials: string; /** 0..palette-1 from a hash of the address (or the name): the same sender always gets the same colour. */ slot: number };

/** "Dana Whitfield (Acme)", "Dana Whitfield | Acme", "Dana Whitfield - Acme": the part after the separator is the organisation. */
const ORG = [/^(.+?)\s*\(([^()]{2,40})\)\s*$/, /^(.+?)\s+[|–—-]\s+(.{2,40})$/];

export function senderParts(fromName: string | null, fromAddress: string | null, palette = 4): SenderParts {
  const address = fromAddress?.trim().toLowerCase() || null;
  let name = fromName?.trim().replace(/^["']|["']$/g, "") ?? "";
  let org: string | null = null;
  for (const re of ORG) {
    const m = re.exec(name);
    if (m?.[1] && m[2]) {
      name = m[1].trim();
      org = m[2].trim();
      break;
    }
  }
  if (name.includes("@")) name = nameFromEmail(name);
  if (name === "") name = address ? nameFromEmail(address) : "Unknown sender";
  const domain = address?.split("@")[1]?.replace(/^www\./, "") ?? "";
  const company = org ?? (domain !== "" ? domain : null);
  const words = name.split(/\s+/).flatMap((w) => Array.from(w).find((c) => /\p{L}/u.test(c)) ?? []);
  const initials = (words.length > 1 ? `${words[0] ?? ""}${words[words.length - 1] ?? ""}` : (words[0] ?? "?")).toUpperCase();
  const seed = address ?? name.toLowerCase();
  let h = 0;
  for (const c of seed) h = (h * 31 + (c.codePointAt(0) ?? 0)) % 100_003;
  return { name, company, initials, slot: h % Math.max(1, palette) };
}

/** The chips of an attention row, at most `max`, in priority order: Priority sender, Waiting on you, Unread, Security alert, then the rest. */
export function attentionChips(kind: string, unread: boolean, max = 2): { key: string; label: string; tone: "alert" | "outline" | "gold" }[] {
  const all: { key: string; label: string; tone: "alert" | "outline" | "gold" }[] = [];
  if (kind === "priority") all.push({ key: "priority", label: "Priority sender", tone: "alert" });
  if (kind === "waiting") all.push({ key: "waiting", label: "Waiting on you", tone: "gold" });
  if (unread || kind === "unread") all.push({ key: "unread", label: "Unread", tone: "outline" });
  if (kind === "security") all.push({ key: "security", label: "Security alert", tone: "alert" });
  if (kind === "repeated_failures") all.push({ key: "repeated_failures", label: "Repeated failures", tone: "alert" });
  const order = ["priority", "waiting", "unread", "security", "repeated_failures"];
  return all.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)).slice(0, max);
}

/** "now", "12m", "5h", "3d": the short age on a row (the full date is the `title`). */
export function ageShort(iso: string, now: Date): string {
  const mins = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(mins) || mins < 1) return "now";
  if (mins < 60) return `${String(mins)}m`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `${String(h)}h` : `${String(Math.floor(h / 24))}d`;
}
