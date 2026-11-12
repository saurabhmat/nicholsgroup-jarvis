// Recipient warnings for a reply (T-234 part 3; same rule as the Approvals card, T-232 security review M1). Pure and
// client-safe so the drawer can update the flags while the owner edits: a domain outside the lane's own mailbox domains is
// "external"; every Bcc is "hidden copy".
import { domainOf } from "@nichols/briefing/domain";

export type RecipientFlag = { address: string; field: "to" | "cc" | "bcc"; flags: ("external" | "bcc")[] };

export function flagRecipients(fields: { to: readonly string[]; cc: readonly string[]; bcc: readonly string[] }, internalDomains: readonly string[]): RecipientFlag[] {
  const internal = new Set(internalDomains.map((d) => d.toLowerCase()).filter((d) => d !== ""));
  const out: RecipientFlag[] = [];
  for (const field of ["to", "cc", "bcc"] as const) {
    for (const address of fields[field]) {
      const domain = domainOf(address);
      const flags: RecipientFlag["flags"] = [];
      if (!internal.has(domain)) flags.push("external");
      if (field === "bcc") flags.push("bcc");
      if (flags.length > 0) out.push({ address, field, flags });
    }
  }
  return out;
}
