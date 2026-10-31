// Sign-in, step 2 (T-018): the 6-digit code from the email. Works inside the installed iPhone app (D-6), unlike the
// email link, which opens in Safari.
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@nichols/ui";
import { Suspense } from "react";
import { verifyCode } from "../actions";

const ERRORS: Record<string, string> = {
  code: "That code is wrong or has expired.",
  unavailable: "Sign-in is unavailable right now. Try again in a minute.",
};

export default function VerifyPage(props: PageProps<"/sign-in/verify">) {
  return (
    <Suspense fallback={null}>
      <VerifyForm {...props} />
    </Suspense>
  );
}

async function VerifyForm({ searchParams }: PageProps<"/sign-in/verify">) {
  if (!(await cookies()).has("signin_pending")) redirect("/sign-in");
  const params = await searchParams;
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Enter your code</CardTitle>
          <CardDescription>Check your email for a 6-digit code. It expires in 10 minutes.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={verifyCode} className="flex flex-col gap-4">
            {error && (
              <Alert variant="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="code">Code</Label>
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
            <Button type="submit">Sign in</Button>
            <Link href="/sign-in" className="text-center text-sm text-muted-foreground underline-offset-4 hover:underline">
              Use a different email or get a new code
            </Link>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
