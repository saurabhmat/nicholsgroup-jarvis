// Errors of the brain store (T-210). A fixed code and message only: never row text, SQL detail or the caller's input
// (pages are the user's private text, and a message could be logged).
export const BRAIN_ERROR_CODES = ["invalid", "secret", "version_conflict", "forbidden", "unavailable"] as const;
export type BrainErrorCode = (typeof BRAIN_ERROR_CODES)[number];

const MESSAGES: Record<BrainErrorCode, string> = {
  invalid: "The brain request is not valid.",
  secret: "The text looks like a credential and was not saved.",
  version_conflict: "The page changed since it was read. Reload it and try again.",
  forbidden: "No access to the brain in this lane.",
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
  if (code === "22023") return new BrainError(message.includes("credential") ? "secret" : "invalid");
  if (code === "42501" || code === "55000") return new BrainError("forbidden");
  return new BrainError("unavailable");
}
