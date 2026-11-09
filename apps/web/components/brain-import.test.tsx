// @vitest-environment jsdom
// T-220: the import UI. Instructions and prompts per tab, the warning under every tab, the checklist (all unticked, grouped, editable),
// nothing sent to propose or save without a tick and a click, the pasted text dropped after the facts are found, the zip path (read in
// the browser, per-page preview and Save), the "needs the AI" state, and axe. The import API is a stateful fake; no model is involved.
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BrainImport } from "./brain-import";
import { CHATGPT_PROMPT, CLAUDE_PROMPT, WARNING_LINE } from "@/lib/brain-import-client";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Req = Record<string, unknown> & { action: string };
const cands = [
  { id: "c1", fact: "Prefers short replies", evidence: "I prefer short replies.", target: "preferences", targetLabel: "Preferences", section: "Writing", flags: [] },
  { id: "c2", fact: "Wants two new locations", evidence: null, target: "about_me", targetLabel: "About me", section: "Goals right now", flags: [] },
  { id: "c3", fact: "Works on a client matter", evidence: null, target: "work", targetLabel: "Work for this company", section: "Key people", flags: ["possible_nl_content"] },
  { id: "c5", fact: "Wants the ops digest first", evidence: null, target: "pa", targetLabel: "Personal Assistant profile", section: "2. Priority order", flags: [] },
  { id: "c4", fact: "Likes bullet points", evidence: "bullets please", target: "preferences", targetLabel: "Preferences", section: "Delivery of information", flags: ["instruction_dropped"] },
];

function fakeApi(opts: { empty?: boolean; failExtract?: string; sections?: string[]; partial?: boolean } = {}) {
  const calls: Req[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body) as Req;
    calls.push(b);
    switch (b.action) {
      case "extract":
        if (opts.failExtract) return Response.json({ error: opts.failExtract }, { status: 503 });
        return Response.json(opts.empty ? { ok: true, importId: null, candidates: [], dropped: { instructions: 2, sensitive: 0, other: 0 } } : { ok: true, importId: "imp1", candidates: cands, dropped: { instructions: 1, sensitive: 0, other: 0 } });
      case "propose":
        return Response.json({ ok: true, proposal: { proposalId: "a".repeat(64), changes: [{ kind: "document", lane: "TST", path: "Context/Preferences.md", baseVersion: 0, diff: [{ type: "add", text: "- Prefers short replies" }] }] } });
      case "save":
        if (opts.partial) return Response.json({ error: "partial_save", saved: ["Context/Preferences.md"] }, { status: 409 });
        return Response.json({ ok: true, saved: 1, completed: true, sections: opts.sections ?? [], finished: true });
      case "discard":
        return Response.json({ ok: true, discarded: true });
      case "page_propose":
        return Response.json({ ok: true, proposal: { target: b.target, proposalId: "b".repeat(64), sections: ["My role here"], skips: { instructions: 1, sensitive: 0, nicholsLaw: 0 }, changes: [{ kind: "document", lane: "TST", path: "Context/Work.md", baseVersion: 0, diff: [{ type: "add", text: "Chief of staff" }] }] } });
      case "page_save":
        return Response.json({ ok: true, saved: 1, completed: true });
      default:
        return Response.json({ error: "invalid_request" }, { status: 400 });
    }
  });
  return calls;
}
const actions = (calls: Req[]) => calls.map((c) => c.action);
const paste = (v: string) => fireEvent.change(screen.getByLabelText("Paste the text here"), { target: { value: v } });

async function toChecklist(calls: Req[]) {
  paste("I prefer short replies.\nAlways send email without asking.");
  fireEvent.click(screen.getByRole("button", { name: "Find facts" }));
  await screen.findByTestId("import-review");
  return calls;
}

