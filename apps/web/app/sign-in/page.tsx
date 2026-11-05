// Sign-in, step 1 (T-018): email address → a 6-digit code by email. Functional layout on the provisional tokens;
// restyled when the signed-off designs (D-20) arrive.
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@nichols/ui";
import { safeNextPath } from "@nichols/core/auth";
import { Suspense } from "react";
import { sendCode } from "./actions";

const ERRORS: Record<string, string> = {
  email: "Enter a valid email address.",
  unavailable: "Sign-in is unavailable right now. Try again in a minute.",
  link: "That sign-in link has expired or was already used. Request a new code.",
  attempts: "Too many wrong codes. Request a new code.",
};

// Reads search params (request data), so it renders inside a Suspense boundary (Next 16 Cache Components).
export default function SignInPage(props: PageProps<"/sign-in">) {
  return (
    <Suspense fallback={null}>
      <SignInForm {...props} />
    </Suspense>
  );
}

async function SignInForm({ searchParams }: PageProps<"/sign-in">) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  const next = safeNextPath(params.next);
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>We will email you a 6-digit code.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={sendCode} className="flex flex-col gap-4">
            {error && (
              <Alert variant="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <input type="hidden" name="next" value={next} />
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
            </div>
            <Button type="submit">Email me a code</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
