"use client";
// Setup interview (T-216, spec brain-and-employees §7): the same flow in the assistant chat (mode "chat") and in
// Settings -> AI brain (mode "page"). Up to three questions per step, "Already set" for known answers, a diff card per
// group and a Save button that is the ONLY thing that writes (preview never does). Summary -> confirm -> test briefing
// (waits for T-213) -> activate. Connecting an account is never done here: a missing source links to Settings ->
// Connections. All text is rendered as React text (never HTML). Single column and 44 px targets for the iPhone.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle, Badge, Button, cn } from "@nichols/ui";
import type { FieldView, GroupView, QuestionView } from "@nichols/brain/interview";
import type { InterviewState, Proposal } from "@nichols/brain/server";
import {
  ERROR_TEXT,
  activeQuestions,
  buildAnswers,
  callInterview,
  canPreview,
  initialValues,
  issueLabel,
  nextGroupId,
  type ApiErr,
  type FormValues,
} from "@/lib/brain-interview-client";

type View = { kind: "group"; id: string } | { kind: "review" } | { kind: "sections" };

const control =
  "min-h-11 w-full min-w-0 rounded-control border border-border bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm";
const tap = "min-h-11 w-full sm:w-auto";

const NOTE_LABEL = { connected: "Connected", not_connected: "Not connected yet", unknown: "Connection unknown" } as const;
const REASON_TEXT: Record<string, string> = {
  lane_policy: "not allowed in this company",
  role: "not allowed for your role",
  drafts_not_stored: "drafts are not stored in this company",
  unknown_type: "not allowed",
};
const ACTION_TEXT: Record<string, string> = { "email.save_draft": "save a draft reply (after you approve it)", "email.send": "send email (after you approve it)", "calendar.event": "change calendar events (after you approve)", "monday.item": "update monday items (after you approve)", "notion.page": "update Notion pages (after you approve)" };

