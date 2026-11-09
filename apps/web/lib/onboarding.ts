// Setup progress for the guided onboarding (T-226): which of the bank's sections are done, for the "Get started" menu
// entry, the Home banner, Settings -> AI brain and the wizard's deep links. Read-only (it never writes, not even the one-time
// completion backfill: that runs only from the interview API's state / save / complete actions); the same stored completion
// the interview API returns (no new data path). Shown only to an owner with the brain view in this lane (the same gate as
// the interview route); anyone else gets null, so the entry points are not drawn.
import type { Guards } from "@nichols/core/auth";
import { GROUPS } from "@nichols/brain/interview";
import { resolveHomeLane } from "@nichols/brain";
import { createBrainStore, loadProgress, type ClientFor, type InterviewEnv } from "@nichols/brain/server";
import { brainLanes, readLaneInfo, timezoneList } from "@/lib/brain-interview";

export type OnboardingSection = { id: string; title: string; done: boolean };

/** `done` is null when the state could not be read just now (the entry then shows no count). */
export type OnboardingView = { done: number | null; total: number; sections: OnboardingSection[]; nextSectionId: string | null };

const bank = (): OnboardingSection[] => GROUPS.map((g) => ({ id: g.id, title: g.title, done: false }));

/** A section id from a URL (`?step=`): only ids of the bank's sections pass; anything else is undefined. */
export function sectionIdFrom(raw: string | string[] | undefined): string | undefined {
  return typeof raw === "string" && GROUPS.some((g) => g.id === raw) ? raw : undefined;
}

/**
 * Lightweight progress for the menu badge, the Home banner and Settings (T-226): the owner role and the brain view for THIS
 * lane only, this lane's facts (settings, policy; no connection state), the stored pages and profile, and the stored
 * completion (`GroupView.complete`: set by Save or "Nothing to add", T-227; until the user has any rows it shows what the
 * T-226 rule derives from the saved answers, which is what the first full-context load records).
 * Not the full interview environment (that is the wizard's own state call). Fails closed: null hides the entry.
 */
export async function loadOnboarding(
  g: Pick<Guards, "requireRole" | "requireLane" | "listLanes">,
  laneId: string,
  now: Date,
): Promise<OnboardingView | null> {
  let userId: string;
  let client: Awaited<ReturnType<Guards["requireLane"]>>["client"];
  try {
    const ctx = await g.requireRole(laneId, ["owner"]);
    userId = ctx.session.userId;
    client = ctx.client;
  } catch {
    return null; // not an owner, or an outage: the entry is hidden; the page behind it checks again
  }
  let env: InterviewEnv;
  try {
    const [withBrain, withFinance] = await Promise.all([brainLanes(client, userId, "brain"), brainLanes(client, userId, "finance")]);
    if (!withBrain.includes(laneId)) return null;
    const info = await readLaneInfo(client, laneId, laneId, withFinance.includes(laneId), false);
    if (!info) return null;
    const clients = new Map<string, ReturnType<ClientFor>>([[laneId, Promise.resolve(client as never)]]);
    const clientFor: ClientFor = (l) => {
      let c = clients.get(l);
      if (c === undefined) {
        c = g.requireLane(l).then((r) => r.client as never);
        clients.set(l, c);
      }
      return c;
    };
    const store = createBrainStore({ clientFor, laneSettingsFor: async (l) => (l === laneId ? { mailboxes: info.mailboxes, kpis: info.kpis } : null) });
    // The home-lane lookup reads only the caller's own rows (D-28: a user's brain is theirs). If it cannot be read the view is
    // degraded (no count), never a guess at the current lane.
    let existing: string | null;
    try {
      existing = await store.findHomeLane(laneId);
    } catch {
      return { done: null, total: GROUPS.length, sections: bank(), nextSectionId: GROUPS[0]?.id ?? null };
    }
    const home = resolveHomeLane({ openLanes: withBrain, existingLaneId: existing, pickedLaneId: laneId });
    if (!home.ok) return null;
    env = { store, ctx: { home: home.laneId, current: laneId, lanes: [info], timezones: timezoneList() }, now };
  } catch {
    return null;
  }
  try {
    const sections = (await loadProgress(env)).map((x) => ({ id: x.id, title: x.title, done: x.complete }));
    return { done: sections.filter((s) => s.done).length, total: sections.length, sections, nextSectionId: sections.find((s) => !s.done)?.id ?? null };
  } catch {
    return { done: null, total: GROUPS.length, sections: bank(), nextSectionId: GROUPS[0]?.id ?? null };
  }
}
