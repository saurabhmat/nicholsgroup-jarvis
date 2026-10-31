// Two-factor step (T-019, D-6): enrol an authenticator app once (QR code or secret), then enter its 6-digit code at
// every sign-in. Functional layout on the provisional tokens; restyled with the signed-off designs (D-20).
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@nichols/ui";
import { AuthError, safeNextPath } from "@nichols/core/auth";
import { guards, mfa } from "@/lib/guards";
import { signOut } from "../sign-in/actions";
import { verifyTotp } from "./actions";

const ERRORS: Record<string, string> = {
  code: "That code is wrong. Use the current code from your authenticator app.",
  unavailable: "Verification is unavailable right now. Try again in a minute.",
};

export default function MfaPage(props: PageProps<"/mfa">) {
  return (
    <Suspense fallback={null}>
      <MfaStep {...props} />
    </Suspense>
  );
}

async function MfaStep({ searchParams }: PageProps<"/mfa">) {
  try {
    await (await guards()).requireSession({ allowAal1: true });
  } catch (e) {
    if (e instanceof AuthError) redirect("/sign-in");
    throw e;
  }
  const params = await searchParams;
  const next = safeNextPath(params.next);
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  const actions = await mfa();
  const status = await actions.status();
  // Step-up (T-020): `reauth=1` asks an AAL2 user for a fresh code before a sensitive action.
  const reauth = params.reauth === "1" && status.aal === "aal2" && status.verifiedFactorId !== null;
  if (status.aal === "aal2" && !reauth) redirect(next);

  // Enrolment shows a fresh secret on every visit until a code is verified (an unfinished one is replaced).
  const enrollment = status.verifiedFactorId ? null : await actions.beginTotpEnrollment();
  const factorId = status.verifiedFactorId ?? enrollment?.factorId ?? "";

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            {enrollment ? "Set up two-factor authentication" : reauth ? "Confirm it's you" : "Enter your authenticator code"}
          </CardTitle>
          <CardDescription>
            {enrollment
              ? "Scan this QR code with an authenticator app (for example Apple Passwords, Google Authenticator or 1Password), then enter the 6-digit code it shows."
              : "Open your authenticator app and enter the current 6-digit code."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {enrollment && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- inline SVG data from Supabase, not an asset */}
              <img
                src={enrollment.qrDataUri}
                alt="QR code for your authenticator app"
                width={192}
                height={192}
                className="mx-auto rounded-control bg-white p-2"
              />
              <div className="flex flex-col gap-1">
                <Label htmlFor="secret">Or enter this key manually</Label>
                <Input id="secret" readOnly value={enrollment.secret} className="font-mono text-sm" data-testid="totp-secret" />
              </div>
            </>
          )}
          <form action={verifyTotp} className="flex flex-col gap-4">
            {error && (
              <Alert variant="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <input type="hidden" name="factorId" value={factorId} />
            <input type="hidden" name="next" value={next} />
            <div className="flex flex-col gap-2">
              <Label htmlFor="code">Authenticator code</Label>
              <Input
                id="code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                autoFocus
                aria-invalid={error ? true : undefined}
              />
            </div>
            <Button type="submit">Verify</Button>
          </form>
          <form action={signOut}>
            <Button type="submit" variant="ghost" className="w-full">
              Sign out
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
