// How a sender is shown on a Needs-your-attention row (T-235 part 2): a name, a company or domain, initials and a stable
// palette slot for the avatar. Pure; the inputs are untrusted message metadata and the outputs are plain text.
import { nameFromEmail } from "./calendar";

export type SenderParts = { name: string; /** The domain of the sender ADDRESS (last "@", without "www."), never from the display name; null when there is no address. */ company: string | null; initials: string; /** 0..palette-1 from a hash of the address (or the name): the same sender always gets the same colour. */ slot: number };

export function senderParts(fromName: string | null, fromAddress: string | null, palette = 4): SenderParts {
  const address = fromAddress?.trim().toLowerCase() || null;
  // The display name is untrusted text (rule 9): it is shown as the name and never as the company or domain.
  let name = fromName?.trim().replace(/^["']|["']$/g, "") ?? "";
  if (name.includes("@")) name = nameFromEmail(name);
  if (name === "") name = address ? nameFromEmail(address) : "Unknown sender";
  // The domain of the ADDRESS, from the last "@" ("a@paypal.com"@evil.test is evil.test), never parsed from the display name.
  const at = address?.lastIndexOf("@") ?? -1;
  const domain = address && at >= 0 ? address.slice(at + 1).replace(/^www\./, "") : "";
  const company = domain !== "" ? domain : null;
  const words = name.split(/\s+/).flatMap((w) => Array.from(w).find((c) => /\p{L}/u.test(c)) ?? []);
  const initials = (words.length > 1 ? `${words[0] ?? ""}${words[words.length - 1] ?? ""}` : (words[0] ?? "?")).toUpperCase();
  const seed = address ?? name.toLowerCase();
  let h = 0;
  for (const c of seed) h = (h * 31 + (c.codePointAt(0) ?? 0)) % 100_003;
  return { name, company, initials, slot: h % Math.max(1, palette) };
}

/** "Name · domain" for a sender line, never a display name alone (the name is untrusted text; the domain is of the ADDRESS). Name only when there is no address. */
export function senderLabel(fromName: string | null, fromAddress: string | null): string {
  const { name, company } = senderParts(fromName, fromAddress);
  return company ? `${name} · ${company}` : name;
}

export type AttentionChip = { key: string; label: string; tone: "alert" | "outline" | "gold" };

/**
 * The chips of an attention row, at most `max`, in order: VIP, Waiting on you, Money, Deadline, Unread, Security alert,
 * Repeated failures (T-240). "Waiting on you" appears ONLY when `waitingOnYou` is true (the owner's mailbox is in the To of the
 * latest message and no reply from the owner came after it); otherwise the reason chips (VIP, Money, Deadline) say why the thread is here.
 */
export function attentionChips(item: { kind: string; unread: boolean; vip?: boolean; money?: boolean; deadline?: boolean; waitingOnYou?: boolean }, max = 2): AttentionChip[] {
  const all: AttentionChip[] = [];
  if (item.vip === true || item.kind === "priority") all.push({ key: "priority", label: "VIP", tone: "alert" });
  if (item.waitingOnYou === true) all.push({ key: "waiting", label: "Waiting on you", tone: "gold" });
  if (item.money === true) all.push({ key: "money", label: "Money", tone: "gold" });
  if (item.deadline === true) all.push({ key: "deadline", label: "Deadline", tone: "alert" });
  if (item.unread || item.kind === "unread") all.push({ key: "unread", label: "Unread", tone: "outline" });
  if (item.kind === "security") all.push({ key: "security", label: "Security alert", tone: "alert" });
  if (item.kind === "repeated_failures") all.push({ key: "repeated_failures", label: "Repeated failures", tone: "alert" });
  return all.slice(0, max);
}

/** "now", "12m", "5h", "3d": the short age on a row (the full date is the `title`). */
export function ageShort(iso: string, now: Date): string {
  const mins = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(mins) || mins < 1) return "now";
  if (mins < 60) return `${String(mins)}m`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `${String(h)}h` : `${String(Math.floor(h / 24))}d`;
}
