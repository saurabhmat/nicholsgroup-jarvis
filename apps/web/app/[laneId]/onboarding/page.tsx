import { OnboardingPage } from "@/components/onboarding-page";

export default function Page(props: PageProps<"/[laneId]/onboarding">) {
  return (
    <OnboardingPage params={props.params} searchParams={props.searchParams} />
  );
}
