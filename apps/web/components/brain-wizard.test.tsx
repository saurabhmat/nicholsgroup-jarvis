// @vitest-environment jsdom
// T-226: the guided onboarding wizard (BrainInterview mode "wizard"): save only on click, skip keeps "Not provided", back keeps
// answers, deep link to a step, the finish screen. A stateful fake of the interview API (the same one the chat uses).
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TEMPLATE_FILES } from "@nichols/brain/domain";
import { GROUPS, buildGroups, setSection } from "@nichols/brain/interview";
import { BrainInterview } from "./brain-interview";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  refresh.mockClear();
  vi.unstubAllGlobals();
});

const lane = {
  laneId: "TST",
  name: "Test Co",
  mailboxes: ["ops@example.test"],
  kpis: ["mrr"],
  connected: ["ops@example.test"],
  policy: { write_actions_allowed: ["email_draft"], store_outbound_drafts: true, llm_allowed_categories: ["email"] },
  financeView: true,
};
const ctx = { home: "TST", current: "TST", lanes: [lane], timezones: ["America/New_York", "UTC"] };
const fill = (body: string, heads: string[]) => heads.reduce((b, h) => setSection(b, h, "Filled in."), body);
const ABOUT_ME = ["Name and how to address me", "Scope of this brain", "Timezone", "Routine and constraints", "First task for Jarvis"];

type Req = { action: string; group?: string; proposalId?: string; answers?: Record<string, Record<string, unknown>> };

/** An in-memory interview API: empty pages at first; saving A-1 fills the About-Me page. */
function fakeApi(opts: { allKnown?: boolean } = {}) {
  const calls: Req[] = [];
  let aboutMe = opts.allKnown ? fill(TEMPLATE_FILES["Context/About-Me.md"] as string, ABOUT_ME) : (TEMPLATE_FILES["Context/About-Me.md"] as string);
  const completed = new Set<string>();
  let noChanges = false;
  let failCompletion = false;
  const state = () => ({
    homeLane: "TST",
    currentLane: "TST",
    groups: buildGroups({ about_me: aboutMe, preferences: TEMPLATE_FILES["Context/Preferences.md"] as string, work: TEMPLATE_FILES["Context/Work.md"] as string, pa: TEMPLATE_FILES["Employees/Personal-Assistant.md"] as string }, null, ctx).map((g) => ({ ...g, complete: completed.has(g.id) })),
    employee: null,
    sources: [{ laneId: "TST", laneName: "Test Co", settingsPath: "/TST/settings#connections", noMailboxes: false, mailboxes: [{ address: "ops@example.test", state: "connected" }] }],
    testBriefing: { available: false, message: "Your test briefing arrives with the daily briefing (T-213)." },
    nextGroupId: null,
  });
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body) as Req;
    calls.push(b);
    if (b.action === "state") return Response.json({ ok: true, state: state() });
    if (b.action === "propose")
      return Response.json({ ok: true, proposal: { groupId: b.group, saves: "Context/About-Me.md", proposalId: "a".repeat(64), changes: noChanges ? [] : [{ kind: "document", lane: "TST", path: "Context/About-Me.md", baseVersion: 1, diff: [{ type: "add", text: "Pat Example" }] }] } });
    if (b.action === "save") {
      if (!noChanges) aboutMe = fill(aboutMe, ABOUT_ME);
      if (failCompletion) {
        failCompletion = false;
        return Response.json({ ok: true, completed: false, state: state() });
      }
      completed.add(String(b.group));
      return Response.json({ ok: true, completed: true, state: state() });
    }
    if (b.action === "complete") {
      completed.add(String(b.group));
      return Response.json({ ok: true, state: state() });
    }
    return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
  });
  return Object.assign(calls, { keepDefaults: () => (noChanges = true), failNextCompletion: () => (failCompletion = true) });
}

const saves = (calls: Req[]) => calls.filter((c) => c.action === "save");

