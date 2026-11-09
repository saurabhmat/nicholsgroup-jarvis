"use client";
// Setup interview (T-216, spec brain-and-employees §7): the same flow in the assistant chat (mode "chat") and in
// Settings -> AI brain (mode "page"). Up to three questions per step, "Already set" for known answers, a diff card per
// group and a Save button that is the ONLY thing that writes (preview never does). Summary -> confirm -> test briefing
// (waits for T-213) -> activate. Connecting an account is never done here: a missing source links to Settings ->
// Connections. All text is rendered as React text (never HTML). Single column and 44 px targets for the iPhone.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle, Badge, Button } from "@nichols/ui";
import type { GroupView } from "@nichols/brain/interview";
import type { InterviewState, Proposal } from "@nichols/brain/server";
import {
  COMPLETION_PENDING_TEXT,
  ERROR_TEXT,
  SAVE_FIRST_HINT,
  activeQuestions,
  buildAnswers,
  callInterview,
  canPreview,
  hasUnsavedAnswers,
  initialValues,
  issueLabel,
  nextGroupId,
  type ApiErr,
  type FormValues,
} from "@/lib/brain-interview-client";
import { ACTION_TEXT, DiffCard, GroupNotices, QuestionBlock, REASON_TEXT, tap } from "./brain-interview-parts";
import { BrainWizard } from "./brain-wizard";

type View = { kind: "group"; id: string } | { kind: "review" } | { kind: "sections" };

/**
 * mode "chat" (assistant) and "page" (the T-216 form) are one flow; mode "wizard" (T-226) is the guided one-group-per-screen
 * onboarding. All three use the same bank, the same interview API and the same checks.
 */
export function BrainInterview(props: { laneId: string; mode: "chat" | "page" | "wizard"; startAt?: "setup" | "assistant"; initialStep?: string; hadStep?: boolean }) {
  if (props.mode === "wizard") return <BrainWizard laneId={props.laneId} initialStep={props.initialStep} hadStep={props.hadStep} />;
  return <InterviewFlow laneId={props.laneId} mode={props.mode} startAt={props.startAt} />;
}

