// Per-request memo of the setup progress (T-226): the layout, Home, Settings and the wizard page all ask for it.
import { cache } from "react";
import { guards } from "@/lib/guards";
import { loadOnboarding } from "@/lib/onboarding";

export const onboardingFor = cache(async (laneId: string) => loadOnboarding(await guards(), laneId, new Date()));
