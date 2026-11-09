// @vitest-environment jsdom
// T-230 B: "Temporary: connection test" lives under Developer tools and is collapsed until opened. Nothing else changed:
// the same two actions (Connect QuickBooks is a same-origin form POST; Check connection is the read-only check).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConnectionTestSection } from "./connection-test-section";

afterEach(cleanup);

describe("ConnectionTestSection", () => {
  it("is a Developer tools section whose connection test is collapsed by default", () => {
    render(<ConnectionTestSection laneId="PKG" />);
    expect(screen.getByRole("heading", { level: 2, name: "Developer tools" })).toBeTruthy();
    const details = screen.getByTestId("connection-test") as HTMLDetailsElement;
    expect(details.tagName).toBe("DETAILS");
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Temporary: connection test");
    expect(details.hasAttribute("open")).toBe(false);
  });

  it("keeps the two actions: Connect QuickBooks (POST form to the start route) and Check connection", () => {
    render(<ConnectionTestSection laneId="PKG" />);
    const connect = screen.getByText("Connect QuickBooks", { selector: "button" });
    const form = connect.closest("form") as HTMLFormElement;
    expect(form.method).toBe("post");
    expect(form.getAttribute("action")).toBe("/api/connect/qbo/start?lane=PKG");
    expect(screen.getByText("Check connection", { selector: "button" })).toBeTruthy();
  });

  it("the section anchor matches the Settings sub-nav", () => {
    const { container } = render(<ConnectionTestSection laneId="PKG" />);
    expect(container.querySelector("#developer-tools")).toBeTruthy();
  });
});