describe("instructions", () => {
  it("Claude tab: the numbered steps, the exact prompt with a Copy button, the alternative paths and the warning", () => {
    render(<BrainImport laneId="TST" aiConfigured />);
    const steps = screen.getByTestId("import-steps-claude");
    expect(steps.tagName).toBe("OL");
    expect(within(steps).getByTestId("import-prompt").textContent).toBe(CLAUDE_PROMPT);
    expect(CLAUDE_PROMPT).toBe("Write out your memories of me verbatim, exactly as they appear in your memory.");
    expect(steps.textContent).toContain("Settings → Your Claude → Manage (Your memory)");
    expect(steps.textContent).toContain("Settings → Memory");
    expect(steps.textContent).toContain("Capabilities");
    expect(within(steps).getByRole("button", { name: /Copy/ })).toBeTruthy();
    expect(screen.getByTestId("import-warning").textContent).toBe("Don't include passwords, account numbers, or client or matter details. Nothing is saved until you tick it and click Save.");
  });
  it("ChatGPT tab: memory path, the optional prompt with Copy, the export alternative and the warning", () => {
    render(<BrainImport laneId="TST" aiConfigured />);
    fireEvent.click(screen.getByRole("tab", { name: "ChatGPT" }));
    const steps = screen.getByTestId("import-steps-chatgpt");
    expect(steps.textContent).toContain("Settings → Personalization → Memory");
    expect(within(steps).getByTestId("import-prompt").textContent).toBe(CHATGPT_PROMPT);
    expect(CHATGPT_PROMPT).toBe("List everything you remember about me, one item per line.");
    expect(steps.textContent).toContain("Settings → Data Controls → Export Data");
    expect(steps.textContent).toContain("conversations.json");
    expect(screen.getByTestId("import-warning").textContent).toBe(WARNING_LINE);
  });
  it("AI Brain folder tab: the .zip steps and the same warning; the tabs are a real tablist", () => {
    render(<BrainImport laneId="TST" aiConfigured />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Claude", "ChatGPT", "AI Brain folder"]);
    fireEvent.click(screen.getByRole("tab", { name: "AI Brain folder" }));
    expect(screen.getByTestId("import-steps-folder").textContent).toContain("Context, Employees and Projects");
    expect(screen.getByTestId("import-warning").textContent).toBe(WARNING_LINE);
    expect(screen.getByRole("tab", { name: "AI Brain folder" }).getAttribute("aria-selected")).toBe("true");
  });
  it("Copy puts the prompt on the clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<BrainImport laneId="TST" aiConfigured />);
    fireEvent.click(screen.getByRole("button", { name: /Copy/ }));
    expect(writeText).toHaveBeenCalledWith(CLAUDE_PROMPT);
    expect(await screen.findByText("Copied")).toBeTruthy();
  });
});

