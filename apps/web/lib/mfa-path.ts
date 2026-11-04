// The /mfa URL a user is sent to after the email code, keeping a safe return path (T-018, T-024). Pure; the caller
// passes a value that already went through safeNextPath.
export function mfaPath(next: string): string {
  return next === "/" ? "/mfa" : `/mfa?next=${encodeURIComponent(next)}`;
}
