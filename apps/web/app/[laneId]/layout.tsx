// Authenticated layout for a lane (T-023): side menu / tabs, company switcher limited to the user's allowed lanes,
// lane in the URL. The lane is verified here and again in every page (lib/lane-page.ts).
import type { ReactNode } from "react";
import { Suspense } from "react";
import { BRAND } from "@/lib/brand";
import { guards } from "@/lib/guards";
import { firstNameFor } from "@/lib/first-name";
import { loadLane } from "@/lib/lane-page";
import { onboardingFor } from "@/lib/onboarding-progress";
import { Shell } from "@/components/shell";
import { signOut } from "../sign-in/actions";

export default function LaneLayout({ children, params }: LayoutProps<"/[laneId]">) {
  return (
    <Suspense fallback={null}>
      <LaneShell params={params}>{children}</LaneShell>
    </Suspense>
  );
}

async function LaneShell({ children, params }: { children: ReactNode; params: Promise<{ laneId: string }> }) {
  const laneId = (await params).laneId;
  // The badge's setup progress does its own owner/brain checks (null unless the owner has the brain view here), so it
  // does not wait for the lane check: both run at once. A failed setup lookup is "no entry" (null), so it can never win over the lane check's 404 or redirect. A refused lane still ends in the lane check's 404 or redirect.
  // The first name (the user's own profile row, never throws) is read alongside, for the phone header band's "Good morning, {name}".
  const [lane, onboarding, firstName] = await Promise.all([loadLane(laneId), onboardingFor(laneId).catch(() => null), guards().then((g) => firstNameFor(g, laneId)).catch(() => undefined)]);
  // After the lane check (which waits for the request): reading the clock here is never part of a prerendered shell (T-243).
  const now = new Date();
  return (
    <Shell now={now} brand={BRAND} lanes={lane.lanes} currentLaneId={lane.laneId} onboarding={onboarding ? { done: onboarding.done, total: onboarding.total } : null} signOut={signOut} {...(firstName ? { firstName } : {})}>
      {children}
    </Shell>
  );
}
