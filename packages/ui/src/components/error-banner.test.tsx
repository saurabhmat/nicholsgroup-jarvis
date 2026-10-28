import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBanner } from "./error-banner";

describe("ErrorBanner", () => {
  it("renders as an alert with title and description", () => {
    render(<ErrorBanner title="Sync failed" description="The last sync did not finish." />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Sync failed");
    expect(alert.textContent).toContain("The last sync did not finish.");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders a Contact support mailto link", () => {
    render(<ErrorBanner title="Sync failed" supportEmail="it@pub-k.org" />);
    const link = screen.getByRole("link", { name: "Contact support" });
    expect(link.getAttribute("href")).toBe("mailto:it@pub-k.org");
  });

  it("encodes the support subject", () => {
    render(<ErrorBanner title="x" supportEmail="it@pub-k.org" supportSubject="Reconnect needed" />);
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "mailto:it@pub-k.org?subject=Reconnect%20needed",
    );
  });

  it("does not render a link for an unsafe address", () => {
    render(<ErrorBanner title="x" supportEmail="javascript:alert(1)" />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders an action slot", () => {
    render(<ErrorBanner title="x" action={<button type="submit">Reconnect</button>} />);
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });
});
