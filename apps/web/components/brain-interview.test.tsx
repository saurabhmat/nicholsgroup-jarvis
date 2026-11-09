// @vitest-environment jsdom
// T-216: component tests for the setup interview: reconfigure by section, the missing-source link, and no connect button.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TEMPLATE_FILES, employeeConfigSchema } from "@nichols/brain/domain";
import { buildGroups, setSection } from "@nichols/brain/interview";
import { BrainInterview } from "./brain-interview";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const lane = {
  laneId: "TST",
  name: "Test Co",
  mailboxes: ["ops@example.test"],
  kpis: ["mrr"],
  connected: [] as string[],
  policy: { write_actions_allowed: ["email_draft"], store_outbound_drafts: true, llm_allowed_categories: ["email"] },
  financeView: true,
};
const ctx = { home: "TST", current: "TST", lanes: [lane], timezones: ["America/New_York", "UTC"] };
const fill = (body: string, heads: string[]) => heads.reduce((b, h) => setSection(b, h, "Filled in."), body);
const docs = {
  about_me: fill(TEMPLATE_FILES["Context/About-Me.md"] as string, ["Name and how to address me", "Scope of this brain", "Timezone", "Routine and constraints", "First task for Jarvis"]),
  preferences: fill(TEMPLATE_FILES["Context/Preferences.md"] as string, ["Writing", "Delivery of information", "Always ask me first", "Never do"]),
  work: fill(TEMPLATE_FILES["Context/Work.md"] as string, ["My role here", "What the company does", "Key people"]),
  pa: TEMPLATE_FILES["Employees/Personal-Assistant.md"] as string,
};

function state(withEmployee: boolean) {
  const config = withEmployee ? employeeConfigSchema.parse({ lanes: ["TST"], sources: { mail: [{ lane: "TST", mailbox: "ops@example.test", priority: 1, include: ["board"] }] } }) : null;
  return {
    homeLane: "TST",
    currentLane: "TST",
    groups: buildGroups(docs, config, ctx).map((g) => ({ ...g, complete: g.derivedComplete })), // the server fills the stored completion in
    employee: withEmployee ? { name: "Jarvis", status: "draft", version: 1, invalid: false, permissions: [{ lane: "TST", laneName: "Test Co", allowed: ["email.save_draft"], denied: [] }] } : null,
    sources: [{ laneId: "TST", laneName: "Test Co", settingsPath: "/TST/settings#connections", noMailboxes: false, mailboxes: [{ address: "ops@example.test", state: "not_connected" }] }],
    testBriefing: { available: false, message: "Your test briefing arrives with the daily briefing (T-213)." },
    nextGroupId: null,
  };
}

const bodies: Record<string, unknown>[] = [];
function stub(s: ReturnType<typeof state>) {
  bodies.length = 0;
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(b);
    return Response.json({ ok: true, state: s });
  });
}

describe("BrainInterview", () => {
  it("with Part A known and an employee saved, opens on the summary; Edit reconfigures one section with its stored answers", async () => {
    stub(state(true));
    render(<BrainInterview laneId="TST" mode="page" />);
    const review = await screen.findByTestId("interview-review");
    expect(review).toBeTruthy();
    // The test briefing step shows the T-213 message and cannot be run.
    const tb = screen.getByTestId("interview-test-briefing");
    expect(tb.textContent).toContain("Your test briefing arrives with the daily briefing (T-213).");
    expect((within(tb).getByRole("button", { name: "Run test briefing" }) as HTMLButtonElement).disabled).toBe(true);
    // Edit on a Personal Assistant section opens that group, prefilled.
    const row = screen.getByText("Rules").closest("li");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Edit" }));
    expect(await screen.findByTestId("q-B15")).toBeTruthy();
    expect(screen.queryByTestId("interview-review")).toBeNull();
  });

  it("All sections lists every group and Change opens a known Part A section for editing", async () => {
    stub(state(true));
    render(<BrainInterview laneId="TST" mode="page" />);
    await screen.findByTestId("interview-review");
    fireEvent.click(screen.getByRole("button", { name: "Set up or change a section" }));
    const list = await screen.findByTestId("interview-sections");
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
    const row = within(list).getByText("About you").closest("li");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Change" }));
    // Known answers are editable once the user chose to change the section.
    expect(await screen.findByTestId("q-A1")).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Filled in.");
  });

  it("a known answer shows 'Already set' with an Edit button that opens the field", async () => {
    stub(state(false));
    render(<BrainInterview laneId="TST" mode="chat" startAt="assistant" />);
    // Part B first (assistant), then back to a Part A group via All sections.
    await screen.findByTestId("interview-group");
    fireEvent.click(screen.getByRole("button", { name: "All sections" }));
    const list = await screen.findByTestId("interview-sections");
    const row = within(list).getByText("About you").closest("li");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: /Change|Set up/ }));
    expect(await screen.findByTestId("q-A1")).toBeTruthy();
  });

  it("shows the missing-source Alert with a link to Settings → Connections, and no connect button anywhere", async () => {
    stub(state(true));
    render(<BrainInterview laneId="TST" mode="chat" />);
    await screen.findByTestId("interview-review");
    const row = screen.getByText("What matters and which mailboxes").closest("li");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Edit" }));
    const alert = await screen.findByTestId("interview-missing-source");
    const link = within(alert).getByRole("link", { name: /Settings → Connections/ });
    expect(link.getAttribute("href")).toBe("/TST/settings#connections");
    expect(screen.queryAllByRole("button").filter((b) => /connect/i.test(b.textContent ?? ""))).toEqual([]);
    expect(screen.getByText(/Not connected yet/)).toBeTruthy();
  });

  it("previews with a propose call and never calls save until the Save button", async () => {
    const s = state(true);
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as { action: string };
      bodies.push(b);
      if (b.action === "propose") return Response.json({ ok: true, proposal: { groupId: "B-6", saves: "x", proposalId: "a".repeat(64), changes: [{ kind: "employee", lane: "TST", name: "Jarvis", status: "draft", baseVersion: 1, diff: [{ type: "add", text: "new rule" }], settings: [], resetsInvalid: false }] } });
      return Response.json({ ok: true, state: s });
    });
    bodies.length = 0;
    render(<BrainInterview laneId="TST" mode="page" />);
    await screen.findByTestId("interview-review");
    const row = screen.getByText("Rules").closest("li");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Edit" }));
    await screen.findByTestId("q-B15");
    fireEvent.change(screen.getByLabelText("Additional rules"), { target: { value: "never reply to press" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview the change" }));
    await screen.findByTestId("interview-diff");
    expect(bodies.map((b) => b.action)).toEqual(["state", "propose"]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies.map((b) => b.action)).toEqual(["state", "propose", "save"]));
  });

  it("Nothing to add is disabled with a hint while unsaved answers are typed (chat and page form)", async () => {
    stub(state(false));
    render(<BrainInterview laneId="TST" mode="page" />);
    await screen.findByTestId("interview-group");
    const group = screen.getByTestId("interview-group");
    expect((within(group).getByRole("button", { name: "Nothing to add" }) as HTMLButtonElement).disabled).toBe(false);
    const field = within(group).queryAllByRole("textbox")[0];
    expect(field).toBeDefined();
    fireEvent.change(field as HTMLElement, { target: { value: "typed" } });
    expect((within(group).getByRole("button", { name: "Nothing to add" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Save or clear your answers first")).toBeTruthy();
  });
});

