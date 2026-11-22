import { ModuleGate } from "@/components/module-gate";
import { OnboardingImportPage } from "@/components/onboarding-import-page";

export default function Page(props: PageProps<"/[laneId]/onboarding/import">) {
  return (
    <ModuleGate module="brain" params={props.params}>
      <OnboardingImportPage params={props.params} />
    </ModuleGate>
  );
}
