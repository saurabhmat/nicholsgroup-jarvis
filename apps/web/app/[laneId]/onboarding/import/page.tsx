import { Suspense } from "react";
import { OnboardingImportPage } from "@/components/onboarding-import-page";

export default function Page(props: PageProps<"/[laneId]/onboarding/import">) {
  return (
    <Suspense fallback={null}>
      <OnboardingImportPage params={props.params} />
    </Suspense>
  );
}
