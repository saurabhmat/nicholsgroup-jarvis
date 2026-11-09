import { OnboardingImportPage } from "@/components/onboarding-import-page";

export default function Page(props: PageProps<"/[laneId]/onboarding/import">) {
  return (
    <OnboardingImportPage params={props.params} />
  );
}