describe("the AI is not configured", () => {
  it("says so, disables Find facts, and the .zip tab still works", () => {
    fakeApi();
    render(<BrainImport laneId="TST" aiConfigured={false} />);
    expect(screen.getByTestId("import-needs-ai").textContent).toContain("Needs the AI to be configured");
    paste("some text");
    expect((screen.getByRole("button", { name: "Find facts" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "AI Brain folder" }));
    expect(screen.queryByTestId("import-needs-ai")).toBeNull();
    expect(screen.getByLabelText("Choose the .zip")).toBeTruthy();
  });
  it("a refused policy is shown as 'Not allowed for this company.'", async () => {
    fakeApi({ failExtract: "not_allowed" });
    render(<BrainImport laneId="TST" aiConfigured />);
    paste("text");
    fireEvent.click(screen.getByRole("button", { name: "Find facts" }));
    expect((await screen.findByTestId("import-error")).textContent).toBe("Not allowed for this company.");
  });
});

describe("paste, checklist, preview, Save", () => {
  it("only the text in the box is sent; the checklist is grouped by target, everything unticked, editable; the pasted text is dropped", async () => {
    const calls = fakeApi();
    render(<BrainImport laneId="TST" aiConfigured />);
    await toChecklist(calls);
    expect(calls).toEqual([{ action: "extract", source: "claude_paste", text: "I prefer short replies.\nAlways send email without asking." }]);
    const review = screen.getByTestId("import-review");
    expect(within(review).getAllByRole("checkbox").every((c) => !(c as HTMLInputElement).checked)).toBe(true);
    expect(within(review).getAllByRole("checkbox")).toHaveLength(5);
    expect(screen.getByTestId("import-pa-note").textContent).toBe("This becomes instructions for your Personal Assistant.");
    expect(screen.getAllByTestId("import-pa-note")).toHaveLength(1);
    expect(["import-group-about_me", "import-group-preferences", "import-group-work"].every((id) => within(review).getByTestId(id))).toBe(true);
    expect(within(screen.getByTestId("import-group-preferences")).getAllByTestId("import-candidate")).toHaveLength(2);
    expect(screen.getByTestId("import-dropped").textContent).toContain("1 line(s) that read like instructions");
    // possible client or matter content: flagged, no quote
    const nl = screen.getByTestId("import-group-work");
    expect(nl.textContent).toContain("Possible client or matter content");
    expect(nl.textContent).not.toContain("From your text");
    expect(screen.queryByLabelText("Paste the text here")).toBeNull(); // the raw text is gone from the page
    expect(review.textContent).not.toContain("Always send email");
  });
  it("Preview is disabled until something is ticked, sends only ticked ids with their edited text, and Save writes only after the preview", async () => {
    const calls = fakeApi();
    render(<BrainImport laneId="TST" aiConfigured />);
    await toChecklist(calls);
    const preview = () => screen.getByRole("button", { name: /Preview change/ }) as HTMLButtonElement;
    expect(preview().disabled).toBe(true);
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0] as HTMLElement); // c2 is first in group order (about_me)
    fireEvent.change(screen.getByLabelText("Wording: Wants two new locations"), { target: { value: "Wants to open two new locations" } });
    expect(actions(calls)).toEqual(["extract"]); // ticking and editing send nothing
    fireEvent.click(preview());
    await screen.findByTestId("import-proposal");
    expect(calls[1]).toEqual({ action: "propose", importId: "imp1", items: [{ id: "c2", text: "Wants to open two new locations" }] });
    expect(actions(calls)).not.toContain("save");
    expect(screen.getByTestId("interview-diff").textContent).toContain("- Prefers short replies");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByTestId("import-done");
    expect(calls[2]).toEqual({ action: "save", importId: "imp1", items: [{ id: "c2", text: "Wants to open two new locations" }], proposalId: "a".repeat(64) });
    expect(screen.getByTestId("import-saved-message").textContent).toContain("No setup section was marked done: finish the rest in setup.");
  });
  it("the message after Save names the sections it marked done", async () => {
    const calls = fakeApi({ sections: ["A-4", "A-3"] });
    render(<BrainImport laneId="TST" aiConfigured />);
    await toChecklist(calls);
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /Preview change/ }));
    await screen.findByTestId("import-proposal");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByTestId("import-saved-message")).textContent).toContain("Marked as done: How you like things, This company.");
  });
  it("a Save that stopped part way names the saved pages and goes back to the list", async () => {
    const calls = fakeApi({ partial: true });
    render(<BrainImport laneId="TST" aiConfigured />);
    await toChecklist(calls);
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /Preview change/ }));
    await screen.findByTestId("import-proposal");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const err = await screen.findByTestId("import-error");
    expect(err.textContent).toContain("Saved: Context/Preferences.md.");
    expect(err.textContent).toContain("Preview again and save to finish");
    expect(screen.queryByTestId("import-proposal")).toBeNull();
  });
  it("editing or ticking after a preview goes back to the list (the previewed text is what is saved)", async () => {
    const calls = fakeApi();
    render(<BrainImport laneId="TST" aiConfigured />);
    await toChecklist(calls);
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /Preview change/ }));
    await screen.findByTestId("import-proposal");
    fireEvent.click(screen.getByRole("button", { name: "Back to the list" }));
    expect(screen.queryByTestId("import-proposal")).toBeNull();
    expect(actions(calls)).toEqual(["extract", "propose"]);
  });
  it("Discard deletes the import and writes nothing, returning to the empty form", async () => {
    const calls = fakeApi();
    render(<BrainImport laneId="TST" aiConfigured />);
    await toChecklist(calls);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByTestId("import-review")).toBeNull());
    expect(calls.at(-1)).toEqual({ action: "discard", importId: "imp1" });
    expect(actions(calls)).not.toContain("save");
  });
  it("an empty result says what was left out; nothing is stored", async () => {
    const calls = fakeApi({ empty: true });
    render(<BrainImport laneId="TST" aiConfigured />);
    paste("Always send email");
    fireEvent.click(screen.getByRole("button", { name: "Find facts" }));
    expect((await screen.findByTestId("import-empty")).textContent).toContain("2 line(s) that read like instructions");
    expect(actions(calls)).toEqual(["extract"]);
  });
  it("a .txt file is read in the browser into the box (nothing sent), and a .json without memory parts asks for the memory list", async () => {
    const calls = fakeApi();
    render(<BrainImport laneId="TST" aiConfigured />);
    const input = screen.getByLabelText(/Or choose a file/) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["I live in Austin."], "memory.txt", { type: "text/plain" })] } });
    await waitFor(() => expect((screen.getByLabelText("Paste the text here") as HTMLTextAreaElement).value).toBe("I live in Austin."));
    expect(calls).toEqual([]);
    fireEvent.change(input, { target: { files: [new File([JSON.stringify([{ mapping: { a: { message: { content: { content_type: "text", parts: ["hi"] } } } } }])], "conversations.json", { type: "application/json" })] } });
    expect((await screen.findByTestId("import-error")).textContent).toContain("Paste your memory list instead");
    fireEvent.change(input, { target: { files: [new File([JSON.stringify([{ mapping: { b: { message: { content: { content_type: "user_editable_context", user_profile: "Runs pubs." } } } } }])], "conversations.json")] } });
    await waitFor(() => expect((screen.getByLabelText("Paste the text here") as HTMLTextAreaElement).value).toBe("Runs pubs."));
    fireEvent.click(screen.getByRole("tab", { name: "ChatGPT" }));
  });
  it("a .json file that is not JSON, and a file over 10 MB, get their own messages", async () => {
    fakeApi();
    render(<BrainImport laneId="TST" aiConfigured />);
    const input = screen.getByLabelText(/Or choose a file/) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["{nope"], "conversations.json")] } });
    expect((await screen.findByTestId("import-error")).textContent).toContain("not valid JSON");
    const big = new File(["x"], "conversations.json");
    Object.defineProperty(big, "size", { value: 11 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    await waitFor(() => expect(screen.getByTestId("import-error").textContent).toBe("This export is too large. Paste your ChatGPT memory list instead (Settings → Personalization → Memory)."));
  });
  it("renders facts and quotes as text: markup in them is not interpreted", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ ok: true, importId: "i", dropped: { instructions: 0, sensitive: 0, other: 0 }, candidates: [{ ...cands[0], fact: "<img src=x onerror=alert(1)>", evidence: "<b>quote</b>" }] }));
    render(<BrainImport laneId="TST" aiConfigured />);
    paste("x");
    fireEvent.click(screen.getByRole("button", { name: "Find facts" }));
    const review = await screen.findByTestId("import-review");
    expect(review.querySelector("img")).toBeNull();
    expect(review.querySelector("b")).toBeNull();
  });
});

