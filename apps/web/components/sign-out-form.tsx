"use client";
// A sign-out form that first removes this tab's unsent drafts (T-234 part 3): the next person on the tab must not find them.
import type { ReactNode } from "react";
import { clearAllDrafts } from "@/lib/reply-draft-store";

export function SignOutForm({ action, children }: { action: (formData: FormData) => void | Promise<void>; children: ReactNode }) {
  return (
    <form
      action={async (formData) => {
        clearAllDrafts();
        await action(formData);
      }}
    >
      {children}
    </form>
  );
}
