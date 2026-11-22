import { ModuleGate } from "@/components/module-gate";
import { OnboardingPage } from "@/components/onboarding-page";

export default function Page(props: PageProps<"/[laneId]/onboarding">) {
  return (
    <ModuleGate module="brain" params={props.params}>
      <OnboardingPage params={props.params} searchParams={props.searchParams} />
    </ModuleGate>
  );
}
