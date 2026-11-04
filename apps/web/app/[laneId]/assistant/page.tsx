import { Suspense } from "react";
import { ModulePage } from "@/components/module-page";

export default function Page(props: PageProps<"/[laneId]/assistant">) {
  return (
    <Suspense fallback={null}>
      <ModulePage module="assistant" params={props.params} />
    </Suspense>
  );
}
