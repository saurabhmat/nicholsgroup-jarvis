// The fixed failure reason for the AI briefing (T-234 part 0): short text from a closed set of codes, plus a hint for
// admins only (owner, admin_technical). Names only: never a value, a provider message or a secret.
import { FAILURE_ADMIN_HINT, FAILURE_TEXT, type FailureCode } from "@nichols/briefing/domain";

export const failureText = (code: FailureCode | null | undefined): string => (code ? FAILURE_TEXT[code] : "Could not be prepared");

export function FailureReason({ code, isAdmin, prefix = "AI summary unavailable" }: { code: FailureCode | null | undefined; isAdmin: boolean; prefix?: string }) {
  return (
    <span data-testid="briefing-failure" className="text-small text-muted-foreground">
      {prefix}: {failureText(code)}
      {isAdmin && code ? (
        <span data-testid="briefing-failure-hint" className="block">
          {FAILURE_ADMIN_HINT[code]}
        </span>
      ) : null}
    </span>
  );
}
