"use client";
// Who and which company Home is drawn for (T-234 part 5), so client pieces can keep their view state (expanded sections, the
// open Reply drawer) in sessionStorage under lane + user. The user id comes from the verified session on the server and is only
// a storage key part (it never decides access). Outside a scope (tests, other pages) nothing is persisted.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { expandedSections, noteSignedInUser } from "@/lib/reply-draft-store";

export type HomeScopeValue = { laneId: string; userId: string };
const Scope = createContext<HomeScopeValue | null>(null);

export function HomeScope({ laneId, userId, children }: HomeScopeValue & { children: ReactNode }) {
  // A different user than this tab last showed Home to: every stored draft and view-state entry goes (before the children read them).
  useLayoutEffect(() => noteSignedInUser(userId), [userId]);
  return <Scope.Provider value={{ laneId, userId }}>{children}</Scope.Provider>;
}

export const useHomeScope = (): HomeScopeValue | null => useContext(Scope);

/**
 * Open/closed state of a section, restored from sessionStorage after mount (the server render and the first client render are
 * both "closed", so there is no hydration mismatch) and written on every change. A router.refresh() keeps the state anyway
 * (client state survives it); the storage copy is for a full reload.
 */
export function usePersistedOpen(id: string | undefined): [boolean, (open: boolean) => void] {
  const scope = useHomeScope();
  const [open, setOpen] = useState(false);
  const laneId = scope?.laneId;
  const userId = scope?.userId;
  useEffect(() => {
    if (!id || !laneId || !userId) return;
    if (expandedSections.read(laneId, userId, id) === true) queueMicrotask(() => setOpen(true));
  }, [id, laneId, userId]);
  const set = (next: boolean) => {
    setOpen(next);
    if (!id || !laneId || !userId) return;
    if (next) expandedSections.write(laneId, userId, id, true);
    else expandedSections.remove(laneId, userId, id);
  };
  return [open, set];
}

/**
 * A `<details>` the browser owns (uncontrolled, so a re-render from the server never touches its open state). The restored
 * state is applied through a ref after mount (the server render and the first client render are both closed) and the toggle
 * event only persists the state to sessionStorage.
 */
export function PersistedDetails({ id, summary, children, className, testId, summaryClassName }: { id: string; summary: ReactNode; children: ReactNode; className?: string; testId?: string; summaryClassName?: string }) {
  const scope = useHomeScope();
  const ref = useRef<HTMLDetailsElement>(null);
  const laneId = scope?.laneId;
  const userId = scope?.userId;
  useEffect(() => {
    if (!laneId || !userId || !ref.current) return;
    if (expandedSections.read(laneId, userId, id) === true) ref.current.open = true;
  }, [id, laneId, userId]);
  return (
    <details
      ref={ref}
      data-testid={testId}
      className={className}
      onToggle={(e) => {
        if (!laneId || !userId) return;
        if (e.currentTarget.open) expandedSections.write(laneId, userId, id, true);
        else expandedSections.remove(laneId, userId, id);
      }}
    >
      <summary className={summaryClassName}>{summary}</summary>
      {children}
    </details>
  );
}