describe("BrainInterview mode wizard", () => {
  it("opens on the intro with the three lines and Start; nothing is called but state", async () => {
    const calls = fakeApi();
    render(<BrainInterview laneId="TST" mode="wizard" />);
    const intro = await screen.findByTestId("wizard-intro");
    expect(within(intro).getAllByRole("listitem")).toHaveLength(3);
    expect(intro.textContent).toContain("never stores passwords, account numbers, or client or matter details");
    expect(intro.textContent).toContain("Nothing is saved until you approve it");
    expect(calls.map((c) => c.action)).toEqual(["state"]);
    fireEvent.click(within(intro).getByRole("button", { name: "Start" }));
    expect(await screen.findByTestId("q-A1")).toBeTruthy();
  });

  it("shows the rail with all 10 sections (current marked), a progress bar, 'Step 1 of 10' and the bank's prompts", async () => {
    fakeApi();
    render(<BrainInterview laneId="TST" mode="wizard" />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    const rail = await screen.findByTestId("wizard-rail");
    const items = within(rail).getAllByRole("button");
    expect(items).toHaveLength(GROUPS.length);
    expect(items.filter((b) => b.getAttribute("aria-current") === "step")).toHaveLength(1);
    expect(items[0]?.getAttribute("aria-current")).toBe("step");
    expect(items[0]?.className).toContain("border-gold");
    expect(items[1]?.className).not.toContain("border-gold");
    expect(screen.getByTestId("wizard-step-label").textContent).toBe("Step 1 of 10");
    expect(screen.getByRole("progressbar", { name: "Setup progress" }).getAttribute("aria-valuemax")).toBe("10");
    const group = screen.getByTestId("interview-group");
    expect(group.querySelectorAll("[data-testid^='q-']").length).toBeLessThanOrEqual(3);
  });

  it("previews first and writes only when 'Save & continue' is clicked", async () => {
    const calls = fakeApi();
    render(<BrainInterview laneId="TST" mode="wizard" />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await screen.findByTestId("q-A1");
    fireEvent.change(screen.getByLabelText("Name", { exact: true }), { target: { value: "Pat Example" } });
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "work" } });
    expect(screen.queryByRole("button", { name: "Save & continue" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
    const diff = await screen.findByTestId("interview-diff");
    expect(diff.textContent).toContain("+ Pat Example");
    expect(saves(calls)).toHaveLength(0); // the preview never writes
    fireEvent.click(screen.getByRole("button", { name: "Save & continue" }));
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(saves(calls)[0]).toMatchObject({ group: "A-1", proposalId: "a".repeat(64) });
    // moves on to the next section, which is now the current one
    await waitFor(() => expect(screen.getByTestId("interview-group").getAttribute("data-group")).toBe("A-2"));
    expect(screen.getByTestId("interview-notice").textContent).toContain("Saved: About you");
    expect(refresh).toHaveBeenCalledTimes(1); // the menu badge re-reads the count
  });

  it("Skip for now saves nothing and leaves the section 'Not provided' on the finish screen", async () => {
    const calls = fakeApi();
    render(<BrainInterview laneId="TST" mode="wizard" />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    for (let i = 0; i < GROUPS.length; i++) {
      await screen.findByTestId("interview-group");
      fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    }
    const finish = await screen.findByTestId("wizard-finish");
    expect(saves(calls)).toHaveLength(0);
    expect(calls.some((c) => c.action === "propose")).toBe(false);
    expect(within(finish).getAllByText("Not provided")).toHaveLength(GROUPS.length);
    // finish: test briefing disabled with the reason, Ask Jarvis links to the assistant
    const tb = within(finish).getByTestId("interview-test-briefing");
    expect(tb.textContent).toContain("Arrives with the daily briefing");
    expect((within(tb).getByRole("button", { name: "Run test briefing" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(finish).getByRole("link", { name: "Ask Jarvis" }).getAttribute("href")).toBe("/TST/assistant");
    // Edit link per section, with the deep-link href
    const edit = within(finish).getByTestId("finish-A-2").querySelector("a");
    expect(edit?.getAttribute("href")).toBe("/TST/onboarding?step=A-2");
    fireEvent.click(edit as HTMLElement);
    await waitFor(() => expect(screen.getByTestId("interview-group").getAttribute("data-group")).toBe("A-2"));
  });

  it("Back keeps the answers typed on the screen you left", async () => {
    fakeApi();
    render(<BrainInterview laneId="TST" mode="wizard" />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await screen.findByTestId("q-A1");
    fireEvent.change(screen.getByLabelText("Name", { exact: true }), { target: { value: "Pat Example" } });
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(screen.getByTestId("interview-group").getAttribute("data-group")).toBe("A-2"));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByTestId("interview-group").getAttribute("data-group")).toBe("A-1"));
    expect((screen.getByLabelText("Name", { exact: true }) as HTMLInputElement).value).toBe("Pat Example");
    // Back from the first section returns to the intro
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByTestId("wizard-intro")).toBeTruthy();
  });

  it("a step from the URL opens exactly that section; an unknown step falls back to the first incomplete one", async () => {
    fakeApi();
    const { unmount } = render(<BrainInterview laneId="TST" mode="wizard" initialStep="A-3" hadStep />);
    await screen.findByTestId("interview-group");
    expect(screen.getByTestId("interview-group").getAttribute("data-group")).toBe("A-3");
    expect(screen.getByTestId("wizard-step-label").textContent).toBe("Step 3 of 10");
    unmount();
    render(<BrainInterview laneId="TST" mode="wizard" initialStep={undefined} hadStep />);
    await screen.findByTestId("interview-group");
    expect(screen.getByTestId("interview-group").getAttribute("data-group")).toBe("A-1");
    expect(screen.queryByTestId("wizard-intro")).toBeNull();
  });

  it("known answers show 'Already set: …' with an Edit button, and nothing is asked until Edit", async () => {
    fakeApi({ allKnown: true });
    render(<BrainInterview laneId="TST" mode="wizard" initialStep="A-1" hadStep />);
    const known = await screen.findByTestId("q-A1-known");
    expect(known.textContent).toContain("Already set:");
    expect(screen.queryByTestId("q-A1")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy(); // nothing to preview
    fireEvent.click(within(known).getByRole("button", { name: "Edit" }));
    expect(await screen.findByTestId("q-A1")).toBeTruthy();
  });

  it("shows an API failure as fixed text, never the server's words", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "<b>boom</b> secret-canary" }, { status: 500 }));
    render(<BrainInterview laneId="TST" mode="wizard" />);
    const err = await screen.findByTestId("interview-error");
    expect(err.textContent).not.toContain("secret-canary");
    expect(err.textContent).not.toContain("boom");
  });

  it("keeping every default then Save: the Save button is there with 'nothing would change' and it records the section", async () => {
    const calls = fakeApi();
    calls.keepDefaults();
    render(<BrainInterview laneId="TST" mode="wizard" initialStep="A-1" hadStep />);
    await screen.findByTestId("q-A1");
    fireEvent.change(screen.getByLabelText("Name", { exact: true }), { target: { value: "Pat Example" } });
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "work" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
    expect((await screen.findByTestId("interview-proposal")).textContent).toContain("Nothing would change");
    fireEvent.click(screen.getByRole("button", { name: "Save & continue" }));
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("interview-group").getAttribute("data-group")).toBe("A-2"));
    expect(screen.getByTestId("wizard-progress-text").textContent).toBe("1 of 10 saved");
  });

  it("Nothing to add marks the section done without a preview or a save, and the finish screen still says Not provided", async () => {
    const calls = fakeApi();
    render(<BrainInterview laneId="TST" mode="wizard" initialStep="A-1" hadStep />);
    await screen.findByTestId("q-A1");
    fireEvent.click(screen.getByRole("button", { name: "Nothing to add" }));
    await waitFor(() => expect(screen.getByTestId("interview-group").getAttribute("data-group")).toBe("A-2"));
    expect(calls.filter((c) => c.action === "complete")).toEqual([{ action: "complete", group: "A-1" }]);
    expect(calls.some((c) => c.action === "propose" || c.action === "save")).toBe(false);
    expect(screen.getByTestId("wizard-progress-text").textContent).toBe("1 of 10 saved");
    expect(screen.getByTestId("interview-notice").textContent).toContain("Marked as done: About you");
    // the rest is skipped: A-1's fields are still "Not provided" on the finish screen
    for (let i = 0; i < GROUPS.length - 1; i++) {
      await screen.findByTestId("interview-group");
      fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    }
    const a1 = await screen.findByTestId("finish-A-1");
    expect(a1.textContent).toContain("Not provided");
  });

  it("a save that could not record completion keeps you on the section with the fixed message, and the next Save records it", async () => {
    const calls = fakeApi();
    calls.failNextCompletion();
    render(<BrainInterview laneId="TST" mode="wizard" initialStep="A-1" hadStep />);
    await screen.findByTestId("q-A1");
    fireEvent.change(screen.getByLabelText("Name", { exact: true }), { target: { value: "Pat Example" } });
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "work" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save & continue" }));
    await waitFor(() => expect(screen.getByTestId("interview-notice").textContent).toBe("Your answers were saved. Click Save again to mark this section done."));
    expect(screen.getByTestId("interview-group").getAttribute("data-group")).toBe("A-1"); // did not move on
    fireEvent.click(await screen.findByRole("button", { name: "Save & continue" }));
    await waitFor(() => expect(screen.getByTestId("interview-group").getAttribute("data-group")).toBe("A-2"));
    expect(saves(calls)).toHaveLength(2);
  });

  it("Nothing to add is disabled with a hint while there are unsaved typed answers, and works again once cleared", async () => {
    fakeApi();
    render(<BrainInterview laneId="TST" mode="wizard" initialStep="A-1" hadStep />);
    await screen.findByTestId("q-A1");
    const btn = () => screen.getByRole("button", { name: "Nothing to add" }) as HTMLButtonElement;
    expect(btn().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Name", { exact: true }), { target: { value: "Pat" } });
    expect(btn().disabled).toBe(true);
    expect(screen.getByText("Save or clear your answers first")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name", { exact: true }), { target: { value: "" } });
    expect(btn().disabled).toBe(false);
  });

  it("an untouched section is not done: the progress starts at 0 and Skip for now does not complete anything", async () => {
    const calls = fakeApi();
    render(<BrainInterview laneId="TST" mode="wizard" initialStep="A-1" hadStep />);
    await screen.findByTestId("q-A1");
    expect(screen.getByTestId("wizard-progress-text").textContent).toBe("0 of 10 saved");
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(screen.getByTestId("interview-group").getAttribute("data-group")).toBe("A-2"));
    expect(calls.some((c) => c.action === "complete" || c.action === "save")).toBe(false);
  });

  // jsdom has no layout or colours, so contrast is covered by the Playwright axe check; structure and names are checked here.
  const violations = async () => (await axe.run(document.body, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] }, rules: { "color-contrast": { enabled: false } } })).violations.map((v) => v.id);

  it("has no axe violations on the intro, a question screen with the diff, and the finish screen", async () => {
    fakeApi();
    render(<BrainInterview laneId="TST" mode="wizard" />);
    await screen.findByTestId("wizard-intro");
    expect(await violations()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByTestId("q-A1");
    fireEvent.change(screen.getByLabelText("Name", { exact: true }), { target: { value: "Pat Example" } });
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "work" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
    await screen.findByTestId("interview-diff");
    expect(await violations()).toEqual([]);
    for (let i = 0; i < GROUPS.length; i++) {
      await screen.findByTestId("interview-group");
      fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    }
    await screen.findByTestId("wizard-finish");
    expect(await violations()).toEqual([]);
  });
});