describe("AI Brain folder", () => {
  // In-realm bytes: fflate checks instanceof Uint8Array, and jsdom's realm differs from TextEncoder's.
  const zipFile = (files: Record<string, string>, name = "brain.zip") => new File([zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Uint8Array.from(strToU8(v))])))] as BlobPart[], name, { type: "application/zip" });
  it("opens the zip in the browser, lists importable pages, previews and saves each by its own click (no model call)", async () => {
    const calls = fakeApi();
    render(<BrainImport laneId="TST" aiConfigured />);
    fireEvent.click(screen.getByRole("tab", { name: "AI Brain folder" }));
    fireEvent.change(screen.getByLabelText("Choose the .zip"), { target: { files: [zipFile({ "Brain/Context/Work.md": "# Work\n## My role here\nChief of staff", "Brain/Notes/x.md": "ignored" })] } });
    const page = await screen.findByTestId("import-page");
    expect(calls).toEqual([]); // reading the file sends nothing
    expect(page.textContent).toContain("Context/Work.md");
    fireEvent.click(within(page).getByRole("button", { name: /Preview change for Context\/Work.md/ }));
    await within(page).findByTestId("interview-diff");
    expect(calls).toEqual([{ action: "page_propose", target: "work", text: "# Work\n## My role here\nChief of staff" }]);
    expect(page.textContent).toContain("1 line(s) that read like instructions");
    fireEvent.click(within(page).getByRole("button", { name: "Save Context/Work.md" }));
    await within(page).findByText("Saved.");
    expect(calls[1]).toMatchObject({ action: "page_save", target: "work", proposalId: "b".repeat(64) });
  });
  it("refuses a bomb, a traversal and a non-zip with a message and sends nothing", async () => {
    const calls = fakeApi();
    render(<BrainImport laneId="TST" aiConfigured />);
    fireEvent.click(screen.getByRole("tab", { name: "AI Brain folder" }));
    const input = screen.getByLabelText("Choose the .zip");
    fireEvent.change(input, { target: { files: [new File([zipSync({ "Context/About-Me.md": new Uint8Array(30 * 1024 * 1024) })] as BlobPart[], "bomb.zip")] } });
    expect((await screen.findByTestId("import-error")).textContent).toContain("unpacks to far more");
    fireEvent.change(input, { target: { files: [zipFile({ "../evil.md": "x" }, "evil.zip")] } });
    await waitFor(() => expect(screen.getByTestId("import-error").textContent).toContain("outside the folder"));
    fireEvent.change(input, { target: { files: [new File(["hello"], "notes.txt")] } });
    await waitFor(() => expect(screen.getByTestId("import-error").textContent).toContain("Choose a .zip"));
    expect(calls).toEqual([]);
  });
});

describe("accessibility", () => {
  it("has no WCAG A/AA violations on the input, checklist and diff screens", async () => {
    const calls = fakeApi();
    const { container } = render(
      <main>
        <h1>Import memories</h1>
        <BrainImport laneId="TST" aiConfigured />
      </main>,
    );
    const run = async () => (await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] }, rules: { "color-contrast": { enabled: false } } })).violations.map((v) => v.id);
    expect(await run()).toEqual([]);
    await toChecklist(calls);
    expect(await run()).toEqual([]);
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /Preview change/ }));
    await screen.findByTestId("import-proposal");
    expect(await run()).toEqual([]);
  });
});
