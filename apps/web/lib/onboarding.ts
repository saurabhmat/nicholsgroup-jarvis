// Setup progress for the guided onboarding (T-226): which of the bank's sections are done, for the "Get started" menu
// entry, the Home banner, Settings -> AI brain and the wizard's deep links. Read-only: the same state the interview API
// returns (no new data path, nothing written). Shown only to an owner with the brain view in this lane (the same gate as
// the interview route); anyone else gets null, so the entry points are not drawn.
import type { Guards } from "@nichols/core/auth";
import { GROUPS } from "@nichols/brain/interview";
import { loadInterviewState } from "@nichols/brain/server";
import { buildEnv, type InterviewDeps } from "@/lib/brain-interview";

export type OnboardingSection = { id: string; title: string; done: boolean };

/** `done` is null when the state could not be read just now (the entry then shows no count). */
export type OnboardingView = { done: number | null; total: number; sections: OnboardingSection[]; nextSectionId: string | null };

const bank = (): OnboardingSection[] => GROUPS.map((g) => ({ id: g.id, title: g.title, done: false }));

/** A section id from a URL (`?step=`): only ids of the bank's sections pass; anything else is undefined. */
export function sectionIdFrom(raw: string | string[] | undefined): string | undefined {
  return typeof raw === "string" && GROUPS.some((g) => g.id === raw) ? raw : undefined;
}

export async function loadOnboarding(
  g: Pick<Guards, "requireRole" | "requireLane" | "listLanes">,
  laneId: string,
  now: Date,
): Promise<OnboardingView | null> {
  let userId: string;
  try {
    userId = (await g.requireRole(laneId, ["owner"])).session.userId;
  } catch {
    return null; // not an owner, or an outage: the entry is hidden; the page behind it checks again
  }
  let built: Awaited<ReturnType<typeof buildEnv>>;
  try {
    built = await buildEnv(g as Awaited<ReturnType<InterviewDeps["guards"]>>, laneId, userId, now);
  } catch {
    return null;
  }
  if ("refused" in built) return null;
  try {
    const state = await loadInterviewState(built.env);
    const sections = state.groups.map((x) => ({ id: x.id, title: x.title, done: x.done }));
    return { done: sections.filter((s) => s.done).length, total: sections.length, sections, nextSectionId: sections.find((s) => !s.done)?.id ?? null };
  } catch {
    return { done: null, total: GROUPS.length, sections: bank(), nextSectionId: GROUPS[0]?.id ?? null };
  }
}
