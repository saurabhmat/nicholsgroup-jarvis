// Placeholder home (T-018) until the app shell (T-023) is built from the signed-off designs (D-20). AAL2 only (T-019).
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@nichols/ui";
import { guards } from "@/lib/guards";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AuthError } from "@nichols/core/auth";
import { signOut } from "./sign-in/actions";

export default function Home() {
  return (
    <Suspense fallback={null}>
      <SignedInHome />
    </Suspense>
  );
}

async function SignedInHome() {
  try {
    await (await guards()).requireSession();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.reason === "mfa_required" ? "/mfa" : "/sign-in");
    throw e;
  }
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Executive Portal</CardTitle>
          <CardDescription>You are signed in.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={signOut}>
            <Button type="submit" variant="outline">
              Sign out
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
