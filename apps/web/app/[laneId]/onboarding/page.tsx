import { Suspense } from "react";
import { OnboardingPage } from "@/components/onboarding-page";

export default function Page(props: PageProps<"/[laneId]/onboarding">) {
  return (
    <Suspense fallback={null}>
      <OnboardingPage params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}
