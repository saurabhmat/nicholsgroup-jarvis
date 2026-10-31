// Placeholder home (T-018) until the app shell (T-023) is built from the signed-off designs (D-20).
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@nichols/ui";
import { guards } from "@/lib/guards";
import { Suspense } from "react";
import { signOut } from "./sign-in/actions";

export default function Home() {
  return (
    <Suspense fallback={null}>
      <SignedInHome />
    </Suspense>
  );
}

async function SignedInHome() {
  // MFA is enforced from T-019 on; until then a signed-in AAL1 session may see this placeholder (no data on it).
  await (await guards()).requireSession({ allowAal1: true });
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
