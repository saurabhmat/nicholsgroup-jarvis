"use client";
// T-276 review: one Settings section that fails to load must not take the whole page to the route error page. Wraps one streamed section: the Suspense fallback
// (a skeleton) stays inside it and shows while the section loads; the error card shows only after a real error. A redirect, a not-found or an auth error (the
// page's own gates: they arrive here as errors with a Next digest, or named AuthError) is NOT a section error and is thrown again, so it still reaches Next.
// Only the error's name is logged.
import { Component, type ReactNode } from "react";
import { Card, CardDescription } from "@nichols/ui";

type State = { error: unknown; failed: boolean };

function isControlFlow(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { digest, name } = error as { digest?: unknown; name?: unknown };
  if (name === "AuthError") return true;
  return typeof digest === "string" && /^NEXT_(REDIRECT|NOT_FOUND|HTTP_ERROR_FALLBACK)/.test(digest);
}

export class SectionBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  override componentDidCatch(error: unknown): void {
    if (!isControlFlow(error)) console.error("settings.section_failed", { error: error instanceof Error ? error.name : "unknown" });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (isControlFlow(this.state.error)) throw this.state.error;
    return (
      <Card role="status" data-testid="section-error" className="p-4">
        <CardDescription>Could not load this section. Reload the page to try again.</CardDescription>
      </Card>
    );
  }
}
