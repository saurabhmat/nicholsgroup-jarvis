// Authenticated layout for a lane (T-023): side menu / tabs, company switcher limited to the user's allowed lanes,
// lane in the URL. The lane is verified here and again in every page (lib/lane-page.ts).
import type { ReactNode } from "react";
import { Suspense } from "react";
import { BRAND } from "@/lib/brand";
import { guards } from "@/lib/guards";
import { firstNameFor } from "@/lib/first-name";
import { loadLane } from "@/lib/lane-page";
import { hiddenNavKeys, laneGate } from "@/lib/lane-modules";
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
  // T-271: the side menu has no setup entry any more (Get started / AI brain is reached from Settings), so no setup progress is read here.
  // The first name (the user's own profile row, never throws) is read alongside, for the phone header band's "Good morning, {name}".
  const [lane, firstName, gate] = await Promise.all([loadLane(laneId), guards().then((g) => firstNameFor(g, laneId)).catch(() => undefined), laneGate(laneId)]);
  // After the lane check (which waits for the request): reading the clock here is never part of a prerendered shell (T-243).
  const now = new Date();
  return (
    <Shell now={now} brand={BRAND} lanes={lane.lanes} currentLaneId={lane.laneId} hiddenKeys={hiddenNavKeys(gate)} signOut={signOut} {...(firstName ? { firstName } : {})}>
      {children}
    </Shell>
  );
}
