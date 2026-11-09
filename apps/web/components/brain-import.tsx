"use client";
// Import memories (T-220, spec brain-and-employees §7a; D-39, D-40). Three ways in, tabs Claude | ChatGPT | AI Brain folder:
//   Claude / ChatGPT  paste (or choose a .txt/.md/.json file): the text is read HERE in the browser; only the text in the box (at
//                     most 50,000 characters) is sent. The server finds candidate facts; ALL start unticked, grouped by where they
//                     would go, text editable. Ticked facts become the exact diff (the interview's diff card); only Save writes.
//   AI Brain folder   a .zip is opened HERE (size, entry and path limits); each importable page is previewed as a diff and saved
//                     only by its own click. No model.
// Everything from the text and the server is rendered as React text. Nothing is stored in the browser.
import Link from "next/link";
import { useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle, Badge, Button, buttonVariants, cn } from "@nichols/ui";
import { TARGET_LABEL } from "@nichols/brain/import";
import type { ExtractResult, ImportCandidateView, ImportProposal, PageProposal } from "@nichols/brain/server";
import {
  CHATGPT_PROMPT,
  CLAUDE_PROMPT,
  IMPORT_ERROR_TEXT,
  LOCAL_READ_NOTE,
  TABS,
  WARNING_LINE,
  callImport,
  droppedNote,
  groupByTarget,
  tickedItems,
  type ImportTab,
} from "@/lib/brain-import-client";
import { MAX_FILE_BYTES, MAX_PASTE_CHARS, ZIP_ERROR_TEXT, fileKind, memoryFromJsonFile, readBrainZip, type ZipPage } from "@/lib/import-files";
import { DiffCard, control, tap } from "./brain-interview-parts";

type Review = { importId: string; candidates: ImportCandidateView[]; dropped: ExtractResult["dropped"] };
type PageState = { proposal: PageProposal | null; saved: boolean; busy: boolean; error: string | null };

