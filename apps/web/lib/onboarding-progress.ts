// Per-request memo of the setup progress (T-226): the layout, Home, Settings and the wizard page all ask for it.
import { cache } from "react";
import { connection } from "next/server";
import { guards } from "@/lib/guards";
import { loadOnboarding } from "@/lib/onboarding";
import { timed } from "@/lib/timed";

// connection() first: the layout and pages start this at the same time as loadLane (which is what used to make the route
// dynamic before `new Date()` ran), and Cache Components refuses a clock read while a shell is being prerendered.
export const onboardingFor = cache(async (laneId: string) => {
  await connection();
  return timed("load.onboarding", async () => loadOnboarding(await guards(), laneId, new Date()));
});
