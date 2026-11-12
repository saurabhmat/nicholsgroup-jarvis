// T-235 part 5 review: the FINAL classes after cn() on the shared components (tailwind-merge once dropped text-label).
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BookBalanceLabel } from "./book-balance";
import { Card, CardTitle } from "./card";
import { EmptyState } from "./empty-state";
import { KpiCard } from "./kpi-card";
import { PageSection } from "./page-section";
import { SlimCard } from "./slim-card";

const classes = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/);

describe("part 5 shared components keep their type-scale classes after cn()", () => {
  it("KpiCard label is 12px uppercase Inter, not the 20px serif card title", () => {
    render(<KpiCard label="Cash" value="$1.00" />);
    const c = classes(screen.getByRole("heading", { name: "Cash" }));
    expect(c).toContain("text-label");
    expect(c).toContain("uppercase");
    expect(c).toContain("text-muted-foreground");
    expect(c).not.toContain("text-card-title");
    expect(c).not.toContain("font-heading");
    expect(c).toContain("font-sans");
  });

  it("BookBalanceLabel keeps text-label with its colour", () => {
    render(<BookBalanceLabel />);
    const c = classes(screen.getByText("Book balance"));
    expect(c).toContain("text-label");
    expect(c).toContain("text-muted-foreground");
    expect(c).toContain("uppercase");
  });

  it("Card and CardTitle: p-6 body-size card, serif 20px title", () => {
    render(
      <Card data-testid="card">
        <CardTitle>Title</CardTitle>
      </Card>,
    );
    const card = classes(screen.getByTestId("card"));
    expect(card).toEqual(expect.arrayContaining(["p-6", "text-body", "text-card-foreground", "rounded-card"]));
    const t = classes(screen.getByRole("heading", { name: "Title" }));
    expect(t).toEqual(expect.arrayContaining(["font-heading", "text-card-title", "font-semibold"]));
    expect(t).not.toContain("uppercase");
  });

  it("PageSection: p-6 card, serif card title, small muted note", () => {
    render(<PageSection title="Section" note="a note"><p>x</p></PageSection>);
    expect(classes(screen.getByRole("region", { name: "Section" }))).toEqual(expect.arrayContaining(["p-6", "text-body", "text-card-foreground"]));
    expect(classes(screen.getByRole("heading", { name: "Section" }))).toEqual(expect.arrayContaining(["font-heading", "text-card-title"]));
    const note = classes(screen.getByText("a note"));
    expect(note).toEqual(expect.arrayContaining(["text-small", "text-muted-foreground"]));
  });

  it("SlimCard: 13px muted text, py-3 px-6", () => {
    render(<SlimCard title="News">one line</SlimCard>);
    expect(classes(screen.getByRole("region", { name: "News" }))).toEqual(expect.arrayContaining(["text-small", "text-muted-foreground", "px-6", "py-3"]));
  });

  it("EmptyState: serif 20px title, 15px muted description", () => {
    render(<EmptyState title="Nothing" description="Later" />);
    expect(classes(screen.getByText("Nothing"))).toEqual(expect.arrayContaining(["font-heading", "text-card-title"]));
    expect(classes(screen.getByText("Later"))).toEqual(expect.arrayContaining(["text-body", "text-muted-foreground"]));
  });
});
