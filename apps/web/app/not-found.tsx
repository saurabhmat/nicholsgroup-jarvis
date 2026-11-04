// One 404 for every missing page and every lane the user cannot open (T-023): it says nothing about which lanes exist.
import Link from "next/link";
import { EmptyState } from "@nichols/ui";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-content items-center justify-center p-4">
      <EmptyState title="Page not found" description="This page does not exist, or you do not have access to it." action={<Link className="text-sm font-medium text-primary underline" href="/">Go to your home page</Link>} />
    </main>
  );
}
