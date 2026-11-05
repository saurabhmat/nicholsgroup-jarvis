// Entry point (T-023): signed-in users go to the first company they may open; a user with none sees a plain notice.
// AAL2 only (T-019). The lane list comes from the server-side guards, never from the URL.
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@nichols/ui";
import { guards } from "@/lib/guards";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AuthError } from "@nichols/core/auth";
import { signOut } from "./sign-in/actions";

export default function Home() {
  return (
    <Suspense fallback={null}>
      <Entry />
    </Suspense>
  );
}

async function Entry() {
  await connection(); // per request, never prerendered
  let first: string | undefined;
  try {
    first = (await (await guards()).listLanes())[0]?.laneId;
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    if (e.reason === "no_session") redirect("/sign-in");
    if (e.reason === "mfa_required") redirect("/mfa");
    // forbidden / step_up_required: show the no-access notice below (redirecting to /sign-in could loop)
  }
  if (first) redirect(`/${first}`);
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Executive Portal</CardTitle>
          <CardDescription>You are signed in, but your account has no company access yet. Ask an administrator.</CardDescription>
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
