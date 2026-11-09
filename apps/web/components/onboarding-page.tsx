// Guided onboarding page (T-226): the lane gate first (loadLane), then the owner's brain view (same gate as the interview
// route and the menu entry; anyone else gets the same 404 as an unknown page, so it does not reveal the page exists), then
// the wizard. `?step=` is checked against the bank's section ids before it reaches the client; anything else is dropped.
import { notFound } from "next/navigation";
import { PageHeader } from "@nichols/ui";
import { loadLane } from "@/lib/lane-page";
import { onboardingFor } from "@/lib/onboarding-progress";
import { sectionIdFrom } from "@/lib/onboarding";
import { BrainInterview } from "./brain-interview";

export async function OnboardingPage({
  params,
  searchParams,
}: {
  params: Promise<{ laneId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const laneId = (await params).laneId;
  // The lane gate and the owner's brain view are independent reads: run together (T-230 A). The page still needs both: a
  // refused lane ends in loadLane's 404 or redirect, and anything but the owner with the brain view gets the same 404.
  const [lane, progress] = await Promise.all([loadLane(laneId), onboardingFor(laneId).catch(() => null)]);
  // null (not the owner with the brain view, a failed lookup, anything else) is never "allowed": it is the same 404.
  if (!progress) notFound();
  const query = await searchParams;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={lane.name} title="Set up your" accent="brain" />
      <BrainInterview laneId={lane.laneId} mode="wizard" initialStep={sectionIdFrom(query.step)} hadStep={query.step !== undefined} />
    </div>
  );
}
