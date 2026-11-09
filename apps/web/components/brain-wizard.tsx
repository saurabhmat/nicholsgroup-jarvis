"use client";
// Guided onboarding wizard (T-226): BrainInterview mode "wizard". The same bank, the same interview API (state / propose /
// save / confirm / activate) and the same checks as the chat and Settings flows; no new data path. One group (at most three
// questions) per screen: fields -> "Preview change" (the exact diff card) -> "Save & continue". Only the Save click writes.
// "Back" keeps the answers typed so far, "Skip for now" leaves the answers as "Not provided" (never guessed). Known answers
// show "Already set: … (Edit)". All text is rendered as React text. iPhone: the rail collapses to "Step N of 10" and the
// action bar sticks above the tab bar.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Alert, AlertDescription, AlertTitle, Badge, Button, buttonVariants, cn } from "@nichols/ui";
import type { GroupView } from "@nichols/brain/interview";
import type { InterviewState, Proposal } from "@nichols/brain/server";
import { ERROR_TEXT, activeQuestions, buildAnswers, callInterview, canPreview, initialValues, issueLabel, type ApiErr, type FormValues } from "@/lib/brain-interview-client";
import { firstIncomplete, initialStage, stageAfter, stageBefore, type Stage } from "@/lib/onboarding-wizard";
import { ACTION_TEXT, DiffCard, GroupNotices, QuestionBlock, REASON_TEXT, tap } from "./brain-interview-parts";

type Draft = { values: FormValues; editing: Set<string> };

