"use client";
// Copy-to-clipboard for a reply draft (T-231d). Copies the exact text shown; says so, or says it could not.
import { useState } from "react";
import { Button } from "@nichols/ui";

export function CopyTextButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" variant="outline" className="h-11 md:h-9" onClick={() => void copy()}>
        {label}
      </Button>
      <span role="status" aria-live="polite" className="text-small text-muted-foreground">
        {state === "copied" ? "Copied" : state === "failed" ? "Could not copy: select the text instead" : ""}
      </span>
    </span>
  );
}
