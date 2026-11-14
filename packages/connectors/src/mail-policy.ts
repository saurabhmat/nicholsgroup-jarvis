// Which mail accounts a lane may connect and use (T-247). Company settings live in lane_config, never in code (rule 2):
//   lane_config.mail.allowed_domains  lower-case domains whose accounts may be connected (empty = nothing: fail closed)
//   lane_config.mailboxes             OPTIONAL exact addresses; when not empty the address must ALSO be listed (it narrows, never widens)
// One rule for the connect callback, every Google call (the provider guard) and the email writer. D-23 (one account, one lane) is separate.
import { ConnectorError } from "./contract/errors";
import type { LaneConfigReader } from "./vault/lane-config";
import type { LaneId } from "@nichols/core";

export type MailPolicy = { readonly domains: readonly string[]; readonly mailboxes: readonly string[] };

const FORBIDDEN_DOMAIN = "This account's domain is not allowed for this lane";
const FORBIDDEN_LISTED = "This mailbox is not one of the lane's configured mailboxes";

/** The lower-cased domain of an address, or null when it is not `local@domain`. */
export function domainOfAddress(address: string): string | null {
  if (typeof address !== "string") return null;
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 1 || at === a.length - 1) return null;
  return a.slice(at + 1);
}

/** True when the address is allowed: its domain is in `domains` (an empty list allows nothing) and, when `mailboxes` is not empty, it is listed there too. */
export function mailAccountAllowed(policy: MailPolicy, address: string): boolean {
  const domain = domainOfAddress(address);
  if (domain === null || !policy.domains.includes(domain)) return false;
  return policy.mailboxes.length === 0 || policy.mailboxes.includes(address.trim().toLowerCase());
}

/** Throws `forbidden` (never a value from the config) when the address is not allowed. */
export function assertMailAccountAllowed(policy: MailPolicy, address: string): void {
  const domain = domainOfAddress(address);
  if (domain === null || !policy.domains.includes(domain)) throw new ConnectorError({ kind: "forbidden", message: FORBIDDEN_DOMAIN });
  if (policy.mailboxes.length > 0 && !policy.mailboxes.includes(address.trim().toLowerCase())) throw new ConnectorError({ kind: "forbidden", message: FORBIDDEN_LISTED });
}

/** A connect must not start for a lane that allows no domain (fail closed): nothing could be accepted afterwards. */
export function assertMailDomainsConfigured(domains: readonly string[]): void {
  if (domains.length === 0) throw new ConnectorError({ kind: "forbidden", message: "No mail domains are configured for this lane" });
}

/** The lane's current mail policy, read on every use (a domain or mailbox removed from the lane stops working at once). Throws when unreadable or malformed (fail closed). */
export async function readMailPolicy(laneConfig: Pick<LaneConfigReader, "mailboxes" | "mailDomains">, laneId: LaneId): Promise<MailPolicy> {
  const [domains, mailboxes] = await Promise.all([laneConfig.mailDomains(laneId), laneConfig.mailboxes(laneId)]);
  return { domains, mailboxes };
}