function Field({ f, q, value, set, values, state }: { f: FieldView; q: QuestionView; value: unknown; set: (v: unknown) => void; values: FormValues; state: InterviewState }) {
  const id = `iv-${q.id}-${f.key}`;
  const label = (
    <label htmlFor={id} className="text-sm font-medium text-foreground">
      {f.label}
    </label>
  );
  switch (f.kind) {
    case "text":
      return (
        <div className="flex flex-col gap-1">
          {label}
          <input id={id} className={control} value={String(value ?? "")} maxLength={f.max} onChange={(e) => set(e.target.value)} />
        </div>
      );
    case "longtext":
    case "list":
      return (
        <div className="flex flex-col gap-1">
          {label}
          <textarea id={id} className={cn(control, "min-h-24")} rows={3} value={String(value ?? "")} maxLength={f.max} onChange={(e) => set(e.target.value)} />
        </div>
      );
    case "time":
      return (
        <div className="flex flex-col gap-1">
          {label}
          <input id={id} type="time" className={control} value={String(value ?? "")} onChange={(e) => set(e.target.value)} />
        </div>
      );
    case "number":
      return (
        <div className="flex flex-col gap-1">
          {label}
          <input id={id} type="number" inputMode="numeric" className={control} min={f.min} max={f.max} value={String(value ?? "")} onChange={(e) => set(e.target.value === "" ? "" : Number(e.target.value))} />
        </div>
      );
    case "boolean":
      return (
        <label htmlFor={id} className="flex min-h-11 items-center gap-3 text-sm text-foreground">
          <input id={id} type="checkbox" className="size-5" checked={value === true} onChange={(e) => set(e.target.checked)} />
          {f.label}
        </label>
      );
    case "select":
      return (
        <div className="flex flex-col gap-1">
          {label}
          <select id={id} className={control} value={String(value ?? "")} onChange={(e) => set(e.target.value)}>
            {f.required && value === "" ? <option value="">Choose…</option> : null}
            {(f.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      );
    case "multiselect": {
      if (q.id === "B7" && f.key === "kpis" && values[q.id]?.show !== "pick") return null;
      const chosen = new Set(Array.isArray(value) ? (value as string[]) : []);
      const options = f.options ?? [];
      if (options.length === 0) return <p className="text-sm text-muted-foreground">{f.label}: nothing to pick for this company.</p>;
      return (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium text-foreground">{f.label}</legend>
          <div className="flex flex-wrap gap-2">
            {options.map((o) => {
              const on = chosen.has(o.value);
              return (
                <label key={o.value} className={cn("inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-control border px-3 text-sm", on ? "border-primary bg-primary-tint text-foreground" : "border-border bg-card text-muted-foreground")}>
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={on}
                    onChange={() => {
                      const next = new Set(chosen);
                      if (on) next.delete(o.value);
                      else next.add(o.value);
                      set(options.filter((x) => next.has(x.value)).map((x) => x.value));
                    }}
                  />
                  {o.label}
                </label>
              );
            })}
          </div>
        </fieldset>
      );
    }
    case "mailbox_order": {
      const options = f.options ?? [];
      const picked = Array.isArray(value) ? (value as string[]) : [];
      const move = (i: number, d: number) => {
        const next = [...picked];
        const [x] = next.splice(i, 1);
        next.splice(i + d, 0, x as string);
        set(next);
      };
      const byValue = new Map(options.map((o) => [o.value, o]));
      return (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-foreground">{f.label}</p>
          {options.length === 0 ? (
            <Alert>
              <AlertDescription>
                No mailbox is set up for this company yet.{" "}
                <Link href={state.sources.find((s) => s.laneId === state.currentLane)?.settingsPath ?? "/"} prefetch={false} className="underline">
                  Open Settings → Connections
                </Link>
                .
              </AlertDescription>
            </Alert>
          ) : null}
          <ol className="flex flex-col gap-2" aria-label="Chosen mailboxes">
            {picked.map((v, i) => {
              const o = byValue.get(v);
              return (
                <li key={v} className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-card px-3 py-2 text-sm">
                  <span className="font-medium">{i + 1}.</span>
                  <span className="min-w-0 flex-1 break-all">{o?.label ?? v}</span>
                  {o?.note ? <Badge variant={o.note === "connected" ? "success" : "muted"}>{NOTE_LABEL[o.note]}</Badge> : null}
                  <Button size="sm" variant="outline" className="min-h-11" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${o?.label ?? v} up`}>
                    Up
                  </Button>
                  <Button size="sm" variant="outline" className="min-h-11" disabled={i === picked.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${o?.label ?? v} down`}>
                    Down
                  </Button>
                  <Button size="sm" variant="ghost" className="min-h-11" onClick={() => set(picked.filter((x) => x !== v))} aria-label={`Remove ${o?.label ?? v}`}>
                    Remove
                  </Button>
                </li>
              );
            })}
          </ol>
          <div className="flex flex-col gap-2">
            {options
              .filter((o) => !picked.includes(o.value))
              .map((o) => (
                <button key={o.value} type="button" onClick={() => set([...picked, o.value])} className="flex min-h-11 flex-wrap items-center gap-2 rounded-control border border-dashed border-border px-3 py-2 text-left text-sm text-foreground hover:bg-muted">
                  <span className="min-w-0 flex-1 break-all">Add {o.label}</span>
                  {o.note ? <Badge variant={o.note === "connected" ? "success" : "muted"}>{NOTE_LABEL[o.note]}</Badge> : null}
                </button>
              ))}
          </div>
        </div>
      );
    }
    case "mailbox_text": {
      const b2 = values.B2?.mailboxes;
      const picked = Array.isArray(b2) ? (b2 as string[]) : [];
      const map = (typeof value === "object" && value !== null ? value : {}) as Record<string, string>;
      if (picked.length === 0) return <p className="text-sm text-muted-foreground">Pick a mailbox above first, then say what counts as important in it.</p>;
      const byValue = new Map((state.groups.flatMap((g) => g.questions).find((x) => x.id === "B2")?.fields[0]?.options ?? []).map((o) => [o.value, o.label]));
      return (
        <div className="flex flex-col gap-3">
          {picked.map((v) => (
            <div key={v} className="flex flex-col gap-1">
              <label htmlFor={`${id}-${v}`} className="text-sm font-medium text-foreground break-all">
                {byValue.get(v) ?? v}
              </label>
              <textarea id={`${id}-${v}`} className={cn(control, "min-h-20")} rows={2} maxLength={2000} value={map[v] ?? ""} onChange={(e) => set({ ...map, [v]: e.target.value })} />
            </div>
          ))}
        </div>
      );
    }
  }
}

function DiffCard({ proposal }: { proposal: Proposal }) {
  return (
    <div className="flex flex-col gap-3" data-testid="interview-diff">
      {proposal.changes.map((c, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-card border border-border bg-background p-3">
          <p className="text-sm font-medium text-foreground">
            {c.kind === "document" ? `${c.path} (${c.lane})` : `${c.name}, Personal Assistant profile (${c.lane}), stays ${c.status}`}
          </p>
          {c.kind === "employee" && c.resetsInvalid ? (
            <Alert variant="alert" data-testid="interview-reset-warning">
              <AlertTitle>The stored assistant profile is not valid</AlertTitle>
              <AlertDescription>Saving replaces its settings with the ones below, starting from the defaults. Check them before you save.</AlertDescription>
            </Alert>
          ) : null}
          <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-control bg-card p-2 text-xs leading-relaxed">
            {c.diff.map((l, j) => (
              <span key={j} className={cn("block", l.type === "add" && "bg-success-surface text-foreground", l.type === "del" && "bg-alert-surface text-alert-foreground line-through")}>
                {l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}
                {l.text}
              </span>
            ))}
          </pre>
          {c.kind === "employee" && c.settings.length > 0 ? (
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground" aria-label="Settings that change">
              {c.settings.map((s) => (
                <li key={s.path} className="break-words">
                  <span className="font-medium text-foreground">{s.path}</span>: {s.before} → {s.after}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function BrainInterview({ laneId, mode, startAt }: { laneId: string; mode: "chat" | "page"; startAt?: "setup" | "assistant" }) {
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
    const r = await callInterview<{ state: InterviewState }>(laneId, { action: "save", group: g.id, answers: buildAnswers(g, values, editing), proposalId: p.proposalId });
    setBusy(false);
    if (!r.ok) {
      if (r.code === "proposal_changed" || r.code === "version_conflict") setProposal(null);
      return fail(r);
    }
    const seen = new Set(visited).add(g.id);
    setVisited(seen);
    setState(r.data.state);
    setNotice(`Saved: ${g.title}.`);
    setConfirmed(false);
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
  const missing = state.sources.filter((s) => s.noMailboxes || s.mailboxes.some((m) => m.state === "not_connected"));

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
        <div className="flex flex-col gap-4" data-testid="interview-group">
          <div className="flex items-center justify-between gap-2">
            <h3 ref={headRef} tabIndex={-1} className="text-sm font-semibold text-foreground outline-none">
              {groupView.title} <span className="font-normal text-muted-foreground">· saves to {groupView.saves}</span>
            </h3>
            <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setView({ kind: "sections" })}>
              All sections
            </Button>
          </div>

          {groupView.questions.some((q) => q.id === "B2") && missing.length > 0 ? (
            <Alert data-testid="interview-missing-source">
              <AlertTitle>A mailbox is not connected yet</AlertTitle>
              <AlertDescription>
                {missing.map((s) => (
                  <span key={s.laneId} className="block">
                    {s.noMailboxes ? `${s.laneName} has no mailbox set up.` : `${s.laneName}: ${s.mailboxes.filter((m) => m.state === "not_connected").map((m) => m.address).join(", ")} not connected.`}{" "}
                    <Link href={s.settingsPath} prefetch={false} className="underline">
                      Open Settings → Connections
                    </Link>
                  </span>
                ))}
                You can still choose a mailbox now; it is read once it is connected. Connecting is done only in Settings.
              </AlertDescription>
            </Alert>
          ) : null}

          {groupView.questions.some((q) => q.id === "A5") && state.sources.length > 1 ? (
            <p className="text-xs text-muted-foreground" data-testid="interview-other-companies">
              This covers {state.sources.find((s) => s.laneId === state.currentLane)?.laneName ?? "this company"} only. Open the assistant in each other company to answer these for it too.
            </p>
          ) : null}

          {groupView.questions.map((q) => {
            if (q.status === "skipped")
              return (
                <p key={q.id} className="text-sm text-muted-foreground" data-testid={`q-${q.id}-skipped`}>
                  Skipped: {q.prompt}{" "}
                  {q.skipReason === "no_finance" ? "(no finance view in this company)" : q.skipReason === "no_web" ? "(outside news is not allowed here)" : q.skipReason === "no_drafts" ? "(reply drafts are not allowed here)" : ""}
                </p>
              );
            if (q.status === "known" && !editing.has(q.id))
              return (
                <div key={q.id} className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-background p-3 text-sm" data-testid={`q-${q.id}-known`}>
                  <span className="min-w-0 flex-1 break-words">
                    <span className="block font-medium text-foreground">{q.prompt}</span>
                    <span className="text-muted-foreground">Already set: {q.known}</span>
                  </span>
                  <Button size="sm" variant="outline" className="min-h-11" onClick={() => setEditing(new Set(editing).add(q.id))}>
                    Edit
                  </Button>
                </div>
              );
            return (
              <div key={q.id} className="flex flex-col gap-3" data-testid={`q-${q.id}`}>
                <p className="text-sm font-medium text-foreground">{q.prompt}</p>
                {q.hint ? <p className="text-xs text-muted-foreground">{q.hint}</p> : null}
                {q.fields.map((f) => (
                  <Field
                    key={f.key}
                    f={f}
                    q={q}
                    state={state}
                    values={values}
                    value={values[q.id]?.[f.key]}
                    set={(v) => {
                      setProposal(null);
                      setValues((all) => ({ ...all, [q.id]: { ...all[q.id], [f.key]: v } }));
                    }}
                  />
                ))}
              </div>
            );
          })}

          {proposal ? (
            <div ref={proposalRef} tabIndex={-1} className="flex flex-col gap-3 outline-none" data-testid="interview-proposal">
              <h4 className="text-sm font-semibold text-foreground">Here is the change. Nothing is saved yet.</h4>
              {proposal.changes.length === 0 ? <p className="text-sm text-muted-foreground">Nothing would change.</p> : <DiffCard proposal={proposal} />}
              <div className="flex flex-col gap-2 sm:flex-row">
                {proposal.changes.length > 0 ? (
                  <Button className={tap} disabled={busy} onClick={() => void save(groupView, proposal)}>
                    {busy ? "Saving…" : "Save"}
                  </Button>
                ) : (
                  <Button className={tap} onClick={() => {
                      const seen = new Set(visited).add(groupView.id);
                      setVisited(seen);
                      route(state, groupView.id, seen);
                    }}>
                    Next
                  </Button>
                )}
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
            </div>
          )}
        </div>
      ) : null}

      {view.kind === "sections" ? (
        <div className="flex flex-col gap-3" data-testid="interview-sections">
          <h3 className="text-sm font-semibold text-foreground">Choose a section to set up or change</h3>
          <ul className="flex flex-col gap-2">
            {state.groups.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-background p-3 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-foreground">{g.title}</span>
                  <span className="text-xs text-muted-foreground">{g.part === "A" ? "Your brain" : "Personal Assistant"}</span>
                </span>
                <Badge variant={g.done ? "success" : "muted"}>{g.done ? "Done" : "Not done"}</Badge>
                <Button size="sm" variant="outline" className="min-h-11" onClick={() => openGroup(g, true)}>
                  {g.done ? "Change" : "Set up"}
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
