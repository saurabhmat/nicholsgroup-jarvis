"use client";
// One chat bubble (T-297): the shell around a message's content. A click or tap on the bubble (not on a link or button inside it, and not while text is being selected) shows or hides that message's
// full time under its text; hovering shows it as a tooltip (`title`). The same time is ALWAYS in the page for screen readers (a visually hidden `<time>` the caller puts inside the bubble), so nothing
// depends on this click. Presentational only: it reads and stores nothing from the chat (the content comes in as children, drawn by the server or the client list as React text).
import { useState, type ReactNode } from "react";
import { cn } from "@nichols/ui";

export function MessageBubble({ mine, fullTime, children }: { mine: boolean; fullTime: string; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <div
      data-testid="bubble"
      title={fullTime}
      onClick={(e) => {
        if ((e.target as Element).closest("a, button")) return; // a link keeps being a link
        if ((window.getSelection()?.toString() ?? "") !== "") return; // selecting text is not a tap
        setShown((s) => !s);
      }}
      // a cap of about 65 characters of text, never wider than the pane minus a margin; own messages in the primary tint (text on it is the foreground colour: >= 4.5:1 in both themes, pinned by a test), incoming in the muted surface
      className={cn("min-w-0 max-w-[min(calc(100%-1.5rem),65ch)] rounded-card border px-3 py-1.5", mine ? "border-primary/25 bg-primary-tint text-foreground" : "border-border bg-muted text-foreground")}
    >
      {children}
      {shown ? (
        <p aria-hidden data-testid="bubble-time" className="mt-1 text-small text-muted-foreground">
          {fullTime}
        </p>
      ) : null}
    </div>
  );
}
