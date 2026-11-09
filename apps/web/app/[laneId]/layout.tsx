// Authenticated layout for a lane (T-023): side menu / tabs, company switcher limited to the user's allowed lanes,
// lane in the URL. The lane is verified here and again in every page (lib/lane-page.ts).
import type { ReactNode } from "react";
import { Suspense } from "react";
import { BRAND } from "@/lib/brand";
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
  const lane = await loadLane((await params).laneId);
  const onboarding = await onboardingFor(lane.laneId); // null unless the owner has the brain view here
  return (
    <Shell brand={BRAND} lanes={lane.lanes} currentLaneId={lane.laneId} onboarding={onboarding ? { done: onboarding.done, total: onboarding.total } : null} signOut={signOut}>
      {children}
    </Shell>
  );
}
