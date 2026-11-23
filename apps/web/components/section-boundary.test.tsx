// @vitest-environment jsdom
// T-276 review: one failing Settings section shows a neutral card and the others still render; redirect / not-found / auth errors are not section errors.
import { Component, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SectionBoundary } from "./section-boundary";

afterEach(cleanup);
const Boom = ({ error }: { error: unknown }): ReactNode => {
  throw error;
};
class Outer extends Component<{ children: ReactNode }, { caught: string | null }> {
  override state = { caught: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { caught: (e as { digest?: string }).digest ?? (e as Error).name };
  }
  override render() {
    return this.state.caught ? <p data-testid="outer">{this.state.caught}</p> : this.props.children;
  }
}

describe("SectionBoundary", () => {
  it("shows nothing extra on a healthy section", () => {
    render(<SectionBoundary><p>fine</p></SectionBoundary>);
    expect(screen.getByText("fine")).toBeTruthy();
    expect(screen.queryByTestId("section-error")).toBeNull();
  });

  it("one section's failure shows the neutral card (no error text) and the sibling sections still render", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <>
        <SectionBoundary><Boom error={new Error("secret detail")} /></SectionBoundary>
        <SectionBoundary><p>other section</p></SectionBoundary>
      </>,
    );
    expect(screen.getByTestId("section-error").textContent).toBe("Could not load this section. Reload the page to try again.");
    expect(screen.queryByText(/secret detail/)).toBeNull();
    expect(screen.getByText("other section")).toBeTruthy();
  });

  it.each([
    ["a redirect", Object.assign(new Error("r"), { digest: "NEXT_REDIRECT;replace;/sign-in;307;" }), "NEXT_REDIRECT;replace;/sign-in;307;"],
    ["a not-found", Object.assign(new Error("n"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" }), "NEXT_HTTP_ERROR_FALLBACK;404"],
    ["an auth error", Object.assign(new Error("a"), { name: "AuthError" }), "AuthError"],
  ])("%s is not caught as a section error: it propagates", (_n, error, caught) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<Outer><SectionBoundary><Boom error={error} /></SectionBoundary></Outer>);
    expect(screen.getByTestId("outer").textContent).toBe(caught);
    expect(screen.queryByTestId("section-error")).toBeNull();
  });
});
