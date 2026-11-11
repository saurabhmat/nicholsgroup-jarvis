// Builds the one RFC 2822 message the approved email actions send or save (T-232): plain text, UTF-8, no attachments, no
// HTML. Every header value is validated again here (no CR/LF or control characters), so a payload that somehow bypassed
// the schema still cannot inject a header. The Message-ID is derived from the action id, which is what makes a send
// findable (and so never repeated) after a crash.
import { ConnectorError } from "../contract/errors";

export const PORTAL_ACTION_HEADER = "X-Portal-Action-Id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const ADDRESS = /^[^\s@<>(),;:"[\]\\]{1,64}@[A-Za-z0-9.-]{1,255}$/;
const refused = (message: string) => new ConnectorError({ kind: "invalid_input", message });

export type MimeInput = {
  actionId: string;
  from: string;
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  subject: string;
  bodyText: string;
  /** RFC Message-ID of the message replied to (with angle brackets) and its References chain. */
  reply?: { messageId: string; references: string };
};

/** `<portal-{actionId}@{mailbox domain}>`: deterministic, so the sent message can be looked up by `rfc822msgid:`. */
export function portalMessageId(actionId: string, mailbox: string): string {
  if (!UUID.test(actionId)) throw refused("The action id is not valid");
  const domain = mailbox.split("@")[1];
  if (!domain || !ADDRESS.test(mailbox)) throw refused("The mailbox address is not valid");
  return `<portal-${actionId.toLowerCase()}@${domain.toLowerCase()}>`;
}

function header(name: string, value: string): string {
  if (CONTROL.test(value) || CONTROL.test(name)) throw refused("A header value contains control characters");
  return `${name}: ${value}`;
}
function addresses(list: readonly string[]): string {
  for (const a of list) if (!ADDRESS.test(a)) throw refused("A recipient address is not valid");
  return list.join(", ");
}
const encodeSubject = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const wrap76 = (b64: string): string => b64.replace(/(.{76})/g, "$1\r\n");

export function buildRfc822(input: MimeInput): string {
  if (!ADDRESS.test(input.from)) throw refused("The sender address is not valid");
  if (input.to.length === 0) throw refused("A recipient is required");
  const lines = [
    header("From", input.from),
    header("To", addresses(input.to)),
    ...(input.cc.length > 0 ? [header("Cc", addresses(input.cc))] : []),
    ...(input.bcc.length > 0 ? [header("Bcc", addresses(input.bcc))] : []),
    header("Subject", encodeSubject(input.subject)),
    header("Message-ID", portalMessageId(input.actionId, input.from)),
    header(PORTAL_ACTION_HEADER, input.actionId.toLowerCase()),
    ...(input.reply ? [header("In-Reply-To", input.reply.messageId), header("References", input.reply.references)] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  return `${lines.join("\r\n")}\r\n\r\n${wrap76(Buffer.from(input.bodyText.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64"))}\r\n`;
}

export const toBase64Url = (raw: string): string => Buffer.from(raw, "utf8").toString("base64url");