function InterviewFlow({ laneId, mode, startAt }: { laneId: string; mode: "chat" | "page"; startAt?: "setup" | "assistant" }) {
  const [state, setState] = useState<InterviewState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [values, setValues] = useState<FormValues>({});
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiErr | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [visited, setVisited] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const headRef = useRef<HTMLHeadingElement | null>(null);
  const proposalRef = useRef<HTMLDivElement | null>(null);
  const first = useRef(true);
  const viewKey = view ? (view.kind === "group" ? `g:${view.id}` : view.kind) : "";

  // Keyboard and screen-reader users land on the new step; the first render does not steal focus from the page.
  useEffect(() => {
    if (!viewKey) return;
    if (first.current) {
      first.current = false;
      return;
    }
    headRef.current?.scrollIntoView?.({ block: "nearest" });
    headRef.current?.focus();
  }, [viewKey]);
  useEffect(() => {
    if (!proposal) return;
    proposalRef.current?.scrollIntoView?.({ block: "nearest" });
    proposalRef.current?.focus();
  }, [proposal]);

  const openGroup = useCallback((g: GroupView, asEdit: boolean) => {
    setValues(initialValues(g));
    setEditing(asEdit ? new Set(g.questions.filter((q) => q.status === "known").map((q) => q.id)) : new Set());
    setProposal(null);
    setError(null);
    setView({ kind: "group", id: g.id });
  }, []);

  const route = useCallback(
    (s: InterviewState, after: string | null, seen: Set<string>) => {
      const hint = after === null && startAt === "assistant" ? (s.groups.find((g) => g.part === "B")?.id ?? null) : null;
      const id = hint ?? nextGroupId(s.groups, after, seen, s.employee !== null);
      const g = id ? s.groups.find((x) => x.id === id) : undefined;
      if (g) openGroup(g, false);
      else setView({ kind: "review" });
    },
    [openGroup, startAt],
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await callInterview<{ state: InterviewState }>(laneId, { action: "state" });
      if (!live) return;
      if (!r.ok) return setLoadError(ERROR_TEXT[r.code] ?? ERROR_TEXT.unavailable ?? "");
      setState(r.data.state);
      route(r.data.state, null, new Set());
    })();
    return () => {
      live = false;
    };
  }, [laneId, route]);

  if (loadError) {
    return (
      <Alert variant="alert" data-testid="interview-error">
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    );
  }
  if (!state || !view) return <p className="text-sm text-muted-foreground" aria-live="polite">Loading your setup…</p>;

  const fail = (r: ApiErr) => setError(r);
  const groupView = view.kind === "group" ? state.groups.find((g) => g.id === view.id) : undefined;

  async function preview(g: GroupView) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await callInterview<{ proposal: Proposal }>(laneId, { action: "propose", group: g.id, answers: buildAnswers(g, values, editing) });
    setBusy(false);
    if (!r.ok) return fail(r);
    setProposal(r.data.proposal);
  }

  async function save(g: GroupView, p: Proposal) {
    setBusy(true);
    setError(null);
    const r = await callInterview<{ state: InterviewState; completed?: boolean }>(laneId, { action: "save", group: g.id, answers: buildAnswers(g, values, editing), proposalId: p.proposalId });
    if (!r.ok) {
      setBusy(false);
      if (r.code === "proposal_changed" || r.code === "version_conflict") setProposal(null);
      return fail(r);
    }
    if (r.data.completed === false) {
      // Saved, but the section was not recorded as done: stay, refresh, and let the next Save record it.
      setState(r.data.state);
      setProposal(null);
      setNotice(COMPLETION_PENDING_TEXT);
      const again = await callInterview<{ proposal: Proposal }>(laneId, { action: "propose", group: g.id, answers: buildAnswers(g, values, editing) });
      setBusy(false);
      if (again.ok) setProposal(again.data.proposal);
      return;
    }
    setBusy(false);
    const seen = new Set(visited).add(g.id);
    setVisited(seen);
    setState(r.data.state);
    setNotice(`Saved: ${g.title}.`);
    setConfirmed(false);
    route(r.data.state, g.id, seen);
  }

  /** "Nothing to add": the section is done, nothing is written to the brain and its answers stay "Not provided". */
  async function nothingToAdd(g: GroupView) {
    setBusy(true);
    setError(null);
    const r = await callInterview<{ state: InterviewState }>(laneId, { action: "complete", group: g.id });
    setBusy(false);
    if (!r.ok) return fail(r);
    const seen = new Set(visited).add(g.id);
    setVisited(seen);
    setState(r.data.state);
    setNotice(`Marked as done: ${g.title}.`);
    route(r.data.state, g.id, seen);
  }

  const skip = (g: GroupView) => {
    const next = new Set(visited).add(g.id);
    setVisited(next);
    route(state, g.id, next);
  };

  async function confirm() {
    setBusy(true);
    setError(null);
    const r = await callInterview<{ employee: InterviewState["employee"] }>(laneId, { action: "confirm" });
    setBusy(false);
    if (!r.ok) return fail(r);
    setConfirmed(true);
  }
  async function activate() {
    setBusy(true);
    setError(null);
    const r = await callInterview<{ state: InterviewState }>(laneId, { action: "activate" });
    setBusy(false);
    if (!r.ok) return fail(r);
    setState(r.data.state);
    setNotice("Your Personal Assistant is active.");
  }

  const setupLink = mode === "chat" ? { href: `/${laneId}/settings#ai-brain`, text: "Prefer a form? Open Settings → AI brain" } : { href: `/${laneId}/assistant`, text: "Prefer the chat? Open the assistant" };

  return (
    <section className="flex flex-col gap-4 rounded-card border border-border bg-card p-4" aria-label="Brain setup" data-testid="brain-interview" data-mode={mode}>
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-foreground">{mode === "chat" ? "Let's set up your brain" : "Set up your AI brain"}</h2>
        <p className="text-sm text-muted-foreground">
          A few questions at a time. Nothing is saved until you tap Save, and you see the exact change first.{" "}
          <Link href={setupLink.href} prefetch={false} className="underline">
            {setupLink.text}
          </Link>
        </p>
      </header>

      {notice ? (
        <Alert variant="success" role="status" data-testid="interview-notice">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="alert" role="alert" data-testid="interview-error">
          <AlertTitle>{ERROR_TEXT[error.code] ?? ERROR_TEXT.unavailable}</AlertTitle>
          {error.issues?.length && groupView ? (
            <AlertDescription>
              <ul className="list-disc pl-4">
                {error.issues.slice(0, 6).map((i, k) => (
                  <li key={k}>{issueLabel(i, groupView)}</li>
                ))}
              </ul>
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}

      {view.kind === "group" && groupView ? (
        <div className="flex flex-col gap-4" data-testid="interview-group" data-group={groupView.id}>
          <div className="flex items-center justify-between gap-2">
            <h3 ref={headRef} tabIndex={-1} className="text-sm font-semibold text-foreground outline-none">
              {groupView.title} <span className="font-normal text-muted-foreground">· saves to {groupView.saves}</span>
            </h3>
            <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setView({ kind: "sections" })}>
              All sections
            </Button>
          </div>

          <GroupNotices group={groupView} state={state} />

          {groupView.questions.map((q) => (
            <QuestionBlock
              key={q.id}
              q={q}
              state={state}
              values={values}
              editing={editing}
              onEdit={(id) => setEditing(new Set(editing).add(id))}
              onChange={(qid, key, v) => {
                setProposal(null);
                setValues((all) => ({ ...all, [qid]: { ...all[qid], [key]: v } }));
              }}
            />
          ))}

          {proposal ? (
            <div ref={proposalRef} tabIndex={-1} className="flex flex-col gap-3 outline-none" data-testid="interview-proposal">
              <h4 className="text-sm font-semibold text-foreground">Here is the change. Nothing is saved yet.</h4>
              {proposal.changes.length === 0 ? <p className="text-sm text-muted-foreground">Nothing would change. Saving records this section as done.</p> : <DiffCard proposal={proposal} />}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button className={tap} disabled={busy} onClick={() => void save(groupView, proposal)}>
                  {busy ? "Saving…" : "Save"}
                </Button>
                <Button variant="outline" className={tap} disabled={busy} onClick={() => setProposal(null)}>
                  Change my answers
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button className={tap} disabled={busy || !canPreview(groupView, values, editing) || activeQuestions(groupView, editing).length === 0} onClick={() => void preview(groupView)}>
                {busy ? "Working…" : "Preview the change"}
              </Button>
              <Button variant="outline" className={tap} disabled={busy} onClick={() => skip(groupView)}>
                Skip for now
              </Button>
              <Button variant="ghost" className={tap} disabled={busy || hasUnsavedAnswers(groupView, values, editing)} aria-describedby={hasUnsavedAnswers(groupView, values, editing) ? "nothing-to-add-hint" : undefined} onClick={() => void nothingToAdd(groupView)}>
                Nothing to add
              </Button>
              {hasUnsavedAnswers(groupView, values, editing) ? (
                <span id="nothing-to-add-hint" className="text-xs text-muted-foreground">
                  {SAVE_FIRST_HINT}
                </span>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {view.kind === "sections" ? (
        <div className="flex flex-col gap-3" data-testid="interview-sections">
          <h3 className="text-sm font-semibold text-foreground">Choose a section to set up or change</h3>
          <ul className="flex flex-col gap-2">
            {state.groups.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-background p-3 text-sm" data-testid={`section-${g.id}`}>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-foreground">{g.title}</span>
                  <span className="text-xs text-muted-foreground">{g.part === "A" ? "Your brain" : "Personal Assistant"}</span>
                </span>
                <Badge variant={g.complete ? "success" : "muted"}>{g.complete ? "Done" : "Not done"}</Badge>
                <Button size="sm" variant="outline" className="min-h-11" onClick={() => openGroup(g, true)}>
                  {g.complete ? "Change" : "Set up"}
                </Button>
              </li>
            ))}
          </ul>
          <Button variant="outline" className={tap} onClick={() => setView({ kind: "review" })}>
            Review everything
          </Button>
        </div>
      ) : null}

      {view.kind === "review" ? (
        <div className="flex flex-col gap-4" data-testid="interview-review">
          <h3 className="text-sm font-semibold text-foreground">Summary</h3>
          <ul className="flex flex-col gap-2">
            {state.groups.map((g) => (
              <li key={g.id} className="flex flex-col gap-1 rounded-control border border-border bg-background p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{g.title}</span>
                  <Button size="sm" variant="outline" className="min-h-11" onClick={() => openGroup(g, true)}>
                    Edit
                  </Button>
                </div>
                {g.questions.some((q) => q.known) ? (
                  <ul className="flex flex-col gap-1 text-muted-foreground">
                    {g.questions.filter((q) => q.known).map((q) => (
                      <li key={q.id} className="break-words">
                        {q.known}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">Not set yet.</p>
                )}
              </li>
            ))}
          </ul>

          {state.employee === null ? (
            <Alert>
              <AlertDescription>Save at least one Personal Assistant section to create your assistant&apos;s draft profile.</AlertDescription>
            </Alert>
          ) : (
            <div className="flex flex-col gap-3" data-testid="interview-employee">
              <p className="text-sm text-foreground">
                {state.employee.name}, your Personal Assistant: <Badge variant={state.employee.status === "active" ? "success" : "muted"}>{state.employee.status}</Badge>
              </p>
              {state.employee.invalid ? (
                <Alert variant="alert" data-testid="interview-invalid-profile">
                  <AlertDescription>The stored profile is not valid, so it cannot be confirmed or activated. Save any Personal Assistant section to review a reset.</AlertDescription>
                </Alert>
              ) : null}
              <ul className="flex flex-col gap-1 text-xs text-muted-foreground" aria-label="What it may propose">
                {state.employee.permissions.map((p) => (
                  <li key={p.lane} className="break-words">
                    {p.laneName}: {p.allowed.length ? `may propose to ${p.allowed.map((a) => ACTION_TEXT[a] ?? a).join(", ")}` : "proposes nothing"}
                    {p.denied.map((d) => `; ${d.type} ${REASON_TEXT[d.reason] ?? "not allowed"}`).join("")}
                  </li>
                ))}
              </ul>
              {/* Test briefing (spec Part C step 3): needs the daily briefing, T-213. The check shows why it is not here. */}
              <div className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-background p-3 text-sm" data-testid="interview-test-briefing">
                <span className="min-w-0 flex-1 text-muted-foreground">{state.testBriefing.available ? "Run a test briefing on the last 48 hours." : state.testBriefing.message}</span>
                <Button size="sm" variant="outline" className="min-h-11" disabled>
                  Run test briefing
                </Button>
              </div>
              {state.employee.status === "active" ? (
                <p className="text-sm text-foreground">Your assistant is active. Change any section above, and save it the same way.</p>
              ) : confirmed ? (
                <Button className={tap} disabled={busy} onClick={() => void activate()}>
                  {busy ? "Activating…" : "Activate my assistant"}
                </Button>
              ) : (
                <Button className={tap} disabled={busy} onClick={() => void confirm()}>
                  {busy ? "Checking…" : "Confirm the setup"}
                </Button>
              )}
            </div>
          )}
          <Button variant="outline" className={tap} onClick={() => setView({ kind: "sections" })}>
            Set up or change a section
          </Button>
        </div>
      ) : null}
    </section>
  );
}
