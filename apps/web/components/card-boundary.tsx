"use client";
// T-245: one failing Finance card or section must not take down the page. A server component that throws is sent to the client as
// an error at its own position. During server rendering the Suspense boundary contains it (React sends the "Loading" fallback and
// retries on the client), and on the client this error boundary catches it and shows "could not load". The Suspense fallback is a
// neutral "Loading": React also streams large boundaries after the shell, so the fallback can show briefly on a healthy page. Only the
// error's name is logged: no figures, ids or messages (rule 4).
import { Component, Suspense, type ReactNode } from "react";
import { KpiCard, PageSection } from "@nichols/ui";

const UNAVAILABLE = "Could not load. Reload in a minute.";
const LOADING = "Loading…";

function Fallback({ label, kind, text }: { label: string; kind: "kpi" | "section"; text: string }) {
  return kind === "kpi" ? <KpiCard label={label} headingLevel="h2" statusText={text} /> : <PageSection title={label} emptyTitle={text} />;
}

type Props = { label: string; kind: "kpi" | "section"; children: ReactNode };

class Boundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error("finance.card_failed", { card: this.props.label, error: error instanceof Error ? error.name : "unknown" });
  }

  override render(): ReactNode {
    return this.state.failed ? <Fallback label={this.props.label} kind={this.props.kind} text={UNAVAILABLE} /> : this.props.children;
  }
}

/** Wraps one Finance card or section: a failure inside shows "could not load" for that card only. */
export function CardBoundary({ label, kind, children }: Props) {
  return (
    <Boundary label={label} kind={kind}>
      <Suspense fallback={<Fallback label={label} kind={kind} text={LOADING} />}>{children}</Suspense>
    </Boundary>
  );
}
