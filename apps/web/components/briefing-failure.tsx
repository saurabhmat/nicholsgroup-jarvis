// The fixed failure reason for the AI briefing (T-234 part 0): short text from a closed set of codes. The admin hint is
// computed on the server and arrives as a prop only for admins (owner, admin_technical), so hint strings are never in
// this client bundle. Names only: never a value, a provider message or a secret.
import { FAILURE_TEXT, type FailureCode } from "@nichols/briefing/domain";

export const failureText = (code: FailureCode | null | undefined): string => (code ? FAILURE_TEXT[code] : "Could not be prepared");

export function FailureReason({ code, hint = null, prefix = "AI summary unavailable" }: { code: FailureCode | null | undefined; hint?: string | null; prefix?: string }) {
  return (
    <span data-testid="briefing-failure" className="text-small text-muted-foreground">
      {prefix}: {failureText(code)}
      {hint ? (
        <span data-testid="briefing-failure-hint" className="block">
          {hint}
        </span>
      ) : null}
    </span>
  );
}