export function BrainWizard({ laneId, initialStep, hadStep }: { laneId: string; initialStep?: string; hadStep?: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<InterviewState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiErr | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const headRef = useRef<HTMLHeadingElement | null>(null);
  const first = useRef(true);
  const stageKey = stage ? (stage.kind === "group" ? `g:${stage.id}` : stage.kind) : "";

  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await callInterview<{ state: InterviewState }>(laneId, { action: "state" });
      if (!live) return;
      if (!r.ok) return setLoadError(ERROR_TEXT[r.code] ?? ERROR_TEXT.unavailable ?? "");
      setState(r.data.state);
      // The step from the URL is checked against the bank's sections again here; an unknown value falls back.
      setStage(initialStage(r.data.state.groups, initialStep, hadStep ?? initialStep !== undefined));
    })();
    return () => {
      live = false;
    };
  }, [laneId, initialStep, hadStep]);

  // Keyboard and screen-reader users land on the new screen; the first render does not steal focus.
  useEffect(() => {
    if (!stageKey) return;
    if (first.current) {
      first.current = false;
      return;
    }
    headRef.current?.scrollIntoView?.({ block: "nearest" });
    headRef.current?.focus();
  }, [stageKey]);

  if (loadError) {
    return (
      <Alert variant="alert" data-testid="interview-error">
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    );
  }
  if (!state || !stage) return <p className="text-sm text-muted-foreground" aria-live="polite">Loading your setup…</p>;

  const groups = state.groups;
  const doneCount = groups.filter((g) => g.done).length;
  const total = groups.length;
  const currentIndex = stage.kind === "group" ? groups.findIndex((g) => g.id === stage.id) : -1;
  const groupView: GroupView | undefined = stage.kind === "group" ? groups[currentIndex] : undefined;

  const draftFor = (g: GroupView): Draft => drafts[g.id] ?? { values: initialValues(g), editing: new Set() };
  const patchDraft = (g: GroupView, f: (d: Draft) => Draft) => setDrafts((all) => ({ ...all, [g.id]: f(all[g.id] ?? { values: initialValues(g), editing: new Set() }) }));

  const go = (next: Stage) => {
    setProposal(null);
    setError(null);
    setNotice(null);
    setStage(next);
  };

  async function preview(g: GroupView) {
    const d = draftFor(g);
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await callInterview<{ proposal: Proposal }>(laneId, { action: "propose", group: g.id, answers: buildAnswers(g, d.values, d.editing) });
    setBusy(false);
    if (!r.ok) return setError(r);
    setProposal(r.data.proposal);
  }

  async function save(g: GroupView, p: Proposal) {
    const d = draftFor(g);
    setBusy(true);
    setError(null);
    const r = await callInterview<{ state: InterviewState }>(laneId, { action: "save", group: g.id, answers: buildAnswers(g, d.values, d.editing), proposalId: p.proposalId });
    setBusy(false);
    if (!r.ok) {
      if (r.code === "proposal_changed" || r.code === "version_conflict") setProposal(null);
      return setError(r);
    }
    setState(r.data.state);
    setDrafts(({ [g.id]: _saved, ...rest }) => {
      void _saved;
      return rest;
    });
    setConfirmed(false);
    setProposal(null);
    setStage(stageAfter(r.data.state.groups, g.id));
    setNotice(`Saved: ${g.title}.`);
    router.refresh(); // the menu badge and the Home banner count the saved section
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    const r = await callInterview<{ employee: InterviewState["employee"] }>(laneId, { action: "confirm" });
    setBusy(false);
    if (!r.ok) return setError(r);
    setConfirmed(true);
  }
  async function activate() {
    setBusy(true);
    setError(null);
    const r = await callInterview<{ state: InterviewState }>(laneId, { action: "activate" });
    setBusy(false);
    if (!r.ok) return setError(r);
    setState(r.data.state);
    setNotice("Your Personal Assistant is active.");
    router.refresh();
  }

  const stepHref = (id: string) => `/${encodeURIComponent(laneId)}/onboarding?step=${encodeURIComponent(id)}`;

  return (
    <section aria-label="Guided setup" className="flex flex-col gap-4" data-testid="brain-wizard" data-stage={stageKey}>
      {stage.kind !== "intro" ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-foreground md:hidden" data-testid="wizard-step-label">
            {stage.kind === "group" ? `Step ${String(currentIndex + 1)} of ${String(total)}` : "All steps"}
          </p>
          <div className="flex items-center gap-3">
            <div
              role="progressbar"
              aria-label="Setup progress"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={doneCount}
              aria-valuetext={`${String(doneCount)} of ${String(total)} sections saved`}
              className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full bg-primary transition-[width]" style={{ width: `${String(Math.round((doneCount / Math.max(total, 1)) * 100))}%` }} />
            </div>
            <span className="text-xs text-muted-foreground" data-testid="wizard-progress-text">
              {doneCount} of {total} saved
            </span>
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 md:grid-cols-[16rem_minmax(0,1fr)]">
        <nav aria-label="Setup sections" className="hidden md:block" data-testid="wizard-rail">
          <ol className="flex flex-col gap-1">
            {groups.map((g, i) => {
              const current = stage.kind === "group" && stage.id === g.id;
              return (
                <li key={g.id}>
                  <button
                    type="button"
                    aria-current={current ? "step" : undefined}
                    onClick={() => go({ kind: "group", id: g.id })}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-2 rounded-control border-l-[3px] px-3 py-2 text-left text-sm hover:bg-muted",
                      current ? "border-gold bg-primary-tint font-semibold text-foreground" : "border-transparent text-muted-foreground",
                    )}
                  >
                    <span className="w-5 shrink-0 text-xs tabular-nums">{i + 1}</span>
                    <span className="min-w-0 flex-1 break-words">{g.title}</span>
                    <Badge variant={g.done ? "success" : current ? "secondary" : "muted"}>{g.done ? "Done" : current ? "Current" : "To do"}</Badge>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-4 md:p-6">
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

          {stage.kind === "intro" ? (
            <div className="flex flex-col gap-4" data-testid="wizard-intro">
              <h2 ref={headRef} tabIndex={-1} className="font-heading text-xl font-semibold text-foreground outline-none">
                Before you start
              </h2>
              <ul className="flex flex-col gap-3 text-base text-foreground">
                <li>Jarvis will learn how you work: who you are, how you spend your time, your companies, and how you want your briefing and mail handled.</li>
                <li>It never stores passwords, account numbers, or client or matter details.</li>
                <li>Nothing is saved until you approve it. You see the exact change first.</li>
              </ul>
              <div>
                <Button className={tap} onClick={() => go({ kind: "group", id: firstIncomplete(groups) ?? groups[0]?.id ?? "" })}>
                  Start
                </Button>
              </div>
            </div>
          ) : null}

          {stage.kind === "group" && groupView ? (
            <GroupScreen
              group={groupView}
              index={currentIndex}
              total={total}
              state={state}
              draft={draftFor(groupView)}
              proposal={proposal}
              busy={busy}
              headRef={headRef}
              onEdit={(id) => patchDraft(groupView, (d) => ({ ...d, editing: new Set(d.editing).add(id) }))}
              onChange={(qid, key, v) => {
                setProposal(null);
                patchDraft(groupView, (d) => ({ ...d, values: { ...d.values, [qid]: { ...d.values[qid], [key]: v } } }));
              }}
              onPreview={() => void preview(groupView)}
              onSave={() => proposal && void save(groupView, proposal)}
              onNext={() => go(stageAfter(groups, groupView.id))}
              onBack={() => go(stageBefore(groups, groupView.id))}
            />
          ) : null}

          {stage.kind === "finish" ? (
            <div className="flex flex-col gap-4" data-testid="wizard-finish">
              <h2 ref={headRef} tabIndex={-1} className="font-heading text-xl font-semibold text-foreground outline-none">
                Your setup so far
              </h2>
              <ul className="flex flex-col gap-2">
                {groups.map((g) => (
                  <li key={g.id} className="flex flex-col gap-1 rounded-control border border-border bg-background p-3 text-sm" data-testid={`finish-${g.id}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground">{g.title}</span>
                      <Link
                        href={stepHref(g.id)}
                        prefetch={false}
                        className="inline-flex min-h-11 items-center px-2 text-primary underline underline-offset-2"
                        onClick={(e) => {
                          e.preventDefault();
                          go({ kind: "group", id: g.id });
                        }}
                      >
                        Edit<span className="sr-only"> {g.title}</span>
                      </Link>
                    </div>
                    {g.questions.some((q) => q.known) ? (
                      <ul className="flex flex-col gap-1 text-muted-foreground">
                        {g.questions
                          .filter((q) => q.known)
                          .map((q) => (
                            <li key={q.id} className="break-words">
                              {q.known}
                            </li>
                          ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground">Not provided</p>
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

              {/* Test briefing waits for the daily briefing (T-213): disabled, with the reason. */}
              <div className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-background p-3 text-sm" data-testid="interview-test-briefing">
                <span className="min-w-0 flex-1 text-muted-foreground">Arrives with the daily briefing</span>
                <Button size="sm" variant="outline" className="min-h-11" disabled>
                  Run test briefing
                </Button>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row">
                <Link href={`/${encodeURIComponent(laneId)}/assistant`} className={cn(buttonVariants(), tap, "inline-flex items-center justify-center")}>
                  Ask Jarvis
                </Link>
                <Button variant="outline" className={tap} onClick={() => go({ kind: "group", id: firstIncomplete(groups) ?? groups[0]?.id ?? "" })}>
                  Back to the steps
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function GroupScreen({
  group,
  index,
  total,
  state,
  draft,
  proposal,
  busy,
  headRef,
  onEdit,
  onChange,
  onPreview,
  onSave,
  onNext,
  onBack,
}: {
  group: GroupView;
  index: number;
  total: number;
  state: InterviewState;
  draft: Draft;
  proposal: Proposal | null;
  busy: boolean;
  headRef: RefObject<HTMLHeadingElement | null>;
  onEdit: (id: string) => void;
  onChange: (qid: string, key: string, v: unknown) => void;
  onPreview: () => void;
  onSave: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const nothingToAsk = activeQuestions(group, draft.editing).length === 0;
  const changes = proposal?.changes.length ?? 0;
  const last = index === total - 1;
  return (
    <div className="flex flex-col gap-4" data-testid="interview-group" data-group={group.id}>
      <div>
        <p className="hidden text-xs text-muted-foreground md:block">
          Step {index + 1} of {total} · saves to {group.saves}
        </p>
        <h2 ref={headRef} tabIndex={-1} className="font-heading text-xl font-semibold text-foreground outline-none">
          {group.title}
        </h2>
      </div>

      <GroupNotices group={group} state={state} />

      {group.questions.map((q) => (
        <QuestionBlock key={q.id} q={q} state={state} values={draft.values} editing={draft.editing} onEdit={onEdit} onChange={onChange} />
      ))}

      {proposal ? (
        <div className="flex flex-col gap-3" data-testid="interview-proposal">
          <h3 className="text-sm font-semibold text-foreground">Here is the change. Nothing is saved yet.</h3>
          {changes === 0 ? <p className="text-sm text-muted-foreground">Nothing would change.</p> : <DiffCard proposal={proposal} />}
        </div>
      ) : null}

      <div
        className="sticky bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-[5] -mx-4 flex flex-wrap items-center gap-2 border-t border-border bg-card px-4 py-3 md:static md:mx-0 md:border-0 md:bg-transparent md:p-0"
        data-testid="wizard-actions"
      >
        {proposal && changes > 0 ? (
          <Button className={cn(tap, "order-first w-full md:order-last md:w-auto")} disabled={busy} onClick={onSave}>
            {busy ? "Saving…" : last ? "Save & finish" : "Save & continue"}
          </Button>
        ) : proposal || nothingToAsk ? (
          <Button className={cn(tap, "order-first w-full md:order-last md:w-auto")} disabled={busy} onClick={onNext}>
            {last ? "Finish" : "Continue"}
          </Button>
        ) : (
          <Button className={cn(tap, "order-first w-full md:order-last md:w-auto")} disabled={busy || !canPreview(group, draft.values, draft.editing)} onClick={onPreview}>
            {busy ? "Working…" : "Preview change"}
          </Button>
        )}
        <Button variant="outline" className="min-h-11 flex-1 md:flex-none" disabled={busy} onClick={onBack}>
          Back
        </Button>
        <Button variant="ghost" className="min-h-11 flex-1 md:flex-none" disabled={busy} onClick={onNext}>
          Skip for now
        </Button>
        <span className="sr-only md:not-sr-only md:ml-auto md:text-xs md:text-muted-foreground">Skipped answers stay &quot;Not provided&quot;.</span>
      </div>
    </div>
  );
}