function CopyPrompt({ label, prompt }: { label: string; prompt: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2 rounded-control border border-border bg-background p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="break-words text-sm text-foreground" data-testid="import-prompt">
        {prompt}
      </p>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => {
            void navigator.clipboard?.writeText(prompt).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          Copy<span className="sr-only"> prompt: {label}</span>
        </Button>
        <span className="text-xs text-muted-foreground" role="status" aria-live="polite">
          {copied ? "Copied" : ""}
        </span>
      </div>
    </div>
  );
}

function Steps({ tab }: { tab: ImportTab }) {
  if (tab === "claude") {
    return (
      <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm text-foreground" data-testid="import-steps-claude">
        <li>Open claude.ai and start a new chat.</li>
        <li className="flex flex-col gap-2">
          Send Claude this message:
          <CopyPrompt label="Claude prompt" prompt={CLAUDE_PROMPT} />
        </li>
        <li>Copy Claude&apos;s whole answer and paste it into the box below.</li>
        <li className="text-muted-foreground">
          Another way: in claude.ai open Settings → Your Claude → Manage (Your memory) and copy the text. Older layouts: Settings → Memory, or Settings → Capabilities.
        </li>
      </ol>
    );
  }
  if (tab === "chatgpt") {
    return (
      <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm text-foreground" data-testid="import-steps-chatgpt">
        <li>Open ChatGPT and go to Settings → Personalization → Memory.</li>
        <li>Copy the list of memories and paste it into the box below.</li>
        <li className="flex flex-col gap-2">
          Optional: ask ChatGPT in a new chat:
          <CopyPrompt label="ChatGPT prompt (optional)" prompt={CHATGPT_PROMPT} />
        </li>
        <li className="text-muted-foreground">
          Another way: Settings → Data Controls → Export Data. When the email arrives, unzip the download and choose conversations.json below. Only the memory and custom-instruction parts are read, not your chats.
        </li>
      </ol>
    );
  }
  return (
    <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm text-foreground" data-testid="import-steps-folder">
      <li>Zip your AI Brain folder. It can hold Context, Employees and Projects folders.</li>
      <li>Choose the .zip below. Jarvis reads About-Me, Preferences and Work from Context, and the Personal Assistant file from Employees.</li>
      <li>Preview each page as a change and save the ones you want. Nothing is saved without your click.</li>
    </ol>
  );
}

export function BrainImport({ laneId, aiConfigured }: { laneId: string; aiConfigured: boolean }) {
  const base = `/${encodeURIComponent(laneId)}/onboarding`;
  const [tab, setTab] = useState<ImportTab>("claude");
  const [text, setText] = useState("");
  const [exported, setExported] = useState(false);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [proposal, setProposal] = useState<ImportProposal | null>(null);
  const [done, setDone] = useState<{ saved: number; completed: boolean } | null>(null);
  const [empty, setEmpty] = useState<string | null>(null);
  const [pages, setPages] = useState<ZipPage[] | null>(null);
  const [zipNotes, setZipNotes] = useState<string[]>([]);
  const [pageState, setPageState] = useState<Record<string, PageState>>({});
  const headRef = useRef<HTMLHeadingElement | null>(null);
  const fail = (code: string) => setError(IMPORT_ERROR_TEXT[code] ?? IMPORT_ERROR_TEXT.unavailable ?? "");
  const source = tab === "chatgpt" ? (exported ? "chatgpt_export" : "chatgpt_paste") : exported ? "claude_export" : "claude_paste";
  const ticked = review ? tickedItems(review.candidates, ticks, edits) : [];

  function reset() {
    setText("");
    setExported(false);
    setFileNote(null);
    setError(null);
    setReview(null);
    setTicks({});
    setEdits({});
    setProposal(null);
    setDone(null);
    setEmpty(null);
  }

  async function onTextFile(file: File) {
    setError(null);
    setFileNote(null);
    if (file.size > MAX_FILE_BYTES) return setError("That file is larger than 10 MB. Paste the part you want instead.");
    const kind = fileKind(file.name);
    if (kind === null || kind === "zip") return setError("Choose a .txt, .md or .json file, or paste the text.");
    const raw = await file.text(); // read here, in the browser: the file itself is never sent
    if (kind === "json") {
      const m = memoryFromJsonFile(raw);
      if (!m.found) return setError("No memory or custom instructions were found in that file. Paste your memory list instead.");
      if (m.text.length > MAX_PASTE_CHARS) return setError("The memory text in that file is longer than 50,000 characters. Paste the part you want instead.");
      setText(m.text);
      setExported(true);
      return setFileNote(`Read the memory and custom-instruction parts of ${file.name}. Check the text below; only this text is sent.`);
    }
    if (raw.length > MAX_PASTE_CHARS) return setError("That file is longer than 50,000 characters. Paste the part you want instead.");
    setText(raw);
    setExported(true);
    setFileNote(`Read ${file.name}. Check the text below; only this text is sent.`);
  }

  async function find() {
    setBusy(true);
    setError(null);
    setEmpty(null);
    const r = await callImport<ExtractResult>(laneId, { action: "extract", source, text });
    setBusy(false);
    if (!r.ok) return fail(r.code);
    const d = r.data;
    if (d.importId === null || d.candidates.length === 0) {
      return setEmpty(droppedNote(d.dropped) ?? "No facts about you were found in that text.");
    }
    setReview({ importId: d.importId, candidates: d.candidates, dropped: d.dropped });
    setText(""); // the pasted text is dropped from the page as soon as the facts are found
    setTicks({});
    setEdits({});
    setTimeout(() => headRef.current?.focus(), 0);
  }

  async function preview() {
    if (!review) return;
    setBusy(true);
    setError(null);
    const r = await callImport<{ proposal: ImportProposal }>(laneId, { action: "propose", importId: review.importId, items: ticked });
    setBusy(false);
    if (!r.ok) return fail(r.code);
    setProposal(r.data.proposal);
  }

  async function save() {
    if (!review || !proposal) return;
    setBusy(true);
    setError(null);
    const r = await callImport<{ saved: number; completed: boolean }>(laneId, { action: "save", importId: review.importId, items: ticked, proposalId: proposal.proposalId });
    setBusy(false);
    if (!r.ok) {
      if (r.code === "proposal_changed" || r.code === "version_conflict") setProposal(null);
      return fail(r.code);
    }
    setDone({ saved: r.data.saved, completed: r.data.completed });
    setReview(null);
    setProposal(null);
  }

  async function discard() {
    if (!review) return;
    setBusy(true);
    const r = await callImport<{ discarded: true }>(laneId, { action: "discard", importId: review.importId });
    setBusy(false);
    if (!r.ok && r.code !== "import_not_found") return fail(r.code);
    reset();
  }

  async function onZip(file: File) {
    setError(null);
    setPages(null);
    setZipNotes([]);
    setPageState({});
    if (file.size > MAX_FILE_BYTES) return setError("That file is larger than 10 MB.");
    if (fileKind(file.name) !== "zip") return setError("Choose a .zip file.");
    const result = readBrainZip(new Uint8Array(await file.arrayBuffer())); // opened here, in the browser
    if (!result.ok) return setError(ZIP_ERROR_TEXT[result.error]);
    setPages(result.pages);
    setZipNotes(result.notes);
  }

  const patchPage = (path: string, p: Partial<PageState>) => setPageState((s) => ({ ...s, [path]: { proposal: null, saved: false, busy: false, error: null, ...s[path], ...p } }));

  async function previewPage(page: ZipPage) {
    patchPage(page.path, { busy: true, error: null });
    const r = await callImport<{ proposal: PageProposal }>(laneId, { action: "page_propose", target: page.target, text: page.text });
    patchPage(page.path, r.ok ? { busy: false, proposal: r.data.proposal } : { busy: false, error: IMPORT_ERROR_TEXT[r.code] ?? IMPORT_ERROR_TEXT.unavailable ?? "" });
  }

  async function savePage(page: ZipPage) {
    const p = pageState[page.path]?.proposal;
    if (!p) return;
    patchPage(page.path, { busy: true, error: null });
    const r = await callImport<{ saved: number }>(laneId, { action: "page_save", target: page.target, text: page.text, proposalId: p.proposalId });
    if (r.ok) patchPage(page.path, { busy: false, saved: true, proposal: null });
    else patchPage(page.path, { busy: false, error: IMPORT_ERROR_TEXT[r.code] ?? IMPORT_ERROR_TEXT.unavailable ?? "", proposal: r.code === "proposal_changed" || r.code === "version_conflict" ? null : p });
  }

  const reviewing = review !== null && done === null;
  return (
    <section aria-label="Import memories" className="flex flex-col gap-4" data-testid="brain-import">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={base} prefetch={false} className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-2">
          Back to setup
        </Link>
      </div>

      {error ? (
        <Alert variant="alert" role="alert" data-testid="import-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {done ? (
        <div className="flex flex-col gap-4 rounded-card border border-border bg-card p-4 md:p-6" data-testid="import-done">
          <h2 ref={headRef} tabIndex={-1} className="font-heading text-xl font-semibold text-foreground outline-none">
            Saved
          </h2>
          <p className="text-sm text-foreground" role="status">
            {done.saved === 0 ? "Those facts were already in your pages, so nothing changed." : `Saved ${String(done.saved)} page${done.saved === 1 ? "" : "s"}.`}{" "}
            {done.completed ? "The matching setup sections are marked done." : "Your pages are saved, but the setup sections could not be marked done just now."} The facts you did not keep were deleted.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Link href={base} prefetch={false} className={cn(buttonVariants(), tap, "inline-flex items-center justify-center")}>
              Continue setup
            </Link>
            <Button variant="outline" className={tap} onClick={reset}>
              Import more
            </Button>
          </div>
        </div>
      ) : reviewing ? (
        <div className="flex flex-col gap-4 rounded-card border border-border bg-card p-4 md:p-6" data-testid="import-review">
          <div className="flex flex-col gap-1">
            <h2 ref={headRef} tabIndex={-1} className="font-heading text-xl font-semibold text-foreground outline-none">
              Choose what to keep
            </h2>
            <p className="text-sm text-muted-foreground">Nothing is ticked. Tick what is right, edit the wording if you like, then preview the change.</p>
            {droppedNote(review.dropped) ? <p className="text-sm text-muted-foreground" data-testid="import-dropped">{droppedNote(review.dropped)}</p> : null}
          </div>

          {proposal ? (
            <div className="flex flex-col gap-3" data-testid="import-proposal">
              <h3 className="text-sm font-semibold text-foreground">Here is the change. Nothing is saved yet.</h3>
              {proposal.changes.length === 0 ? <p className="text-sm text-muted-foreground">These facts are already in your pages. Saving records the matching sections as done.</p> : <DiffCard proposal={proposal} />}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button className={tap} disabled={busy} onClick={() => void save()}>
                  {busy ? "Saving…" : "Save"}
                </Button>
                <Button variant="outline" className={tap} disabled={busy} onClick={() => setProposal(null)}>
                  Back to the list
                </Button>
              </div>
            </div>
          ) : (
            <>
              {groupByTarget(review.candidates).map((g) => (
                <fieldset key={g.target} className="flex min-w-0 flex-col gap-2" data-testid={`import-group-${g.target}`}>
                  <legend className="text-sm font-semibold text-foreground">{g.label}</legend>
                  <ul className="flex flex-col gap-2">
                    {g.items.map((c) => {
                      const flagged = c.flags.includes("possible_nl_content");
                      const boxId = `imp-${c.id}`;
                      return (
                        <li key={c.id} className="flex flex-col gap-2 rounded-control border border-border bg-background p-3" data-testid="import-candidate">
                          <div className="flex items-start gap-3">
                            <input
                              id={boxId}
                              type="checkbox"
                              className="mt-1 size-6 shrink-0 accent-[var(--primary)]"
                              checked={ticks[c.id] === true}
                              onChange={(e) => {
                                setError(null);
                                setTicks((t) => ({ ...t, [c.id]: e.target.checked }));
                              }}
                            />
                            <div className="flex min-w-0 flex-1 flex-col gap-2">
                              <label htmlFor={boxId} className="flex min-h-6 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                <span>
                                  Keep under <span className="font-medium text-foreground">{c.section}</span>
                                </span>
                                {flagged ? <Badge variant="alert">Possible client or matter content</Badge> : null}
                                {c.flags.includes("instruction_dropped") ? <Badge variant="muted">Instruction removed from the quote</Badge> : null}
                              </label>
                              <textarea
                                aria-label={`Wording: ${c.fact}`}
                                className={cn(control, "min-h-16")}
                                rows={2}
                                maxLength={500}
                                value={edits[c.id] ?? c.fact}
                                onChange={(e) => setEdits((m) => ({ ...m, [c.id]: e.target.value }))}
                              />
                              {c.evidence ? <p className="break-words text-xs text-muted-foreground">From your text: &ldquo;{c.evidence}&rdquo;</p> : null}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              ))}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button className={tap} disabled={busy || ticked.length === 0} onClick={() => void preview()}>
                  {busy ? "Working…" : `Preview change${ticked.length > 0 ? ` (${String(ticked.length)} ticked)` : ""}`}
                </Button>
                <Button variant="outline" className={tap} disabled={busy} onClick={() => void discard()}>
                  Discard
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4 rounded-card border border-border bg-card p-4 md:p-6">
          <div role="tablist" aria-label="Where to import from" className="flex flex-wrap gap-2">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                type="button"
                id={`import-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="import-panel"
                onClick={() => {
                  setTab(t.id);
                  setError(null);
                  setEmpty(null);
                }}
                className={cn(
                  "min-h-11 rounded-control border px-4 text-sm font-medium",
                  tab === t.id ? "border-gold bg-primary-tint text-foreground" : "border-border bg-card text-muted-foreground hover:bg-muted",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div id="import-panel" role="tabpanel" aria-labelledby={`import-tab-${tab}`} className="flex flex-col gap-4">
            <Steps tab={tab} />

            {tab === "folder" ? (
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
                  Choose the .zip
                  <input type="file" accept=".zip,application/zip" className={control} onChange={(e) => e.target.files?.[0] && void onZip(e.target.files[0])} />
                </label>
                {zipNotes.map((n) => (
                  <p key={n} className="text-xs text-muted-foreground">
                    {n}
                  </p>
                ))}
                {pages?.map((p) => {
                  const st = pageState[p.path];
                  return (
                    <div key={p.path} className="flex flex-col gap-3 rounded-control border border-border bg-background p-3" data-testid="import-page">
                      <p className="break-words text-sm font-medium text-foreground">
                        {p.path} <span className="font-normal text-muted-foreground">→ {TARGET_LABEL[p.target]}</span>
                      </p>
                      {st?.error ? (
                        <Alert variant="alert" role="alert">
                          <AlertDescription>{st.error}</AlertDescription>
                        </Alert>
                      ) : null}
                      {st?.saved ? (
                        <p className="text-sm text-foreground" role="status">
                          Saved.
                        </p>
                      ) : st?.proposal ? (
                        <div className="flex flex-col gap-3">
                          {st.proposal.skips.instructions + st.proposal.skips.sensitive + st.proposal.skips.nicholsLaw > 0 ? (
                            <p className="text-xs text-muted-foreground">
                              Left out: {String(st.proposal.skips.instructions)} line(s) that read like instructions, {String(st.proposal.skips.sensitive)} section(s) with passwords or account numbers, {String(st.proposal.skips.nicholsLaw)} section(s) naming Nichols Law.
                            </p>
                          ) : null}
                          {st.proposal.changes.length === 0 ? <p className="text-sm text-muted-foreground">Nothing would change.</p> : <DiffCard proposal={st.proposal} />}
                          <Button className={tap} disabled={st.busy} onClick={() => void savePage(p)}>
                            {st.busy ? "Saving…" : `Save ${p.path}`}
                          </Button>
                        </div>
                      ) : (
                        <Button variant="outline" className={tap} disabled={st?.busy === true} onClick={() => void previewPage(p)}>
                          {st?.busy ? "Working…" : `Preview change for ${p.path}`}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {aiConfigured ? null : (
                  <Alert variant="alert" data-testid="import-needs-ai">
                    <AlertTitle>Needs the AI to be configured</AlertTitle>
                    <AlertDescription>Pasting and files need the AI. Ask your administrator to set it up. A brain folder .zip can still be imported.</AlertDescription>
                  </Alert>
                )}
                <div className="flex flex-col gap-1">
                  <label htmlFor="import-text" className="text-sm font-medium text-foreground">
                    Paste the text here
                  </label>
                  <textarea
                    id="import-text"
                    className={cn(control, "min-h-40")}
                    rows={8}
                    value={text}
                    maxLength={MAX_PASTE_CHARS}
                    onChange={(e) => {
                      setText(e.target.value);
                      setExported(false);
                      setEmpty(null);
                    }}
                  />
                  <p className="text-xs text-muted-foreground" aria-live="polite">
                    {text.length.toLocaleString("en-US")} of {MAX_PASTE_CHARS.toLocaleString("en-US")} characters
                  </p>
                </div>
                <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
                  Or choose a file (.txt, .md or .json, up to 10 MB)
                  <input type="file" accept=".txt,.md,.json,text/plain,text/markdown,application/json" className={control} onChange={(e) => e.target.files?.[0] && void onTextFile(e.target.files[0])} />
                </label>
                {fileNote ? (
                  <p className="text-xs text-muted-foreground" role="status">
                    {fileNote}
                  </p>
                ) : null}
                {empty ? (
                  <Alert data-testid="import-empty">
                    <AlertDescription>{empty}</AlertDescription>
                  </Alert>
                ) : null}
                <div>
                  <Button className={tap} disabled={busy || !aiConfigured || text.trim() === ""} onClick={() => void find()}>
                    {busy ? "Reading…" : "Find facts"}
                  </Button>
                </div>
              </div>
            )}
          </div>

          <p className="text-sm font-medium text-foreground" data-testid="import-warning">
            {WARNING_LINE}
          </p>
          <p className="text-xs text-muted-foreground">{LOCAL_READ_NOTE}</p>
        </div>
      )}
    </section>
  );
}
