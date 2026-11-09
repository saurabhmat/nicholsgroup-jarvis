// Errors of the brain store (T-210). A fixed code and message only: never row text, SQL detail or the caller's input
// (pages are the user's private text, and a message could be logged).
export const BRAIN_ERROR_CODES = ["invalid", "secret", "sensitive_ssn", "sensitive_card", "sensitive_bank", "config_invalid", "version_conflict", "forbidden", "rate_limited", "unavailable"] as const;
export type BrainErrorCode = (typeof BRAIN_ERROR_CODES)[number];

const MESSAGES: Record<BrainErrorCode, string> = {
  invalid: "The brain request is not valid.",
  secret: "The text looks like a credential and was not saved.",
  sensitive_ssn: "The text contains what looks like a Social Security number (###-##-####), so it was not saved. Remove it and try again.",
  sensitive_card: "The text contains what looks like a payment card number, so it was not saved. Remove it and try again.",
  sensitive_bank: "The text contains what looks like a bank account, routing or IBAN number, so it was not saved. Remove it and try again.",
  config_invalid: "The employee settings are not valid for this lane.",
  version_conflict: "The page changed since it was read. Reload it and try again.",
  forbidden: "No access to the brain in this lane.",
  rate_limited: "Too many imports in the last hour. Try again later.",
  unavailable: "The brain is unavailable right now.",
};

export class BrainError extends Error {
  override readonly name = "BrainError";
  readonly code: BrainErrorCode;
  constructor(code: BrainErrorCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}

/** Maps a PostgREST error from the brain functions (SQLSTATE and our fixed message prefixes) to a BrainError. */
export function toBrainError(error: { code?: string | undefined; message?: string | undefined } | null | undefined): BrainError {
  const code = error?.code;
  const message = error?.message ?? "";
  if (code === "40001" || message.includes("version_conflict")) return new BrainError("version_conflict");
  if (code === "22023") {
    if (message.includes("credential")) return new BrainError("secret");
    if (message.includes("brain: sensitive_ssn")) return new BrainError("sensitive_ssn");
    if (message.includes("brain: sensitive_card")) return new BrainError("sensitive_card");
    if (message.includes("brain: sensitive_bank")) return new BrainError("sensitive_bank");
    return new BrainError("invalid");
  }
  if (code === "54000" && message.includes("too many imports")) return new BrainError("rate_limited");
  if (code === "42501" || code === "55000") return new BrainError("forbidden");
  return new BrainError("unavailable");
}
