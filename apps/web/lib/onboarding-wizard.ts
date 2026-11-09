// Pure helpers for the onboarding wizard (T-226): which screen opens first, and the screen before/after another.
// No server imports; used by the client component and unit-tested.

export type Stage = { kind: "intro" } | { kind: "group"; id: string } | { kind: "finish" };

type G = { id: string; complete: boolean };

/**
 * The screen the wizard opens on. `step` is validated against the bank's sections (`groups`): a valid id opens that step;
 * an unknown value (or none) falls back to the first incomplete step. A fresh start (no `?step=` at all and nothing saved)
 * shows the intro; when every section is done the finish screen opens.
 */
export function initialStage(groups: readonly G[], step: string | undefined, hadStep: boolean): Stage {
  if (step !== undefined && groups.some((g) => g.id === step)) return { kind: "group", id: step };
  if (!hadStep && !groups.some((g) => g.complete)) return { kind: "intro" };
  const next = groups.find((g) => !g.complete);
  return next ? { kind: "group", id: next.id } : { kind: "finish" };
}

/** The screen after a group (bank order); the finish screen after the last one. */
export function stageAfter(groups: readonly G[], id: string): Stage {
  const i = groups.findIndex((g) => g.id === id);
  const next = i >= 0 ? groups[i + 1] : undefined;
  return next ? { kind: "group", id: next.id } : { kind: "finish" };
}

/** The screen before a group; the intro before the first one. */
export function stageBefore(groups: readonly G[], id: string): Stage {
  const i = groups.findIndex((g) => g.id === id);
  const prev = i > 0 ? groups[i - 1] : undefined;
  return prev ? { kind: "group", id: prev.id } : { kind: "intro" };
}

/** The first section that is not done (where "Start" and "Continue setup" go), or the first one when all are done. */
export function firstIncomplete(groups: readonly G[]): string | null {
  return (groups.find((g) => !g.complete) ?? groups[0])?.id ?? null;
}
