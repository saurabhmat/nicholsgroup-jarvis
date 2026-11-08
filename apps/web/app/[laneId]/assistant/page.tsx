import { Suspense } from "react";
import { AssistantPage } from "@/components/assistant-page";

export default function Page(props: PageProps<"/[laneId]/assistant">) {
  return (
    <Suspense fallback={null}>
      <AssistantPage params={props.params} />
    </Suspense>
  );
}
