import { Suspense } from "react";
import { ModulePage } from "@/components/module-page";

export default function Page(props: PageProps<"/[laneId]/calendar">) {
  return (
    <Suspense fallback={null}>
      <ModulePage module="calendar" params={props.params} />
    </Suspense>
  );
}
